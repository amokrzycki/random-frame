//! One lock and a narrow write-ahead journal across the existing stores. HTTP never holds it.
use super::{
    device::DeviceIdentity,
    history::local_stamp,
    io::{load_json, save_json},
    sync_ops::operation_id,
    ActivityStore, ExplorationOutcome, ExplorationStore, FavoriteStore, HistoryItem,
    HistorySnapshot, HistoryStore, PreferenceStore, SeenStore,
};
use crate::{
    error::AppError,
    snapshot::{self, ActivityOperation, ExplorationRecord, Outcome, SyncRecord, SyncSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
pub type Generation = [u64; 6];
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    version: u8,
    id: [u8; 16],
    effects: SyncSnapshot,
    /// Restore: `effects` replace the synchronized stores instead of merging into them.
    #[serde(default)]
    replace: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_operation: Option<snapshot::OperationId>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ClearRequest {
    history: Vec<[u8; 16]>,
    activity: Vec<[u8; 16]>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Clears {
    requests: BTreeMap<String, Option<ClearRequest>>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct CheckCommit {
    pub inserted: bool,
    pub evidence_changed: bool,
}
#[derive(Clone, Copy)]
enum AcceptanceOrigin {
    Standard,
    Nearby,
}
pub struct PersistentState {
    path: PathBuf,
    clear_path: PathBuf,
    operation: Mutex<()>,
    changes: tokio::sync::watch::Sender<Generation>,
    pub seen: Arc<SeenStore>,
    pub history: Arc<HistoryStore>,
    pub favorites: Arc<FavoriteStore>,
    pub explored: Arc<ExplorationStore>,
    pub activity: Arc<ActivityStore>,
    pub preferences: Arc<PreferenceStore>,
    pub identity: Arc<DeviceIdentity>,
}
impl PersistentState {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        let identity = Arc::new(DeviceIdentity::new(directory)?);
        Self::with_identity(
            directory,
            Arc::clone(&identity),
            Arc::new(SeenStore::new(directory)?),
            Arc::new(HistoryStore::new(directory)?),
            Arc::new(FavoriteStore::new(directory)?),
            Arc::new(ExplorationStore::new(directory)?),
            Arc::new(ActivityStore::new(directory)?),
        )
    }
    pub fn with_identity(
        directory: &Path,
        identity: Arc<DeviceIdentity>,
        seen: Arc<SeenStore>,
        history: Arc<HistoryStore>,
        favorites: Arc<FavoriteStore>,
        explored: Arc<ExplorationStore>,
        activity: Arc<ActivityStore>,
    ) -> Result<Self, AppError> {
        let state = Self {
            path: directory.join("state-transaction.json"),
            clear_path: directory.join("history-clear.json"),
            operation: Mutex::new(()),
            changes: tokio::sync::watch::channel([0; 6]).0,
            seen,
            history,
            favorites,
            explored,
            activity,
            preferences: Arc::new(PreferenceStore::with_identity(directory, &identity)?),
            identity,
        };
        state.read(|| Ok(()))?;
        let clears: Clears = load_json(&state.clear_path)?;
        // A prepared clear survives closing the app during its Undo window.
        for (id, request) in clears.requests {
            if request.is_some() {
                state.commit_clear(&id)?;
            }
        }
        Ok(state)
    }
    pub fn read<T>(&self, f: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
        let _guard = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = self.generation();
        let result = self.recover().and_then(|()| f());
        let after = self.generation();
        if before != after {
            self.changes.send_replace(after);
        }
        result
    }
    pub fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<Generation> {
        self.changes.subscribe()
    }
    pub fn generation(&self) -> Generation {
        [
            self.seen.generation(),
            self.history.generation(),
            self.favorites.generation(),
            self.explored.generation(),
            self.activity.generation(),
            self.preferences.generation(),
        ]
    }

    /// Stage only in the upload copy. Failed publication must not alter the durable roster.
    pub fn snapshot_for_publication(
        &self,
        at_ms: u64,
    ) -> Result<(SyncSnapshot, Generation), AppError> {
        self.read(|| {
            let mut snapshot = self.snapshot_unlocked()?;
            PreferenceStore::stage_self_last_sync(&mut snapshot, &self.identity, at_ms);
            Ok((snapshot, self.generation()))
        })
    }

    /// Acknowledge the exact self record in the accepted envelope, preserving edits made
    /// during HTTP. Only the preference generation caused by this acknowledgement is clean.
    pub fn record_published_self(
        &self,
        record: crate::snapshot::DeviceRecord,
        mut generation: Generation,
    ) -> Result<Generation, AppError> {
        self.read(|| {
            let before = self.preferences.generation();
            self.preferences
                .merge(crate::snapshot::Preferences::default(), vec![record])?;
            if generation[5] == before {
                generation[5] = self.preferences.generation();
            }
            Ok(generation)
        })
    }

    pub fn snapshot(&self) -> Result<(SyncSnapshot, Generation), AppError> {
        self.read(|| Ok((self.snapshot_unlocked()?, self.generation())))
    }
    fn snapshot_unlocked(&self) -> Result<SyncSnapshot, AppError> {
        let (mut history, mut history_removed) = self.history.sync_state_with_generation().0;
        let saved = self.favorites.sync_state_with_generation().0;
        let mut favorites = saved.favorites;
        let mut favorites_removed = saved.favorites_removed;
        let (mut activity, mut activity_removed) = self.activity.sync_state();
        history.sort_by_key(|x| x.operation_id);
        history_removed.sort_unstable();
        favorites.sort_by_key(|x| x.operation_id);
        favorites_removed.sort_unstable();
        activity.sort_by_key(ActivityOperation::operation_id);
        activity_removed.sort_unstable();
        let (preferences, devices) = self.preferences.sync_state();
        let state = SyncSnapshot {
            seen: self.seen.snapshot_with_generation().0,
            history,
            history_removed,
            favorites,
            favorites_removed,
            collections: saved.collections,
            collections_removed: saved.collections_removed,
            memberships: saved.memberships,
            memberships_removed: saved.memberships_removed,
            exploration: self.explored.sync_state(),
            activity,
            activity_removed,
            preferences,
            devices,
        };
        snapshot::validate_snapshot(&state).map_err(AppError::persistence)?;
        Ok(state)
    }
    fn recover(&self) -> Result<(), AppError> {
        let pending: Option<Transaction> = load_json(&self.path)?;
        if let Some(pending) = pending {
            if pending.version != 2 {
                return Err(AppError::persistence("Unsupported transaction schema"));
            }
            // ponytail: recovery re-validates the entire snapshot before applying effects.
            // This adds startup latency for large datasets, but ensures crash safety:
            // a corrupted transaction file cannot partially apply and leave inconsistent state.
            // Bounded by the 64MB upload limit; acceptable tradeoff for durability guarantees.
            if pending.replace {
                snapshot::validate_snapshot(&pending.effects).map_err(AppError::persistence)?;
            } else {
                snapshot::merge_snapshots(&self.snapshot_unlocked()?, &pending.effects)
                    .map_err(AppError::persistence)?;
            }
            self.apply(&pending)?;
            save_json(&self.path, &Option::<Transaction>::None)?;
        }
        Ok(())
    }
    fn apply(&self, tx: &Transaction) -> Result<(), AppError> {
        if tx.replace {
            self.apply_replace(&tx.effects)?;
        } else {
            self.seen.merge(tx.effects.seen.iter().copied())?;
            self.history.merge_sync_state((
                tx.effects.history.clone(),
                tx.effects.history_removed.clone(),
            ))?;
            self.favorites
                .merge_sync_state(super::FavoriteSyncState::from_snapshot(&tx.effects))?;
            self.explored
                .merge_sync_state(tx.effects.exploration.clone())?;
            self.activity.merge_sync_state(
                tx.effects.activity.clone(),
                tx.effects.activity_removed.clone(),
            )?;
            self.preferences
                .merge(tx.effects.preferences.clone(), tx.effects.devices.clone())?;
        }
        if let Some(id) = tx.restore_operation {
            save_json(
                &self.path.with_file_name("sync-restore-receipt.json"),
                &Some(id),
            )?;
        }
        Ok(())
    }
    /// Every step is a set-to-target, so replaying a journaled Restore after a crash is idempotent.
    fn apply_replace(&self, target: &SyncSnapshot) -> Result<(), AppError> {
        self.seen.replace(&target.seen)?;
        self.history
            .replace_sync_state((target.history.clone(), target.history_removed.clone()))?;
        self.favorites
            .replace_sync_state(super::FavoriteSyncState::from_snapshot(target))?;
        self.explored
            .replace_sync_state(target.exploration.clone())?;
        self.activity
            .replace_sync_state(target.activity.clone(), target.activity_removed.clone())?;
        self.preferences
            .replace(target.preferences.clone(), target.devices.clone())?;
        // A prepared "clear history" holds pre-join operation IDs; committing it later would
        // publish those deletions.
        let mut clears: Clears = load_json(&self.clear_path)?;
        let mut changed = false;
        for request in clears.requests.values_mut() {
            changed |= request.take().is_some();
        }
        if changed {
            save_json(&self.clear_path, &clears)?;
        }
        Ok(())
    }
    /// Restore: makes `target` the whole synchronized state through the journal. Device
    /// identity, thumbnails and Sync credentials are not part of it and stay untouched.
    #[cfg(test)]
    pub fn replace_synchronized(&self, target: &SyncSnapshot) -> Result<Generation, AppError> {
        self.replace_synchronized_once(target, None)
    }
    pub fn replace_synchronized_once(
        &self,
        target: &SyncSnapshot,
        operation: Option<snapshot::OperationId>,
    ) -> Result<Generation, AppError> {
        self.read(|| {
            // One active admin journal: its durable receipt prevents replay erasing later local edits.
            let applied: Option<snapshot::OperationId> =
                load_json(&self.path.with_file_name("sync-restore-receipt.json"))?;
            if operation.is_some() && applied == operation {
                return Ok(self.generation());
            }
            snapshot::validate_snapshot(target).map_err(AppError::persistence)?;
            let tx = Transaction {
                version: 2,
                id: operation_id(),
                effects: target.clone(),
                replace: true,
                restore_operation: operation,
            };
            save_json(&self.path, &Some(&tx))?;
            self.apply(&tx)?;
            save_json(&self.path, &Option::<Transaction>::None)?;
            Ok(self.generation())
        })
    }
    fn transact(&self, effects: &SyncSnapshot) -> Result<(), AppError> {
        let current = self.snapshot_unlocked()?;
        let mut effects =
            snapshot::merge_snapshots(&current, effects).map_err(AppError::persistence)?;
        snapshot::reconcile_seen(&mut effects);
        if effects == current {
            return Ok(());
        }
        let tx = Transaction {
            version: 2,
            id: operation_id(),
            effects,
            replace: false,
            restore_operation: None,
        };
        // No upload-size check here: oversized local state must remain durable and recoverable.
        save_json(&self.path, &Some(&tx))?;
        self.apply(&tx)?;
        save_json(&self.path, &Option::<Transaction>::None)
    }
    /// Merges a validated remote snapshot through the journal.
    pub fn merge(&self, incoming: &SyncSnapshot) -> Result<(), AppError> {
        self.read(|| {
            snapshot::merge_snapshots(&self.snapshot_unlocked()?, incoming)
                .map_err(|error| AppError::invalid_input(error.to_string()))?;
            self.transact(incoming)
        })
    }
    pub fn record_check(
        &self,
        id: u64,
        outcome: ExplorationOutcome,
    ) -> Result<CheckCommit, AppError> {
        self.read(|| {
            if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
                return Err(AppError::invalid_input("Invalid image identifier"));
            }
            let previous = self.explored.evidence(id);
            // Evidence is a bitmask: bit 0 (1) = viewed, bit 1 (2) = rejected.
            // OR-ing outcomes accumulates them; an item viewed then rejected has evidence = 3.
            let evidence = previous.unwrap_or(0) | outcome.evidence();
            let changed = previous != Some(evidence);
            if changed {
                self.transact(&SyncSnapshot {
                    exploration: vec![ExplorationRecord {
                        source: "prntsc".into(),
                        id: crate::sources::prntsc::value_to_base36(id),
                        evidence,
                    }],
                    ..SyncSnapshot::default()
                })?;
            }
            Ok(CheckCommit {
                inserted: previous.is_none(),
                evidence_changed: changed,
            })
        })
    }
    pub fn discover(
        &self,
        id: u64,
        outcome: ExplorationOutcome,
        at_ms: u64,
        day: &str,
    ) -> Result<(), AppError> {
        self.read(|| {
            let mut effects = SyncSnapshot::default();
            self.discovery_effects(&mut effects, id, outcome, at_ms, day)?;
            self.transact(&effects)
        })
    }
    fn discovery_effects(
        &self,
        effects: &mut SyncSnapshot,
        id: u64,
        outcome: ExplorationOutcome,
        at_ms: u64,
        day: &str,
    ) -> Result<(), AppError> {
        if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
            return Err(AppError::invalid_input("Invalid image identifier"));
        }
        snapshot::validate_day(day).map_err(AppError::persistence)?;
        if let Some(previous) = self.explored.evidence(id) {
            if previous & outcome.evidence() == 0 {
                effects.exploration.push(ExplorationRecord {
                    source: "prntsc".into(),
                    id: crate::sources::prntsc::value_to_base36(id),
                    evidence: previous | outcome.evidence(),
                });
            }
            return Ok(());
        }
        let id = crate::sources::prntsc::value_to_base36(id);
        effects.exploration.push(ExplorationRecord {
            source: "prntsc".into(),
            id: id.clone(),
            evidence: outcome.evidence(),
        });
        effects.activity.push(ActivityOperation::Discovery {
            operation_id: operation_id(),
            source: "prntsc".into(),
            id,
            outcome: match outcome {
                ExplorationOutcome::Viewed => Outcome::Viewed,
                ExplorationOutcome::Rejected => Outcome::Rejected,
            },
            occurred_at_ms: at_ms,
            day: day.into(),
        });
        Ok(())
    }
    pub fn accept(&self, item: &HistoryItem) -> Result<HistorySnapshot, AppError> {
        self.accept_with_origin(item, AcceptanceOrigin::Standard)
    }
    pub fn accept_nearby(&self, item: &HistoryItem) -> Result<HistorySnapshot, AppError> {
        self.accept_with_origin(item, AcceptanceOrigin::Nearby)
    }
    fn accept_with_origin(
        &self,
        item: &HistoryItem,
        origin: AcceptanceOrigin,
    ) -> Result<HistorySnapshot, AppError> {
        self.read(|| {
            snapshot::validate_fields(&item.source, &item.id, &item.source_page_url)
                .map_err(AppError::persistence)?;
            let current = self.snapshot_unlocked()?;
            let mut effects = SyncSnapshot::default();
            let stamp = local_stamp(item.viewed_at, false);
            if let Some(existing) = current
                .history
                .iter()
                .find(|x| x.source == item.source && x.id == item.id)
            {
                let mut op = existing.clone();
                if stamp.key() > op.last_view.key() {
                    op.last_view = stamp.clone();
                }
                effects.history.push(op);
            } else {
                effects.history.push(SyncRecord {
                    operation_id: operation_id(),
                    order_at: current
                        .history
                        .iter()
                        .map(|x| x.order_at.saturating_add(1))
                        .max()
                        .unwrap_or(0)
                        .max(item.viewed_at),
                    last_view: stamp.clone(),
                    source: item.source.clone(),
                    id: item.id.clone(),
                    source_page_url: item.source_page_url.clone(),
                });
            }
            if item.source == "prntsc" {
                let id = crate::sources::prntsc::item_id_value(&item.id)?;
                effects.seen.push(id);
                if matches!(origin, AcceptanceOrigin::Nearby) {
                    effects.exploration.push(ExplorationRecord {
                        source: "prntsc".into(),
                        id: crate::sources::prntsc::value_to_base36(id),
                        evidence: 1,
                    });
                } else {
                    self.discovery_effects(
                        &mut effects,
                        id,
                        ExplorationOutcome::Viewed,
                        item.viewed_at,
                        &stamp.day,
                    )?;
                }
            }
            self.transact(&effects)?;
            let position = self
                .history
                .snapshot()
                .history
                .iter()
                .position(|x| x.source == item.source && x.id == item.id)
                .ok_or_else(|| AppError::persistence("Accepted frame missing"))?;
            self.history.select(position)
        })
    }
    pub fn prepare_clear(&self) -> Result<String, AppError> {
        self.read(|| {
            let current = self.snapshot_unlocked()?;
            let mut clears: Clears = load_json(&self.clear_path)?;
            let id = hex::encode(operation_id());
            clears.requests.insert(
                id.clone(),
                Some(ClearRequest {
                    history: current.history.iter().map(|x| x.operation_id).collect(),
                    activity: current
                        .activity
                        .iter()
                        .map(ActivityOperation::operation_id)
                        .collect(),
                }),
            );
            save_json(&self.clear_path, &clears)?;
            Ok(id)
        })
    }
    pub fn commit_clear(&self, id: &str) -> Result<(), AppError> {
        self.read(|| {
            let mut clears: Clears = load_json(&self.clear_path)?;
            let request = clears
                .requests
                .get(id)
                .ok_or_else(|| AppError::invalid_input("Unknown clear request"))?;
            if let Some(request) = request {
                let mut history_removed = request.history.clone();
                history_removed.sort_unstable();
                let mut activity_removed = request.activity.clone();
                activity_removed.sort_unstable();
                self.transact(&SyncSnapshot {
                    history_removed,
                    activity_removed,
                    ..SyncSnapshot::default()
                })?;
                clears.requests.insert(id.into(), None);
                save_json(&self.clear_path, &clears)?;
            }
            Ok(())
        })
    }
    pub fn cancel_clear(&self, id: &str) -> Result<(), AppError> {
        self.read(|| {
            let mut clears: Clears = load_json(&self.clear_path)?;
            if !clears.requests.contains_key(id) {
                return Err(AppError::invalid_input("Unknown clear request"));
            }
            clears.requests.insert(id.into(), None);
            save_json(&self.clear_path, &clears)
        })
    }
}
