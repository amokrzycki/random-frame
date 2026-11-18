//! Credential vault and the durable operation journal.
use super::{
    engine::SyncEngine,
    errors::SyncError,
    state::{JoinMode, SyncLocalConfig},
};
use crate::{
    persistence::save_json,
    secure_storage::{SecretStore, StorageError},
    sync_crypto::RootSecret,
    sync_membership_crypto as crypto,
    sync_protocol::{
        decode, encode, valid_hex, MemberRegistration, OperationResult, Request, MAX_REQUEST,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Credentials {
    pub group_id: String,
    pub member_id: String,
    pub token: [u8; 32],
    pub nonce: [u8; 32],
    pub private_key: [u8; 32],
    pub root: [u8; 32],
    pub admin: bool,
    /// The administrator's current join code, or a joiner's code until its join is accepted.
    pub join_seed: Option<[u8; 32]>,
}

impl Credentials {
    pub fn new(group: String) -> Self {
        let (private, _) = crypto::keypair();
        Self {
            group_id: group,
            member_id: crypto::random_id(),
            token: crypto::random_secret(),
            nonce: crypto::random_secret(),
            private_key: *private,
            root: *RootSecret::generate().as_bytes(),
            admin: false,
            join_seed: None,
        }
    }
    pub fn registration(&self, device: String) -> Result<MemberRegistration, SyncError> {
        Ok(MemberRegistration {
            member_id: self.member_id.clone(),
            device_id: device,
            token_verifier: crypto::verifier(&self.token),
            wrapping_public_key: crypto::public_key(&self.private_key)
                .map_err(|_| SyncError::CorruptLocalState)?,
            nonce: hex::encode(self.nonce),
        })
    }
    pub fn root(&self) -> Result<RootSecret, SyncError> {
        RootSecret::from_bytes(&self.root).map_err(|_| SyncError::CorruptLocalState)
    }
}

#[derive(Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub(super) struct Vault {
    pub current: Option<Credentials>,
    /// Becomes `current` only after the server accepts the journaled operation that created it.
    pub pending: Option<Credentials>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    pub group_id: String,
    pub request: Request,
    pub request_hash: String,
    pub route: String,
    /// Accepting this operation promotes the vault's pending credentials.
    pub promote: bool,
    /// Accepting this operation replaces local synchronized state with the published snapshot.
    pub restore: bool,
    pub join_mode: Option<JoinMode>,
    pub generation: Option<super::state::Generation>,
    pub self_record: Option<crate::snapshot::DeviceRecord>,
}

impl<S: SecretStore> SyncEngine<S> {
    pub(super) fn journal_path(&self) -> std::path::PathBuf {
        self.path.with_file_name("sync-journal.json")
    }
    fn request_path(&self, operation: &str) -> std::path::PathBuf {
        self.path
            .with_file_name(format!("sync-journal-{operation}.bin"))
    }
    pub(super) async fn vault(&self) -> Result<Vault, SyncError> {
        match self.secret.load().await {
            Ok(b) => {
                let v: Vault =
                    serde_json::from_slice(&b).map_err(|_| SyncError::CorruptLocalState)?;
                for c in [&v.current, &v.pending].into_iter().flatten() {
                    if (!c.group_id.is_empty() && !valid_hex(&c.group_id, 32))
                        || !valid_hex(&c.member_id, 16)
                    {
                        return Err(SyncError::CorruptLocalState);
                    }
                }
                Ok(v)
            }
            Err(StorageError::Missing) => Ok(Vault::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub(super) async fn save_vault(&self, v: &Vault) -> Result<(), SyncError> {
        self.secret
            .store(Zeroizing::new(
                serde_json::to_vec(v).map_err(|_| SyncError::Persistence)?,
            ))
            .await
            .map_err(Into::into)
    }
    pub(super) fn journal(&self) -> Result<Option<Journal>, SyncError> {
        let value: Option<Journal> = crate::persistence::load_json(&self.journal_path())
            .map_err(|_| SyncError::CorruptLocalState)?;
        if let Some(j) = &value {
            if !valid_hex(&j.group_id, 32)
                || !valid_hex(&j.request.operation_id, 16)
                || !valid_hex(&j.request_hash, 32)
            {
                return Err(SyncError::CorruptLocalState);
            }
        }
        Ok(value)
    }
    pub(super) fn request_bytes(&self, j: &Journal) -> Result<Vec<u8>, SyncError> {
        let path = self.request_path(&j.request.operation_id);
        let size = fs::metadata(&path)
            .map_err(|_| SyncError::Persistence)?
            .len();
        if size > MAX_REQUEST as u64 {
            return Err(SyncError::CorruptLocalState);
        }
        let b = fs::read(path).map_err(|_| SyncError::Persistence)?;
        if hex::encode(Sha256::digest(&b)) != j.request_hash {
            return Err(SyncError::CorruptLocalState);
        }
        let (r, _): (Request, &[u8]) = decode(&b).map_err(|_| SyncError::CorruptLocalState)?;
        if serde_json::to_vec(&r).map_err(|_| SyncError::Persistence)?
            != serde_json::to_vec(&j.request).map_err(|_| SyncError::Persistence)?
        {
            return Err(SyncError::CorruptLocalState);
        }
        Ok(b)
    }
    pub(super) fn prepare(&self, mut j: Journal, payload: &[u8]) -> Result<Journal, SyncError> {
        if self.journal()?.is_some() {
            return Err(SyncError::PendingOperation);
        }
        let b = encode(&j.request, payload).map_err(|_| SyncError::BodyTooLarge)?;
        j.request_hash = hex::encode(Sha256::digest(&b));
        let path = self.request_path(&j.request.operation_id);
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| SyncError::Persistence)?;
        f.write_all(&b)
            .and_then(|()| f.sync_all())
            .map_err(|_| SyncError::Persistence)?;
        #[cfg(unix)]
        crate::persistence::sync_parent(&path).map_err(|_| SyncError::Persistence)?;
        save_json(&self.journal_path(), &Some(&j)).map_err(|_| SyncError::Persistence)?;
        Ok(j)
    }
    pub(super) fn rewrite_journal(&self, j: &Journal) -> Result<(), SyncError> {
        save_json(&self.journal_path(), &Some(j)).map_err(|_| SyncError::Persistence)
    }
    /// Removes the manifest and every journaled request file, whatever state they are in.
    pub(super) fn remove_journal_files(&self) -> Result<(), SyncError> {
        let directory = self.path.parent().ok_or(SyncError::Persistence)?;
        for entry in fs::read_dir(directory).map_err(|_| SyncError::Persistence)? {
            let name = entry.map_err(|_| SyncError::Persistence)?.file_name();
            let name = name.to_string_lossy();
            if name == "sync-journal.json"
                || (name.starts_with("sync-journal-") && name.ends_with(".bin"))
            {
                match fs::remove_file(directory.join(&*name)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(SyncError::Persistence),
                }
            }
        }
        Ok(())
    }
    pub(super) fn clear_journal(&self, j: &Journal) -> Result<(), SyncError> {
        // Clear the authoritative manifest before removing its ciphertext; a crash cannot replay it.
        save_json(&self.journal_path(), &Option::<Journal>::None)
            .map_err(|_| SyncError::Persistence)?;
        let _ = fs::remove_file(self.request_path(&j.request.operation_id));
        Ok(())
    }
    /// The config a group reaches after an accepted operation.
    pub(super) fn config_after(
        &self,
        c: &Credentials,
        result: &OperationResult,
    ) -> Result<SyncLocalConfig, SyncError> {
        let prior = self.config()?.filter(|p| p.group_id == c.group_id);
        if prior
            .as_ref()
            .is_some_and(|p| p.last_accepted_revision > result.revision)
        {
            return Err(SyncError::CorruptLocalState);
        }
        Ok(SyncLocalConfig {
            group_id: c.group_id.clone(),
            member_id: c.member_id.clone(),
            credential_version: prior.as_ref().map_or(1, |p| p.credential_version),
            key_id: c.root()?.derive().key_id().into(),
            epoch: result.epoch,
            last_accepted_revision: result.revision,
            last_success_at: prior.as_ref().and_then(|p| p.last_success_at),
            terminal: None,
            adoption: prior.and_then(|p| p.adoption),
            left_locally: false,
        })
    }
}
