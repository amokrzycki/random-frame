use std::time::{Duration, SystemTime};

pub fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
