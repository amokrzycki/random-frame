use super::{errors::SyncError, state::Generation};
use crate::{
    persistence::{FavoriteStore, HistoryStore, SeenStore},
    snapshot,
    sync_crypto::SyncKeys,
};

pub(super) struct SyncData<'a> {
    pub(super) seen: &'a SeenStore,
    pub(super) history: &'a HistoryStore,
    pub(super) favorites: &'a FavoriteStore,
}

impl SyncData<'_> {
    pub(super) fn local_snapshot(&self) -> Result<(Vec<u8>, Generation), SyncError> {
        let seen = self.seen.snapshot_with_generation();
        let history = &self.history;
        let favorites = &self.favorites;
        let ((mut history_ops, mut history_removed), history_generation) =
            history.sync_state_with_generation();
        let ((mut favorite_ops, mut favorite_removed), favorites_generation) =
            favorites.sync_state_with_generation();
        history_ops.sort_by_key(|op| op.operation_id);
        history_removed.sort_unstable();
        favorite_ops.sort_by_key(|op| op.operation_id);
        favorite_removed.sort_unstable();
        let bytes = snapshot::serialize_snapshot(&snapshot::SyncSnapshot {
            seen: seen.0,
            history: history_ops,
            history_removed,
            favorites: favorite_ops,
            favorites_removed: favorite_removed,
        })
        .map_err(|error| match error {
            snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
            _ => SyncError::Persistence,
        })?;
        Ok((bytes, (seen.1, history_generation, favorites_generation)))
    }

    pub(super) fn merge_remote(&self, keys: &SyncKeys, envelope: &[u8]) -> Result<(), SyncError> {
        let plaintext = keys
            .decrypt_snapshot(keys.sync_id(), envelope)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        let remote =
            snapshot::parse_snapshot(&plaintext).map_err(|_| SyncError::InvalidRemoteData)?;
        self.seen
            .merge(remote.seen)
            .map_err(|_| SyncError::Persistence)?;
        self.history
            .merge_sync_state((remote.history, remote.history_removed))
            .map_err(|_| SyncError::Persistence)?;
        self.favorites
            .merge_sync_state((remote.favorites, remote.favorites_removed))
            .map_err(|_| SyncError::Persistence)?;
        Ok(())
    }
}
