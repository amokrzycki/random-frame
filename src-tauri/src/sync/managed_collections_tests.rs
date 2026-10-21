#![allow(
    clippy::too_many_lines,
    reason = "End-to-end transitions keep all assertions together"
)]
use super::{
    admin::{Credentials, Journal},
    membership_tests::start,
    tests::{assert_sync_data_equal, device, directory, MemorySecret},
    *,
};
use crate::{
    persistence::{CollectionEditorRequest, SavedFrameRef},
    snapshot,
    sync_membership_crypto::{self as crypto, AdminRecoverySecret},
    sync_protocol::{Mutation, Recipient, RecoveryRegistration, Request},
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

// Produce the exact pre-collections HEAD payload, without pretending v3 was already accepted.
async fn create_v2(a: &SyncEngine<MemorySecret>) -> Result<String, Box<dyn std::error::Error>> {
    let group = hex::encode(crypto::random_secret());
    let mut c = Credentials::new(group.clone(), crypto::random_id());
    let admin = AdminRecoverySecret::generate();
    c.admin_secret = Some(*admin.0);
    c.recovery_generation = 1;
    let member = c.pairing(hex::encode(a.data.identity.id()))?;
    let (auth, _, public_key) = admin.derive_credentials(&group)?;
    let recovery = RecoveryRegistration {
        generation: 1,
        token_verifier: crypto::verifier(&auth),
        public_key,
    };
    let recipients = [
        Recipient {
            kind: "member".into(),
            id: c.member_id.clone(),
            version: 1,
            public_key: member.wrapping_public_key.clone(),
        },
        Recipient {
            kind: "admin_recovery".into(),
            id: c.member_id.clone(),
            version: 1,
            public_key: recovery.public_key.clone(),
        },
    ];
    let root = c.root()?;
    let packages = recipients
        .iter()
        .map(|r| crypto::seal_root(&group, 1, r, &root))
        .collect::<Result<Vec<_>, _>>()?;
    let payload = root.derive().encrypt_managed(
        &group,
        1,
        &snapshot::v2::serialize_snapshot(&a.data.snapshot()?.0)?,
    )?;
    let entry = Journal {
        version: 2,
        group_id: group.clone(),
        request: Request {
            operation_id: crypto::random_id(),
            expected_revision: 0,
            expected_epoch: 0,
            mutation: Mutation::Create {
                member,
                recovery,
                key_id: root.derive().sync_id().into(),
                packages,
            },
        },
        request_hash: String::new(),
        route: "create".into(),
        promote: true,
        restore: false,
        legacy_source_id: None,
        join_mode: None,
        confirmed: true,
        generation: None,
        self_record: None,
        snapshot_schema: Some(2),
        source_schema: 2,
    };
    let mut vault = a.vault().await?;
    vault.pending = Some(c);
    a.save_vault(&vault).await?;
    let entry = a.prepare(entry, &payload)?;
    let mut old_manifest = serde_json::to_value(&entry)?;
    old_manifest
        .as_object_mut()
        .ok_or("invalid journal")?
        .remove("snapshotSchema");
    old_manifest
        .as_object_mut()
        .ok_or("invalid journal")?
        .remove("sourceSchema");
    crate::persistence::save_json(&a.admin_path(), &Some(old_manifest))?;
    let entry = a.journal()?.ok_or("no legacy journal")?;
    a.commit_journal(&entry).await?;
    assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 2);
    Ok(admin.code(&group, 1).to_string())
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

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; HEAD v2 upgrade gates and schema-aware Restore/Merge"]
async fn real_server_managed_v2_upgrade_consent_and_migration() -> TestResult {
    for mode in [JoinMode::Restore, JoinMode::Merge] {
        let root = directory("managed-v2-consent");
        let (_server, url) = start(&root).await?;
        let a = device(&root.join("a"), &url, MemorySecret::default())?;
        // Both installations carry the same old save, hence deterministic collection/membership IDs.
        let mut old = snapshot::SyncSnapshot::default();
        old.favorites.push(snapshot::FavoriteRecord {
            operation_id: [10; 16],
            added_at: 42,
            source: "prntsc".into(),
            id: "abc123".into(),
            source_page_url: "https://prnt.sc/abc123".into(),
        });
        a.data.merge(&old)?;
        let admin = create_v2(&a).await?;
        let b_secret = MemorySecret::default();
        let b = device(&root.join("b"), &url, b_secret.clone())?;
        let mut migrated = old;
        snapshot::migrate_legacy_collections(&mut migrated);
        b.data.merge(&migrated)?;
        b.data.favorites.create_collection("Local empty")?;
        let before = b.data.snapshot()?.0;
        let invite = a.create_invitation(&b.pairing_request().await?).await?;
        assert_eq!(
            b.join(&invite, mode).await.err(),
            Some(SyncError::UpgradeRequired)
        );
        assert_eq!(b.data.snapshot()?.0, before);
        assert_eq!(a.sync_now().await.err(), Some(SyncError::UpgradeRequired));
        assert_eq!(
            a.startup_sync().await.err(),
            Some(SyncError::UpgradeRequired)
        );
        let member = b
            .config()?
            .ok_or("no config")?
            .managed
            .ok_or("no member")?
            .member_id;
        assert_eq!(
            a.remove_device(&member).await.err(),
            Some(SyncError::UpgradeRequired)
        );
        let e = device(&root.join("e"), &url, MemorySecret::default())?;
        assert_eq!(
            e.recover_admin(&admin, false).await.err(),
            Some(SyncError::UpgradeRequired)
        );
        assert!(e.journal()?.is_none());
        e.approve_upgrade(Some(&admin)).await?;
        assert!(e.recover_admin(&admin, false).await?.prepared);
        e.cancel_admin_recovery().await?;
        assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 2);
        // Approving another group does not unlock this one. Consent survives restart.
        b.data.approve_sync_upgrade("another-group")?;
        assert_eq!(
            b.startup_sync().await.err(),
            Some(SyncError::UpgradeRequired)
        );
        b.approve_upgrade(Some(&invite)).await?;
        drop(b);
        let b = device(&root.join("b"), &url, b_secret)?;
        b.startup_sync().await?;
        assert!(b
            .data
            .favorites
            .library()
            .collections
            .iter()
            .any(|c| c.name == "Local empty"));
        // Remote v3 is an already completed upgrade; A needs no second approval.
        a.sync_now().await?;
        let legacy = snapshot::hash_id(&[b"rf/collections/legacy-favorites/v1"]);
        a.data.favorites.delete_collection(legacy)?;
        a.sync_now().await?;
        // A later v2 migration of the same save cannot resurrect the deleted seed collection.
        b.data.merge(&migrated)?;
        b.sync_now().await?;
        a.sync_now().await?;
        assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
        assert!(!b
            .data
            .favorites
            .library()
            .collections
            .iter()
            .any(|c| c.collection_id == legacy));
        assert!(b.data.favorites.library().memberships.is_empty());
        fs::remove_dir_all(root)?;
    }
    Ok(())
}

