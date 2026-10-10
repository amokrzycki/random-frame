use super::errors::SyncError;
use crate::persistence::{promote_json, save_json};
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
    /// Remote wins in represented domains; unsupported domains migrate from durable local v2 state.
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
    pub(super) fn from_snapshot(
        s: &crate::snapshot::SyncSnapshot,
        this_device: crate::snapshot::OperationId,
    ) -> Self {
        let meaningful = s.has_meaningful_synchronized_state(this_device);
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
    #[serde(rename = "joinedAtMs")]
    pub joined_at_ms: u64,
    #[serde(rename = "lastSyncedAtMs")]
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
    if let Some(bytes) = read_config_file(path)? {
        return decode_config(&bytes).map(Some);
    }
    let temporary_path = path.with_extension("json.tmp");
    let backup_path = path.with_extension("json.bak");
    let backup = read_config_file(&backup_path)?
        .as_deref()
        .map(decode_config)
        .transpose()?;
    let temporary = read_config_file(&temporary_path)?;
    let (candidate, config) = if let Some(bytes) = temporary {
        if bytes.len() > 1024 {
            return Err(SyncError::CorruptLocalState);
        }
        match serde_json::from_slice::<SyncLocalConfig>(&bytes) {
            Ok(config) => {
                config.validate()?;
                // A replacement cannot change pairing or lower a committed security floor.
                if backup.as_ref().is_some_and(|previous| {
                    previous.sync_id != config.sync_id
                        || previous.last_accepted_revision > config.last_accepted_revision
                        || previous.highest_schema_version > config.highest_schema_version
                }) {
                    return Err(SyncError::CorruptLocalState);
                }
                (temporary_path, config)
            }
            // A torn write has no accepted metadata; recover the last committed config.
            Err(error) if error.is_syntax() || error.is_eof() => {
                let config = backup.ok_or(SyncError::CorruptLocalState)?;
                (backup_path, config)
            }
            Err(_) => return Err(SyncError::CorruptLocalState),
        }
    } else if let Some(config) = backup {
        (backup_path, config)
    } else {
        return Ok(None);
    };
    promote_json(&candidate, path).map_err(|_| SyncError::Persistence)?;
    Ok(Some(config))
}

fn read_config_file(path: &Path) -> Result<Option<Vec<u8>>, SyncError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SyncError::Persistence),
    }
}

fn decode_config(bytes: &[u8]) -> Result<SyncLocalConfig, SyncError> {
    if bytes.len() > 1024 {
        return Err(SyncError::CorruptLocalState);
    }
    let config: SyncLocalConfig =
        serde_json::from_slice(bytes).map_err(|_| SyncError::CorruptLocalState)?;
    config.validate()?;
    Ok(config)
}

pub(super) fn save_config(path: &Path, config: &SyncLocalConfig) -> Result<(), SyncError> {
    config.validate()?;
    save_json(path, config).map_err(|_| SyncError::Persistence)
}

fn schema_v1() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::DeviceSummary;

    #[test]
    fn device_summary_matches_frontend_ipc_fixture() -> Result<(), serde_json::Error> {
        let device = DeviceSummary {
            device_id: "aabbccdd".into(),
            display_name: "Studio laptop".into(),
            platform: "linux".into(),
            joined_at_ms: 1_700_000_000_000,
            last_synced_at_ms: Some(1_700_000_060_000),
            this_device: true,
        };
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/sync-device-summary.json"
        ))?;
        assert_eq!(serde_json::to_value(&device)?, expected);
        let legacy = DeviceSummary {
            joined_at_ms: 0,
            last_synced_at_ms: None,
            ..device
        };
        let json = serde_json::to_value(legacy)?;
        assert_eq!(json["joinedAtMs"], 0);
        assert!(json["lastSyncedAtMs"].is_null());
        Ok(())
    }
}
