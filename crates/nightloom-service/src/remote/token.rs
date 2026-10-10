//! The bearer token the phone sends, and the QR code that carries it there.
//!
//! One token for the listener, generated once and kept in the OS credential
//! store under the same service the API keys use (`credentials::
//! remote_token`), so it is never on disk in the clear. The tailnet already
//! limits who can reach the port to his own devices; the token is the
//! second lock, for a tailnet that one day has a device on it that is not
//! his. Regenerating it is the revocation.
//!
//! **Shape** (nightshift blocker 173, its default taken): the 122 random
//! bits of one uuid v4, written as 32 lowercase hex characters. Long enough
//! that guessing is not a path in, short enough to type from the card once
//! if the camera is not to hand; the QR carries it as a URL fragment so a
//! scan is the whole setup.

/// A fresh token.
pub fn generate() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Whether `presented` is this listener's token, compared in constant time
/// so the comparison's duration says nothing about how much of it matched.
/// An empty expected token matches nothing: a listener with no token is a
/// listener nobody may drive, not one anybody may.
pub fn matches(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    if a.is_empty() {
        return false;
    }
    // Every byte of the longer one is visited whatever the shorter says,
    // and the lengths are folded in rather than returned on early.
    let mut diff = (a.len() != b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

/// The URL the phone opens: the page, with the token in the fragment. A
/// fragment never leaves the browser — it is not sent in the request — so
/// the token is not in the listener's logs or any proxy's; the page reads
/// it once, stores it, and strips it from the address bar.
pub fn setup_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/#token={token}")
}

/// The setup URL as a QR code, an SVG the Settings card can draw inline.
/// Error-correction level M: a phone camera across a desk reads it fine,
/// and a lower level keeps the code small enough to scan off a laptop
/// screen at arm's length.
pub fn qr_svg(contents: &str) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(contents, qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(200, 200)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_32_hex_chars_and_two_are_never_the_same() {
        let a = generate();
        let b = generate();
        assert_eq!(a.len(), 32);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_ne!(a, b);
    }

    #[test]
    fn matching_is_exact() {
        let t = generate();
        assert!(matches(&t, &t));
        assert!(!matches(&t, &t[..31]));
        assert!(!matches(&t, &format!("{t}0")));
        assert!(!matches(&t, ""));
        assert!(
            !matches("", ""),
            "an empty token never matches: there is nothing to match"
        );
    }

    #[test]
    fn the_setup_url_carries_the_token_as_a_fragment() {
        let url = setup_url("100.121.88.105", 8642, "abc");
        assert_eq!(url, "http://100.121.88.105:8642/#token=abc");
    }

    #[test]
    fn the_qr_is_an_svg() {
        let svg = qr_svg(&setup_url("100.121.88.105", 8642, &generate())).unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("<svg"));
    }
}
