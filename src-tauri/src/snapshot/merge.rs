use super::{
    validate_snapshot, ActivityOperation, ExplorationRecord, OperationId, PreferencesV2, Register,
    SnapshotError, SyncSnapshot,
};
use std::collections::{BTreeMap, BTreeSet};
fn union<T: Ord + Clone>(a: &[T], b: &[T]) -> Vec<T> {
    a.iter()
        .chain(b)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn operations<T: Clone + PartialEq>(
    a: &[T],
    b: &[T],
    key: impl Fn(&T) -> OperationId,
    merge: impl Fn(&mut T, &T) -> Result<(), SnapshotError>,
) -> Result<Vec<T>, SnapshotError> {
    let mut result = BTreeMap::new();
    for item in a.iter().chain(b) {
        match result.entry(key(item)) {
            std::collections::btree_map::Entry::Vacant(e) => {
                e.insert(item.clone());
            }
            std::collections::btree_map::Entry::Occupied(mut e) => merge(e.get_mut(), item)?,
        }
    }
    Ok(result.into_values().collect())
}
fn immutable<T: PartialEq>(a: &mut T, b: &T) -> Result<(), SnapshotError> {
    if a != b {
        return Err(SnapshotError::ConflictingOperation);
    }
    Ok(())
}
fn register<T: Clone + PartialEq>(
    a: Option<&Register<T>>,
    b: Option<&Register<T>>,
) -> Result<Option<Register<T>>, SnapshotError> {
    match (a, b) {
        (Some(a), Some(b)) => {
            if a.operation_id == b.operation_id && a != b {
                return Err(SnapshotError::ConflictingOperation);
            }
            Ok(Some(if a.stamp() >= b.stamp() { a } else { b }.clone()))
        }
        _ => Ok(a.or(b).cloned()),
    }
}
pub fn merge_snapshots(a: &SyncSnapshot, b: &SyncSnapshot) -> Result<SyncSnapshot, SnapshotError> {
    validate_snapshot(a)?;
    validate_snapshot(b)?;
    let mut result = SyncSnapshot {
        seen: union(&a.seen, &b.seen),
        history: operations(
            &a.history,
            &b.history,
            |x| x.operation_id,
            |a, b| {
                if a.order_at != b.order_at
                    || a.source != b.source
                    || a.id != b.id
                    || a.source_page_url != b.source_page_url
                {
                    return Err(SnapshotError::ConflictingOperation);
                }
                if b.last_view.key() > a.last_view.key() {
                    a.last_view = b.last_view.clone();
                }
                Ok(())
            },
        )?,
        history_removed: union(&a.history_removed, &b.history_removed),
        favorites: operations(&a.favorites, &b.favorites, |x| x.operation_id, immutable)?,
        favorites_removed: union(&a.favorites_removed, &b.favorites_removed),
        activity: operations(
            &a.activity,
            &b.activity,
            ActivityOperation::operation_id,
            immutable,
        )?,
        activity_removed: union(&a.activity_removed, &b.activity_removed),
        preferences: PreferencesV2 {
            theme: register(a.preferences.theme.as_ref(), b.preferences.theme.as_ref())?,
            history_page_size: register(
                a.preferences.history_page_size.as_ref(),
                b.preferences.history_page_size.as_ref(),
            )?,
        },
        devices: operations(
            &a.devices,
            &b.devices,
            |x| x.device_id,
            |a, b| {
                a.metadata = register(Some(&a.metadata), Some(&b.metadata))?
                    .ok_or(SnapshotError::InvalidValue)?;
                a.last_sync = register(a.last_sync.as_ref(), b.last_sync.as_ref())?;
                a.joined_at_ms = a.joined_at_ms.min(b.joined_at_ms);
                Ok(())
            },
        )?,
        ..SyncSnapshot::default()
    };
    let mut evidence = BTreeMap::new();
    for x in a.exploration.iter().chain(&b.exploration) {
        *evidence
            .entry((x.source.clone(), x.id.clone()))
            .or_insert(0) |= x.evidence;
    }
    result.exploration = evidence
        .into_iter()
        .map(|((source, id), evidence)| ExplorationRecord {
            source,
            id,
            evidence,
        })
        .collect();
    let history_removed: BTreeSet<_> = result.history_removed.iter().copied().collect();
    let favorites_removed: BTreeSet<_> = result.favorites_removed.iter().copied().collect();
    let activity_removed: BTreeSet<_> = result.activity_removed.iter().copied().collect();
    result
        .history
        .retain(|x| !history_removed.contains(&x.operation_id));
    result
        .favorites
        .retain(|x| !favorites_removed.contains(&x.operation_id));
    result
        .activity
        .retain(|x| !activity_removed.contains(&x.operation_id()));
    validate_snapshot(&result)?;
    Ok(result)
}

/// Reconciliation is a persistence invariant, separate from the pure CRDT union.
pub(crate) fn reconcile_seen(snapshot: &mut SyncSnapshot) {
    // Reconciliation never invents Activity.
    let viewed = snapshot
        .history
        .iter()
        .filter(|x| x.source == "prntsc")
        .map(|x| &x.id)
        .chain(
            snapshot
                .exploration
                .iter()
                .filter(|x| x.source == "prntsc" && x.evidence & 1 != 0)
                .map(|x| &x.id),
        )
        .filter_map(|id| crate::sources::prntsc::item_id_value(id).ok());
    snapshot.seen = snapshot
        .seen
        .iter()
        .copied()
        .chain(viewed)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
}
