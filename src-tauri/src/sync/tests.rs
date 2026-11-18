#![allow(
    clippy::too_many_lines,
    clippy::unused_async_trait_impl,
    reason = "End-to-end scenarios keep all assertions together"
)]
//! End-to-end tests against the real Sync server binary (`RF_SYNC_SERVER_BIN`).
use super::{vault::Journal, *};
use crate::{
    persistence::PersistentState,
    secure_storage::{SecretStore, StorageError},
    snapshot, sync_code, sync_membership_crypto as crypto,
    sync_protocol::{Mutation, Request},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Clone, Default)]
pub(super) struct MemorySecret {
    value: Arc<Mutex<Option<Vec<u8>>>>,
    pub(super) fail_store: Arc<AtomicBool>,
}

impl SecretStore for MemorySecret {
    async fn store(&self, bytes: Zeroizing<Vec<u8>>) -> Result<(), StorageError> {
        if self.fail_store.load(Ordering::Relaxed) {
            return Err(StorageError::Unavailable);
        }
        *self
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes.to_vec());
        Ok(())
    }
    async fn load(&self) -> Result<Zeroizing<Vec<u8>>, StorageError> {
        self.value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .map(Zeroizing::new)
            .ok_or(StorageError::Missing)
    }
    async fn delete(&self) -> Result<(), StorageError> {
        *self
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

pub(super) struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) async fn start(root: &Path) -> Result<(Server, String), Box<dyn std::error::Error>> {
    fs::create_dir_all(root)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    drop(listener);
    let server = {
        // A child holds duplicates of open descriptors until it execs; keep that window out of
        // another test's profile-lock open.
        let _spawning = crate::child_spawn_guard();
        Server(
            Command::new(std::env::var("RF_SYNC_SERVER_BIN")?)
                .env("RF_SYNC_BIND", address.to_string())
                .env("RF_SYNC_DB", root.join("sync.db"))
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()?,
        )
    };
    let url = format!("http://{address}");
    // Parallel CI tests can delay a healthy server's startup; allow up to ten seconds.
    for _ in 0..200 {
        if reqwest::get(format!("{url}/health"))
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            return Ok((server, url));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("server not ready".into())
}

pub(super) fn directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "random-frame-sync-{label}-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ))
}

pub(super) fn device(
    path: &Path,
    url: &str,
    secret: MemorySecret,
) -> Result<SyncEngine<MemorySecret>, SyncError> {
    let state = PersistentState::new(path).map_err(|_| SyncError::Persistence)?;
    Ok(SyncEngine::new(
        path,
        Arc::new(state),
        secret,
        Some(url),
        None,
    ))
}

fn new_device(root: &Path, name: &str, url: &str) -> Result<SyncEngine<MemorySecret>, SyncError> {
    device(&root.join(name), url, MemorySecret::default())
}

fn history_item(id: &str) -> crate::persistence::HistoryItem {
    crate::persistence::HistoryItem {
        source: "prntsc".to_owned(),
        id: id.to_owned(),
        source_page_url: format!("https://prnt.sc/{id}"),
        viewed_at: 42,
    }
}

fn seed_library(a: &SyncEngine<MemorySecret>) -> TestResult {
    let mut s = snapshot::SyncSnapshot::default();
    s.favorites.push(snapshot::FavoriteRecord {
        operation_id: [10; 16],
        added_at: 42,
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
    });
    for id in [20, 21] {
        s.collections.push(snapshot::CollectionRecord {
            collection_id: [id; 16],
            name: snapshot::Register {
                clock: 1,
                operation_id: [id; 16],
                value: format!("Collection {id}"),
            },
        });
        s.memberships.push(snapshot::MembershipRecord {
            operation_id: [id; 16],
            collection_id: [id; 16],
            favorite_operation_id: [10; 16],
        });
    }
    a.data.merge(&s)?;
    Ok(())
}

fn synced(engine: &SyncEngine<MemorySecret>) -> Result<snapshot::SyncSnapshot, SyncError> {
    Ok(engine
        .data
        .snapshot()
        .map_err(|_| SyncError::Persistence)?
        .0)
}

