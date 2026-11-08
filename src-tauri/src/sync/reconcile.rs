use super::{errors::SyncError, state::Generation};
use crate::{
    persistence::{PersistentState, PreferenceStore},
    snapshot,
    sync_crypto::SyncKeys,
};
pub(super) struct SyncData<'a> {
    pub(super) state: &'a PersistentState,
}
/// Authenticates and decodes. Touches no local state.
pub(super) fn decode_remote(
    keys: &SyncKeys,
    envelope: &[u8],
) -> Result<snapshot::SyncSnapshot, SyncError> {
    let plaintext = keys
        .decrypt_snapshot(keys.sync_id(), envelope)
        .map_err(|_| SyncError::InvalidRemoteData)?;
    let remote = snapshot::parse_snapshot(&plaintext).map_err(|_| SyncError::InvalidRemoteData)?;
    #[cfg(any(test, debug_assertions))]
    snapshot::report_diagnostics(
        "after_remote_decode",
        &remote,
        plaintext.len(),
        envelope.len(),
    );
    Ok(remote)
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
    /// Restore, not CRDT union: every domain is remote-authoritative, including explicit
    /// empty values. A stale local roster is never imported; identity registers only this device.
    pub(super) fn restore_target(
        &self,
        remote: &snapshot::SyncSnapshot,
        at_ms: u64,
    ) -> Result<snapshot::SyncSnapshot, SyncError> {
        let mut target = remote.clone();
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

    pub(super) fn merge_remote(&self, keys: &SyncKeys, envelope: &[u8]) -> Result<(), SyncError> {
        let remote = decode_remote(keys, envelope)?;
        self.state.merge(&remote).map_err(|error| {
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
                        bytes.len(),
                        bytes.len() + crate::sync_crypto::ENVELOPE_OVERHEAD,
                    );
                }
            }
        }
        Ok(())
    }
}
