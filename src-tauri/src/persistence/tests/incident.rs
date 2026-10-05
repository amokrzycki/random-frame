//! Opt-in incident inspection. Stores open ONLY in disposable copies of the profiles.
use super::*;
use crate::sync_crypto::RootSecret;
use std::collections::BTreeSet;

#[test]
#[ignore = "requires RF_SYNC_FORENSIC_BEFORE, RF_SYNC_FORENSIC_AFTER, RF_SYNC_FORENSIC_WINDOWS"]
fn preserved_incident_profiles_explain_history_reduction_without_activity_loss(
) -> Result<(), Box<dyn std::error::Error>> {
    let directory = test_directory("incident-copies");
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let result = inspect_copies(&directory);
    fs::remove_dir_all(directory)?;
    result
}

#[allow(
    clippy::print_stderr,
    reason = "opt-in forensic test reports aggregate measurements only"
)]
fn inspect_copies(directory: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut snapshots = Vec::new();
    for (label, variable) in [
        ("linux_before", "RF_SYNC_FORENSIC_BEFORE"),
        ("linux_after", "RF_SYNC_FORENSIC_AFTER"),
        ("windows_after", "RF_SYNC_FORENSIC_WINDOWS"),
    ] {
        let source = PathBuf::from(std::env::var(variable)?);
        let copy = directory.join(label);
        fs::create_dir(&copy)?;
        // Deliberately excludes sync-config and all browser/keychain data.
        for name in [
            "activity.json",
            "activity-v2.json",
            "history.json",
            "history-v3.json",
            "favorites.json",
            "favorites-v3.json",
            "exploration-v2.json",
            "prntsc-seen.json",
            "state-migration.json",
            "state-transaction.json",
            "preferences.json",
            "device-identity.json",
        ] {
            for suffix in ["", ".tmp", ".bak"] {
                let file = format!("{name}{suffix}");
                if source.join(&file).exists() {
                    fs::copy(source.join(&file), copy.join(&file))?;
                }
            }
        }
        let state = PersistentState::new(&copy)?;
        let (snapshot, _) = state.snapshot()?;
        let plaintext = snapshot::serialize_snapshot(&snapshot)?;
        let keys = RootSecret::generate().derive();
        let envelope = keys.encrypt_snapshot(&plaintext)?;
        let decrypted = keys.decrypt_snapshot(keys.sync_id(), &envelope)?;
        let decoded = snapshot::decode_snapshot(&decrypted)?;
        assert!(
            decoded.data == snapshot,
            "round trip changes incident snapshot"
        );
        let viewed = snapshot::activity_projection(&snapshot.activity)?.0;
        eprintln!(
            "{label}: schema=2 plaintext={} envelope={} seen={} history={} history_removed={} favorites={} favorites_removed={} exploration={} activity={} activity_removed={} viewed_total={viewed}",
            plaintext.len(), envelope.len(), snapshot.seen.len(), snapshot.history.len(),
            snapshot.history_removed.len(), snapshot.favorites.len(), snapshot.favorites_removed.len(),
            snapshot.exploration.len(), snapshot.activity.len(), snapshot.activity_removed.len(),
        );
        snapshots.push(snapshot);
    }
    let before = &snapshots[0];
    let after = &snapshots[1];
    let windows = &snapshots[2];
    assert_eq!(before.history.len(), 5752);
    assert_eq!(after.history.len(), 4541);
    assert_eq!(windows.history.len(), 4541);
    assert_eq!(snapshot::activity_projection(&before.activity)?.0, 5739);
    assert_eq!(snapshot::activity_projection(&after.activity)?.0, 5755);
    assert_eq!(snapshot::activity_projection(&windows.activity)?.0, 5755);
    assert_eq!(before.activity_removed.len(), 0);
    assert_eq!(after.activity_removed.len(), 0);
    assert_eq!(windows.activity_removed.len(), 0);

    let pre_ids: BTreeSet<_> = before.history.iter().map(|op| op.operation_id).collect();
    let post_ids: BTreeSet<_> = after.history.iter().map(|op| op.operation_id).collect();
    let lost: BTreeSet<_> = pre_ids.difference(&post_ids).copied().collect();
    let legacy_windows: serde_json::Value = serde_json::from_slice(&fs::read(
        PathBuf::from(std::env::var("RF_SYNC_FORENSIC_WINDOWS")?).join("history.json"),
    )?)?;
    let old_removals: Vec<[u8; 16]> =
        serde_json::from_value(legacy_windows["removed_history_ops"].clone())?;
    let old_removals: BTreeSet<_> = old_removals.into_iter().collect();
    assert_eq!(lost.len(), 1214);
    assert!(
        lost == old_removals,
        "every loss must match a legacy Windows removal"
    );
    assert_eq!(post_ids.difference(&pre_ids).count(), 3);

    // The first count reduction is exactly the operation/tombstone union.
    let merged = snapshot::merge_snapshots(before, windows)?;
    assert_eq!(merged.history.len(), 4541);
    assert_eq!(snapshot::activity_projection(&merged.activity)?.0, 5755);
    assert!(
        merged.activity == after.activity,
        "Activity operations remain unchanged"
    );
    assert!(
        merged.history == after.history,
        "History losses follow existing removals"
    );
    Ok(())
}