async fn snapshot_request(
    a: &SyncEngine<MemorySecret>,
    schema: u32,
) -> Result<(Journal, Vec<u8>), Box<dyn std::error::Error>> {
    let mut vault = a.vault().await?;
    let c = vault.current.as_mut().ok_or("missing credentials")?;
    let (control, remote) = a.read_managed(c, None).await?;
    let state = a.data.snapshot()?.0;
    let bytes = if schema == 2 {
        snapshot::v2::serialize_snapshot(&state)?
    } else if schema == 3 {
        snapshot::v3::serialize_snapshot(&state)?
    } else {
        snapshot::serialize_snapshot(&state)?
    };
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
            snapshot_schema: Some(schema),
            source_schema: remote.original_schema_version,
        },
        payload,
    ))
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; accepted PUT, journal replay and downgrade after restart"]
async fn real_server_managed_collection_publication_timeout_and_restart() -> TestResult {
    let root = directory("managed-publication-floor");
    let (_server, url) = start(&root).await?;
    let secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, secret.clone())?;
    create_v2(&a).await?;
    seed_library(&a)?;
    let before = a.data.snapshot()?.0;
    let (entry, payload) = snapshot_request(&a, 3).await?;
    let entry = a.prepare(entry, &payload)?;
    // The final send guard also protects a journal prepared before consent was recorded.
    assert_eq!(
        a.commit_journal(&entry).await.err(),
        Some(SyncError::UpgradeRequired)
    );
    a.approve_upgrade(None).await?;
    let exact = a.request_bytes(&entry)?;
    let vault = a.vault().await?;
    let c = vault.current.as_ref().ok_or("no credentials")?;
    a.data
        .begin_publication(&entry.group_id, entry.request.expected_revision, 3)?;
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
    // A stale writer can send opaque v2, but a client that attempted v3 must reject it.
    let mut stale = entry.request.clone();
    stale.operation_id = crypto::random_id();
    stale.expected_revision = accepted.revision;
    let v2 = c.root()?.derive().encrypt_managed(
        &entry.group_id,
        accepted.epoch,
        &snapshot::v2::serialize_snapshot(&before)?,
    )?;
    a.call_v2(
        &entry.group_id,
        "snapshot",
        reqwest::Method::PUT,
        &c.token,
        None,
        Some(crate::sync_protocol::encode(&stale, &v2)?),
    )
    .await?;
    drop(a);
    let a = device(&root.join("a"), &url, secret)?;
    assert_eq!(a.request_bytes(&entry)?, exact);
    let mut vault = a.vault().await?;
    assert_eq!(
        a.read_managed(vault.current.as_mut().ok_or("no credentials")?, None)
            .await
            .err(),
        Some(SyncError::SchemaDowngrade)
    );
    let retried = a.commit_journal(&entry).await?;
    assert_eq!(retried.revision, accepted.revision); // No duplicate operation or revision.
    assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 3);
    assert_eq!(a.data.schema_floor(&entry.group_id)?, 3);
    assert_eq!(
        a.startup_sync().await.err(),
        Some(SyncError::SchemaDowngrade)
    );
    assert_eq!(a.data.snapshot()?.0, before);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; CAS retry observes v3 and drops preserved v2-only local collections"]
