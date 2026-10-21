use super::errors::SyncError;
use crate::persistence::{promote_json, save_json};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub(super) type Generation = crate::persistence::transaction::Generation;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncLocalConfig {
    pub(super) protocol_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) managed: Option<ManagedConfig>,
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
            managed: None,
            sync_id,
            last_accepted_revision: Some(revision),
            highest_schema_version: crate::snapshot::CURRENT_SNAPSHOT_SCHEMA,
            last_success_at: None,
        }
    }

    pub(super) fn validate(&self) -> Result<(), SyncError> {
        if !(1..=crate::snapshot::CURRENT_SNAPSHOT_SCHEMA).contains(&self.highest_schema_version)
            || !matches!(
                (self.protocol_version, &self.managed),
                (1, None) | (2, Some(_))
            )
            || self.sync_id.len() != 64
            || !self
                .sync_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.last_accepted_revision.is_some_and(|r| r < 1)
        {
            return Err(SyncError::CorruptLocalState);
        }
        if let Some(m) = &self.managed {
            m.validate()?;
        }
        Ok(())
    }
}

/// How a device without Sync credentials adopts an existing Sync.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    UpgradeRequired,
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
    pub snapshot_schema_version: u32,
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
            snapshot_schema_version: 1,
            this_device_id: None,
            devices: Vec::new(),
            control: MembershipStatus::default(),
        }
    }
}

#[cfg(test)]
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
                if let Some(previous) = &backup {
                    if previous.sync_id != config.sync_id {
                        // A journaled move is the one intentional switch of group identity.
                        if !pending_managed_move(path, previous, &config)? {
                            return Err(SyncError::CorruptLocalState);
                        }
                    } else if previous.last_accepted_revision > config.last_accepted_revision
                        || previous.highest_schema_version > config.highest_schema_version
                        || previous
                            .managed
                            .as_ref()
                            .zip(config.managed.as_ref())
                            .is_some_and(|(a, b)| {
                                a.member_id != b.member_id
                                    || a.epoch > b.epoch
                                    || a.credential_version > b.credential_version
                                    || a.terminal.is_some() && a.terminal != b.terminal
                            })
                    {
                        return Err(SyncError::CorruptLocalState);
                    }
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
            member_id: None,
            status: None,
            is_master: false,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManagedConfig {
    pub member_id: String,
    pub credential_version: i64,
    pub key_id: String,
    pub epoch: i64,
    pub terminal: Option<String>,
    pub legacy_source_id: Option<String>,
    pub adoption: Option<JoinMode>,
    #[serde(default)]
    pub left_locally: bool,
}
impl ManagedConfig {
    fn validate(&self) -> Result<(), SyncError> {
        use crate::sync_protocol::valid_hex;
        if !valid_hex(&self.member_id, 16)
            || !valid_hex(&self.key_id, 32)
            || self.credential_version < 1
            || self.epoch < 1
            || self
                .legacy_source_id
                .as_ref()
                .is_some_and(|s| !valid_hex(s, 32))
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
    pub legacy_source_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateManagedSyncResult {
    pub group_id: String,
    pub admin_recovery_code: String,
    pub status: SyncStatus,
    pub source_legacy_id: Option<String>,
    pub prepared: bool,
}

fn pending_managed_move(
    path: &Path,
    old: &SyncLocalConfig,
    new: &SyncLocalConfig,
) -> Result<bool, SyncError> {
    if old.protocol_version != 1 || new.protocol_version != 2 {
        return Ok(false);
    }
    let journal: Option<super::admin::Journal> =
        crate::persistence::load_json(&path.with_file_name("sync-admin.json"))
            .map_err(|_| SyncError::CorruptLocalState)?;
    let Some(journal) = journal else {
        return Ok(false);
    };
    let crate::sync_protocol::Mutation::Create { member, .. } = &journal.request.mutation else {
        return Ok(false);
    };
    Ok(journal.version == 2
        && journal.promote
        && journal.confirmed
        && journal.group_id == new.sync_id
        && journal.legacy_source_id.as_deref() == Some(&old.sync_id)
        && new.managed.as_ref().is_some_and(|m| {
            m.member_id == member.member_id && m.legacy_source_id.as_deref() == Some(&old.sync_id)
        }))
}
