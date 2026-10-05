use super::{
    activity::{activity_day, day_key},
    io::{load_json, save_json},
    sync_ops::{deduplicate_tombstones, operation_id, validate_item},
};
use crate::{error::AppError, snapshot::ViewStamp};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::BTreeMap;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub source: String,
    pub id: String,
    pub source_page_url: String,
    pub viewed_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default)]
struct HistoryData {
    #[serde(default = "schema_v2")]
    version: u8,
    history: Vec<HistoryItem>,
    index: Option<usize>,
    #[serde(default)]
    history_ops: Vec<HistoryOp>,
    #[serde(default)]
    removed_history_ops: Vec<[u8; 16]>,
    #[serde(default)]
    local_views: HashMap<String, u64>,
}

fn schema_v2() -> u8 {
    2
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct HistoryOp {
    operation_id: [u8; 16],
    order_at: u64,
    viewed_at: u64,
    #[serde(default)]
    day: String,
    #[serde(default)]
    day_inferred: bool,
    source: String,
    id: String,
    source_page_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub history: Vec<HistoryItem>,
    pub index: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedFrame {
    pub snapshot: HistorySnapshot,
    pub order_at: u64,
    pub last_view: ViewStamp,
}

pub type HistorySyncState = (Vec<crate::snapshot::SyncRecord>, Vec<[u8; 16]>);

impl HistoryData {
    fn selected_key(&self) -> Option<String> {
        self.index
            .and_then(|index| self.history.get(index))
            .map(history_key)
    }

    /// Drops removed operations, keeps both sync sections within one snapshot, and re-projects.
    fn normalize(&mut self, selected: Option<String>) {
        let removed: HashSet<_> = self.removed_history_ops.iter().copied().collect();
        self.history_ops
            .retain(|op| !removed.contains(&op.operation_id));
        self.history_ops
            .sort_by_key(|op| (op.order_at, op.operation_id));
        deduplicate_tombstones(&mut self.removed_history_ops);
        self.history = project_history(&self.history_ops);
        let keys: HashSet<_> = self.history.iter().map(history_key).collect();
        self.local_views.retain(|key, _| keys.contains(key));
        self.index = selected.and_then(|key| {
            self.history
                .iter()
                .position(|item| history_key(item) == key)
        });
    }
}

pub struct HistoryStore {
    path: PathBuf,
    data: Mutex<HistoryData>,
    generation: AtomicU64,
}

impl HistoryStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("history-v3.json");
        let source = super::migration::source_path(directory, "history-v3.json", "history.json")?;
        let mut data: HistoryData = load_json(&source)?;
        if source == path && data.version != 3 {
            return Err(AppError::persistence("Unsupported history schema"));
        }
        if source != path
            && (data.version != 2 || (data.history_ops.is_empty() && !data.history.is_empty()))
        {
            data.version = 2;
            data.history_ops = data
                .history
                .iter()
                .enumerate()
                .map(|(index, item)| HistoryOp {
                    operation_id: operation_id(),
                    order_at: index as u64,
                    viewed_at: item.viewed_at,
                    day: local_stamp(item.viewed_at, true).day,
                    day_inferred: true,
                    source: item.source.clone(),
                    id: item.id.clone(),
                    source_page_url: item.source_page_url.clone(),
                })
                .collect();
            data.local_views = data
                .history
                .iter()
                .map(|item| (history_key(item), item.viewed_at))
                .collect();
        }
        for op in &mut data.history_ops {
            if op.day.is_empty() {
                let key = format!("{}\0{}", op.source, op.id);
                op.viewed_at = op
                    .viewed_at
                    .max(data.local_views.get(&key).copied().unwrap_or(0));
                op.day = local_stamp(op.viewed_at, true).day;
                op.day_inferred = true;
            }
        }
        data.version = 3;
        let selected = data.selected_key();
        data.normalize(selected);
        save_json(&path, &data)?;
        super::migration::receipt(directory, "history-v3")?;
        Ok(Self {
            path,
            data: Mutex::new(data),
            generation: AtomicU64::new(0),
        })
    }

    pub fn snapshot(&self) -> HistorySnapshot {
        snapshot(
            &self
                .data
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    pub fn sync_state_with_generation(&self) -> (HistorySyncState, u64) {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = (
            data.history_ops
                .iter()
                .map(|op| crate::snapshot::SyncRecord {
                    operation_id: op.operation_id,
                    order_at: op.order_at,
                    last_view: ViewStamp {
                        at_ms: op.viewed_at,
                        day: op.day.clone(),
                        day_inferred: op.day_inferred,
                    },
                    source: op.source.clone(),
                    id: op.id.clone(),
                    source_page_url: op.source_page_url.clone(),
                })
                .collect(),
            data.removed_history_ops.clone(),
        );
        let generation = self.generation.load(Ordering::Relaxed);
        drop(data);
        (state, generation)
    }

    #[cfg(test)]
    pub fn sync_state(&self) -> HistorySyncState {
        self.sync_state_with_generation().0
    }

    #[cfg(test)]
    pub fn record(&self, item: HistoryItem) -> Result<HistorySnapshot, AppError> {
        validate_item(&item.source, &item.id, &item.source_page_url)?;
        let key = history_key(&item);
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        next.version = 3;
        if let Some(op) = next
            .history_ops
            .iter_mut()
            .find(|op| op.source == item.source && op.id == item.id)
        {
            let stamp = local_stamp(item.viewed_at, false);
            if stamp.key()
                > (ViewStamp {
                    at_ms: op.viewed_at,
                    day: op.day.clone(),
                    day_inferred: op.day_inferred,
                })
                .key()
            {
                op.viewed_at = stamp.at_ms;
                op.day = stamp.day;
                op.day_inferred = false;
            }
        } else {
            // First-view time, kept above every known entry so a new frame always lands last.
            let order_at = next
                .history_ops
                .iter()
                .map(|op| op.order_at.saturating_add(1))
                .max()
                .unwrap_or(0)
                .max(item.viewed_at);
            next.history_ops.push(HistoryOp {
                operation_id: operation_id(),
                order_at,
                viewed_at: item.viewed_at,
                day: local_stamp(item.viewed_at, false).day,
                day_inferred: false,
                source: item.source,
                id: item.id,
                source_page_url: item.source_page_url,
            });
        }
        next.local_views.insert(key.clone(), item.viewed_at);
        next.normalize(Some(key));
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        let result = snapshot(&data);
        drop(data);
        Ok(result)
    }

    /// Prnt.sc frames first shown per local day (`YYYY-MM-DD`); revisits never touch `viewed_at`.
    #[cfg(test)]
    pub fn prntsc_views_per_day(&self) -> BTreeMap<String, u64> {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut days = BTreeMap::new();
        for item in data.history.iter().filter(|item| item.source == "prntsc") {
            let Some(viewed_at) = i64::try_from(item.viewed_at)
                .ok()
                .and_then(|millis| Local.timestamp_millis_opt(millis).single())
            else {
                continue;
            };
            *days.entry(day_key(activity_day(&viewed_at))).or_insert(0) += 1;
        }
        drop(data);
        days
    }

    #[cfg(test)]
    pub fn local_view_times(&self) -> Vec<Option<u64>> {
        self.frame_views()
            .iter()
            .map(|view| Some(view.at_ms))
            .collect()
    }

    pub fn frame_views(&self) -> Vec<FrameView> {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut latest = HashMap::new();
        for op in &data.history_ops {
            let winner = latest
                .entry((op.source.as_str(), op.id.as_str()))
                .or_insert(op);
            if (op.viewed_at, !op.day_inferred, &op.day)
                > (winner.viewed_at, !winner.day_inferred, &winner.day)
            {
                *winner = op;
            }
        }
        data.history
            .iter()
            .filter_map(|item| {
                latest
                    .get(&(item.source.as_str(), item.id.as_str()))
                    .map(|op| FrameView {
                        source: op.source.clone(),
                        id: op.id.clone(),
                        at_ms: op.viewed_at,
                        day: op.day.clone(),
                        day_inferred: op.day_inferred,
                    })
            })
            .collect()
    }

    pub fn select(&self, index: usize) -> Result<HistorySnapshot, AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if index >= data.history.len() {
            return Err(AppError::invalid_input("Invalid history position"));
        }
        let mut next = data.clone();
        next.index = Some(index);
        self.save(&next)?;
        *data = next;
        let result = snapshot(&data);
        drop(data);
        Ok(result)
    }

    /// Removes one frame. Every op for it is tombstoned, since a synced device may hold its own,
    /// and the earliest `order_at` is returned so `restore` can put it back in place.
    pub fn remove(&self, source: &str, id: &str) -> Result<RemovedFrame, AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let matching: Vec<_> = next
            .history_ops
            .iter()
            .filter(|op| op.source == source && op.id == id)
            .map(|op| (op.operation_id, op.order_at))
            .collect();
        let order_at = matching
            .iter()
            .map(|&(_, order_at)| order_at)
            .min()
            .ok_or_else(|| AppError::invalid_input("Frame is not in history"))?;
        let last_view = next
            .history_ops
            .iter()
            .filter(|op| op.source == source && op.id == id)
            .map(|op| ViewStamp {
                at_ms: op.viewed_at,
                day: op.day.clone(),
                day_inferred: op.day_inferred,
            })
            .max_by(|a, b| a.key().cmp(&b.key()))
            .ok_or_else(|| AppError::invalid_input("Frame is not in history"))?;
        next.removed_history_ops
            .extend(matching.iter().map(|&(operation_id, _)| operation_id));
        let selected = next.selected_key();
        next.normalize(selected);
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        let snapshot = snapshot(&data);
        drop(data);
        Ok(RemovedFrame {
            snapshot,
            order_at,
            last_view,
        })
    }

    /// Undo for `remove`: a fresh op at the old `order_at`, so the frame returns to its place
    /// while the tombstones already synced elsewhere stay valid.
    pub fn restore(
        &self,
        item: HistoryItem,
        order_at: u64,
        last_view: ViewStamp,
    ) -> Result<HistorySnapshot, AppError> {
        validate_item(&item.source, &item.id, &item.source_page_url)?;
        if crate::snapshot::validate_day(&last_view.day).is_err() {
            return Err(AppError::invalid_input("Invalid view day"));
        }
        let key = history_key(&item);
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        if !next
            .history_ops
            .iter()
            .any(|op| op.source == item.source && op.id == item.id)
        {
            next.local_views.insert(key, last_view.at_ms);
            next.history_ops.push(HistoryOp {
                operation_id: operation_id(),
                order_at,
                viewed_at: last_view.at_ms,
                day: last_view.day,
                day_inferred: last_view.day_inferred,
                source: item.source,
                id: item.id,
                source_page_url: item.source_page_url,
            });
        }
        let selected = next.selected_key();
        next.normalize(selected);
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        let result = snapshot(&data);
        drop(data);
        Ok(result)
    }

    #[cfg(test)]
    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        next.removed_history_ops
            .extend(next.history_ops.iter().map(|op| op.operation_id));
        next.version = 3;
        next.normalize(None);
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        drop(data);
        Ok(())
    }

    fn save(&self, data: &HistoryData) -> Result<(), AppError> {
        save_json(&self.path, data)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Restore: history becomes exactly `incoming`; local operations, tombstones and legacy views are dropped.
    pub fn replace_sync_state(&self, incoming: HistorySyncState) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        next.history_ops = incoming
            .0
            .into_iter()
            .map(|op| HistoryOp {
                operation_id: op.operation_id,
                order_at: op.order_at,
                viewed_at: op.last_view.at_ms,
                day: op.last_view.day,
                day_inferred: op.last_view.day_inferred,
                source: op.source,
                id: op.id,
                source_page_url: op.source_page_url,
            })
            .collect();
        next.removed_history_ops = incoming.1;
        next.local_views.clear();
        let selected = next.selected_key();
        next.normalize(selected);
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        drop(data);
        Ok(())
    }

    pub fn merge_sync_state(&self, incoming: HistorySyncState) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let mut positions: HashMap<_, _> = next
            .history_ops
            .iter()
            .enumerate()
            .map(|(index, op)| (op.operation_id, index))
            .collect();
        for op in incoming.0 {
            if let Some(&index) = positions.get(&op.operation_id) {
                let existing = &mut next.history_ops[index];
                if existing.source != op.source
                    || existing.id != op.id
                    || existing.source_page_url != op.source_page_url
                    || existing.order_at != op.order_at
                {
                    return Err(AppError::persistence("Conflicting history operation"));
                }
                let stamp = ViewStamp {
                    at_ms: existing.viewed_at,
                    day: existing.day.clone(),
                    day_inferred: existing.day_inferred,
                };
                if op.last_view.key() > stamp.key() {
                    existing.viewed_at = op.last_view.at_ms;
                    existing.day = op.last_view.day;
                    existing.day_inferred = op.last_view.day_inferred;
                }
            } else {
                positions.insert(op.operation_id, next.history_ops.len());
                next.history_ops.push(HistoryOp {
                    operation_id: op.operation_id,
                    order_at: op.order_at,
                    viewed_at: op.last_view.at_ms,
                    day: op.last_view.day,
                    day_inferred: op.last_view.day_inferred,
                    source: op.source,
                    id: op.id,
                    source_page_url: op.source_page_url,
                });
            }
        }
        next.removed_history_ops.extend(incoming.1);
        let selected = next.selected_key();
        next.normalize(selected);
        if *data != next {
            self.save(&next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        drop(data);
        Ok(())
    }
}

