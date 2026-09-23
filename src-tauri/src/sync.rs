//! Pairing and monotonic merge. No UI or frame fetching lives here.

use crate::{
    persistence::{save_json, SeenStore},
    secure_storage::{SecretStore, StorageError},
    snapshot,
    sync_crypto::{RootSecret, SyncKeys},
    sync_transport::{SyncTransport, TransportError},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;

const MAX_CAS_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncLocalConfig {
    protocol_version: u8,
    sync_id: String,
    last_accepted_revision: Option<i64>,
}

impl SyncLocalConfig {
    fn new(sync_id: String, revision: i64) -> Self {
        Self {
            protocol_version: 1,
            sync_id,
            last_accepted_revision: Some(revision),
        }
    }

    fn validate(&self) -> Result<(), SyncError> {
        if self.protocol_version != 1
            || self.sync_id.len() != 64
            || !self
                .sync_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.last_accepted_revision.is_some_and(|r| r < 1)
        {
            return Err(SyncError::CorruptLocalState);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "category", content = "details", rename_all = "snake_case")]
pub enum SyncError {
    InvalidEndpoint,
    InvalidRecoveryKey,
    AlreadyPaired,
    Unpaired,
    AlreadySyncing,
    CorruptLocalState,
    SecureStorage,
    Persistence,
    InvalidRemoteData,
    Offline,
    Timeout,
    Tls,
    MalformedResponse,
    MissingChain,
    Conflict,
    RateLimited,
    ServerError,
    BodyTooLarge,
    ServerRollbackDetected {
        local_revision: i64,
        remote_revision: i64,
    },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.category())
    }
}

impl std::error::Error for SyncError {}

impl From<TransportError> for SyncError {
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::InvalidEndpoint => Self::InvalidEndpoint,
            TransportError::Offline => Self::Offline,
            TransportError::Timeout => Self::Timeout,
            TransportError::Tls => Self::Tls,
            TransportError::MissingChain => Self::MissingChain,
            TransportError::Conflict => Self::Conflict,
            TransportError::RateLimited => Self::RateLimited,
            TransportError::ServerError => Self::ServerError,
            TransportError::BodyTooLarge => Self::BodyTooLarge,
            TransportError::MalformedResponse
            | TransportError::InvalidEtag
            | TransportError::UnexpectedStatus(_)
            | TransportError::InvalidIdentity => Self::MalformedResponse,
        }
    }
}

impl From<StorageError> for SyncError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Missing | StorageError::Corrupt => Self::CorruptLocalState,
            StorageError::Unavailable | StorageError::AccessDenied => Self::SecureStorage,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Unpaired,
    Idle,
    Syncing,
    Offline,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub paired: bool,
    pub state: SyncState,
    pub last_success_revision: Option<i64>,
    pub dirty: bool,
    pub last_error_category: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSyncResult {
    pub recovery_key: String,
    pub status: SyncStatus,
    /// Set only if remote create succeeded but local pairing could not finish.
    pub local_pairing_error: Option<SyncError>,
}

pub struct SyncEngine<S: SecretStore> {
    seen: Arc<SeenStore>,
    secret: S,
    transport: Option<SyncTransport>,
    path: PathBuf,
    operation: AsyncMutex<()>,
    status: Mutex<SyncStatus>,
    uploaded_generation: Mutex<Option<u64>>,
}

impl<S: SecretStore> SyncEngine<S> {
    pub fn new(directory: &Path, seen: Arc<SeenStore>, secret: S, endpoint: Option<&str>) -> Self {
        let transport = endpoint.and_then(|value| SyncTransport::new(value).ok());
        let path = directory.join("sync-config.json");
        let config = load_config(&path).ok().flatten();
        Self {
            seen,
            secret,
            transport,
            path,
            operation: AsyncMutex::new(()),
            status: Mutex::new(SyncStatus {
                paired: config.is_some(),
                state: if config.is_some() {
                    SyncState::Idle
                } else {
                    SyncState::Unpaired
                },
                last_success_revision: config.and_then(|c| c.last_accepted_revision),
                dirty: true,
                last_error_category: None,
            }),
            uploaded_generation: Mutex::new(None),
        }
    }

    fn transport(&self) -> Result<&SyncTransport, SyncError> {
        self.transport.as_ref().ok_or(SyncError::InvalidEndpoint)
    }

    fn config(&self) -> Result<Option<SyncLocalConfig>, SyncError> {
        load_config(&self.path)
    }

    fn save(&self, config: &SyncLocalConfig) -> Result<(), SyncError> {
        config.validate()?;
        save_json(&self.path, config).map_err(|_| SyncError::Persistence)
    }

