//! First-join semantics: Restore (remote wins) versus Merge (CRDT union), on the real incident shape.
use super::*;
use crate::{
    persistence::{
        ExplorationOutcome, FavoriteItem, HistoryItem, PersistentState, UserPreferences,
    },
    snapshot::{DeviceMetadata, SyncSnapshot},
};

type TestResult = Result<(), Box<dyn std::error::Error>>;
type Server = Arc<Mutex<ServerState>>;

const REMOTE_HISTORY: u64 = 5752;
const LOCAL_TOMBSTONES: u64 = 1214;
const LOCAL_ITEMS: [&str; 3] = ["900001", "900002", "900003"];

fn lock(server: &Server) -> std::sync::MutexGuard<'_, ServerState> {
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn op_id(index: u64) -> [u8; 16] {
    u128::from(index).to_be_bytes()
}

fn remote_rows() -> Vec<snapshot::SyncRecord> {
    (0..REMOTE_HISTORY)
        .map(|index| {
            let id = (20_000 + index).to_string();
            snapshot::SyncRecord {
                operation_id: op_id(index + 1),
                order_at: index + 1,
                last_view: snapshot::ViewStamp::inferred(index + 1),
                source: "prntsc".into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                id,
            }
        })
        .collect()
}

fn favorite(id: &str) -> FavoriteItem {
    FavoriteItem {
        source: "prntsc".into(),
        id: id.into(),
        source_page_url: format!("https://prnt.sc/{id}"),
        added_at: 5,
    }
}

fn accept(engine: &SyncEngine<MemorySecret>, id: &str, at: u64) -> Result<(), SyncError> {
    engine
        .data
        .accept(
            &HistoryItem {
                source: "prntsc".into(),
                id: id.into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                viewed_at: at,
            },
            false,
        )
        .map(drop)
        .map_err(|_| SyncError::Persistence)
}

fn theme(engine: &SyncEngine<MemorySecret>, value: &str) -> Result<(), crate::error::AppError> {
    engine
        .data
        .preferences
        .set(
            UserPreferences {
                theme: Some(value.into()),
                history_page_size: None,
            },
            false,
        )
        .map(drop)
}

fn remote(
    server: &Server,
    keys: &crate::sync_crypto::SyncKeys,
) -> Result<SyncSnapshot, Box<dyn std::error::Error>> {
    let envelope = lock(server).envelope.clone();
    let plain = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
    Ok(snapshot::decode_snapshot(&plain)?.data)
}

fn remote_schema(
    server: &Server,
    keys: &crate::sync_crypto::SyncKeys,
) -> Result<u32, Box<dyn std::error::Error>> {
    let envelope = lock(server).envelope.clone();
    let plain = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
    Ok(snapshot::decode_snapshot(&plain)?.original_schema_version)
}

/// "Linux": 5752 History, no removals, a large legacy Activity import, favorites, preferences.
/// "Windows": 3 History + 1214 removals matching Linux operations, its own Activity and metadata.
struct Incident {
    url: String,
    server: Server,
    task: tokio::task::JoinHandle<()>,
    linux: SyncEngine<MemorySecret>,
    windows: SyncEngine<MemorySecret>,
    windows_secret: MemorySecret,
    key: String,
    keys: crate::sync_crypto::SyncKeys,
    paths: Vec<PathBuf>,
}

