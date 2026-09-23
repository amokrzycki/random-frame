use crate::error::{AppError, ErrorKind};
use rand::{distributions::Uniform, Rng};

const BASE36_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

// Empirically determined practical upper bound of the legacy
// sequential base-36 Lightshot namespace.
// 26y3ahr is the last confirmed assigned ID found during boundary probing.
const LEGACY_MAX_ID: &str = "26y3ahr";
pub(crate) const LEGACY_MAX_VALUE: u64 = 4_773_622_239;

pub(super) fn make_id() -> String {
    let mut random = rand::thread_rng();
    let range = Uniform::new_inclusive(0u64, LEGACY_MAX_VALUE);
    value_to_base36(random.sample(range))
}

fn value_to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(BASE36_ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits)
        .unwrap_or_else(|invalid| String::from_utf8_lossy(invalid.as_bytes()).into_owned())
}

fn base36_to_value(id: &str) -> Option<u64> {
    id.bytes().try_fold(0u64, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte - b'0'),
            b'a'..=b'z' => u64::from(byte - b'a') + 10,
            _ => return None,
        };
        value.checked_mul(36)?.checked_add(digit)
    })
}

pub fn validate_item_id(id: &str) -> Result<(), AppError> {
    item_id_value(id).map(drop)
}

pub(crate) fn item_id_value(id: &str) -> Result<u64, AppError> {
    if !id.is_empty() && id.len() <= LEGACY_MAX_ID.len() {
        if let Some(value) = base36_to_value(id).filter(|value| *value <= LEGACY_MAX_VALUE) {
            return Ok(value);
        }
    }
    Err(AppError::new(
        ErrorKind::InvalidInput,
        "Invalid image identifier",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_variable_length_legacy_base36_ids() {
        assert!(validate_item_id("abc123").is_ok());
        assert!(validate_item_id("abc12").is_ok());
        assert!(validate_item_id(LEGACY_MAX_ID).is_ok());
        assert_eq!(item_id_value("0abc123").ok(), item_id_value("abc123").ok());
        assert_eq!(item_id_value("00").ok(), Some(0));
        for invalid in [
            "26y3ahs", "26y3ahz", "zzzzzzz", "ABC123", "abc-12", "ąbc123", "",
        ] {
            assert!(matches!(
                validate_item_id(invalid),
                Err(AppError {
                    kind: ErrorKind::InvalidInput,
                    ..
                })
            ));
        }
    }

    #[test]
    fn base36_conversions_match_known_boundary_values() {
        assert!(matches!(
            (
                base36_to_value("8aupm6"),
                base36_to_value(LEGACY_MAX_ID)
            ),
            (Some(lower), Some(upper)) if lower < upper
        ));
        assert_eq!(base36_to_value(LEGACY_MAX_ID), Some(LEGACY_MAX_VALUE));
        assert_eq!(value_to_base36(LEGACY_MAX_VALUE), LEGACY_MAX_ID);
        assert_eq!(value_to_base36(LEGACY_MAX_VALUE + 1), "26y3ahs");
        assert_eq!(item_id_value("0").ok(), Some(0));
        assert_eq!(item_id_value(LEGACY_MAX_ID).ok(), Some(LEGACY_MAX_VALUE));
        assert!(item_id_value("26y3ahs").is_err());
    }

    #[test]
    fn value_to_base36_never_pads() {
        assert_eq!(value_to_base36(0), "0");
        assert_eq!(value_to_base36(35), "z");
        assert_eq!(value_to_base36(36), "10");
    }

    #[test]
    fn legacy_id_generator_stays_in_bound_lowercase_and_unpadded() {
        let mut saw_seven_char_id = false;
        for _ in 0..2000 {
            let id = make_id();
            assert!(id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
            assert!(id.len() <= LEGACY_MAX_ID.len());
            assert!(matches!(
                base36_to_value(&id),
                Some(value) if value <= LEGACY_MAX_VALUE
            ));
            if id.len() == LEGACY_MAX_ID.len() {
                saw_seven_char_id = true;
            }
        }
        assert!(
            saw_seven_char_id,
            "expected at least one 7-char id in 2000 samples"
        );
    }

    #[test]
    fn round_trips_value_through_base36_at_key_boundaries() {
        let six_digit_max = 36u64.pow(6) - 1;
        let seven_digit_min = 36u64.pow(6);
        for value in [0, 35, 36, six_digit_max, seven_digit_min, LEGACY_MAX_VALUE] {
            assert_eq!(base36_to_value(&value_to_base36(value)), Some(value));
            assert_eq!(item_id_value(&value_to_base36(value)).ok(), Some(value));
        }
    }

    #[test]
    fn never_generates_a_value_above_the_legacy_max() {
        for _ in 0..100_000 {
            assert!(
                matches!(base36_to_value(&make_id()), Some(value) if value <= LEGACY_MAX_VALUE)
            );
        }
    }

    // Uniform sampling over 0..=LEGACY_MAX_VALUE, converted straight to base36
    // with no padding, means string length is a deterministic function of the
    // sampled integer rather than something chosen separately. Since
    // 2 * 36^6 - 1 < LEGACY_MAX_VALUE < 3 * 36^6, the "<= zzzzzz" and "1xxxxxx"
    // buckets are each exactly one full 36^6-sized block (~45.6%), and the
    // remaining "2xxxxxx..26y3ahr" partial block is ~8.8%. Frequent 1xxxxxx
    // ids are an expected consequence of the range, not a distribution bug.
    #[test]
    fn generated_ids_match_the_expected_length_bucket_distribution() {
        const SAMPLES: u32 = 200_000;
        let six_digit_max = 36u64.pow(6) - 1; // "zzzzzz"
        let leading_one_max = 2 * 36u64.pow(6) - 1; // "1zzzzzz"

        let mut short = 0u32;
        let mut leading_one = 0u32;
        let mut leading_high = 0u32;

        for _ in 0..SAMPLES {
            // make_id() only ever emits BASE36_ALPHABET bytes, so this is always Some;
            // unwrap_or(0) sidesteps the crate's expect_used/unwrap_used lints.
            let value = base36_to_value(&make_id()).unwrap_or(0);
            if value <= six_digit_max {
                short += 1;
            } else if value <= leading_one_max {
                leading_one += 1;
            } else {
                leading_high += 1;
            }
        }

        let assert_share = |count: u32, expected: f64, label: &str| {
            let share = f64::from(count) / f64::from(SAMPLES);
            let tolerance = 0.01; // ~9 sigma at 200k samples, generous but bug-sensitive
            assert!(
                (share - expected).abs() < tolerance,
                "{label} share {share:.4} not within tolerance of expected {expected:.4}"
            );
        };
        assert_share(short, 0.4561, "<= zzzzzz");
        assert_share(leading_one, 0.4561, "1xxxxxx");
        assert_share(leading_high, 0.0878, "2xxxxxx..26y3ahr");
    }
}
