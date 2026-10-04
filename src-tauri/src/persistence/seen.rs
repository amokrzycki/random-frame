use super::io::{load_json, save_json};
use crate::error::AppError;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Monotonic local record of legacy Prnt.sc frames accepted for display.
/// Remote merges update the JSON base; local views append fixed-width IDs to the log.
pub struct SeenStore {
    path: PathBuf,
    #[allow(
        dead_code,
        reason = "retained append-log API; coordinated writes currently use bulk merge"
    )]
    log_path: PathBuf,
    ids: Mutex<HashSet<u64>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SeenStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("prntsc-seen.json");
        let log_path = directory.join("prntsc-seen.log");
        let ids: Vec<u64> = load_json(&path)?;
        if ids
            .iter()
            .any(|id| *id > crate::sources::prntsc::LEGACY_MAX_VALUE)
        {
            return Err(AppError::persistence("Invalid legacy Prnt.sc seen ID"));
        }
        let mut ids: HashSet<u64> = ids.into_iter().collect();
        let log = match fs::read(&log_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(AppError::persistence(error)),
        };
        let mut records = log.chunks_exact(8);
        for record in &mut records {
            let id = u64::from_le_bytes(record.try_into().map_err(AppError::persistence)?);
            if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
                return Err(AppError::persistence("Invalid legacy Prnt.sc seen ID"));
            }
            ids.insert(id);
        }
        if !records.remainder().is_empty() {
            OpenOptions::new()
                .write(true)
                .open(&log_path)
                .and_then(|file| file.set_len((log.len() - records.remainder().len()) as u64))
                .map_err(AppError::persistence)?;
        }
        Ok(Self {
            path,
            log_path,
            ids: Mutex::new(ids),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
    }

    pub fn contains(&self, id: u64) -> bool {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&id)
    }

    #[allow(
        dead_code,
        reason = "retained monotonic insert API is exercised by persistence and upload-race tests"
    )]
    pub fn insert(&self, id: u64) -> Result<bool, AppError> {
        if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
            return Err(AppError::invalid_input("Invalid legacy Prnt.sc seen ID"));
        }
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ids.contains(&id) {
            return Ok(false);
        }
        // ponytail: this log grows with local views; compact it if startup replay becomes costly.
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .map_err(AppError::persistence)?;
        let length = file.metadata().map_err(AppError::persistence)?.len();
        let aligned_length = length - length % 8;
        if aligned_length != length {
            file.set_len(aligned_length)
                .map_err(AppError::persistence)?;
        }
        if let Err(error) = file.write_all(&id.to_le_bytes()) {
            let _ = file.set_len(aligned_length);
            return Err(AppError::persistence(error));
        }
        file.sync_all().map_err(AppError::persistence)?;
        ids.insert(id);
        drop(ids);
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(true)
    }

    pub fn snapshot_with_generation(&self) -> (Vec<u64>, u64) {
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut sorted: Vec<_> = ids.iter().copied().collect();
        sorted.sort_unstable();
        let generation = self.generation.load(std::sync::atomic::Ordering::Relaxed);
        drop(ids);
        (sorted, generation)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::Relaxed)
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
        // Remote merges rewrite the base snapshot; local inserts only append to the log.
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
