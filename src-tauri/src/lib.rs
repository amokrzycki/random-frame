mod error;
mod persistence;
mod rate_limit;
mod sources;

use chrono::Local;
use error::{AppError, ErrorKind};
use persistence::{ActivityStore, ExplorationStore, HistoryItem, HistorySnapshot, HistoryStore};
use rate_limit::RateLimiter;
use reqwest::StatusCode;
use serde::Serialize;
use sources::{prntsc, prntsc::FetchedFrame, prntsc::Prntsc, select_source, Source};
use std::{
    error::Error,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Response, Manager, State};

struct PendingFrame {
    source: String,
    id: String,
    bytes: Vec<u8>,
}

struct AppState {
    prntsc: Prntsc,
    history: HistoryStore,
    explored: Arc<ExplorationStore>,
    activity: Arc<ActivityStore>,
    rate_limiter: Mutex<RateLimiter>,
    // UI loads one frame at a time; use a keyed cache if concurrent consumers are added.
    pending: Mutex<Option<PendingFrame>>,
}

impl AppState {
    fn new(data_directory: &Path) -> Result<Self, AppError> {
        let explored = Arc::new(ExplorationStore::new(data_directory)?);
        let activity = Arc::new(ActivityStore::new(data_directory)?);
        Ok(Self {
            prntsc: Prntsc::new(Arc::clone(&explored), Arc::clone(&activity))?,
            history: HistoryStore::new(data_directory)?,
            explored,
            activity,
            rate_limiter: Mutex::new(RateLimiter::new()),
            pending: Mutex::new(None),
        })
    }

    fn take_api_token(&self) -> Result<(), AppError> {
        self.rate_limiter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(pending);
    }

    fn take_pending(&self, source: &str, id: &str) -> Option<Vec<u8>> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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

const LEGACY_ID_SPACE_SIZE: u64 = 4_773_622_240;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorationStats {
    explored: usize,
    total: u64,
    // Classified since tracking began; may not sum to `explored` on upgraded installs.
    viewable: usize,
    unavailable: usize,
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
    let mut attempt = 0;
    loop {
        let result = match source {
            Source::Prntsc => state.prntsc.get_random_frame().await,
            Source::InternetArchive => Err(AppError::new(
                ErrorKind::UnavailableSource,
                "Internet Archive source is not available yet",
            )),
        };
        match result {
            Ok(frame) => return Ok(frame),
            Err(error) => match retry_decision(attempt, &error) {
                RetryDecision::RetryNow => {}
                RetryDecision::RetryAfter(delay) => tokio::time::sleep(delay).await,
                RetryDecision::Abort => return Err(error),
            },
        }
        attempt += 1;
    }
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
        Source::InternetArchive => {
            return Err(AppError::new(
                ErrorKind::UnavailableSource,
                "Internet Archive source is not available yet",
            ));
        }
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
        Source::InternetArchive => {
            return Err(AppError::new(
                ErrorKind::UnavailableSource,
                "Internet Archive source is not available yet",
            ));
        }
    };
    Ok(Response::new(frame.bytes))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_history(state: State<'_, AppState>) -> HistorySnapshot {
    state.history.snapshot()
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn record_history_item(
    item: HistoryItem,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    let source = select_source(&item.source)?;
    if source == Source::Prntsc {
        prntsc::validate_item_id(&item.id)?;
    }
    state.history.record(item)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn select_history_item(
    index: usize,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    state.history.select(index)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn clear_history(state: State<'_, AppState>) -> Result<(), AppError> {
    state.explored.clear()?;
    state.activity.clear()?;
    state.history.clear()
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_exploration_stats(state: State<'_, AppState>) -> ExplorationStats {
    ExplorationStats {
        explored: state.explored.count(),
        total: LEGACY_ID_SPACE_SIZE,
        viewable: state.explored.viewable_count(),
        unavailable: state.explored.unavailable_count(),
    }
}

// Half a year keeps the heatmap compact; a full year would force tiny cells or widen the dialog.
// Acts as a rolling-window cap, not a fixed size: `ActivityStore::recent_days` never renders days
// before tracking started, so a fresh install shows fewer days until it grows into this window.
const ACTIVITY_WINDOW_DAYS: u32 = 183;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyActivity {
    date: String,
    viewed: u64,
    rejected: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewingActivity {
    viewed_total: u64,
    days: Vec<DailyActivity>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_viewing_activity(state: State<'_, AppState>) -> ViewingActivity {
    let today = Local::now().date_naive();
    let days = state
        .activity
        .recent_days(today, ACTIVITY_WINDOW_DAYS)
        .into_iter()
        .map(|(date, daily)| DailyActivity {
            date,
            viewed: daily.viewed,
            rejected: daily.rejected,
        })
        .collect();
    ViewingActivity {
        viewed_total: state.activity.viewed_total(),
        days,
    }
}

/// One-shot migration of the legacy client-side viewing counter into the backend store.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn migrate_viewing_stats(
    legacy_day: String,
    legacy_today: u64,
    legacy_total: u64,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let today = Local::now().date_naive().to_string();
    state
        .activity
        .migrate(&legacy_day, legacy_today, legacy_total, &today)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the application.
///
/// # Errors
///
/// Returns an error when the HTTP client or Tauri runtime cannot be initialized.
pub fn run() -> Result<(), Box<dyn Error>> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            app.manage(AppState::new(&data_directory)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_random_frame,
            get_frame_by_id,
            get_frame_image,
            get_history,
            record_history_item,
            select_history_item,
            clear_history,
            get_exploration_stats,
            get_viewing_activity,
            migrate_viewing_stats
        ])
        .run(tauri::generate_context!())?;
    Ok(())
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

    fn test_state_directory(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        std::env::temp_dir().join(format!(
            "random-frame-lib-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[tokio::test(start_paused = true)]
    async fn internet_archive_source_never_touches_exploration_or_activity_state(
    ) -> Result<(), AppError> {
        // InternetArchive must short-circuit before state.prntsc, or its ids leak into Prnt.sc counters.
        let directory = test_state_directory("internet-archive");
        let state = AppState::new(&directory)?;

        let result = random_frame(Source::InternetArchive, &state).await;

        assert!(matches!(
            result,
            Err(AppError {
                kind: ErrorKind::UnavailableSource,
                ..
            })
        ));
        assert_eq!(state.explored.count(), 0);
        assert_eq!(state.activity.viewed_total(), 0);
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }
}
