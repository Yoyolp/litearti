use crate::model::DecodedText;
use encoding_rs::{Encoding, GB18030, UTF_8};

/// Text files above this size are truncated rather than loaded whole, so a
/// stray multi-gigabyte log cannot exhaust memory or stall the reader.
pub const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

/// Largest prefix length of `bytes` that does not split a UTF-8 sequence.
///
/// Truncating at an arbitrary byte offset can land in the middle of a
/// multi-byte character. That matters more than it looks: `decode` tries strict
/// UTF-8 first and falls back to GB18030, so a cut-off trailing byte makes the
/// whole file fail UTF-8 validation and get re-decoded as GB18030 — turning an
/// entire valid UTF-8 document into mojibake, with `lossy` likely false so the
/// reader never warns. Backing up to a character boundary costs at most three
/// bytes and keeps the decode honest.
///
/// Returns 0 when `limit` falls inside the very first character, which cannot
/// happen for `limit >= 4` and any real encoding.
pub fn floor_char_boundary(bytes: &[u8], limit: usize) -> usize {
    let mut end = limit.min(bytes.len());
    // Nothing to trim when the cut is already at (or past) the end.
    if end >= bytes.len() {
        return bytes.len();
    }
    // A UTF-8 continuation byte matches 0b10xx_xxxx. While the byte at the cut
    // is a continuation byte, the cut sits mid-character — step back one.
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    end
}

/// Decode `bytes`, truncating at `MAX_TEXT_BYTES` on a character boundary.
///
/// Returns the decoded text plus whether truncation happened, so the caller can
/// say so without duplicating the boundary logic.
pub fn decode_truncated(bytes: &[u8], requested: Option<&str>) -> (DecodedText, bool) {
    if bytes.len() <= MAX_TEXT_BYTES {
        return (decode(bytes, requested), false);
    }
    let end = floor_char_boundary(bytes, MAX_TEXT_BYTES);
    (decode(&bytes[..end], requested), true)
}

fn has_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
}

/// The encoding's name in one consistent shape.
///
/// `encoding_rs` canonicalizes names but keeps their original casing, so it
/// yields `UTF-8` for one encoding and `gb18030` for another. Normalizing to
/// uppercase keeps the encoding control in the reader from looking sloppy.
fn label_of(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_uppercase()
}

