#![allow(
    clippy::unused_async_trait_impl,
    clippy::struct_excessive_bools,
    clippy::too_many_lines,
    reason = "small deterministic HTTP test fixture"
)]
use super::cas::MAX_CAS_ATTEMPTS;
use super::*;
use crate::{
    persistence::{FavoriteItem, FavoriteStore, HistoryItem, HistoryStore, SeenStore},
    secure_storage::{SecretStore, StorageError},
    snapshot,
    sync_crypto::RootSecret,
    sync_transport::{SyncTransport, MAX_ENVELOPE},
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[path = "join_mode_tests.rs"]
mod join_mode;
#[path = "large_upgrade_tests.rs"]
mod large_upgrade;

#[derive(Clone, Default)]
struct MemorySecret {
    value: Arc<Mutex<Option<[u8; 32]>>>,
    fail_store: Arc<AtomicBool>,
}

impl SecretStore for MemorySecret {
    async fn store(&self, root: RootSecret) -> Result<(), StorageError> {
        if self.fail_store.load(Ordering::Relaxed) {
            return Err(StorageError::Unavailable);
        }
        *self
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(*root.as_bytes());
        Ok(())
    }
    async fn load(&self) -> Result<RootSecret, StorageError> {
        let value = self
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .ok_or(StorageError::Missing)?;
        RootSecret::from_bytes(&value).map_err(|_| StorageError::Corrupt)
    }
    async fn delete(&self) -> Result<(), StorageError> {
        *self
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

fn assert_sync_data_equal(actual: &snapshot::SyncSnapshot, expected: &snapshot::SyncSnapshot) {
    assert_eq!(actual.seen, expected.seen, "seen mismatch");
    assert_eq!(actual.history, expected.history, "history mismatch");
    assert_eq!(
        actual.history_removed, expected.history_removed,
        "history_removed mismatch"
    );
    assert_eq!(actual.favorites, expected.favorites, "favorites mismatch");
    assert_eq!(
        actual.favorites_removed, expected.favorites_removed,
        "favorites_removed mismatch"
    );
    assert_eq!(
        actual.exploration, expected.exploration,
        "exploration mismatch"
    );
    assert_eq!(actual.activity, expected.activity, "activity mismatch");
    assert_eq!(
        actual.activity_removed, expected.activity_removed,
        "activity_removed mismatch"
    );
    assert_eq!(
        actual.preferences, expected.preferences,
        "preferences mismatch"
    );
}

#[derive(Default)]
struct ServerState {
    id: Option<String>,
    token: Option<String>,
    revision: i64,
    envelope: Vec<u8>,
    force_conflict: bool,
    conflicts_remaining: usize,
    fail_next_update: bool,
    fail_next_create: bool,
    insert_on_update: Option<(Arc<SeenStore>, u64)>,
    v1_on_update: Option<Vec<u8>>,
    state_on_update: Option<Arc<crate::persistence::PersistentState>>,
    block_config_on_update: Option<PathBuf>,
    block_preferences_on_update: Option<PathBuf>,
    history_on_update: Option<(Arc<HistoryStore>, HistoryItem)>,
    malformed_etag: bool,
    omit_etag: bool,
    rate_limit_next_get: bool,
    oversized: bool,
    requests: usize,
}

async fn server() -> Result<
    (String, Arc<Mutex<ServerState>>, tokio::task::JoinHandle<()>),
    Box<dyn std::error::Error>,
> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let state = Arc::new(Mutex::new(ServerState::default()));
    let shared = Arc::clone(&state);
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let shared = Arc::clone(&shared);
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0_u8; 8192];
                let head_end = loop {
                    let Ok(n) = stream.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end + 4;
                    }
                    if request.len() > 16_384 {
                        return;
                    }
                };
                let Ok(head) = std::str::from_utf8(&request[..head_end]) else {
                    return;
                };
                let head = head.to_owned();
                let mut lines = head.split("\r\n");
                let first = lines.next().unwrap_or_default();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                let headers: Vec<_> = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                    .collect();
                let get = |name: &str| {
                    headers
                        .iter()
                        .find(|(k, _)| k == name)
                        .map(|(_, v)| v.as_str())
                };
                let length = get("content-length")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                while request.len() - head_end < length {
                    let Ok(n) = stream.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                }
                let body = &request[head_end..head_end + length];
                let id = path.strip_prefix("/sync/").unwrap_or_default();
                let token = get("authorization")
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .unwrap_or_default();
                let (status, etag, payload, oversized) = {
                    let mut state = shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.requests += 1;
                    let (status, etag, payload) = if method == "PUT"
                        && get("if-none-match") == Some("*")
                    {
                        if state.fail_next_create {
                            state.fail_next_create = false;
                            (503, None, Vec::new())
                        } else if state.id.is_some() {
                            (412, None, Vec::new())
                        } else {
                            state.id = Some(id.to_owned());
                            state.token = Some(token.to_owned());
                            state.revision = 1;
                            state.envelope = body.to_vec();
                            (201, Some("\"1\"".to_owned()), Vec::new())
                        }
                    } else if state.id.as_deref() != Some(id)
                        || state.token.as_deref() != Some(token)
                    {
                        (404, None, Vec::new())
                    } else if method == "GET" && state.rate_limit_next_get {
                        state.rate_limit_next_get = false;
                        (429, None, Vec::new())
                    } else if method == "GET" {
                        let payload = state.envelope.clone();
                        (
                            200,
                            if state.omit_etag {
                                None
                            } else {
                                Some(if state.malformed_etag {
                                    "W/\"1\"".to_owned()
                                } else {
                                    format!("\"{}\"", state.revision)
                                })
                            },
                            payload,
                        )
                    } else if method == "PUT" {
                        if let Some(envelope) = state.v1_on_update.take() {
                            state.envelope = envelope;
                            state.revision += 1;
                            (412, None, Vec::new())
                        } else if state.fail_next_update {
                            state.fail_next_update = false;
                            (503, None, Vec::new())
                        } else if state.force_conflict || state.conflicts_remaining > 0 {
                            state.force_conflict = false;
                            state.conflicts_remaining = state.conflicts_remaining.saturating_sub(1);
                            state.revision += 1;
                            (412, None, Vec::new())
                        } else if get("if-match")
                            != Some(format!("\"{}\"", state.revision).as_str())
                        {
                            (412, None, Vec::new())
                        } else {
                            state.revision += 1;
                            state.envelope = body.to_vec();
                            if let Some(path) = state.block_config_on_update.take() {
                                if fs::create_dir(path.join("sync-config.json.tmp")).is_err() {
                                    return;
                                }
                            }
                            if let Some(path) = state.block_preferences_on_update.take() {
                                if fs::create_dir(path.join("preferences.json.tmp")).is_err() {
                                    return;
                                }
                            }
                            if let Some((seen, id)) = state.insert_on_update.take() {
                                let _ = seen.insert(id);
                            }
                            if let Some((history, item)) = state.history_on_update.take() {
                                let _ = history.record(item);
                            }
                            if let Some(data) = state.state_on_update.take() {
                                if data
                                    .discover(
                                        99,
                                        crate::persistence::ExplorationOutcome::Viewed,
                                        1,
                                        "2026-10-02",
                                    )
                                    .is_err()
                                {
                                    return;
                                }
                                if data
                                    .read(|| {
                                        data.preferences.set(
                                            crate::persistence::UserPreferences {
                                                theme: Some("dark".into()),
                                                history_page_size: Some(50),
                                            },
                                            false,
                                        )
                                    })
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            (204, Some(format!("\"{}\"", state.revision)), Vec::new())
                        }
                    } else {
                        (405, None, Vec::new())
                    };
                    (status, etag, payload, state.oversized && method == "GET")
                };
                let content_length = if oversized {
                    MAX_ENVELOPE + 1
                } else {
                    payload.len()
                };
                let mut response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {content_length}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n");
                if let Some(etag) = etag {
                    use std::fmt::Write;
                    let _ = write!(response, "ETag: {etag}\r\n");
                }
                response.push_str("\r\n");
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(&payload).await;
            });
        }
    });
    Ok((url, state, task))
}

fn directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "random-frame-sync-{label}-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ))
}

fn device(
    path: &Path,
    url: &str,
    secret: MemorySecret,
) -> Result<SyncEngine<MemorySecret>, SyncError> {
    let seen = Arc::new(SeenStore::new(path).map_err(|_| SyncError::Persistence)?);
    let history = Arc::new(HistoryStore::new(path).map_err(|_| SyncError::Persistence)?);
    let favorites = Arc::new(FavoriteStore::new(path).map_err(|_| SyncError::Persistence)?);
    make_engine(path, seen, history, favorites, secret, Some(url))
}

type TestDevice = (
    SyncEngine<MemorySecret>,
    Arc<HistoryStore>,
    Arc<FavoriteStore>,
);

