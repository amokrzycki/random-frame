pub mod prntsc;

use crate::error::{AppError, ErrorKind};
use rand::{seq::IteratorRandom, Rng};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Prntsc,
    InternetArchive,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Self::Prntsc => "prntsc",
            Self::InternetArchive => "internet-archive",
        }
    }

    fn available(self) -> bool {
        matches!(self, Self::Prntsc)
    }
}

const SOURCES: [Source; 2] = [Source::Prntsc, Source::InternetArchive];

pub fn select_source(requested: &str) -> Result<Source, AppError> {
    select_source_with(requested, &mut rand::thread_rng())
}

fn select_source_with(requested: &str, random: &mut impl Rng) -> Result<Source, AppError> {
    if requested == "mixed" {
        return SOURCES
            .iter()
            .copied()
            .filter(|source| source.available())
            .choose(random)
            .ok_or_else(|| {
                AppError::new(
                    ErrorKind::UnavailableSource,
                    "No sources are currently available",
                )
            });
    }

    let source = SOURCES
        .iter()
        .copied()
        .find(|source| source.id() == requested)
        .ok_or_else(|| {
            AppError::new(
                ErrorKind::UnknownSource,
                format!("Unknown source: {requested}"),
            )
        })?;
    if !source.available() {
        return Err(AppError::new(
            ErrorKind::UnavailableSource,
            format!("{} source is not available yet", source.id()),
        ));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::mock::StepRng;

    #[test]
    fn selects_explicit_unknown_and_unavailable_sources() {
        let mut random = StepRng::new(0, 0);
        assert!(matches!(
            select_source_with("prntsc", &mut random),
            Ok(Source::Prntsc)
        ));
        assert!(matches!(
            select_source_with("unknown", &mut random),
            Err(AppError {
                kind: ErrorKind::UnknownSource,
                ..
            })
        ));
        assert!(matches!(
            select_source_with("internet-archive", &mut random),
            Err(AppError {
                kind: ErrorKind::UnavailableSource,
                ..
            })
        ));
    }

    #[test]
    fn mixed_routes_only_to_the_prntsc_exploration_pipeline() {
        let mut random = StepRng::new(0, 1);
        assert!(matches!(
            select_source_with("mixed", &mut random),
            Ok(Source::Prntsc)
        ));
        assert!(matches!(
            select_source_with("mixed", &mut random),
            Ok(Source::Prntsc)
        ));
    }
}
