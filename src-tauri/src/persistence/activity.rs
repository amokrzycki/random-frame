use super::{
    exploration::ExplorationOutcome,
    io::{load_json, save_json},
};
use crate::error::AppError;
use chrono::{DateTime, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
struct DailyActivity {
    viewed: u64,
    rejected: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct ActivityData {
    migrated: bool,
    revisit_views_repaired: bool,
    viewed_total: u64,
    days: BTreeMap<String, DailyActivity>,
}

const DAY_KEY_FORMAT: &str = "%Y-%m-%d";

/// Activity's single definition of a day: the calendar date on `instant`'s own wall clock, never
/// its UTC date. Production callers pass `Local` times, so days follow the user's local calendar.
pub fn activity_day<Tz: TimeZone>(instant: &DateTime<Tz>) -> NaiveDate {
    instant.date_naive()
}

/// `YYYY-MM-DD` bucket key for an activity day; `recent_days` parses keys back with the same format.
pub fn day_key(day: NaiveDate) -> String {
    day.format(DAY_KEY_FORMAT).to_string()
}

/// A single day's recorded activity, keyed by the user's local date (`YYYY-MM-DD`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DailyActivitySnapshot {
    pub viewed: u64,
    pub rejected: u64,
}

pub struct ActivityStore {
    path: PathBuf,
    data: Mutex<ActivityData>,
}

impl ActivityStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("activity.json");
        let data = load_json(&path)?;
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    /// Records one newly classified unique id for the local day (`YYYY-MM-DD`).
    pub fn record(&self, outcome: ExplorationOutcome, day: &str) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let entry = next.days.entry(day.to_owned()).or_default();
        match outcome {
            ExplorationOutcome::Viewed => {
                entry.viewed += 1;
                next.viewed_total += 1;
            }
            ExplorationOutcome::Rejected => entry.rejected += 1,
        }
        self.save(&next)?;
        *data = next;
        drop(data);
        Ok(())
    }

    pub fn viewed_total(&self) -> u64 {
        self.data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .viewed_total
    }

    /// One-shot fold-in of lifetime totals from the legacy client-side counter; no-op once `migrated`.
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
        next.viewed_total = next.viewed_total.saturating_add(legacy_total);
        if legacy_day == today && legacy_today > 0 {
            let entry = next.days.entry(today.to_owned()).or_default();
            entry.viewed = entry.viewed.saturating_add(legacy_today);
        }
        self.save(&next)?;
        *data = next;
        drop(data);
        Ok(())
    }

    /// One-shot clamp of each day's `viewed` (and `viewed_total`) to first views; never raises a count.
    pub fn repair_revisit_views(
        &self,
        first_views: &BTreeMap<String, u64>,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if data.revisit_views_repaired {
            return Ok(());
        }
        let mut next = data.clone();
        next.revisit_views_repaired = true;
        for (day, entry) in &mut next.days {
            let excess = entry
                .viewed
                .saturating_sub(first_views.get(day).copied().unwrap_or(0));
            entry.viewed -= excess;
            next.viewed_total = next.viewed_total.saturating_sub(excess);
        }
        self.save(&next)?;
        *data = next;
        drop(data);
        Ok(())
    }

    /// Returns local days from the start of tracking through `today`, oldest first, capped at
    /// `max_days`. Tracking start is the earliest day with a recorded bucket (there is no reliable
    /// data before it, so it is never zero-filled as "0 activity"); with no recorded bucket at all,
    /// only `today` is returned.
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
        let tracking_start = data
            .days
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
            let daily = data.days.get(&key).copied().unwrap_or_default();
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

    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = ActivityData::default();
        self.save(&next)?;
        *data = next;
        drop(data);
        Ok(())
    }

    fn save(&self, data: &ActivityData) -> Result<(), AppError> {
        save_json(&self.path, data)
    }
}