impl Incident {
    async fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let (url, server, task) = server().await?;
        Self::build(url, server, task).await
    }

    async fn build(
        url: String,
        server: Server,
        task: tokio::task::JoinHandle<()>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let linux_path = directory("join-linux");
        let windows_path = directory("join-windows");
        fs::create_dir_all(&linux_path)?;
        fs::write(
            linux_path.join("activity.json"),
            include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
        )?;
        let linux = device(&linux_path, &url, MemorySecret::default())?;
        linux
            .data
            .history
            .merge_sync_state((remote_rows(), vec![]))?;
        linux
            .data
            .discover(30_000, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
        linux.data.favorites.toggle(favorite("20001"))?;
        theme(&linux, "dark")?;
        let key = linux.create().await?.recovery_key;
        let keys = RootSecret::from_recovery_key(&key)?.derive();

        let windows_secret = MemorySecret::default();
        let windows = device(&windows_path, &url, windows_secret.clone())?;
        windows
            .data
            .history
            .merge_sync_state((vec![], (1..=LOCAL_TOMBSTONES).map(op_id).collect()))?;
        for (offset, id) in LOCAL_ITEMS.into_iter().enumerate() {
            accept(&windows, id, 1_790_000_000_000 + offset as u64)?;
        }
        windows.data.favorites.toggle(favorite("900001"))?;
        theme(&windows, "system")?;
        theme(&windows, "light")?;
        windows
            .data
            .preferences
            .set_device_metadata(DeviceMetadata {
                display_name: "Windows installation".into(),
                platform: "windows".into(),
            })?;
        Ok(Self {
            url,
            server,
            task,
            linux,
            windows,
            windows_secret,
            key,
            keys,
            paths: vec![linux_path, windows_path],
        })
    }

    fn windows_path(&self) -> &Path {
        &self.paths[1]
    }

    fn third(&self, label: &str) -> Result<SyncEngine<MemorySecret>, SyncError> {
        device(&directory(label), &self.url, MemorySecret::default())
    }

    fn finish(self) -> TestResult {
        self.task.abort();
        for path in self.paths {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }
}

fn history_ids(snapshot: &SyncSnapshot) -> Vec<&str> {
    snapshot.history.iter().map(|x| x.id.as_str()).collect()
}

#[tokio::test]
async fn incident_restore_adopts_remote_and_never_publishes_local_deletions() -> TestResult {
    let t = Incident::new().await?;
    let (before, _) = t.windows.data.snapshot()?;
    assert_eq!(before.history.len(), 3);
    assert_eq!(before.history_removed.len(), 1214);
    let linux_activity = t.linux.data.activity.viewed_total();
    assert_eq!(linux_activity, 5752 + 1);

    t.windows.join(&t.key, JoinMode::Restore).await?;

    // Windows == Linux, not 4541.
    assert_eq!(t.windows.data.history.snapshot().history.len(), 5752);
    assert_eq!(t.windows.data.history.sync_state().1.len(), 0);
    assert_eq!(t.windows.data.activity.viewed_total(), linux_activity);
    assert_eq!(t.windows.data.favorites.snapshot().len(), 1);
    assert_eq!(t.windows.data.favorites.snapshot()[0].id, "20001");
    assert_eq!(
        t.windows.data.preferences.get().theme.as_deref(),
        Some("dark")
    );

    // The published state carries none of the pre-join local state.
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(published.history.len(), 5752);
    assert_eq!(published.history_removed.len(), 0);
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| !history_ids(&published).contains(id)));
    assert_eq!(published.favorites.len(), 1);
    assert_eq!(
        snapshot::activity_projection(&published.activity)?.0,
        linux_activity
    );
    assert_eq!(published.activity_removed.len(), 0);
    assert_eq!(
        published
            .preferences
            .theme
            .as_ref()
            .map(|x| x.value.as_str()),
        Some("dark")
    );
    assert_eq!(remote_schema(&t.server, &t.keys)?, 2);

    // Linux keeps 5752 after Windows' first publication and a following sync.
    t.linux.sync_now().await?;
    assert_eq!(t.linux.data.history.snapshot().history.len(), 5752);
    t.windows.sync_now().await?;
    assert_eq!(t.windows.data.history.snapshot().history.len(), 5752);

    // A third device restores the same state.
    let third = t.third("join-third")?;
    third.join(&t.key, JoinMode::Restore).await?;
    assert_eq!(third.data.history.snapshot().history.len(), 5752);
    assert_eq!(third.data.activity.viewed_total(), linux_activity);
    assert_eq!(third.data.favorites.snapshot().len(), 1);
    assert_eq!(third.data.history.sync_state().1.len(), 0);

    // Afterwards Windows is an ordinary CRDT participant: its own deletions propagate.
    accept(&t.windows, "910001", 1_790_000_100_000)?;
    t.windows.data.history.remove("prntsc", "20010")?;
    t.windows.sync_now().await?;
    t.linux.sync_now().await?;
    assert_eq!(t.linux.data.history.snapshot().history.len(), 5752);
    assert_eq!(t.linux.data.history.sync_state().1.len(), 1);
    assert!(t
        .linux
        .data
        .history
        .snapshot()
        .history
        .iter()
        .any(|x| x.id == "910001"));
    assert!(t
        .linux
        .data
        .history
        .snapshot()
        .history
        .iter()
        .all(|x| x.id != "20010"));

    // Device identity stays Windows'; the roster holds both installations and nothing stale.
    let status = t.windows.status().await?;
    let this = status.this_device_id.clone().ok_or("missing id")?;
    assert_eq!(this, hex::encode(t.windows.data.identity.id()));
    assert_ne!(this, hex::encode(t.linux.data.identity.id()));
    assert_eq!(status.devices.len(), 3);
    assert!(status
        .devices
        .iter()
        .any(|d| d.this_device && d.platform == t.windows.data.identity.platform()));
    assert!(status
        .devices
        .iter()
        .any(|d| !d.this_device && d.device_id == hex::encode(t.linux.data.identity.id())));
    third.leave().await?;
    t.finish()
}

