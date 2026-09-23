use crate::error::{AppError, ErrorKind};
use crate::persistence::{
    activity_day, day_key, ActivityStore, ExplorationOutcome, ExplorationStore, SeenStore,
};
use chrono::Local;
use reqwest::{redirect::Policy, Client};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

mod id;
mod parser;

use id::make_id;
pub use id::validate_item_id;
pub(crate) use id::{item_id_value, LEGACY_MAX_VALUE};
pub use parser::{extract_image_url, is_allowed_image_url};

const MAX_IMAGE_BYTES: usize = 15_000_000;
const MAX_IMAGE_BYTES_U64: u64 = 15_000_000;
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RandomItem {
    pub id: String,
    pub source: String,
    pub source_page_url: String,
    pub mime_type: String,
}

#[derive(Clone, Debug)]
struct ResolvedItem {
    id: String,
    media_url: String,
    source_page_url: String,
}

pub struct FetchedFrame {
    pub item: RandomItem,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
struct ResolvedCache {
    values: HashMap<String, String>,
    order: VecDeque<String>,
}

impl ResolvedCache {
    fn insert(&mut self, id: String, url: String) {
        if self.values.insert(id.clone(), url).is_none() {
            self.order.push_back(id);
        }
        if self.values.len() > 100 {
            if let Some(oldest) = self.order.pop_front() {
                self.values.remove(&oldest);
            }
        }
    }
}

pub struct Prntsc {
    client: Client,
    explored: Arc<ExplorationStore>,
    seen: Arc<SeenStore>,
    activity: Arc<ActivityStore>,
    resolved: Mutex<ResolvedCache>,
}

impl Prntsc {
    pub fn new(
        explored: Arc<ExplorationStore>,
        seen: Arc<SeenStore>,
        activity: Arc<ActivityStore>,
    ) -> Result<Self, AppError> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(Policy::none())
            .build()
            .map_err(AppError::network)?;
        Ok(Self {
            client,
            explored,
            seen,
            activity,
            resolved: Mutex::new(ResolvedCache::default()),
        })
    }

    pub async fn get_random_frame(&self) -> Result<FetchedFrame, AppError> {
        let id = pick_unexplored_id(&self.explored, &self.seen, make_id)?;
        let result = self.get_frame(&id).await;
        reject_newly_known(&self.explored, &self.seen, item_id_value(&id)?, result)
    }

    pub async fn get_frame(&self, id: &str) -> Result<FetchedFrame, AppError> {
        let value = item_id_value(id)?;
        let result = match self.resolve_item(id).await {
            Ok(item) => self.fetch_asset(item).await,
            Err(error) => Err(error),
        };
        if classify_rejection(&result) {
            record_exploration(
                &self.explored,
                &self.activity,
                value,
                ExplorationOutcome::Rejected,
                &day_key(activity_day(&Local::now())),
            )?;
        }
        result
    }

    pub fn record_viewed(&self, id: u64) -> Result<(), AppError> {
        record_exploration(
            &self.explored,
            &self.activity,
            id,
            ExplorationOutcome::Viewed,
            &day_key(activity_day(&Local::now())),
        )
    }

