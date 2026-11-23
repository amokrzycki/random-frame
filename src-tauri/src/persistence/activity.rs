#[cfg(test)]
use super::exploration::ExplorationOutcome;
use super::io::{load_json, save_json};
#[cfg(test)]
use super::sync_ops::operation_id;
#[cfg(test)]
use crate::snapshot::Outcome;
use crate::{
    error::AppError,
    snapshot::{activity_projection, merge_snapshots, ActivityOperation, SyncSnapshot},
};
use chrono::{DateTime, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
const DAY_KEY_FORMAT: &str = "%Y-%m-%d";
pub fn activity_day<Tz: TimeZone>(instant: &DateTime<Tz>) -> NaiveDate {
    instant.date_naive()
}
pub fn day_key(day: NaiveDate) -> String {
    day.format(DAY_KEY_FORMAT).to_string()
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DailyActivitySnapshot {
    pub viewed: u64,
    pub rejected: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActivityData {
    version: u8,
    operations: Vec<ActivityOperation>,
    removed: Vec<[u8; 16]>,
}
impl Default for ActivityData {
    fn default() -> Self {
        Self {
            version: 2,
            operations: Vec::new(),
            removed: Vec::new(),
        }
    }
}
pub struct ActivityStore {
    path: PathBuf,
    data: Mutex<ActivityData>,
    generation: AtomicU64,
}
impl ActivityStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("activity-v2.json");
        let data: ActivityData = load_json(&path)?;
        if data.version != 2 {
            return Err(AppError::persistence("Unsupported Activity schema"));
        }
        crate::snapshot::validate_snapshot(&SyncSnapshot {
            activity: data.operations.clone(),
            activity_removed: data.removed.clone(),
            ..SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        save_json(&path, &data)?;
        Ok(Self {
            path,
            data: Mutex::new(data),
            generation: AtomicU64::new(0),
        })
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub fn sync_state(&self) -> (Vec<ActivityOperation>, Vec<[u8; 16]>) {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (data.operations.clone(), data.removed.clone())
    }
    pub fn merge_sync_state(
        &self,
        operations: Vec<ActivityOperation>,
        removed: Vec<[u8; 16]>,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let merged = merge_snapshots(
            &SyncSnapshot {
                activity: data.operations.clone(),
                activity_removed: data.removed.clone(),
                ..SyncSnapshot::default()
            },
            &SyncSnapshot {
                activity: operations,
                activity_removed: removed,
                ..SyncSnapshot::default()
            },
        )
        .map_err(AppError::persistence)?;
        let mut next = data.clone();
        next.operations = merged.activity;
        next.removed = merged.activity_removed;
        let result = self.save_changed(&mut data, next);
        drop(data);
        result
    }
    /// Restore: Activity becomes exactly `incoming`.
    pub fn replace_sync_state(
        &self,
        operations: Vec<ActivityOperation>,
        removed: Vec<[u8; 16]>,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = ActivityData {
            operations,
            removed,
            ..data.clone()
        };
        let result = self.save_changed(&mut data, next);
        drop(data);
        result
    }
    fn save_changed(&self, data: &mut ActivityData, next: ActivityData) -> Result<(), AppError> {
        if *data != next {
            save_json(&self.path, &next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
    // Used by store-level tests. Production discoveries are journaled with their frame key.
    #[cfg(test)]
    pub fn record(&self, outcome: ExplorationOutcome, day: &str) -> Result<(), AppError> {
        let op = ActivityOperation::Discovery {
            operation_id: operation_id(),
            source: "prntsc".into(),
            id: "0".into(),
            outcome: match outcome {
                ExplorationOutcome::Viewed => Outcome::Viewed,
                ExplorationOutcome::Rejected => Outcome::Rejected,
            },
            occurred_at_ms: 0,
            day: day.into(),
        };
        self.merge_sync_state(vec![op], Vec::new())
    }
    pub fn draw_frame_views(&self) -> Vec<super::history::FrameView> {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        data.operations
            .iter()
            .filter_map(|op| match op {
                ActivityOperation::Discovery {
                    source,
                    id,
                    outcome: crate::snapshot::Outcome::Viewed,
                    occurred_at_ms,
                    day,
                    ..
                } => Some(super::history::FrameView {
                    source: source.clone(),
                    id: id.clone(),
                    at_ms: *occurred_at_ms,
                    day: day.clone(),
                    day_inferred: false,
                }),
                ActivityOperation::Discovery { .. } => None,
            })
            .collect()
    }
    pub fn viewed_total(&self) -> u64 {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        activity_projection(&data.operations).map_or(0, |x| x.0)
    }
    pub fn recent_days(
        &self,
        today: NaiveDate,
        max_days: u32,
    ) -> Vec<(String, DailyActivitySnapshot)> {
        if max_days == 0 {
            return Vec::new();
        }
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (_, projection) = activity_projection(&data.operations).unwrap_or_default();
        let tracking_start = projection
            .keys()
            .find_map(|key| NaiveDate::parse_from_str(key, DAY_KEY_FORMAT).ok());
        let earliest_allowed = today - chrono::Duration::days(i64::from(max_days - 1));
        let start = tracking_start
            .map_or(today, |date| date.max(earliest_allowed))
            .min(today);

        let mut days = Vec::new();
        let mut cursor = start;
        while cursor <= today {
            let key = day_key(cursor);
            let daily = projection.get(&key).copied().unwrap_or_default();
            days.push((
                key,
                DailyActivitySnapshot {
                    viewed: daily.viewed,
                    rejected: daily.rejected,
                },
            ));
            match cursor.succ_opt() {
                Some(next) => cursor = next,
                None => break,
            }
        }
        drop(data);
        days
    }

    #[cfg(test)]
    pub fn clear(&self) -> Result<(), AppError> {
        let (ops, removed) = self.sync_state();
        let mut removed = removed;
        removed.extend(ops.iter().map(ActivityOperation::operation_id));
        removed.sort_unstable();
        removed.dedup();
        self.merge_sync_state(Vec::new(), removed)
    }
}