#[tokio::test]
async fn incident_merge_keeps_union_semantics_with_previous_deletions() -> TestResult {
    let t = Incident::new().await?;
    let linux_activity = t.linux.data.activity.viewed_total();
    let windows_activity = t.windows.data.activity.viewed_total();
    assert_eq!(windows_activity, 3);

    t.windows.join(&t.key, JoinMode::Merge).await?;

    assert_eq!(t.windows.data.history.snapshot().history.len(), 4541);
    assert_eq!(t.windows.data.history.sync_state().1.len(), 1214);
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(published.history.len(), 4541);
    assert_eq!(published.history_removed.len(), 1214);
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| history_ids(&published).contains(id)));
    // Activity is a plain union of operations: nothing lost, nothing double counted.
    assert_eq!(
        t.windows.data.activity.viewed_total(),
        linux_activity + windows_activity
    );
    assert_eq!(published.activity_removed.len(), 0);
    // Both favorites survive; the later preference wins exactly as before.
    assert_eq!(t.windows.data.favorites.snapshot().len(), 2);
    assert_eq!(
        t.windows.data.preferences.get().theme.as_deref(),
        Some("light")
    );

    t.linux.sync_now().await?;
    assert_eq!(t.linux.data.history.snapshot().history.len(), 4541);
    assert_eq!(
        t.linux.data.activity.viewed_total(),
        linux_activity + windows_activity
    );
    assert_eq!(t.linux.data.favorites.snapshot().len(), 2);

    // Repeated Merge/sync is idempotent for every synchronized section.
    let before = remote(&t.server, &t.keys)?;
    t.windows.sync_now().await?;
    t.linux.sync_now().await?;
    let after = remote(&t.server, &t.keys)?;
    assert_eq!(before.history, after.history);
    assert_eq!(before.history_removed, after.history_removed);
    assert_eq!(before.favorites, after.favorites);
    assert_eq!(before.activity, after.activity);
    assert_eq!(before.exploration, after.exploration);
    t.finish()
}

#[tokio::test]
async fn restore_with_empty_or_additive_local_state_matches_remote() -> TestResult {
    let t = Incident::new().await?;
    // Local empty.
    let empty = t.third("join-empty")?;
    assert!(!empty.local_summary()?.meaningful);
    empty.join(&t.key, JoinMode::Restore).await?;
    assert_eq!(empty.data.history.snapshot().history.len(), 5752);
    // Local additions only (no deletions): Windows' history without its tombstones.
    let additions = t.third("join-additions")?;
    for id in LOCAL_ITEMS {
        accept(&additions, id, 1_790_000_000_000)?;
    }
    additions.data.favorites.toggle(favorite("900002"))?;
    additions
        .data
        .discover(77, ExplorationOutcome::Rejected, 1, "2026-10-02")?;
    additions.join(&t.key, JoinMode::Restore).await?;
    let (state, _) = additions.data.snapshot()?;
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(history_ids(&state).len(), 5752);
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| !history_ids(&state).contains(id)));
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| !history_ids(&published).contains(id)));
    assert_eq!(state.favorites, published.favorites);
    assert_eq!(state.exploration, published.exploration);
    assert_eq!(
        additions.data.activity.viewed_total(),
        t.linux.data.activity.viewed_total()
    );
    t.finish()
}

