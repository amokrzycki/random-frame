//! Ephemeral window membership and bounded previews; durable checks belong to `PersistentState`.
mod thumbnail;
use crate::{
    error::{AppError, ErrorKind},
    persistence::{ExplorationOutcome, PersistentState},
    sources::prntsc::{self, FetchedFrame, Prntsc},
    thumbnail_cache::ThumbnailCache,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

// ponytail: preview cache caps are tuned for the 9-tile window; raise if the grid grows
const MAX_PREVIEW_CACHE: usize = 27;
const HANDOFF_TTL_SECS: u64 = 30;
// Evidence bitmask: bit 0 (1) = viewed, bit 1 (2) = rejected. Value 2 = rejected-only.
const EVIDENCE_REJECTED_ONLY: u8 = 2;

#[derive(Clone)]
enum Verified {
    Available(Arc<Vec<u8>>),
    Unavailable,
}
struct Session {
    id: String,
    generation: u64,
    anchor: String,
    wanted: HashSet<String>,
    handles: HashMap<String, String>,
}
#[derive(Default)]
struct Inner {
    session: Option<Session>,
    previews: HashMap<String, Verified>,
    order: VecDeque<String>,
    handoff: Option<(Instant, FetchedFrame)>,
}
pub struct Nearby {
    inner: Arc<Mutex<Inner>>,
    changes: watch::Sender<u64>,
    decoder: Arc<Semaphore>,
    resolves: Semaphore,
}
impl Default for Nearby {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            changes: watch::channel(0).0,
            decoder: Arc::new(Semaphore::new(1)),
            resolves: Semaphore::new(2),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub window: prntsc::NearbyWindow,
    pub evidence: BTreeMap<String, u8>,
}
#[derive(Clone, Serialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Resolution {
    Available {
        source: String,
        id: String,
        source_page_url: String,
        thumbnail_handle: String,
    },
    Unavailable {
        reason: String,
    },
    Retryable {
        kind: ErrorKind,
        message: String,
        retry_after_ms: Option<u64>,
    },
    Unsaved {
        kind: ErrorKind,
        message: String,
    },
    Canceled,
}
impl Nearby {
    pub fn set_window(
        &self,
        session_id: &str,
        generation: u64,
        center: &str,
        anchor: &str,
        data: &PersistentState,
    ) -> Result<WindowState, AppError> {
        if session_id.is_empty() || session_id.len() > 80 || generation == 0 {
            return Err(AppError::invalid_input("Invalid Nearby session"));
        }
        let window = prntsc::nearby_window(center)?;
        let anchor = prntsc::value_to_base36(prntsc::item_id_value(anchor)?);
        let wanted: HashSet<_> = window
            .slots
            .iter()
            .filter_map(|slot| slot.id.clone())
            .collect();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(current) = &inner.session {
            if current.id == session_id
                && (generation <= current.generation || anchor != current.anchor)
            {
                return Err(AppError::invalid_input("Stale Nearby window"));
            }
        }
        let handles = wanted
            .iter()
            .map(|id| {
                let previous = inner
                    .session
                    .as_ref()
                    .filter(|s| s.id == session_id)
                    .and_then(|s| s.handles.get(id))
                    .cloned();
                (
                    id.clone(),
                    previous.unwrap_or_else(|| format!("{:032x}", rand::random::<u128>())),
                )
            })
            .collect();
        inner.session = Some(Session {
            id: session_id.into(),
            generation,
            anchor,
            wanted: wanted.clone(),
            handles,
        });
        drop(inner);
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
        let evidence = data.read(|| {
            Ok(wanted
                .into_iter()
                .filter_map(|id| {
                    prntsc::item_id_value(&id)
                        .ok()
                        .and_then(|value| data.explored.evidence(value))
                        .map(|e| (id, e))
                })
                .collect())
        })?;
        Ok(WindowState { window, evidence })
    }
    fn member(&self, session_id: &str, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .session
            .as_ref()
            .is_some_and(|s| s.id == session_id && s.wanted.contains(id))
    }
    fn remember(&self, session_id: &str, id: &str, value: Verified, frame: Option<FetchedFrame>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.order.retain(|key| key != id);
        inner.order.push_back(id.into());
        inner.previews.insert(id.into(), value);
        if let Some(frame) = frame.filter(|frame| {
            frame.bytes.len() <= prntsc::MAX_IMAGE_BYTES
                && inner
                    .session
                    .as_ref()
                    .is_some_and(|s| s.id == session_id && s.wanted.contains(id))
        }) {
            let at = Instant::now();
            inner.handoff = Some((at, frame));
            let cache = Arc::downgrade(&self.inner);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(HANDOFF_TTL_SECS)).await;
                if let Some(cache) = cache.upgrade() {
                    let mut inner = cache
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if inner
                        .handoff
                        .as_ref()
                        .is_some_and(|(created, _)| *created == at)
                    {
                        inner.handoff = None;
                    }
                }
            });
        }
        while inner.previews.len() > MAX_PREVIEW_CACHE {
            let Some(old) = inner.order.pop_front() else {
                break;
            };
            if inner
                .session
                .as_ref()
                .is_some_and(|s| s.wanted.contains(&old))
            {
                inner.order.push_back(old);
            } else {
                inner.previews.remove(&old);
            }
        }
        drop(inner);
    }
    fn commit(
        &self,
        session_id: &str,
        id: &str,
        verified: &Verified,
        data: &PersistentState,
    ) -> Resolution {
        let result = prntsc::item_id_value(id).and_then(|id| {
            data.record_check(
                id,
                match verified {
                    Verified::Available(_) => ExplorationOutcome::Viewed,
                    Verified::Unavailable => ExplorationOutcome::Rejected,
                },
            )
        });
        if let Err(error) = result {
            return Resolution::Unsaved {
                kind: ErrorKind::Persistence,
                message: error.message,
            };
        }
        match verified {
            Verified::Available(_) => {
                let inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let handle = inner
                    .session
                    .as_ref()
                    .filter(|s| s.id == session_id)
                    .and_then(|s| s.handles.get(id))
                    .cloned();
                drop(inner);
                handle.map_or(Resolution::Canceled, |thumbnail_handle| {
                    Resolution::Available {
                        source: "prntsc".into(),
                        id: id.into(),
                        source_page_url: format!("https://prnt.sc/{id}"),
                        thumbnail_handle,
                    }
                })
            }
            Verified::Unavailable => Resolution::Unavailable {
                reason: "Unavailable".into(),
            },
        }
    }
    #[allow(
        clippy::too_many_arguments,
        clippy::too_many_lines,
        clippy::significant_drop_tightening,
        reason = "Keep the verification pipeline explicit; its decoder permit intentionally survives through the durable commit"
    )]
    pub async fn resolve(
        &self,
        session_id: &str,
        generation: u64,
        id: &str,
        retry: bool,
        source: &Prntsc,
        data: &PersistentState,
        files: &ThumbnailCache,
    ) -> Result<Resolution, AppError> {
        let value = prntsc::item_id_value(id)?;
        if id != prntsc::value_to_base36(value) {
            return Err(AppError::invalid_input("Noncanonical Nearby identifier"));
        }
        let mut changes = self.changes.subscribe();
        let (cached, anchor) = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let session = inner
                .session
                .as_ref()
                .filter(|s| {
                    s.id == session_id && s.generation == generation && s.wanted.contains(id)
                })
                .ok_or_else(|| AppError::invalid_input("Stale Nearby request"))?;
            (inner.previews.get(id).cloned(), session.anchor == id)
        };
        if let Some(cached) = cached {
            return Ok(self.commit(session_id, id, &cached, data));
        }
        let evidence = data.read(|| Ok(data.explored.evidence(value)))?;
        if evidence == Some(EVIDENCE_REJECTED_ONLY) {
            return Ok(Resolution::Unavailable {
                reason: "Unavailable".into(),
            });
        }
        let work = async {
            let _resolve_permit = self
                .resolves
                .acquire()
                .await
                .map_err(|_| AppError::invalid_input("Preview service closed"))?;
            // Only native cache bytes with History/Saved provenance prove an unchecked ID.
            let provenance = data.read(|| {
                Ok(data.history.snapshot().history.iter().any(|x| {
                    x.source == "prntsc" && prntsc::item_id_value(&x.id).ok() == Some(value)
                }) || data.favorites.snapshot().iter().any(|x| {
                    x.source == "prntsc" && prntsc::item_id_value(&x.id).ok() == Some(value)
                }))
            })?;
            let cached_file = if retry && !anchor {
                None
            } else {
                files.read_preview(id)?
            };
            let (bytes, frame) = if let Some(bytes) =
                cached_file.filter(|_| evidence.is_some_and(|e| e & 1 != 0) || provenance)
            {
                (Arc::new(bytes), None)
            } else {
                if anchor {
                    return Err(AppError::new(
                        ErrorKind::InvalidResponse,
                        "Current preview is not saved locally yet",
                    ));
                }
                let outcome = source.fetch_outcome(id, true, retry).await?;
                let frame = match outcome {
                    prntsc::FetchOutcome::Fetched(frame) => frame,
                    prntsc::FetchOutcome::ConfirmedUnavailable { .. } => {
                        return Ok((Verified::Unavailable, None, None))
                    }
                };
                (Arc::clone(&frame.bytes), Some(frame))
            };
            let permit = self
                .decoder
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| AppError::invalid_input("Preview decoder closed"))?;
            if !self.member(session_id, id) {
                return Err(AppError::new(ErrorKind::Network, "Request canceled"));
            }
            let existing = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .previews
                .get(id)
                .cloned();
            if let Some(existing) = existing {
                return Ok((existing, None, Some(permit)));
            }
            let (encoded, permit) =
                tokio::task::spawn_blocking(move || (thumbnail::encode(&bytes), permit))
                    .await
                    .map_err(AppError::persistence)?;
            Ok::<_, AppError>((Verified::Available(Arc::new(encoded?)), frame, Some(permit)))
        };
        tokio::pin!(work);
        let result = loop {
            tokio::select! {
                biased;
                result = &mut work => break result,
                notification = changes.changed() => { if notification.is_err() || !self.member(session_id, id) { return Ok(Resolution::Canceled); } }
            }
        };
        match result {
            Ok((verified, frame, _permit)) => {
                self.remember(session_id, id, verified.clone(), frame);
                Ok(self.commit(session_id, id, &verified, data))
            }
            Err(error) => Ok(Resolution::Retryable {
                kind: error.kind,
                message: error.message,
                retry_after_ms: error.retry_after_ms,
            }),
        }
    }
    pub fn thumbnail(&self, session_id: &str, handle: &str) -> Result<Vec<u8>, AppError> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = inner
            .session
            .as_ref()
            .filter(|s| s.id == session_id)
            .and_then(|s| {
                s.handles
                    .iter()
                    .find(|(_, value)| value.as_str() == handle)
                    .map(|(id, _)| id)
            });
        let Some(id) = id else {
            return Err(AppError::new(ErrorKind::NotFound, "Preview cache miss"));
        };
        match inner.previews.get(id) {
            Some(Verified::Available(bytes)) => Ok((**bytes).clone()),
            _ => Err(AppError::new(ErrorKind::NotFound, "Preview cache miss")),
        }
    }
    pub fn close(&self, session_id: &str, selected: Option<&str>) -> Result<(), AppError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(s) = &inner.session {
            if s.id != session_id {
                return Ok(());
            }
            if selected.is_some_and(|id| !s.wanted.contains(id)) {
                return Err(AppError::invalid_input("Invalid Nearby selection"));
            }
        }
        if inner
            .handoff
            .as_ref()
            .is_none_or(|(_, frame)| selected != Some(frame.item.id.as_str()))
        {
            inner.handoff = None;
        }
        inner.session = None;
        drop(inner);
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }
    pub fn take_handoff(&self, id: &str) -> Option<FetchedFrame> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner
            .handoff
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() > Duration::from_secs(30))
        {
            inner.handoff = None;
        }
        if inner
            .handoff
            .as_ref()
            .is_some_and(|(_, frame)| frame.item.id == id)
        {
            inner.handoff.take().map(|(_, frame)| frame)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    #[tokio::test]
    async fn nearby_service_reuses_overlap_persists_only_checks_and_retries_without_refetch(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory =
            std::env::temp_dir().join(format!("nearby-service-{}", rand::random::<u64>()));
        let data = Arc::new(PersistentState::new(&directory)?);
        let files = ThumbnailCache::new(directory.join("thumbnails"));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let hits = Arc::new(AtomicUsize::new(0));
        let hit_count = hits.clone();
        let mut image_bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(32, 24)
            .write_to(&mut image_bytes, image::ImageFormat::Png)?;
        let image_bytes = image_bytes.into_inner();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0; 2048];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let asset = request.starts_with("GET /asset/");
                if !asset {
                    hit_count.fetch_add(1, Ordering::SeqCst);
                }
                let body = if asset {
                    image_bytes.clone()
                } else {
                    b"<img id='screenshot-image' src='https://i.imgur.com/test.png'>".to_vec()
                };
                let content = if asset { "image/png" } else { "text/html" };
                let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {content}\r\nConnection: close\r\n\r\n",body.len());
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            }
        });
        let source = Prntsc::new(data.clone())?.with_test_base(base);
        let nearby = Nearby::default();
        nearby.set_window("test", 1, "abc123", "abc123", &data)?;
        for id in [
            "abc11z", "abc120", "abc121", "abc122", "abc124", "abc125", "abc126", "abc127",
        ] {
            assert!(matches!(
                nearby
                    .resolve("test", 1, id, false, &source, &data, &files)
                    .await?,
                Resolution::Available { .. }
            ));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 8);
        let snapshot = data.snapshot()?.0;
        assert_eq!(snapshot.exploration.len(), 8);
        assert!(
            snapshot.history.is_empty() && snapshot.seen.is_empty() && snapshot.activity.is_empty()
        );
        nearby.set_window("test", 2, "abc127", "abc123", &data)?;
        for id in ["abc124", "abc125", "abc126", "abc127"] {
            nearby
                .resolve("test", 2, id, false, &source, &data, &files)
                .await?;
        }
        assert_eq!(hits.load(Ordering::SeqCst), 8);
        // A commit failure retains verified bytes; retry cannot hit upstream again.
        std::fs::create_dir(directory.join("exploration-v2.json.tmp"))?;
        assert!(matches!(
            nearby
                .resolve("test", 2, "abc128", false, &source, &data, &files)
                .await?,
            Resolution::Unsaved { .. }
        ));
        std::fs::remove_dir(directory.join("exploration-v2.json.tmp"))?;
        assert!(matches!(
            nearby
                .resolve("test", 2, "abc128", true, &source, &data, &files)
                .await?,
            Resolution::Available { .. }
        ));
        assert_eq!(hits.load(Ordering::SeqCst), 9);
        for id in ["abc129", "abc12a", "abc12b"] {
            nearby
                .resolve("test", 2, id, false, &source, &data, &files)
                .await?;
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            12,
            "a four-step shift introduces four source jobs"
        );
        nearby.close("test", None)?;
        assert!(nearby.thumbnail("test", "abc124").is_err());
        assert!(nearby
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .handoff
            .is_none());
        task.abort();
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[tokio::test]
    async fn nearby_handles_protect_live_tiles_and_raw_handoff_expires_without_another_request(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("nearby-caps-{}", rand::random::<u64>()));
        let data = PersistentState::new(&directory)?;
        let nearby = Nearby::default();
        nearby.set_window("caps", 1, "10", "10", &data)?;
        for value in 0..45 {
            nearby.remember(
                "caps",
                &prntsc::value_to_base36(value),
                Verified::Available(Arc::new(vec![1; 1024])),
                None,
            );
        }
        {
            let inner = nearby
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(inner.previews.len(), 27);
            for id in 32..=40 {
                assert!(inner.previews.contains_key(&prntsc::value_to_base36(id)));
            }
            drop(inner);
        }
        assert!(nearby.set_window("caps", 1, "11", "10", &data).is_err());
        assert!(nearby.set_window("caps", 2, "11", "11", &data).is_err());
        tokio::time::pause();
        nearby.remember(
            "caps",
            "10",
            Verified::Available(Arc::new(vec![1])),
            Some(FetchedFrame {
                item: prntsc::RandomItem {
                    source: "prntsc".into(),
                    id: "10".into(),
                    source_page_url: "https://prnt.sc/10".into(),
                    mime_type: "image/png".into(),
                },
                bytes: Arc::new(vec![2; 1024]),
            }),
        );
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(31)).await;
        tokio::task::yield_now().await;
        assert!(nearby
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .handoff
            .is_none());
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
}
