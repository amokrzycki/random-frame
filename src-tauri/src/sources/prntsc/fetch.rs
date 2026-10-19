//! One keyed raw pipeline, shared by viewer and preview consumers; dropping the last cancels it.
use super::{
    item_id_value, value_to_base36, AppError, Arc, Duration, ErrorKind, FetchedFrame, HashMap,
    Mutex, Prntsc,
};
use crate::rate_limit::RateLimiter;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Weak,
};
use tokio::sync::{watch, Notify, Semaphore};

// Default upstream pause when Retry-After header is absent or unparseable
const DEFAULT_PAUSE_MS: u64 = 10_000;

type ResultFrame = Result<FetchedFrame, AppError>;
struct Admission {
    preview_only: AtomicBool,
    promoted: Notify,
}
pub(super) struct RawJob {
    admission: Arc<Admission>,
    serial: u64,
    result: watch::Sender<Option<ResultFrame>>,
    abort: Mutex<Option<tokio::task::AbortHandle>>,
}
impl Drop for RawJob {
    fn drop(&mut self) {
        if let Some(abort) = self
            .abort
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            abort.abort();
        }
    }
}
pub(super) struct Fetches {
    jobs: Mutex<HashMap<String, Weak<RawJob>>>,
    serial: AtomicU64,
    total: Semaphore,
    previews: Semaphore,
    viewer_waiting: AtomicUsize,
    viewer_changed: Notify,
    limiter: Mutex<RateLimiter>,
    pause: Mutex<Option<(std::time::Instant, AppError)>>,
}
impl Default for Fetches {
    fn default() -> Self {
        Self {
            jobs: Mutex::default(),
            serial: AtomicU64::new(0),
            total: Semaphore::new(3),
            previews: Semaphore::new(2),
            viewer_waiting: AtomicUsize::new(0),
            viewer_changed: Notify::new(),
            limiter: Mutex::new(RateLimiter::new()),
            pause: Mutex::new(None),
        }
    }
}
struct Waiting<'a>(&'a AtomicUsize, &'a Notify);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
        self.1.notify_waiters();
    }
}
impl Prntsc {
    pub async fn raw_frame(&self, id: &str, preview: bool, retry: bool) -> ResultFrame {
        let id = value_to_base36(item_id_value(id)?);
        let job = {
            let mut jobs = self
                .fetches
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(job) = jobs.get(&id).and_then(Weak::upgrade) {
                job
            } else {
                jobs.retain(|_, job| job.strong_count() > 0);
                let job = Arc::new(RawJob {
                    admission: Arc::new(Admission {
                        preview_only: AtomicBool::new(preview),
                        promoted: Notify::new(),
                    }),
                    serial: self.fetches.serial.fetch_add(1, Ordering::Relaxed),
                    result: watch::channel(None).0,
                    abort: Mutex::new(None),
                });
                jobs.insert(id.clone(), Arc::downgrade(&job));
                drop(jobs);
                let weak = Arc::downgrade(&job);
                let source = self.clone();
                let admission = job.admission.clone();
                let task = tokio::spawn(async move {
                    let result = source.admitted_fetch(&id, &admission, retry).await;
                    if let Some(job) = weak.upgrade() {
                        job.result.send_replace(Some(result));
                        let mut jobs = source
                            .fetches
                            .jobs
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if jobs
                            .get(&id)
                            .and_then(Weak::upgrade)
                            .is_some_and(|current| current.serial == job.serial)
                        {
                            jobs.remove(&id);
                        }
                    }
                });
                *job.abort
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task.abort_handle());
                job
            }
        };
        if !preview {
            job.admission.preview_only.store(false, Ordering::SeqCst);
            job.admission.promoted.notify_waiters();
        }
        let mut result = job.result.subscribe();
        loop {
            let completed = result.borrow().clone();
            if let Some(result) = completed {
                return result;
            }
            result
                .changed()
                .await
                .map_err(|_| AppError::new(ErrorKind::Network, "Request canceled"))?;
        }
    }
    #[allow(
        clippy::too_many_lines,
        reason = "Keep admission, cancellation and upstream pause ownership in one auditable pipeline"
    )]
    async fn admitted_fetch(&self, id: &str, admission: &Admission, retry: bool) -> ResultFrame {
        let promoted = admission.promoted.notified();
        let mut preview_permit = if admission.preview_only.load(Ordering::SeqCst) {
            tokio::select! {
                permit = self.fetches.previews.acquire() => Some(permit.map_err(|_| AppError::invalid_input("Preview service closed"))?),
                () = promoted => None,
            }
        } else {
            None
        };
        let preview = admission.preview_only.load(Ordering::SeqCst);
        if !preview {
            preview_permit = None;
        }
        let waiting = if preview {
            None
        } else {
            self.fetches.viewer_waiting.fetch_add(1, Ordering::SeqCst);
            Some(Waiting(
                &self.fetches.viewer_waiting,
                &self.fetches.viewer_changed,
            ))
        };
        if preview {
            loop {
                let changed = self.fetches.viewer_changed.notified();
                if self.fetches.viewer_waiting.load(Ordering::SeqCst) == 0 {
                    break;
                }
                changed.await;
            }
        }
        let _total = self
            .fetches
            .total
            .acquire()
            .await
            .map_err(|_| AppError::invalid_input("Source service closed"))?;
        drop(waiting);
        if admission.preview_only.load(Ordering::SeqCst) {
            let mut pause = self
                .fetches
                .pause
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((until, error)) = pause.as_ref() {
                if !retry || *until > std::time::Instant::now() {
                    return Err(error.clone());
                }
                *pause = None;
            }
        }
        loop {
            let delay = {
                let mut limiter = self
                    .fetches
                    .limiter
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let delay = limiter.delay_until_token(std::time::Instant::now());
                if delay.is_zero() {
                    limiter.take()?;
                }
                delay
            };
            if delay.is_zero() {
                break;
            }
            tokio::time::sleep(delay).await;
        }
        if retry {
            self.resolved
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
        }
        let result = async {
            let item = self.resolve_item(id).await?;
            self.fetch_asset(item).await
        }
        .await;
        if let Err(error) = &result {
            if matches!(
                error.kind,
                ErrorKind::UpstreamForbidden | ErrorKind::UpstreamRateLimited
            ) {
                let delay = Duration::from_millis(error.retry_after_ms.unwrap_or(DEFAULT_PAUSE_MS));
                let until = std::time::Instant::now()
                    .checked_add(delay)
                    .unwrap_or_else(std::time::Instant::now);
                *self
                    .fetches
                    .pause
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some((until, error.clone()));
            }
            if error.is_classified_source_outcome() {
                self.resolved
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(id);
            }
        }
        drop(preview_permit);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Notify,
    };
    #[tokio::test]
    async fn shared_jobs_coalesce_and_last_consumer_cancels_all_admission(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("nearby-raw-{}", rand::random::<u64>()));
        let data = Arc::new(crate::persistence::PersistentState::new(&directory)?);
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let pages = Arc::new(AtomicUsize::new(0));
        let waiting = Arc::new(Notify::new());
        let count = pages.clone();
        let release = waiting.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let count = count.clone();
                let release = release.clone();
                tokio::spawn(async move {
                    let mut request = [0; 1024];
                    let _ = stream.read(&mut request).await;
                    count.fetch_add(1, Ordering::SeqCst);
                    release.notified().await;
                    let _=stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                });
            }
        });
        let source = super::Prntsc::new(data)?.with_test_base(base);
        let a = source.clone();
        let first = tokio::spawn(async move { a.raw_frame("abc123", true, false).await });
        let b = source.clone();
        let second = tokio::spawn(async move { b.raw_frame("0abc123", false, false).await });
        for _ in 0..100 {
            if pages.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(pages.load(Ordering::SeqCst), 1);
        first.abort(); // The viewer consumer keeps the shared pipeline alive.
        waiting.notify_waiters();
        assert_eq!(
            second.await?.err().map(|e| e.kind),
            Some(ErrorKind::NotFound)
        );
        let mut pending = Vec::new();
        for id in ["abc124", "abc125", "abc126", "abc127"] {
            let s = source.clone();
            pending.push(tokio::spawn(
                async move { s.raw_frame(id, true, false).await },
            ));
        }
        let s = source.clone();
        pending.push(tokio::spawn(async move {
            s.raw_frame("abc128", false, false).await
        }));
        for _ in 0..100 {
            if source.fetches.total.available_permits() == 0 && pages.load(Ordering::SeqCst) == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(source.fetches.total.available_permits(), 0);
        assert_eq!(source.fetches.previews.available_permits(), 0);
        assert_eq!(pages.load(Ordering::SeqCst), 4); // Two previews, one viewer, plus the earlier shared request.
        for handle in pending {
            handle.abort();
        }
        for _ in 0..100 {
            if source.fetches.total.available_permits() == 3 {
                break;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(source.fetches.total.available_permits(), 3);
        assert_eq!(source.fetches.previews.available_permits(), 2);
        assert_eq!(
            pages.load(Ordering::SeqCst),
            4,
            "queued obsolete jobs never start"
        );
        server.abort();
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[tokio::test]
    async fn upstream_pause_requires_explicit_retry_even_after_retry_after_expires(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for (status, retry_after) in [
            (403, "0"),
            (429, "0"),
            (429, "Wed, 21 Oct 2015 07:28:00 GMT"),
        ] {
            let directory =
                std::env::temp_dir().join(format!("nearby-pause-{}", rand::random::<u64>()));
            let data = Arc::new(crate::persistence::PersistentState::new(&directory)?);
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let base = format!("http://{}", listener.local_addr()?);
            let pages = Arc::new(AtomicUsize::new(0));
            let count = pages.clone();
            let server = tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let mut request = [0; 1024];
                    let _ = stream.read(&mut request).await;
                    let first = count.fetch_add(1, Ordering::SeqCst) == 0;
                    let response = if first {
                        format!("HTTP/1.1 {status} Paused\r\nRetry-After: {retry_after}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    } else {
                        "HTTP/1.1 410 Gone\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            });
            let source = Prntsc::new(data)?.with_test_base(base);
            let error = source
                .raw_frame("abc123", true, false)
                .await
                .err()
                .ok_or("expected pause")?;
            assert_eq!(error.retry_after_ms, Some(0));
            assert!(!error.is_classified_source_outcome());
            assert_eq!(
                source
                    .raw_frame("abc124", true, false)
                    .await
                    .err()
                    .map(|e| e.kind),
                Some(error.kind)
            );
            assert_eq!(
                pages.load(Ordering::SeqCst),
                1,
                "automatic work remains paused"
            );
            assert_eq!(
                source
                    .raw_frame("abc124", true, true)
                    .await
                    .err()
                    .map(|e| e.kind),
                Some(ErrorKind::NotFound)
            );
            assert_eq!(
                pages.load(Ordering::SeqCst),
                2,
                "only explicit retry restarts source work"
            );
            server.abort();
            std::fs::remove_dir_all(directory)?;
        }
        Ok(())
    }
}
