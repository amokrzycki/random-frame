//! Client sync facade.
mod cas;
mod engine;
mod errors;
mod reconcile;
mod state;

pub use engine::SyncEngine;
pub use errors::SyncError;
#[allow(unused_imports, reason = "preserve the sync module API")]
pub use state::{CreateSyncResult, SyncLocalConfig, SyncState, SyncStatus};

#[cfg(test)]
mod tests;