    async fn resolve_item(&self, id: &str) -> Result<ResolvedItem, AppError> {
        validate_item_id(id)?;
        let source_page_url = format!("https://prnt.sc/{id}");
        let cached = self
            .resolved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values
            .get(id)
            .cloned();
        if let Some(media_url) = cached {
            return Ok(ResolvedItem {
                id: id.to_owned(),
                media_url,
                source_page_url,
            });
        }

        let page = self
            .client
            .get(&source_page_url)
            .header("accept", "text/html,application/xhtml+xml")
            .timeout(Duration::from_secs(12))
            .send()
            .await
            .map_err(AppError::network)?;
        if !page.status().is_success() {
            return Err(AppError::upstream("Prnt.sc", page.status()));
        }
        let html = page.text().await.map_err(AppError::network)?;
        let media_url = extract_image_url(&html).ok_or_else(|| {
            AppError::new(ErrorKind::NotFound, "No image was found at this address")
        })?;
        self.resolved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.to_owned(), media_url.clone());
        Ok(ResolvedItem {
            id: id.to_owned(),
            media_url,
            source_page_url,
        })
    }

    async fn fetch_asset(&self, item: ResolvedItem) -> Result<FetchedFrame, AppError> {
        if !is_allowed_image_url(&item.media_url) {
            return Err(AppError::new(
                ErrorKind::InvalidResponse,
                "The source returned an untrusted image address",
            ));
        }
        let mut response = self
            .client
            .get(&item.media_url)
            .header("accept", "image/avif,image/webp,image/png,image/jpeg,*/*")
            .header("referer", &item.source_page_url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(AppError::network)?;
        if !response.status().is_success() {
            return Err(AppError::upstream("The image host", response.status()));
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if !mime_type.to_ascii_lowercase().starts_with("image/") {
            // Terminal rejection: assumes a non-image response is permanent, not a transient CDN hiccup.
            return Err(AppError::new(
                ErrorKind::InvalidResponse,
                "The source did not return a valid image",
            ));
        }
        if let Some(length) = response.content_length() {
            if length > MAX_IMAGE_BYTES_U64 {
                return Err(image_too_large());
            }
        }

        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0)
                .min(MAX_IMAGE_BYTES),
        );
        while let Some(chunk) = response.chunk().await.map_err(AppError::network)? {
            validate_image_size(bytes.len() + chunk.len())?;
            bytes.extend_from_slice(&chunk);
        }
        Ok(FetchedFrame {
            item: RandomItem {
                id: item.id,
                source: "prntsc".to_owned(),
                source_page_url: item.source_page_url,
                mime_type,
            },
            bytes,
        })
    }
}

// 32 retries covers reroll odds until the space is nearly exhausted.
fn pick_unexplored_id(
    explored: &ExplorationStore,
    seen: &SeenStore,
    mut make_candidate: impl FnMut() -> String,
) -> Result<String, AppError> {
    for _ in 0..32 {
        let candidate = make_candidate();
        match item_id_value(&candidate) {
            Ok(value) if !explored.contains(value) && !seen.contains(value) => {
                return Ok(candidate)
            }
            _ => {}
        }
    }
    Err(no_new_frame())
}

fn reject_newly_known(
    explored: &ExplorationStore,
    seen: &SeenStore,
    id: u64,
    result: Result<FetchedFrame, AppError>,
) -> Result<FetchedFrame, AppError> {
    let frame = result?;
    if explored.contains(id) || seen.contains(id) {
        return Err(no_new_frame());
    }
    Ok(frame)
}

fn no_new_frame() -> AppError {
    AppError::new(ErrorKind::NoNewFrame, "No new frame was found; try again")
}

fn classify_rejection<T>(result: &Result<T, AppError>) -> bool {
    matches!(result, Err(error) if error.is_classified_source_outcome())
}

/// Counts an outcome once per unique id, so revisits re-fetched via `get_frame` never reach activity.
fn record_exploration(
    explored: &ExplorationStore,
    activity: &ActivityStore,
    value: u64,
    outcome: ExplorationOutcome,
    day: &str,
) -> Result<(), AppError> {
    if explored.mark(value, outcome)? {
        activity.record(outcome, day)?;
    }
    Ok(())
}

#[cfg(test)]
fn outcome_is_explored<T>(result: &Result<T, AppError>) -> bool {
    classify_rejection(result)
}

fn validate_image_size(size: usize) -> Result<(), AppError> {
    if size > MAX_IMAGE_BYTES {
        Err(image_too_large())
    } else {
        Ok(())
    }
}

