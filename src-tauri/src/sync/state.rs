use super::errors::SyncError;
use crate::persistence::save_json;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub(super) type Generation = (u64, u64, u64);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncLocalConfig {
    protocol_version: u8,
    pub(super) sync_id: String,
    pub(super) last_accepted_revision: Option<i64>,
}

impl SyncLocalConfig {
    pub(super) fn new(sync_id: String, revision: i64) -> Self {
        Self {
            protocol_version: 1,
            sync_id,
            last_accepted_revision: Some(revision),
        }
    }

    pub(super) fn validate(&self) -> Result<(), SyncError> {
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

pub(super) fn load_config(path: &Path) -> Result<Option<SyncLocalConfig>, SyncError> {
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

pub(super) fn save_config(path: &Path, config: &SyncLocalConfig) -> Result<(), SyncError> {
    config.validate()?;
    save_json(path, config).map_err(|_| SyncError::Persistence)
}