async fn real_server_managed_restore_retry_observes_schema_change() -> TestResult {
    let root = directory("managed-restore-cas");
    let (_server, url) = start(&root).await?;
    let a = device(&root.join("a"), &url, MemorySecret::default())?;
    create_v2(&a).await?;
    let b = device(&root.join("b"), &url, MemorySecret::default())?;
    b.data
        .favorites
        .create_collection("Local collection absent from v2")?;
    let invite = a.create_invitation(&b.pairing_request().await?).await?;
    assert_eq!(
        b.join(&invite, JoinMode::Restore).await.err(),
        Some(SyncError::UpgradeRequired)
    );
    b.approve_upgrade(Some(&invite)).await?;
    let (mut stale, _) = snapshot_request(&b, snapshot::CURRENT_SNAPSHOT_SCHEMA).await?;
    let mut vault = b.vault().await?;
    let c = vault.current.as_mut().ok_or("no credentials")?;
    let (_, remote) = b.read_managed(c, None).await?;
    let local = b.data.snapshot()?.0;
    let target = b.data().restore_target(&remote, &local, 1)?;
    let payload = c.root()?.derive().encrypt_managed(
        &c.group_id,
        stale.request.expected_epoch,
        &snapshot::serialize_snapshot(&target)?,
    )?;
    stale.restore = true;
    b.save_vault(&vault).await?;
    let stale = b.prepare(stale, &payload)?;
    // Another device upgrades the remote while B's first Restore request is in flight.
    a.approve_upgrade(None).await?;
    a.sync_now().await?;
    assert_eq!(
        b.commit_journal(&stale).await.err(),
        Some(SyncError::Conflict)
    );
    assert_eq!(b.data.snapshot()?.0, local);
    assert!(b.journal()?.is_none());
    b.startup_sync().await?;
    assert!(b.data.favorites.library().collections.is_empty());
    a.sync_now().await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
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

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; legacy migration cannot bypass collection format consent"]
async fn real_server_managed_legacy_move_keeps_upgrade_separate() -> TestResult {
    use crate::{
        secure_storage::SecretStore, sync_crypto::RootSecret, sync_transport::SyncTransport,
    };
    let root = directory("managed-legacy-v2-upgrade");
    let (_server, url) = start(&root).await?;
    let secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, secret.clone())?;
    seed_library(&a)?;
    let legacy = RootSecret::generate();
    let keys = legacy.derive();
    let transport = SyncTransport::new(&url)?;
    let envelope =
        keys.encrypt_snapshot(&snapshot::v2::serialize_snapshot(&a.data.snapshot()?.0)?)?;
    let revision = transport
        .create(keys.sync_id(), &keys.client_auth_token(), envelope.clone())
        .await?;
    let mut config = SyncLocalConfig::new(keys.sync_id().into(), revision);
    config.highest_schema_version = 2;
    a.save(&config)?;
    secret.store(legacy).await?;
    let before = a.data.snapshot()?.0;
    assert_eq!(
        a.move_to_managed_sync().await.err(),
        Some(SyncError::UpgradeRequired)
    );
    assert_eq!(a.data.snapshot()?.0, before);
    assert!(a.journal()?.is_none());
    a.approve_upgrade(None).await?;
    let moved = a.move_to_managed_sync().await?;
    assert_ne!(moved.group_id, keys.sync_id());
    assert_eq!(moved.source_legacy_id.as_deref(), Some(keys.sync_id()));
    assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 4);
    assert_eq!(
        transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?,
        (revision, envelope)
    );
    let current = a.data.snapshot()?.0;
    let migrated = snapshot::decode_snapshot(&snapshot::v2::serialize_snapshot(&before)?)?.data;
    let expected = snapshot::merge_snapshots(&before, &migrated)?;
    assert_eq!(current.collections, expected.collections);
    assert_eq!(current.memberships, expected.memberships);
    assert_eq!(current.collections_removed, expected.collections_removed);
    assert_eq!(current.memberships_removed, expected.memberships_removed);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exact v3 replay followed by independent Nearby consent4"]