    fn status_snapshot(&self) -> SyncStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let uploaded = *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.dirty = uploaded.map_or(true, |generation| self.seen.generation() != generation);
        status
    }

    fn set_state(&self, state: SyncState, error: Option<&SyncError>, revision: Option<i64>) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.state = state;
        status.last_error_category = error.map(|e| e.category().to_owned());
        if let Some(revision) = revision {
            status.last_success_revision = Some(revision);
        }
    }

    pub async fn status(&self) -> Result<SyncStatus, SyncError> {
        match self.config()? {
            None => match self.secret.load().await {
                Err(StorageError::Missing) => Ok(self.status_snapshot()),
                Ok(_) => Err(SyncError::CorruptLocalState),
                Err(error) => Err(error.into()),
            },
            Some(config) => {
                let root = self.secret.load().await?;
                if root.derive().sync_id() != config.sync_id {
                    return Err(SyncError::CorruptLocalState);
                }
                Ok(self.status_snapshot())
            }
        }
    }

    async fn paired(&self) -> Result<(SyncLocalConfig, SyncKeys), SyncError> {
        let config = self.config()?.ok_or(SyncError::Unpaired)?;
        let root = self.secret.load().await?;
        let keys = root.derive();
        if keys.sync_id() != config.sync_id {
            return Err(SyncError::CorruptLocalState);
        }
        Ok((config, keys))
    }

    pub async fn create(&self) -> Result<CreateSyncResult, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if self.config()?.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        match self.secret.load().await {
            Err(StorageError::Missing) => {}
            Ok(_) => return Err(SyncError::CorruptLocalState),
            Err(error) => return Err(error.into()),
        }
        self.set_state(SyncState::Syncing, None, None);
        let result = self.create_inner().await;
        self.finish(
            &result
                .as_ref()
                .map(|r| r.status.clone())
                .map_err(Clone::clone),
        );
        result
    }

    async fn create_inner(&self) -> Result<CreateSyncResult, SyncError> {
        let root = RootSecret::generate();
        let keys = root.derive();
        let (snapshot, generation) = self
            .seen
            .snapshot_with_generation()
            .map_err(|_| SyncError::Persistence)?;
        let envelope = keys
            .encrypt_snapshot(&snapshot)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        let revision = self
            .transport()?
            .create(keys.sync_id(), &keys.client_auth_token(), envelope)
            .await?;
        let recovery_key = root.recovery_key().to_string();
        if let Err(error) = self.secret.store(root).await {
            let category = if self.secret.delete().await.is_err() {
                SyncError::CorruptLocalState
            } else {
                error.into()
            };
            self.set_state(SyncState::Error, Some(&category), None);
            return Ok(CreateSyncResult {
                recovery_key,
                status: self.status_snapshot(),
                local_pairing_error: Some(category),
            });
        }
        let config = SyncLocalConfig::new(keys.sync_id().to_owned(), revision);
        if let Err(error) = self.save(&config) {
            let cleanup = self.secret.delete().await;
            let category = if cleanup.is_err() {
                SyncError::CorruptLocalState
            } else {
                error
            };
            self.set_state(SyncState::Error, Some(&category), None);
            return Ok(CreateSyncResult {
                recovery_key,
                status: self.status_snapshot(),
                local_pairing_error: Some(category),
            });
        }
        *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .paired = true;
        self.set_state(SyncState::Idle, None, Some(revision));
        Ok(CreateSyncResult {
            recovery_key,
            status: self.status_snapshot(),
            local_pairing_error: None,
        })
    }

    pub async fn join(&self, recovery_key: &str) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if self.config()?.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        match self.secret.load().await {
            Err(StorageError::Missing) => {}
            Ok(_) => return Err(SyncError::CorruptLocalState),
            Err(error) => return Err(error.into()),
        }
        let root = RootSecret::from_recovery_key(recovery_key)
            .map_err(|_| SyncError::InvalidRecoveryKey)?;
        self.set_state(SyncState::Syncing, None, None);
        let result = self.join_inner(root).await;
        self.finish(&result);
        result
    }

    async fn join_inner(&self, root: RootSecret) -> Result<SyncStatus, SyncError> {
        let keys = root.derive();
        let (revision, remote) = self
            .transport()?
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        self.merge_remote(&keys, &remote)?;
        let (revision, generation) = self.push_with_retries(&keys, revision, None).await?;
        if let Err(error) = self.secret.store(root).await {
            return Err(if self.secret.delete().await.is_err() {
                SyncError::CorruptLocalState
            } else {
                error.into()
            });
        }
        if let Err(error) = self.save(&SyncLocalConfig::new(keys.sync_id().to_owned(), revision)) {
            self.secret
                .delete()
                .await
                .map_err(|_| SyncError::CorruptLocalState)?;
            return Err(error);
        }
        *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .paired = true;
        self.set_state(SyncState::Idle, None, Some(revision));
        Ok(self.status_snapshot())
    }

    pub async fn sync_now(&self) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        self.set_state(SyncState::Syncing, None, None);
        let result = self.sync_inner().await;
        self.finish(&result);
        result
    }

    async fn sync_inner(&self) -> Result<SyncStatus, SyncError> {
        let (mut config, keys) = self.paired().await?;
        let (revision, remote) = self
            .transport()?
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        Self::check_rollback(&config, revision)?;
        self.merge_remote(&keys, &remote)?;
        if config
            .last_accepted_revision
            .map_or(true, |floor| revision > floor)
        {
            config.last_accepted_revision = Some(revision);
            self.save(&config)?;
        }
        let (revision, generation) = self
            .push_with_retries(&keys, revision, Some(&mut config))
            .await?;
        // A failed local save after PUT is recoverable: next GET may be above the old floor.
        config.last_accepted_revision = Some(revision);
        self.save(&config)?;
        *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
        self.set_state(SyncState::Idle, None, Some(revision));
        Ok(self.status_snapshot())
    }

    fn check_rollback(config: &SyncLocalConfig, remote: i64) -> Result<(), SyncError> {
        // Revision is not AEAD AAD. A first-time join has no floor and cannot detect
        // a valid historical blob replayed before this device first joined.
        if let Some(local) = config.last_accepted_revision {
            if remote < local {
                return Err(SyncError::ServerRollbackDetected {
                    local_revision: local,
                    remote_revision: remote,
                });
            }
        }
        Ok(())
    }

    fn merge_remote(&self, keys: &SyncKeys, envelope: &[u8]) -> Result<(), SyncError> {
        let plaintext = keys
            .decrypt_snapshot(keys.sync_id(), envelope)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        let ids = snapshot::parse_snapshot(&plaintext).map_err(|_| SyncError::InvalidRemoteData)?;
        self.seen.merge(ids).map_err(|_| SyncError::Persistence)?;
        Ok(())
    }

    async fn push_with_retries(
        &self,
        keys: &SyncKeys,
        mut revision: i64,
        mut config: Option<&mut SyncLocalConfig>,
    ) -> Result<(i64, u64), SyncError> {
        for attempt in 0..MAX_CAS_ATTEMPTS {
            let (snapshot, generation) = self
                .seen
                .snapshot_with_generation()
                .map_err(|_| SyncError::Persistence)?;
            let envelope = keys
                .encrypt_snapshot(&snapshot)
                .map_err(|_| SyncError::InvalidRemoteData)?;
            match self
                .transport()?
                .update(
                    keys.sync_id(),
                    &keys.client_auth_token(),
                    revision,
                    envelope,
                )
                .await
            {
                Ok(next) => return Ok((next, generation)),
                Err(TransportError::Conflict) if attempt + 1 < MAX_CAS_ATTEMPTS => {
                    let (latest, remote) = self
                        .transport()?
                        .get(keys.sync_id(), &keys.client_auth_token())
                        .await?;
                    if let Some(config) = config.as_mut() {
                        Self::check_rollback(config, latest)?;
                    }
                    self.merge_remote(keys, &remote)?;
                    if let Some(config) = config.as_mut() {
                        if config
                            .last_accepted_revision
                            .map_or(true, |floor| latest > floor)
                        {
                            config.last_accepted_revision = Some(latest);
                            self.save(config)?;
                        }
                    }
                    revision = latest;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(SyncError::Conflict)
    }

    pub async fn startup_sync(&self) -> Result<SyncStatus, SyncError> {
        if self.config()?.is_none() {
            return self.status().await;
        }
        self.sync_now().await
    }

    pub async fn leave(&self) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        self.secret
            .delete()
            .await
            .map_err(|_| SyncError::SecureStorage)?;
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SyncError::Persistence),
        }
        *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        *self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = SyncStatus {
            paired: false,
            state: SyncState::Unpaired,
            last_success_revision: None,
            dirty: true,
            last_error_category: None,
        };
        Ok(self.status_snapshot())
    }

    fn finish<T>(&self, result: &Result<T, SyncError>) {
        if let Err(error) = result {
            let state = if matches!(error, SyncError::Unpaired) {
                SyncState::Unpaired
            } else if matches!(
                error,
                SyncError::Offline
                    | SyncError::Timeout
                    | SyncError::Tls
                    | SyncError::RateLimited
                    | SyncError::ServerError
            ) {
                SyncState::Offline
            } else {
                SyncState::Error
            };
            self.set_state(state, Some(error), None);
        }
    }
}

