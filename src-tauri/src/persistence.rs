use crate::error::AppError;
use crate::snapshot::{self, SnapshotError};
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Reads a JSON store, recovering a `.json.tmp` left by a save interrupted before its rename.
fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, AppError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(AppError::persistence),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary = path.with_extension("json.tmp");
            match fs::read(&temporary) {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(data) => {
                        fs::rename(temporary, path).map_err(AppError::persistence)?;
                        Ok(data)
                    }
                    Err(error) => {
                        #[cfg(windows)]
                        if path.with_extension("json.bak").exists() {
                            return restore_json_backup(path);
                        }
                        Err(AppError::persistence(error))
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    #[cfg(windows)]
                    if path.with_extension("json.bak").exists() {
                        return restore_json_backup(path);
                    }
                    Ok(T::default())
                }
                Err(error) => Err(AppError::persistence(error)),
            }
        }
        Err(error) => Err(AppError::persistence(error)),
    }
}

#[cfg(windows)]
fn restore_json_backup<T: DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let backup = path.with_extension("json.bak");
    let data = serde_json::from_slice(&fs::read(&backup).map_err(AppError::persistence)?)
        .map_err(AppError::persistence)?;
    fs::rename(backup, path).map_err(AppError::persistence)?;
    Ok(data)
}

/// Writes a `.json.tmp` sibling and renames it over the store, so a crash never leaves a torn file.
pub(crate) fn save_json<T: Serialize>(path: &Path, data: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
    let temporary = path.with_extension("json.tmp");
    if let Err(error) = fs::write(&temporary, bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::persistence(error));
    }
    #[cfg(windows)]
    if path.exists() {
        let backup = path.with_extension("json.bak");
        if backup.exists() {
            fs::remove_file(&backup).map_err(AppError::persistence)?;
        }
        fs::rename(path, &backup).map_err(AppError::persistence)?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(backup, path);
            return Err(AppError::persistence(error));
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    fs::rename(&temporary, path).map_err(AppError::persistence)
}

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
        let data = load_json(&path)?;
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

    /// Prnt.sc frames first shown per local day (`YYYY-MM-DD`); revisits never touch `viewed_at`.
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
        save_json(&self.path, data)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteItem {
    pub source: String,
    pub id: String,
    pub source_page_url: String,
    pub added_at: u64,
}

/// Frames the visitor starred, kept apart from history so clearing history never drops them.
pub struct FavoriteStore {
    path: PathBuf,
    data: Mutex<Vec<FavoriteItem>>,
}