async fn real_server_exact_v3_replay_requires_new_consent_before_nearby_publication() -> TestResult
{
    let root = directory("nearby-v3-replay");
    let (_server, url) = start(&root).await?;
    let a = device(&root.join("a"), &url, MemorySecret::default())?;
    create_v2(&a).await?;
    let (entry, payload) = snapshot_request(&a, 3).await?;
    crate::persistence::save_json(
        &root.join("a/sync-upgrades.json"),
        &std::collections::BTreeMap::from([(entry.group_id.clone(), 3)]),
    )?;
    let entry = a.prepare(entry, &payload)?;
    let exact = a.request_bytes(&entry)?;
    a.commit_journal(&entry).await?;
    assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 3);
    assert_eq!(
        exact,
        crate::sync_protocol::encode(&entry.request, &payload)?
    );
    a.data
        .record_check(42, crate::persistence::ExplorationOutcome::Viewed)?;
    assert_eq!(a.sync_now().await.err(), Some(SyncError::UpgradeRequired));
    assert!(!a.data.sync_upgrade_approved(&entry.group_id)?);
    a.approve_upgrade(None).await?;
    a.sync_now().await?;
    assert_eq!(a.config()?.ok_or("no config")?.highest_schema_version, 4);
    assert_eq!(a.data.snapshot()?.0.seen.len(), 0);
    let mut vault = a.vault().await?;
    let (_, remote) = a
        .read_managed(vault.current.as_mut().ok_or("no credentials")?, None)
        .await?;
    assert_eq!(remote.original_schema_version, 4);
    assert_eq!(remote.data.exploration.len(), 1);
    assert_eq!(remote.data.seen.len(), 0);
    let b_secret = MemorySecret::default();
    let b = device(&root.join("b"), &url, b_secret.clone())?;
    let invitation = a.create_invitation(&b.pairing_request().await?).await?;
    b.join(&invitation, JoinMode::Restore).await?;
    b.data
        .record_check(43, crate::persistence::ExplorationOutcome::Rejected)?;
    b.sync_now().await?;
    a.sync_now().await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
    let b = device(&root.join("b"), &url, b_secret)?;
    b.startup_sync().await?;
    for data in [&a.data, &b.data] {
        let snapshot = data.snapshot()?.0;
        assert_eq!(snapshot.exploration.len(), 2);
        assert_eq!(snapshot.seen.len(), 0);
        assert_eq!(data.history.snapshot().history.len(), 0);
        assert_eq!(data.activity.viewed_total(), 0);
    }
    fs::remove_dir_all(root)?;
    Ok(())
}
