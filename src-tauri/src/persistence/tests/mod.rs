use super::io::load_json;
use super::*;
use crate::{
    error::AppError,
    snapshot::{self, MAX_SECTION},
};
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::PathBuf,
    sync::Arc,
    thread,
    time::SystemTime,
};

pub(super) fn test_directory(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    std::env::temp_dir().join(format!(
        "random-frame-{name}-{}-{nonce}",
        std::process::id()
    ))
}

fn day_at(rfc3339: &str) -> Result<NaiveDate, AppError> {
    DateTime::parse_from_rfc3339(rfc3339)
        .map(|instant| activity_day(&instant))
        .map_err(AppError::persistence)
}

mod activity;
mod device;
mod history_favorites;
mod migration;
mod seen_exploration;
