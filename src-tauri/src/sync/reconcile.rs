use super::{errors::SyncError, state::Generation};
use crate::{
    persistence::{PersistentState, PreferenceStore},
    snapshot,
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
    /// Replaces local synchronized state with the remote snapshot: every domain is
    /// remote-authoritative, including explicit empty values. A stale local roster is never imported; identity registers only this device.
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
        // Keep the existing persistence invariant: every Prnt.sc frame in retained
        // History implies Seen. This never copies the unrelated local Seen collection.
        snapshot::reconcile_seen(&mut target);
        snapshot::validate_snapshot(&target).map_err(|_| SyncError::InvalidRemoteData)?;
        Ok(target)
    }
}
