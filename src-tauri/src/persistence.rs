use crate::error::AppError;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub source: String,
    pub id: String,
    pub source_page_url: String,
    pub viewed_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct HistoryData {
    history: Vec<HistoryItem>,
    index: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub history: Vec<HistoryItem>,
    pub index: i64,
}

pub struct HistoryStore {
    path: PathBuf,
    data: Mutex<HistoryData>,
}

impl HistoryStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("history.json");
        let data = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(AppError::persistence)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let temporary = path.with_extension("json.tmp");
                match fs::read(&temporary) {
                    Ok(bytes) => {
                        let data = serde_json::from_slice(&bytes).map_err(AppError::persistence)?;
                        fs::rename(temporary, &path).map_err(AppError::persistence)?;
                        data
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        HistoryData::default()
                    }
                    Err(error) => return Err(AppError::persistence(error)),
                }
            }
            Err(error) => return Err(AppError::persistence(error)),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
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

    pub fn record(&self, item: HistoryItem) -> Result<HistorySnapshot, AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let index = next
            .history
            .iter()
            .position(|saved| saved.source == item.source && saved.id == item.id);
        next.index = Some(if let Some(index) = index {
            next.history[index].viewed_at = item.viewed_at;
            index
        } else {
            next.history.push(item);
            next.history.len() - 1
        });
        self.save(&next)?;
        *data = next;
        let result = snapshot(&data);
        drop(data);
        Ok(result)
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

    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = HistoryData::default();
        self.save(&next)?;
        *data = next;
        drop(data);
        Ok(())
    }

    fn save(&self, data: &HistoryData) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
        let temporary = self.path.with_extension("json.tmp");
        if let Err(error) = fs::write(&temporary, bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(AppError::persistence(error));
        }
        #[cfg(windows)]
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(AppError::persistence)?;
        }
        fs::rename(&temporary, &self.path).map_err(AppError::persistence)
    }
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

/// Classification recorded by `ExplorationStore`. `Unknown` marks legacy ids whose outcome can't be reconstructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExplorationClass {
    Unknown,
    Viewed,
    Rejected,
}

impl ExplorationClass {
    fn marker(self) -> Option<char> {
        match self {
            Self::Unknown => None,
            Self::Viewed => Some('v'),
            Self::Rejected => Some('r'),
        }
    }

    fn from_marker(marker: &str) -> Self {
        match marker {
            "v" => Self::Viewed,
            "r" => Self::Rejected,
            _ => Self::Unknown,
        }
    }
}

fn parse_exploration_line(line: &str) -> Result<(u64, ExplorationClass), std::num::ParseIntError> {
    match line.split_once(',') {
        Some((id, marker)) => Ok((id.parse()?, ExplorationClass::from_marker(marker))),
        None => Ok((line.parse()?, ExplorationClass::Unknown)),
    }
}

pub struct ExplorationStore {
    path: PathBuf,
    ids: Mutex<HashMap<u64, ExplorationClass>>,
}