impl FavoriteStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("favorites.json");
        let data = load_json(&path)?;
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    pub fn snapshot(&self) -> Vec<FavoriteItem> {
        self.data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Adds the frame, or removes it when its `(source, id)` is already a favorite.
    pub fn toggle(&self, item: FavoriteItem) -> Result<Vec<FavoriteItem>, AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        if let Some(index) = next
            .iter()
            .position(|saved| saved.source == item.source && saved.id == item.id)
        {
            next.remove(index);
        } else {
            next.push(item);
        }
        save_json(&self.path, &next)?;
        *data = next;
        let result = data.clone();
        drop(data);
        Ok(result)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        save_json(&self.path, &Vec::<FavoriteItem>::new())?;
        data.clear();
        drop(data);
        Ok(())
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

    pub fn viewed_ids(&self) -> Result<Vec<u64>, AppError> {
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = match fs::read_to_string(&self.path) {
            Ok(contents) => contents
                .lines()
                .map(parse_exploration_line)
                .filter_map(|entry| match entry {
                    Ok((id, ExplorationClass::Viewed)) => Some(Ok(id)),
                    Ok(_) => None,
                    Err(error) => Some(Err(AppError::persistence(error))),
                })
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(AppError::persistence(error)),
        };
        drop(ids);
        result
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

/// Monotonic local record of legacy Prnt.sc frames accepted for display.
pub struct SeenStore {
    path: PathBuf,
    ids: Mutex<HashSet<u64>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SeenStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("prntsc-seen.json");
        let ids: Vec<u64> = load_json(&path)?;
        if ids
            .iter()
            .any(|id| *id > crate::sources::prntsc::LEGACY_MAX_VALUE)
        {
            return Err(AppError::persistence("Invalid legacy Prnt.sc seen ID"));
        }
        Ok(Self {
            path,
            ids: Mutex::new(ids.into_iter().collect()),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
    }

    pub fn contains(&self, id: u64) -> bool {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&id)
    }

    pub fn insert(&self, id: u64) -> Result<bool, AppError> {
        Ok(self.merge([id])? != 0)
    }

    #[allow(
        dead_code,
        reason = "snapshot export is consumed by a later sync stage"
    )]
    pub fn serialize_snapshot(&self) -> Result<Vec<u8>, SnapshotError> {
        // ponytail: sorting under this lock pauses draws; shorten the lock if large stores cause UI stalls.
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot::serialize_snapshot(&ids)
    }

    pub fn snapshot_with_generation(&self) -> Result<(Vec<u8>, u64), SnapshotError> {
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let bytes = snapshot::serialize_snapshot(&ids)?;
        let generation = self.generation.load(std::sync::atomic::Ordering::Relaxed);
        drop(ids);
        Ok((bytes, generation))
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[allow(
        dead_code,
        reason = "snapshot import is consumed by a later sync stage"
    )]
    pub fn merge_snapshot(&self, bytes: &[u8]) -> Result<usize, AppError> {
        let incoming = snapshot::parse_snapshot(bytes)
            .map_err(|error| AppError::invalid_input(error.to_string()))?;
        self.merge(incoming)
    }

    pub fn merge(&self, incoming: impl IntoIterator<Item = u64>) -> Result<usize, AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = ids.clone();
        for id in incoming {
            if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
                return Err(AppError::invalid_input("Invalid legacy Prnt.sc seen ID"));
            }
            next.insert(id);
        }
        let added = next.len() - ids.len();
        if added == 0 {
            return Ok(0);
        }
        // ponytail: full snapshot rewrites on insert; consider an append log if real usage makes this slow.
        let mut sorted: Vec<_> = next.iter().copied().collect();
        sorted.sort_unstable();
        save_json(&self.path, &sorted)?;
        *ids = next;
        self.generation
            .fetch_add(added as u64, std::sync::atomic::Ordering::Relaxed);
        drop(ids);
        Ok(added)
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

    fn day_at(rfc3339: &str) -> Result<NaiveDate, AppError> {
        DateTime::parse_from_rfc3339(rfc3339)
            .map(|instant| activity_day(&instant))
            .map_err(AppError::persistence)
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
    fn seen_insert_merge_and_reload_are_monotonic_and_idempotent() -> Result<(), AppError> {
        let directory = test_directory("seen");
        let store = SeenStore::new(&directory)?;
        assert!(!store.contains(42));
        assert!(store.insert(42)?);
        assert!(!store.insert(42)?);
        assert_eq!(store.merge([42, 43, 43, 44])?, 2);
        assert_eq!(store.merge([42, 43, 44])?, 0);
        drop(store);
        let reloaded = SeenStore::new(&directory)?;
        assert!(reloaded.contains(42));
        assert!(reloaded.contains(43));
        assert!(reloaded.contains(44));
        assert_eq!(reloaded.merge([44, 45])?, 1);
        let saved: Vec<u64> = load_json(&directory.join("prntsc-seen.json"))?;
        assert_eq!(saved, vec![42, 43, 44, 45]);
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn snapshot_merge_is_atomic_monotonic_and_persistent() -> Result<(), AppError> {
        let directory = test_directory("snapshot-merge");
        let local = SeenStore::new(&directory)?;
        local.insert(1)?;
        let incoming_directory = test_directory("snapshot-incoming");
        let incoming = SeenStore::new(&incoming_directory)?;
        incoming.merge([2, 3])?;
        let bytes = incoming
            .serialize_snapshot()
            .map_err(AppError::persistence)?;

        let mut corrupt = bytes.clone();
        corrupt.extend_from_slice(&4_u64.to_le_bytes());
        assert!(local.merge_snapshot(&corrupt).is_err());
        let mut invalid_last = bytes.clone();
        invalid_last[24..32]
            .copy_from_slice(&(crate::sources::prntsc::LEGACY_MAX_VALUE + 1).to_le_bytes());
        assert!(local.merge_snapshot(&invalid_last).is_err());
        assert!(local.contains(1));
        assert!(!local.contains(2));
        assert_eq!(local.merge_snapshot(&bytes)?, 2);
        assert_eq!(local.merge_snapshot(&bytes)?, 0);
        assert_eq!(
            local.merge_snapshot(
                &snapshot::serialize_snapshot(&HashSet::new()).map_err(AppError::persistence)?
            )?,
            0
        );
        assert_eq!(
            local.merge_snapshot(
                &snapshot::serialize_snapshot(&HashSet::from([2_u64]))
                    .map_err(AppError::persistence)?
            )?,
            0
        );
        drop(local);
        let reloaded = SeenStore::new(&directory)?;
        assert_eq!(
            reloaded
                .serialize_snapshot()
                .map_err(AppError::persistence)?,
            snapshot::serialize_snapshot(&HashSet::from([1, 2, 3]))
                .map_err(AppError::persistence)?
        );
        let empty_directory = test_directory("snapshot-empty");
        let empty = SeenStore::new(&empty_directory)?;
        assert_eq!(empty.merge_snapshot(&bytes)?, 2);

        fs::remove_dir_all(directory).map_err(AppError::persistence)?;
        fs::remove_dir_all(incoming_directory).map_err(AppError::persistence)?;
        fs::remove_dir_all(empty_directory).map_err(AppError::persistence)
    }

    #[test]
    #[ignore = "manual size and timing measurement; includes local JSON persistence in merge"]
    #[allow(
        clippy::print_stderr,
        reason = "measurement is reported from an ignored test"
    )]
    fn measure_snapshot_sizes_and_times() -> Result<(), AppError> {
        use std::time::Instant;

        for count in [100_u64, 10_000, 100_000, 500_000, 1_000_000] {
            let directory = test_directory("snapshot-measure");
            let store = SeenStore::new(&directory)?;
            let ids: HashSet<_> = (0..count).collect();

            let start = Instant::now();
            let bytes = snapshot::serialize_snapshot(&ids).map_err(AppError::persistence)?;
            let serialize = start.elapsed();
            let start = Instant::now();
            let parsed = snapshot::parse_snapshot(&bytes).map_err(AppError::persistence)?;
            let parse = start.elapsed();
            let start = Instant::now();
            let added = store.merge(parsed)?;
            let merge = start.elapsed();
            assert_eq!(
                added,
                usize::try_from(count).map_err(AppError::persistence)?
            );
            eprintln!(
                "{count}\t{}\t{serialize:?}\t{parse:?}\t{merge:?}",
                bytes.len()
            );
            #[cfg(target_os = "linux")]
            {
                let status =
                    fs::read_to_string("/proc/self/status").map_err(AppError::persistence)?;
                eprintln!(
                    "{}",
                    status
                        .lines()
                        .find(|line| line.starts_with("VmHWM:"))
                        .unwrap_or("VmHWM unavailable")
                );
            }
            fs::remove_dir_all(directory).map_err(AppError::persistence)?;
        }
        Ok(())
    }

    #[test]
    fn interrupted_seen_snapshot_is_recovered() -> Result<(), AppError> {
        let directory = test_directory("seen-recovery");
        let store = SeenStore::new(&directory)?;
        store.insert(42)?;
        drop(store);
        fs::rename(
            directory.join("prntsc-seen.json"),
            directory.join("prntsc-seen.json.tmp"),
        )
        .map_err(AppError::persistence)?;
        assert!(SeenStore::new(&directory)?.contains(42));
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn failed_seen_save_does_not_change_memory_or_disk() -> Result<(), AppError> {
        let directory = test_directory("seen-failed-save");
        let store = SeenStore::new(&directory)?;
        store.insert(42)?;
        fs::create_dir(directory.join("prntsc-seen.json.tmp")).map_err(AppError::persistence)?;
        assert!(store.insert(43).is_err());
        assert!(!store.contains(43));
        assert!(SeenStore::new(&directory)?.contains(42));
        assert!(!SeenStore::new(&directory)?.contains(43));
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
    fn favorite_toggle_adds_then_removes_and_survives_reload() -> Result<(), AppError> {
        let directory = test_directory("favorites");
        let item = |added_at| FavoriteItem {
            source: "prntsc".to_owned(),
            id: "abc123".to_owned(),
            source_page_url: "https://prnt.sc/abc123".to_owned(),
            added_at,
        };
        let store = FavoriteStore::new(&directory)?;
        assert_eq!(store.toggle(item(42))?, vec![item(42)]);
        // Membership is by (source, id): a later timestamp still removes the same frame.
        assert!(store.toggle(item(84))?.is_empty());
        assert_eq!(store.toggle(item(126))?, vec![item(126)]);

        let reloaded = FavoriteStore::new(&directory)?;
        assert_eq!(reloaded.snapshot(), vec![item(126)]);
        // A save interrupted before its rename leaves only the .tmp file; it is recovered on load.
        fs::rename(
            directory.join("favorites.json"),
            directory.join("favorites.json.tmp"),
        )
        .map_err(AppError::persistence)?;
        assert_eq!(FavoriteStore::new(&directory)?.snapshot(), vec![item(126)]);
        assert!(directory.join("favorites.json").exists());
        reloaded.clear()?;
        assert!(FavoriteStore::new(&directory)?.snapshot().is_empty());
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
    fn history_views_per_day_counts_only_prntsc_entries_by_local_day() -> Result<(), AppError> {
        let directory = test_directory("history-views-per-day");
        let store = HistoryStore::new(&directory)?;
        let viewed_at: u64 = 1_789_000_000_000;
        for (source, id) in [
            ("prntsc", "abc123"),
            ("prntsc", "abc124"),
            ("other", "abc125"),
        ] {
            store.record(HistoryItem {
                source: source.to_owned(),
                id: id.to_owned(),
                source_page_url: format!("https://prnt.sc/{id}"),
                viewed_at,
            })?;
        }
        let day = Local
            .timestamp_millis_opt(1_789_000_000_000)
            .single()
            .map(|time| day_key(activity_day(&time)))
            .unwrap_or_default();
        assert_eq!(store.prntsc_views_per_day(), BTreeMap::from([(day, 2)]));
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn revisit_repair_only_lowers_overcounted_days_runs_once_and_persists() -> Result<(), AppError>
    {
        let directory = test_directory("activity-repair");
        let store = ActivityStore::new(&directory)?;
        // Migrated legacy views match history, so they survive.
        store.migrate("2026-09-21", 3, 100, "2026-09-21")?;
        // 2 revisits on top of 4 first views.
        for _ in 0..6 {
            store.record(ExplorationOutcome::Viewed, "2026-09-22")?;
        }
        store.record(ExplorationOutcome::Rejected, "2026-09-22")?;
        let first_views = BTreeMap::from([
            ("2026-09-20".to_owned(), 9),
            ("2026-09-21".to_owned(), 3),
            ("2026-09-22".to_owned(), 4),
        ]);

        store.repair_revisit_views(&first_views)?;
        store.repair_revisit_views(&BTreeMap::new())?;

        let expected = vec![
            (
                "2026-09-21".to_owned(),
                DailyActivitySnapshot {
                    viewed: 3,
                    rejected: 0,
                },
            ),
            (
                "2026-09-22".to_owned(),
                DailyActivitySnapshot {
                    viewed: 4,
                    rejected: 1,
                },
            ),
        ];
        let today = NaiveDate::from_ymd_opt(2026, 9, 22).unwrap_or_default();
        assert_eq!(
            store.recent_days(today, 183),
            expected,
            "days before tracking stay absent"
        );
        assert_eq!(
            store.viewed_total(),
            104,
            "legacy total survives the repair"
        );
        let reloaded = ActivityStore::new(&directory)?;
        assert_eq!(reloaded.recent_days(today, 183), expected);
        assert_eq!(reloaded.viewed_total(), 104);
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

    #[test]
    fn recent_days_with_zero_max_days_returns_empty() -> Result<(), AppError> {
        let directory = test_directory("activity-window-zero");
        let store = ActivityStore::new(&directory)?;
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        store.record(ExplorationOutcome::Viewed, "2026-09-20")?;
        assert!(store.recent_days(today, 0).is_empty());
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn recent_days_with_future_tracking_start_clamps_to_today() -> Result<(), AppError> {
        let directory = test_directory("activity-window-future");
        let store = ActivityStore::new(&directory)?;
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
        store.record(ExplorationOutcome::Viewed, "2026-09-25")?;
        let days = store.recent_days(today, 183);
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].0, "2026-09-20");
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn activity_day_is_the_local_calendar_day_not_the_utc_day() -> Result<(), AppError> {
        // UTC+2: just after local midnight the UTC date is still the previous day.
        assert_eq!(day_key(day_at("2026-09-22T00:30:00+02:00")?), "2026-09-22");
        assert_eq!(day_key(day_at("2026-09-22T23:59:59+02:00")?), "2026-09-22");
        // UTC-5: late in the local evening the UTC date is already the next day.
        assert_eq!(day_key(day_at("2026-09-22T00:00:00-05:00")?), "2026-09-22");
        assert_eq!(day_key(day_at("2026-09-22T22:30:00-05:00")?), "2026-09-22");
        Ok(())
    }

    #[test]
    fn activity_days_follow_the_local_offset_across_dst_changes() -> Result<(), AppError> {
        // Europe/Warsaw enters DST on 2026-03-29 (+01:00 -> +02:00) and leaves it on 2026-10-25.
        assert_eq!(day_key(day_at("2026-03-29T00:30:00+01:00")?), "2026-03-29");
        assert_eq!(day_key(day_at("2026-03-29T23:30:00+02:00")?), "2026-03-29");
        assert_eq!(day_key(day_at("2026-10-25T00:30:00+02:00")?), "2026-10-25");
        assert_eq!(day_key(day_at("2026-10-25T23:30:00+01:00")?), "2026-10-25");

        let directory = test_directory("activity-window-dst");
        let store = ActivityStore::new(&directory)?;
        store.record(
            ExplorationOutcome::Viewed,
            &day_key(day_at("2026-10-24T12:00:00+02:00")?),
        )?;
        let dates: Vec<String> = store
            .recent_days(day_at("2026-10-26T00:30:00+01:00")?, 183)
            .into_iter()
            .map(|(date, _)| date)
            .collect();
        assert_eq!(
            dates,
            ["2026-10-24", "2026-10-25", "2026-10-26"],
            "the 25-hour DST day appears exactly once, with no skipped or duplicated day"
        );
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn first_local_day_of_use_starts_the_window_and_local_today_ends_it() -> Result<(), AppError> {
        // First use whose UTC date differs from the local date, on both sides of UTC.
        for (zone, first_use, later) in [
            (
                "utc-plus-2",
                "2026-09-22T00:30:00+02:00",
                "2026-09-24T01:00:00+02:00",
            ),
            (
                "utc-minus-5",
                "2026-09-22T22:30:00-05:00",
                "2026-09-24T21:00:00-05:00",
            ),
        ] {
            let directory = test_directory(&format!("activity-first-day-{zone}"));
            let store = ActivityStore::new(&directory)?;
            let first_day = day_at(first_use)?;
            store.record(ExplorationOutcome::Viewed, &day_key(first_day))?;

            assert_eq!(
                store.recent_days(first_day, 183),
                vec![(
                    "2026-09-22".to_owned(),
                    DailyActivitySnapshot {
                        viewed: 1,
                        rejected: 0,
                    },
                )],
                "{zone}: the first local day is today and nothing before it is rendered"
            );

            let days = store.recent_days(day_at(later)?, 183);
            let dates: Vec<&str> = days.iter().map(|(date, _)| date.as_str()).collect();
            assert_eq!(
                dates,
                ["2026-09-22", "2026-09-23", "2026-09-24"],
                "{zone}: window runs from the first local day through local today"
            );
            assert_eq!(days[2].1, DailyActivitySnapshot::default());
            fs::remove_dir_all(directory).map_err(AppError::persistence)?;
        }
        Ok(())
    }
}
