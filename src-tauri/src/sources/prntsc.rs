use crate::error::{AppError, ErrorKind};
use rand::{distributions::Uniform, Rng};
use regex::Regex;
use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::Duration,
};

const CHARACTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_IMAGE_BYTES: usize = 15_000_000;
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
    resolved: Mutex<ResolvedCache>,
}

impl Prntsc {
    pub fn new() -> Result<Self, AppError> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(Policy::none())
            .build()
            .map_err(AppError::network)?;
        Ok(Self {
            client,
            resolved: Mutex::new(ResolvedCache::default()),
        })
    }

    pub async fn get_random_frame(&self) -> Result<FetchedFrame, AppError> {
        let item = self.resolve_item(&make_id()).await?;
        self.fetch_asset(item).await
    }

    pub async fn get_frame(&self, id: &str) -> Result<FetchedFrame, AppError> {
        let item = self.resolve_item(id).await?;
        self.fetch_asset(item).await
    }

    async fn resolve_item(&self, id: &str) -> Result<ResolvedItem, AppError> {
        validate_item_id(id)?;
        let source_page_url = format!("https://prnt.sc/{id}");
        let cached = self
            .resolved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            validate_image_size(length as usize)?;
        }

        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or(0)
                .min(MAX_IMAGE_BYTES as u64) as usize,
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

fn make_id() -> String {
    let mut random = rand::thread_rng();
    let range = Uniform::new(0, CHARACTERS.len());
    (0..6)
        .map(|_| CHARACTERS[random.sample(range)] as char)
        .collect()
}

pub fn validate_item_id(id: &str) -> Result<(), AppError> {
    if id.len() == 6
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid image identifier",
        ))
    }
}

pub fn is_allowed_image_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && matches!(url.host_str(), Some("image.prntscr.com" | "i.imgur.com"))
    })
}

pub fn extract_image_url(html: &str) -> Option<String> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r#"(?i)<img[^>]+id=["']screenshot-image["'][^>]+src=["']([^"']+)["']"#,
            r#"(?i)<img[^>]+src=["']([^"']+)["'][^>]+id=["']screenshot-image["']"#,
            r#"(?i)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']"#,
            r#"(?i)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("static HTML pattern must compile"))
        .collect()
    });
    patterns.iter().find_map(|pattern| {
        let value = pattern.captures(html)?.get(1)?.as_str();
        let decoded = value
            .replace("&amp;", "&")
            .replace("&#x2F;", "/")
            .replace("&#47;", "/");
        is_allowed_image_url(&decoded).then_some(decoded)
    })
}

fn validate_image_size(size: usize) -> Result<(), AppError> {
    if size > MAX_IMAGE_BYTES {
        Err(AppError::new(
            ErrorKind::ImageTooLarge,
            "The image is too large",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_fixed_width_lowercase_base36_ids() {
        assert!(validate_item_id("abc123").is_ok());
        for invalid in ["abc12", "abc1234", "ABC123", "abc-12", "ąbc123"] {
            assert_eq!(
                validate_item_id(invalid).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn allows_only_known_https_image_hosts() {
        assert!(is_allowed_image_url("https://i.imgur.com/example.png"));
        assert!(is_allowed_image_url(
            "https://image.prntscr.com/image/example.png"
        ));
        assert!(!is_allowed_image_url(
            "http://image.prntscr.com/example.png"
        ));
        assert!(!is_allowed_image_url(
            "https://image.prntscr.com.evil.example/image.png"
        ));
        assert!(!is_allowed_image_url("not a url"));
    }

    #[test]
    fn extracts_screenshot_or_open_graph_image_in_either_attribute_order() {
        let cases = [
            r#"<img id="screenshot-image" src="https://i.imgur.com/a.png">"#,
            r#"<img src="https://i.imgur.com/b.png" id="screenshot-image">"#,
            r#"<meta property="og:image" content="https://image.prntscr.com/a.png?x=1&amp;y=2">"#,
            r#"<meta content="https://image.prntscr.com/b.png" property="og:image">"#,
        ];
        assert_eq!(
            extract_image_url(cases[0]),
            Some("https://i.imgur.com/a.png".into())
        );
        assert_eq!(
            extract_image_url(cases[1]),
            Some("https://i.imgur.com/b.png".into())
        );
        assert_eq!(
            extract_image_url(cases[2]),
            Some("https://image.prntscr.com/a.png?x=1&y=2".into())
        );
        assert_eq!(
            extract_image_url(cases[3]),
            Some("https://image.prntscr.com/b.png".into())
        );
        assert_eq!(
            extract_image_url(r#"<meta property="og:image" content="https://evil.example/a.png">"#),
            None
        );
        assert_eq!(
            extract_image_url(r#"<META PROPERTY="OG:IMAGE" CONTENT="https://i.imgur.com/c.png">"#),
            Some("https://i.imgur.com/c.png".into())
        );
    }

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
        assert_eq!(
            validate_image_size(MAX_IMAGE_BYTES + 1).unwrap_err().kind,
            ErrorKind::ImageTooLarge
        );
    }
}
