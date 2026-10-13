use super::*;
use crate::persistence::favorites::{
    CollectionEditorRequest, NewCollection, RemoveSavedRequest, SavedFrameRef,
};
use crate::snapshot::{CollectionRecord, MembershipRecord, Register, SyncSnapshot};

fn item(id: &str) -> FavoriteItem {
    FavoriteItem {
        source: "prntsc".into(),
        id: id.into(),
        source_page_url: format!("https://prnt.sc/{id}"),
        added_at: 42,
    }
}
fn editor(store: &FavoriteStore, request_id: [u8; 16]) -> CollectionEditorRequest {
    let item = &store.library().items[0];
    CollectionEditorRequest {
        request_id,
        frame: SavedFrameRef {
            source: item.item.source.clone(),
            id: item.item.id.clone(),
            expected_save_operation_ids: item.save_operation_ids.clone(),
        },
        create_collections: vec![],
        add_to_collection_ids: vec![],
        remove_membership_operation_ids: vec![],
    }
}
#[test]
fn editor_is_atomic_retriable_and_preserves_the_library_and_undo() -> Result<(), AppError> {
    let dir = test_directory("collections-editor");
    let store = FavoriteStore::new(&dir)?;
    store.save_frame(item("abc123"), None)?;
    let original = store.sync_state();
    let mut request = editor(&store, [10; 16]);
    request.create_collections = vec![
        NewCollection {
            collection_id: [1; 16],
            name: " Screenshots ".into(),
        },
        NewCollection {
            collection_id: [2; 16],
            name: "Weird ones".into(),
        },
    ];
    request.add_to_collection_ids = vec![[1; 16], [9; 16]];
    assert!(store.commit_editor(request.clone()).is_err());
    assert_eq!(store.sync_state(), original);
    request.add_to_collection_ids = vec![[1; 16], [2; 16]];
    store.commit_editor(request.clone())?;
    assert_eq!(store.library().memberships.len(), 2);
    assert_eq!(store.library().items[0].item.added_at, 42);
    let accepted = store.sync_state();
    store.commit_editor(request.clone())?;
    assert_eq!(store.sync_state(), accepted);
    store.rename_collection([1; 16], "Renamed")?;
    let mut detach = editor(&store, [11; 16]);
    detach.remove_membership_operation_ids = store
        .library()
        .memberships
        .iter()
        .filter(|m| m.collection_id == [1; 16])
        .map(|m| m.operation_id)
        .collect();
    store.commit_editor(detach)?;
    store.commit_editor(request)?;
    assert_eq!(store.library().memberships.len(), 1);
    assert_eq!(store.library().collections[0].name, "Renamed");
    // Removal and retry refer to the observed save, never another operation with the same image key.
    let mut remove = RemoveSavedRequest {
        request_id: [12; 16],
        frames: vec![editor(&store, [0; 16]).frame],
    };
    let removed = store.remove_saved(remove.clone())?;
    assert!(store.library().items.is_empty());
    assert_eq!(store.remove_saved(remove.clone())?.undo, removed.undo);
    store.save_frame(item("abc123"), None)?;
    assert!(store.library().memberships.is_empty());
    let mut stale = editor(&store, [13; 16]);
    stale.frame = remove.frames[0].clone();
    stale.create_collections.push(NewCollection {
        collection_id: [3; 16],
        name: "Stale".into(),
    });
    assert_eq!(
        store.commit_editor(stale).err().map(|e| e.kind),
        Some(crate::error::ErrorKind::StaleSavedFrame)
    );
    let fresh = store.sync_state();
    store.remove_saved(remove.clone())?;
    assert_eq!(store.sync_state(), fresh);
    store.delete_collection([1; 16])?;
    store.restore_saved(&removed.undo)?;
    assert_eq!(store.library().items.len(), 1);
    assert_eq!(store.library().memberships.len(), 1);
    let restored = store.sync_state();
    store.restore_saved(&removed.undo)?;
    assert_eq!(store.sync_state(), restored);
    remove.request_id = [14; 16];
    remove.frames = vec![editor(&store, [0; 16]).frame];
    store.remove_saved(remove)?;
    assert_eq!(store.library().collections.len(), 1);
    assert!(store.library().items.is_empty());
    assert_eq!(FavoriteStore::new(&dir)?.sync_state(), store.sync_state());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn failed_write_leaves_no_partial_collections_and_move_keeps_other_assignments(
) -> Result<(), AppError> {
    let dir = test_directory("collections-write");
    let store = FavoriteStore::new(&dir)?;
    store.save_frame(item("abc123"), None)?;
    let mut request = editor(&store, [5; 16]);
    request.create_collections = (1..=3)
        .map(|id| NewCollection {
            collection_id: [id; 16],
            name: format!("Collection {id}"),
        })
        .collect();
    request.add_to_collection_ids = vec![[1; 16], [2; 16]];
    let before = store.sync_state();
    fs::create_dir(dir.join("favorites-v4.json.tmp")).map_err(AppError::persistence)?;
    assert!(store.commit_editor(request.clone()).is_err());
    assert_eq!(store.sync_state(), before);
    fs::remove_dir(dir.join("favorites-v4.json.tmp")).map_err(AppError::persistence)?;
    store.commit_editor(request)?;
    let mut movement = editor(&store, [6; 16]);
    movement.add_to_collection_ids = vec![[3; 16]];
    movement.remove_membership_operation_ids = store
        .library()
        .memberships
        .iter()
        .filter(|m| m.collection_id == [1; 16])
        .map(|m| m.operation_id)
        .collect();
    store.commit_editor(movement)?;
    assert_eq!(store.library().memberships.len(), 2);
    assert!(store
        .library()
        .memberships
        .iter()
        .all(|m| m.collection_id != [1; 16]));
    store.delete_collection([3; 16])?;
    assert_eq!(store.library().items.len(), 1);
    assert_eq!(store.library().memberships.len(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn canonical_migration_survives_rename_delete_detach_receipt_and_old_journal(
) -> Result<(), AppError> {
    let dir = test_directory("collections-migration");
    fs::create_dir_all(&dir).map_err(AppError::persistence)?;
    let record = snapshot::FavoriteRecord {
        operation_id: [7; 16],
        added_at: 42,
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
    };
    fs::write(
        dir.join("favorites-v3.json"),
        serde_json::to_vec(
            &serde_json::json!({"version":3,"favorites":[record],"removed":vec![[8u8;16]]}),
        )
        .map_err(AppError::persistence)?,
    )
    .map_err(AppError::persistence)?;
    let store = FavoriteStore::new(&dir)?;
    let converted = store.sync_state();
    assert_eq!(converted.favorites[0], record);
    assert_eq!(converted.favorites_removed, vec![[8; 16]]);
    assert_eq!(
        hex::encode(converted.collections[0].collection_id),
        "1cd8cf2843ed1f6ec1cdc237d8a9ae7f"
    );
    let id = converted.collections[0].collection_id;
    assert_eq!(converted.collections[0].name.clock, 0);
    store.rename_collection(id, "Custom")?;
    store.merge_sync_state(converted.clone())?;
    assert_eq!(store.library().collections[0].name, "Custom");
    let mut detach = editor(&store, [4; 16]);
    detach.remove_membership_operation_ids = store
        .library()
        .memberships
        .iter()
        .map(|m| m.operation_id)
        .collect();
    store.commit_editor(detach)?;
    store.merge_sync_state(converted.clone())?;
    assert!(store.library().memberships.is_empty());
    store.delete_collection(id)?;
    store.merge_sync_state(converted)?;
    assert!(store.library().collections.is_empty());
    assert!(FavoriteStore::new(&dir)?.library().collections.is_empty());
    fs::remove_file(dir.join("favorites-v4.json")).map_err(AppError::persistence)?;
    assert!(FavoriteStore::new(&dir).is_err());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn collection_merge_converges_and_orphan_relations_remain_inactive() -> Result<(), AppError> {
    let a = SyncSnapshot {
        collections: vec![CollectionRecord {
            collection_id: [1; 16],
            name: Register {
                clock: 1,
                operation_id: [2; 16],
                value: "A".into(),
            },
        }],
        memberships: vec![MembershipRecord {
            operation_id: [3; 16],
            collection_id: [1; 16],
            favorite_operation_id: [4; 16],
        }],
        ..SyncSnapshot::default()
    };
    let b = SyncSnapshot {
        collections: vec![CollectionRecord {
            collection_id: [1; 16],
            name: Register {
                clock: 2,
                operation_id: [5; 16],
                value: "B".into(),
            },
        }],
        ..SyncSnapshot::default()
    };
    let c = SyncSnapshot {
        collections_removed: vec![[1; 16]],
        memberships_removed: vec![[3; 16]],
        ..SyncSnapshot::default()
    };
    let merge = |a: &SyncSnapshot, b: &SyncSnapshot| {
        snapshot::merge_snapshots(a, b).map_err(AppError::persistence)
    };
    assert_eq!(merge(&a, &b)?, merge(&b, &a)?);
    assert_eq!(merge(&merge(&a, &b)?, &c)?, merge(&a, &merge(&b, &c)?)?);
    assert_eq!(merge(&a, &a)?, a);
    let dir = test_directory("collections-orphan");
    let store = FavoriteStore::new(&dir)?;
    store.replace_sync_state(FavoriteSyncState::from_snapshot(&a))?;
    assert!(store.library().memberships.is_empty());
    assert!(store.library().items.is_empty());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn editor_observed_remove_survives_sync_and_unknown_adds_are_not_removed() -> Result<(), AppError> {
    let dir = test_directory("collections-observed-ops");
    let state = PersistentState::new(&dir)?;
    let store = &state.favorites;
    store.save_frame(item("abc123"), None)?;
    let mut setup = editor(store, [1; 16]);
    setup.create_collections = vec![NewCollection {
        collection_id: [2; 16],
        name: "One".into(),
    }];
    setup.add_to_collection_ids = vec![[2; 16]];
    store.commit_editor(setup)?;
    let mut draft = editor(store, [3; 16]);
    let observed = store.library().memberships[0].operation_id;
    draft.remove_membership_operation_ids = vec![observed];
    let later = MembershipRecord {
        operation_id: [4; 16],
        collection_id: [2; 16],
        favorite_operation_id: draft.frame.expected_save_operation_ids[0],
    };
    state.merge(&SyncSnapshot {
        memberships: vec![later],
        memberships_removed: vec![observed],
        ..SyncSnapshot::default()
    })?;
    state.read(|| store.commit_editor(draft.clone()))?;
    assert_eq!(store.library().memberships.len(), 1);
    assert_eq!(store.library().memberships[0].operation_id, [4; 16]);
    let mut previous_edit = editor(store, [5; 16]);
    // A second save of the same frame invalidates its exact save identity; another frame does not.
    store.save_frame(item("def456"), None)?;
    state.read(|| store.commit_editor(previous_edit.clone()))?;
    previous_edit.request_id = [6; 16];
    let mut additional = store
        .sync_state()
        .favorites
        .iter()
        .find(|x| x.source == "prntsc" && x.id == "abc123")
        .ok_or_else(|| AppError::invalid_input("abc123 should exist"))?
        .clone();
    additional.operation_id = [7; 16];
    state.merge(&SyncSnapshot {
        favorites: vec![additional],
        ..SyncSnapshot::default()
    })?;
    assert_eq!(
        state
            .read(|| store.commit_editor(previous_edit))
            .err()
            .map(|e| e.kind),
        Some(crate::error::ErrorKind::StaleSavedFrame)
    );
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn old_transaction_recovery_migrates_favorite_effects_after_v4_already_exists(
) -> Result<(), AppError> {
    let dir = test_directory("collections-old-journal");
    let state = PersistentState::new(&dir)?;
    drop(state);
    let record = snapshot::FavoriteRecord {
        operation_id: [42; 16],
        added_at: 123,
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
    };
    let mut effects = serde_json::to_value(SyncSnapshot {
        favorites: vec![record.clone()],
        ..SyncSnapshot::default()
    })
    .map_err(AppError::persistence)?;
    let fields = effects
        .as_object_mut()
        .ok_or_else(|| AppError::invalid_input("Fixture must be an object"))?;
    for name in [
        "collections",
        "collections_removed",
        "memberships",
        "memberships_removed",
    ] {
        fields.remove(name);
    }
    let journal = serde_json::json!({"version":1,"id":vec![1u8;16],"effects":effects,"close_legacy_import":false});
    fs::write(
        dir.join("state-transaction.json"),
        serde_json::to_vec(&journal).map_err(AppError::persistence)?,
    )
    .map_err(AppError::persistence)?;
    let recovered = PersistentState::new(&dir)?;
    assert_eq!(recovered.favorites.sync_state().favorites, vec![record]);
    assert_eq!(
        recovered.favorites.library().collections[0].name,
        "Ulubione"
    );
    assert_eq!(
        recovered.favorites.library().memberships[0].favorite_operation_id,
        [42; 16]
    );
    let first = recovered.favorites.sync_state();
    drop(recovered);
    assert_eq!(PersistentState::new(&dir)?.favorites.sync_state(), first);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
