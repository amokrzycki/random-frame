//! Aggregate-only instrumentation, excluded from release builds.
use super::{activity_projection, ActivityOperation, Outcome, SnapshotError, SyncSnapshot};

#[derive(Debug, PartialEq, Eq)]
pub struct SnapshotDiagnostics {
    pub schema: u32,
    pub plaintext_bytes: usize,
    pub envelope_bytes: usize,
    pub seen: usize,
    pub history: usize,
    pub history_removed: usize,
    pub favorites: usize,
    pub favorites_removed: usize,
    pub exploration: usize,
    pub activity: usize,
    pub activity_removed: usize,
    pub viewed_total: u64,
    pub legacy_imports: usize,
    pub viewed_discoveries: usize,
    pub rejected_discoveries: usize,
}

pub fn diagnostics(
    snapshot: &SyncSnapshot,
    schema: u32,
    plaintext_bytes: usize,
    envelope_bytes: usize,
) -> Result<SnapshotDiagnostics, SnapshotError> {
    let mut counts = SnapshotDiagnostics {
        schema,
        plaintext_bytes,
        envelope_bytes,
        seen: snapshot.seen.len(),
        history: snapshot.history.len(),
        history_removed: snapshot.history_removed.len(),
        favorites: snapshot.favorites.len(),
        favorites_removed: snapshot.favorites_removed.len(),
        exploration: snapshot.exploration.len(),
        activity: snapshot.activity.len(),
        activity_removed: snapshot.activity_removed.len(),
        viewed_total: activity_projection(&snapshot.activity)?.0,
        legacy_imports: 0,
        viewed_discoveries: 0,
        rejected_discoveries: 0,
    };
    for operation in &snapshot.activity {
        match operation {
            ActivityOperation::LegacyImport { .. } => counts.legacy_imports += 1,
            ActivityOperation::Discovery { outcome, .. } => match outcome {
                Outcome::Viewed => counts.viewed_discoveries += 1,
                Outcome::Rejected => counts.rejected_discoveries += 1,
            },
        }
    }
    Ok(counts)
}

pub(crate) fn diagnostics_enabled() -> bool {
    std::env::var_os("RANDOM_FRAME_SYNC_DIAGNOSTICS").is_some_and(|value| value == "1")
}

#[allow(
    clippy::print_stderr,
    reason = "opt-in aggregate diagnostics in debug builds only"
)]
pub(crate) fn report_diagnostics(
    stage: &str,
    snapshot: &SyncSnapshot,
    schema: u32,
    plaintext_bytes: usize,
    envelope_bytes: usize,
) {
    if diagnostics_enabled() {
        if let Ok(counts) = diagnostics(snapshot, schema, plaintext_bytes, envelope_bytes) {
            // This type contains only numbers. Never add keys, IDs, URLs or contents.
            eprintln!("[sync:{stage}] {counts:?}");
        }
    }
}

pub(crate) fn report_upload(plaintext: &[u8], envelope: &[u8]) {
    if diagnostics_enabled() {
        if let Ok(decoded) = super::decode_snapshot(plaintext) {
            report_diagnostics(
                "before_upload",
                &decoded.data,
                decoded.original_schema_version,
                plaintext.len(),
                envelope.len(),
            );
        }
    }
}
