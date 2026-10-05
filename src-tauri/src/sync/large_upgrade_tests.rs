use super::*;
use crate::persistence::ExplorationOutcome;

fn migrated_device(
    path: &Path,
    url: &str,
    secret: MemorySecret,
) -> Result<SyncEngine<MemorySecret>, Box<dyn std::error::Error>> {
    fs::create_dir_all(path)?;
    fs::write(
        path.join("activity.json"),
        include_bytes!("../persistence/tests/fixtures/activity-large-legacy.json"),
    )?;
    Ok(device(path, url, secret)?)
}

#[tokio::test]
async fn v1_upgrade_retains_large_activity_with_both_join_orders_and_cas_race(
) -> Result<(), Box<dyn std::error::Error>> {
    for windows_first in [false, true] {
        let (url, server, task) = server().await?;
        let paths = [
            directory("upgrade-a"),
            directory("upgrade-b"),
            directory("upgrade-c"),
        ];
        let root = RootSecret::from_bytes(&(0_u8..32).collect::<Vec<_>>())?;
        let keys = root.derive();
        let v1 = include_bytes!("../persistence/tests/fixtures/envelope-v1.bin").to_vec();
        SyncTransport::new(&url)?
            .create(keys.sync_id(), &keys.client_auth_token(), v1.clone())
            .await?;
        let a_secret = MemorySecret::default();
        let a = migrated_device(&paths[0], &url, a_secret.clone())?;
        let b = device(&paths[1], &url, MemorySecret::default())?;
        for id in [700_001, 700_002, 700_003] {
            b.data
                .discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
        }
        if windows_first {
            // Linux durably accepts the old GET, then exits before any PUT.
            super::super::reconcile::SyncData { state: &a.data }.merge_remote(&keys, &v1, 1, 1)?;
            let imported_ids = a.data.activity.sync_state().0;
            assert_eq!(a.data.activity.viewed_total(), 5752);
            drop(a);
            // Windows publishes its three local operations while Linux is offline.
            b.join(root.recovery_key().as_str(), JoinMode::Merge)
                .await?;
            let a = device(&paths[0], &url, a_secret)?;
            assert!(
                a.data.activity.sync_state().0 == imported_ids,
                "restart preserves import IDs"
            );
            a.join(root.recovery_key().as_str(), JoinMode::Merge)
                .await?;
            assert_eq!(a.data.activity.viewed_total(), 5755);
            b.sync_now().await?;
        } else {
            // A final v1 write wins the first CAS during Linux's upgrade.
            server
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .v1_on_update = Some(v1);
            a.join(root.recovery_key().as_str(), JoinMode::Merge)
                .await?;
            assert_eq!(a.data.activity.viewed_total(), 5752);
            b.join(root.recovery_key().as_str(), JoinMode::Merge)
                .await?;
            a.sync_now().await?;
            assert_eq!(a.data.activity.viewed_total(), 5755);
        }
        assert_eq!(b.data.activity.viewed_total(), 5755);
        b.sync_now().await?;
        assert_eq!(b.data.activity.viewed_total(), 5755);
        let c = device(&paths[2], &url, MemorySecret::default())?;
        c.join(root.recovery_key().as_str(), JoinMode::Merge)
            .await?;
        assert_eq!(c.data.activity.viewed_total(), 5755);
        assert_eq!(c.data.activity.sync_state().1.len(), 0);
        assert_eq!(c.data.activity.sync_state().0.len(), 4);
        task.abort();
        for path in paths {
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn concurrent_cas_retry_retains_new_remote_and_local_activity_above_large_import(
) -> Result<(), Box<dyn std::error::Error>> {
    let (url, server, task) = server().await?;
    let paths = [directory("cas-large-a"), directory("cas-large-b")];
    let a = migrated_device(&paths[0], &url, MemorySecret::default())?;
    let key = a.create().await?.recovery_key;
    let keys = RootSecret::from_recovery_key(&key)?.derive();
    let b = device(&paths[1], &url, MemorySecret::default())?;
    for id in [700_001, 700_002, 700_003] {
        b.data
            .discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    // A distinct offline discovery is published by a competing writer between
    // B's GET and first PUT. The test hook accepts either encrypted wire schema.
    a.data
        .discover(800_000, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    let concurrent = snapshot::serialize_snapshot(&a.data.snapshot()?.0)?;
    server
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .v1_on_update = Some(keys.encrypt_snapshot(&concurrent)?);
    b.join(&key, JoinMode::Merge).await?;
    a.sync_now().await?;
    assert_eq!(b.data.activity.viewed_total(), 5756);
    assert_eq!(a.data.activity.viewed_total(), 5756);
    let active = a.data.activity.sync_state().0;
    assert_eq!(active.len(), 5);
    assert!(
        b.data.activity.sync_state().0 == active,
        "CAS retry retains both operation sets"
    );
    assert_eq!(a.data.activity.sync_state().1.len(), 0);
    task.abort();
    for path in paths {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
