mod error;
mod nearby;
mod persistence;
mod rate_limit;
mod secure_storage;
mod snapshot;
mod sources;
mod sync;
mod sync_crypto;
mod sync_membership_crypto;
mod sync_protocol;
mod sync_transport;
mod thumbnail_cache;
mod time;

use chrono::Local;
use error::{AppError, ErrorKind};
#[cfg(test)]
use persistence::SeenStore;
use persistence::{
    activity_day, day_key, ActivityStore, CollectionEditorRequest, ExplorationStore, FavoriteItem,
    FavoriteStore, FrameView, HistoryItem, HistorySnapshot, HistoryStore, PersistentState,
    RemoveSavedRequest, RemovedFrame, RemovedSaved, SavedLibrary, SavedUndo, UserPreferences,
};
use reqwest::StatusCode;
use secure_storage::SecureStorage;
use serde::Serialize;
use sources::{prntsc, prntsc::FetchedFrame, prntsc::Prntsc, select_source, Source};
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    error::Error,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use sync::{
    CreateManagedSyncResult, JoinMode, LocalSyncSummary, SyncEngine, SyncError, SyncStatus,
};
use tauri::{ipc::Response, Manager, State};

struct PendingFrame {
    source: String,
    id: String,
    bytes: Arc<Vec<u8>>,
}

struct AppState {
    data: Arc<PersistentState>,
    imports_ready: tokio::sync::watch::Sender<bool>,
    #[cfg(desktop)]
    shutdown_started: AtomicBool,
    #[cfg(desktop)]
    shutdown_finished: AtomicBool,
    prntsc: Prntsc,
    nearby: nearby::Nearby,
    history: Arc<HistoryStore>,
    favorites: Arc<FavoriteStore>,
    explored: Arc<ExplorationStore>,
    #[cfg(test)]
    seen: Arc<SeenStore>,
    sync: Option<SyncEngine<SecureStorage>>,
    activity: Arc<ActivityStore>,
    // UI loads one frame at a time; use a keyed cache if concurrent consumers are added.
    pending: Mutex<Option<PendingFrame>>,
}

impl AppState {
    fn new(data_directory: &Path, app_handle: Option<tauri::AppHandle>) -> Result<Self, AppError> {
        let data = Arc::new(PersistentState::new(data_directory)?);
        let explored = Arc::clone(&data.explored);
        let activity = Arc::clone(&data.activity);
        let history = Arc::clone(&data.history);
        #[cfg(test)]
        let seen = Arc::clone(&data.seen);
        let favorites = Arc::clone(&data.favorites);

        let sync = Some(SyncEngine::new(
            data_directory,
            Arc::clone(&data),
            SecureStorage::default(),
            std::env::var("RANDOM_FRAME_SYNC_BASE_URL")
                .ok()
                .as_deref()
                .or(option_env!("RANDOM_FRAME_SYNC_BASE_URL")),
            app_handle,
        ));
        Ok(Self {
            prntsc: Prntsc::new(Arc::clone(&data))?,
            nearby: nearby::Nearby::default(),
            data,
            imports_ready: tokio::sync::watch::channel(false).0,
            #[cfg(desktop)]
            shutdown_started: AtomicBool::new(false),
            #[cfg(desktop)]
            shutdown_finished: AtomicBool::new(false),
            history,
            favorites,
            explored,
            #[cfg(test)]
            seen,
            sync,
            activity,
            pending: Mutex::new(None),
        })
    }

    fn ensure_imports_ready(&self) -> Result<(), SyncError> {
        if *self.imports_ready.borrow() {
            Ok(())
        } else {
            Err(SyncError::LocalMigrationPending)
        }
    }

    async fn flush_before_exit(&self) {
        // Never export incomplete migrations. An early close can wait for imports, at most 5s,
        // then gets the separate 5s network budget. Failed initialization remains local for retry.
        let mut ready = self.imports_ready.subscribe();
        if tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|ready| *ready))
            .await
            .is_ok()
        {
            if let Some(sync) = &self.sync {
                let _ = sync.flush_pending().await;
            }
        }
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

    fn take_pending(&self, source: &str, id: &str) -> Option<Arc<Vec<u8>>> {
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
    viewable: usize,
    unavailable: usize,
    unclassified: usize,
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
    } else if matches!(error.kind, ErrorKind::NotFound | ErrorKind::NoNewFrame) {
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
    let mut frame = random_frame(source, &state).await?;
    let item = frame.item.clone();
    state.store_pending(&mut frame);
    Ok(item)
}