#[tokio::test]
async fn restore_ignores_local_favorite_and_activity_tombstones_and_legacy_activity() -> TestResult
{
    let t = Incident::new().await?;
    let path = directory("join-tombstones");
    fs::create_dir_all(&path)?;
    // Unmigrated legacy activity.json on the joining device.
    fs::write(
        path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let local = device(&path, &t.url, MemorySecret::default())?;
    assert_eq!(local.data.activity.viewed_total(), 5752);
    let (remote_favorites, _) = t.linux.data.favorites.sync_state();
    let (remote_activity, _) = t.linux.data.activity.sync_state();
    local.data.favorites.merge_sync_state((
        vec![],
        remote_favorites.iter().map(|x| x.operation_id).collect(),
    ))?;
    local.data.activity.merge_sync_state(
        vec![],
        remote_activity
            .iter()
            .map(snapshot::ActivityOperation::operation_id)
            .collect(),
        false,
    )?;
    assert!(local.local_summary()?.meaningful);
    assert_eq!(local.local_summary()?.favorite_removals, 1);
    assert_eq!(local.local_summary()?.activity_removals, 2);

    local.join(&t.key, JoinMode::Restore).await?;
    assert_eq!(local.data.favorites.snapshot().len(), 1);
    assert_eq!(
        local.data.activity.viewed_total(),
        t.linux.data.activity.viewed_total()
    );
    assert_eq!(local.data.activity.sync_state().1.len(), 0);
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(published.favorites_removed.len(), 0);
    assert_eq!(published.activity_removed.len(), 0);
    assert_eq!(published.activity.len(), remote_activity.len());
    fs::remove_dir_all(path)?;
    t.finish()
}

#[tokio::test]
async fn restore_preferences_follow_remote_even_when_remote_has_none() -> TestResult {
    let t = Incident::new().await?;
    t.windows.join(&t.key, JoinMode::Restore).await?;
    assert_eq!(
        t.windows.data.preferences.get().theme.as_deref(),
        Some("dark")
    );
    t.finish()?;

    let (url, _server, task) = server().await?;
    let remote_path = directory("join-no-prefs-remote");
    let local_path = directory("join-no-prefs-local");
    let remote = device(&remote_path, &url, MemorySecret::default())?;
    let key = remote.create().await?.recovery_key;
    let local = device(&local_path, &url, MemorySecret::default())?;
    theme(&local, "light")?;
    assert!(local.local_summary()?.meaningful);
    local.join(&key, JoinMode::Restore).await?;
    assert_eq!(local.data.preferences.get().theme, None);
    task.abort();
    fs::remove_dir_all(remote_path)?;
    fs::remove_dir_all(local_path)?;
    Ok(())
}

#[tokio::test]
async fn restore_cas_conflicts_stay_restore_and_include_the_newer_remote() -> TestResult {
    let t = Incident::new().await?;
    // Another device publishes revision N+1 between Restore's GET and PUT, then a second
    // bare conflict follows. Neither retry may fall back to Merge.
    let mut concurrent = t.linux.data.snapshot()?.0;
    concurrent.history.push(snapshot::SyncRecord {
        operation_id: op_id(9_000_001),
        order_at: 9_000_001,
        last_view: snapshot::ViewStamp::inferred(9_000_001),
        source: "prntsc".into(),
        id: "newer".into(),
        source_page_url: "https://prnt.sc/newer".into(),
    });
    concurrent.history.sort_by_key(|x| x.operation_id);
    {
        let mut state = lock(&t.server);
        state.v1_on_update = Some(
            t.keys
                .encrypt_snapshot(&snapshot::serialize_snapshot(&concurrent)?)?,
        );
        state.conflicts_remaining = 1;
    }
    t.windows.join(&t.key, JoinMode::Restore).await?;
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(published.history.len(), 5753);
    assert_eq!(published.history_removed.len(), 0);
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| !history_ids(&published).contains(id)));
    assert_eq!(t.windows.data.history.snapshot().history.len(), 5753);
    assert_eq!(t.windows.data.history.sync_state().1.len(), 0);
    assert_eq!(t.windows.data.favorites.snapshot().len(), 1);

    // Retries are bounded exactly like Merge: persistent conflicts surface and change nothing.
    let other = t.third("join-conflict")?;
    accept(&other, "800001", 1)?;
    let before = other.data.snapshot()?.0;
    lock(&t.server).conflicts_remaining = 10;
    assert_eq!(
        other.join(&t.key, JoinMode::Restore).await.err(),
        Some(SyncError::Conflict)
    );
    assert_eq!(other.data.snapshot()?.0, before);
    t.finish()
}

