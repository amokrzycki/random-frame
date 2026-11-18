//! The 24-word join code: a 32-byte seed in the BIP-39 English encoding.
use bip39::{Error, Language, Mnemonic};
use std::fmt;
use zeroize::Zeroizing;

const WORDS: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeError {
    WordCount,
    UnknownWord(usize),
    Checksum,
}

impl fmt::Display for CodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WordCount => f.write_str("The code must have 24 words"),
            Self::UnknownWord(position) => {
                write!(f, "Word {} is not in the word list", position + 1)
            }
            Self::Checksum => f.write_str("The code has a typo"),
        }
    }
}

impl std::error::Error for CodeError {}

pub fn encode(seed: &[u8; 32]) -> Result<Zeroizing<String>, CodeError> {
    let mnemonic =
        Mnemonic::from_entropy_in(Language::English, seed).map_err(|_| CodeError::Checksum)?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

pub fn decode(input: &str) -> Result<Zeroizing<[u8; 32]>, CodeError> {
    let normalized = Zeroizing::new(
        input
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join(" "),
    );
    if normalized.split(' ').count() != WORDS {
        return Err(CodeError::WordCount);
    }
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(
        |error| match error {
            Error::UnknownWord(position) => CodeError::UnknownWord(position),
            Error::BadWordCount(_) => CodeError::WordCount,
            _ => CodeError::Checksum,
        },
    )?;
    let entropy = Zeroizing::new(mnemonic.to_entropy());
    let mut seed = Zeroizing::new([0; 32]);
    seed.copy_from_slice(&entropy);
    Ok(seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: [(&str, &str); 8] = [
    (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    ),
    (
        "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    ),
    (
        "8080808080808080808080808080808080808080808080808080808080808080",
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
    ),
    (
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    ),
    (
        "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c",
        "hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length",
    ),
    (
        "9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863",
        "panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside",
    ),
    (
        "066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad",
        "all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform",
    ),
    (
        "f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f",
        "void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold",
    ),
    ];

    #[test]
    fn matches_the_official_256_bit_vectors() -> Result<(), Box<dyn std::error::Error>> {
        for (hex_seed, words) in VECTORS {
            let mut seed = [0; 32];
            hex::decode_to_slice(hex_seed, &mut seed)?;
            assert_eq!(encode(&seed)?.as_str(), words);
            assert_eq!(*decode(words)?, seed);
        }
        Ok(())
    }

    #[test]
    fn accepts_case_and_irregular_whitespace() -> Result<(), CodeError> {
        let (_, words) = VECTORS[1];
        let messy = format!("  {}\n\t", words.to_uppercase().replacen(' ', "   ", 3));
        assert_eq!(*decode(&messy)?, [0x7f; 32]);
        Ok(())
    }

    #[test]
    fn reports_word_count_unknown_word_and_checksum_separately() {
        let (_, words) = VECTORS[0];
        let short = words.split(' ').take(23).collect::<Vec<_>>().join(" ");
        assert_eq!(decode(&short).err(), Some(CodeError::WordCount));
        assert_eq!(decode("").err(), Some(CodeError::WordCount));
        let unknown = words.replacen("abandon", "abandonx", 1);
        assert_eq!(decode(&unknown).err(), Some(CodeError::UnknownWord(0)));
        let wrong_checksum = words.replace(" art", " abandon");
        assert_eq!(decode(&wrong_checksum).err(), Some(CodeError::Checksum));
        let (_, other) = VECTORS[3];
        assert_eq!(
            decode(&format!("{other} zoo")).err(),
            Some(CodeError::WordCount)
        );
    }

    #[test]
    fn twelve_word_phrases_are_not_codes() {
        let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        assert_eq!(decode(twelve).err(), Some(CodeError::WordCount));
    }
}