fn image_too_large() -> AppError {
    AppError::new(ErrorKind::ImageTooLarge, "The image is too large")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_resolved_url_cache_at_one_hundred_entries() {
        let mut cache = ResolvedCache::default();
        for index in 0..101 {
            cache.insert(
                format!("{index:06}"),
                format!("https://i.imgur.com/{index}.png"),
            );
        }
        assert_eq!(cache.values.len(), 100);
        assert!(!cache.values.contains_key("000000"));
        assert!(cache.values.contains_key("000100"));
    }

    #[test]
    fn rejects_images_over_fifteen_megabytes() {
        assert!(validate_image_size(MAX_IMAGE_BYTES).is_ok());
        assert!(matches!(
            validate_image_size(MAX_IMAGE_BYTES + 1),
            Err(AppError {
                kind: ErrorKind::ImageTooLarge,
                ..
            })
        ));
    }

    #[test]
    fn records_rejections_but_not_fetch_success_or_transient_failures() {
        let valid: Result<(), AppError> = Ok(());
        let rejected: Result<(), AppError> = Err(AppError::new(
            ErrorKind::InvalidResponse,
            "rejected by parser",
        ));
        let placeholder: Result<(), AppError> =
            Err(AppError::new(ErrorKind::NotFound, "placeholder"));
        let timeout: Result<(), AppError> = Err(AppError::new(ErrorKind::Timeout, "timeout"));
        let limited: Result<(), AppError> = Err(AppError::upstream(
            "Prnt.sc",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ));
        let server_error: Result<(), AppError> = Err(AppError::upstream(
            "Prnt.sc",
            reqwest::StatusCode::BAD_GATEWAY,
        ));

        assert!(!outcome_is_explored(&valid));
        assert!(outcome_is_explored(&rejected));
        assert!(outcome_is_explored(&placeholder));
        assert!(!outcome_is_explored(&timeout));
        assert!(!outcome_is_explored(&limited));
        assert!(!outcome_is_explored(&server_error));
    }

    #[test]
    fn only_classifies_rejections_during_fetch() {
        let valid: Result<(), AppError> = Ok(());
        let placeholder: Result<(), AppError> =
            Err(AppError::new(ErrorKind::NotFound, "placeholder"));
        let timeout: Result<(), AppError> = Err(AppError::new(ErrorKind::Timeout, "timeout"));

        assert!(!classify_rejection(&valid));
        assert!(classify_rejection(&placeholder));
        assert!(!classify_rejection(&timeout));
    }

    fn temp_store_directory(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let directory = std::env::temp_dir().join(format!(
            "random-frame-prntsc-{name}-{}-{nonce}",
            std::process::id()
        ));
        directory
    }

    #[test]
    fn revisits_navigation_and_restart_reloads_never_count_as_new_activity() -> Result<(), AppError>
    {
        use crate::persistence::DailyActivitySnapshot;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let directory = std::env::temp_dir().join(format!(
            "random-frame-prntsc-activity-once-{}-{nonce}",
            std::process::id()
        ));
        let day = "2026-09-22";
        let explored = ExplorationStore::new(&directory)?;
        let activity = ActivityStore::new(&directory)?;

        // First view and one unavailable id.
        record_exploration(&explored, &activity, 1, ExplorationOutcome::Viewed, day)?;
        record_exploration(&explored, &activity, 2, ExplorationOutcome::Rejected, day)?;
        // Uncached back/forward or history jump re-fetches; may later fail.
        record_exploration(&explored, &activity, 1, ExplorationOutcome::Viewed, day)?;
        record_exploration(&explored, &activity, 1, ExplorationOutcome::Rejected, day)?;
        record_exploration(&explored, &activity, 2, ExplorationOutcome::Rejected, day)?;

        // Restart reloads state, then re-fetches the selected frame.
        drop((explored, activity));
        let explored = ExplorationStore::new(&directory)?;
        let activity = ActivityStore::new(&directory)?;
        record_exploration(&explored, &activity, 1, ExplorationOutcome::Viewed, day)?;

        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 22).unwrap_or_default();
        assert_eq!(
            activity.recent_days(today, 1),
            vec![(
                day.to_owned(),
                DailyActivitySnapshot {
                    viewed: 1,
                    rejected: 1
                }
            )]
        );
        assert_eq!(explored.count(), 2);
        assert_eq!(explored.viewable_count(), 1);
        assert_eq!(explored.unavailable_count(), 1);
        assert_eq!(
            usize::try_from(activity.viewed_total()).ok(),
            Some(explored.viewable_count())
        );
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    fn pick_from(candidates: &[&str]) -> impl FnMut() -> String {
        let mut index = 0;
        let candidates: Vec<String> = candidates.iter().map(|value| (*value).to_owned()).collect();
        move || {
            let candidate = candidates.get(index).cloned().unwrap_or_default();
            index += 1;
            candidate
        }
    }

    #[test]
    fn skips_already_explored_candidates_before_returning_one() -> Result<(), AppError> {
        let directory = temp_store_directory("skip");
        let store = ExplorationStore::new(&directory)?;
        let seen = SeenStore::new(&directory)?;
        store.mark(item_id_value("abc123")?, ExplorationOutcome::Viewed)?;
        store.mark(item_id_value("abc124")?, ExplorationOutcome::Rejected)?;
        seen.insert(item_id_value("abc125")?)?;
        store.mark(item_id_value("abc126")?, ExplorationOutcome::Rejected)?;
        seen.insert(item_id_value("abc126")?)?;

        let picked = pick_unexplored_id(
            &store,
            &seen,
            pick_from(&["abc123", "abc124", "abc125", "abc126", "abc127"]),
        )?;

        assert_eq!(picked, "abc127");
        Ok(())
    }

    #[test]
    fn returns_first_candidate_immediately_when_it_is_unexplored() -> Result<(), AppError> {
        let directory = temp_store_directory("first");
        let store = ExplorationStore::new(&directory)?;
        let seen = SeenStore::new(&directory)?;

        let picked = pick_unexplored_id(&store, &seen, pick_from(&["abc123", "abc124"]))?;

        assert_eq!(picked, "abc123");
        Ok(())
    }

    #[test]
    fn returns_typed_error_after_32_known_candidates() -> Result<(), AppError> {
        let directory = temp_store_directory("exhausted");
        let store = ExplorationStore::new(&directory)?;
        let seen = SeenStore::new(&directory)?;
        store.mark(item_id_value("abc123")?, ExplorationOutcome::Viewed)?;

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let picked = pick_unexplored_id(&store, &seen, || {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            "abc123".to_owned()
        });

        assert!(matches!(
            picked,
            Err(AppError {
                kind: ErrorKind::NoNewFrame,
                ..
            })
        ));
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 32);
        Ok(())
    }

    #[test]
    fn newly_seen_frame_is_rejected_after_fetch() -> Result<(), AppError> {
        let directory = temp_store_directory("race");
        let explored = ExplorationStore::new(&directory)?;
        let seen = SeenStore::new(&directory)?;
        let id = item_id_value("abc123")?;
        let frame = FetchedFrame {
            item: RandomItem {
                id: "abc123".to_owned(),
                source: "prntsc".to_owned(),
                source_page_url: "https://prnt.sc/abc123".to_owned(),
                mime_type: "image/png".to_owned(),
            },
            bytes: vec![1],
        };
        seen.insert(id)?;
        assert!(matches!(
            reject_newly_known(&explored, &seen, id, Ok(frame)),
            Err(AppError {
                kind: ErrorKind::NoNewFrame,
                ..
            })
        ));
        Ok(())
    }

    #[test]
    fn clearing_local_exploration_does_not_restore_seen_random_candidates() -> Result<(), AppError>
    {
        let directory = temp_store_directory("clear-seen");
        let explored = ExplorationStore::new(&directory)?;
        let seen = SeenStore::new(&directory)?;
        let id = item_id_value("abc123")?;
        explored.mark(id, ExplorationOutcome::Viewed)?;
        seen.insert(id)?;
        explored.clear()?;
        let picked = pick_unexplored_id(&explored, &seen, pick_from(&["abc123", "abc124"]))?;
        assert_eq!(picked, "abc124");
        Ok(())
    }
}