fn history_key(item: &HistoryItem) -> String {
    format!("{}\0{}", item.source, item.id)
}

fn project_history(ops: &[HistoryOp]) -> Vec<HistoryItem> {
    let mut positions: HashMap<(&str, &str), usize> = HashMap::new();
    let mut result: Vec<HistoryItem> = Vec::new();
    for op in ops {
        if let Some(&index) = positions.get(&(op.source.as_str(), op.id.as_str())) {
            let item = &mut result[index];
            item.viewed_at = item.viewed_at.max(op.viewed_at);
        } else {
            positions.insert((op.source.as_str(), op.id.as_str()), result.len());
            result.push(HistoryItem {
                source: op.source.clone(),
                id: op.id.clone(),
                source_page_url: op.source_page_url.clone(),
                viewed_at: op.viewed_at,
            });
        }
    }
    result
}

fn snapshot(data: &HistoryData) -> HistorySnapshot {
    HistorySnapshot {
        history: data.history.clone(),
        index: data
            .index
            .and_then(|index| i64::try_from(index).ok())
            .unwrap_or(-1),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::test_directory;
    use super::*;

    #[test]
    fn failed_history_saves_do_not_change_memory() -> Result<(), AppError> {
        let directory = test_directory("failed-history");
        fs::write(&directory, []).map_err(AppError::persistence)?;
        let item = HistoryItem {
            source: "prntsc".to_owned(),
            id: "abc123".to_owned(),
            source_page_url: "https://prnt.sc/abc123".to_owned(),
            viewed_at: 42,
        };
        let store = HistoryStore {
            path: directory.join("history.json"),
            data: Mutex::new(HistoryData::default()),
            generation: AtomicU64::new(0),
        };

        assert!(store.record(item.clone()).is_err());
        assert_eq!(store.snapshot().history, vec![]);

        *store
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = HistoryData {
            history: vec![item],
            index: None,
            ..HistoryData::default()
        };
        assert!(store.select(0).is_err());
        assert_eq!(store.snapshot().index, -1);
        assert!(store.clear().is_err());
        assert_eq!(store.snapshot().history.len(), 1);
        fs::remove_file(directory).map_err(AppError::persistence)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameView {
    pub source: String,
    pub id: String,
    pub at_ms: u64,
    pub day: String,
    pub day_inferred: bool,
}
pub(super) fn local_stamp(at_ms: u64, day_inferred: bool) -> ViewStamp {
    let mut stamp = ViewStamp::inferred(at_ms);
    if let Some(time) = i64::try_from(at_ms)
        .ok()
        .and_then(|ms| Local.timestamp_millis_opt(ms).single())
    {
        stamp.day = day_key(activity_day(&time));
    }
    stamp.day_inferred = day_inferred;
    stamp
}
