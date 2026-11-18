use super::errors::SyncError;
use crate::{
    persistence::{promote_json, save_json},
    sync_protocol::valid_hex,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

/// The config is a few small fields; anything larger is damaged, not data to parse.
const MAX_CONFIG_BYTES: usize = 1024;

pub(super) type Generation = crate::persistence::transaction::Generation;

/// What this device remembers about its Sync group.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncLocalConfig {
    pub(super) group_id: String,
    pub(super) member_id: String,
    pub(super) credential_version: i64,
    pub(super) key_id: String,
    pub(super) epoch: i64,
    pub(super) last_accepted_revision: i64,
    #[serde(default)]
    pub(super) last_success_at: Option<u64>,
    pub(super) terminal: Option<String>,
    pub(super) adoption: Option<JoinMode>,
    #[serde(default)]
    pub(super) left_locally: bool,
}

impl SyncLocalConfig {
    pub(super) fn validate(&self) -> Result<(), SyncError> {
        if !valid_hex(&self.group_id, 32)
            || !valid_hex(&self.member_id, 16)
            || !valid_hex(&self.key_id, 32)
            || self.credential_version < 1
            || self.epoch < 1
            || self.last_accepted_revision < 1
            || self.terminal.as_ref().is_some_and(|s| {
                !matches!(
                    s.as_str(),
                    "revoked" | "closed" | "credential_replaced" | "left"
                )
            })
        {
            return Err(SyncError::CorruptLocalState);
        }
        Ok(())
    }
}

/// How a device without Sync credentials adopts an existing Sync.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    /// Remote replaces local synchronized state.
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
    pub collections: usize,
    pub collection_removals: usize,
    pub memberships: usize,
    pub membership_removals: usize,
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
            collections: s.collections.len(),
            collection_removals: s.collections_removed.len(),
            memberships: s.memberships.len(),
            membership_removals: s.memberships_removed.len(),
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
    UpdatingKey,
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
    pub member_id: Option<String>,
    pub status: Option<String>,
    pub is_master: bool,
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
    pub this_device_id: Option<String>,
    pub devices: Vec<DeviceSummary>,
    #[serde(flatten)]
    pub control: MembershipStatus,
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
            this_device_id: None,
            devices: Vec::new(),
            control: MembershipStatus::default(),
        }
    }
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
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(SyncError::CorruptLocalState);
        }
        match serde_json::from_slice::<SyncLocalConfig>(&bytes) {
            Ok(config) => {
                config.validate()?;
                if let Some(previous) = &backup {
                    if previous.group_id != config.group_id
                        || previous.member_id != config.member_id
                        || previous.last_accepted_revision > config.last_accepted_revision
                        || previous.epoch > config.epoch
                        || previous.credential_version > config.credential_version
                        || previous.terminal.is_some() && previous.terminal != config.terminal
                    {
                        return Err(SyncError::CorruptLocalState);
                    }
                }
                (temporary_path, config)
            }
            // A torn write has no accepted metadata; recover the last committed config.
            Err(error) if error.is_syntax() || error.is_eof() => {
                let Some(config) = backup else {
                    // The very first write tore; the journal that caused it will be replayed.
                    let _ = fs::remove_file(&temporary_path);
                    return Ok(None);
                };
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
    if bytes.len() > MAX_CONFIG_BYTES {
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

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipStatus {
    pub group_state: Option<String>,
    pub membership_state: Option<String>,
    pub master_member_id: Option<String>,
    pub this_member_id: Option<String>,
    pub credential_version: Option<i64>,
    pub key_epoch: Option<i64>,
    pub control_verified_at: Option<u64>,
    /// Administrator only: a join code is registered and can be shown.
    pub code_ready: bool,
}

/// Result of creating a Sync. `code` is absent only if registering it failed after the
/// group already exists; the administrator then asks for a new code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSyncResult {
    pub code: Option<String>,
    pub status: SyncStatus,
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
            member_id: None,
            status: None,
            is_master: false,
        };
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/sync-device-summary.json"
        ))?;
        assert_eq!(serde_json::to_value(&device)?, expected);
        let unknown = DeviceSummary {
            joined_at_ms: 0,
            last_synced_at_ms: None,
            ..device
        };
        let json = serde_json::to_value(unknown)?;
        assert_eq!(json["joinedAtMs"], 0);
        assert!(json["lastSyncedAtMs"].is_null());
        Ok(())
    }
}