#[tokio::test]
async fn two_devices_converge_with_cas_collision_and_leave_keeps_seen(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let a_path = directory("a");
    let b_path = directory("b");
    let a_secret = MemorySecret::default();
    let b_secret = MemorySecret::default();
    let a = device(&a_path, &url, a_secret.clone())?;
    let b = device(&b_path, &url, b_secret.clone())?;
    a.seen.merge([1, 2, 3])?;
    b.seen.merge([3, 4, 5])?;
    let created = a.create().await?;
    assert!(created.local_pairing_error.is_none());
    assert_eq!(created.status.last_success_revision, Some(1));
    assert!(!created.status.dirty);
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .fail_next_create = true;
    assert_eq!(b.create().await.err(), Some(SyncError::ServerError));
    assert!(!b_path.join("sync-config.json").exists());
    assert!(b_secret.load().await.is_err());
    b.join(&created.recovery_key, JoinMode::Merge).await?;
    for id in 1..=5 {
        assert!(b.seen.contains(id));
    }
    a.seen.insert(6)?;
    b.seen.insert(7)?;
    assert!(a.status().await?.dirty);
    a.sync_now().await?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .force_conflict = true;
    b.sync_now().await?;
    a.sync_now().await?;
    for id in 1..=7 {
        assert!(a.seen.contains(id));
        assert!(b.seen.contains(id));
    }
    let envelope = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    let keys = a_secret.load().await?.derive();
    let remote = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
    assert_eq!(
        snapshot::parse_snapshot(&remote)?.seen,
        (1..=7).collect::<Vec<_>>()
    );
    b.leave().await?;
    assert!(b.seen.contains(7));
    assert!(b_secret.load().await.is_err());
    assert!(!b_path.join("sync-config.json").exists());
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

#[tokio::test]
async fn devices_converge_history_and_favorites() -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let a_path = directory("v2-a");
    let b_path = directory("v2-b");
    let make = |path: &Path, secret: MemorySecret| -> Result<TestDevice, SyncError> {
        let seen = Arc::new(SeenStore::new(path).map_err(|_| SyncError::Persistence)?);
        let history = Arc::new(HistoryStore::new(path).map_err(|_| SyncError::Persistence)?);
        let favorites = Arc::new(FavoriteStore::new(path).map_err(|_| SyncError::Persistence)?);
        let engine = make_engine(
            path,
            seen,
            Arc::clone(&history),
            Arc::clone(&favorites),
            secret,
            Some(&url),
        )?;
        Ok((engine, history, favorites))
    };
    let (a, a_history, a_favorites) = make(&a_path, MemorySecret::default())?;
    let (b, b_history, b_favorites) = make(&b_path, MemorySecret::default())?;
    a_history.record(HistoryItem {
        source: "prntsc".into(),
        id: "a".into(),
        source_page_url: "https://prnt.sc/a".into(),
        viewed_at: 1,
    })?;
    b_history.record(HistoryItem {
        source: "prntsc".into(),
        id: "b".into(),
        source_page_url: "https://prnt.sc/b".into(),
        viewed_at: 2,
    })?;
    a_favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "a".into(),
        source_page_url: "https://prnt.sc/a".into(),
        added_at: 1,
    })?;
    b_favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "b".into(),
        source_page_url: "https://prnt.sc/b".into(),
        added_at: 2,
    })?;
    let created = a.create().await?;
    b.join(&created.recovery_key, JoinMode::Merge).await?;
    a.sync_now().await?;
    let a_ids = a_history
        .snapshot()
        .history
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    let b_ids = b_history
        .snapshot()
        .history
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(a_ids, b_ids);
    assert_eq!(a_favorites.snapshot().len(), 2);
    assert_eq!(b_favorites.snapshot().len(), 2);
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    let _ = server;
    Ok(())
}

#[tokio::test]
async fn exploration_syncs_with_seen_history_and_favorites(
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::{
        clear_local_history,
        persistence::{ExplorationOutcome, FavoriteItem, HistoryItem},
        AppState,
    };

    let (url, _, task) = server().await?;
    let a_path = directory("local-exploration-a");
    let b_path = directory("local-exploration-b");
    fs::create_dir_all(&a_path)?;
    fs::write(a_path.join("prntsc-explored.txt"), "200\n")?;
    let a_state = AppState::new(&a_path, None)?;
    let b_state = AppState::new(&b_path, None)?;
    for id in 0..100 {
        a_state.explored.mark(id, ExplorationOutcome::Viewed)?;
        a_state.seen.insert(id)?;
    }
    for id in 100..120 {
        a_state.explored.mark(id, ExplorationOutcome::Rejected)?;
    }
    b_state.explored.mark(300, ExplorationOutcome::Viewed)?;
    b_state.seen.insert(300)?;
    a_state.history.record(HistoryItem {
        source: "prntsc".into(),
        id: "1".into(),
        source_page_url: "https://prnt.sc/1".into(),
        viewed_at: 1,
    })?;
    a_state.favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "1".into(),
        source_page_url: "https://prnt.sc/1".into(),
        added_at: 1,
    })?;
    let a_counts = (121, 100, 20, 1);
    let b_counts = (1, 1, 0, 0);
    assert_eq!(a_state.explored.counts(), a_counts);
    assert_eq!(b_state.explored.counts(), b_counts);

    let a = SyncEngine::new(
        &a_path,
        Arc::clone(&a_state.data),
        MemorySecret::default(),
        Some(&url),
        None,
    );
    let key = a.create().await?.recovery_key;
    let b = SyncEngine::new(
        &b_path,
        Arc::clone(&b_state.data),
        MemorySecret::default(),
        Some(&url),
        None,
    );
    b.join(&key, JoinMode::Merge).await?;
    b.sync_now().await?;
    a.sync_now().await?;
    assert!(a_state.seen.contains(300));
    assert!(b_state.seen.contains(0));
    assert_eq!(b_state.history.snapshot().history.len(), 1);
    assert_eq!(b_state.favorites.snapshot().len(), 1);
    assert_eq!(b_state.explored.count(), 122);
    assert_eq!(a_state.explored.counts(), (122, 101, 20, 1));
    assert_eq!(b_state.explored.counts(), (122, 101, 20, 1));

    clear_local_history(&a_state)?;
    a.sync_now().await?;
    b.sync_now().await?;
    assert_eq!(b_state.history.snapshot().history, vec![]);
    assert_eq!(b_state.favorites.snapshot().len(), 1);
    assert_eq!(a_state.explored.counts(), (122, 101, 20, 1));
    assert_eq!(b_state.explored.counts(), (122, 101, 20, 1));
    drop(a);
    drop(b);
    drop(a_state);
    drop(b_state);
    assert_eq!(
        AppState::new(&a_path, None)?.explored.counts(),
        (122, 101, 20, 1)
    );
    assert_eq!(
        AppState::new(&b_path, None)?.explored.counts(),
        (122, 101, 20, 1)
    );
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

