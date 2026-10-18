use super::{engine::SyncEngine, errors::SyncError, state::SyncStatus};
use crate::{persistence::transaction::Generation, secure_storage::SecretStore};
use std::time::Duration;
use tokio::sync::watch;

const DEBOUNCE: Duration = Duration::from_secs(1);
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(5);

// A quiet period batches mutations; it is not a delay used to guess upload completion.
async fn next_batch(changes: &mut watch::Receiver<Generation>) -> bool {
    if changes.changed().await.is_err() {
        return false;
    }
    loop {
        match tokio::time::timeout(DEBOUNCE, changes.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return false,
            Err(_) => return true,
        }
    }
}

impl<S: SecretStore> SyncEngine<S> {
    pub async fn run_background(&self, mut changes: watch::Receiver<Generation>) {
        while next_batch(&mut changes).await {
            // No timer retries on failure. A mutation, focus/resume, restart or explicit Sync retries.
            let _ = self.sync_pending().await;
        }
    }

    async fn sync_pending(&self) -> Result<SyncStatus, SyncError> {
        // Wait for manual/admin operations, then recheck: they may have published this generation.
        let _guard = self.operation.lock().await;
        if !self.status_snapshot().dirty || (self.config()?.is_none() && self.journal()?.is_none())
        {
            return Ok(self.status_snapshot());
        }
        self.set_state(super::state::SyncState::Syncing, None, None);
        let result = self.sync_inner().await;
        self.finish(&result);
        result
    }

    pub async fn flush_pending(&self) -> Result<SyncStatus, SyncError> {
        // One attempt, including lock acquisition. Edits during upload remain dirty for later retry.
        // Cancellation leaves its durable journal intact.
        if let Ok(result) = tokio::time::timeout(SHUTDOWN_BUDGET, self.sync_pending()).await {
            result
        } else {
            let result = Err(SyncError::Timeout);
            self.finish(&result);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn rapid_mutations_share_one_batch_and_reset_the_quiet_period(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (tx, mut rx) = watch::channel([0; 6]);
        let batch = tokio::spawn(async move { next_batch(&mut rx).await });
        for n in 1..=10 {
            tx.send_replace([n; 6]);
            tokio::time::advance(Duration::from_millis(100)).await;
            tokio::task::yield_now().await;
            assert!(!batch.is_finished());
        }
        tokio::time::advance(DEBOUNCE).await;
        assert!(batch.await?);
        Ok(())
    }
}
