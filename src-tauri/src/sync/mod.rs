//! Client sync facade.
mod admin;
mod cas;
mod engine;
mod errors;
mod managed;
mod reconcile;
mod state;

pub use engine::SyncEngine;
pub use errors::SyncError;
#[allow(unused_imports, reason = "preserve the sync module API")]
pub use state::{
    CreateManagedSyncResult, JoinMode, LocalSyncSummary, SyncLocalConfig, SyncState, SyncStatus,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod membership_tests;

#[cfg(test)]
mod managed_collections_tests;