#[tokio::test]
async fn clearing_history_preserves_seen_and_propagates_only_known_removals(
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::{
        clear_local_history,
        persistence::{DailyActivitySnapshot, ExplorationOutcome},
        record_accepted_frame, AppState,
    };

    let (url, server, task) = server().await?;
    let a_path = directory("clear-a");
    let b_path = directory("clear-b");
    fs::create_dir_all(&a_path)?;
    fs::write(a_path.join("prntsc-explored.txt"), "200\n")?;
    let a_secret = MemorySecret::default();
    let b_secret = MemorySecret::default();
    let a_state = AppState::new(&a_path, None)?;
    let b_state = AppState::new(&b_path, None)?;
    let engine = |path: &Path, state: &AppState, secret: MemorySecret| {
        SyncEngine::new(path, Arc::clone(&state.data), secret, Some(&url), None)
    };
    let a = engine(&a_path, &a_state, a_secret.clone());
    let b = engine(&b_path, &b_state, b_secret.clone());
    let today_date = chrono::Local::now().date_naive();
    let today = crate::persistence::day_key(today_date);
    let yesterday = crate::persistence::day_key(today_date - chrono::Duration::days(1));
    let viewed_at = u64::try_from(chrono::Local::now().timestamp_millis())?;
    let item = |id: &str| HistoryItem {
        source: "prntsc".into(),
        id: id.into(),
        source_page_url: format!("https://prnt.sc/{id}"),
        viewed_at,
    };
    for id in ["abc123", "abc124", "abc125"] {
        record_accepted_frame(&item(id), &a_state, false)?;
    }
    a_state.seen.merge(1..=5)?;
    a_state.explored.mark(10, ExplorationOutcome::Rejected)?;
    a_state
        .activity
        .record(ExplorationOutcome::Rejected, &yesterday)?;
    a_state.favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
        added_at: 1,
    })?;
    assert_eq!(a_state.activity.viewed_total(), 3);
    assert_eq!(a_state.explored.counts(), (5, 3, 1, 1));
    let seen_before = a_state.seen.snapshot_with_generation().0;
    let key = a.create().await?.recovery_key;
    b.join(&key, JoinMode::Merge).await?;
    assert_eq!(b_state.explored.count(), 5);
    b_state.explored.mark(11, ExplorationOutcome::Rejected)?;
    b_state
        .activity
        .record(ExplorationOutcome::Rejected, &yesterday)?;
    b_state.explored.mark(12, ExplorationOutcome::Viewed)?;
    b_state
        .activity
        .record(ExplorationOutcome::Viewed, &today)?;
    b_state.seen.insert(12)?;
    assert_eq!(b_state.history.snapshot().history.len(), 3);
    assert_eq!(b_state.favorites.snapshot().len(), 1);

    // B is offline: its three known operations are old, while this new operation is unknown to A.
    record_accepted_frame(&item("abc126"), &b_state, false)?;
    clear_local_history(&a_state)?;
    assert_eq!(a_state.seen.snapshot_with_generation().0, seen_before);
    assert_eq!(a_state.favorites.snapshot().len(), 1);
    assert_eq!(a_state.history.snapshot().history, vec![]);
    assert_eq!(a_state.history.sync_state().1.len(), 3);
    assert_eq!(a_state.activity.viewed_total(), 0);
    assert_eq!(a_state.explored.counts(), (5, 3, 1, 1));
    assert_eq!(a_state.explored.viewable_count(), 3);
    assert_eq!(a_state.explored.unavailable_count(), 1);
    assert_eq!(
        a_state.activity.recent_days(today_date, 183),
        vec![(
            today.clone(),
            DailyActivitySnapshot {
                viewed: 0,
                rejected: 0
            }
        )]
    );
    assert_eq!(a_state.history.local_view_times(), vec![]);

    // A encounters a 412 and must retain its tombstones through GET, merge, and retry.
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .force_conflict = true;
    a.sync_now().await?;
    let remote = || -> Result<snapshot::SyncSnapshot, Box<dyn std::error::Error>> {
        let envelope = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .envelope
            .clone();
        let keys = a_secret
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .ok_or("missing test secret")?;
        let root = RootSecret::from_bytes(&keys)?;
        let keys = root.derive();
        Ok(snapshot::parse_snapshot(
            &keys.decrypt_snapshot(keys.sync_id(), &envelope)?,
        )?)
    };
    let after_clear = remote()?;
    assert_eq!(after_clear.history, vec![]);
    assert_eq!(after_clear.history_removed.len(), 3);
    assert_eq!(after_clear.seen, seen_before);
    assert_eq!(after_clear.favorites.len(), 1);
    assert_eq!(a_state.explored.counts(), (5, 3, 1, 1));

    b.sync_now().await?;
    let b_ids: Vec<_> = b_state
        .history
        .snapshot()
        .history
        .into_iter()
        .map(|x| x.id)
        .collect();
    assert_eq!(b_ids, ["abc126"]);
    assert_eq!(b_state.history.sync_state().1.len(), 3);
    assert_eq!(b_state.favorites.snapshot().len(), 1);
    assert_eq!(b_state.activity.viewed_total(), 2);
    assert_eq!(b_state.explored.count(), 8);
    assert_eq!(b_state.explored.viewable_count(), 5);
    assert_eq!(b_state.explored.unavailable_count(), 2);
    assert_eq!(a_state.explored.counts(), (5, 3, 1, 1));
    assert_eq!(a_state.explored.viewable_count(), 3);
    assert_eq!(a_state.explored.unavailable_count(), 1);
    let days = b_state.activity.recent_days(today_date, 183);
    assert_eq!(
        days[0],
        (
            yesterday,
            DailyActivitySnapshot {
                viewed: 0,
                rejected: 1
            }
        )
    );
    assert_eq!(
        days[1],
        (
            today,
            DailyActivitySnapshot {
                viewed: 2,
                rejected: 0
            }
        )
    );
    assert_eq!(remote()?.history.len(), 1);
    assert_eq!(remote()?.history_removed.len(), 3);
    a.sync_now().await?;
    let stable = remote()?;
    b.sync_now().await?;
    a.sync_now().await?;
    assert_sync_data_equal(&remote()?, &stable);

    // Clear Favorites removes known entries, while B's new offline favorite survives.
    b_state.favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "abc126".into(),
        source_page_url: "https://prnt.sc/abc126".into(),
        added_at: 2,
    })?;
    a_state.favorites.clear()?;
    assert_eq!(a_state.favorites.snapshot(), vec![]);
    a.sync_now().await?;
    assert_eq!(remote()?.favorites, vec![]);
    b.sync_now().await?;
    assert_eq!(
        b_state
            .favorites
            .snapshot()
            .into_iter()
            .map(|x| x.id)
            .collect::<Vec<_>>(),
        ["abc126"]
    );
    a.sync_now().await?;
    let stable = remote()?;
    assert_eq!(stable.favorites.len(), 1);
    assert_eq!(stable.favorites_removed.len(), 1);
    b.sync_now().await?;
    assert_sync_data_equal(&remote()?, &stable);

    drop(a);
    drop(b);
    drop(a_state);
    drop(b_state);
    let a_restarted = AppState::new(&a_path, None)?;
    let b_restarted = AppState::new(&b_path, None)?;
    assert_eq!(a_restarted.history.snapshot().history.len(), 1);
    assert_eq!(b_restarted.history.snapshot().history.len(), 1);
    assert_eq!(a_restarted.favorites.snapshot().len(), 1);
    assert_eq!(b_restarted.favorites.snapshot().len(), 1);
    assert_eq!(
        a_restarted.seen.snapshot_with_generation().0,
        b_restarted.seen.snapshot_with_generation().0
    );
    assert_eq!(a_restarted.activity.viewed_total(), 2);
    assert_eq!(a_restarted.explored.counts(), (8, 5, 2, 1));
    assert_eq!(a_restarted.explored.viewable_count(), 5);
    assert_eq!(a_restarted.explored.unavailable_count(), 2);
    assert_eq!(b_restarted.activity.viewed_total(), 2);
    assert_eq!(b_restarted.explored.count(), 8);
    engine(&a_path, &a_restarted, a_secret.clone())
        .startup_sync()
        .await?;
    engine(&b_path, &b_restarted, b_secret.clone())
        .startup_sync()
        .await?;
    assert_sync_data_equal(&remote()?, &stable);
    assert_eq!(a_restarted.explored.counts(), (8, 5, 2, 1));
    assert_eq!(b_restarted.explored.count(), 8);
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN pointing to the real random-frame-sync-server binary"]
async fn real_server_two_device_offline_and_startup_e2e() -> Result<(), Box<dyn std::error::Error>>
{
    use std::process::{Child, Command, Stdio};

    struct Server(Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let binary = std::env::var("RF_SYNC_SERVER_BIN")?;
    let root = directory("real-server");
    fs::create_dir_all(&root)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    drop(listener);
    let url = format!("http://{address}");
    let database = root.join("sync.db");
    let start = || -> Result<Server, Box<dyn std::error::Error>> {
        Ok(Server(
            Command::new(&binary)
                .env("RF_SYNC_BIND", address.to_string())
                .env("RF_SYNC_DB", &database)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        ))
    };
    let ready = || async {
        for _ in 0..40 {
            if reqwest::get(format!("{url}/health"))
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return Ok::<(), Box<dyn std::error::Error>>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err("real server did not become ready".into())
    };
    let server = start()?;
    ready().await?;
    let a_secret = MemorySecret::default();
    let a_path = root.join("a");
    fs::create_dir_all(&a_path)?;
    fs::write(
        a_path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let a = device(&a_path, &url, a_secret.clone())?;
    let b = device(&root.join("b"), &url, MemorySecret::default())?;
    a.seen.insert(101)?;
    b.seen.insert(202)?;
    for id in [700_001, 700_002, 700_003] {
        b.data.discover(
            id,
            crate::persistence::ExplorationOutcome::Viewed,
            1,
            "2026-10-02",
        )?;
    }
    assert_eq!(a.data.activity.viewed_total(), 5752);
    assert_eq!(b.data.activity.viewed_total(), 3);
    let created = a.create().await?;
    assert!(created.local_pairing_error.is_none());
    assert_eq!(created.status.last_success_revision, Some(1));
    assert_eq!(
        b.join(&created.recovery_key, JoinMode::Merge)
            .await?
            .last_success_revision,
        Some(2)
    );
    assert!(b.seen.contains(101));
    assert_eq!(b.data.activity.viewed_total(), 5755);
    a.seen.insert(303)?;
    b.seen.insert(404)?;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(3));
    assert_eq!(b.sync_now().await?.last_success_revision, Some(4));
    assert_eq!(a.sync_now().await?.last_success_revision, Some(5));
    assert_eq!(a.data.activity.viewed_total(), 5755);
    assert_eq!(b.data.activity.viewed_total(), 5755);
    for id in [101, 202, 303, 404] {
        assert!(a.seen.contains(id));
        assert!(b.seen.contains(id));
    }
    let keys = a_secret.load().await?.derive();
    let transport = SyncTransport::new(&url)?;
    let (revision, envelope) = transport
        .get(keys.sync_id(), &keys.client_auth_token())
        .await?;
    assert_eq!(revision, 5);
    assert_eq!(
        snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?.seen,
        vec![101, 202, 303, 404, 700_001, 700_002, 700_003]
    );

    drop(server);
    a.seen.insert(505)?;
    b.seen.insert(606)?;
    assert_eq!(a.sync_now().await.err(), Some(SyncError::Offline));
    assert!(a.status().await?.dirty);
    assert!(a.seen.contains(505));
    let server = start()?;
    ready().await?;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(6));
    assert!(!a.status().await?.dirty);
    assert_eq!(b.sync_now().await?.last_success_revision, Some(7));
    assert_eq!(a.startup_sync().await?.last_success_revision, Some(8));
    assert_eq!(a.data.activity.viewed_total(), 5755);
    assert_eq!(b.data.activity.viewed_total(), 5755);
    for id in [101, 202, 303, 404, 505, 606] {
        assert!(a.seen.contains(id));
        assert!(b.seen.contains(id));
    }
    let (revision, envelope) = transport
        .get(keys.sync_id(), &keys.client_auth_token())
        .await?;
    assert_eq!(revision, 8);
    assert_eq!(
        snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?.seen,
        vec![101, 202, 303, 404, 505, 606, 700_001, 700_002, 700_003]
    );
    drop(server);
    assert_eq!(a.startup_sync().await.err(), Some(SyncError::Offline));
    assert!(a.seen.insert(707)?);
    assert!(a.status().await?.dirty);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RF_SYNC_E2E_URL, RF_SYNC_E2E_SSH_KEY, and RF_SYNC_E2E_SSH_TARGET"]
#[allow(
    clippy::print_stdout,
    reason = "report actual production E2E revisions"
)]
async fn production_https_two_device_e2e() -> Result<(), Box<dyn std::error::Error>> {
    use std::process::Command;

    fn service(key: &str, target: &str, action: &str) -> Result<(), Box<dyn std::error::Error>> {
        let status = Command::new("ssh")
            .args(["-F", "/dev/null", "-i", key, "-o", "BatchMode=yes", target])
            .arg(format!("sudo -n systemctl {action} random-frame-sync"))
            .status()?;
        if !status.success() {
            return Err(format!("remote systemctl {action} failed: {status}").into());
        }
        Ok(())
    }

    struct RestoreService<'a> {
        key: &'a str,
        target: &'a str,
        stopped: bool,
    }
    impl Drop for RestoreService<'_> {
        fn drop(&mut self) {
            if self.stopped {
                let _ = service(self.key, self.target, "start");
            }
        }
    }

    let url = std::env::var("RF_SYNC_E2E_URL")?;
    let key = std::env::var("RF_SYNC_E2E_SSH_KEY")?;
    let target = std::env::var("RF_SYNC_E2E_SSH_TARGET")?;
    let root = directory("production-https");
    let a_secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, a_secret.clone())?;
    let b = device(&root.join("b"), &url, MemorySecret::default())?;
    a.seen.insert(101)?;
    b.seen.insert(202)?;
    let created = a.create().await?;
    assert!(created.local_pairing_error.is_none());
    assert_eq!(created.status.last_success_revision, Some(1));
    let keys = a_secret.load().await?.derive();
    println!(
        "production sync_id={} create=1 A=[101] B=[202]",
        keys.sync_id()
    );

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(
        b.join(&created.recovery_key, JoinMode::Merge)
            .await?
            .last_success_revision,
        Some(2)
    );
    println!("join=2 B=[101,202]");
    a.seen.insert(303)?;
    b.seen.insert(404)?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(3));
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(b.sync_now().await?.last_success_revision, Some(4));
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(5));
    println!("converged=5 A/B=[101,202,303,404]");

    let transport = SyncTransport::new(&url)?;
    let (revision, envelope) = transport
        .get(keys.sync_id(), &keys.client_auth_token())
        .await?;
    assert_eq!(revision, 5);
    assert_eq!(
        snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?.seen,
        vec![101, 202, 303, 404]
    );

    service(&key, &target, "restart")?;
    assert!(reqwest::get(format!("{url}/health"))
        .await?
        .status()
        .is_success());
    a.seen.insert(505)?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(6));
    println!("restart=6 A=[101,202,303,404,505]");

    let mut restore = RestoreService {
        key: &key,
        target: &target,
        stopped: false,
    };
    service(&key, &target, "stop")?;
    restore.stopped = true;
    b.seen.insert(606)?;
    assert_eq!(b.sync_now().await.err(), Some(SyncError::ServerError));
    assert!(b.status().await?.dirty);
    println!("offline B local 606 persisted, dirty=true, error=server_error");
    service(&key, &target, "start")?;
    restore.stopped = false;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(b.sync_now().await?.last_success_revision, Some(7));
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(8));
    let (revision, envelope) = transport
        .get(keys.sync_id(), &keys.client_auth_token())
        .await?;
    assert_eq!(revision, 8);
    let expected = vec![101, 202, 303, 404, 505, 606];
    assert_eq!(
        snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?.seen,
        expected
    );
    for id in expected {
        assert!(a.seen.contains(id) && b.seen.contains(id));
    }
    println!("recovered=8 A/B/remote=[101,202,303,404,505,606]");
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
async fn rollback_rejected_before_decrypt_or_merge_and_equal_or_higher_allowed(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("rollback");
    let engine = device(&path, &url, MemorySecret::default())?;
    engine.seen.insert(1)?;
    engine.create().await?;
    let mut config = engine.config()?.ok_or("missing config")?;
    config.last_accepted_revision = Some(10);
    engine.save(&config)?;
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.revision = 9;
        state.envelope = vec![0; 40];
    }
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::ServerRollbackDetected {
            local_revision: 10,
            remote_revision: 9
        })
    );
    assert!(!engine.seen.contains(2));
    assert_eq!(
        engine.config()?.and_then(|c| c.last_accepted_revision),
        Some(10)
    );
    let keys = engine.secret.load().await?.derive();
    let valid = keys.encrypt_snapshot(&snapshot::serialize_snapshot(&snapshot::SyncSnapshot {
        seen: vec![1, 2],
        ..snapshot::SyncSnapshot::default()
    })?)?;
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.revision = 10;
        state.envelope = valid;
    }
    engine.sync_now().await?;
    assert!(engine.seen.contains(2));
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.revision = 15;
    }
    engine.sync_now().await?;
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn partial_failures_preserve_recovery_and_local_union(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let a_path = directory("partial-a");
    let b_path = directory("partial-b");
    let a_secret = MemorySecret::default();
    a_secret.fail_store.store(true, Ordering::Relaxed);
    let a = device(&a_path, &url, a_secret.clone())?;
    a.seen.insert(1)?;
    let partial = a.create().await?;
    assert_eq!(partial.local_pairing_error, Some(SyncError::SecureStorage));
    assert!(!a_path.join("sync-config.json").exists());
    assert!(a_secret.load().await.is_err());
    let b = device(&b_path, &url, MemorySecret::default())?;
    b.seen.insert(2)?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .fail_next_update = true;
    assert_eq!(
        b.join(&partial.recovery_key, JoinMode::Merge).await.err(),
        Some(SyncError::ServerError)
    );
    assert!(b.seen.contains(1));
    assert!(b.seen.contains(2));
    assert!(!b_path.join("sync-config.json").exists());
    b.join(&partial.recovery_key, JoinMode::Merge).await?;
    let c_path = directory("partial-c");
    let c_secret = MemorySecret::default();
    c_secret.fail_store.store(true, Ordering::Relaxed);
    let c = device(&c_path, &url, c_secret.clone())?;
    c.seen.insert(3)?;
    assert_eq!(
        c.join(&partial.recovery_key, JoinMode::Merge).await.err(),
        Some(SyncError::SecureStorage)
    );
    assert!(c.seen.contains(1));
    assert!(!c_path.join("sync-config.json").exists());
    assert!(c_secret.load().await.is_err());
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    fs::remove_dir_all(c_path)?;
    Ok(())
}

