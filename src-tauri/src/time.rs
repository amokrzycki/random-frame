use std::time::{Duration, SystemTime};

// ponytail: returns u64::MAX if system clock is before Unix epoch (misconfigured systems).
// Callers comparing timestamps should treat u64::MAX as an error sentinel.
pub fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
