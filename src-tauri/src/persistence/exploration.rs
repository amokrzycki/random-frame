use crate::error::AppError;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorationOutcome {
    Viewed,
    Rejected,
}
