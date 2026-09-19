use crate::error::{AppError, ErrorKind};
use std::time::Instant;

const CAPACITY: f64 = 8.0;
const REFILL_PER_SECOND: f64 = 3.0;

pub struct RateLimiter {
    tokens: f64,
    updated_at: Instant,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            tokens: CAPACITY,
            updated_at: Instant::now(),
        }
    }

    fn take_at(&mut self, now: Instant) -> Result<(), AppError> {
        self.tokens = (self.tokens
            + now.duration_since(self.updated_at).as_secs_f64() * REFILL_PER_SECOND)
            .min(CAPACITY);
        self.updated_at = now;
        if self.tokens < 1.0 {
            return Err(AppError::new(
                ErrorKind::RateLimited,
                "Too many requests. Please try again shortly.",
            ));
        }
        self.tokens -= 1.0;
        Ok(())
    }

    pub fn take(&mut self) -> Result<(), AppError> {
        self.take_at(Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn enforces_capacity_and_refills_three_tokens_per_second() {
        let start = Instant::now();
        let mut limiter = RateLimiter {
            tokens: CAPACITY,
            updated_at: start,
        };
        for _ in 0..8 {
            assert!(limiter.take_at(start).is_ok());
        }
        assert_eq!(
            limiter.take_at(start).unwrap_err().kind,
            ErrorKind::RateLimited
        );
        assert!(limiter.take_at(start + Duration::from_millis(334)).is_ok());
        assert_eq!(
            limiter
                .take_at(start + Duration::from_millis(334))
                .unwrap_err()
                .kind,
            ErrorKind::RateLimited
        );
    }
}
