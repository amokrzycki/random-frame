use super::{errors::SyncError, state::Generation};
use crate::{
    persistence::PersistentState,
    snapshot,
    sync_crypto::{CryptoError, SyncKeys},
};
pub(super) struct SyncData<'a> {
    pub(super) state: &'a PersistentState,
}
impl SyncData<'_> {
    pub(super) fn local_snapshot(&self) -> Result<(Vec<u8>, Generation), SyncError> {
        let (snapshot, generation) = self.state.snapshot().map_err(|_| SyncError::Persistence)?;
        let bytes = snapshot::serialize_snapshot(&snapshot).map_err(|error| match error {
            snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
            _ => SyncError::Persistence,
        })?;
        Ok((bytes, generation))
    }
    pub(super) fn merge_remote(
        &self,
        keys: &SyncKeys,
        envelope: &[u8],
        schema_floor: u32,
        revision: i64,
    ) -> Result<u32, SyncError> {
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
        self.state
            .merge_versioned(&remote.data, keys.sync_id(), remote.original_schema_version)
            .map_err(|error| {
                if error.kind == crate::error::ErrorKind::InvalidInput {
                    SyncError::InvalidRemoteData
                } else {
                    SyncError::Persistence
                }
            })?;
        Ok(remote.original_schema_version)
    }
}