#[tokio::test]
async fn transport_and_pairing_reject_bad_inputs() -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("bad");
    let engine = device(&path, &url, MemorySecret::default())?;
    assert_eq!(
        engine.join("wrong", JoinMode::Merge).await.err(),
        Some(SyncError::InvalidRecoveryKey)
    );
    let created = engine.create().await?;
    let other_path = directory("bad-other");
    let other = device(&other_path, &url, MemorySecret::default())?;
    assert_eq!(
        other
            .join(&RootSecret::generate().recovery_key(), JoinMode::Merge)
            .await
            .err(),
        Some(SyncError::MissingChain)
    );
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.malformed_etag = true;
    }
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::MalformedResponse)
    );
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.malformed_etag = false;
        state.omit_etag = true;
    }
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::MalformedResponse)
    );
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.omit_etag = false;
        state.rate_limit_next_get = true;
    }
    assert_eq!(engine.sync_now().await.err(), Some(SyncError::RateLimited));
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.oversized = true;
    }
    assert_eq!(engine.sync_now().await.err(), Some(SyncError::BodyTooLarge));
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .oversized = false;
    engine.sync_now().await?;
    assert!(created.recovery_key.starts_with("rf1-"));
    task.abort();
    fs::remove_dir_all(path)?;
    fs::remove_dir_all(other_path)?;
    Ok(())
}

