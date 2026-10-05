use super::{errors::SyncError, state::Generation};
use crate::{
    persistence::{PersistentState, PreferenceStore},
    snapshot,
    sync_crypto::{CryptoError, SyncKeys},
};
pub(super) struct SyncData<'a> {
    pub(super) state: &'a PersistentState,
}
impl SyncData<'_> {
    pub(super) fn local_snapshot(
        &self,
    ) -> Result<(Vec<u8>, Generation, snapshot::DeviceRecord), SyncError> {
        let (snapshot, generation) = self
            .state
            .snapshot_for_publication(crate::time::now_ms())
            .map_err(|_| SyncError::Persistence)?;
        let self_record = snapshot
            .devices
            .iter()
            .find(|d| d.device_id == self.state.identity.id())
            .cloned()
            .ok_or(SyncError::Persistence)?;
        let bytes = snapshot::serialize_snapshot(&snapshot).map_err(|error| match error {
            snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
            _ => SyncError::Persistence,
        })?;
        Ok((bytes, generation, self_record))
    }
    /// Authenticates, decodes and applies every downgrade rule. Touches no local state.
    pub(super) fn decode_remote(
        &self,
        keys: &SyncKeys,
        envelope: &[u8],
        schema_floor: u32,
        revision: i64,
    ) -> Result<snapshot::DecodedSnapshot, SyncError> {
        let plaintext =
            keys.decrypt_snapshot(keys.sync_id(), envelope)
                .map_err(|error| match error {
                    CryptoError::UnsupportedSnapshotVersion(version) => {
                        SyncError::UnsupportedVersion(version)
                    }
                    _ => SyncError::InvalidRemoteData,
                })?;
        let remote = snapshot::decode_snapshot(&plaintext).map_err(|error| match error {
            snapshot::SnapshotError::UnsupportedVersion(version) => {
                SyncError::UnsupportedVersion(version)
            }
            _ => SyncError::InvalidRemoteData,
        })?;
        debug_assert_eq!(remote.needs_upgrade, remote.original_schema_version == 1);
        #[cfg(any(test, debug_assertions))]
        snapshot::report_diagnostics(
            "after_remote_decode",
            &remote.data,
            remote.original_schema_version,
            plaintext.len(),
            envelope.len(),
        );
        let schema_floor = schema_floor
            .max(
                self.state
                    .schema_floor(keys.sync_id())
                    .map_err(|_| SyncError::Persistence)?,
            )
            .max(
                self.state
                    .publication_floor(keys.sync_id(), revision)
                    .map_err(|_| SyncError::Persistence)?,
            );
        if remote.original_schema_version < schema_floor {
            return Err(SyncError::SchemaDowngrade);
        }
        Ok(remote)
    }

    /// Schema-aware Restore, not CRDT union. Represented domains are remote-authoritative,
    /// including explicit empty values. Only unsupported content domains use captured local
    /// v2 state. A stale local roster is never imported; identity registers only this device.
    pub(super) fn restore_target(
        &self,
        remote: &snapshot::DecodedSnapshot,
        local: &snapshot::SyncSnapshot,
        at_ms: u64,
    ) -> Result<snapshot::SyncSnapshot, SyncError> {
        use snapshot::SyncDomain;
        debug_assert!([
            SyncDomain::Seen,
            SyncDomain::History,
            SyncDomain::HistoryRemovals,
            SyncDomain::Favorites,
            SyncDomain::FavoriteRemovals,
        ]
        .into_iter()
        .all(|domain| remote.represents(domain)));
        let mut target = remote.data.clone();
        if !remote.represents(SyncDomain::Exploration) {
            target.exploration.clone_from(&local.exploration);
        }
        if !remote.represents(SyncDomain::Activity) {
            target.activity.clone_from(&local.activity);
        }
        if !remote.represents(SyncDomain::ActivityRemovals) {
            target.activity_removed.clone_from(&local.activity_removed);
        }
        if !remote.represents(SyncDomain::Preferences) {
            target.preferences.clone_from(&local.preferences);
        }
        if !remote.represents(SyncDomain::Devices) {
            target.devices.clear();
        }
        let remote_has_self = target
            .devices
            .iter()
            .any(|d| d.device_id == self.state.identity.id());
        PreferenceStore::register_self(&mut target, &self.state.identity, at_ms);
        // Preserve only this identity's known join date; Restore still discards the local roster.
        if let Some(known) = self
            .state
            .preferences
            .sync_state()
            .1
            .iter()
            .find(|d| d.device_id == self.state.identity.id())
        {
            if let Some(record) = target
                .devices
                .iter_mut()
                .find(|d| d.device_id == known.device_id)
            {
                record.joined_at_ms = if remote_has_self {
                    snapshot::earliest_joined_at(record.joined_at_ms, known.joined_at_ms)
                } else {
                    known.joined_at_ms
                };
            }
        }
        // Keep the existing persistence invariant: viewed evidence in retained History or
        // Exploration implies Seen. This never copies the unrelated local Seen collection.
        snapshot::reconcile_seen(&mut target);
        snapshot::validate_snapshot(&target).map_err(|_| SyncError::InvalidRemoteData)?;
        Ok(target)
    }

    pub(super) fn merge_remote(
        &self,
        keys: &SyncKeys,
        envelope: &[u8],
        schema_floor: u32,
        revision: i64,
    ) -> Result<u32, SyncError> {
        let remote = self.decode_remote(keys, envelope, schema_floor, revision)?;
        self.state
            .merge_versioned(&remote.data, keys.sync_id(), remote.original_schema_version)
            .map_err(|error| {
                if error.kind == crate::error::ErrorKind::InvalidInput {
                    SyncError::InvalidRemoteData
                } else {
                    SyncError::Persistence
                }
            })?;
        #[cfg(any(test, debug_assertions))]
        if snapshot::diagnostics_enabled() {
            // After merge there is no envelope yet. Its planned length is exactly
            // the serialized length plus the frozen 52-byte envelope overhead.
            if let Ok((merged, _)) = self.state.snapshot() {
                if let Ok(bytes) = snapshot::serialize_snapshot(&merged) {
                    snapshot::report_diagnostics(
                        "after_merge",
                        &merged,
                        2,
                        bytes.len(),
                        bytes.len() + crate::sync_crypto::ENVELOPE_OVERHEAD,
                    );
                }
            }
        }
        Ok(remote.original_schema_version)
    }
}
