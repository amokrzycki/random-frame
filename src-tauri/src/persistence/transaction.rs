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
    close_legacy_import: bool,
    #[serde(default)]
    session_import: bool,
    #[serde(default)]
    accepted_schema: Option<(String, u32)>,
    /// Restore: `effects` replace the synchronized stores instead of merging into them.
    #[serde(default)]
    replace: bool,
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
    #[serde(default)]
    legacy_request: Option<String>,
    requests: BTreeMap<String, Option<ClearRequest>>,
}
pub struct PersistentState {
    path: PathBuf,
    clear_path: PathBuf,
    schema_path: PathBuf,
    publication_path: PathBuf,
    operation: Mutex<()>,
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
    #[cfg(test)]
    pub fn with_stores(
        directory: &Path,
        seen: Arc<SeenStore>,
        history: Arc<HistoryStore>,
        favorites: Arc<FavoriteStore>,
        explored: Arc<ExplorationStore>,
        activity: Arc<ActivityStore>,
    ) -> Result<Self, AppError> {
        Self::with_identity(
            directory,
            Arc::new(DeviceIdentity::new(directory)?),
            seen,
            history,
            favorites,
            explored,
            activity,
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
            schema_path: directory.join("sync-schema-floor.json"),
            publication_path: directory.join("sync-publication.json"),
            operation: Mutex::new(()),
            seen,
            history,
            favorites,
            explored,
            activity,
            preferences: Arc::new(PreferenceStore::with_identity(directory, identity.clone())?),
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
        self.recover()?;
        f()
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

    pub fn stage_self_last_sync(&self, at_ms: u64) -> Result<(), AppError> {
        self.read(|| self.preferences.update_self_last_sync(at_ms))
    }

    pub fn set_device_name(&self, name: &str) -> Result<(), AppError> {
        self.read(|| {
            self.identity.set_display_name(name)?;
            self.preferences
                .set_device_metadata(self.identity.metadata())
        })
    }
    pub fn snapshot(&self) -> Result<(SyncSnapshot, Generation), AppError> {
        self.read(|| Ok((self.snapshot_unlocked()?, self.generation())))
    }
    fn snapshot_unlocked(&self) -> Result<SyncSnapshot, AppError> {
        let (mut history, mut history_removed) = self.history.sync_state_with_generation().0;
        let (mut favorites, mut favorites_removed) = self.favorites.sync_state_with_generation().0;
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
            if pending.version != 1 {
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
            self.favorites.merge_sync_state((
                tx.effects.favorites.clone(),
                tx.effects.favorites_removed.clone(),
            ))?;
            self.explored
                .merge_sync_state(tx.effects.exploration.clone())?;
            self.activity.merge_sync_state(
                tx.effects.activity.clone(),
                tx.effects.activity_removed.clone(),
                tx.close_legacy_import,
            )?;
            self.preferences
                .merge(tx.effects.preferences.clone(), tx.effects.devices.clone())?;
        }
        if tx.session_import {
            super::migration::receipt(
                self.path
                    .parent()
                    .ok_or_else(|| AppError::persistence("Missing data directory"))?,
                "session-history",
            )?;
        }
        if let Some((id, schema)) = &tx.accepted_schema {
            let mut floors: BTreeMap<String, u32> = load_json(&self.schema_path)?;
            let floor = floors.entry(id.clone()).or_insert(1);
            *floor = (*floor).max(*schema);
            save_json(&self.schema_path, &floors)?;
        }
        Ok(())
    }
    /// Every step is a set-to-target, so replaying a journaled Restore after a crash is idempotent.
    fn apply_replace(&self, target: &SyncSnapshot) -> Result<(), AppError> {
        self.seen.replace(&target.seen)?;
        self.history
            .replace_sync_state((target.history.clone(), target.history_removed.clone()))?;
        self.favorites
            .replace_sync_state((target.favorites.clone(), target.favorites_removed.clone()))?;
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
    pub fn replace_synchronized(&self, target: &SyncSnapshot) -> Result<Generation, AppError> {
        self.read(|| {
            snapshot::validate_snapshot(target).map_err(AppError::persistence)?;
            let tx = Transaction {
                version: 1,
                id: operation_id(),
                effects: target.clone(),
                close_legacy_import: true,
                // The browser session import is pre-join local history as well.
                session_import: true,
                accepted_schema: None,
                replace: true,
            };
            save_json(&self.path, &Some(&tx))?;
            self.apply(&tx)?;
            save_json(&self.path, &Option::<Transaction>::None)?;
            Ok(self.generation())
        })
    }
    /// Test hook: a Restore that crashed right after its journal became durable.
    #[cfg(test)]
    pub fn journal_replace_only(&self, target: &SyncSnapshot) -> Result<(), AppError> {
        let tx = Transaction {
            version: 1,
            id: operation_id(),
            effects: target.clone(),
            close_legacy_import: true,
            session_import: true,
            accepted_schema: None,
            replace: true,
        };
        save_json(&self.path, &Some(&tx))
    }
    fn transact(&self, effects: &SyncSnapshot, close_legacy_import: bool) -> Result<(), AppError> {
        self.transact_import(effects, close_legacy_import, false)
    }
    fn transact_import(
        &self,
        effects: &SyncSnapshot,
        close_legacy_import: bool,
        session_import: bool,
    ) -> Result<(), AppError> {
        self.transact_versioned(effects, close_legacy_import, session_import, None)
    }
    fn transact_versioned(
        &self,
        effects: &SyncSnapshot,
        close_legacy_import: bool,
        session_import: bool,
        accepted_schema: Option<(String, u32)>,
    ) -> Result<(), AppError> {
        let current = self.snapshot_unlocked()?;
        let mut effects =
            snapshot::merge_snapshots(&current, effects).map_err(AppError::persistence)?;
        snapshot::reconcile_seen(&mut effects);
        if effects == current
            && !close_legacy_import
            && !session_import
            && accepted_schema.is_none()
        {
            return Ok(());
        }
        let tx = Transaction {
            version: 1,
            id: operation_id(),
            effects,
            close_legacy_import,
            session_import,
            accepted_schema,
            replace: false,
        };
        // No upload-size check here: oversized local state must remain durable and recoverable.
        save_json(&self.path, &Some(&tx))?;
        self.apply(&tx)?;
        save_json(&self.path, &Option::<Transaction>::None)
    }
    #[cfg(test)]
    pub fn merge(&self, incoming: &SyncSnapshot) -> Result<(), AppError> {
        self.read(|| {
            snapshot::merge_snapshots(&self.snapshot_unlocked()?, incoming)
                .map_err(|error| AppError::invalid_input(error.to_string()))?;
            self.transact(incoming, false)
        })
    }
    pub fn schema_floor(&self, sync_id: &str) -> Result<u32, AppError> {
        self.read(|| {
            let floors: BTreeMap<String, u32> = load_json(&self.schema_path)?;
            if floors.values().any(|v| !(1..=2).contains(v)) {
                return Err(AppError::persistence("Invalid schema floor"));
            }
            Ok(floors.get(sync_id).copied().unwrap_or(1))
        })
    }
    pub fn publication_floor(&self, sync_id: &str, revision: i64) -> Result<u32, AppError> {
        self.read(|| {
            let pending: BTreeMap<String, i64> = load_json(&self.publication_path)?;
            // An unanswered PUT may have succeeded. At its original revision, v1 can
            // still be retried; a later revision must honor the attempted v2 publication.
            Ok(
                if pending.get(sync_id).is_some_and(|base| revision > *base) {
                    2
                } else {
                    1
                },
            )
        })
    }
    pub fn begin_publication(&self, sync_id: &str, revision: i64) -> Result<(), AppError> {
        self.read(|| {
            let mut pending: BTreeMap<String, i64> = load_json(&self.publication_path)?;
            pending.insert(sync_id.into(), revision);
            save_json(&self.publication_path, &pending)
        })
    }
    pub fn cancel_publication(&self, sync_id: &str) -> Result<(), AppError> {
        self.read(|| self.cancel_publication_unlocked(sync_id))
    }
    fn cancel_publication_unlocked(&self, sync_id: &str) -> Result<(), AppError> {
        let mut pending: BTreeMap<String, i64> = load_json(&self.publication_path)?;
        if pending.remove(sync_id).is_some() {
            save_json(&self.publication_path, &pending)?;
        }
        Ok(())
    }
    pub fn complete_publication(&self, sync_id: &str) -> Result<(), AppError> {
        self.read(|| {
            let mut floors: BTreeMap<String, u32> = load_json(&self.schema_path)?;
            floors.insert(sync_id.into(), 2);
            save_json(&self.schema_path, &floors)?;
            self.cancel_publication_unlocked(sync_id)
        })
    }
    pub fn merge_versioned(
        &self,
        incoming: &SyncSnapshot,
        sync_id: &str,
        schema: u32,
    ) -> Result<(), AppError> {
        self.read(|| {
            let floors: BTreeMap<String, u32> = load_json(&self.schema_path)?;
            if schema < floors.get(sync_id).copied().unwrap_or(1) {
                return Err(AppError::invalid_input("Schema downgrade"));
            }
            snapshot::merge_snapshots(&self.snapshot_unlocked()?, incoming)
                .map_err(|error| AppError::invalid_input(error.to_string()))?;
            self.transact_versioned(incoming, false, false, Some((sync_id.into(), schema)))
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
            self.transact(&effects, false)
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
        if self.explored.contains(id) {
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
    pub fn accept(
        &self,
        item: &HistoryItem,
        legacy_import: bool,
    ) -> Result<HistorySnapshot, AppError> {
        self.read(|| {
            snapshot::validate_fields(&item.source, &item.id, &item.source_page_url)
                .map_err(AppError::persistence)?;
            let current = self.snapshot_unlocked()?;
            let mut effects = SyncSnapshot::default();
            let stamp = local_stamp(item.viewed_at, legacy_import);
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
                if !legacy_import {
                    self.discovery_effects(
                        &mut effects,
                        id,
                        ExplorationOutcome::Viewed,
                        item.viewed_at,
                        &stamp.day,
                    )?;
                }
            }
            self.transact(&effects, false)?;
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
    pub fn import_session_history(
        &self,
        items: Vec<HistoryItem>,
        index: i64,
    ) -> Result<HistorySnapshot, AppError> {
        self.read(|| {
            let directory = self
                .path
                .parent()
                .ok_or_else(|| AppError::persistence("Missing data directory"))?;
            if super::migration::has_receipt(directory, "session-history")? {
                return Ok(self.history.snapshot());
            }
            let mut current = self.snapshot_unlocked()?;
            for item in items {
                snapshot::validate_fields(&item.source, &item.id, &item.source_page_url)
                    .map_err(AppError::persistence)?;
                if item.source == "prntsc" {
                    current
                        .seen
                        .push(crate::sources::prntsc::item_id_value(&item.id)?);
                }
                if !current
                    .history
                    .iter()
                    .any(|x| x.source == item.source && x.id == item.id)
                {
                    current.history.push(SyncRecord {
                        operation_id: operation_id(),
                        order_at: current
                            .history
                            .iter()
                            .map(|x| x.order_at.saturating_add(1))
                            .max()
                            .unwrap_or(0)
                            .max(item.viewed_at),
                        last_view: local_stamp(item.viewed_at, true),
                        source: item.source,
                        id: item.id,
                        source_page_url: item.source_page_url,
                    });
                }
            }
            current.seen.sort_unstable();
            current.seen.dedup();
            current.history.sort_by_key(|x| x.operation_id);
            self.transact_import(&current, false, true)?;
            if let Ok(index) = usize::try_from(index) {
                if index < self.history.snapshot().history.len() {
                    return self.history.select(index);
                }
            }
            Ok(self.history.snapshot())
        })
    }
    pub fn prepare_clear(&self) -> Result<String, AppError> {
        self.prepare_clear_request(false)
    }
    pub fn prepare_clear_request(&self, legacy_pending: bool) -> Result<String, AppError> {
        self.read(|| {
            let current = self.snapshot_unlocked()?;
            let mut clears: Clears = load_json(&self.clear_path)?;
            if legacy_pending {
                if let Some(id) = clears.legacy_request {
                    return Ok(id);
                }
            }
            let id = operation_id()
                .iter()
                .fold(String::with_capacity(32), |mut output, byte| {
                    use std::fmt::Write;
                    let _ = write!(output, "{byte:02x}");
                    output
                });
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
            if legacy_pending {
                clears.legacy_request = Some(id.clone());
            }
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
                self.transact(
                    &SyncSnapshot {
                        history_removed,
                        activity_removed,
                        ..SyncSnapshot::default()
                    },
                    true,
                )?;
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
