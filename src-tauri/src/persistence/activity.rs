#[cfg(test)]
use super::exploration::ExplorationOutcome;
use super::{
    io::{load_json, save_json},
    sync_ops::operation_id,
};
#[cfg(test)]
use crate::snapshot::Outcome;
use crate::{
    error::AppError,
    snapshot::{
        activity_projection, merge_snapshots, ActivityOperation, DailyCounts, SyncSnapshot,
    },
};
use chrono::{DateTime, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
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
#[derive(Default, Deserialize)]
#[serde(default)]
struct LegacyActivity {
    migrated: bool,
    revisit_views_repaired: bool,
    viewed_total: u64,
    // ponytail: day keys are validated during LegacyImport creation in ActivityStore::new(),
    // not during deserialization. Invalid keys are filtered out before creating the operation.
    days: BTreeMap<String, DailyCounts>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActivityData {
    version: u8,
    migrated: bool,
    revisit_views_repaired: bool,
    operations: Vec<ActivityOperation>,
    removed: Vec<[u8; 16]>,
}
impl Default for ActivityData {
    fn default() -> Self {
        Self {
            version: 2,
            migrated: false,
            revisit_views_repaired: false,
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
        let source = super::migration::source_path(directory, "activity-v2.json", "activity.json")?;
        let data = if source == path {
            load_json::<ActivityData>(&path)?
        } else {
            let legacy: LegacyActivity = load_json(&source)?;
            // Filter out invalid day keys during migration; validate_snapshot catches any remaining issues.
            let valid_days: BTreeMap<String, DailyCounts> = legacy
                .days
                .into_iter()
                .filter(|(day, _)| crate::snapshot::validate_day(day).is_ok())
                .collect();
            let operations = if legacy.viewed_total == 0 && valid_days.is_empty() {
                Vec::new()
            } else {
                vec![ActivityOperation::LegacyImport {
                    operation_id: operation_id(),
                    viewed_total: legacy.viewed_total,
                    days: valid_days,
                }]
            };
            ActivityData {
                migrated: legacy.migrated,
                revisit_views_repaired: legacy.revisit_views_repaired,
                operations,
                ..ActivityData::default()
            }
        };
        if data.version != 2 {
            return Err(AppError::persistence("Unsupported Activity schema"));
        }
        crate::snapshot::validate_snapshot(&SyncSnapshot {
            activity: data.operations.clone(),
            activity_removed: data.removed.clone(),
            ..SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        // ID and all receipts share this one atomic save; a restarted import uses it unchanged.
        save_json(&path, &data)?;
        super::migration::receipt(directory, "activity-v2")?;
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
        close_legacy_import: bool,
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
        next.migrated |= close_legacy_import;
        let result = self.save_changed(&mut data, next);
        drop(data);
        result
    }
    /// Restore: Activity becomes exactly `incoming` and the legacy browser import is closed,
    /// so a later `migrate` cannot add pre-join counters.
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
            migrated: true,
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
        self.merge_sync_state(vec![op], Vec::new(), false)
    }
    pub fn viewed_total(&self) -> u64 {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        activity_projection(&data.operations).map_or(0, |x| x.0)
    }
    pub fn migrate(
        &self,
        legacy_day: &str,
        legacy_today: u64,
        legacy_total: u64,
        today: &str,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if data.migrated {
            return Ok(());
        }
        let mut next = data.clone();
        next.migrated = true;
        if legacy_total > 0 {
            let days = if legacy_day == today && legacy_today > 0 {
                BTreeMap::from([(
                    today.into(),
                    DailyCounts {
                        viewed: legacy_today,
                        rejected: 0,
                    },
                )])
            } else {
                BTreeMap::new()
            };
            next.operations.push(ActivityOperation::LegacyImport {
                operation_id: operation_id(),
                viewed_total: legacy_total,
                days,
            });
            next.operations.sort_by_key(ActivityOperation::operation_id);
            activity_projection(&next.operations).map_err(AppError::persistence)?;
        }
        let result = self.save_changed(&mut data, next);
        drop(data);
        result
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
        self.merge_sync_state(Vec::new(), removed, true)
    }
}