impl ExplorationStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("prntsc-explored.txt");
        let ids = match fs::read_to_string(&path) {
            Ok(contents) => contents
                .lines()
                .map(parse_exploration_line)
                .collect::<Result<_, _>>()
                .map_err(AppError::persistence)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(AppError::persistence(error)),
        };
        Ok(Self {
            path,
            ids: Mutex::new(ids),
        })
    }

    /// Marks a unique Prnt.sc id as explored under `outcome`. No-op if already recorded.
    pub fn mark(&self, id: u64, outcome: ExplorationOutcome) -> Result<bool, AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ids.contains_key(&id) {
            return Ok(false);
        }
        let class = match outcome {
            ExplorationOutcome::Viewed => ExplorationClass::Viewed,
            ExplorationOutcome::Rejected => ExplorationClass::Rejected,
        };
        let marker = class.marker().unwrap_or('?');
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| writeln!(file, "{id},{marker}"));
        if let Err(error) = result {
            drop(ids);
            return Err(AppError::persistence(error));
        }
        ids.insert(id, class);
        drop(ids);
        Ok(true)
    }

    pub fn count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Unique Prnt.sc ids classified as viewed since tracking began. Excludes legacy ids.
    pub fn viewable_count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|class| **class == ExplorationClass::Viewed)
            .count()
    }

    /// Unique Prnt.sc ids classified as rejected since tracking began. Excludes legacy ids.
    pub fn unavailable_count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|class| **class == ExplorationClass::Rejected)
            .count()
    }

    pub fn contains(&self, id: u64) -> bool {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&id)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::persistence(error)),
        }
        ids.clear();
        drop(ids);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorationOutcome {
    Viewed,
    Rejected,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
struct DailyActivity {
    viewed: u64,
    rejected: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct ActivityData {
    migrated: bool,
    viewed_total: u64,
    days: BTreeMap<String, DailyActivity>,
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
        let data = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(AppError::persistence)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let temporary = path.with_extension("json.tmp");
                match fs::read(&temporary) {
                    Ok(bytes) => {
                        let data = serde_json::from_slice(&bytes).map_err(AppError::persistence)?;
                        fs::rename(temporary, &path).map_err(AppError::persistence)?;
                        data
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        ActivityData::default()
                    }
                    Err(error) => return Err(AppError::persistence(error)),
                }
            }
            Err(error) => return Err(AppError::persistence(error)),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    /// Records one checked candidate for the given local day (`YYYY-MM-DD`).
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

    /// Returns local days from the start of tracking through `today`, oldest first, capped at
    /// `max_days`. Tracking start is the earliest day with a recorded bucket (there is no reliable
    /// data before it, so it is never zero-filled as "0 activity"); with no recorded bucket at all,
    /// only `today` is returned.
    pub fn recent_days(
        &self,
        today: NaiveDate,
        max_days: u32,
    ) -> Vec<(String, DailyActivitySnapshot)> {
        let recorded_days = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .days
            .clone();
        let tracking_start = recorded_days
            .keys()
            .next()
            .and_then(|key| NaiveDate::parse_from_str(key, "%Y-%m-%d").ok());
        let earliest_allowed =
            today - chrono::Duration::days(i64::from(max_days.saturating_sub(1)));
        let start = tracking_start.map_or(today, |date| date.max(earliest_allowed));

        let mut days = Vec::new();
        let mut cursor = start;
        while cursor <= today {
            let key = cursor.to_string();
            let daily = recorded_days.get(&key).copied().unwrap_or_default();
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
        let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
        let temporary = self.path.with_extension("json.tmp");
        if let Err(error) = fs::write(&temporary, bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(AppError::persistence(error));
        }
        #[cfg(windows)]
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(AppError::persistence)?;
        }
        fs::rename(&temporary, &self.path).map_err(AppError::persistence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread, time::SystemTime};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        std::env::temp_dir().join(format!(
            "random-frame-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn history_survives_reload_and_clear_is_persistent() -> Result<(), AppError> {
        let directory = test_directory("history");
        let store = HistoryStore::new(&directory)?;
        store.record(HistoryItem {
            source: "prntsc".to_owned(),
            id: "abc123".to_owned(),
            source_page_url: "https://prnt.sc/abc123".to_owned(),
            viewed_at: 42,
        })?;

        let reloaded = HistoryStore::new(&directory)?;
        assert_eq!(reloaded.snapshot().history[0].id, "abc123");
        reloaded.record(HistoryItem {
            source: "prntsc".to_owned(),
            id: "abc123".to_owned(),
            source_page_url: "https://prnt.sc/abc123".to_owned(),
            viewed_at: 84,
        })?;
        assert_eq!(reloaded.snapshot().history.len(), 1);
        assert_eq!(reloaded.snapshot().history[0].viewed_at, 84);
        reloaded.clear()?;
        assert!(HistoryStore::new(&directory)?.snapshot().history.is_empty());
        fs::rename(
            directory.join("history.json"),
            directory.join("history.json.tmp"),
        )
        .map_err(AppError::persistence)?;
        assert!(HistoryStore::new(&directory)?.snapshot().history.is_empty());
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn explored_ids_are_unique_race_safe_and_persistent() -> Result<(), AppError> {
        let directory = test_directory("explored");
        let store = Arc::new(ExplorationStore::new(&directory)?);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let store = Arc::clone(&store);
                thread::spawn(move || store.mark(42, ExplorationOutcome::Viewed))
            })
            .collect();
        for worker in threads {
            assert!(worker.join().is_ok_and(|result| result.is_ok()));
        }
        assert_eq!(store.count(), 1);
        store.clear()?;
        assert_eq!(store.count(), 0);
        drop(store);
        assert_eq!(ExplorationStore::new(&directory)?.count(), 0);
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn repeated_views_of_the_same_id_never_move_the_independent_rejected_count(
    ) -> Result<(), AppError> {
        // Regression: unavailable was once derived as explored - viewedTotal, wrong under revisits.
        let directory = test_directory("explored-repeat-views");
        let store = ExplorationStore::new(&directory)?;

        store.mark(7, ExplorationOutcome::Rejected)?;
        assert_eq!(store.unavailable_count(), 1);

        // Same id shown many times (e.g. adjacent-id jump): only the first mark is recorded.
        for _ in 0..25 {
            store.mark(1, ExplorationOutcome::Viewed)?;
        }

        assert_eq!(store.count(), 2);
        assert_eq!(store.viewable_count(), 1);
        assert_eq!(
            store.unavailable_count(),
            1,
            "rejected count must not decay from repeat views"
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn explored_unique_equals_viewable_plus_unavailable_once_fully_classified(
    ) -> Result<(), AppError> {
        let directory = test_directory("explored-equation");
        let store = ExplorationStore::new(&directory)?;
        store.mark(1, ExplorationOutcome::Viewed)?;
        store.mark(2, ExplorationOutcome::Viewed)?;
        store.mark(3, ExplorationOutcome::Rejected)?;

        assert_eq!(
            store.count(),
            store.viewable_count() + store.unavailable_count()
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn a_second_mark_of_a_different_class_is_ignored_and_keeps_the_first_classification(
    ) -> Result<(), AppError> {
        let directory = test_directory("explored-reclassify");
        let store = ExplorationStore::new(&directory)?;
        assert!(store.mark(9, ExplorationOutcome::Viewed)?);
        assert!(!store.mark(9, ExplorationOutcome::Rejected)?);

        assert_eq!(store.viewable_count(), 1);
        assert_eq!(store.unavailable_count(), 0);
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn legacy_plain_id_lines_are_counted_as_explored_but_not_classified() -> Result<(), AppError> {
        // Legacy ids (bare numbers, no comma) still count toward explored but never viewable/rejected.
        let directory = test_directory("explored-legacy");
        fs::create_dir_all(&directory).map_err(AppError::persistence)?;
        fs::write(directory.join("prntsc-explored.txt"), "10\n11\n")
            .map_err(AppError::persistence)?;

        let store = ExplorationStore::new(&directory)?;
        assert_eq!(store.count(), 2);
        assert_eq!(store.viewable_count(), 0);
        assert_eq!(store.unavailable_count(), 0);

        store.mark(12, ExplorationOutcome::Viewed)?;
        assert_eq!(store.count(), 3);
        assert_eq!(store.viewable_count(), 1);
        assert_eq!(
            store.viewable_count() + store.unavailable_count(),
            1,
            "classified subset must stay smaller than the explored total while legacy ids remain"
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

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
        };

        assert!(store.record(item.clone()).is_err());
        assert!(store.snapshot().history.is_empty());

        *store
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = HistoryData {
            history: vec![item],
            index: None,
        };
        assert!(store.select(0).is_err());
        assert_eq!(store.snapshot().index, -1);
        assert!(store.clear().is_err());
        assert_eq!(store.snapshot().history.len(), 1);
        fs::remove_file(directory).map_err(AppError::persistence)
    }

    #[test]
    fn activity_records_viewed_and_rejected_into_the_right_day_and_persists() -> Result<(), AppError>
    {
        let directory = test_directory("activity");
        let store = ActivityStore::new(&directory)?;
        store.record(ExplorationOutcome::Viewed, "2026-09-19")?;
        store.record(ExplorationOutcome::Rejected, "2026-09-19")?;
        store.record(ExplorationOutcome::Rejected, "2026-09-19")?;
        store.record(ExplorationOutcome::Viewed, "2026-09-20")?;

        assert_eq!(store.viewed_total(), 2);
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        let days = store.recent_days(today, 3);
        assert_eq!(
            days,
            vec![
                (
                    "2026-09-19".to_owned(),
                    DailyActivitySnapshot {
                        viewed: 1,
                        rejected: 2
                    }
                ),
                (
                    "2026-09-20".to_owned(),
                    DailyActivitySnapshot {
                        viewed: 1,
                        rejected: 0
                    }
                ),
            ],
            "2026-09-18 predates the first recorded activity and must not be zero-filled"
        );

        let reloaded = ActivityStore::new(&directory)?;
        assert_eq!(reloaded.viewed_total(), 2);
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn activity_clear_resets_totals_and_days() -> Result<(), AppError> {
        let directory = test_directory("activity-clear");
        let store = ActivityStore::new(&directory)?;
        store.record(ExplorationOutcome::Viewed, "2026-09-20")?;
        store.clear()?;
        assert_eq!(store.viewed_total(), 0);
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        assert_eq!(
            store.recent_days(today, 1),
            vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn activity_migration_runs_once_and_only_folds_today_when_the_legacy_day_matches(
    ) -> Result<(), AppError> {
        let directory = test_directory("activity-migrate");
        let store = ActivityStore::new(&directory)?;

        store.migrate("2026-09-19", 5, 101, "2026-09-20")?;
        assert_eq!(store.viewed_total(), 101);
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        assert_eq!(
            store.recent_days(today, 1),
            vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())],
            "legacy day differs from today, so today's bucket stays untouched"
        );

        // A second migration attempt must not double-count the lifetime total.
        store.migrate("2026-09-20", 3, 101, "2026-09-20")?;
        assert_eq!(store.viewed_total(), 101);
        assert_eq!(
            store.recent_days(today, 1),
            vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn activity_migration_folds_todays_partial_count_when_the_legacy_day_matches(
    ) -> Result<(), AppError> {
        let directory = test_directory("activity-migrate-today");
        let store = ActivityStore::new(&directory)?;

        store.migrate("2026-09-20", 7, 42, "2026-09-20")?;
        assert_eq!(store.viewed_total(), 42);
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        assert_eq!(
            store.recent_days(today, 1),
            vec![(
                "2026-09-20".to_owned(),
                DailyActivitySnapshot {
                    viewed: 7,
                    rejected: 0
                }
            )]
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn recent_days_with_no_recorded_activity_returns_only_today() -> Result<(), AppError> {
        let directory = test_directory("activity-window-empty");
        let store = ActivityStore::new(&directory)?;
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        assert_eq!(
            store.recent_days(today, 183),
            vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn recent_days_stops_at_the_first_recorded_day_short_of_the_window_cap() -> Result<(), AppError>
    {
        let directory = test_directory("activity-window-partial");
        let store = ActivityStore::new(&directory)?;
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        // Tracking started 7 days ago: exactly 8 days (2026-09-13 .. 2026-09-20) should render.
        store.record(ExplorationOutcome::Viewed, "2026-09-13")?;

        let days = store.recent_days(today, 183);
        assert_eq!(days.len(), 8);
        assert_eq!(
            days.first().map(|(date, _)| date.as_str()),
            Some("2026-09-13")
        );
        assert_eq!(
            days.last().map(|(date, _)| date.as_str()),
            Some("2026-09-20")
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn recent_days_caps_long_running_history_to_a_rolling_window() -> Result<(), AppError> {
        let directory = test_directory("activity-window-rolling");
        let store = ActivityStore::new(&directory)?;
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        // Tracking started a year ago, far past the 183-day cap.
        store.record(ExplorationOutcome::Viewed, "2025-09-20")?;

        let days = store.recent_days(today, 183);
        assert_eq!(days.len(), 183);
        assert_eq!(
            days.first().map(|(date, _)| date.as_str()),
            Some("2026-03-22"),
            "window must start exactly 182 days before today, not at the true tracking start"
        );
        assert_eq!(
            days.last().map(|(date, _)| date.as_str()),
            Some("2026-09-20")
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }
}
