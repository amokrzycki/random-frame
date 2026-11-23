use super::io::{load_json, save_json};
use crate::{
    error::AppError,
    snapshot::{merge_snapshots, ExplorationRecord, SyncSnapshot},
    sources::prntsc::value_to_base36,
};
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorationOutcome {
    // Bit 1 is verified availability; it does not imply a user view.
    Viewed,
    Rejected,
}
impl ExplorationOutcome {
    pub fn evidence(self) -> u8 {
        match self {
            Self::Viewed => 1,
            Self::Rejected => 2,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExplorationData {
    version: u8,
    records: Vec<ExplorationRecord>,
}
impl Default for ExplorationData {
    fn default() -> Self {
        Self {
            version: 2,
            records: Vec::new(),
        }
    }
}
pub struct ExplorationStore {
    path: PathBuf,
    ids: Mutex<BTreeMap<(String, String), u8>>,
    generation: AtomicU64,
}
impl ExplorationStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("exploration-v2.json");
        let data: ExplorationData = load_json(&path)?;
        if data.version != 2 {
            return Err(AppError::persistence("Unsupported Exploration schema"));
        }
        crate::snapshot::validate_snapshot(&SyncSnapshot {
            exploration: data.records.clone(),
            ..SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        let ids: BTreeMap<_, _> = data
            .records
            .into_iter()
            .map(|x| ((x.source, x.id), x.evidence))
            .collect();
        save_json(
            &path,
            &ExplorationData {
                version: 2,
                records: records(&ids),
            },
        )?;
        Ok(Self {
            path,
            ids: Mutex::new(ids),
            generation: AtomicU64::new(0),
        })
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub fn sync_state(&self) -> Vec<ExplorationRecord> {
        records(
            &self
                .ids
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
    /// Restore: exploration becomes exactly `incoming`.
    pub fn replace_sync_state(&self, incoming: Vec<ExplorationRecord>) -> Result<(), AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next: BTreeMap<_, _> = incoming
            .into_iter()
            .map(|x| ((x.source, x.id), x.evidence))
            .collect();
        if *ids != next {
            save_json(
                &self.path,
                &ExplorationData {
                    version: 2,
                    records: records(&next),
                },
            )?;
            *ids = next;
            drop(ids);
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn merge_sync_state(&self, incoming: Vec<ExplorationRecord>) -> Result<(), AppError> {
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let merged = merge_snapshots(
            &SyncSnapshot {
                exploration: records(&ids),
                ..SyncSnapshot::default()
            },
            &SyncSnapshot {
                exploration: incoming,
                ..SyncSnapshot::default()
            },
        )
        .map_err(AppError::persistence)?;
        let next: BTreeMap<_, _> = merged
            .exploration
            .into_iter()
            .map(|x| ((x.source, x.id), x.evidence))
            .collect();
        if *ids != next {
            save_json(
                &self.path,
                &ExplorationData {
                    version: 2,
                    records: records(&next),
                },
            )?;
            *ids = next;
            drop(ids);
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn mark(&self, id: u64, outcome: ExplorationOutcome) -> Result<bool, AppError> {
        if id > crate::sources::prntsc::LEGACY_MAX_VALUE {
            return Err(AppError::invalid_input("Invalid image identifier"));
        }
        if self.contains(id) {
            return Ok(false);
        }
        self.merge_sync_state(vec![ExplorationRecord {
            source: "prntsc".into(),
            id: value_to_base36(id),
            evidence: outcome.evidence(),
        }])?;
        Ok(true)
    }
    pub fn evidence(&self, id: u64) -> Option<u8> {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&("prntsc".into(), value_to_base36(id)))
            .copied()
    }
    pub fn contains(&self, id: u64) -> bool {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&("prntsc".into(), value_to_base36(id)))
    }
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut result = (0, 0, 0, 0);
        for ((source, _), evidence) in ids.iter() {
            if source != "prntsc" {
                continue;
            }
            result.0 += 1;
            if evidence & 1 != 0 {
                result.1 += 1;
            } else if evidence & 2 != 0 {
                result.2 += 1;
            } else {
                result.3 += 1;
            }
        }
        drop(ids);
        result
    }
    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.counts().0
    }
    #[cfg(test)]
    pub fn viewable_count(&self) -> usize {
        self.counts().1
    }
    #[cfg(test)]
    pub fn unavailable_count(&self) -> usize {
        self.counts().2
    }
}
fn records(ids: &BTreeMap<(String, String), u8>) -> Vec<ExplorationRecord> {
    ids.iter()
        .map(|((source, id), evidence)| ExplorationRecord {
            source: source.clone(),
            id: id.clone(),
            evidence: *evidence,
        })
        .collect()
}