#[tokio::test]
async fn config_identity_and_single_operation_are_checked_before_network(
) -> Result<(), Box<dyn std::error::Error>> {
    let path = directory("config");
    let secret = MemorySecret::default();
    let engine = device(&path, "https://sync.example.com", secret.clone())?;
    let config = SyncLocalConfig::new("a".repeat(64), 10);
    engine.save(&config)?;
    assert_eq!(
        engine.config()?.and_then(|c| c.last_accepted_revision),
        Some(10)
    );
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    secret.store(RootSecret::generate()).await?;
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    assert_eq!(
        engine.status().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    fs::write(&engine.path, b"{broken")?;
    assert_eq!(engine.config().err(), Some(SyncError::CorruptLocalState));
    fs::remove_file(&engine.path)?;
    assert_eq!(
        engine.status().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    let guard = engine.operation.lock().await;
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::AlreadySyncing)
    );
    drop(guard);
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn dirty_local_change_survives_upload_and_offline_sync(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("dirty");
    let engine = device(&path, &url, MemorySecret::default())?;
    engine.seen.insert(1)?;
    engine.create().await?;
    {
        let mut fixture = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        fixture.insert_on_update = Some((Arc::clone(&engine.seen), 2));
        fixture.history_on_update = Some((
            Arc::clone(&engine.history),
            HistoryItem {
                source: "prntsc".into(),
                id: "abc123".into(),
                source_page_url: "https://prnt.sc/abc123".into(),
                viewed_at: 42,
            },
        ));
    }
    let status = engine.sync_now().await?;
    assert!(status.dirty);
    assert!(engine.seen.contains(2));
    assert_eq!(engine.history.snapshot().history.len(), 1);
    engine.sync_now().await?;
    assert!(!engine.status().await?.dirty);
    let envelope = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    let keys = engine.secret.load().await?.derive();
    assert_eq!(
        snapshot::parse_snapshot(&keys.decrypt_snapshot(keys.sync_id(), &envelope)?)?
            .history
            .len(),
        1
    );
    task.abort();
    engine.seen.insert(3)?;
    assert_eq!(engine.sync_now().await.err(), Some(SyncError::Offline));
    assert!(engine.seen.contains(3));
    assert!(engine.status().await?.dirty);
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn bounded_conflicts_and_invalid_envelope_do_not_unpair(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("conflicts");
    let engine = device(&path, &url, MemorySecret::default())?;
    engine.seen.insert(1)?;
    engine.create().await?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .conflicts_remaining = MAX_CAS_ATTEMPTS;
    assert_eq!(engine.sync_now().await.err(), Some(SyncError::Conflict));
    assert!(engine.status().await?.paired);
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.envelope = vec![0; 40];
    }
    assert_eq!(
        engine.sync_now().await.err(),
        Some(SyncError::InvalidRemoteData)
    );
    assert!(engine.seen.contains(1));
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn join_conflict_retries_do_not_persist_pairing_until_cas_succeeds(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let a_path = directory("join-cas-a");
    let b_path = directory("join-cas-b");
    let a = device(&a_path, &url, MemorySecret::default())?;
    let b_secret = MemorySecret::default();
    let b = device(&b_path, &url, b_secret.clone())?;
    a.seen.insert(1)?;
    b.seen.insert(2)?;
    let created = a.create().await?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .conflicts_remaining = MAX_CAS_ATTEMPTS;

    assert_eq!(
        b.join(&created.recovery_key, JoinMode::Merge).await.err(),
        Some(SyncError::Conflict)
    );
    assert!(b.config()?.is_none());
    assert!(b_secret.load().await.is_err());
    assert!(b.seen.contains(1) && b.seen.contains(2));

    let joined = b.join(&created.recovery_key, JoinMode::Merge).await?;
    assert_eq!(joined.last_success_revision, Some(5));
    assert_eq!(
        b.config()?.and_then(|config| config.last_accepted_revision),
        Some(5)
    );
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

fn make_engine(
    path: &Path,
    seen: Arc<SeenStore>,
    history: Arc<HistoryStore>,
    favorites: Arc<FavoriteStore>,
    secret: MemorySecret,
    endpoint: Option<&str>,
) -> Result<SyncEngine<MemorySecret>, SyncError> {
    use crate::persistence::{ActivityStore, ExplorationStore, PersistentState};
    let state = PersistentState::with_stores(
        path,
        seen,
        history,
        favorites,
        Arc::new(ExplorationStore::new(path).map_err(|_| SyncError::Persistence)?),
        Arc::new(ActivityStore::new(path).map_err(|_| SyncError::Persistence)?),
    )
    .map_err(|_| SyncError::Persistence)?;
    Ok(SyncEngine::new(
        path,
        Arc::new(state),
        secret,
        endpoint,
        None,
    ))
}

#[tokio::test]
async fn v1_writer_cannot_overwrite_published_v2_after_cas_conflict(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("mixed-version");
    let a = device(&path, &url, MemorySecret::default())?;
    let root = RootSecret::from_bytes(&(0u8..32).collect::<Vec<_>>())?;
    let keys = root.derive();
    let v1 = include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec();
    let transport = SyncTransport::new(&url)?;
    let old_revision = transport
        .create(keys.sync_id(), &keys.client_auth_token(), v1.clone())
        .await?;
    let mut old_change = snapshot::v1::parse_snapshot(include_bytes!(
        "../persistence/tests/fixtures/snapshot-v1.bin"
    ))?;
    old_change.seen.push(99);
    let old_envelope = keys.encrypt_snapshot(&snapshot::v1::serialize_snapshot(&old_change)?)?;
    // A v1 write racing ahead of migration must be included by the v2 CAS retry.
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .v1_on_update = Some(old_envelope);
    a.join(root.recovery_key().as_str(), JoinMode::Merge)
        .await?;
    assert!(a.seen.contains(99));
    let (revision, published) = transport
        .get(keys.sync_id(), &keys.client_auth_token())
        .await?;
    let plain = keys.decrypt_snapshot(keys.sync_id(), &published)?;
    assert_eq!(
        snapshot::decode_snapshot(&plain)?.original_schema_version,
        2
    );
    // The old writer already prepared a v1 PUT. It loses CAS, then its frozen decoder
    // rejects the GET result before another PUT can be built.
    assert_eq!(
        transport
            .update(keys.sync_id(), &keys.client_auth_token(), old_revision, v1)
            .await,
        Err(crate::sync_transport::TransportError::Conflict)
    );
    assert!(matches!(
        snapshot::v1::parse_snapshot(&plain),
        Err(snapshot::v1::SnapshotError::UnsupportedVersion(2))
    ));
    assert_eq!(
        transport
            .get(keys.sync_id(), &keys.client_auth_token())
            .await?
            .0,
        revision
    );
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}
#[tokio::test]
async fn higher_revision_v1_is_rejected_after_v2() -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("schema-downgrade");
    let a = device(&path, &url, MemorySecret::default())?;
    let key = a.create().await?.recovery_key;
    let keys = RootSecret::from_recovery_key(&key)?.derive();
    let before = a.data.snapshot()?.0;
    let old = keys.encrypt_snapshot(include_bytes!(
        "../persistence/tests/fixtures/snapshot-v1.bin"
    ))?;
    {
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.revision += 1;
        state.envelope = old;
    }
    assert!(matches!(
        a.sync_now().await,
        Err(SyncError::SchemaDowngrade)
    ));
    assert_eq!(a.data.snapshot()?.0, before);
    assert!(!a.seen.contains(9));
    drop(a);
    let a = device(
        &path,
        &url,
        MemorySecret {
            value: Arc::new(Mutex::new(Some(
                *RootSecret::from_recovery_key(&key)?.as_bytes(),
            ))),
            ..MemorySecret::default()
        },
    )?;
    assert!(matches!(
        a.sync_now().await,
        Err(SyncError::SchemaDowngrade)
    ));
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}
#[tokio::test]
async fn v1_upgrade_keeps_publication_floor_after_pairing_failure(
) -> Result<(), Box<dyn std::error::Error>> {
    for fail_secret_store in [false, true] {
        let (url, server, task) = server().await?;
        let path = directory("upgrade-pairing-failure");
        let secret = MemorySecret::default();
        secret
            .fail_store
            .store(fail_secret_store, Ordering::Relaxed);
        let a = device(&path, &url, secret)?;
        if !fail_secret_store {
            server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .block_config_on_update = Some(path.clone());
        }
        let root = RootSecret::from_bytes(&(0u8..32).collect::<Vec<_>>())?;
        let keys = root.derive();
        let v1 = include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec();
        SyncTransport::new(&url)?
            .create(keys.sync_id(), &keys.client_auth_token(), v1.clone())
            .await?;
        assert!(matches!(
            a.join(root.recovery_key().as_str(), JoinMode::Merge).await,
            Err(SyncError::SecureStorage | SyncError::Persistence)
        ));
        assert_eq!(a.data.schema_floor(keys.sync_id())?, 2);
        drop(a);
        if !fail_secret_store {
            fs::remove_dir(path.join("sync-config.json.tmp"))?;
        }
        let a = device(&path, &url, MemorySecret::default())?;
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.revision += 1;
            state.envelope = v1;
        }
        assert!(matches!(
            a.join(root.recovery_key().as_str(), JoinMode::Merge).await,
            Err(SyncError::SchemaDowngrade)
        ));
        task.abort();
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
#[tokio::test]
async fn activity_exploration_and_preference_changes_during_upload_remain_dirty(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("v2-inflight");
    let a = device(&path, &url, MemorySecret::default())?;
    a.create().await?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .state_on_update = Some(Arc::clone(&a.data));
    let result = a.sync_now().await?;
    assert!(result.dirty);
    assert_eq!(a.data.activity.viewed_total(), 1);
    assert_eq!(a.data.explored.count(), 1);
    assert_eq!(a.data.preferences.get().history_page_size, Some(50));
    assert!(!a.sync_now().await?.dirty);
    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}
#[tokio::test]
async fn device_identity_stable_across_restart_and_rejoin() -> Result<(), Box<dyn std::error::Error>>
{
    let (url, _server, task) = server().await?;
    let path = directory("device-restart");
    let secret = MemorySecret::default();
    let a = device(&path, &url, secret.clone())?;
    let created = a.create().await?;
    let first_joined = created.status.devices[0].joined_at_ms;
    assert!(first_joined > 0);
    assert!(created.status.devices[0].last_synced_at_ms.is_some());
    let first_id = created
        .status
        .this_device_id
        .clone()
        .ok_or("device id missing after create")?;
    assert_eq!(a.status().await?.this_device_id, Some(first_id.clone()));

    // Restart keeps the same device identity.
    let restarted = device(&path, &url, secret.clone())?;
    let restarted_status = restarted.status().await?;
    assert_eq!(restarted_status.this_device_id, Some(first_id.clone()));
    assert_eq!(restarted_status.devices.len(), 1);
    assert!(restarted_status.devices[0].this_device);
    assert_eq!(restarted_status.devices[0].joined_at_ms, first_joined);
    assert_eq!(
        restarted_status.last_success_at,
        created.status.last_success_at
    );

    // Disconnect keeps identity but drops pairing; rejoin keeps the same ID.
    restarted.leave().await?;
    let after_leave = device(&path, &url, secret.clone())?;
    assert_eq!(
        after_leave.status().await?.this_device_id,
        Some(first_id.clone())
    );
    after_leave
        .join(&created.recovery_key, JoinMode::Merge)
        .await?;
    let rejoined_status = after_leave.status().await?;
    assert_eq!(rejoined_status.this_device_id, Some(first_id.clone()));
    assert_eq!(rejoined_status.devices[0].joined_at_ms, first_joined);

    // A fresh directory with the same recovery key gets a new identity.
    let fresh_path = directory("device-fresh");
    let fresh = device(&fresh_path, &url, MemorySecret::default())?;
    fresh.join(&created.recovery_key, JoinMode::Merge).await?;
    assert_ne!(fresh.status().await?.this_device_id, Some(first_id));

    task.abort();
    fs::remove_dir_all(path)?;
    fs::remove_dir_all(fresh_path)?;
    Ok(())
}

#[tokio::test]
async fn roster_converges_with_this_device_flag() -> Result<(), Box<dyn std::error::Error>> {
    let (url, _server, task) = server().await?;
    let a_path = directory("roster-a");
    let b_path = directory("roster-b");
    let a = device(&a_path, &url, MemorySecret::default())?;
    let b = device(&b_path, &url, MemorySecret::default())?;
    let created = a.create().await?;
    b.join(&created.recovery_key, JoinMode::Merge).await?;
    a.sync_now().await?;
    b.sync_now().await?;

    let a_status = a.status().await?;
    let b_status = b.status().await?;
    assert_eq!(a_status.devices.len(), 2);
    assert_eq!(b_status.devices.len(), 2);
    assert_eq!(a_status.devices.iter().filter(|d| d.this_device).count(), 1);
    assert_eq!(b_status.devices.iter().filter(|d| d.this_device).count(), 1);
    let mut a_ids: Vec<_> = a_status
        .devices
        .iter()
        .map(|d| d.device_id.clone())
        .collect();
    let mut b_ids: Vec<_> = b_status
        .devices
        .iter()
        .map(|d| d.device_id.clone())
        .collect();
    a_ids.sort();
    b_ids.sort();
    assert_eq!(a_ids, b_ids);

    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

#[tokio::test]
async fn failed_put_does_not_advance_last_success_at() -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("failed-put");
    let a = device(&path, &url, MemorySecret::default())?;
    a.create().await?;
    let before = a.status().await?;
    assert!(before.last_success_at.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    a.seen.insert(42)?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .fail_next_update = true;
    assert_eq!(a.sync_now().await.err(), Some(SyncError::ServerError));
    let after = a.status().await?;
    assert_eq!(after.last_success_at, before.last_success_at);
    assert_eq!(
        after.devices[0].last_synced_at_ms,
        before.devices[0].last_synced_at_ms
    );
    assert!(after.dirty);

    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn status_read_does_not_upload_or_change_roster() -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("status-read");
    let a = device(&path, &url, MemorySecret::default())?;
    a.create().await?;
    let before_requests = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .requests;
    let before_devices = a.status().await?.devices.len();

    let status = a.status().await?;
    let after_requests = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .requests;
    assert_eq!(after_requests, before_requests);
    assert_eq!(status.devices.len(), before_devices);

    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn offline_rename_is_dirty_and_publishes_later() -> Result<(), Box<dyn std::error::Error>> {
    let (url, _server, task) = server().await?;
    let path = directory("offline-rename");
    let a = device(&path, &url, MemorySecret::default())?;
    a.create().await?;
    a.sync_now().await?;
    assert!(!a.status().await?.dirty);

    a.data.set_device_name("Living Room")?;
    let status = a.status().await?;
    assert!(status.dirty);
    assert!(status
        .devices
        .iter()
        .any(|d| d.this_device && d.display_name == "Living Room"));

    a.sync_now().await?;
    let published = a.status().await?;
    assert!(!published.dirty);
    assert!(published
        .devices
        .iter()
        .any(|d| d.this_device && d.display_name == "Living Room"));

    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires RANDOM_FRAME_SYNC_E2E_URL pointing to the unmodified local server"]
async fn unmodified_server_recovers_complete_v2_state_on_a_third_device(
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::persistence::{ExplorationOutcome, UserPreferences};
    let url = std::env::var("RANDOM_FRAME_SYNC_E2E_URL")?;
    let paths = [directory("e2e-a"), directory("e2e-b"), directory("e2e-c")];
    fs::create_dir_all(&paths[0])?;
    fs::write(
        paths[0].join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    fs::write(
        paths[0].join("prntsc-explored.txt"),
        include_bytes!("../persistence/tests/fixtures/exploration-v1.txt"),
    )?;
    let a = device(&paths[0], &url, MemorySecret::default())?;
    a.data.accept(
        &HistoryItem {
            source: "prntsc".into(),
            id: "1".into(),
            source_page_url: "https://prnt.sc/1".into(),
            viewed_at: 1,
        },
        true,
    )?;
    a.data.favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "1".into(),
        source_page_url: "https://prnt.sc/1".into(),
        added_at: 1,
    })?;
    a.data.preferences.set(
        UserPreferences {
            theme: Some("dark".into()),
            history_page_size: Some(50),
        },
        false,
    )?;
    assert_eq!(a.data.activity.viewed_total(), 5752);
    let key = a.create().await?.recovery_key;
    let b = device(&paths[1], &url, MemorySecret::default())?;
    for id in [700_001, 700_002, 700_003] {
        b.data
            .discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    b.join(&key, JoinMode::Merge).await?;
    assert_eq!(b.data.activity.viewed_total(), 5755);
    b.data
        .discover(800_000, ExplorationOutcome::Rejected, 2, "2026-10-02")?;
    b.sync_now().await?;
    a.sync_now().await?;
    let c = device(&paths[2], &url, MemorySecret::default())?;
    c.join(&key, JoinMode::Merge).await?;
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
    assert_sync_data_equal(&b.data.snapshot()?.0, &c.data.snapshot()?.0);
    assert_eq!(c.data.activity.viewed_total(), 5755);
    assert_eq!(c.data.explored.counts(), (7, 4, 2, 1));
    assert_eq!(c.data.preferences.get().theme.as_deref(), Some("dark"));
    assert_eq!(
        c.data.history.frame_views()[0].day,
        a.data.history.frame_views()[0].day
    );
    for path in paths {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[tokio::test]
async fn large_migrated_activity_survives_join_cas_restart_and_third_device(
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::persistence::{
        ExplorationOutcome, FavoriteItem, HistoryItem, PersistentState, UserPreferences,
    };
    use crate::snapshot::DeviceMetadata;

    let (url, server, task) = server().await?;
    let a_path = directory("large-activity-a");
    let b_path = directory("large-activity-b");
    let c_path = directory("large-activity-c");
    fs::create_dir_all(&a_path)?;
    fs::write(
        a_path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let a = device(&a_path, &url, MemorySecret::default())?;

    // Seed the Windows-era navigation set in one merge. 1,214 removals leave
    // 4,538 active rows; B contributes three new rows, for 4,541 at convergence.
    let rows: Vec<_> = (0_u64..5752)
        .map(|index| {
            let operation_id = u128::from(index + 1).to_be_bytes();
            let id = (20_000 + index).to_string();
            snapshot::SyncRecord {
                operation_id,
                order_at: index + 1,
                last_view: snapshot::ViewStamp::inferred(index + 1),
                source: "prntsc".into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                id,
            }
        })
        .collect();
    let removals: Vec<_> = rows.iter().take(1214).map(|row| row.operation_id).collect();
    let seen_ids = rows
        .iter()
        .filter_map(|row| crate::sources::prntsc::item_id_value(&row.id).ok())
        .collect::<Vec<_>>();
    a.data.history.merge_sync_state((rows, vec![]))?;
    a.data.seen.merge(seen_ids)?;
    a.data
        .discover(30_000, ExplorationOutcome::Rejected, 1, "2026-10-02")?;
    a.data.favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "20000".into(),
        source_page_url: "https://prnt.sc/20000".into(),
        added_at: 1,
    })?;
    a.data.preferences.set(
        UserPreferences {
            theme: Some("dark".into()),
            history_page_size: Some(50),
        },
        false,
    )?;
    assert_eq!(a.data.activity.viewed_total(), 5752);
    assert_eq!(a.data.history.snapshot().history.len(), 5752);
    let recovery_key = a.create().await?.recovery_key;

    let read_remote =
        || -> Result<(snapshot::SyncSnapshot, usize, usize), Box<dyn std::error::Error>> {
            let envelope = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .envelope
                .clone();
            let root = RootSecret::from_bytes(
                &a.secret
                    .value
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .ok_or("missing test secret")?,
            )?;
            let keys = root.derive();
            let plaintext = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
            let decoded = snapshot::decode_snapshot(&plaintext)?;
            assert_eq!(decoded.original_schema_version, 2);
            Ok((decoded.data, plaintext.len(), envelope.len()))
        };
    let (initial, initial_plaintext_bytes, initial_envelope_bytes) = read_remote()?;
    assert_eq!(snapshot::activity_projection(&initial.activity)?.0, 5752);
    assert_eq!(initial.activity.len(), 2);
    assert_eq!(initial.history.len(), 5752);
    assert_eq!(initial.history_removed.len(), 0);
    assert!(initial_plaintext_bytes > 0);
    assert!(initial_envelope_bytes > initial_plaintext_bytes);
    let initial_diagnostics =
        snapshot::diagnostics(&initial, 2, initial_plaintext_bytes, initial_envelope_bytes)?;
    assert_eq!(initial_diagnostics.schema, 2);
    assert_eq!(initial_diagnostics.viewed_total, 5752);
    assert_eq!(initial_diagnostics.legacy_imports, 1);
    assert_eq!(initial_diagnostics.viewed_discoveries, 0);
    assert_eq!(initial_diagnostics.rejected_discoveries, 1);
    assert_eq!(initial_diagnostics.history, 5752);
    assert_eq!(initial_diagnostics.history_removed, 0);

    let b_secret = MemorySecret::default();
    let b = device(&b_path, &url, b_secret.clone())?;
    // Windows' 1,214 removals are local before first GET, exercising reconciliation
    // against Linux's full 5,752-row publication.
    b.data.history.merge_sync_state((vec![], removals))?;
    // These local views are staged before the first GET as well.
    for (offset, id) in ["900001", "900002", "900003"].into_iter().enumerate() {
        b.data.accept(
            &HistoryItem {
                source: "prntsc".into(),
                id: id.into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                viewed_at: 1_790_000_000_000 + u64::try_from(offset)?,
            },
            false,
        )?;
    }
    // The remote rejects the first PUT after B has durably merged the GET. Restart
    // B before retrying to prove the 5,752-view LegacyImport and its union survive.
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .fail_next_update = true;
    assert_eq!(
        b.join(&recovery_key, JoinMode::Merge).await.err(),
        Some(SyncError::ServerError)
    );
    assert_eq!(b.data.activity.viewed_total(), 5755);
    assert_eq!(read_remote()?.0.activity.len(), 2);
    drop(b);
    let b = device(&b_path, &url, b_secret)?;

    // A CAS collision during the retry forces another GET/merge/PUT round.
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .conflicts_remaining = 1;
    b.join(&recovery_key, JoinMode::Merge).await?;
    b.data.preferences.set_device_metadata(DeviceMetadata {
        display_name: "Regression client".into(),
        platform: "windows".into(),
    })?;
    a.sync_now().await?;
    b.sync_now().await?;

    let read_final =
        || -> Result<(snapshot::SyncSnapshot, usize, usize), Box<dyn std::error::Error>> {
            let (data, plaintext_bytes, envelope_bytes) = read_remote()?;
            let summary = snapshot::activity_projection(&data.activity)?;
            assert_eq!(summary.0, 5755);
            assert_eq!(data.activity.len(), 5);
            assert_eq!(data.activity_removed.len(), 0);
            assert_eq!(data.history.len(), 4541);
            assert_eq!(data.history_removed.len(), 1214);
            assert_eq!(data.favorites.len(), 1);
            assert_eq!(data.seen.len(), 5755);
            assert_eq!(data.exploration.len(), 4);
            assert_eq!(
                data.preferences.theme.as_ref().map(|x| x.value.as_str()),
                Some("dark")
            );
            assert!(data
                .devices
                .iter()
                .any(|x| x.metadata.value.platform == "windows"));
            let reencoded = snapshot::serialize_snapshot(&data)?;
            assert_eq!(reencoded.len(), plaintext_bytes);
            assert!(envelope_bytes > plaintext_bytes);
            assert!(envelope_bytes <= MAX_ENVELOPE);
            let diagnostics = snapshot::diagnostics(&data, 2, plaintext_bytes, envelope_bytes)?;
            assert_eq!(diagnostics.schema, 2);
            assert_eq!(diagnostics.seen, 5755);
            assert_eq!(diagnostics.history, 4541);
            assert_eq!(diagnostics.history_removed, 1214);
            assert_eq!(diagnostics.favorites, 1);
            assert_eq!(diagnostics.exploration, 4);
            assert_eq!(diagnostics.activity, 5);
            assert_eq!(diagnostics.activity_removed, 0);
            assert_eq!(diagnostics.viewed_total, 5755);
            assert_eq!(diagnostics.legacy_imports, 1);
            assert_eq!(diagnostics.viewed_discoveries, 3);
            assert_eq!(diagnostics.rejected_discoveries, 1);
            Ok((data, plaintext_bytes, envelope_bytes))
        };
    let (stable, plaintext_bytes, envelope_bytes) = read_final()?;
    assert!(plaintext_bytes > 0);
    assert!(envelope_bytes > plaintext_bytes);
    assert_eq!(a.data.activity.viewed_total(), 5755);
    assert_eq!(b.data.activity.viewed_total(), 5755);
    assert_eq!(a.data.history.snapshot().history.len(), 4541);
    assert_eq!(b.data.history.snapshot().history.len(), 4541);

    let c = device(&c_path, &url, MemorySecret::default())?;
    c.join(&recovery_key, JoinMode::Merge).await?;
    assert_sync_data_equal(&read_final()?.0, &stable);
    assert_eq!(c.data.activity.viewed_total(), 5755);
    assert_eq!(c.data.history.snapshot().history.len(), 4541);
    assert_eq!(c.data.history.sync_state().1.len(), 1214);
    assert_eq!(c.data.favorites.snapshot().len(), 1);
    assert_eq!(c.data.preferences.get().theme.as_deref(), Some("dark"));

    // Explicit Activity tombstones reduce the Activity projection itself.
    let state_dir = directory("activity-tombstone-only");
    fs::create_dir_all(&state_dir)?;
    fs::write(
        state_dir.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let local = PersistentState::new(&state_dir)?;
    local.activity.clear()?;
    let (snapshot, _) = local.snapshot()?;
    assert_eq!(snapshot.activity.len(), 0);
    assert_eq!(snapshot.activity_removed.len(), 1);
    assert_eq!(local.activity.viewed_total(), 0);

    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    fs::remove_dir_all(c_path)?;
    fs::remove_dir_all(state_dir)?;
    Ok(())
}

#[tokio::test]
async fn v1_remote_without_activity_keeps_local_large_legacy_import(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("large-activity-v1-remote");
    fs::create_dir_all(&path)?;
    fs::write(
        path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let root = RootSecret::from_bytes(&(0_u8..32).collect::<Vec<_>>())?;
    let keys = root.derive();
    let transport = SyncTransport::new(&url)?;
    transport
        .create(
            keys.sync_id(),
            &keys.client_auth_token(),
            include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec(),
        )
        .await?;

    let local = device(&path, &url, MemorySecret::default())?;
    assert_eq!(local.data.activity.viewed_total(), 5752);
    local
        .join(root.recovery_key().as_str(), JoinMode::Merge)
        .await?;
    assert_eq!(local.data.activity.viewed_total(), 5752);

    let envelope = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    let plaintext = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
    let decoded = snapshot::decode_snapshot(&plaintext)?;
    assert_eq!(decoded.original_schema_version, 2);
    assert_eq!(
        snapshot::activity_projection(&decoded.data.activity)?.0,
        5752
    );
    assert_eq!(decoded.data.activity.len(), 1);
    assert_eq!(decoded.data.activity_removed.len(), 0);

    task.abort();
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn windows_published_tombstones_before_linux_import_converge_without_activity_loss(
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::persistence::{ExplorationOutcome, HistoryItem};
    use crate::snapshot::DeviceMetadata;

    let (url, server, task) = server().await?;
    let windows_path = directory("large-activity-windows-first");
    let linux_path = directory("large-activity-linux-second");
    fs::create_dir_all(&linux_path)?;
    fs::write(
        linux_path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    let windows = device(&windows_path, &url, MemorySecret::default())?;
    let linux_secret = MemorySecret::default();
    let linux = device(&linux_path, &url, linux_secret.clone())?;

    // Match removals to Linux's future history operation IDs before the Linux
    // installation joins. This models Windows Sync being published first.
    let future_history_ids = (1_u64..=1214)
        .map(|index| u128::from(index).to_be_bytes())
        .collect::<Vec<_>>();
    windows
        .data
        .history
        .merge_sync_state((vec![], future_history_ids))?;
    for (offset, id) in ["900001", "900002", "900003"].into_iter().enumerate() {
        windows.data.accept(
            &HistoryItem {
                source: "prntsc".into(),
                id: id.into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                viewed_at: 1_790_000_000_000 + u64::try_from(offset)?,
            },
            false,
        )?;
    }
    windows
        .data
        .preferences
        .set_device_metadata(DeviceMetadata {
            display_name: "Windows installation".into(),
            platform: "windows".into(),
        })?;
    let recovery_key = windows.create().await?.recovery_key;
    let (windows_snapshot, windows_generation) = windows.data.snapshot()?;
    let windows_plaintext = snapshot::serialize_snapshot(&windows_snapshot)?;
    let windows_diagnostics =
        snapshot::diagnostics(&windows_snapshot, 2, windows_plaintext.len(), 0)?;
    assert_eq!(windows_generation[4], 3);
    assert_eq!(windows_diagnostics.history, 3);
    assert_eq!(windows_diagnostics.history_removed, 1214);
    assert_eq!(windows_diagnostics.viewed_total, 3);

    let rows: Vec<_> = (0_u64..5752)
        .map(|index| {
            let id = (20_000 + index).to_string();
            snapshot::SyncRecord {
                operation_id: u128::from(index + 1).to_be_bytes(),
                order_at: index + 1,
                last_view: snapshot::ViewStamp::inferred(index + 1),
                source: "prntsc".into(),
                source_page_url: format!("https://prnt.sc/{id}"),
                id,
            }
        })
        .collect();
    let seen_ids = rows
        .iter()
        .filter_map(|row| crate::sources::prntsc::item_id_value(&row.id).ok())
        .collect::<Vec<_>>();
    linux.data.history.merge_sync_state((rows, vec![]))?;
    linux.data.seen.merge(seen_ids)?;
    linux
        .data
        .discover(30_000, ExplorationOutcome::Rejected, 1, "2026-10-02")?;
    assert_eq!(linux.data.activity.viewed_total(), 5752);

    linux.join(&recovery_key, JoinMode::Merge).await?;
    assert_eq!(linux.data.activity.viewed_total(), 5755);
    assert_eq!(linux.data.history.snapshot().history.len(), 4541);
    assert_eq!(linux.data.history.sync_state().1.len(), 1214);
    windows.sync_now().await?;
    linux.sync_now().await?;

    let envelope = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    let keys = linux.secret.load().await?.derive();
    let plaintext = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
    let decoded = snapshot::decode_snapshot(&plaintext)?;
    let diagnostics = snapshot::diagnostics(
        &decoded.data,
        decoded.original_schema_version,
        plaintext.len(),
        envelope.len(),
    )?;
    assert_eq!(diagnostics.schema, 2);
    assert_eq!(diagnostics.history, 4541);
    assert_eq!(diagnostics.history_removed, 1214);
    assert_eq!(diagnostics.viewed_total, 5755);
    assert_eq!(diagnostics.legacy_imports, 1);
    assert_eq!(diagnostics.viewed_discoveries, 3);
    assert_eq!(diagnostics.rejected_discoveries, 1);
    assert_eq!(diagnostics.activity_removed, 0);

    task.abort();
    fs::remove_dir_all(windows_path)?;
    fs::remove_dir_all(linux_path)?;
    Ok(())
}

#[tokio::test]
async fn restore_preserves_earliest_known_self_join() -> Result<(), Box<dyn std::error::Error>> {
    let (url, _, task) = server().await?;
    let a_path = directory("join-time-a");
    let b_path = directory("join-time-b");
    let a = device(&a_path, &url, MemorySecret::default())?;
    let b = device(&b_path, &url, MemorySecret::default())?;
    let mut known = b.data.preferences.sync_state().1;
    known[0].joined_at_ms = 100;
    b.data
        .preferences
        .replace(snapshot::PreferencesV2::default(), known)?;
    let created = a.create().await?;
    let joined = b.join(&created.recovery_key, JoinMode::Restore).await?;
    let self_record = joined
        .devices
        .iter()
        .find(|d| d.this_device)
        .ok_or("missing self")?;
    assert_eq!(self_record.joined_at_ms, 100);
    assert!(self_record.last_synced_at_ms.is_some());
    task.abort();
    fs::remove_dir_all(a_path)?;
    fs::remove_dir_all(b_path)?;
    Ok(())
}

fn self_timestamp(status: &SyncStatus) -> Option<u64> {
    status
        .devices
        .iter()
        .find(|d| d.this_device)
        .and_then(|d| d.last_synced_at_ms)
}

fn published_snapshot(
    server: &Arc<Mutex<ServerState>>,
    key: &str,
) -> Result<snapshot::SyncSnapshot, Box<dyn std::error::Error>> {
    let keys = RootSecret::from_recovery_key(key)?.derive();
    let envelope = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    Ok(snapshot::parse_snapshot(
        &keys.decrypt_snapshot(keys.sync_id(), &envelope)?,
    )?)
}

#[tokio::test]
async fn roster_timestamps_match_create_join_retry_startup_and_remote_publication(
) -> Result<(), Box<dyn std::error::Error>> {
    for mode in [JoinMode::Merge, JoinMode::Restore] {
        let (url, server, task) = server().await?;
        let a_path = directory("timestamp-publish-a");
        let b_path = directory("timestamp-publish-b");
        let a = device(&a_path, &url, MemorySecret::default())?;
        let b = device(&b_path, &url, MemorySecret::default())?;
        let created = a.create().await?;
        let published = published_snapshot(&server, &created.recovery_key)?;
        assert!(created.status.devices[0].joined_at_ms > 0);
        assert_eq!(
            published.devices[0].last_sync.as_ref().map(|r| r.value),
            self_timestamp(&created.status)
        );
        assert!(self_timestamp(&created.status).is_some());
        let b_joined = b.status().await?.devices[0].joined_at_ms;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .force_conflict = true;
        let joined = b.join(&created.recovery_key, mode).await?;
        let published = published_snapshot(&server, &created.recovery_key)?;
        let record = published
            .devices
            .iter()
            .find(|d| d.device_id == b.data.identity.id())
            .ok_or("missing published self")?;
        assert_eq!(record.joined_at_ms, b_joined);
        assert_eq!(
            record.last_sync.as_ref().map(|r| r.value),
            self_timestamp(&joined)
        );
        assert!(self_timestamp(&joined).is_some());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let synced = b.startup_sync().await?;
        assert!(self_timestamp(&synced) > self_timestamp(&joined));
        assert!(synced.last_success_at >= self_timestamp(&synced));
        assert!(!synced.dirty);
        let received = a.sync_now().await?;
        let b_record = received
            .devices
            .iter()
            .find(|d| d.device_id == hex::encode(b.data.identity.id()))
            .ok_or("missing received device")?;
        assert_eq!(b_record.last_synced_at_ms, self_timestamp(&synced));
        assert_eq!(b_record.joined_at_ms, b_joined);
        task.abort();
        fs::remove_dir_all(a_path)?;
        fs::remove_dir_all(b_path)?;
    }
    Ok(())
}

#[tokio::test]
async fn failed_create_and_join_never_record_unpublished_timestamps(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let a_path = directory("timestamp-failure-a");
    let a = device(&a_path, &url, MemorySecret::default())?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .fail_next_create = true;
    assert_eq!(a.create().await.err(), Some(SyncError::ServerError));
    assert_eq!(self_timestamp(&a.status().await?), None);
    let created = a.create().await?;
    for mode in [JoinMode::Merge, JoinMode::Restore] {
        let path = directory("timestamp-failed-join");
        let b = device(&path, &url, MemorySecret::default())?;
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .fail_next_update = true;
        assert_eq!(
            b.join(&created.recovery_key, mode).await.err(),
            Some(SyncError::ServerError)
        );
        assert_eq!(self_timestamp(&b.status().await?), None);
        assert_eq!(
            self_timestamp(
                &device(&path, &url, MemorySecret::default())?
                    .status()
                    .await?
            ),
            None
        );
        assert!(!published_snapshot(&server, &created.recovery_key)?
            .devices
            .iter()
            .any(|d| d.device_id == b.data.identity.id()));
        fs::remove_dir_all(path)?;
    }
    task.abort();
    fs::remove_dir_all(a_path)?;
    Ok(())
}

#[tokio::test]
async fn rejected_sync_and_prepublication_persistence_failure_preserve_roster_timestamp(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let path = directory("timestamp-rejected");
    let secret = MemorySecret::default();
    let a = device(&path, &url, secret.clone())?;
    let created = a.create().await?;
    a.sync_now().await?;
    let before = a.status().await?;
    let original = server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .envelope
        .clone();
    for failure in 0..5 {
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match failure {
                0 => state.rate_limit_next_get = true,
                1 => state.envelope = vec![0; 52],
                2 => state.revision = 1,
                3 => state.conflicts_remaining = MAX_CAS_ATTEMPTS,
                _ => {
                    fs::create_dir(path.join("sync-config.json.tmp"))?;
                }
            }
        }
        let result = a.sync_now().await;
        if failure == 2 {
            assert_eq!(
                result.err(),
                Some(SyncError::ServerRollbackDetected {
                    local_revision: 2,
                    remote_revision: 1,
                })
            );
        } else {
            assert!(result.is_err());
        }
        let after = a.status().await?;
        assert_eq!(self_timestamp(&after), self_timestamp(&before));
        assert_eq!(after.last_success_at, before.last_success_at);
        let mut state = server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.envelope.clone_from(&original);
        state.revision = 2;
    }
    fs::remove_dir(path.join("sync-config.json.tmp"))?;
    task.abort();
    assert!(a.startup_sync().await.is_err());
    assert_eq!(self_timestamp(&a.status().await?), self_timestamp(&before));
    let restarted = device(&path, &url, secret)?;
    assert_eq!(
        self_timestamp(&restarted.status().await?),
        self_timestamp(&before)
    );
    assert_eq!(
        published_snapshot(&server, &created.recovery_key)?.devices[0]
            .last_sync
            .as_ref()
            .map(|r| r.value),
        self_timestamp(&before)
    );
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn published_timestamp_survives_local_save_failure_and_recovers_from_remote(
) -> Result<(), Box<dyn std::error::Error>> {
    for fail_preferences in [true, false] {
        let (url, server, task) = server().await?;
        let path = directory("timestamp-save-failure");
        let a = device(&path, &url, MemorySecret::default())?;
        let created = a.create().await?;
        let before = a.status().await?;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        {
            let mut state = server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if fail_preferences {
                state.block_preferences_on_update = Some(path.clone());
            } else {
                state.block_config_on_update = Some(path.clone());
            }
        }
        assert_eq!(a.sync_now().await.err(), Some(SyncError::Persistence));
        let after = a.status().await?;
        assert_eq!(after.last_success_at, before.last_success_at);
        let published = published_snapshot(&server, &created.recovery_key)?;
        let timestamp = published.devices[0].last_sync.as_ref().map(|r| r.value);
        assert!(timestamp > self_timestamp(&before));
        if fail_preferences {
            assert_eq!(self_timestamp(&after), self_timestamp(&before));
        } else {
            // The roster records a real accepted PUT even if saving local success fails.
            assert_eq!(self_timestamp(&after), timestamp);
        }
        fs::remove_dir(path.join(if fail_preferences {
            "preferences.json.tmp"
        } else {
            "sync-config.json.tmp"
        }))?;
        let other_path = directory("timestamp-save-failure-peer");
        let other = device(&other_path, &url, MemorySecret::default())?;
        let received = other.join(&created.recovery_key, JoinMode::Restore).await?;
        assert_eq!(
            received
                .devices
                .iter()
                .find(|d| !d.this_device)
                .ok_or("missing peer")?
                .last_synced_at_ms,
            timestamp
        );
        a.sync_now().await?;
        assert!(self_timestamp(&a.status().await?) >= timestamp);
        task.abort();
        fs::remove_dir_all(path)?;
        fs::remove_dir_all(other_path)?;
    }
    Ok(())
}
