use crate::{error::AppError, sources::prntsc::LEGACY_MAX_VALUE};
use std::{
    collections::{hash_map::Entry, HashMap},
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

    fn from_marker(marker: &str) -> Option<Self> {
        match marker {
            "v" => Some(Self::Viewed),
            "r" => Some(Self::Rejected),
            _ => None,
        }
    }
}

fn corrupt_exploration() -> AppError {
    AppError::persistence("Invalid Prnt.sc exploration data")
}

fn parse_exploration_line(line: &str) -> Result<(u64, ExplorationClass), AppError> {
    let (id, class) = match line.split_once(',') {
        Some((id, marker)) => (
            id,
            ExplorationClass::from_marker(marker).ok_or_else(corrupt_exploration)?,
        ),
        None => (line, ExplorationClass::Unknown),
    };
    let id = id.parse().map_err(|_| corrupt_exploration())?;
    if id > LEGACY_MAX_VALUE {
        return Err(corrupt_exploration());
    }
    Ok((id, class))
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
            Ok(contents) => {
                let mut ids = HashMap::new();
                for line in contents.lines() {
                    let (id, class) = parse_exploration_line(line)?;
                    match ids.entry(id) {
                        Entry::Vacant(entry) => {
                            entry.insert(class);
                        }
                        Entry::Occupied(entry) if *entry.get() == class => {}
                        Entry::Occupied(_) => return Err(corrupt_exploration()),
                    }
                }
                ids
            }
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
        if id > LEGACY_MAX_VALUE {
            return Err(AppError::invalid_input("Invalid image identifier"));
        }
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

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// One snapshot keeps the displayed categories coherent with the total during writes.
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut viewable = 0;
        let mut unavailable = 0;
        let mut unclassified = 0;
        for class in ids.values() {
            match class {
                ExplorationClass::Viewed => viewable += 1,
                ExplorationClass::Rejected => unavailable += 1,
                ExplorationClass::Unknown => unclassified += 1,
            }
        }
        (ids.len(), viewable, unavailable, unclassified)
    }

    /// Unique Prnt.sc ids classified as viewed since tracking began. Excludes legacy ids.
    #[cfg(test)]
    pub fn viewable_count(&self) -> usize {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|class| **class == ExplorationClass::Viewed)
            .count()
    }

    /// Unique Prnt.sc ids classified as rejected since tracking began. Excludes legacy ids.
    #[cfg(test)]
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorationOutcome {
    Viewed,
    Rejected,
}
