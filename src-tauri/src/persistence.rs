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
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HistoryData::default(),
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
        let index = data
            .history
            .iter()
            .position(|saved| saved.source == item.source && saved.id == item.id);
        data.index = Some(if let Some(index) = index {
            data.history[index].viewed_at = item.viewed_at;
            index
        } else {
            data.history.push(item);
            data.history.len() - 1
        });
        self.save(&data)?;
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
        data.index = Some(index);
        self.save(&data)?;
        let result = snapshot(&data);
        drop(data);
        Ok(result)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *data = HistoryData::default();
        let result = self.save(&data);
        drop(data);
        result
    }

    fn save(&self, data: &HistoryData) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
        fs::write(&self.path, bytes).map_err(AppError::persistence)
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
        drop(store);
        assert_eq!(ExplorationStore::new(&directory)?.count(), 1);
        fs::remove_dir_all(directory).map_err(AppError::persistence)
    }
}
