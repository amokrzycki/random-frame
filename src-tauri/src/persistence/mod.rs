mod activity;
mod exploration;
mod favorites;
mod history;
mod io;
mod seen;
mod sync_ops;

#[allow(unused_imports, reason = "preserve the persistence module API")]
pub use activity::{activity_day, day_key, ActivityStore, DailyActivitySnapshot};
pub use exploration::{ExplorationOutcome, ExplorationStore};
#[allow(unused_imports, reason = "preserve the persistence module API")]
pub use favorites::{FavoriteItem, FavoriteStore, FavoriteSyncState};
#[allow(unused_imports, reason = "preserve the persistence module API")]
pub use history::{HistoryItem, HistorySnapshot, HistoryStore, HistorySyncState, RemovedFrame};
pub(crate) use io::save_json;
pub use seen::SeenStore;

#[cfg(test)]
mod tests;
