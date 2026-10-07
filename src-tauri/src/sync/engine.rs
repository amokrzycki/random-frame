use super::{
    cas::{check_rollback, push_with_retries, restore_with_retries},
    errors::SyncError,
    reconcile::SyncData,
    state::{
        load_config, save_config, CreateSyncResult, DeviceSummary, Generation, JoinMode,
        LocalSyncSummary, SyncLocalConfig, SyncState, SyncStatus,
    },
};
#[cfg(test)]
use crate::persistence::{HistoryStore, SeenStore};
use crate::{
    persistence::PersistentState,
    secure_storage::{SecretStore, StorageError},
    sync_crypto::{RootSecret, SyncKeys},
    sync_transport::SyncTransport,
    time::now_ms,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

pub struct SyncEngine<S: SecretStore> {
    #[cfg(test)]
    pub(super) seen: Arc<SeenStore>,
    #[cfg(test)]
    pub(super) history: Arc<HistoryStore>,
    pub(super) data: Arc<PersistentState>,
    pub(super) secret: S,
    transport: Option<SyncTransport>,
    pub(super) path: PathBuf,
    pub(super) operation: AsyncMutex<()>,
    status: Mutex<SyncStatus>,
    uploaded_generation: Mutex<Option<Generation>>,
    app_handle: Option<AppHandle>,
}

impl<S: SecretStore> SyncEngine<S> {
    pub fn new(
        directory: &Path,
        data: Arc<PersistentState>,
        secret: S,
        endpoint: Option<&str>,
        app_handle: Option<AppHandle>,
    ) -> Self {
        let transport = endpoint.and_then(|value| SyncTransport::new(value).ok());
        let path = directory.join("sync-config.json");
        let config = load_config(&path).ok().flatten();
        Self {
            #[cfg(test)]
            seen: Arc::clone(&data.seen),
            #[cfg(test)]
            history: Arc::clone(&data.history),
            data,
            secret,
            transport,
            path,
            operation: AsyncMutex::new(()),
            status: Mutex::new(SyncStatus {
                supported: true,
                paired: config.is_some(),
                state: if config.is_some() {
                    SyncState::Idle
                } else {
                    SyncState::Unpaired
                },
                last_success_at: None,
                last_success_revision: config.and_then(|c| c.last_accepted_revision),
                dirty: true,
                last_error_category: None,
                snapshot_schema_version: 1,
                this_device_id: None,
                devices: Vec::new(),
            }),
            uploaded_generation: Mutex::new(None),
            app_handle,
        }
    }

    fn transport(&self) -> Result<&SyncTransport, SyncError> {
        self.transport.as_ref().ok_or(SyncError::InvalidEndpoint)
    }

    fn data(&self) -> SyncData<'_> {
        SyncData { state: &self.data }
    }

    pub(super) fn config(&self) -> Result<Option<SyncLocalConfig>, SyncError> {
        load_config(&self.path)
    }

    pub(super) fn save(&self, config: &SyncLocalConfig) -> Result<(), SyncError> {
        save_config(&self.path, config)
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
        status.dirty = uploaded != Some(self.local_generation());
        status.last_success_at = self.config().ok().flatten().and_then(|c| c.last_success_at);
        status.snapshot_schema_version = self
            .config()
            .ok()
            .flatten()
            .map_or(1, |c| c.highest_schema_version);
        status.this_device_id = Some(hex::encode(self.data.identity.id()));
        status.devices = self
            .data
            .preferences
            .sync_state()
            .1
            .iter()
            .map(|d| {
                let this = d.device_id == self.data.identity.id();
                DeviceSummary {
                    device_id: hex::encode(d.device_id),
                    display_name: d.metadata.value.display_name.clone(),
                    platform: d.metadata.value.platform.clone(),
                    joined_at_ms: d.joined_at_ms,
                    last_synced_at_ms: d.last_sync.as_ref().map(|r| r.value),
                    this_device: this,
                }
            })
            .collect();
        status
    }

    fn local_generation(&self) -> Generation {
        self.data.generation()
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

    fn notify_state_changed(&self) {
        if let Some(handle) = &self.app_handle {
            let _ = handle.emit("sync-state-changed", ());
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

    pub async fn recovery_key(&self) -> Result<String, SyncError> {
        let config = self.config()?.ok_or(SyncError::Unpaired)?;
        let root = self.secret.load().await?;
        let keys = root.derive();
        if keys.sync_id() != config.sync_id {
            return Err(SyncError::CorruptLocalState);
        }
        Ok(root.recovery_key().to_string())
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
        let (snapshot, generation, self_record) = self.data().local_snapshot()?;
        let envelope = keys
            .encrypt_snapshot(&snapshot)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        #[cfg(any(test, debug_assertions))]
        crate::snapshot::report_upload(&snapshot, &envelope);
        self.data
            .begin_publication(keys.sync_id(), 0)
            .map_err(|_| SyncError::Persistence)?;
        let revision = self
            .transport()?
            .create(keys.sync_id(), &keys.client_auth_token(), envelope)
            .await?;
        let recovery_key = root.recovery_key().to_string();
        if self.data.complete_publication(keys.sync_id()).is_err() {
            self.set_state(SyncState::Error, Some(&SyncError::Persistence), None);
            return Ok(CreateSyncResult {
                recovery_key,
                status: self.status_snapshot(),
                local_pairing_error: Some(SyncError::Persistence),
            });
        }
        let Ok(generation) = self.data.record_published_self(self_record, generation) else {
            self.set_state(SyncState::Error, Some(&SyncError::Persistence), None);
            return Ok(CreateSyncResult {
                recovery_key,
                status: self.status_snapshot(),
                local_pairing_error: Some(SyncError::Persistence),
            });
        };
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
        let mut config = SyncLocalConfig::new(keys.sync_id().to_owned(), revision);
        config.last_success_at = Some(now_ms());
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
        self.notify_state_changed();
        Ok(CreateSyncResult {
            recovery_key,
            status: self.status_snapshot(),
            local_pairing_error: None,
        })
    }

    /// Counts of what this device would bring into (Merge) or lose to (Restore) a join.
    pub fn local_summary(&self) -> Result<LocalSyncSummary, SyncError> {
        let (snapshot, _) = self.data.snapshot().map_err(|_| SyncError::Persistence)?;
        Ok(LocalSyncSummary::from_snapshot(
            &snapshot,
            self.data.identity.id(),
        ))
    }

    pub async fn join(&self, recovery_key: &str, mode: JoinMode) -> Result<SyncStatus, SyncError> {
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
        let result = self.join_inner(root, mode).await;
        self.finish(&result);
        result
    }

    async fn join_inner(&self, root: RootSecret, mode: JoinMode) -> Result<SyncStatus, SyncError> {
        let keys = root.derive();
        let (revision, remote) = self
            .transport()?
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?;
        let (revision, generation) = match mode {
            JoinMode::Merge => {
                let schema = self.data().merge_remote(&keys, &remote, 1, revision)?;
                push_with_retries(
                    &self.data(),
                    self.transport.as_ref(),
                    &self.path,
                    &keys,
                    revision,
                    None,
                    schema,
                )
                .await?
            }
            JoinMode::Restore => {
                let decoded = self.data().decode_remote(&keys, &remote, 1, revision)?;
                restore_with_retries(
                    &self.data(),
                    self.transport.as_ref(),
                    &keys,
                    revision,
                    decoded,
                )
                .await?
            }
        };
        if let Err(error) = self.secret.store(root).await {
            return Err(if self.secret.delete().await.is_err() {
                SyncError::CorruptLocalState
            } else {
                error.into()
            });
        }
        let mut config = SyncLocalConfig::new(keys.sync_id().to_owned(), revision);
        config.last_success_at = Some(now_ms());
        if let Err(error) = self.save(&config) {
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
        self.notify_state_changed();
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
        check_rollback(&config, revision)?;
        let schema =
            self.data()
                .merge_remote(&keys, &remote, config.highest_schema_version, revision)?;
        config.highest_schema_version = config.highest_schema_version.max(schema);
        if config
            .last_accepted_revision
            .is_none_or(|floor| revision > floor)
        {
            config.last_accepted_revision = Some(revision);
            self.save(&config)?;
        }
        self.save(&config)?;
        let (revision, generation) = push_with_retries(
            &self.data(),
            self.transport.as_ref(),
            &self.path,
            &keys,
            revision,
            Some(&mut config),
            schema,
        )
        .await?;
        // A failed local save after PUT is recoverable: next GET may be above the old floor.
        config.last_accepted_revision = Some(revision);
        config.highest_schema_version = 2;
        config.last_success_at = Some(now_ms());
        self.save(&config)?;
        *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
        self.set_state(SyncState::Idle, None, Some(revision));
        self.notify_state_changed();
        Ok(self.status_snapshot())
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
            supported: true,
            paired: false,
            state: SyncState::Unpaired,
            last_success_at: None,
            last_success_revision: None,
            dirty: true,
            last_error_category: None,
            snapshot_schema_version: 1,
            this_device_id: None,
            devices: Vec::new(),
        };
        self.notify_state_changed();
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
