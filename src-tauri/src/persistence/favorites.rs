use super::{
    io::{load_json, save_json},
    sync_ops::{cap_tombstones, operation_id, validate_item},
};
use crate::{error::AppError, snapshot::MAX_SECTION};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct FavoriteData {
    version: u8,
    favorites: Vec<FavoriteOp>,
    removed: Vec<[u8; 16]>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FavoriteOp {
    operation_id: [u8; 16],
    added_at: u64,
    source: String,
    id: String,
    source_page_url: String,
}

pub type FavoriteSyncState = (Vec<crate::snapshot::FavoriteRecord>, Vec<[u8; 16]>);

impl FavoriteData {
    fn normalize(&mut self) {
        let removed: HashSet<_> = self.removed.iter().copied().collect();
        self.favorites
            .retain(|op| !removed.contains(&op.operation_id));
        cap_tombstones(&mut self.removed);
    }
}

fn favorite_projection(data: &FavoriteData) -> Vec<FavoriteItem> {
    let mut items: Vec<_> = data.favorites.iter().collect();
    items.sort_by_key(|item| (item.added_at, item.operation_id));
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert((item.source.as_str(), item.id.as_str())))
        .map(|item| FavoriteItem {
            source: item.source.clone(),
            id: item.id.clone(),
            source_page_url: item.source_page_url.clone(),
            added_at: item.added_at,
        })
        .collect()
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
    data: Mutex<FavoriteData>,
    generation: AtomicU64,
}

impl FavoriteStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("favorites.json");
        let value: serde_json::Value = load_json(&path)?;
        let mut data = if value.is_null() {
            FavoriteData {
                version: 2,
                favorites: Vec::new(),
                removed: Vec::new(),
            }
        } else if value.is_array() {
            let old: Vec<FavoriteItem> =
                serde_json::from_value(value).map_err(AppError::persistence)?;
            FavoriteData {
                version: 2,
                favorites: old
                    .into_iter()
                    .map(|item| FavoriteOp {
                        operation_id: operation_id(),
                        added_at: item.added_at,
                        source: item.source,
                        id: item.id,
                        source_page_url: item.source_page_url,
                    })
                    .collect(),
                removed: Vec::new(),
            }
        } else {
            serde_json::from_value(value).map_err(AppError::persistence)?
        };
        if data.version != 2 {
            return Err(AppError::persistence("Unsupported favorites schema"));
        }
        data.normalize();
        save_json(&path, &data)?;
        Ok(Self {
            path,
            data: Mutex::new(data),
            generation: AtomicU64::new(0),
        })
    }

    pub fn snapshot(&self) -> Vec<FavoriteItem> {
        favorite_projection(
            &self
                .data
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    pub fn sync_state_with_generation(&self) -> (FavoriteSyncState, u64) {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = (
            data.favorites
                .iter()
                .map(|op| crate::snapshot::FavoriteRecord {
                    operation_id: op.operation_id,
                    added_at: op.added_at,
                    source: op.source.clone(),
                    id: op.id.clone(),
                    source_page_url: op.source_page_url.clone(),
                })
                .collect(),
            data.removed.clone(),
        );
        let generation = self.generation.load(Ordering::Relaxed);
        drop(data);
        (state, generation)
    }

    #[cfg(test)]
    pub fn sync_state(&self) -> FavoriteSyncState {
        self.sync_state_with_generation().0
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn merge_sync_state(&self, incoming: FavoriteSyncState) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let mut positions: HashMap<_, _> = next
            .favorites
            .iter()
            .enumerate()
            .map(|(index, op)| (op.operation_id, index))
            .collect();
        for op in incoming.0 {
            if let Some(&index) = positions.get(&op.operation_id) {
                let existing = &next.favorites[index];
                if existing.source != op.source
                    || existing.id != op.id
                    || existing.source_page_url != op.source_page_url
                    || existing.added_at != op.added_at
                {
                    return Err(AppError::persistence("Conflicting favorite operation"));
                }
            } else {
                positions.insert(op.operation_id, next.favorites.len());
                next.favorites.push(FavoriteOp {
                    operation_id: op.operation_id,
                    added_at: op.added_at,
                    source: op.source,
                    id: op.id,
                    source_page_url: op.source_page_url,
                });
            }
        }
        next.removed.extend(incoming.1);
        next.normalize();
        save_json(&self.path, &next)?;
        *data = next;
        self.generation.fetch_add(1, Ordering::Relaxed);
        drop(data);
        Ok(())
    }

    /// Adds the frame, or removes it when its `(source, id)` is already a favorite.
    pub fn toggle(&self, item: FavoriteItem) -> Result<Vec<FavoriteItem>, AppError> {
        validate_item(&item.source, &item.id, &item.source_page_url)?;
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let active_ids: Vec<_> = next
            .favorites
            .iter()
            .filter(|saved| saved.source == item.source && saved.id == item.id)
            .map(|saved| saved.operation_id)
            .collect();
        if active_ids.is_empty() {
            if next.favorites.len() >= MAX_SECTION {
                return Err(AppError::invalid_input("Favorites limit reached"));
            }
            next.favorites.push(FavoriteOp {
                operation_id: operation_id(),
                added_at: item.added_at,
                source: item.source,
                id: item.id,
                source_page_url: item.source_page_url,
            });
        } else {
            next.removed.extend(active_ids);
        }
        next.normalize();
        save_json(&self.path, &next)?;
        *data = next;
        self.generation.fetch_add(1, Ordering::Relaxed);
        let result = favorite_projection(&data);
        drop(data);
        Ok(result)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        next.removed
            .extend(next.favorites.iter().map(|item| item.operation_id));
        next.normalize();
        save_json(&self.path, &next)?;
        *data = next;
        self.generation.fetch_add(1, Ordering::Relaxed);
        drop(data);
        Ok(())
    }
}
