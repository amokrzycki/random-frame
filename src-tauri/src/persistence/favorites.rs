use super::{
    io::{load_json, save_json},
    sync_ops::{operation_id, validate_item},
};
use crate::{
    error::{AppError, ErrorKind},
    snapshot::{
        self, CollectionRecord, FavoriteRecord, MembershipRecord, OperationId, Register,
        SyncSnapshot,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct FavoriteSyncState {
    pub favorites: Vec<FavoriteRecord>,
    #[serde(rename = "removed", alias = "favorites_removed", default)]
    pub favorites_removed: Vec<OperationId>,
    #[serde(default)]
    pub collections: Vec<CollectionRecord>,
    #[serde(default)]
    pub collections_removed: Vec<OperationId>,
    #[serde(default)]
    pub memberships: Vec<MembershipRecord>,
    #[serde(default)]
    pub memberships_removed: Vec<OperationId>,
}
impl FavoriteSyncState {
    pub fn from_snapshot(s: &SyncSnapshot) -> Self {
        Self {
            favorites: s.favorites.clone(),
            favorites_removed: s.favorites_removed.clone(),
            collections: s.collections.clone(),
            collections_removed: s.collections_removed.clone(),
            memberships: s.memberships.clone(),
            memberships_removed: s.memberships_removed.clone(),
        }
    }
    pub fn snapshot(&self) -> SyncSnapshot {
        self.clone().into_snapshot()
    }
    fn into_snapshot(self) -> SyncSnapshot {
        let mut s = SyncSnapshot {
            favorites: self.favorites,
            favorites_removed: self.favorites_removed,
            collections: self.collections,
            collections_removed: self.collections_removed,
            memberships: self.memberships,
            memberships_removed: self.memberships_removed,
            ..SyncSnapshot::default()
        };
        s.favorites.sort_by_key(|x| x.operation_id);
        s.favorites_removed.sort_unstable();
        s.collections.sort_by_key(|x| x.collection_id);
        s.collections_removed.sort_unstable();
        s.memberships.sort_by_key(|x| x.operation_id);
        s.memberships_removed.sort_unstable();
        s
    }
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
struct FavoriteData {
    version: u8,
    #[serde(flatten)]
    state: FavoriteSyncState,
    #[serde(default)]
    editors: BTreeMap<String, CollectionEditorRequest>,
    #[serde(default)]
    removals: BTreeMap<String, RemovalReceipt>,
}
impl FavoriteData {
    fn normalize(&mut self) -> Result<(), AppError> {
        let mut s = self.state.snapshot();
        snapshot::normalize_seeded_collection_name(&mut s);
        s.favorites_removed.dedup();
        s.collections_removed.dedup();
        s.memberships_removed.dedup();
        let removed: HashSet<_> = s.favorites_removed.iter().copied().collect();
        s.favorites.retain(|x| !removed.contains(&x.operation_id));
        let removed: HashSet<_> = s.collections_removed.iter().copied().collect();
        s.collections
            .retain(|x| !removed.contains(&x.collection_id));
        let removed: HashSet<_> = s.memberships_removed.iter().copied().collect();
        s.memberships.retain(|x| !removed.contains(&x.operation_id));
        for item in &s.favorites {
            validate_item(&item.source, &item.id, &item.source_page_url)?;
        }
        snapshot::validate_snapshot(&s).map_err(AppError::persistence)?;
        self.state = FavoriteSyncState::from_snapshot(&s);
        Ok(())
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
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedItem {
    #[serde(flatten)]
    pub item: FavoriteItem,
    pub save_operation_ids: Vec<OperationId>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCollection {
    pub collection_id: OperationId,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_field_names,
    reason = "IPC distinguishes three different operation identities"
)]
pub struct SavedMembership {
    pub operation_id: OperationId,
    pub collection_id: OperationId,
    pub favorite_operation_id: OperationId,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLibrary {
    pub items: Vec<SavedItem>,
    pub collections: Vec<SavedCollection>,
    pub memberships: Vec<SavedMembership>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedFrameRef {
    pub source: String,
    pub id: String,
    pub expected_save_operation_ids: Vec<OperationId>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewCollection {
    pub collection_id: OperationId,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionEditorRequest {
    pub request_id: OperationId,
    pub frame: SavedFrameRef,
    pub create_collections: Vec<NewCollection>,
    pub add_to_collection_ids: Vec<OperationId>,
    pub remove_membership_operation_ids: Vec<OperationId>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveSavedRequest {
    pub request_id: OperationId,
    pub frames: Vec<SavedFrameRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoSavedFrame {
    pub item: FavoriteItem,
    pub collection_ids: Vec<OperationId>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedUndo {
    pub request_id: OperationId,
    pub frames: Vec<UndoSavedFrame>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct RemovalReceipt {
    request: RemoveSavedRequest,
    undo: SavedUndo,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedSaved {
    pub library: SavedLibrary,
    pub undo: SavedUndo,
}
fn request_key(id: &OperationId) -> String {
    hex::encode(id)
}
fn collection_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    snapshot::validate_collection_name(name).map_err(|_| {
        AppError::invalid_input(
            "Use a collection name of 1–128 UTF-8 bytes without control characters",
        )
    })?;
    Ok(name.into())
}
fn saved_ids(data: &FavoriteData, frame: &SavedFrameRef) -> Vec<OperationId> {
    data.state
        .favorites
        .iter()
        .filter(|x| x.source == frame.source && x.id == frame.id)
        .map(|x| x.operation_id)
        .collect()
}
fn check_save(data: &FavoriteData, frame: &SavedFrameRef) -> Result<(), AppError> {
    let ids = saved_ids(data, frame);
    if ids.is_empty() || ids != frame.expected_save_operation_ids {
        return Err(AppError::new(
            ErrorKind::StaleSavedFrame,
            "This save changed while you were editing. Open the current save to begin a new edit.",
        ));
    }
    Ok(())
}
fn projection(data: &FavoriteData) -> SavedLibrary {
    let mut records: Vec<_> = data.state.favorites.iter().collect();
    records.sort_by_key(|x| (x.added_at, x.operation_id));
    let mut seen = HashSet::new();
    let items = records
        .into_iter()
        .filter(|x| seen.insert((&x.source, &x.id)))
        .map(|x| SavedItem {
            item: FavoriteItem {
                source: x.source.clone(),
                id: x.id.clone(),
                source_page_url: x.source_page_url.clone(),
                added_at: x.added_at,
            },
            save_operation_ids: data
                .state
                .favorites
                .iter()
                .filter(|op| op.source == x.source && op.id == x.id)
                .map(|op| op.operation_id)
                .collect(),
        })
        .collect();
    let collections = data
        .state
        .collections
        .iter()
        .map(|c| SavedCollection {
            collection_id: c.collection_id,
            name: c.name.value.clone(),
        })
        .collect();
    let saves: HashSet<_> = data
        .state
        .favorites
        .iter()
        .map(|x| x.operation_id)
        .collect();
    let active: HashSet<_> = data
        .state
        .collections
        .iter()
        .map(|x| x.collection_id)
        .collect();
    let memberships = data
        .state
        .memberships
        .iter()
        .filter(|m| saves.contains(&m.favorite_operation_id) && active.contains(&m.collection_id))
        .map(|m| SavedMembership {
            operation_id: m.operation_id,
            collection_id: m.collection_id,
            favorite_operation_id: m.favorite_operation_id,
        })
        .collect();
    SavedLibrary {
        items,
        collections,
        memberships,
    }
}

/// Global saves and their collections share one atomic file, mutex and generation.
pub struct FavoriteStore {
    path: PathBuf,
    data: Mutex<FavoriteData>,
    generation: AtomicU64,
}
impl FavoriteStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("favorites-v4.json");
        let source =
            super::migration::source_path(directory, "favorites-v4.json", "favorites-v3.json")?;
        let source = if source == path {
            source
        } else {
            super::migration::source_path(directory, "favorites-v3.json", "favorites.json")?
        };
        let value: serde_json::Value = load_json(&source)?;
        let mut data = if value.is_null() {
            FavoriteData::default()
        } else if value.is_array() {
            let old: Vec<FavoriteItem> =
                serde_json::from_value(value).map_err(AppError::persistence)?;
            FavoriteData {
                version: 2,
                state: FavoriteSyncState {
                    favorites: old
                        .into_iter()
                        .map(|x| FavoriteRecord {
                            operation_id: operation_id(),
                            added_at: x.added_at,
                            source: x.source,
                            id: x.id,
                            source_page_url: x.source_page_url,
                        })
                        .collect(),
                    ..FavoriteSyncState::default()
                },
                ..FavoriteData::default()
            }
        } else {
            serde_json::from_value(value).map_err(AppError::persistence)?
        };
        if (source == path && data.version != 4)
            || (source != path && ![0, 2, 3].contains(&data.version))
        {
            return Err(AppError::persistence("Unsupported saved library schema"));
        }
        data.normalize()?;
        if source != path {
            let mut s = data.state.snapshot();
            snapshot::migrate_legacy_collections(&mut s);
            data.state = FavoriteSyncState::from_snapshot(&s);
        }
        data.version = 4;
        data.normalize()?;
        save_json(&path, &data)?;
        super::migration::receipt(directory, "favorites-v4")?;
        Ok(Self {
            path,
            data: Mutex::new(data),
            generation: AtomicU64::new(0),
        })
    }
    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut FavoriteData) -> Result<T, AppError>,
    ) -> Result<(SavedLibrary, T), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = data.clone();
        let result = f(&mut next)?;
        next.normalize()?;
        if next != *data {
            save_json(&self.path, &next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        let library = projection(&data);
        drop(data);
        Ok((library, result))
    }
    pub fn library(&self) -> SavedLibrary {
        projection(
            &self
                .data
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
    pub fn snapshot(&self) -> Vec<FavoriteItem> {
        self.library().items.into_iter().map(|x| x.item).collect()
    }
    pub fn sync_state_with_generation(&self) -> (FavoriteSyncState, u64) {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (data.state.clone(), self.generation.load(Ordering::Relaxed))
    }
    #[cfg(test)]
    pub fn sync_state(&self) -> FavoriteSyncState {
        self.sync_state_with_generation().0
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub fn replace_sync_state(&self, incoming: FavoriteSyncState) -> Result<(), AppError> {
        self.mutate(|data| {
            data.state = incoming;
            Ok(())
        })
        .map(|_| ())
    }
    pub fn merge_sync_state(&self, incoming: FavoriteSyncState) -> Result<(), AppError> {
        self.mutate(|data| {
            let merged =
                snapshot::merge_snapshots(&data.state.snapshot(), &incoming.into_snapshot())
                    .map_err(AppError::persistence)?;
            data.state = FavoriteSyncState::from_snapshot(&merged);
            Ok(())
        })
        .map(|_| ())
    }
    fn clock(data: &FavoriteData) -> Result<u64, AppError> {
        data.state
            .collections
            .iter()
            .map(|c| c.name.clock)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| AppError::persistence("Collection clock exhausted"))
    }
    fn target(data: &FavoriteData, id: OperationId) -> Result<(), AppError> {
        if data.state.collections.iter().any(|c| c.collection_id == id) {
            Ok(())
        } else {
            Err(AppError::invalid_input(
                "That collection no longer exists. Choose another collection.",
            ))
        }
    }
    pub fn create_collection(&self, name: &str) -> Result<SavedLibrary, AppError> {
        let name = collection_name(name)?;
        self.mutate(|data| {
            data.state.collections.push(CollectionRecord {
                collection_id: operation_id(),
                name: Register {
                    clock: Self::clock(data)?,
                    operation_id: operation_id(),
                    value: name,
                },
            });
            Ok(())
        })
        .map(|x| x.0)
    }
    pub fn rename_collection(&self, id: OperationId, name: &str) -> Result<SavedLibrary, AppError> {
        let name = collection_name(name)?;
        self.mutate(|data| {
            Self::target(data, id)?;
            let clock = Self::clock(data)?;
            if let Some(c) = data
                .state
                .collections
                .iter_mut()
                .find(|c| c.collection_id == id)
            {
                c.name = Register {
                    clock,
                    operation_id: operation_id(),
                    value: name,
                };
            }
            Ok(())
        })
        .map(|x| x.0)
    }
    pub fn delete_collection(&self, id: OperationId) -> Result<SavedLibrary, AppError> {
        self.mutate(|data| {
            if data.state.collections_removed.contains(&id) {
                return Ok(());
            }
            Self::target(data, id)?;
            data.state.collections_removed.push(id);
            Ok(())
        })
        .map(|x| x.0)
    }
    pub fn save_frame(
        &self,
        item: FavoriteItem,
        collection_id: Option<OperationId>,
    ) -> Result<SavedLibrary, AppError> {
        validate_item(&item.source, &item.id, &item.source_page_url)?;
        self.mutate(|data| {
            if let Some(id) = collection_id {
                Self::target(data, id)?;
            }
            let mut ids: Vec<_> = data
                .state
                .favorites
                .iter()
                .filter(|x| x.source == item.source && x.id == item.id)
                .map(|x| x.operation_id)
                .collect();
            if ids.is_empty() {
                let id = operation_id();
                ids.push(id);
                data.state.favorites.push(FavoriteRecord {
                    operation_id: id,
                    added_at: item.added_at,
                    source: item.source,
                    id: item.id,
                    source_page_url: item.source_page_url,
                });
            }
            if let Some(collection_id) = collection_id {
                if !data.state.memberships.iter().any(|m| {
                    m.collection_id == collection_id && ids.contains(&m.favorite_operation_id)
                }) {
                    data.state.memberships.push(MembershipRecord {
                        operation_id: operation_id(),
                        collection_id,
                        favorite_operation_id: ids[0],
                    });
                }
            }
            Ok(())
        })
        .map(|x| x.0)
    }
    pub fn commit_editor(
        &self,
        request: CollectionEditorRequest,
    ) -> Result<SavedLibrary, AppError> {
        self.mutate(|data| {
            let key = request_key(&request.request_id);
            if let Some(previous) = data.editors.get(&key) {
                if previous != &request {
                    return Err(AppError::invalid_input("Conflicting editor request"));
                }
                return Ok(());
            }
            check_save(data, &request.frame)?;
            let mut creates = BTreeSet::new();
            let clock = Self::clock(data)?;
            for c in &request.create_collections {
                if !creates.insert(c.collection_id)
                    || data
                        .state
                        .collections
                        .iter()
                        .any(|x| x.collection_id == c.collection_id)
                    || data.state.collections_removed.contains(&c.collection_id)
                {
                    return Err(AppError::invalid_input(
                        "Collection identity already exists",
                    ));
                }
                let name = collection_name(&c.name)?;
                data.state.collections.push(CollectionRecord {
                    collection_id: c.collection_id,
                    name: Register {
                        clock,
                        operation_id: snapshot::hash_id(&[
                            b"rf/collections/create/v1",
                            &request.request_id,
                            &c.collection_id,
                        ]),
                        value: name,
                    },
                });
            }
            for id in &request.add_to_collection_ids {
                Self::target(data, *id)?;
            }
            for id in &request.remove_membership_operation_ids {
                if !data.state.memberships_removed.contains(id)
                    && !data.state.memberships.iter().any(|m| {
                        m.operation_id == *id
                            && request
                                .frame
                                .expected_save_operation_ids
                                .contains(&m.favorite_operation_id)
                    })
                {
                    return Err(AppError::invalid_input("Unknown saved frame assignment"));
                }
            }
            data.state
                .memberships_removed
                .extend(&request.remove_membership_operation_ids);
            let targets: BTreeSet<_> = request.add_to_collection_ids.iter().copied().collect();
            if targets.len() != request.add_to_collection_ids.len() {
                return Err(AppError::invalid_input("Duplicate collection target"));
            }
            for collection_id in targets {
                let favorite_operation_id = request.frame.expected_save_operation_ids[0];
                // Stable IDs make a retried commit unable to revive an assignment removed later.
                let operation_id = snapshot::hash_id(&[
                    b"rf/collections/assign/v1",
                    &request.request_id,
                    &collection_id,
                    &favorite_operation_id,
                ]);
                data.state.memberships.push(MembershipRecord {
                    operation_id,
                    collection_id,
                    favorite_operation_id,
                });
            }
            data.editors.insert(key, request);
            Ok(())
        })
        .map(|x| x.0)
    }
    pub fn remove_saved(&self, request: RemoveSavedRequest) -> Result<RemovedSaved, AppError> {
        let (library, undo) = self.mutate(|data| {
            let key = request_key(&request.request_id);
            if let Some(receipt) = data.removals.get(&key) {
                if receipt.request != request {
                    return Err(AppError::invalid_input("Conflicting removal request"));
                }
                return Ok(receipt.undo.clone());
            }
            for frame in &request.frames {
                check_save(data, frame)?;
            }
            let library = projection(data);
            let frames = library
                .items
                .iter()
                .filter(|x| {
                    request
                        .frames
                        .iter()
                        .any(|f| f.source == x.item.source && f.id == x.item.id)
                })
                .map(|x| UndoSavedFrame {
                    item: x.item.clone(),
                    collection_ids: library
                        .memberships
                        .iter()
                        .filter(|m| x.save_operation_ids.contains(&m.favorite_operation_id))
                        .map(|m| m.collection_id)
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect(),
                })
                .collect();
            let undo = SavedUndo {
                request_id: snapshot::hash_id(&[b"rf/collections/undo/v1", &request.request_id]),
                frames,
            };
            let ids: HashSet<_> = request
                .frames
                .iter()
                .flat_map(|x| &x.expected_save_operation_ids)
                .copied()
                .collect();
            data.state.favorites_removed.extend(ids.iter());
            data.state.memberships_removed.extend(
                data.state
                    .memberships
                    .iter()
                    .filter(|m| ids.contains(&m.favorite_operation_id))
                    .map(|m| m.operation_id),
            );
            data.removals.insert(
                key,
                RemovalReceipt {
                    request,
                    undo: undo.clone(),
                },
            );
            Ok(undo)
        })?;
        Ok(RemovedSaved { library, undo })
    }
    pub fn restore_saved(&self, undo: &SavedUndo) -> Result<SavedLibrary, AppError> {
        self.mutate(|data| {
            if !data.removals.values().any(|receipt| &receipt.undo == undo) {
                return Err(AppError::invalid_input("Unknown saved Undo"));
            }
            for frame in &undo.frames {
                let x = &frame.item;
                validate_item(&x.source, &x.id, &x.source_page_url)?;
                let id = snapshot::hash_id(&[
                    b"rf/collections/restore-save/v1",
                    &undo.request_id,
                    x.source.as_bytes(),
                    b"\0",
                    x.id.as_bytes(),
                ]);
                if !data.state.favorites.iter().any(|x| x.operation_id == id)
                    && !data.state.favorites_removed.contains(&id)
                {
                    data.state.favorites.push(FavoriteRecord {
                        operation_id: id,
                        added_at: x.added_at,
                        source: x.source.clone(),
                        id: x.id.clone(),
                        source_page_url: x.source_page_url.clone(),
                    });
                }
                for collection_id in frame.collection_ids.iter().copied() {
                    if Self::target(data, collection_id).is_err() {
                        continue;
                    }
                    let operation_id = snapshot::hash_id(&[
                        b"rf/collections/restore-membership/v1",
                        &undo.request_id,
                        &collection_id,
                        &id,
                    ]);
                    if !data
                        .state
                        .memberships
                        .iter()
                        .any(|m| m.operation_id == operation_id)
                        && !data.state.memberships_removed.contains(&operation_id)
                    {
                        data.state.memberships.push(MembershipRecord {
                            operation_id,
                            collection_id,
                            favorite_operation_id: id,
                        });
                    }
                }
            }
            Ok(())
        })
        .map(|x| x.0)
    }
    // Retained for old callers; new UI uses idempotent save/remove/restore commands.
    pub fn toggle(&self, item: FavoriteItem) -> Result<Vec<FavoriteItem>, AppError> {
        let library = self.library();
        if let Some(x) = library
            .items
            .iter()
            .find(|x| x.item.source == item.source && x.item.id == item.id)
        {
            self.remove_saved(RemoveSavedRequest {
                request_id: operation_id(),
                frames: vec![SavedFrameRef {
                    source: item.source,
                    id: item.id,
                    expected_save_operation_ids: x.save_operation_ids.clone(),
                }],
            })?;
        } else {
            self.save_frame(item, None)?;
        }
        Ok(self.snapshot())
    }
    pub fn clear(&self) -> Result<(), AppError> {
        let frames = self
            .library()
            .items
            .into_iter()
            .map(|x| SavedFrameRef {
                source: x.item.source,
                id: x.item.id,
                expected_save_operation_ids: x.save_operation_ids,
            })
            .collect();
        self.remove_saved(RemoveSavedRequest {
            request_id: operation_id(),
            frames,
        })
        .map(|_| ())
    }
}