#[tauri::command]
async fn get_frame_by_id(
    source: Option<String>,
    id: String,
    intent: Option<String>,
    state: State<'_, AppState>,
) -> Result<prntsc::RandomItem, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    prntsc::validate_item_id(&id)?;
    let mut frame = match source {
        Source::Prntsc => {
            if nearby_intent(intent.as_deref())? {
                if let Some(frame) = state.nearby.take_handoff(&id) {
                    frame
                } else {
                    nearby_full(&state, &id).await?
                }
            } else {
                state.prntsc.get_frame(&id).await?
            }
        }
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
    intent: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    prntsc::validate_item_id(&id)?;
    if let Some(bytes) = state.take_pending(source.id(), &id) {
        return Ok(Response::new((*bytes).clone()));
    }

    let frame = match source {
        Source::Prntsc => {
            if nearby_intent(intent.as_deref())? {
                if let Some(frame) = state.nearby.take_handoff(&id) {
                    frame
                } else {
                    nearby_full(&state, &id).await?
                }
            } else {
                state.prntsc.get_frame(&id).await?
            }
        }
        Source::InternetArchive => {
            return Err(AppError::new(
                ErrorKind::UnavailableSource,
                "Internet Archive source is not available yet",
            ));
        }
    };
    Ok(Response::new((*frame.bytes).clone()))
}

fn nearby_intent(intent: Option<&str>) -> Result<bool, AppError> {
    match intent {
        None | Some("standard") => Ok(false),
        Some("nearby") => Ok(true),
        _ => Err(AppError::invalid_input("Invalid fetch intent")),
    }
}
async fn nearby_full(state: &AppState, id: &str) -> Result<FetchedFrame, AppError> {
    let result = state.prntsc.fetch_outcome(id, false, true).await?;
    if matches!(&result, prntsc::FetchOutcome::ConfirmedUnavailable { .. }) {
        state.data.record_check(
            prntsc::item_id_value(id)?,
            persistence::ExplorationOutcome::Rejected,
        )?;
    }
    result.into_frame()
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands require owned arguments and state extractors"
)]
fn set_nearby_window(
    session_id: String,
    generation: u64,
    center_id: String,
    anchor_id: String,
    state: State<'_, AppState>,
) -> Result<nearby::WindowState, AppError> {
    state
        .ensure_imports_ready()
        .map_err(|_| AppError::persistence("Finish initialization first"))?;
    state
        .nearby
        .set_window(&session_id, generation, &center_id, &anchor_id, &state.data)
}
#[tauri::command]
async fn resolve_nearby_frame(
    session_id: String,
    generation: u64,
    id: String,
    retry: Option<bool>,
    state: State<'_, AppState>,
    files: State<'_, thumbnail_cache::ThumbnailCache>,
) -> Result<nearby::Resolution, AppError> {
    state
        .nearby
        .resolve(
            &session_id,
            generation,
            &id,
            retry.unwrap_or(false),
            &state.prntsc,
            &state.data,
            &files,
        )
        .await
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands require owned arguments and state extractors"
)]
fn get_nearby_thumbnail(
    session_id: String,
    thumbnail_handle: String,
    state: State<'_, AppState>,
) -> Result<Response, AppError> {
    state
        .nearby
        .thumbnail(&session_id, &thumbnail_handle)
        .map(Response::new)
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands require owned arguments and state extractors"
)]
fn close_nearby(
    session_id: String,
    selected_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.nearby.close(&session_id, selected_id.as_deref())
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands require owned arguments and state extractors"
)]
fn record_nearby_history_item(
    item: HistoryItem,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    state.data.accept_nearby(&item)
}

