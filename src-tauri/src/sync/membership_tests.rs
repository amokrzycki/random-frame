#![allow(
    clippy::many_single_char_names,
    clippy::too_many_lines,
    reason = "End-to-end scenarios keep short labels for six independent devices"
)]
use super::tests::{assert_sync_data_equal, device, directory, MemorySecret};
use super::*;
use crate::{
    secure_storage::SecretStore, sync_membership_crypto as crypto, sync_transport::SyncTransport,
};
use std::{
    fs,
    process::{Child, Command, Stdio},
    sync::atomic::Ordering,
};
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn start(root: &std::path::Path) -> Result<(Server, String), Box<dyn std::error::Error>> {
    fs::create_dir_all(root)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    drop(listener);
    let server = Server(
        Command::new(std::env::var("RF_SYNC_SERVER_BIN")?)
            .env("RF_SYNC_BIND", address.to_string())
            .env("RF_SYNC_DB", root.join("sync.db"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?,
    );
    let url = format!("http://{address}");
    for _ in 0..40 {
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
#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises actual HTTP and SQLite"]
async fn real_server_managed_move_rotation_recovery_dissolve(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = directory("managed-e2e");
    let (server, url) = start(&root).await?;
    let a_secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, a_secret.clone())?;
    a.seen.insert(101)?;
    let legacy = a.create().await?;
    let old = crate::sync_crypto::RootSecret::from_recovery_key(&legacy.recovery_key)?.derive();
    let transport = SyncTransport::new(&url)?;
    let original = transport
        .get(old.sync_id(), &old.client_auth_token())
        .await?;
    let created = a.move_to_managed_sync().await?;
    assert_eq!(created.source_legacy_id.as_deref(), Some(old.sync_id()));
    assert_eq!(
        created.status.control.master_member_id,
        created.status.control.this_member_id
    );
    assert_eq!(
        transport
            .get(old.sync_id(), &old.client_auth_token())
            .await?,
        original
    );
    assert!(a_secret.load().await.is_err());
    let group = created.group_id.clone();
    let admin = created.admin_recovery_code;
    let master = created
        .status
        .control
        .this_member_id
        .clone()
        .ok_or("no master")?;
    let b = device(&root.join("b"), &url, MemorySecret::default())?;
    b.seen.insert(202)?;
    let invite = a.create_invitation(&b.pairing_request().await?).await?;
    a.startup_sync().await?;
    assert_eq!(a.invitation_code().await?, invite);
    let joined = b.join(&invite, JoinMode::Merge).await?;
    assert_ne!(
        joined.control.this_member_id.as_deref(),
        Some(master.as_str())
    );
    assert_eq!(
        b.recovery_key().await.err(),
        Some(SyncError::MasterRequired)
    );
    assert_eq!(
        b.dissolve_group().await.err(),
        Some(SyncError::MasterRequired)
    );
    assert_eq!(
        b.remove_device(&master).await.err(),
        Some(SyncError::MasterRequired)
    );
    let c_secret = MemorySecret::default();
    let c = device(&root.join("c"), &url, c_secret.clone())?;
    let invite = a.create_invitation(&c.pairing_request().await?).await?;
    c.join(&invite, JoinMode::Restore).await?;
    let removed = joined.control.this_member_id.ok_or("no member")?;
    c.seen.insert(303)?;
    a.remove_device(&removed).await?;
    assert_eq!(a.status().await?.control.key_epoch, Some(2));
    assert_eq!(b.sync_now().await.err(), Some(SyncError::Revoked));
    assert!(b.seen.contains(202));
    assert!(!b.status().await?.paired);
    let d = device(&root.join("d"), &url, MemorySecret::default())?;
    let invite = a.create_invitation(&d.pairing_request().await?).await?;
    let joined = d.join(&invite, JoinMode::Merge).await?;
    a.remove_device(&joined.control.this_member_id.ok_or("no member")?)
        .await?;
    // C missed two epochs and keeps its unsent operation while automatically opening the current package.
    let status = c.startup_sync().await?;
    assert_eq!(status.control.key_epoch, Some(3));
    assert!(c.seen.contains(303));
    a.sync_now().await?;
    assert!(a.seen.contains(303));
    let old_vault = a.vault().await?;
    let old_credentials = old_vault.current.as_ref().ok_or("no creds")?;
    let old_token = crypto::token(&old_credentials.token);
    let e_secret = MemorySecret::default();
    let e = device(&root.join("e"), &url, e_secret.clone())?;
    e.seen.insert(999)?;
    let prepared = e.recover_admin(&admin, false).await?;
    assert!(prepared.prepared);
    assert_eq!(
        e.join(&legacy.recovery_key, JoinMode::Restore).await.err(),
        Some(SyncError::PendingOperation)
    );
    assert!(e.seen.contains(999));
    assert_eq!(
        e.startup_sync().await.err(),
        Some(SyncError::PendingOperation)
    );
    assert!(a.status().await?.paired);
    let new_code = prepared.admin_recovery_code.clone();
    drop(e);
    let e = device(&root.join("e"), &url, e_secret.clone())?;
    let recovered = e.recover_admin("", true).await?;
    assert_eq!(recovered.admin_recovery_code, new_code);
    assert_eq!(
        recovered.status.control.this_member_id.as_deref(),
        Some(master.as_str())
    );
    assert_eq!(recovered.status.control.credential_version, Some(2));
    assert!(!e.seen.contains(999));
    assert!(e.seen.contains(303));
    assert_eq!(
        a.sync_now().await.err(),
        Some(SyncError::CredentialReplaced)
    );
    assert!(transport
        .managed(
            &group,
            "snapshot",
            reqwest::Method::GET,
            &old_token,
            None,
            None
        )
        .await
        .is_err());
    let f = device(&root.join("f"), &url, MemorySecret::default())?;
    assert_eq!(
        f.recover_admin(&admin, false)
            .await
            .err()
            .map(|e| e.category()),
        Some("missing_chain")
    );
    c.seen.insert(404)?;
    c.sync_now().await?;
    e.sync_now().await?;
    assert!(e.seen.contains(404));
    assert_eq!(e.leave().await.err(), Some(SyncError::MasterCannotLeave));
    let prepared = f.recover_admin(&new_code, false).await?;
    assert!(prepared.prepared);
    f.cancel_admin_recovery().await?;
    assert!(f.journal()?.is_none());
    assert!(e.status().await?.paired);
    f.recover_admin(&new_code, false).await?;
    let second = f.recover_admin("", true).await?;
    assert_eq!(second.status.control.credential_version, Some(3));
    assert_eq!(
        second.status.control.this_member_id.as_deref(),
        Some(master.as_str())
    );
    c.startup_sync().await?;
    let ended = f.dissolve_group().await?;
    assert_eq!(ended.control.group_state.as_deref(), Some("closed"));
    assert!(c.startup_sync().await.is_err());
    assert_eq!(
        c.status().await?.control.group_state.as_deref(),
        Some("closed")
    );
    assert!(c.seen.contains(404));
    assert!(f.seen.contains(404));
    // The old legacy group was untouched by both create and dissolve.
    assert_eq!(
        transport
            .get(old.sync_id(), &old.client_auth_token())
            .await?,
        original
    );
    drop(server);
    fs::remove_dir_all(root)?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires RF_SYNC_SERVER_BIN; exercises durable requests after lost responses"]
async fn real_server_managed_journal_keyring_and_recovery_timeout(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = directory("managed-journal");
    let (server, url) = start(&root).await?;
    let secret = MemorySecret::default();
    let a = device(&root.join("a"), &url, secret.clone())?;
    secret.fail_store.store(true, Ordering::Relaxed);
    assert_eq!(
        a.create_managed().await.err().map(|e| e.category()),
        Some("secure_storage")
    );
    assert!(a.journal()?.is_none());
    secret.fail_store.store(false, Ordering::Relaxed);
    let created = a.create_managed().await?;
    let b_secret = MemorySecret::default();
    let b = device(&root.join("b"), &url, b_secret.clone())?;
    b.recover_admin(&created.admin_recovery_code, false).await?;
    let mut j = b.journal()?.ok_or("no journal")?;
    let exact = b.request_bytes(&j)?;
    j.confirmed = true;
    crate::persistence::save_json(&b.admin_path(), &Some(&j))?;
    let mut v = b.vault().await?;
    let auth = v.auth.as_ref().ok_or("no auth")?;
    // HTTP committed, but the app never received a result or promoted its local credentials.
    b.call_v2(
        &j.group_id,
        &j.route,
        reqwest::Method::POST,
        auth,
        None,
        Some(exact.clone()),
    )
    .await?;
    v.current = v.pending.take();
    b.save_vault(&v).await?;
    drop(b);
    let b = device(&root.join("b"), &url, b_secret)?;
    assert_eq!(b.request_bytes(&j)?, exact);
    let recovered = b.recover_admin("", false).await?;
    assert!(!recovered.prepared);
    assert!(b.journal()?.is_none());
    assert_eq!(recovered.status.control.credential_version, Some(2));
    let c = device(&root.join("c"), &url, MemorySecret::default())?;
    assert!(c
        .recover_admin(&created.admin_recovery_code, false)
        .await
        .is_err());
    assert_sync_data_equal(&a.data.snapshot()?.0, &b.data.snapshot()?.0);
    let s = b.status().await?;
    let config = b.config()?.ok_or("no config")?;
    assert_eq!(s.control.key_epoch, Some(2));
    assert_eq!(config.managed.ok_or("no managed")?.epoch, 2);
    drop(server);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn windows_move_config_promotion_requires_its_pending_journal(
) -> Result<(), Box<dyn std::error::Error>> {
    use super::state::{load_config, ManagedConfig, SyncLocalConfig};
    use crate::sync_protocol::{Mutation, PairingRequest, RecoveryRegistration, Request};
    let root = directory("move-config-promotion");
    fs::create_dir_all(&root)?;
    let path = root.join("sync-config.json");
    let old = SyncLocalConfig::new("11".repeat(32), 999);
    let mut next = SyncLocalConfig::new("22".repeat(32), 1);
    next.protocol_version = 2;
    next.managed = Some(ManagedConfig {
        member_id: "33".repeat(16),
        credential_version: 1,
        key_id: "44".repeat(32),
        epoch: 1,
        terminal: None,
        legacy_source_id: Some(old.sync_id.clone()),
        adoption: None,
        left_locally: false,
    });
    fs::write(path.with_extension("json.bak"), serde_json::to_vec(&old)?)?;
    fs::write(path.with_extension("json.tmp"), serde_json::to_vec(&next)?)?;
    assert_eq!(load_config(&path).err(), Some(SyncError::CorruptLocalState));
    let j = super::admin::Journal {
        version: 2,
        group_id: next.sync_id.clone(),
        request: Request {
            operation_id: "55".repeat(16),
            expected_revision: 0,
            expected_epoch: 0,
            mutation: Mutation::Create {
                member: PairingRequest {
                    member_id: "33".repeat(16),
                    device_id: "66".repeat(16),
                    token_verifier: "77".repeat(32),
                    wrapping_public_key: "88".repeat(32),
                    nonce: "99".repeat(32),
                },
                recovery: RecoveryRegistration {
                    generation: 1,
                    token_verifier: "aa".repeat(32),
                    public_key: "bb".repeat(32),
                },
                key_id: "44".repeat(32),
                packages: vec![],
            },
        },
        request_hash: "cc".repeat(32),
        route: "create".into(),
        promote: true,
        restore: false,
        legacy_source_id: Some(old.sync_id),
        join_mode: None,
        confirmed: true,
        generation: None,
        self_record: None,
    };
    crate::persistence::save_json(&root.join("sync-admin.json"), &Some(j))?;
    let recovered = load_config(&path)?.ok_or("missing config")?;
    assert_eq!(recovered.sync_id, next.sync_id);
    assert_eq!(recovered.last_accepted_revision, Some(1));
    assert_eq!(recovered.protocol_version, 2);
    fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn managed_config_fits_the_existing_strict_limit() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = super::state::SyncLocalConfig::new("ff".repeat(32), i64::MAX);
    config.protocol_version = 2;
    config.last_success_at = Some(u64::MAX);
    config.managed = Some(super::state::ManagedConfig {
        member_id: "ff".repeat(16),
        credential_version: i64::MAX,
        key_id: "ff".repeat(32),
        epoch: i64::MAX,
        terminal: Some("credential_replaced".into()),
        legacy_source_id: Some("ff".repeat(32)),
        adoption: Some(JoinMode::Restore),
        left_locally: false,
    });
    let bytes = serde_json::to_vec(&config)?;
    assert!(bytes.len() <= 1024);
    let path = directory("managed-config-limit");
    fs::create_dir_all(&path)?;
    let file = path.join("sync-config.json");
    fs::write(&file, bytes)?;
    assert!(super::state::load_config(&file)?.is_some());
    fs::write(&file, vec![b' '; 1025])?;
    assert_eq!(
        super::state::load_config(&file).err(),
        Some(SyncError::CorruptLocalState)
    );
    fs::remove_dir_all(path)?;
    Ok(())
}
