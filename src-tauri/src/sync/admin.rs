//! Durable exact requests. Secrets live only in the separate v2 keyring entry.
use super::{
    engine::SyncEngine,
    errors::SyncError,
    state::{JoinMode, ManagedConfig, SyncLocalConfig},
};
use crate::{
    persistence::save_json,
    secure_storage::{SecretStore, StorageError},
    sync_crypto::RootSecret,
    sync_membership_crypto as crypto,
    sync_protocol::{
        decode, encode, valid_hex, OperationResult, PairingRequest, Request, MAX_REQUEST,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Credentials {
    pub version: u8,
    pub group_id: String,
    pub member_id: String,
    pub token: [u8; 32],
    pub nonce: [u8; 32],
    pub private_key: [u8; 32],
    pub root: [u8; 32],
    pub admin_secret: Option<[u8; 32]>,
    pub recovery_generation: i64,
}
impl Credentials {
    pub fn new(group: String, member: String) -> Self {
        let (private, _) = crypto::keypair();
        Self {
            version: 2,
            group_id: group,
            member_id: member,
            token: crypto::random_secret(),
            nonce: crypto::random_secret(),
            private_key: *private,
            root: *RootSecret::generate().as_bytes(),
            admin_secret: None,
            recovery_generation: 0,
        }
    }
    pub fn pairing(&self, device: String) -> Result<PairingRequest, SyncError> {
        Ok(PairingRequest {
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
    pub pending: Option<Credentials>,
    pub pairing: Option<Credentials>,
    pub auth: Option<[u8; 32]>,
    pub invitation: Option<[u8; 32]>,
    pub invitation_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    pub version: u8,
    pub group_id: String,
    pub request: Request,
    pub request_hash: String,
    pub route: String,
    pub promote: bool,
    pub restore: bool,
    pub legacy_source_id: Option<String>,
    pub join_mode: Option<JoinMode>,
    pub confirmed: bool,
    pub generation: Option<super::state::Generation>,
    pub self_record: Option<crate::snapshot::DeviceRecord>,
    #[serde(default)]
    pub snapshot_schema: Option<u32>,
    #[serde(default = "managed_schema")]
    pub source_schema: u32,
}
fn managed_schema() -> u32 {
    2
}
impl<S: SecretStore> SyncEngine<S> {
    pub(super) fn admin_path(&self) -> std::path::PathBuf {
        self.path.with_file_name("sync-admin.json")
    }
    pub(super) async fn vault(&self) -> Result<Vault, SyncError> {
        match self.secret.load_v2().await {
            Ok(b) => {
                let v: Vault =
                    serde_json::from_slice(&b).map_err(|_| SyncError::CorruptLocalState)?;
                for c in [&v.current, &v.pending, &v.pairing].into_iter().flatten() {
                    if c.version != 2
                        || (!c.group_id.is_empty() && !valid_hex(&c.group_id, 32))
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
            .store_v2(Zeroizing::new(
                serde_json::to_vec(v).map_err(|_| SyncError::Persistence)?,
            ))
            .await
            .map_err(Into::into)
    }
    pub(super) fn journal(&self) -> Result<Option<Journal>, SyncError> {
        let path = self.admin_path();
        let value: Option<Journal> =
            crate::persistence::load_json(&path).map_err(|_| SyncError::CorruptLocalState)?;
        if let Some(j) = &value {
            if j.version != 2
                || !valid_hex(&j.group_id, 32)
                || !valid_hex(&j.request.operation_id, 16)
                || !valid_hex(&j.request_hash, 32)
                || !(2..=3).contains(&j.source_schema)
                || j.snapshot_schema.is_some_and(|v| !(2..=3).contains(&v))
            {
                return Err(SyncError::CorruptLocalState);
            }
        }
        Ok(value)
    }
    pub(super) fn request_bytes(&self, j: &Journal) -> Result<Vec<u8>, SyncError> {
        let path = self
            .path
            .with_file_name(format!("sync-admin-{}.bin", j.request.operation_id));
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
        let path = self
            .path
            .with_file_name(format!("sync-admin-{}.bin", j.request.operation_id));
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
        save_json(&self.admin_path(), &Some(&j)).map_err(|_| SyncError::Persistence)?;
        Ok(j)
    }
    pub(super) fn clear_journal(&self, j: &Journal) -> Result<(), SyncError> {
        // Clear the authoritative manifest before removing its ciphertext; a crash cannot replay it.
        save_json(&self.admin_path(), &Option::<Journal>::None)
            .map_err(|_| SyncError::Persistence)?;
        let _ = fs::remove_file(
            self.path
                .with_file_name(format!("sync-admin-{}.bin", j.request.operation_id)),
        );
        Ok(())
    }
    pub(super) fn managed_config(
        &self,
        c: &Credentials,
        result: &OperationResult,
        source: Option<String>,
    ) -> Result<SyncLocalConfig, SyncError> {
        let prior = self.config()?;
        if prior.as_ref().is_some_and(|p| {
            p.sync_id == c.group_id
                && p.last_accepted_revision
                    .is_some_and(|r| r > result.revision)
        }) {
            return Err(SyncError::CorruptLocalState);
        }
        let mut config = SyncLocalConfig::new(c.group_id.clone(), result.revision);
        config.protocol_version = 2;
        config.highest_schema_version = prior
            .as_ref()
            .filter(|p| p.sync_id == c.group_id)
            .map_or(2, |p| p.highest_schema_version);
        config.last_success_at = prior.as_ref().and_then(|p| p.last_success_at);
        let credential_version = prior
            .as_ref()
            .filter(|p| p.sync_id == c.group_id)
            .and_then(|p| p.managed.as_ref())
            .map_or(1, |p| p.credential_version);
        config.managed = Some(ManagedConfig {
            member_id: c.member_id.clone(),
            credential_version,
            key_id: c.root()?.derive().sync_id().into(),
            epoch: result.epoch,
            terminal: None,
            legacy_source_id: source,
            adoption: prior.and_then(|p| p.managed.and_then(|m| m.adoption)),
            left_locally: false,
        });
        Ok(config)
    }
}
