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
                        if state.fail_next_update {
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
                            if let Some((seen, id)) = state.insert_on_update.take() {
                                let _ = seen.insert(id);
                            }
                            if let Some((history, item)) = state.history_on_update.take() {
                                let _ = history.record(item);
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
    Ok(SyncEngine::new(
        path,
        seen,
        history,
        favorites,
        secret,
        Some(url),
    ))
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
    b.join(&created.recovery_key).await?;
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
        let engine = SyncEngine::new(
            path,
            seen,
            Arc::clone(&history),
            Arc::clone(&favorites),
            secret,
            Some(&url),
        );
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
    b.join(&created.recovery_key).await?;
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
    let a = device(&root.join("a"), &url, a_secret.clone())?;
    let b = device(&root.join("b"), &url, MemorySecret::default())?;
    a.seen.insert(101)?;
    b.seen.insert(202)?;
    let created = a.create().await?;
    assert!(created.local_pairing_error.is_none());
    assert_eq!(created.status.last_success_revision, Some(1));
    assert_eq!(
        b.join(&created.recovery_key).await?.last_success_revision,
        Some(2)
    );
    assert!(b.seen.contains(101));
    a.seen.insert(303)?;
    b.seen.insert(404)?;
    assert_eq!(a.sync_now().await?.last_success_revision, Some(3));
    assert_eq!(b.sync_now().await?.last_success_revision, Some(4));
    assert_eq!(a.sync_now().await?.last_success_revision, Some(5));
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
        vec![101, 202, 303, 404]
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
        vec![101, 202, 303, 404, 505, 606]
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
        b.join(&created.recovery_key).await?.last_success_revision,
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
        b.join(&partial.recovery_key).await.err(),
        Some(SyncError::ServerError)
    );
    assert!(b.seen.contains(1));
    assert!(b.seen.contains(2));
    assert!(!b_path.join("sync-config.json").exists());
    b.join(&partial.recovery_key).await?;
    let c_path = directory("partial-c");
    let c_secret = MemorySecret::default();
    c_secret.fail_store.store(true, Ordering::Relaxed);
    let c = device(&c_path, &url, c_secret.clone())?;
    c.seen.insert(3)?;
    assert_eq!(
        c.join(&partial.recovery_key).await.err(),
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
        engine.join("wrong").await.err(),
        Some(SyncError::InvalidRecoveryKey)
    );
    let created = engine.create().await?;
    let other_path = directory("bad-other");
    let other = device(&other_path, &url, MemorySecret::default())?;
    assert_eq!(
        other
            .join(&RootSecret::generate().recovery_key())
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
        b.join(&created.recovery_key).await.err(),
        Some(SyncError::Conflict)
    );
    assert!(b.config()?.is_none());
    assert!(b_secret.load().await.is_err());
    assert!(b.seen.contains(1) && b.seen.contains(2));

    let joined = b.join(&created.recovery_key).await?;
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
