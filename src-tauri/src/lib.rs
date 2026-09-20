mod error;
mod rate_limit;
mod sources;

use error::{AppError, ErrorKind};
use rate_limit::RateLimiter;
use reqwest::StatusCode;
use sources::{prntsc, prntsc::FetchedFrame, prntsc::Prntsc, select_source, Source};
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Response, State};

struct PendingFrame {
    source: String,
    id: String,
    bytes: Vec<u8>,
}

struct AppState {
    prntsc: Prntsc,
    rate_limiter: Mutex<RateLimiter>,
    // ponytail: the UI loads one frame at a time; use a bounded keyed cache if concurrent consumers are added.
    pending: Mutex<Option<PendingFrame>>,
}

impl AppState {
    fn new() -> Result<Self, AppError> {
        Ok(Self {
            prntsc: Prntsc::new()?,
            rate_limiter: Mutex::new(RateLimiter::new()),
            pending: Mutex::new(None),
        })
    }

    fn take_api_token(&self) -> Result<(), AppError> {
        self.rate_limiter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    fn store_pending(&self, frame: &mut FetchedFrame) {
        let pending = PendingFrame {
            source: frame.item.source.clone(),
            id: frame.item.id.clone(),
            bytes: std::mem::take(&mut frame.bytes),
        };
        *self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pending);
    }

    fn take_pending(&self, source: &str, id: &str) -> Option<Vec<u8>> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending
            .as_ref()
            .is_some_and(|frame| frame.source == source && frame.id == id)
        {
            pending.take().map(|frame| frame.bytes)
        } else {
            None
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RetryDecision {
    RetryNow,
    RetryAfter(Duration),
    Abort,
}

fn retry_decision(attempt: usize, error: &AppError) -> RetryDecision {
    if attempt >= 19
        || error.is_upstream_status(StatusCode::FORBIDDEN)
        || error.is_upstream_status(StatusCode::TOO_MANY_REQUESTS)
    {
        RetryDecision::Abort
    } else if error.kind == ErrorKind::NotFound {
        RetryDecision::RetryNow
    } else {
        RetryDecision::RetryAfter(Duration::from_millis(150 * (attempt as u64 + 1)))
    }
}

async fn random_frame(source: Source, state: &AppState) -> Result<FetchedFrame, AppError> {
    for attempt in 0..20 {
        let result = match source {
            Source::Prntsc => state.prntsc.get_random_frame().await,
            Source::InternetArchive => {
                unreachable!("unavailable sources are rejected by the registry")
            }
        };
        match result {
            Ok(frame) => return Ok(frame),
            Err(error) => match retry_decision(attempt, &error) {
                RetryDecision::RetryNow => continue,
                RetryDecision::RetryAfter(delay) => tokio::time::sleep(delay).await,
                RetryDecision::Abort => return Err(error),
            },
        }
    }
    unreachable!("the retry loop returns on its final attempt")
}

#[tauri::command]
async fn get_random_frame(
    source: Option<String>,
    state: State<'_, AppState>,
) -> Result<prntsc::RandomItem, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    state.take_api_token()?;
    let mut frame = random_frame(source, &state).await?;
    let item = frame.item.clone();
    state.store_pending(&mut frame);
    Ok(item)
}

#[tauri::command]
async fn get_frame_by_id(
    source: Option<String>,
    id: String,
    state: State<'_, AppState>,
) -> Result<prntsc::RandomItem, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    prntsc::validate_item_id(&id)?;
    state.take_api_token()?;
    let mut frame = match source {
        Source::Prntsc => state.prntsc.get_frame(&id).await?,
        Source::InternetArchive => unreachable!("unavailable sources are rejected by the registry"),
    };
    let item = frame.item.clone();
    state.store_pending(&mut frame);
    Ok(item)
}

#[tauri::command]
async fn get_frame_image(
    source: Option<String>,
    id: String,
    state: State<'_, AppState>,
) -> Result<Response, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    prntsc::validate_item_id(&id)?;
    if let Some(bytes) = state.take_pending(source.id(), &id) {
        return Ok(Response::new(bytes));
    }

    state.take_api_token()?;
    let frame = match source {
        Source::Prntsc => state.prntsc.get_frame(&id).await?,
        Source::InternetArchive => unreachable!("unavailable sources are rejected by the registry"),
    };
    Ok(Response::new(frame.bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new().expect("failed to initialize the HTTP client"))
        .invoke_handler(tauri::generate_handler![
            get_random_frame,
            get_frame_by_id,
            get_frame_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_retry_decisions_and_linear_backoff() {
        let missing = AppError::upstream("source", StatusCode::NOT_FOUND);
        let forbidden = AppError::upstream("source", StatusCode::FORBIDDEN);
        let limited = AppError::upstream("source", StatusCode::TOO_MANY_REQUESTS);
        let network = AppError::new(ErrorKind::Network, "network");

        assert_eq!(retry_decision(0, &missing), RetryDecision::RetryNow);
        assert_eq!(retry_decision(0, &forbidden), RetryDecision::Abort);
        assert_eq!(retry_decision(0, &limited), RetryDecision::Abort);
        assert_eq!(
            retry_decision(2, &network),
            RetryDecision::RetryAfter(Duration::from_millis(450))
        );
        assert_eq!(retry_decision(19, &missing), RetryDecision::Abort);
    }
}
