#![allow(
    clippy::too_many_lines,
    reason = "End-to-end transitions keep all assertions together"
)]
use super::{
    admin::Journal,
    membership_tests::start,
    tests::{assert_sync_data_equal, device, directory, MemorySecret},
    *,
};
use crate::{
    persistence::{CollectionEditorRequest, SavedFrameRef},
    snapshot, sync_membership_crypto as crypto,
    sync_protocol::{Mutation, Request},
};
use std::fs;

type TestResult = Result<(), Box<dyn std::error::Error>>;

pub(super) fn seed_library(a: &SyncEngine<MemorySecret>) -> TestResult {
    let mut s = snapshot::SyncSnapshot::default();
    s.favorites.push(snapshot::FavoriteRecord {
        operation_id: [10; 16],
        added_at: 42,
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
    });
    for id in [20, 21, 22] {
        s.collections.push(snapshot::CollectionRecord {
            collection_id: [id; 16],
            name: snapshot::Register {
                clock: 1,
                operation_id: [id; 16],
                value: format!("Collection {id}"),
            },
        });
    }
    for id in [20, 21] {
        s.memberships.push(snapshot::MembershipRecord {
            operation_id: [id; 16],
            collection_id: [id; 16],
            favorite_operation_id: [10; 16],
        });
    }
    s.collections_removed.push([23; 16]);
    s.memberships_removed.push([24; 16]);
    s.favorites_removed.push([25; 16]);
    a.data.merge(&s)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; actual HTTP/SQLite collection convergence"]
async fn real_server_managed_collections_offline_and_deletions() -> TestResult {
    let root = directory("managed-collections");
    let (_server, url) = start(&root).await?;
    let a = device(&root.join("a"), &url, MemorySecret::default())?;
    seed_library(&a)?;
    let created = a.create_managed().await?;
    let b_secret = MemorySecret::default();
    let b = device(&root.join("b"), &url, b_secret.clone())?;
    // A user-created empty collection makes this a meaningful device, even without saved images.
    b.data.favorites.create_collection("Offline empty")?;
    assert!(b.local_summary()?.meaningful);
    let invite = a.create_invitation(&b.pairing_request().await?).await?;
    b.join(&invite, JoinMode::Merge).await?;
    a.sync_now().await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
    a.data
        .favorites
        .rename_collection([20; 16], "Renamed offline")?;
    b.data.favorites.delete_collection([21; 16])?;
    let item = &b.data.favorites.library().items[0];
    b.data.favorites.commit_editor(CollectionEditorRequest {
        request_id: [40; 16],
        frame: SavedFrameRef {
            source: item.item.source.clone(),
            id: item.item.id.clone(),
            expected_save_operation_ids: item.save_operation_ids.clone(),
        },
        create_collections: vec![],
        add_to_collection_ids: vec![],
        remove_membership_operation_ids: vec![[20; 16]],
    })?;
    a.sync_now().await?;
    b.sync_now().await?;
    a.sync_now().await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
    assert_eq!(a.data.favorites.library().items.len(), 1);
    assert!(a.data.favorites.library().memberships.is_empty());
    assert!(a
        .data
        .favorites
        .library()
        .collections
        .iter()
        .any(|c| c.name == "Offline empty"));
    assert!(a
        .data
        .favorites
        .library()
        .collections
        .iter()
        .any(|c| c.name == "Renamed offline"));
    let expected = b.data.snapshot()?.0;
    drop(b);
    let b = device(&root.join("b"), &url, b_secret)?;
    b.startup_sync().await?;
    assert_sync_data_equal(&b.data.snapshot()?.0, &expected);
    let e = device(&root.join("e"), &url, MemorySecret::default())?;
    e.recover_admin(&created.admin_recovery_code, false).await?;
    e.recover_admin("", true).await?;
    assert_sync_data_equal(&e.data.snapshot()?.0, &expected);
    fs::remove_dir_all(root)?;
    Ok(())
}

async fn snapshot_request(
    a: &SyncEngine<MemorySecret>,
) -> Result<(Journal, Vec<u8>), Box<dyn std::error::Error>> {
    let mut vault = a.vault().await?;
    let c = vault.current.as_mut().ok_or("missing credentials")?;
    let (control, _) = a.read_managed(c, None).await?;
    let bytes = snapshot::serialize_snapshot(&a.data.snapshot()?.0)?;
    let payload = c
        .root()?
        .derive()
        .encrypt_managed(&c.group_id, control.epoch, &bytes)?;
    Ok((
        Journal {
            version: 2,
            group_id: c.group_id.clone(),
            request: Request {
                operation_id: crypto::random_id(),
                expected_revision: control.revision,
                expected_epoch: control.epoch,
                mutation: Mutation::Snapshot {
                    credential_version: control
                        .members
                        .iter()
                        .find(|m| m.member_id == c.member_id)
                        .ok_or("no member")?
                        .credential_version,
                    key_id: control.key_id,
                },
            },
            request_hash: String::new(),
            route: "snapshot".into(),
            promote: false,
            restore: false,
            legacy_source_id: None,
            join_mode: None,
            confirmed: true,
            generation: None,
            self_record: None,
        },
        payload,
    ))
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; accepted PUT and journal replay after restart"]
async fn real_server_managed_collection_publication_timeout_and_restart() -> TestResult {
    let root = directory("managed-publication-replay");
    let (_server, url) = start(&root).await?;
    let secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, secret.clone())?;
    a.create_managed().await?;
    seed_library(&a)?;
    let before = a.data.snapshot()?.0;
    let (entry, payload) = snapshot_request(&a).await?;
    let entry = a.prepare(entry, &payload)?;
    let exact = a.request_bytes(&entry)?;
    let vault = a.vault().await?;
    let c = vault.current.as_ref().ok_or("no credentials")?;
    // The PUT is accepted but its response is lost before the journal is cleared.
    let accepted = a
        .call_v2(
            &entry.group_id,
            "snapshot",
            reqwest::Method::PUT,
            &c.token,
            None,
            Some(exact.clone()),
        )
        .await?;
    let accepted: crate::sync_protocol::OperationResult = serde_json::from_slice(&accepted)?;
    drop(a);
    let a = device(&root.join("a"), &url, secret)?;
    assert_eq!(a.request_bytes(&entry)?, exact);
    let retried = a.commit_journal(&entry).await?;
    assert_eq!(retried.revision, accepted.revision); // No duplicate operation or revision.
    a.startup_sync().await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &before);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; edits after an applied Restore survive journal cleanup failure"]
async fn real_server_managed_restore_replay_keeps_later_local_collections() -> TestResult {
    let root = directory("managed-restore-receipt");
    let (_server, url) = start(&root).await?;
    let a = device(&root.join("a"), &url, MemorySecret::default())?;
    seed_library(&a)?;
    let created = a.create_managed().await?;
    let secret = MemorySecret::default();
    let b = device(&root.join("b"), &url, secret.clone())?;
    b.recover_admin(&created.admin_recovery_code, false).await?;
    let mut entry = b.journal()?.ok_or("no journal")?;
    entry.confirmed = true;
    crate::persistence::save_json(&b.admin_path(), &Some(&entry))?;
    fs::create_dir(b.admin_path().with_extension("json.tmp"))?;
    assert_eq!(
        b.commit_journal(&entry).await.err(),
        Some(SyncError::Persistence)
    );
    fs::remove_dir(b.admin_path().with_extension("json.tmp"))?;
    b.data
        .favorites
        .create_collection("Created after Restore")?;
    let expected = b.data.snapshot()?.0;
    drop(b);
    let b = device(&root.join("b"), &url, secret)?;
    b.commit_journal(&entry).await?;
    assert_eq!(b.data.snapshot()?.0, expected);
    b.sync_now().await?;
    assert!(b
        .data
        .favorites
        .library()
        .collections
        .iter()
        .any(|c| c.name == "Created after Restore"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; HTTP payload limit and damaged encrypted snapshot preserve data"]
async fn real_server_managed_collection_validation_and_size_fail_without_data_loss() -> TestResult {
    let root = directory("managed-collection-errors");
    let (_server, url) = super::membership_tests::start_with_limit(&root, 8192).await?;
    let a = device(&root.join("a"), &url, MemorySecret::default())?;
    seed_library(&a)?;
    a.create_managed().await?;
    let vault = a.vault().await?;
    let c = vault.current.as_ref().ok_or("no credentials")?;
    let original = a
        .call_v2(
            &c.group_id,
            "snapshot",
            reqwest::Method::GET,
            &c.token,
            None,
            None,
        )
        .await?;
    for index in 0..80 {
        a.data
            .favorites
            .create_collection(&format!("{index} {}", "x".repeat(110)))?;
    }
    let before = a.data.snapshot()?.0;
    assert_eq!(a.sync_now().await.err(), Some(SyncError::BodyTooLarge));
    assert_eq!(a.data.snapshot()?.0, before);
    assert_eq!(
        a.call_v2(
            &c.group_id,
            "snapshot",
            reqwest::Method::GET,
            &c.token,
            None,
            None
        )
        .await?,
        original
    );
    // The server cannot validate ciphertext. A damaged blob must fail before merge.
    let (control, original_payload): (crate::sync_protocol::Control, &[u8]) =
        crate::sync_protocol::decode(&original)?;
    let request = Request {
        operation_id: crypto::random_id(),
        expected_revision: control.revision,
        expected_epoch: control.epoch,
        mutation: Mutation::Snapshot {
            credential_version: 1,
            key_id: control.key_id,
        },
    };
    let mut payload = original_payload.to_vec();
    let last = payload.last_mut().ok_or("empty ciphertext")?;
    *last ^= 1;
    a.call_v2(
        &c.group_id,
        "snapshot",
        reqwest::Method::PUT,
        &c.token,
        None,
        Some(crate::sync_protocol::encode(&request, &payload)?),
    )
    .await?;
    assert_eq!(a.sync_now().await.err(), Some(SyncError::BodyTooLarge)); // Pending exact request remains blocked by the limit.
    let entry = a.journal()?.ok_or("no pending request")?;
    // The exact pending request remains retryable; a separate authenticated read validates the remote.
    assert_eq!(
        a.commit_journal(&entry).await.err(),
        Some(SyncError::BodyTooLarge)
    );
    assert_eq!(
        a.read_managed(
            &mut a.vault().await?.current.take().ok_or("no credentials")?,
            None
        )
        .await
        .err(),
        Some(SyncError::InvalidRemoteData)
    );
    assert_eq!(a.data.snapshot()?.0, before);
    fs::remove_dir_all(root)?;
    Ok(())
}
