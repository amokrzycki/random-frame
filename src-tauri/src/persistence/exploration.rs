use super::io::{load_json, save_json};
use crate::{
    error::AppError,
    snapshot::{merge_snapshots, ExplorationRecord, SyncSnapshot},
    sources::prntsc::{item_id_value, value_to_base36, LEGACY_MAX_VALUE},
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
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExplorationData {
    version: u8,
    records: Vec<ExplorationRecord>,
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
        let source =
            super::migration::source_path(directory, "exploration-v2.json", "prntsc-explored.txt")?;
        let mut ids = BTreeMap::new();
        if source == path {
            let data: ExplorationData = load_json(&path)?;
            if data.version != 2 {
                return Err(AppError::persistence("Unsupported Exploration schema"));
            }
            crate::snapshot::validate_snapshot(&SyncSnapshot {
                exploration: data.records.clone(),
                ..SyncSnapshot::default()
            })
            .map_err(AppError::persistence)?;
            for x in data.records {
                ids.insert((x.source, x.id), x.evidence);
            }
        } else {
            match fs::read_to_string(source) {
                Ok(contents) => {
                    for line in contents.lines() {
                        let (id, evidence) = match line.split_once(',') {
                            Some((id, "v")) => (id, 1),
                            Some((id, "r")) => (id, 2),
                            None => (line, 0),
                            _ => return Err(AppError::persistence("Invalid exploration marker")),
                        };
                        let id: u64 = id.parse().map_err(AppError::persistence)?;
                        if id > LEGACY_MAX_VALUE {
                            return Err(AppError::persistence("Invalid exploration ID"));
                        }
                        *ids.entry(("prntsc".into(), value_to_base36(id)))
                            .or_insert(0) |= evidence;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(AppError::persistence(e)),
            }
        }
        save_json(
            &path,
            &ExplorationData {
                version: 2,
                records: records(&ids),
            },
        )?;
        super::migration::receipt(directory, "exploration-v2")?;
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
        if id > LEGACY_MAX_VALUE {
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
    pub fn viewed_ids(&self) -> Vec<u64> {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|((source, _), evidence)| source == "prntsc" && *evidence & 1 != 0)
            .filter_map(|((_, id), _)| item_id_value(id).ok())
            .collect()
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