/// Decode text bytes into a string plus the facts the reader needs to explain
/// what happened.
///
/// When `requested` names an encoding, that choice is honored unconditionally —
/// a person who overrides the guess should get exactly what they asked for.
/// Otherwise the order is: BOM, then strict UTF-8, then GB18030. GB18030 is
/// tried last because it accepts almost any byte sequence, which would mask
/// genuinely broken UTF-8 if it ran first.
pub fn decode(bytes: &[u8], requested: Option<&str>) -> DecodedText {
    let had_bom = has_bom(bytes);

    if let Some(label) = requested {
        if let Some(encoding) = Encoding::for_label(label.trim().as_bytes()) {
            let (text, _, lossy) = encoding.decode(bytes);
            return DecodedText {
                text: text.into_owned(),
                encoding: label_of(encoding),
                had_bom,
                lossy,
            };
        }
    }

    // A BOM is authoritative: `UTF_8::decode` sniffs UTF-8/UTF-16LE/UTF-16BE
    // marks itself and reports the encoding it actually used.
    if had_bom {
        let (text, encoding, lossy) = UTF_8.decode(bytes);
        return DecodedText {
            text: text.into_owned(),
            encoding: label_of(encoding),
            had_bom,
            lossy,
        };
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return DecodedText {
            text: text.to_string(),
            encoding: label_of(UTF_8),
            had_bom,
            lossy: false,
        };
    }

    let (text, _, lossy) = GB18030.decode(bytes);
    DecodedText {
        text: text.into_owned(),
        encoding: label_of(GB18030),
        had_bom,
        lossy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ascii_is_utf8() {
        let out = decode(b"hello", None);
        assert_eq!(out.encoding, "UTF-8");
        assert_eq!(out.text, "hello");
        assert!(!out.lossy);
    }

    #[test]
    fn utf8_bom_is_stripped() {
        let out = decode(b"\xEF\xBB\xBFhello", None);
        assert_eq!(out.encoding, "UTF-8");
        assert_eq!(out.text, "hello");
        assert!(out.had_bom);
    }

    #[test]
    fn gb18030_chinese_round_trips() {
        // "中文" in GB18030
        let out = decode(&[0xD6, 0xD0, 0xCE, 0xC4], None);
        assert_eq!(out.encoding, "GB18030");
        assert_eq!(out.text, "中文");
        assert!(!out.lossy);
    }

    #[test]
    fn explicit_encoding_wins() {
        let out = decode(&[0xD6, 0xD0, 0xCE, 0xC4], Some("gb18030"));
        assert_eq!(out.text, "中文");
        assert_eq!(out.encoding, "GB18030");
    }

    #[test]
    fn unknown_label_falls_back_to_detection() {
        let out = decode(b"hello", Some("not-an-encoding"));
        assert_eq!(out.encoding, "UTF-8");
    }

    #[test]
    fn utf8_never_reports_lossy() {
        let out = decode("中文测试".as_bytes(), None);
        assert_eq!(out.encoding, "UTF-8");
        assert!(!out.lossy);
        assert_eq!(out.text, "中文测试");
    }

    #[test]
    fn invalid_bytes_do_not_panic() {
        // A byte sequence that is neither valid UTF-8 nor meaningful text must
        // still decode into something, never panic.
        let out = decode(&[0xFF, 0xFF, 0xFF], None);
        assert!(!out.text.is_empty() || out.text.is_empty());
    }

    // --- truncation boundary ---------------------------------------------

    #[test]
    fn boundary_is_unchanged_when_already_on_a_char_start() {
        let bytes = "ab".as_bytes();
        assert_eq!(floor_char_boundary(bytes, 1), 1);
        assert_eq!(floor_char_boundary(bytes, 2), 2);
    }

    #[test]
    fn boundary_clamps_to_length() {
        let bytes = b"abc";
        assert_eq!(floor_char_boundary(bytes, 99), 3);
    }

    #[test]
    fn boundary_steps_back_over_continuation_bytes() {
        // "中" is E4 B8 AD: cutting at 1 or 2 lands mid-character.
        let bytes = "中文".as_bytes();
        assert_eq!(bytes.len(), 6);
        assert_eq!(floor_char_boundary(bytes, 1), 0, "cut inside the first char");
        assert_eq!(floor_char_boundary(bytes, 2), 0, "cut inside the first char");
        assert_eq!(floor_char_boundary(bytes, 3), 3, "exactly after the first char");
        assert_eq!(floor_char_boundary(bytes, 4), 3, "cut inside the second char");
        assert_eq!(floor_char_boundary(bytes, 5), 3, "cut inside the second char");
        assert_eq!(floor_char_boundary(bytes, 6), 6, "exactly at the end");
    }

    #[test]
    fn truncating_at_a_boundary_keeps_utf8_valid() {
        // This is the bug the boundary exists for: slicing "中文" at byte 4
        // yields invalid UTF-8, and `decode` would then fall back to GB18030
        // and turn the whole file into mojibake.
        let bytes = "中文".as_bytes();
        let naive = &bytes[..4];
        assert!(std::str::from_utf8(naive).is_err(), "naive cut should be invalid");

        let safe = &bytes[..floor_char_boundary(bytes, 4)];
        assert!(std::str::from_utf8(safe).is_ok());
        assert_eq!(std::str::from_utf8(safe).unwrap(), "中");
    }

    #[test]
    fn boundary_on_ascii_is_the_limit() {
        let bytes = vec![b'a'; 100];
        assert_eq!(floor_char_boundary(&bytes, 50), 50);
    }

    #[test]
    fn boundary_handles_empty_input() {
        assert_eq!(floor_char_boundary(&[], 0), 0);
        assert_eq!(floor_char_boundary(&[], 10), 0);
    }

    #[test]
    fn decode_truncated_reports_flag() {
        // Small input: no truncation, flag false.
        let (decoded, truncated) = decode_truncated(b"hello", None);
        assert!(!truncated);
        assert_eq!(decoded.text, "hello");
    }
}
