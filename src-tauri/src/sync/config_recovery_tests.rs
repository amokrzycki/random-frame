use super::*;
use crate::sync::{cas::check_rollback, state::load_config};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn write_config(path: &Path, config: &SyncLocalConfig) -> TestResult {
    fs::write(path, serde_json::to_vec(config)?)?;
    Ok(())
}

#[tokio::test]
async fn backup_and_temporary_recovery_preserve_pairing_across_restarts() -> TestResult {
    for artifact in ["json.bak", "json.tmp"] {
        for torn_temporary in [
            None,
            Some(b"{\"protocolVersion\":".as_slice()),
            Some(b"{broken".as_slice()),
        ] {
            if artifact == "json.tmp" && torn_temporary.is_some() {
                continue;
            }
            let path = directory("config-recovery");
            fs::create_dir_all(&path)?;
            let root = RootSecret::generate();
            let key = root.recovery_key().to_string();
            let mut config = SyncLocalConfig::new(root.derive().sync_id().into(), 42);
            config.last_success_at = Some(123);
            let canonical = path.join("sync-config.json");
            write_config(&canonical.with_extension(artifact), &config)?;
            if let Some(bytes) = torn_temporary {
                fs::write(canonical.with_extension("json.tmp"), bytes)?;
            }
            let secret = MemorySecret::default();
            secret.store(root).await?;
            for _ in 0..2 {
                let engine = device(&path, "https://sync.example.com", secret.clone())?;
                let status = engine.status().await?;
                assert!(status.paired);
                assert_eq!(status.last_success_revision, Some(42));
                assert_eq!(status.snapshot_schema_version, 3);
                assert_eq!(status.last_success_at, Some(123));
                assert_eq!(engine.recovery_key().await?, key);
                let recovered = engine.config()?.ok_or("missing recovered config")?;
                assert_eq!(recovered.sync_id, config.sync_id);
                assert!(matches!(
                    check_rollback(&recovered, 41),
                    Err(SyncError::ServerRollbackDetected { .. })
                ));
                assert!(canonical.is_file());
            }
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

#[test]
fn canonical_precedence_includes_corrupt_canonical_fail_closed() -> TestResult {
    let path = directory("config-canonical");
    fs::create_dir_all(&path)?;
    let canonical = path.join("sync-config.json");
    let current = SyncLocalConfig::new("a".repeat(64), 42);
    write_config(&canonical, &current)?;
    let stale = SyncLocalConfig::new("b".repeat(64), 1);
    for extension in ["json.tmp", "json.bak"] {
        write_config(&canonical.with_extension(extension), &stale)?;
    }
    let before = fs::read(&canonical)?;
    let loaded = load_config(&canonical)?.ok_or("missing canonical")?;
    assert_eq!(loaded.sync_id, current.sync_id);
    assert_eq!(loaded.last_accepted_revision, Some(42));
    assert_eq!(fs::read(&canonical)?, before);
    fs::write(&canonical, b"{broken")?;
    assert_eq!(
        load_config(&canonical).err(),
        Some(SyncError::CorruptLocalState)
    );
    assert_eq!(fs::read(&canonical)?, b"{broken");
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn invalid_candidates_are_never_promoted_or_defaulted() -> TestResult {
    let valid = serde_json::to_value(SyncLocalConfig::new("a".repeat(64), 42))?;
    let mut cases = vec![b"{\"protocolVersion\":".to_vec(), b"[]".to_vec()];
    for (field, value) in [
        ("protocolVersion", serde_json::json!(2)),
        ("syncId", serde_json::json!("G".repeat(64))),
        ("syncId", serde_json::json!("a")),
        ("lastAcceptedRevision", serde_json::json!(0)),
        ("lastAcceptedRevision", serde_json::json!(-1)),
        ("highestSchemaVersion", serde_json::json!(0)),
        ("highestSchemaVersion", serde_json::json!(4)),
        ("unexpected", serde_json::json!(true)),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        cases.push(serde_json::to_vec(&invalid)?);
    }
    for field in ["syncId", "protocolVersion"] {
        let mut invalid = valid.clone();
        invalid
            .as_object_mut()
            .ok_or("not an object")?
            .remove(field);
        cases.push(serde_json::to_vec(&invalid)?);
    }
    let mut oversized = serde_json::to_vec(&valid)?;
    oversized.resize(1025, b' ');
    cases.push(oversized);
    for extension in ["json", "json.tmp", "json.bak"] {
        for bytes in &cases {
            let path = directory("config-invalid");
            fs::create_dir_all(&path)?;
            let canonical = path.join("sync-config.json");
            let candidate = canonical.with_extension(extension);
            fs::write(&candidate, bytes)?;
            assert_eq!(
                load_config(&canonical).err(),
                Some(SyncError::CorruptLocalState)
            );
            assert_eq!(fs::read(&candidate)?, *bytes);
            if extension != "json" {
                assert!(!canonical.exists());
            }
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

#[test]
fn temporary_must_not_roll_back_or_change_backup_identity() -> TestResult {
    for regression in 0..4 {
        let path = directory("config-floors");
        fs::create_dir_all(&path)?;
        let canonical = path.join("sync-config.json");
        let backup = SyncLocalConfig::new("a".repeat(64), 42);
        let mut temporary = backup.clone();
        match regression {
            0 => temporary.last_accepted_revision = Some(41),
            1 => temporary.last_accepted_revision = None,
            2 => temporary.highest_schema_version = 1,
            _ => temporary.sync_id = "b".repeat(64),
        }
        write_config(&canonical.with_extension("json.bak"), &backup)?;
        write_config(&canonical.with_extension("json.tmp"), &temporary)?;
        assert_eq!(
            load_config(&canonical).err(),
            Some(SyncError::CorruptLocalState)
        );
        assert!(!canonical.exists());
        assert!(canonical.with_extension("json.bak").exists());
        assert!(canonical.with_extension("json.tmp").exists());
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[test]
fn valid_temporary_takes_precedence_over_backup_without_lowering_floors() -> TestResult {
    let path = directory("config-newer-temporary");
    fs::create_dir_all(&path)?;
    let canonical = path.join("sync-config.json");
    let mut backup = SyncLocalConfig::new("a".repeat(64), 41);
    backup.highest_schema_version = 1;
    let temporary = SyncLocalConfig::new(backup.sync_id.clone(), 42);
    write_config(&canonical.with_extension("json.bak"), &backup)?;
    write_config(&canonical.with_extension("json.tmp"), &temporary)?;
    for _ in 0..2 {
        let config = load_config(&canonical)?.ok_or("missing temporary")?;
        assert_eq!(config.last_accepted_revision, Some(42));
        assert_eq!(config.highest_schema_version, 3);
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn incompatible_or_oversized_temporary_does_not_fall_back_to_older_backup() -> TestResult {
    for oversized in [false, true] {
        let path = directory("config-unsafe-fallback");
        fs::create_dir_all(&path)?;
        let canonical = path.join("sync-config.json");
        let backup = SyncLocalConfig::new("a".repeat(64), 42);
        write_config(&canonical.with_extension("json.bak"), &backup)?;
        let mut invalid = serde_json::to_value(&backup)?;
        invalid["highestSchemaVersion"] = serde_json::json!(4);
        let mut bytes = serde_json::to_vec(&invalid)?;
        if oversized {
            bytes.resize(1025, b' ');
        }
        fs::write(canonical.with_extension("json.tmp"), &bytes)?;
        assert_eq!(
            load_config(&canonical).err(),
            Some(SyncError::CorruptLocalState)
        );
        assert!(!canonical.exists());
        assert_eq!(fs::read(canonical.with_extension("json.tmp"))?, bytes);
        assert!(canonical.with_extension("json.bak").exists());
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[test]
fn legacy_config_and_exact_size_limit_remain_supported() -> TestResult {
    let path = directory("config-legacy");
    fs::create_dir_all(&path)?;
    let canonical = path.join("sync-config.json");
    let mut legacy = serde_json::to_value(SyncLocalConfig::new("a".repeat(64), 42))?;
    legacy
        .as_object_mut()
        .ok_or("not an object")?
        .remove("highestSchemaVersion");
    legacy
        .as_object_mut()
        .ok_or("not an object")?
        .remove("lastSuccessAt");
    let mut bytes = serde_json::to_vec(&legacy)?;
    bytes.resize(1024, b' ');
    fs::write(canonical.with_extension("json.bak"), &bytes)?;
    let config = load_config(&canonical)?.ok_or("missing legacy config")?;
    assert_eq!(config.highest_schema_version, 1);
    assert_eq!(config.last_success_at, None);
    assert_eq!(config.last_accepted_revision, Some(42));
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn corrupt_backup_or_unreadable_candidate_cannot_be_bypassed() -> TestResult {
    for unreadable_temporary in [false, true] {
        let path = directory("config-candidate-error");
        fs::create_dir_all(&path)?;
        let canonical = path.join("sync-config.json");
        let valid = SyncLocalConfig::new("a".repeat(64), 42);
        let expected = if unreadable_temporary {
            write_config(&canonical.with_extension("json.bak"), &valid)?;
            fs::create_dir(canonical.with_extension("json.tmp"))?;
            SyncError::Persistence
        } else {
            fs::write(canonical.with_extension("json.bak"), b"{broken")?;
            write_config(&canonical.with_extension("json.tmp"), &valid)?;
            SyncError::CorruptLocalState
        };
        assert_eq!(load_config(&canonical).err(), Some(expected));
        assert!(!canonical.exists());
        assert!(canonical.with_extension("json.bak").exists());
        assert!(canonical.with_extension("json.tmp").exists());
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[tokio::test]
async fn recovered_backup_retains_remote_revision_schema_and_publication_guards() -> TestResult {
    for guard in [
        "revision",
        "config-schema",
        "schema-ledger",
        "publication-ledger",
    ] {
        let (url, server, task) = server().await?;
        let path = directory("config-recovered-guards");
        let secret = MemorySecret::default();
        let engine = device(&path, &url, secret.clone())?;
        let root = RootSecret::from_bytes(&(0u8..32).collect::<Vec<_>>())?;
        let keys = root.derive();
        let v1 = include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec();
        SyncTransport::new(&url)?
            .create(keys.sync_id(), &keys.client_auth_token(), v1)
            .await?;
        let mut config = SyncLocalConfig::new(keys.sync_id().into(), 42);
        if guard != "config-schema" {
            config.highest_schema_version = 1;
        }
        write_config(&engine.path.with_extension("json.bak"), &config)?;
        secret.store(root).await?;
        if guard == "schema-ledger" {
            engine.data.begin_publication(keys.sync_id(), 40, 3)?;
            engine.data.complete_publication(keys.sync_id())?;
        } else if guard == "publication-ledger" {
            engine.data.begin_publication(keys.sync_id(), 40, 2)?;
        }
        drop(engine);
        server
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .revision = if guard == "revision" { 41 } else { 43 };
        let restarted = device(&path, &url, secret)?;
        let before = restarted.data.snapshot()?.0;
        let expected = if guard == "revision" {
            SyncError::ServerRollbackDetected {
                local_revision: 42,
                remote_revision: 41,
            }
        } else {
            SyncError::SchemaDowngrade
        };
        assert_eq!(restarted.startup_sync().await.err(), Some(expected));
        assert_eq!(restarted.data.snapshot()?.0, before);
        assert_eq!(
            restarted
                .config()?
                .ok_or("missing recovered floor")?
                .last_accepted_revision,
            Some(42)
        );
        task.abort();
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[tokio::test]
async fn absent_config_and_recovery_identity_are_checked_against_credentials() -> TestResult {
    for extension in [None, Some("json.tmp"), Some("json.bak")] {
        let path = directory("config-secret");
        let secret = MemorySecret::default();
        let engine = device(&path, "https://sync.example.com", secret.clone())?;
        assert!(!engine.status().await?.paired);
        secret.store(RootSecret::generate()).await?;
        if let Some(extension) = extension {
            write_config(
                &engine.path.with_extension(extension),
                &SyncLocalConfig::new("a".repeat(64), 42),
            )?;
        }
        assert_eq!(
            engine.status().await.err(),
            Some(SyncError::CorruptLocalState)
        );
        assert_eq!(
            engine.recovery_key().await.err(),
            Some(if extension.is_some() {
                SyncError::CorruptLocalState
            } else {
                SyncError::Unpaired
            })
        );
        assert_eq!(
            engine.sync_now().await.err(),
            Some(if extension.is_some() {
                SyncError::CorruptLocalState
            } else {
                SyncError::Unpaired
            })
        );
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[tokio::test]
async fn leave_removes_every_recovery_artifact_and_allows_rejoin() -> TestResult {
    for artifacts in [
        vec![],
        vec!["json.bak"],
        vec!["json.tmp"],
        vec!["json.bak", "json.tmp"],
    ] {
        let (url, _, task) = server().await?;
        let path = directory("leave-artifacts");
        let secret = MemorySecret::default();
        let engine = device(&path, &url, secret.clone())?;
        let created = engine.create().await?;
        let config = engine.config()?.ok_or("missing pairing")?;
        for extension in artifacts {
            write_config(&engine.path.with_extension(extension), &config)?;
        }
        assert!(!engine.leave().await?.paired);
        for extension in ["json", "json.tmp", "json.bak"] {
            assert!(!engine.path.with_extension(extension).exists());
        }
        assert_eq!(secret.load().await.err(), Some(StorageError::Missing));
        drop(engine);
        let restarted = device(&path, &url, secret)?;
        assert!(!restarted.startup_sync().await?.paired);
        assert!(
            restarted
                .join(&created.recovery_key, JoinMode::Merge)
                .await?
                .paired
        );
        task.abort();
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[tokio::test]
async fn interrupted_leave_fails_closed_and_cleanup_can_be_retried() -> TestResult {
    let path = directory("leave-interrupted");
    let secret = MemorySecret::default();
    let engine = device(&path, "https://sync.example.com", secret.clone())?;
    let root = RootSecret::generate();
    let config = SyncLocalConfig::new(root.derive().sync_id().into(), 42);
    secret.store(root).await?;
    engine.save(&config)?;
    // A removal failure must leave canonical metadata and credentials available for retry.
    fs::create_dir(engine.path.with_extension("json.tmp"))?;
    assert_eq!(engine.leave().await.err(), Some(SyncError::Persistence));
    assert!(secret.load().await.is_ok());
    assert!(engine.path.is_file());
    fs::remove_dir(engine.path.with_extension("json.tmp"))?;
    // Simulate a crash after all config removals but before secure-store deletion.
    fs::remove_file(&engine.path)?;
    drop(engine);
    let restarted = device(&path, "https://sync.example.com", secret.clone())?;
    assert_eq!(
        restarted.status().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    assert!(!restarted.leave().await?.paired);
    assert_eq!(secret.load().await.err(), Some(StorageError::Missing));
    drop(restarted);
    assert!(
        !device(&path, "https://sync.example.com", secret)?
            .status()
            .await?
            .paired
    );
    fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn leave_secret_deletion_failure_keeps_config_removal_retryable() -> TestResult {
    let path = directory("leave-secret-failure");
    let secret = MemorySecret::default();
    let engine = device(&path, "https://sync.example.com", secret.clone())?;
    let root = RootSecret::generate();
    let config = SyncLocalConfig::new(root.derive().sync_id().into(), 42);
    secret.store(root).await?;
    engine.save(&config)?;
    for extension in ["json.tmp", "json.bak"] {
        write_config(&engine.path.with_extension(extension), &config)?;
    }
    secret.fail_delete.store(true, Ordering::Relaxed);
    assert_eq!(engine.leave().await.err(), Some(SyncError::SecureStorage));
    assert!(secret.load().await.is_ok());
    for extension in ["json", "json.tmp", "json.bak"] {
        assert!(!engine.path.with_extension(extension).exists());
    }
    drop(engine);
    let restarted = device(&path, "https://sync.example.com", secret.clone())?;
    assert!(restarted.config()?.is_none());
    assert_eq!(
        restarted.status().await.err(),
        Some(SyncError::CorruptLocalState)
    );
    secret.fail_delete.store(false, Ordering::Relaxed);
    assert!(!restarted.leave().await?.paired);
    assert_eq!(secret.load().await.err(), Some(StorageError::Missing));
    fs::remove_dir_all(path)?;
    Ok(())
}
