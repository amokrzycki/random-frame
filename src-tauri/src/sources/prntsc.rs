use crate::error::{AppError, ErrorKind};
use crate::persistence::ExplorationStore;
use reqwest::{redirect::Policy, Client};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

mod id;
mod parser;

pub use id::validate_item_id;
use id::{item_id_value, make_id};
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
    resolved: Mutex<ResolvedCache>,
}

impl Prntsc {
    pub fn new(explored: Arc<ExplorationStore>) -> Result<Self, AppError> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(Policy::none())
            .build()
            .map_err(AppError::network)?;
        Ok(Self {
            client,
            explored,
            resolved: Mutex::new(ResolvedCache::default()),
        })
    }

    pub async fn get_random_frame(&self) -> Result<FetchedFrame, AppError> {
        self.get_frame(&make_id()).await
    }

    pub async fn get_frame(&self, id: &str) -> Result<FetchedFrame, AppError> {
        let value = item_id_value(id)?;
        let result = match self.resolve_item(id).await {
            Ok(item) => self.fetch_asset(item).await,
            Err(error) => Err(error),
        };
        if outcome_is_explored(&result) {
            self.explored.mark(value)?;
        }
        result
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

fn outcome_is_explored<T>(result: &Result<T, AppError>) -> bool {
    result
        .as_ref()
        .map_or_else(AppError::is_classified_source_outcome, |_| true)
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
    fn counts_classified_results_but_not_transient_failures() {
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

        assert!(outcome_is_explored(&valid));
        assert!(outcome_is_explored(&rejected));
        assert!(outcome_is_explored(&placeholder));
        assert!(!outcome_is_explored(&timeout));
        assert!(!outcome_is_explored(&limited));
        assert!(!outcome_is_explored(&server_error));
    }
}
