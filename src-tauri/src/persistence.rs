use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
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

pub struct ExplorationStore {
    path: PathBuf,
    ids: Mutex<HashSet<u64>>,
}

impl ExplorationStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("prntsc-explored.txt");
        let ids = match fs::read_to_string(&path) {
            Ok(contents) => contents
                .lines()
                .map(str::parse)
                .collect::<Result<_, _>>()
                .map_err(AppError::persistence)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashSet::new(),
            Err(error) => return Err(AppError::persistence(error)),
        };
        Ok(Self {
            path,
            ids: Mutex::new(ids),
        })
    }

    pub fn mark(&self, id: u64) -> Result<bool, AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !ids.insert(id) {
            return Ok(false);
        }
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| writeln!(file, "{id}"));
        if let Err(error) = result {
            ids.remove(&id);
            drop(ids);
            return Err(AppError::persistence(error));
        }
        drop(ids);
        Ok(true)
    }

    pub fn count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    pub fn contains(&self, id: u64) -> bool {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&id)
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
                thread::spawn(move || store.mark(42))
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
}