#[tauri::command]
async fn get_thumbnail_image(
    source: Option<String>,
    id: String,
    state: State<'_, AppState>,
) -> Result<Response, AppError> {
    let source = select_source(source.as_deref().unwrap_or("prntsc"))?;
    prntsc::validate_item_id(&id)?;
    let frame = match source {
        Source::Prntsc => state.prntsc.get_thumbnail(&id).await?,
        Source::InternetArchive => {
            return Err(AppError::new(
                ErrorKind::UnavailableSource,
                "Internet Archive source is not available yet",
            ));
        }
    };
    Ok(Response::new((*frame.bytes).clone()))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_history(state: State<'_, AppState>) -> Result<HistorySnapshot, AppError> {
    state.data.read(|| Ok(state.history.snapshot()))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn record_history_item(
    item: HistoryItem,
    legacy_import: Option<bool>,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    record_accepted_frame(&item, &state, legacy_import.unwrap_or(false))
}

fn record_accepted_frame(
    item: &HistoryItem,
    state: &AppState,
    legacy_import: bool,
) -> Result<HistorySnapshot, AppError> {
    let source = select_source(&item.source)?;
    let legacy_id = if source == Source::Prntsc {
        Some(prntsc::item_id_value(&item.id)?)
    } else {
        None
    };
    let _ = legacy_id;
    state.data.accept(item, legacy_import)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn select_history_item(
    index: usize,
    source: Option<String>,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    state.data.read(|| match (source, id) {
        (Some(source), Some(id)) => state.history.select_frame(&source, &id),
        (None, None) => state.history.select(index),
        _ => Err(AppError::invalid_input("Incomplete frame identity")),
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
// Like a clear, a single removal leaves favorites, seen frames, and stats alone.
fn remove_history_item(
    source: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<RemovedFrame, AppError> {
    state.data.read(|| state.history.remove(&source, &id))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn restore_history_item(
    item: HistoryItem,
    order_at: u64,
    last_view: crate::snapshot::ViewStamp,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    state
        .data
        .read(|| state.history.restore(item, order_at, last_view))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
// Favorites, seen frames, and classified exploration outlive a local history clear.
fn clear_history(state: State<'_, AppState>) -> Result<(), AppError> {
    clear_local_history(&state)
}

fn clear_local_history(state: &AppState) -> Result<(), AppError> {
    let request = state.data.prepare_clear()?;
    state.data.commit_clear(&request)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_favorites(state: State<'_, AppState>) -> Result<Vec<FavoriteItem>, AppError> {
    state.data.read(|| Ok(state.favorites.snapshot()))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn toggle_favorite(
    item: FavoriteItem,
    state: State<'_, AppState>,
) -> Result<Vec<FavoriteItem>, AppError> {
    let source = select_source(&item.source)?;
    if source == Source::Prntsc {
        prntsc::validate_item_id(&item.id)?;
    }
    state.data.read(|| state.favorites.toggle(item))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn clear_favorites(state: State<'_, AppState>) -> Result<(), AppError> {
    state.data.read(|| state.favorites.clear())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn get_saved_library(state: State<'_, AppState>) -> Result<SavedLibrary, AppError> {
    state.data.read(|| Ok(state.favorites.library()))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn save_frame(
    item: FavoriteItem,
    collection_id: Option<snapshot::OperationId>,
    state: State<'_, AppState>,
) -> Result<SavedLibrary, AppError> {
    let source = select_source(&item.source)?;
    if source == Source::Prntsc {
        prntsc::validate_item_id(&item.id)?;
    }
    state
        .data
        .read(|| state.favorites.save_frame(item, collection_id))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn commit_collection_editor(
    request: CollectionEditorRequest,
    state: State<'_, AppState>,
) -> Result<SavedLibrary, AppError> {
    state.data.read(|| state.favorites.commit_editor(request))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command IPC arguments are passed by value"
)]
fn create_collection(name: String, state: State<'_, AppState>) -> Result<SavedLibrary, AppError> {
    state.data.read(|| state.favorites.create_collection(&name))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command IPC arguments are passed by value"
)]
fn rename_collection(
    collection_id: snapshot::OperationId,
    name: String,
    state: State<'_, AppState>,
) -> Result<SavedLibrary, AppError> {
    state
        .data
        .read(|| state.favorites.rename_collection(collection_id, &name))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn delete_collection(
    collection_id: snapshot::OperationId,
    state: State<'_, AppState>,
) -> Result<SavedLibrary, AppError> {
    state
        .data
        .read(|| state.favorites.delete_collection(collection_id))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn remove_saved_frame(
    request: RemoveSavedRequest,
    state: State<'_, AppState>,
) -> Result<RemovedSaved, AppError> {
    if request.frames.len() != 1 {
        return Err(AppError::invalid_input("Expected one saved frame"));
    }
    state.data.read(|| state.favorites.remove_saved(request))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn clear_saved_frames(
    request: RemoveSavedRequest,
    state: State<'_, AppState>,
) -> Result<RemovedSaved, AppError> {
    state.data.read(|| state.favorites.remove_saved(request))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors are passed by value"
)]
fn restore_saved_frames(
    undo: SavedUndo,
    state: State<'_, AppState>,
) -> Result<SavedLibrary, AppError> {
    state.data.read(|| state.favorites.restore_saved(&undo))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_exploration_stats(state: State<'_, AppState>) -> Result<ExplorationStats, AppError> {
    state.data.read(|| {
        let (explored, viewable, unavailable, unclassified) = state.explored.counts();
        Ok(ExplorationStats {
            explored,
            total: LEGACY_ID_SPACE_SIZE,
            viewable,
            unavailable,
            unclassified,
        })
    })
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
    local_view_times: Vec<Option<u64>>,
    frame_views: Vec<FrameView>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_viewing_activity(state: State<'_, AppState>) -> Result<ViewingActivity, AppError> {
    state.data.read(|| {
        let today = activity_day(&Local::now());
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
        let frame_views = state.activity.draw_frame_views();
        Ok(ViewingActivity {
            viewed_total: state.activity.viewed_total(),
            days,
            local_view_times: draw_view_times(&state.history.snapshot().history, &frame_views),
            frame_views,
        })
    })
}

fn draw_view_times(history: &[HistoryItem], frame_views: &[FrameView]) -> Vec<Option<u64>> {
    let normalized_id = |source: &str, id: &str| {
        if source == "prntsc" {
            prntsc::item_id_value(id).map_or_else(|_| id.to_owned(), prntsc::value_to_base36)
        } else {
            id.to_owned()
        }
    };
    let mut times = std::collections::HashMap::with_capacity(frame_views.len());
    for view in frame_views {
        // Preserve the first discovery, including historical leading-zero aliases.
        times
            .entry((view.source.as_str(), normalized_id(&view.source, &view.id)))
            .or_insert(view.at_ms);
    }
    history
        .iter()
        .map(|item| {
            times
                .get(&(item.source.as_str(), normalized_id(&item.source, &item.id)))
                .copied()
        })
        .collect()
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
    let today = day_key(activity_day(&Local::now()));
    state.data.read(|| {
        state
            .activity
            .migrate(&legacy_day, legacy_today, legacy_total, &today)
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn complete_state_imports(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    state.data.read(|| Ok(()))?;
    if !state.imports_ready.send_replace(true) {
        let changes = state.data.subscribe_changes();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Some(sync) = &state.sync {
                sync.run_background(changes).await;
            }
        });
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn import_session_history(
    items: Vec<HistoryItem>,
    index: i64,
    state: State<'_, AppState>,
) -> Result<HistorySnapshot, AppError> {
    state.data.import_session_history(items, index)
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn prepare_history_clear(
    legacy_pending: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    state
        .data
        .prepare_clear_request(legacy_pending.unwrap_or(false))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn commit_history_clear(request_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.data.commit_clear(&request_id)
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn cancel_history_clear(request_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.data.cancel_clear(&request_id)
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn get_user_preferences(state: State<'_, AppState>) -> Result<UserPreferences, AppError> {
    state.data.read(|| Ok(state.data.preferences.get()))
}
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn set_user_preferences(
    preferences: UserPreferences,
    legacy_import: Option<bool>,
    state: State<'_, AppState>,
) -> Result<UserPreferences, AppError> {
    state.data.read(|| {
        state
            .data
            .preferences
            .set(preferences, legacy_import.unwrap_or(false))
    })
}

#[tauri::command]
async fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatus, SyncError> {
    match &state.sync {
        Some(sync) => sync.status().await,
        None => Ok(SyncStatus::unsupported()),
    }
}

#[tauri::command]
async fn create_sync(state: State<'_, AppState>) -> Result<CreateManagedSyncResult, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.create_managed().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
async fn join_sync(
    recovery_key: String,
    mode: JoinMode,
    state: State<'_, AppState>,
) -> Result<SyncStatus, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.join(&recovery_key, mode).await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
fn get_sync_join_summary(state: State<'_, AppState>) -> Result<LocalSyncSummary, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.local_summary(),
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
async fn approve_sync_upgrade(
    recovery_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.approve_upgrade(recovery_key.as_deref()).await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> Result<SyncStatus, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.sync_now().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
async fn startup_sync(state: State<'_, AppState>) -> Result<SyncStatus, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.startup_sync().await,
        None => Ok(SyncStatus::unsupported()),
    }
}

#[tauri::command]
async fn leave_sync(state: State<'_, AppState>) -> Result<SyncStatus, SyncError> {
    match &state.sync {
        Some(sync) => sync.leave().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be passed by value"
)]
fn set_sync_device_name(name: String, state: State<'_, AppState>) -> Result<(), SyncError> {
    if state.sync.is_none() {
        return Err(SyncError::UnsupportedPlatform);
    }
    let trimmed = name.trim();
    state
        .data
        .set_device_name(trimmed)
        .map_err(|_| SyncError::Persistence)
}

#[tauri::command]
async fn get_sync_recovery_key(state: State<'_, AppState>) -> Result<String, SyncError> {
    match &state.sync {
        Some(sync) => sync.recovery_key().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[tauri::command]
async fn get_sync_pairing_request(state: State<'_, AppState>) -> Result<String, SyncError> {
    match &state.sync {
        Some(sync) => sync.pairing_request().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn create_sync_invitation(
    request: String,
    state: State<'_, AppState>,
) -> Result<String, SyncError> {
    match &state.sync {
        Some(sync) => sync.create_invitation(&request).await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn get_sync_invitation(state: State<'_, AppState>) -> Result<String, SyncError> {
    match &state.sync {
        Some(sync) => sync.invitation_code().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn move_to_managed_sync(
    state: State<'_, AppState>,
) -> Result<CreateManagedSyncResult, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.move_to_managed_sync().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn recover_sync_admin(
    code: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<CreateManagedSyncResult, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.recover_admin(&code, confirmed).await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn remove_sync_device(
    member_id: String,
    state: State<'_, AppState>,
) -> Result<SyncStatus, SyncError> {
    state.ensure_imports_ready()?;
    match &state.sync {
        Some(sync) => sync.remove_device(&member_id).await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn cancel_sync_admin_recovery(state: State<'_, AppState>) -> Result<(), SyncError> {
    match &state.sync {
        Some(sync) => sync.cancel_admin_recovery().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}
#[tauri::command]
async fn dissolve_sync(state: State<'_, AppState>) -> Result<SyncStatus, SyncError> {
    match &state.sync {
        Some(sync) => sync.dissolve_group().await,
        None => Err(SyncError::UnsupportedPlatform),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "Each flag is an independent platform feature read by the frontend"
)]
struct PlatformCapabilities {
    platform: &'static str,
    sync: bool,
    desktop_window_controls: bool,
    updater: bool,
    image_clipboard: bool,
}

#[tauri::command]
fn get_platform_capabilities() -> PlatformCapabilities {
    PlatformCapabilities {
        platform: std::env::consts::OS,
        sync: true,
        desktop_window_controls: cfg!(desktop),
        updater: cfg!(desktop),
        image_clipboard: cfg!(desktop),
    }
}

/// Finishes the activity, as the system Back does from the first screen. Tauri's own exit kills the
/// process instead, and its `plugin:app|exit` is not exposed to the frontend.
#[cfg(target_os = "android")]
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors must be passed by value"
)]
async fn exit_app(webview: tauri::Webview, state: State<'_, AppState>) -> tauri::Result<()> {
    state.flush_before_exit().await;
    webview.with_webview(|platform| {
        platform.jni_handle().exec(|env, activity, _webview| {
            let _ = env.call_method(activity, "finish", "()V", &[]);
        });
    })
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
fn mobile_main() {
    // Android has no caller to report to; a failed start ends with the activity.
    let _ = run();
}

#[cfg(desktop)]
fn request_shutdown(app: &tauri::AppHandle, code: i32) {
    let state = app.state::<AppState>();
    if state.shutdown_started.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        state.flush_before_exit().await;
        state.shutdown_finished.store(true, Ordering::Release);
        app.exit(code);
    });
}

fn handle_lifecycle(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(desktop)]
    match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            request_shutdown(app, 0);
        }
        tauri::RunEvent::ExitRequested { api, code, .. }
            if !app
                .state::<AppState>()
                .shutdown_finished
                .load(Ordering::Acquire) =>
        {
            api.prevent_exit();
            request_shutdown(app, code.unwrap_or(0));
        }
        _ => {}
    }
    #[cfg(mobile)]
    let _ = (app, event);
}

/// Starts the application.
///
/// # Errors
///
/// Returns an error when the HTTP client or Tauri runtime cannot be initialized.
pub fn run() -> Result<(), Box<dyn Error>> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            let handle = app.handle().clone();
            app.manage(AppState::new(&data_directory, Some(handle))?);
            thumbnail_cache::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_platform_capabilities,
            #[cfg(target_os = "android")]
            exit_app,
            set_nearby_window,
            resolve_nearby_frame,
            get_nearby_thumbnail,
            close_nearby,
            record_nearby_history_item,
            get_random_frame,
            get_frame_by_id,
            get_frame_image,
            get_thumbnail_image,
            thumbnail_cache::load_thumbnail_cache,
            thumbnail_cache::save_thumbnail_cache,
            get_history,
            record_history_item,
            import_session_history,
            complete_state_imports,
            select_history_item,
            remove_history_item,
            restore_history_item,
            clear_history,
            prepare_history_clear,
            commit_history_clear,
            cancel_history_clear,
            get_user_preferences,
            set_user_preferences,
            get_favorites,
            toggle_favorite,
            clear_favorites,
            get_saved_library,
            save_frame,
            commit_collection_editor,
            create_collection,
            rename_collection,
            delete_collection,
            remove_saved_frame,
            clear_saved_frames,
            restore_saved_frames,
            get_exploration_stats,
            get_viewing_activity,
            migrate_viewing_stats,
            get_sync_status,
            create_sync,
            get_sync_pairing_request,
            create_sync_invitation,
            get_sync_invitation,
            move_to_managed_sync,
            recover_sync_admin,
            remove_sync_device,
            dissolve_sync,
            cancel_sync_admin_recovery,
            join_sync,
            get_sync_join_summary,
            sync_now,
            approve_sync_upgrade,
            startup_sync,
            leave_sync,
            set_sync_device_name,
            get_sync_recovery_key
        ])
        .build(tauri::generate_context!())?
        .run(handle_lifecycle);

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
        let no_new_frame = AppError::new(ErrorKind::NoNewFrame, "No new frame");
        assert_eq!(retry_decision(0, &no_new_frame), RetryDecision::RetryNow);
        assert_eq!(retry_decision(19, &no_new_frame), RetryDecision::Abort);
    }

    #[test]
    fn desktop_capabilities_keep_desktop_features() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(get_platform_capabilities())?,
            serde_json::json!({
                "platform": std::env::consts::OS,
                "sync": true,
                "desktopWindowControls": true,
                "updater": true,
                "imageClipboard": true,
            })
        );
        Ok(())
    }

    pub(super) fn test_state_directory(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        std::env::temp_dir().join(format!(
            "random-frame-lib-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn history_item(id: &str) -> HistoryItem {
        HistoryItem {
            source: "prntsc".to_owned(),
            id: id.to_owned(),
            source_page_url: format!("https://prnt.sc/{id}"),
            viewed_at: 42,
        }
    }

    #[test]
    fn startup_merges_history_and_only_viewed_legacy_exploration() -> Result<(), AppError> {
        let directory = test_state_directory("seen-migration");
        let history = HistoryStore::new(&directory)?;
        history.record(history_item("abc123"))?;
        std::fs::write(
            directory.join("prntsc-explored.txt"),
            "1,v\n2,r\n3\n1,v\n4,v\n5\n",
        )
        .map_err(AppError::persistence)?;
        // A prior launch may have saved only part of the migration.
        SeenStore::new(&directory)?.insert(1)?;

        for _ in 0..2 {
            let state = AppState::new(&directory, None)?;
            for id in [prntsc::item_id_value("abc123")?, 1, 4] {
                assert!(state.seen.contains(id));
            }
            for id in [2, 3, 5] {
                assert!(!state.seen.contains(id));
            }
            assert_eq!(state.explored.count(), 5);
        }
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn startup_repairs_history_saved_before_seen_and_clear_preserves_seen() -> Result<(), AppError>
    {
        let directory = test_state_directory("seen-repair-clear");
        HistoryStore::new(&directory)?.record(history_item("abc123"))?;
        let state = AppState::new(&directory, None)?;
        let id = prntsc::item_id_value("abc123")?;
        assert!(state.seen.contains(id));

        record_accepted_frame(&history_item("abc124"), &state, false)?;
        record_accepted_frame(&history_item("abc124"), &state, false)?;
        assert!(state.seen.contains(prntsc::item_id_value("abc124")?));
        assert_eq!(state.activity.viewed_total(), 1);
        clear_local_history(&state)?;
        assert_eq!(state.history.snapshot().history, vec![]);
        assert_eq!(state.explored.count(), 1);
        assert_eq!(state.explored.viewable_count(), 1);
        assert_eq!(state.activity.viewed_total(), 0);
        assert!(state.seen.contains(id));
        drop(state);
        let restarted = AppState::new(&directory, None)?;
        assert!(restarted.seen.contains(id));
        assert_eq!(restarted.explored.count(), 1);
        assert_eq!(restarted.explored.viewable_count(), 1);
        assert_eq!(restarted.activity.viewed_total(), 0);
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn accepted_manual_frame_is_seen_once_without_blocking_reopen() -> Result<(), AppError> {
        let directory = test_state_directory("manual-seen");
        let state = AppState::new(&directory, None)?;
        let id = prntsc::item_id_value("abc123")?;
        record_accepted_frame(&history_item("abc123"), &state, false)?;
        assert!(state.seen.contains(id));
        assert_eq!(state.explored.viewable_count(), 1);
        record_accepted_frame(&history_item("abc123"), &state, false)?;
        assert_eq!(state.history.snapshot().history.len(), 1);
        assert_eq!(state.activity.viewed_total(), 1);
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn legacy_history_import_does_not_count_views_again() -> Result<(), AppError> {
        let directory = test_state_directory("legacy-import-activity");
        let state = AppState::new(&directory, None)?;
        let id = prntsc::item_id_value("0abc123")?;
        record_accepted_frame(&history_item("0abc123"), &state, true)?;
        assert!(state.seen.contains(id));
        assert_eq!(state.activity.viewed_total(), 0);
        assert_eq!(state.explored.viewable_count(), 0);
        state.activity.migrate("2026-09-24", 1, 1, "2026-09-24")?;
        assert_eq!(state.activity.viewed_total(), 1);
        drop(state);
        assert!(AppState::new(&directory, None)?.seen.contains(id));
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn remote_snapshot_changes_only_seen() -> Result<(), AppError> {
        let directory = test_state_directory("remote-seen");
        let state = AppState::new(&directory, None)?;
        let history_before = state.history.snapshot();
        assert_eq!(state.seen.merge([42_u64])?, 1);
        assert!(state.seen.contains(42));
        assert_eq!(state.explored.count(), 0);
        assert_eq!(state.activity.viewed_total(), 0);
        assert_eq!(
            state.history.snapshot().history.len(),
            history_before.history.len()
        );
        drop(state);
        let restarted = AppState::new(&directory, None)?;
        assert!(restarted.seen.contains(42));
        assert_eq!(restarted.explored.count(), 0);
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[test]
    fn startup_repairs_revisit_overcount_from_older_builds_without_touching_other_data(
    ) -> Result<(), AppError> {
        // Pre-fix shape: activity counted 2 uncached revisits on top of 3 first views.
        let directory = test_state_directory("revisit-repair");
        std::fs::create_dir_all(&directory).map_err(AppError::persistence)?;
        let now = Local::now();
        let today = day_key(activity_day(&now));
        let viewed_at = u64::try_from(now.timestamp_millis()).unwrap_or_default();
        let history: Vec<_> = ["abc123", "abc124", "abc125"]
            .iter()
            .map(|id| {
                serde_json::json!({
                    "source": "prntsc",
                    "id": id,
                    "sourcePageUrl": format!("https://prnt.sc/{id}"),
                    "viewedAt": viewed_at,
                })
            })
            .collect();
        let write = |name: &str, contents: String| {
            std::fs::write(directory.join(name), contents).map_err(AppError::persistence)
        };
        write(
            "history.json",
            serde_json::json!({ "history": history, "index": 1 }).to_string(),
        )?;
        write(
            "activity.json",
            serde_json::json!({
                "migrated": false,
                "viewed_total": 5,
                "days": { &today: { "viewed": 5, "rejected": 2 } },
            })
            .to_string(),
        )?;
        write(
            "prntsc-explored.txt",
            "1,v\n2,v\n3,v\n4,r\n5,r\n".to_owned(),
        )?;

        for _ in 0..2 {
            let state = AppState::new(&directory, None)?;
            let days = state.activity.recent_days(activity_day(&now), 1);
            assert_eq!(days[0].1.viewed, 5);
            assert_eq!(days[0].1.rejected, 2);
            assert_eq!(state.activity.viewed_total(), 5);
            assert_eq!(state.explored.viewable_count(), 3);
            assert_eq!(state.explored.unavailable_count(), 2);
            assert_eq!(state.history.snapshot().history.len(), 3);
        }
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }

    #[tokio::test(start_paused = true)]
    async fn internet_archive_source_never_touches_exploration_or_activity_state(
    ) -> Result<(), AppError> {
        // InternetArchive must short-circuit before state.prntsc, or its ids leak into Prnt.sc counters.
        let directory = test_state_directory("internet-archive");
        let state = AppState::new(&directory, None)?;

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

#[cfg(test)]
mod startup_guard_tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn early_close_waits_for_imports_and_abandoned_initialization_is_bounded(
    ) -> Result<(), AppError> {
        let path = tests::test_state_directory("early-close");
        let state = AppState::new(&path, None)?;
        let started = tokio::time::Instant::now();
        let complete = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            state.imports_ready.send_replace(true);
        };
        tokio::join!(state.flush_before_exit(), complete);
        assert_eq!(started.elapsed(), Duration::from_millis(100));
        state.imports_ready.send_replace(false);
        let started = tokio::time::Instant::now();
        state.flush_before_exit().await;
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        std::fs::remove_dir_all(path).map_err(AppError::persistence)?;
        Ok(())
    }

    #[test]
    fn sync_exports_wait_for_startup_imports() -> Result<(), AppError> {
        let directory = tests::test_state_directory("startup-gate");
        let state = AppState::new(&directory, None)?;
        assert_eq!(
            state.ensure_imports_ready(),
            Err(SyncError::LocalMigrationPending)
        );
        state.imports_ready.send_replace(true);
        assert_eq!(state.ensure_imports_ready(), Ok(()));
        std::fs::remove_dir_all(directory).map_err(AppError::persistence)
    }
}

#[cfg(test)]
mod stats_performance_tests {
    use super::*;
    #[test]
    fn stats_join_preserves_first_draw_aliases_and_provider_boundaries() {
        let history: Vec<_> = [
            ("prntsc", "0b"),
            ("prntsc", "b"),
            ("other", "0b"),
            ("other", "b"),
            ("prntsc", "c"),
        ]
        .into_iter()
        .map(|(source, id)| HistoryItem {
            source: source.into(),
            id: id.into(),
            source_page_url: String::new(),
            viewed_at: 999,
        })
        .collect();
        let views: Vec<_> = [
            ("prntsc", "b", 10),
            ("prntsc", "0b", 20),
            ("other", "b", 30),
        ]
        .into_iter()
        .map(|(source, id, at_ms)| FrameView {
            source: source.into(),
            id: id.into(),
            at_ms,
            day: "2026-10-19".into(),
            day_inferred: false,
        })
        .collect();
        assert_eq!(
            draw_view_times(&history, &views),
            vec![Some(10), Some(10), None, Some(30), None]
        );
    }
    #[test]
    #[ignore = "manual stats read benchmark"]
    #[allow(
        clippy::print_stderr,
        reason = "measurement is reported from an ignored test"
    )]
    fn stats_join_timing() {
        let history: Vec<_> = (0..10_000)
            .map(|i| HistoryItem {
                source: "prntsc".into(),
                id: format!("a{i:06}"),
                source_page_url: String::new(),
                viewed_at: 0,
            })
            .collect();
        let views: Vec<_> = history
            .iter()
            .enumerate()
            .map(|(i, x)| FrameView {
                source: x.source.clone(),
                id: x.id.clone(),
                at_ms: i as u64,
                day: "2026-10-19".into(),
                day_inferred: false,
            })
            .collect();
        let start = std::time::Instant::now();
        let times = std::hint::black_box(draw_view_times(&history, &views));
        assert_eq!(times.last(), Some(&Some(9_999)));
        eprintln!("stats 10k history/view join: {:?}", start.elapsed());
    }
}