#[tokio::test]
async fn merge_cas_conflict_still_unions_both_sides() -> TestResult {
    let t = Incident::new().await?;
    let mut concurrent = t.linux.data.snapshot()?.0;
    concurrent.history.push(snapshot::SyncRecord {
        operation_id: op_id(9_000_001),
        order_at: 9_000_001,
        last_view: snapshot::ViewStamp::inferred(9_000_001),
        source: "prntsc".into(),
        id: "newer".into(),
        source_page_url: "https://prnt.sc/newer".into(),
    });
    concurrent.history.sort_by_key(|x| x.operation_id);
    lock(&t.server).v1_on_update = Some(
        t.keys
            .encrypt_snapshot(&snapshot::serialize_snapshot(&concurrent)?)?,
    );
    t.windows.join(&t.key, JoinMode::Merge).await?;
    let published = remote(&t.server, &t.keys)?;
    assert_eq!(published.history.len(), 4542);
    assert_eq!(published.history_removed.len(), 1214);
    assert!(LOCAL_ITEMS
        .iter()
        .all(|id| history_ids(&published).contains(id)));
    t.finish()
}

#[tokio::test]
async fn restore_v1_remote_upgrades_without_importing_local_activity() -> TestResult {
    let (url, server, task) = server().await?;
    let root = RootSecret::from_bytes(&(0_u8..32).collect::<Vec<_>>())?;
    let keys = root.derive();
    let v1 = include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec();
    SyncTransport::new(&url)?
        .create(keys.sync_id(), &keys.client_auth_token(), v1.clone())
        .await?;
    let path = directory("join-v1-restore");
    fs::create_dir_all(&path)?;
    fs::write(
        path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let local = device(&path, &url, MemorySecret::default())?;
    for id in [700_001, 700_002, 700_003] {
        local
            .data
            .discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    assert_eq!(local.data.activity.viewed_total(), 5755);
    // A final v1 write wins the first CAS during the upgrade.
    lock(&server).v1_on_update = Some(v1.clone());
    local
        .join(root.recovery_key().as_str(), JoinMode::Restore)
        .await?;
    // The v1 chain carries no Activity, so Restore keeps none of the local counts either.
    assert_eq!(local.data.activity.viewed_total(), 0);
    assert_eq!(remote_schema(&server, &keys)?, 2);
    let published = remote(&server, &keys)?;
    assert_eq!(published.activity.len(), 0);

    // Schema downgrade protection still applies to Restore, and leaves local state alone.
    local.leave().await?;
    {
        let mut state = lock(&server);
        state.revision += 1;
        state.envelope = v1;
    }
    accept(&local, "800001", 1)?;
    let before = local.data.snapshot()?.0;
    assert_eq!(
        local
            .join(root.recovery_key().as_str(), JoinMode::Restore)
            .await
            .err(),
        Some(SyncError::SchemaDowngrade)
    );
    assert_eq!(local.data.snapshot()?.0, before);
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn restore_failures_before_the_replacement_leave_local_state_untouched() -> TestResult {
    let t = Incident::new().await?;
    let before = t.windows.data.snapshot()?.0;
    let untouched = |t: &Incident| -> Result<bool, crate::error::AppError> {
        Ok(t.windows.data.snapshot()?.0 == before
            && !t.windows_path().join("sync-config.json").exists())
    };

    // Wrong recovery key.
    assert_eq!(
        t.windows
            .join(&RootSecret::generate().recovery_key(), JoinMode::Restore)
            .await
            .err(),
        Some(SyncError::MissingChain)
    );
    assert!(untouched(&t)?);
    // Garbage and tampered (unauthenticated) remote data.
    let good = lock(&t.server).envelope.clone();
    lock(&t.server).envelope = vec![7; 200];
    assert_eq!(
        t.windows.join(&t.key, JoinMode::Restore).await.err(),
        Some(SyncError::InvalidRemoteData)
    );
    assert!(untouched(&t)?);
    let mut tampered = good.clone();
    if let Some(last) = tampered.last_mut() {
        *last ^= 1;
    }
    lock(&t.server).envelope = tampered;
    assert_eq!(
        t.windows.join(&t.key, JoinMode::Restore).await.err(),
        Some(SyncError::InvalidRemoteData)
    );
    assert!(untouched(&t)?);
    lock(&t.server).envelope = good;
    // The server refuses the publication.
    lock(&t.server).fail_next_update = true;
    assert_eq!(
        t.windows.join(&t.key, JoinMode::Restore).await.err(),
        Some(SyncError::ServerError)
    );
    assert!(untouched(&t)?);
    assert!(t.windows_secret.load().await.is_err());
    // And the very same device can still restore afterwards.
    t.windows.join(&t.key, JoinMode::Restore).await?;
    assert_eq!(t.windows.data.history.snapshot().history.len(), 5752);
    t.finish()
}

#[tokio::test]
async fn restore_pairing_failure_after_publication_is_consistent_and_retryable() -> TestResult {
    let t = Incident::new().await?;
    t.windows_secret.fail_store.store(true, Ordering::Relaxed);
    let failed = t.windows.join(&t.key, JoinMode::Restore).await;
    assert!(failed.is_err(), "{failed:?}");
    // Not paired, but already exactly the remote state: no tombstone can leak into a later sync.
    assert!(!t.windows_path().join("sync-config.json").exists());
    assert!(t.windows_secret.load().await.is_err());
    assert_eq!(t.windows.data.history.snapshot().history.len(), 5752);
    assert_eq!(t.windows.data.history.sync_state().1.len(), 0);
    t.windows_secret.fail_store.store(false, Ordering::Relaxed);
    t.windows.join(&t.key, JoinMode::Restore).await?;
    t.windows.sync_now().await?;
    assert_eq!(remote(&t.server, &t.keys)?.history_removed.len(), 0);
    t.finish()
}

#[tokio::test]
async fn restore_cannot_be_resurrected_by_restart_or_legacy_imports() -> TestResult {
    let t = Incident::new().await?;
    let path = directory("join-restart");
    fs::create_dir_all(&path)?;
    // Everything legacy a pre-v2 install can leave behind, all with pre-join content.
    fs::write(
        path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    fs::write(
        path.join("history.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": 2,
            "history": [],
            "index": null,
            "history_ops": [],
            "removed_history_ops": (1..=LOCAL_TOMBSTONES).map(op_id).collect::<Vec<_>>(),
        }))?,
    )?;
    fs::write(path.join("prntsc-explored.txt"), "200,v\n201,r\n")?;
    let local = device(&path, &t.url, MemorySecret::default())?;
    assert_eq!(local.data.history.sync_state().1.len(), 1214);
    // A "clear history" the user prepared before joining.
    let pending = local.data.prepare_clear()?;

    local.join(&t.key, JoinMode::Restore).await?;
    let (restored, _) = local.data.snapshot()?;
    drop(local);

    // Restart: legacy files, receipts and the journal must not change anything.
    let reopened = PersistentState::new(&path)?;
    assert_eq!(reopened.snapshot()?.0, restored);
    assert_eq!(reopened.history.sync_state().1.len(), 0);
    assert_eq!(
        reopened.activity.viewed_total(),
        t.linux.data.activity.viewed_total()
    );
    // Frontend legacy imports and the pending clear are closed or inert.
    reopened
        .activity
        .migrate("2026-10-02", 5, 999, "2026-10-02")?;
    assert_eq!(
        reopened.activity.viewed_total(),
        t.linux.data.activity.viewed_total()
    );
    reopened.import_session_history(
        vec![HistoryItem {
            source: "prntsc".into(),
            id: "session".into(),
            source_page_url: "https://prnt.sc/session".into(),
            viewed_at: 1,
        }],
        0,
    )?;
    reopened.preferences.set(
        UserPreferences {
            theme: Some("light".into()),
            history_page_size: Some(10),
        },
        true,
    )?;
    reopened.commit_clear(&pending)?;
    assert_eq!(reopened.snapshot()?.0, restored);
    assert!(
        !path.join("state-transaction.json").exists()
            || fs::read_to_string(path.join("state-transaction.json"))?.trim() == "null"
    );
    drop(reopened);
    fs::remove_dir_all(path)?;
    t.finish()
}

#[tokio::test]
async fn crash_during_restore_replacement_recovers_the_whole_target() -> TestResult {
    let t = Incident::new().await?;
    let (mut target, _) = t.linux.data.snapshot()?;
    snapshot::reconcile_seen(&mut target);
    crate::persistence::PreferenceStore::register_self(&mut target, &t.windows.data.identity, 1);

    // Crash 1: the journal is durable, nothing else happened.
    t.windows.data.journal_replace_only(&target)?;
    let reopened = PersistentState::new(t.windows_path())?;
    let (state, _) = reopened.snapshot()?;
    assert_eq!(state.history.len(), 5752);
    assert_eq!(state.history_removed.len(), 0);
    assert_eq!(state.favorites, target.favorites);
    assert_eq!(state.activity, target.activity);
    assert_eq!(state.preferences, target.preferences);
    drop(reopened);

    // Crash 2: replacement dies midway (a store cannot write). No half state is readable,
    // and the next start finishes the replacement.
    let other = t.third("join-crash")?;
    accept(&other, "800001", 1)?;
    let other_path = directory("join-crash-path");
    fs::create_dir_all(&other_path)?;
    let partial = PersistentState::new(&other_path)?;
    partial.history.merge_sync_state((vec![], vec![op_id(1)]))?;
    fs::create_dir(other_path.join("favorites-v3.json.tmp"))?;
    assert!(partial.replace_synchronized(&target).is_err());
    assert!(
        partial.snapshot().is_err(),
        "half-replaced state must not be exported"
    );
    fs::remove_dir(other_path.join("favorites-v3.json.tmp"))?;
    drop(partial);
    let recovered = PersistentState::new(&other_path)?;
    let (state, _) = recovered.snapshot()?;
    assert_eq!(state.history.len(), 5752);
    assert_eq!(state.history_removed.len(), 0);
    assert_eq!(state.favorites, target.favorites);
    fs::remove_dir_all(other_path)?;
    t.finish()
}

#[tokio::test]
async fn summary_counts_are_aggregate_and_tombstone_only_devices_are_not_empty() -> TestResult {
    let t = Incident::new().await?;
    let summary = t.windows.local_summary()?;
    assert_eq!(summary.history, 3);
    assert_eq!(summary.history_removals, 1214);
    assert_eq!(summary.favorites, 1);
    assert!(summary.meaningful);
    let json = serde_json::to_string(&summary)?;
    assert_eq!(
        json,
        r#"{"history":3,"historyRemovals":1214,"favorites":1,"favoriteRemovals":0,"activityRemovals":0,"meaningful":true}"#
    );

    let only = t.third("join-only-tombstones")?;
    assert!(!only.local_summary()?.meaningful);
    only.data
        .history
        .merge_sync_state((vec![], vec![op_id(1)]))?;
    let summary = only.local_summary()?;
    assert_eq!((summary.history, summary.history_removals), (0, 1));
    assert!(summary.meaningful);

    let default = SyncSnapshot::default();
    assert!(!state::LocalSyncSummary::from_snapshot(&default).meaningful);
    for (label, changed) in [
        (
            "seen",
            SyncSnapshot {
                seen: vec![1],
                ..SyncSnapshot::default()
            },
        ),
        (
            "history removals",
            SyncSnapshot {
                history_removed: vec![op_id(1)],
                ..SyncSnapshot::default()
            },
        ),
        (
            "favorite removals",
            SyncSnapshot {
                favorites_removed: vec![op_id(1)],
                ..SyncSnapshot::default()
            },
        ),
        (
            "activity removals",
            SyncSnapshot {
                activity_removed: vec![op_id(1)],
                ..SyncSnapshot::default()
            },
        ),
    ] {
        assert!(
            state::LocalSyncSummary::from_snapshot(&changed).meaningful,
            "{label}"
        );
    }
    t.finish()
}

#[test]
fn join_mode_is_an_explicit_wire_value() -> TestResult {
    assert_eq!(
        serde_json::from_str::<JoinMode>("\"restore\"")?,
        JoinMode::Restore
    );
    assert_eq!(
        serde_json::from_str::<JoinMode>("\"merge\"")?,
        JoinMode::Merge
    );
    assert!(serde_json::from_str::<JoinMode>("true").is_err());
    assert!(serde_json::from_str::<JoinMode>("\"replace\"").is_err());
    Ok(())
}

#[tokio::test]
async fn restore_drops_stale_local_roster_records_and_merge_keeps_them() -> TestResult {
    let t = Incident::new().await?;
    let stale = [9_u8; 16];
    let stale_record = || snapshot::DeviceRecord {
        device_id: stale,
        metadata: snapshot::Register {
            clock: 1,
            operation_id: op_id(77),
            value: DeviceMetadata {
                display_name: "Old install".into(),
                platform: "windows".into(),
            },
        },
        joined_at_ms: 1,
        last_sync: None,
    };
    t.windows
        .data
        .preferences
        .merge(snapshot::PreferencesV2::default(), vec![stale_record()])?;
    let merging = t.third("join-stale-merge")?;
    merging
        .data
        .preferences
        .merge(snapshot::PreferencesV2::default(), vec![stale_record()])?;

    t.windows.join(&t.key, JoinMode::Restore).await?;
    let roster = remote(&t.server, &t.keys)?.devices;
    assert!(roster.iter().all(|d| d.device_id != stale));
    assert!(roster
        .iter()
        .any(|d| d.device_id == t.windows.data.identity.id()));
    assert!(roster
        .iter()
        .any(|d| d.device_id == t.linux.data.identity.id()));
    assert_eq!(roster.len(), 2);
    let ours = roster
        .iter()
        .find(|d| d.device_id == t.windows.data.identity.id())
        .ok_or("missing")?;
    assert!(ours.last_sync.is_some());
    assert_ne!(t.windows.data.identity.id(), t.linux.data.identity.id());

    // Merge keeps the unchanged CRDT behavior: every known roster record is published.
    merging.join(&t.key, JoinMode::Merge).await?;
    assert!(remote(&t.server, &t.keys)?
        .devices
        .iter()
        .any(|d| d.device_id == stale));
    t.finish()
}

/// The same incident against the unmodified real server, for both modes.
#[tokio::test]
#[ignore = "requires RANDOM_FRAME_SYNC_E2E_URL pointing to the unmodified local server"]
async fn unmodified_server_incident_restore_and_merge() -> TestResult {
    let url = std::env::var("RANDOM_FRAME_SYNC_E2E_URL")?;
    let published = |t: &Incident| {
        let transport = SyncTransport::new(&t.url);
        let keys = RootSecret::from_recovery_key(&t.key).map(|root| root.derive());
        async move {
            let transport = transport?;
            let keys = keys?;
            let (_, envelope) = transport
                .get(keys.sync_id(), &keys.client_auth_token())
                .await?;
            let plain = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
            Ok::<_, Box<dyn std::error::Error>>(snapshot::decode_snapshot(&plain)?.data)
        }
    };
    for mode in [JoinMode::Restore, JoinMode::Merge] {
        let t = Incident::build(
            url.clone(),
            Arc::new(Mutex::new(ServerState::default())),
            tokio::spawn(async {}),
        )
        .await?;
        t.windows.join(&t.key, mode).await?;
        let third = t.third("e2e-join-third")?;
        let expected = match mode {
            JoinMode::Restore => (5752, 0),
            JoinMode::Merge => (4541, 1214),
        };
        assert_eq!(
            (
                t.windows.data.history.snapshot().history.len(),
                t.windows.data.history.sync_state().1.len()
            ),
            expected
        );
        let state = published(&t).await?;
        assert_eq!((state.history.len(), state.history_removed.len()), expected);
        t.linux.sync_now().await?;
        t.windows.sync_now().await?;
        assert_eq!(t.linux.data.history.snapshot().history.len(), expected.0);
        third.join(&t.key, mode).await?;
        assert_eq!(third.data.history.snapshot().history.len(), expected.0);
        assert_eq!(
            third.data.activity.viewed_total(),
            t.linux.data.activity.viewed_total()
                + if mode == JoinMode::Merge {
                    t.windows.data.activity.viewed_total() - t.linux.data.activity.viewed_total()
                } else {
                    0
                }
        );
        t.finish()?;
    }
    Ok(())
}