fn assert_same_library(a: &SyncEngine<MemorySecret>, b: &SyncEngine<MemorySecret>) -> TestResult {
    let (a, b) = (synced(a)?, synced(b)?);
    assert_eq!(a.seen, b.seen, "seen");
    assert_eq!(a.history, b.history, "history");
    assert_eq!(a.favorites, b.favorites, "favorites");
    assert_eq!(a.collections, b.collections, "collections");
    assert_eq!(a.memberships, b.memberships, "memberships");
    assert_eq!(a.history_removed, b.history_removed, "history tombstones");
    Ok(())
}

async fn create(a: &SyncEngine<MemorySecret>) -> Result<String, Box<dyn std::error::Error>> {
    let created = a.create().await?;
    assert!(created.status.paired);
    assert_eq!(
        created.status.control.master_member_id,
        created.status.control.this_member_id
    );
    assert!(created.status.control.code_ready);
    created.code.ok_or_else(|| "no code".into())
}

#[test]
fn a_word_code_has_exactly_24_words_and_is_deterministic_per_seed() -> TestResult {
    let words = sync_code::encode(&[7; 32])?;
    assert_eq!(words.split(' ').count(), 24);
    assert_eq!(*sync_code::decode(&words)?, [7; 32]);
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_create_join_converge_and_leave() -> TestResult {
    let root = directory("converge");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    a.seen.insert(101)?;
    a.history.record(history_item("abc123"))?;
    seed_library(&a)?;
    let code = create(&a).await?;

    let b = new_device(&root, "b", &url)?;
    b.seen.insert(202)?;
    let joined = b.join(&code, JoinMode::Merge).await?;
    assert!(joined.paired);
    assert_ne!(
        joined.control.this_member_id,
        joined.control.master_member_id
    );
    assert!(!joined.control.code_ready);
    assert!(b.seen.contains(101));
    assert!(b.seen.contains(202));
    assert_eq!(joined.devices.len(), 2);

    a.sync_now().await?;
    assert!(a.seen.contains(202));
    assert_same_library(&a, &b)?;

    b.seen.insert(303)?;
    b.sync_now().await?;
    a.sync_now().await?;
    assert!(a.seen.contains(303));

    assert_eq!(a.show_code().await?, code);
    assert_eq!(b.show_code().await.err(), Some(SyncError::MasterRequired));
    assert_eq!(b.new_code().await.err(), Some(SyncError::MasterRequired));
    assert_eq!(
        b.dissolve_group().await.err(),
        Some(SyncError::MasterRequired)
    );
    assert_eq!(a.leave().await.err(), Some(SyncError::MasterCannotLeave));

    let left = b.leave().await?;
    assert_eq!(left.control.membership_state.as_deref(), Some("left"));
    assert!(b.seen.contains(303), "leaving keeps local data");
    let status = a.status().await?;
    assert_eq!(
        status
            .devices
            .iter()
            .filter(|d| d.status.as_deref() == Some("active"))
            .count(),
        1
    );

    let ended = a.dissolve_group().await?;
    assert_eq!(ended.control.group_state.as_deref(), Some("closed"));
    assert!(a.seen.contains(303));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_one_code_serves_several_devices_until_it_is_replaced() -> TestResult {
    let root = directory("code-reuse");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    for name in ["b", "c"] {
        let device = new_device(&root, name, &url)?;
        assert!(device.join(&code, JoinMode::Merge).await?.paired);
    }
    assert_eq!(a.status().await?.devices.len(), 3);

    let replaced = a.new_code().await?;
    assert_ne!(replaced, code);
    assert_eq!(a.show_code().await?, replaced);
    let late = new_device(&root, "late", &url)?;
    assert_eq!(
        late.join(&code, JoinMode::Merge).await.err(),
        Some(SyncError::CodeRejected)
    );
    assert!(!late.status().await?.paired);
    assert!(late.join(&replaced, JoinMode::Merge).await?.paired);
    assert_eq!(a.status().await?.devices.len(), 4);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_removing_a_device_rotates_the_key_and_the_code() -> TestResult {
    let root = directory("removal");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    let c = new_device(&root, "c", &url)?;
    let b_status = b.join(&code, JoinMode::Merge).await?;
    c.join(&code, JoinMode::Merge).await?;
    c.seen.insert(303)?;

    let removed = b_status.control.this_member_id.ok_or("no member")?;
    let after = a.remove_device(&removed).await?;
    assert_eq!(after.control.key_epoch, Some(2));
    assert!(after.control.code_ready, "a fresh code exists right away");
    let fresh = a.show_code().await?;
    assert_ne!(fresh, code);

    assert_eq!(b.sync_now().await.err(), Some(SyncError::Revoked));
    assert!(!b.status().await?.paired);
    let outsider = new_device(&root, "outsider", &url)?;
    assert_eq!(
        outsider.join(&code, JoinMode::Merge).await.err(),
        Some(SyncError::CodeRejected)
    );

    // C missed the rotation and opens the new key on its own; its unsent change survives.
    let status = c.startup_sync().await?;
    assert_eq!(status.control.key_epoch, Some(2));
    a.sync_now().await?;
    assert!(a.seen.contains(303));
    assert!(outsider.join(&fresh, JoinMode::Merge).await?.paired);

    // The removed device can start over with the new code.
    let again = b.join(&fresh, JoinMode::Merge).await?;
    assert!(again.paired);
    assert_ne!(again.control.this_member_id, Some(removed));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_restore_replaces_local_state_and_merge_keeps_it() -> TestResult {
    let root = directory("modes");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    a.seen.insert(1)?;
    seed_library(&a)?;
    let code = create(&a).await?;

    let restoring = new_device(&root, "restoring", &url)?;
    restoring.history.record(history_item("zzz999"))?;
    restoring.seen.insert(2)?;
    let summary = restoring.local_summary()?;
    assert!(summary.meaningful);
    restoring.join(&code, JoinMode::Restore).await?;
    assert!(restoring.seen.contains(1));
    assert_eq!(synced(&restoring)?.history, vec![]);
    assert_eq!(synced(&restoring)?.collections.len(), 2);

    let merging = new_device(&root, "merging", &url)?;
    merging.history.record(history_item("zzz999"))?;
    merging.join(&code, JoinMode::Merge).await?;
    assert_eq!(synced(&merging)?.history.len(), 1);
    assert_eq!(synced(&merging)?.collections.len(), 2);
    a.sync_now().await?;
    assert_eq!(synced(&a)?.history.len(), 1);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_bad_codes_are_told_apart() -> TestResult {
    let root = directory("bad-codes");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;

    assert_eq!(
        b.join("", JoinMode::Merge).await.err(),
        Some(SyncError::CodeLength)
    );
    let short = code.split(' ').take(23).collect::<Vec<_>>().join(" ");
    assert_eq!(
        b.join(&short, JoinMode::Merge).await.err(),
        Some(SyncError::CodeLength)
    );
    let unknown = format!(
        "notaword {}",
        code.split(' ').skip(1).collect::<Vec<_>>().join(" ")
    );
    assert_eq!(
        b.join(&unknown, JoinMode::Merge).await.err(),
        Some(SyncError::CodeWord(0))
    );
    let stranger = sync_code::encode(&crypto::random_secret())?;
    assert_eq!(
        b.join(&stranger, JoinMode::Merge).await.err(),
        Some(SyncError::CodeRejected)
    );
    assert!(!b.status().await?.paired);
    assert!(b.journal()?.is_none());

    let shouted = format!("  {}  ", code.to_uppercase().replace(' ', "\n"));
    assert!(b.join(&shouted, JoinMode::Merge).await?.paired);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises durable requests after lost responses"]
async fn real_server_join_survives_a_lost_response_and_a_replaced_code() -> TestResult {
    let root = directory("lost-join");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let secret = MemorySecret::default();
    let b = device(&root.join("b"), &url, secret.clone())?;
    let seed = sync_code::decode(&code)?;

    // The request reaches the server, but its response never reaches the device.
    let entry = b.prepare_join(&seed, JoinMode::Merge).await?;
    let bytes = b.request_bytes(&entry)?;
    let vault = b.vault().await?;
    let pending = vault.pending.as_ref().ok_or("no pending credentials")?;
    b.send_join(pending, &bytes).await?;

    // Meanwhile the administrator replaces the code, so the original secret no longer works.
    a.new_code().await?;
    assert!(b.journal()?.is_some());

    drop(b);
    let b = device(&root.join("b"), &url, secret)?;
    let status = b.startup_sync().await?;
    assert!(status.paired);
    assert!(b.journal()?.is_none());
    assert_eq!(a.status().await?.devices.len(), 2);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises durable requests after lost responses"]
async fn real_server_a_rejected_join_leaves_nothing_behind() -> TestResult {
    let root = directory("rejected-join");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    let seed = sync_code::decode(&code)?;
    let entry = b.prepare_join(&seed, JoinMode::Merge).await?;
    a.new_code().await?;
    assert_eq!(
        b.commit_journal(&entry).await.err(),
        Some(SyncError::CodeRejected)
    );
    assert!(b.journal()?.is_none());
    assert!(b.vault().await?.pending.is_none());
    assert!(!b.status().await?.paired);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises durable requests after lost responses"]
async fn real_server_unsent_changes_survive_a_restart_and_conflicts_converge() -> TestResult {
    let root = directory("restart");
    let (_server, url) = start(&root).await?;
    let a_secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, a_secret.clone())?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    b.join(&code, JoinMode::Merge).await?;

    a.seen.insert(11)?;
    b.seen.insert(22)?;
    let (left, right) = tokio::join!(a.sync_now(), b.sync_now());
    left?;
    right?;
    a.sync_now().await?;
    b.sync_now().await?;
    assert_same_library(&a, &b)?;
    assert!(a.seen.contains(22) && b.seen.contains(11));

    a.seen.insert(33)?;
    drop(a);
    let a = device(&root.join("a"), &url, a_secret)?;
    assert!(a.status().await?.paired);
    a.startup_sync().await?;
    b.sync_now().await?;
    assert!(b.seen.contains(33));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_a_device_that_was_closed_out_can_start_again() -> TestResult {
    let root = directory("closed");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    b.join(&code, JoinMode::Merge).await?;
    a.dissolve_group().await?;

    assert!(b.sync_now().await.is_err());
    assert_eq!(
        b.status().await?.control.group_state.as_deref(),
        Some("closed")
    );
    let forgotten = b.leave().await?;
    assert!(!forgotten.paired);
    assert_eq!(forgotten.control.group_state, None);
    let again = b.create().await?;
    assert!(again.status.paired);
    assert!(again.code.is_some());
    fs::remove_dir_all(root)?;
    Ok(())
}

fn config(revision: i64, epoch: i64) -> state::SyncLocalConfig {
    state::SyncLocalConfig {
        group_id: "ab".repeat(32),
        member_id: "cd".repeat(16),
        credential_version: 1,
        key_id: "ef".repeat(32),
        epoch,
        last_accepted_revision: revision,
        last_success_at: None,
        terminal: None,
        adoption: None,
        left_locally: false,
    }
}

#[test]
fn config_recovers_from_a_torn_write_and_rejects_regressions() -> TestResult {
    let dir = directory("config");
    fs::create_dir_all(&dir)?;
    let path = dir.join("sync-config.json");
    assert!(state::load_config(&path)?.is_none());

    state::save_config(&path, &config(5, 1))?;
    assert_eq!(
        state::load_config(&path)?.map(|c| c.last_accepted_revision),
        Some(5)
    );

    // A crash after the old config was moved aside and the new one only half written.
    fs::rename(&path, path.with_extension("json.bak"))?;
    fs::write(path.with_extension("json.tmp"), b"{\"groupId\":")?;
    let recovered = state::load_config(&path)?.ok_or("no config")?;
    assert_eq!(recovered.last_accepted_revision, 5);
    assert!(path.exists());

    // A torn very first write has nothing to fall back to: start clean instead of failing.
    let _ = fs::remove_file(path.with_extension("json.bak"));
    let _ = fs::remove_file(&path);
    fs::write(path.with_extension("json.tmp"), b"{\"groupId\":")?;
    assert!(state::load_config(&path)?.is_none());
    assert!(!path.with_extension("json.tmp").exists());
    state::save_config(&path, &config(5, 1))?;
    fs::rename(&path, path.with_extension("json.bak"))?;
    fs::write(path.with_extension("json.tmp"), b"{\"groupId\":")?;
    state::load_config(&path)?;

    // A complete newer config is promoted.
    fs::rename(&path, path.with_extension("json.bak"))?;
    fs::write(
        path.with_extension("json.tmp"),
        serde_json::to_vec(&config(6, 2))?,
    )?;
    assert_eq!(
        state::load_config(&path)?.map(|c| (c.last_accepted_revision, c.epoch)),
        Some((6, 2))
    );

    // An older revision, or another group, never replaces the committed one.
    fs::rename(&path, path.with_extension("json.bak"))?;
    fs::write(
        path.with_extension("json.tmp"),
        serde_json::to_vec(&config(3, 2))?,
    )?;
    assert_eq!(
        state::load_config(&path).err(),
        Some(SyncError::CorruptLocalState)
    );
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[test]
fn damaged_or_inconsistent_config_is_corrupt_not_unpaired() -> TestResult {
    let dir = directory("config-bad");
    fs::create_dir_all(&dir)?;
    let path = dir.join("sync-config.json");
    for bad in [
        b"not json".to_vec(),
        serde_json::to_vec(&config(0, 1))?,
        serde_json::to_vec(&config(1, 0))?,
        serde_json::to_vec(&{
            let mut c = config(1, 1);
            c.terminal = Some("unknown".into());
            c
        })?,
        serde_json::to_vec(&{
            let mut c = config(1, 1);
            c.group_id = "short".into();
            c
        })?,
    ] {
        fs::write(&path, bad)?;
        assert_eq!(
            state::load_config(&path).err(),
            Some(SyncError::CorruptLocalState)
        );
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[tokio::test]
async fn the_journal_holds_one_exact_request_and_detects_tampering() -> TestResult {
    let dir = directory("journal");
    let engine = device(&dir, "http://127.0.0.1:9", MemorySecret::default())?;
    let entry = Journal {
        group_id: "ab".repeat(32),
        request: Request {
            operation_id: crypto::random_id(),
            expected_revision: 1,
            expected_epoch: 1,
            mutation: Mutation::Leave {
                credential_version: 1,
            },
        },
        request_hash: String::new(),
        route: "leave".into(),
        promote: false,
        restore: false,
        join_mode: None,
        generation: None,
        self_record: None,
    };
    let prepared = engine.prepare(entry.clone(), &[])?;
    assert!(engine.request_bytes(&prepared).is_ok());
    assert_eq!(
        engine.prepare(entry, &[]).err(),
        Some(SyncError::PendingOperation)
    );
    let on_disk = engine.journal()?.ok_or("journal missing")?;
    assert_eq!(on_disk.request_hash, prepared.request_hash);

    let file = dir.join(format!(
        "sync-journal-{}.bin",
        prepared.request.operation_id
    ));
    let mut bytes = fs::read(&file)?;
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&file, bytes)?;
    assert_eq!(
        engine.request_bytes(&prepared).err(),
        Some(SyncError::CorruptLocalState)
    );
    engine.clear_journal(&prepared)?;
    assert!(engine.journal()?.is_none());
    assert!(!file.exists());
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[tokio::test]
async fn nothing_works_without_a_server_and_nothing_is_left_behind() -> TestResult {
    let dir = directory("offline");
    let engine = device(&dir, "http://127.0.0.1:9", MemorySecret::default())?;
    assert!(!engine.status().await?.paired);
    let created = engine.create().await.err();
    assert!(matches!(
        created,
        Some(SyncError::Offline | SyncError::Timeout)
    ));
    // The attempt is durable and resumes, instead of inventing a second group.
    assert!(engine.journal()?.is_some());
    assert_eq!(
        engine.join("", JoinMode::Merge).await.err(),
        Some(SyncError::PendingOperation)
    );
    let fresh = device(
        &directory("offline-2"),
        "http://127.0.0.1:9",
        MemorySecret::default(),
    )?;
    assert_eq!(
        fresh.join("", JoinMode::Merge).await.err(),
        Some(SyncError::CodeLength)
    );
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[test]
fn a_server_revision_below_the_floor_is_a_rollback() {
    let floor = config(5, 1);
    assert!(cas::check_rollback(&floor, 5).is_ok());
    assert!(cas::check_rollback(&floor, 9).is_ok());
    assert_eq!(
        cas::check_rollback(&floor, 4),
        Err(SyncError::ServerRollbackDetected {
            local_revision: 5,
            remote_revision: 4
        })
    );
}

#[tokio::test]
async fn a_snapshot_that_can_never_be_accepted_is_dropped_not_replayed() -> TestResult {
    let dir = directory("hopeless");
    let engine = device(&dir, "http://127.0.0.1:9", MemorySecret::default())?;
    let entry = engine.prepare(
        Journal {
            group_id: "ab".repeat(32),
            request: Request {
                operation_id: crypto::random_id(),
                expected_revision: 1,
                expected_epoch: 1,
                mutation: Mutation::Snapshot {
                    credential_version: 1,
                    key_id: "cd".repeat(32),
                },
            },
            request_hash: String::new(),
            route: "snapshot".into(),
            promote: false,
            restore: false,
            join_mode: None,
            generation: None,
            self_record: None,
        },
        b"payload",
    )?;
    let file = dir.join(format!("sync-journal-{}.bin", entry.request.operation_id));
    fs::write(&file, b"damaged")?;
    assert_eq!(
        engine.commit_journal(&entry).await.err(),
        Some(SyncError::CorruptLocalState)
    );
    assert!(engine.journal()?.is_none());
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[tokio::test]
async fn damaged_local_state_can_be_left_and_started_over() -> TestResult {
    let dir = directory("damaged");
    let engine = device(&dir, "http://127.0.0.1:9", MemorySecret::default())?;
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("sync-config.json"), b"{\"syncId\":\"old\"}")?;
    assert_eq!(
        engine.status().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    let status = engine.leave().await?;
    assert!(!status.paired);
    assert!(!dir.join("sync-config.json").exists());
    assert!(!engine.status().await?.paired);
    fs::remove_dir_all(dir)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_a_retried_join_uses_the_mode_chosen_last() -> TestResult {
    let root = directory("mode-switch");
    let (_server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    a.seen.insert(1)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    b.seen.insert(2)?;
    let seed = sync_code::decode(&code)?;
    b.prepare_join(&seed, JoinMode::Restore).await?;
    b.join(&code, JoinMode::Merge).await?;
    assert!(b.seen.contains(1) && b.seen.contains(2));
    a.sync_now().await?;
    assert!(a.seen.contains(2), "Merge published the local change");
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_an_unreachable_server_leaves_status_and_leave_usable() -> TestResult {
    let root = directory("unreachable");
    let (server, url) = start(&root).await?;
    let a = new_device(&root, "a", &url)?;
    let code = create(&a).await?;
    let b = new_device(&root, "b", &url)?;
    b.join(&code, JoinMode::Merge).await?;
    drop(server);

    let status = b.status().await?;
    assert!(status.paired);
    assert_eq!(status.last_error_category.as_deref(), Some("offline"));
    assert!(status.control.this_member_id.is_some());
    let left = b.leave().await?;
    assert_eq!(
        left.control.membership_state.as_deref(),
        Some("left_locally")
    );
    fs::remove_dir_all(root)?;
    Ok(())
}
