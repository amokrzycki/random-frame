use super::errors::SyncError;
use crate::persistence::save_json;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub(super) type Generation = crate::persistence::transaction::Generation;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncLocalConfig {
    protocol_version: u8,
    pub(super) sync_id: String,
    pub(super) last_accepted_revision: Option<i64>,
    #[serde(default = "schema_v1")]
    pub(super) highest_schema_version: u32,
    #[serde(default)]
    pub(super) last_success_at: Option<u64>,
}

impl SyncLocalConfig {
    pub(super) fn new(sync_id: String, revision: i64) -> Self {
        Self {
            protocol_version: 1,
            sync_id,
            last_accepted_revision: Some(revision),
            highest_schema_version: 2,
            last_success_at: None,
        }
    }

    pub(super) fn validate(&self) -> Result<(), SyncError> {
        if !(1..=2).contains(&self.highest_schema_version)
            || self.protocol_version != 1
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

/// How a device without Sync credentials adopts an existing Sync.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    /// The remote state replaces this device's synchronized state; nothing local is published.
    Restore,
    /// Remote and local synchronized state are unioned, local deletions included.
    Merge,
}

/// Aggregate counts of this device's pre-join synchronized state. Never carries identifiers.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncSummary {
    pub history: usize,
    pub history_removals: usize,
    pub favorites: usize,
    pub favorite_removals: usize,
    pub activity_removals: usize,
    pub meaningful: bool,
}

impl LocalSyncSummary {
    pub(super) fn from_snapshot(s: &crate::snapshot::SyncSnapshot) -> Self {
        // Meaningful = any synchronized content or deletion except the device roster, which a
        // fresh install always has. A device with only deletions is NOT empty.
        let meaningful = !(s.seen.is_empty()
            && s.history.is_empty()
            && s.history_removed.is_empty()
            && s.favorites.is_empty()
            && s.favorites_removed.is_empty()
            && s.exploration.is_empty()
            && s.activity.is_empty()
            && s.activity_removed.is_empty()
            && s.preferences == crate::snapshot::PreferencesV2::default());
        Self {
            history: s.history.len(),
            history_removals: s.history_removed.len(),
            favorites: s.favorites.len(),
            favorite_removals: s.favorites_removed.len(),
            activity_removals: s.activity_removed.len(),
            meaningful,
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
pub struct DeviceSummary {
    pub device_id: String,
    pub display_name: String,
    pub platform: String,
    pub joined_at_ms: u64,
    pub last_synced_at_ms: Option<u64>,
    pub this_device: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub supported: bool,
    pub paired: bool,
    pub state: SyncState,
    pub last_success_at: Option<u64>,
    pub last_success_revision: Option<i64>,
    pub dirty: bool,
    pub last_error_category: Option<String>,
    pub snapshot_schema_version: u32,
    pub this_device_id: Option<String>,
    pub devices: Vec<DeviceSummary>,
}

impl SyncStatus {
    pub fn unsupported() -> Self {
        Self {
            supported: false,
            paired: false,
            state: SyncState::Unpaired,
            last_success_at: None,
            last_success_revision: None,
            dirty: false,
            last_error_category: Some("unsupported_platform".to_owned()),
            snapshot_schema_version: 1,
            this_device_id: None,
            devices: Vec::new(),
        }
    }
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

fn schema_v1() -> u32 {
    1
}
