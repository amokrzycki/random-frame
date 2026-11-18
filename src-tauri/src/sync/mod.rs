//! Client sync facade.
mod cas;
mod commit;
mod engine;
mod errors;
mod group;
mod helpers;
mod lifecycle;
mod observe;
mod reconcile;
mod state;
mod vault;

pub use engine::SyncEngine;
pub use errors::SyncError;
#[allow(unused_imports, reason = "preserve the sync module API")]
pub use state::{CreateSyncResult, JoinMode, LocalSyncSummary, SyncLocalConfig, SyncStatus};

#[cfg(test)]
mod tests;