impl SyncError {
    fn category(&self) -> &'static str {
        match self {
            Self::ServerRollbackDetected { .. } => "rollback_detected",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::InvalidRecoveryKey => "invalid_recovery_key",
            Self::AlreadyPaired => "already_paired",
            Self::Unpaired => "unpaired",
            Self::AlreadySyncing => "already_syncing",
            Self::CorruptLocalState => "corrupt_local_state",
            Self::SecureStorage => "secure_storage",
            Self::Persistence => "persistence",
            Self::InvalidRemoteData => "invalid_remote_data",
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::Tls => "tls",
            Self::MalformedResponse => "malformed_response",
            Self::MissingChain => "missing_chain",
            Self::Conflict => "conflict",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::BodyTooLarge => "body_too_large",
        }
    }
}

fn load_config(path: &Path) -> Result<Option<SyncLocalConfig>, SyncError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary = path.with_extension("json.tmp");
            match fs::read(&temporary) {
                Ok(bytes) => {
                    fs::rename(temporary, path).map_err(|_| SyncError::Persistence)?;
                    bytes
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(SyncError::Persistence),
            }
        }
        Err(_) => return Err(SyncError::Persistence),
    };
    if bytes.len() > 1024 {
        return Err(SyncError::CorruptLocalState);
    }
    let config: SyncLocalConfig =
        serde_json::from_slice(&bytes).map_err(|_| SyncError::CorruptLocalState)?;
    config.validate()?;
    Ok(Some(config))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unused_async_trait_impl,
        clippy::struct_excessive_bools,
        clippy::too_many_lines,
        reason = "small deterministic HTTP test fixture"
    )]
    use super::*;
    use crate::sync_transport::MAX_ENVELOPE;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Clone, Default)]
    struct MemorySecret {
        value: Arc<Mutex<Option<[u8; 32]>>>,
        fail_store: Arc<AtomicBool>,
    }

    impl SecretStore for MemorySecret {
        async fn store(&self, root: RootSecret) -> Result<(), StorageError> {
            if self.fail_store.load(Ordering::Relaxed) {
                return Err(StorageError::Unavailable);
            }
            *self
                .value
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(*root.as_bytes());
            Ok(())
        }
        async fn load(&self) -> Result<RootSecret, StorageError> {
            let value = self
                .value
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .ok_or(StorageError::Missing)?;
            RootSecret::from_bytes(&value).map_err(|_| StorageError::Corrupt)
        }
        async fn delete(&self) -> Result<(), StorageError> {
            *self
                .value
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            Ok(())
        }
    }

    #[derive(Default)]
    struct ServerState {
        id: Option<String>,
        token: Option<String>,
        revision: i64,
        envelope: Vec<u8>,
        force_conflict: bool,
        conflicts_remaining: usize,
        fail_next_update: bool,
        fail_next_create: bool,
        insert_on_update: Option<(Arc<SeenStore>, u64)>,
        malformed_etag: bool,
        omit_etag: bool,
        rate_limit_next_get: bool,
        oversized: bool,
        requests: usize,
    }

    async fn server() -> Result<
        (String, Arc<Mutex<ServerState>>, tokio::task::JoinHandle<()>),
        Box<dyn std::error::Error>,
    > {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(Mutex::new(ServerState::default()));
        let shared = Arc::clone(&state);
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let shared = Arc::clone(&shared);
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0_u8; 8192];
                    let head_end = loop {
                        let Ok(n) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..n]);
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            break end + 4;
                        }
                        if request.len() > 16_384 {
                            return;
                        }
                    };
                    let Ok(head) = std::str::from_utf8(&request[..head_end]) else {
                        return;
                    };
                    let head = head.to_owned();
                    let mut lines = head.split("\r\n");
                    let first = lines.next().unwrap_or_default();
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or_default();
                    let path = parts.next().unwrap_or_default();
                    let headers: Vec<_> = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                        .collect();
                    let get = |name: &str| {
                        headers
                            .iter()
                            .find(|(k, _)| k == name)
                            .map(|(_, v)| v.as_str())
                    };
                    let length = get("content-length")
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0);
                    while request.len() - head_end < length {
                        let Ok(n) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..n]);
                    }
                    let body = &request[head_end..head_end + length];
                    let id = path.strip_prefix("/sync/").unwrap_or_default();
                    let token = get("authorization")
                        .and_then(|v| v.strip_prefix("Bearer "))
                        .unwrap_or_default();
                    let (status, etag, payload) = {
                        let mut state = shared
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.requests += 1;
                        let (status, etag, payload) =
                            if method == "PUT" && get("if-none-match") == Some("*") {
                                if state.fail_next_create {
                                    state.fail_next_create = false;
                                    (503, None, Vec::new())
                                } else if state.id.is_some() {
                                    (412, None, Vec::new())
                                } else {
                                    state.id = Some(id.to_owned());
                                    state.token = Some(token.to_owned());
                                    state.revision = 1;
                                    state.envelope = body.to_vec();
                                    (201, Some("\"1\"".to_owned()), Vec::new())
                                }
                            } else if state.id.as_deref() != Some(id)
                                || state.token.as_deref() != Some(token)
                            {
                                (404, None, Vec::new())
                            } else if method == "GET" && state.rate_limit_next_get {
                                state.rate_limit_next_get = false;
                                (429, None, Vec::new())
                            } else if method == "GET" {
                                let payload = if state.oversized {
                                    vec![0; MAX_ENVELOPE + 1]
                                } else {
                                    state.envelope.clone()
                                };
                                (
                                    200,
                                    if state.omit_etag {
                                        None
                                    } else {
                                        Some(if state.malformed_etag {
                                            "W/\"1\"".to_owned()
                                        } else {
                                            format!("\"{}\"", state.revision)
                                        })
                                    },
                                    payload,
                                )
                            } else if method == "PUT" {
                                if state.fail_next_update {
                                    state.fail_next_update = false;
                                    (503, None, Vec::new())
                                } else if state.force_conflict || state.conflicts_remaining > 0 {
                                    state.force_conflict = false;
                                    state.conflicts_remaining =
                                        state.conflicts_remaining.saturating_sub(1);
                                    state.revision += 1;
                                    (412, None, Vec::new())
                                } else if get("if-match")
                                    != Some(format!("\"{}\"", state.revision).as_str())
                                {
                                    (412, None, Vec::new())
                                } else {
                                    state.revision += 1;
                                    state.envelope = body.to_vec();
                                    if let Some((seen, id)) = state.insert_on_update.take() {
                                        let _ = seen.insert(id);
                                    }
                                    (204, Some(format!("\"{}\"", state.revision)), Vec::new())
                                }
                            } else {
                                (405, None, Vec::new())
                            };
                        drop(state);
                        (status, etag, payload)
                    };
                    let mut response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n", payload.len());
                    if let Some(etag) = etag {
                        use std::fmt::Write;
                        let _ = write!(response, "ETag: {etag}\r\n");
                    }
                    response.push_str("\r\n");
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.write_all(&payload).await;
                });
            }
        });
        Ok((url, state, task))
    }

    fn directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "random-frame-sync-{label}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    fn device(
        path: &Path,
        url: &str,
        secret: MemorySecret,
    ) -> Result<SyncEngine<MemorySecret>, SyncError> {
        let seen = Arc::new(SeenStore::new(path).map_err(|_| SyncError::Persistence)?);
        Ok(SyncEngine::new(path, seen, secret, Some(url)))
    }

    #[tokio::test]
    async fn two_devices_converge_with_cas_collision_and_leave_keeps_seen(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let a_path = directory("a");
        let b_path = directory("b");
        let a_secret = MemorySecret::default();
        let b_secret = MemorySecret::default();
        let a = device(&a_path, &url, a_secret.clone())?;
        let b = device(&b_path, &url, b_secret.clone())?;
        a.seen.merge([1, 2, 3])?;
        b.seen.merge([3, 4, 5])?;
        let created = a.create().await?;
        assert!(created.local_pairing_error.is_none());
        assert_eq!(created.status.last_success_revision, Some(1));
        assert!(!created.status.dirty);
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .fail_next_create = true;
        assert_eq!(b.create().await.err(), Some(SyncError::ServerError));
        assert!(!b_path.join("sync-config.json").exists());
        assert!(b_secret.load().await.is_err());
        b.join(&created.recovery_key).await?;
        for id in 1..=5 {
            assert!(b.seen.contains(id));
        }
        a.seen.insert(6)?;
        b.seen.insert(7)?;
        assert!(a.status().await?.dirty);
        a.sync_now().await?;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .force_conflict = true;
        b.sync_now().await?;
        a.sync_now().await?;
        for id in 1..=7 {
            assert!(a.seen.contains(id));
            assert!(b.seen.contains(id));
        }
        let envelope = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .envelope
            .clone();
        let keys = a_secret.load().await?.derive();
        let remote = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
        assert_eq!(
            snapshot::parse_snapshot(&remote)?,
            (1..=7).collect::<Vec<_>>()
        );
        b.leave().await?;
        assert!(b.seen.contains(7));
        assert!(b_secret.load().await.is_err());
        assert!(!b_path.join("sync-config.json").exists());
        task.abort();
        fs::remove_dir_all(a_path)?;
        fs::remove_dir_all(b_path)?;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires RF_SYNC_SERVER_BIN pointing to the real random-frame-sync-server binary"]
    async fn real_server_two_device_offline_and_startup_e2e(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use std::process::{Child, Command, Stdio};

        struct Server(Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let binary = std::env::var("RF_SYNC_SERVER_BIN")?;
        let root = directory("real-server");
        fs::create_dir_all(&root)?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        drop(listener);
        let url = format!("http://{address}");
        let database = root.join("sync.db");
        let start = || -> Result<Server, Box<dyn std::error::Error>> {
            Ok(Server(
                Command::new(&binary)
                    .env("RF_SYNC_BIND", address.to_string())
                    .env("RF_SYNC_DB", &database)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?,
            ))
        };
        let ready = || async {
            for _ in 0..40 {
                if reqwest::get(format!("{url}/health"))
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    return Ok::<(), Box<dyn std::error::Error>>(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err("real server did not become ready".into())
        };
        let server = start()?;
        ready().await?;
        let a_secret = MemorySecret::default();
        let a = device(&root.join("a"), &url, a_secret.clone())?;
        let b = device(&root.join("b"), &url, MemorySecret::default())?;
        a.seen.insert(101)?;
        b.seen.insert(202)?;
        let created = a.create().await?;
        assert!(created.local_pairing_error.is_none());
        assert_eq!(created.status.last_success_revision, Some(1));
        assert_eq!(
            b.join(&created.recovery_key).await?.last_success_revision,
            Some(2)
        );
        assert!(b.seen.contains(101));
        a.seen.insert(303)?;
        b.seen.insert(404)?;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(3));
        assert_eq!(b.sync_now().await?.last_success_revision, Some(4));
        assert_eq!(a.sync_now().await?.last_success_revision, Some(5));
        for id in [101, 202, 303, 404] {
            assert!(a.seen.contains(id));
            assert!(b.seen.contains(id));
        }
        let keys = a_secret.load().await?.derive();
        let transport = SyncTransport::new(&url)?;
        let (revision, envelope) = transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        assert_eq!(revision, 5);
        assert_eq!(
            snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?,
            vec![101, 202, 303, 404]
        );

        drop(server);
        a.seen.insert(505)?;
        b.seen.insert(606)?;
        assert_eq!(a.sync_now().await.err(), Some(SyncError::Offline));
        assert!(a.status().await?.dirty);
        assert!(a.seen.contains(505));
        let server = start()?;
        ready().await?;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(6));
        assert!(!a.status().await?.dirty);
        assert_eq!(b.sync_now().await?.last_success_revision, Some(7));
        assert_eq!(a.startup_sync().await?.last_success_revision, Some(8));
        for id in [101, 202, 303, 404, 505, 606] {
            assert!(a.seen.contains(id));
            assert!(b.seen.contains(id));
        }
        let (revision, envelope) = transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        assert_eq!(revision, 8);
        assert_eq!(
            snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?,
            vec![101, 202, 303, 404, 505, 606]
        );
        drop(server);
        assert_eq!(a.startup_sync().await.err(), Some(SyncError::Offline));
        assert!(a.seen.insert(707)?);
        assert!(a.status().await?.dirty);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires RF_SYNC_E2E_URL, RF_SYNC_E2E_SSH_KEY, and RF_SYNC_E2E_SSH_TARGET"]
    #[allow(
        clippy::print_stdout,
        reason = "report actual production E2E revisions"
    )]
    async fn production_https_two_device_e2e() -> Result<(), Box<dyn std::error::Error>> {
        use std::process::Command;

        fn service(
            key: &str,
            target: &str,
            action: &str,
        ) -> Result<(), Box<dyn std::error::Error>> {
            let status = Command::new("ssh")
                .args(["-F", "/dev/null", "-i", key, "-o", "BatchMode=yes", target])
                .arg(format!("sudo -n systemctl {action} random-frame-sync"))
                .status()?;
            if !status.success() {
                return Err(format!("remote systemctl {action} failed: {status}").into());
            }
            Ok(())
        }

        struct RestoreService<'a> {
            key: &'a str,
            target: &'a str,
            stopped: bool,
        }
        impl Drop for RestoreService<'_> {
            fn drop(&mut self) {
                if self.stopped {
                    let _ = service(self.key, self.target, "start");
                }
            }
        }

        let url = std::env::var("RF_SYNC_E2E_URL")?;
        let key = std::env::var("RF_SYNC_E2E_SSH_KEY")?;
        let target = std::env::var("RF_SYNC_E2E_SSH_TARGET")?;
        let root = directory("production-https");
        let a_secret = MemorySecret::default();
        let a = device(&root.join("a"), &url, a_secret.clone())?;
        let b = device(&root.join("b"), &url, MemorySecret::default())?;
        a.seen.insert(101)?;
        b.seen.insert(202)?;
        let created = a.create().await?;
        assert!(created.local_pairing_error.is_none());
        assert_eq!(created.status.last_success_revision, Some(1));
        let keys = a_secret.load().await?.derive();
        println!(
            "production sync_id={} create=1 A=[101] B=[202]",
            keys.sync_id()
        );

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(
            b.join(&created.recovery_key).await?.last_success_revision,
            Some(2)
        );
        println!("join=2 B=[101,202]");
        a.seen.insert(303)?;
        b.seen.insert(404)?;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(3));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(b.sync_now().await?.last_success_revision, Some(4));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(5));
        println!("converged=5 A/B=[101,202,303,404]");

        let transport = SyncTransport::new(&url)?;
        let (revision, envelope) = transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        assert_eq!(revision, 5);
        assert_eq!(
            snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?,
            vec![101, 202, 303, 404]
        );

        service(&key, &target, "restart")?;
        assert!(reqwest::get(format!("{url}/health"))
            .await?
            .status()
            .is_success());
        a.seen.insert(505)?;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(6));
        println!("restart=6 A=[101,202,303,404,505]");

        let mut restore = RestoreService {
            key: &key,
            target: &target,
            stopped: false,
        };
        service(&key, &target, "stop")?;
        restore.stopped = true;
        b.seen.insert(606)?;
        assert_eq!(b.sync_now().await.err(), Some(SyncError::ServerError));
        assert!(b.status().await?.dirty);
        println!("offline B local 606 persisted, dirty=true, error=server_error");
        service(&key, &target, "start")?;
        restore.stopped = false;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(b.sync_now().await?.last_success_revision, Some(7));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(a.sync_now().await?.last_success_revision, Some(8));
        let (revision, envelope) = transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        assert_eq!(revision, 8);
        let expected = vec![101, 202, 303, 404, 505, 606];
        assert_eq!(
            snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?,
            expected
        );
        for id in expected {
            assert!(a.seen.contains(id) && b.seen.contains(id));
        }
        println!("recovered=8 A/B/remote=[101,202,303,404,505,606]");
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[tokio::test]
    async fn rollback_rejected_before_decrypt_or_merge_and_equal_or_higher_allowed(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let path = directory("rollback");
        let engine = device(&path, &url, MemorySecret::default())?;
        engine.seen.insert(1)?;
        engine.create().await?;
        let mut config = engine.config()?.ok_or("missing config")?;
        config.last_accepted_revision = Some(10);
        engine.save(&config)?;
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.revision = 9;
            state.envelope = vec![0; 40];
        }
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::ServerRollbackDetected {
                local_revision: 10,
                remote_revision: 9
            })
        );
        assert!(!engine.seen.contains(2));
        assert_eq!(
            engine.config()?.and_then(|c| c.last_accepted_revision),
            Some(10)
        );
        let keys = engine.secret.load().await?.derive();
        let valid = keys.encrypt_snapshot(&snapshot::serialize_snapshot(
            &std::collections::HashSet::from([1, 2]),
        )?)?;
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.revision = 10;
            state.envelope = valid;
        }
        engine.sync_now().await?;
        assert!(engine.seen.contains(2));
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.revision = 15;
        }
        engine.sync_now().await?;
        task.abort();
        fs::remove_dir_all(path)?;
        Ok(())
    }

    #[tokio::test]
    async fn partial_failures_preserve_recovery_and_local_union(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let a_path = directory("partial-a");
        let b_path = directory("partial-b");
        let a_secret = MemorySecret::default();
        a_secret.fail_store.store(true, Ordering::Relaxed);
        let a = device(&a_path, &url, a_secret.clone())?;
        a.seen.insert(1)?;
        let partial = a.create().await?;
        assert_eq!(partial.local_pairing_error, Some(SyncError::SecureStorage));
        assert!(!a_path.join("sync-config.json").exists());
        assert!(a_secret.load().await.is_err());
        let b = device(&b_path, &url, MemorySecret::default())?;
        b.seen.insert(2)?;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .fail_next_update = true;
        assert_eq!(
            b.join(&partial.recovery_key).await.err(),
            Some(SyncError::ServerError)
        );
        assert!(b.seen.contains(1));
        assert!(b.seen.contains(2));
        assert!(!b_path.join("sync-config.json").exists());
        b.join(&partial.recovery_key).await?;
        let c_path = directory("partial-c");
        let c_secret = MemorySecret::default();
        c_secret.fail_store.store(true, Ordering::Relaxed);
        let c = device(&c_path, &url, c_secret.clone())?;
        c.seen.insert(3)?;
        assert_eq!(
            c.join(&partial.recovery_key).await.err(),
            Some(SyncError::SecureStorage)
        );
        assert!(c.seen.contains(1));
        assert!(!c_path.join("sync-config.json").exists());
        assert!(c_secret.load().await.is_err());
        task.abort();
        fs::remove_dir_all(a_path)?;
        fs::remove_dir_all(b_path)?;
        fs::remove_dir_all(c_path)?;
        Ok(())
    }

    #[tokio::test]
    async fn transport_and_pairing_reject_bad_inputs() -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let path = directory("bad");
        let engine = device(&path, &url, MemorySecret::default())?;
        assert_eq!(
            engine.join("wrong").await.err(),
            Some(SyncError::InvalidRecoveryKey)
        );
        let created = engine.create().await?;
        let other_path = directory("bad-other");
        let other = device(&other_path, &url, MemorySecret::default())?;
        assert_eq!(
            other
                .join(&RootSecret::generate().recovery_key())
                .await
                .err(),
            Some(SyncError::MissingChain)
        );
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.malformed_etag = true;
        }
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::MalformedResponse)
        );
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.malformed_etag = false;
            state.omit_etag = true;
        }
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::MalformedResponse)
        );
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.omit_etag = false;
            state.rate_limit_next_get = true;
        }
        assert_eq!(engine.sync_now().await.err(), Some(SyncError::RateLimited));
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.oversized = true;
        }
        assert_eq!(engine.sync_now().await.err(), Some(SyncError::BodyTooLarge));
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .oversized = false;
        engine.sync_now().await?;
        assert!(created.recovery_key.starts_with("rf1-"));
        task.abort();
        fs::remove_dir_all(path)?;
        fs::remove_dir_all(other_path)?;
        Ok(())
    }

    #[tokio::test]
    async fn config_identity_and_single_operation_are_checked_before_network(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let path = directory("config");
        let secret = MemorySecret::default();
        let engine = device(&path, "https://sync.example.com", secret.clone())?;
        let config = SyncLocalConfig::new("a".repeat(64), 10);
        engine.save(&config)?;
        assert_eq!(
            engine.config()?.and_then(|c| c.last_accepted_revision),
            Some(10)
        );
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::CorruptLocalState)
        );
        secret.store(RootSecret::generate()).await?;
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::CorruptLocalState)
        );
        assert_eq!(
            engine.status().await.err(),
            Some(SyncError::CorruptLocalState)
        );
        fs::write(&engine.path, b"{broken")?;
        assert_eq!(engine.config().err(), Some(SyncError::CorruptLocalState));
        fs::remove_file(&engine.path)?;
        assert_eq!(
            engine.status().await.err(),
            Some(SyncError::CorruptLocalState)
        );
        let guard = engine.operation.lock().await;
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::AlreadySyncing)
        );
        drop(guard);
        fs::remove_dir_all(path)?;
        Ok(())
    }

    #[tokio::test]
    async fn dirty_local_change_survives_upload_and_offline_sync(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let path = directory("dirty");
        let engine = device(&path, &url, MemorySecret::default())?;
        engine.seen.insert(1)?;
        engine.create().await?;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert_on_update = Some((Arc::clone(&engine.seen), 2));
        let status = engine.sync_now().await?;
        assert!(status.dirty);
        assert!(engine.seen.contains(2));
        engine.sync_now().await?;
        assert!(!engine.status().await?.dirty);
        task.abort();
        engine.seen.insert(3)?;
        assert_eq!(engine.sync_now().await.err(), Some(SyncError::Offline));
        assert!(engine.seen.contains(3));
        assert!(engine.status().await?.dirty);
        fs::remove_dir_all(path)?;
        Ok(())
    }

    #[tokio::test]
    async fn bounded_conflicts_and_invalid_envelope_do_not_unpair(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        let path = directory("conflicts");
        let engine = device(&path, &url, MemorySecret::default())?;
        engine.seen.insert(1)?;
        engine.create().await?;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .conflicts_remaining = MAX_CAS_ATTEMPTS;
        assert_eq!(engine.sync_now().await.err(), Some(SyncError::Conflict));
        assert!(engine.status().await?.paired);
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.envelope = vec![0; 40];
        }
        assert_eq!(
            engine.sync_now().await.err(),
            Some(SyncError::InvalidRemoteData)
        );
        assert!(engine.seen.contains(1));
        task.abort();
        fs::remove_dir_all(path)?;
        Ok(())
    }
}
