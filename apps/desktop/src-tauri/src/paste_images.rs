//! Item 382: the images of a paste that holds text and images, for the
//! composer (`pasteImages.ts`).
//!
//! A copy from a web page reaches the composer's paste event as HTML whose
//! `<img>` srcs are `http(s)` URLs (measured 2026-10-18, nightshift
//! `notes/runner-design/wave11-b-report.md`). [`fetch_paste_image`] gets one:
//!
//! 1. **From the pasteboard first** (macOS): Safari's copy puts a web archive
//!    on the pasteboard that already holds every image's bytes, keyed by URL —
//!    no network, and an image behind a login comes too.
//! 2. **Else from the network**: a plain GET with no cookies (the client has
//!    no cookie store), a 20 s budget, a size cap at the model's own image
//!    limit, at most 5 redirects, and never to this machine or its network —
//!    the paste's HTML is the copied page's, and a crafted `<img>` must not
//!    reach Nightloom's own listener or the router. Each hop's address is
//!    resolved, checked and pinned before the connection.
//!
//! The answer is a PNG, JPEG, GIF or WebP (judged by its bytes, not the
//! server's word) as base64 — what an image chip holds — or the reason it is
//! not, which the composer writes into the image's marker.

use base64::Engine as _;
use reqwest::Url;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

/// The model takes an image up to 10 MB of base64 (`MAX_IMAGE_BASE64` in
/// `attachFiles.svelte.ts`): this many raw bytes.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024 / 4 * 3;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Nightloom";

/// An image as a chip holds it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PastedImage {
    pub media_type: String,
    /// Base64, no `data:` prefix.
    pub data: String,
}

/// One `http(s)` image of a paste: the pasteboard's web archive, else the
/// network. `Err` is a short reason.
#[tauri::command]
pub async fn fetch_paste_image(url: String) -> Result<PastedImage, String> {
    let parsed = web_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        let u = url.clone();
        if let Ok(Some(img)) = tokio::task::spawn_blocking(move || pasteboard_image(&u)).await {
            return Ok(img);
        }
    }
    fetch(parsed, false, TIMEOUT, MAX_IMAGE_BYTES).await
}

fn web_url(url: &str) -> Result<Url, String> {
    let u = Url::parse(url).map_err(|_| "not a web address".to_string())?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        _ => Err("not a web address".into()),
    }
}

/// The image type its first bytes say, of those the model takes.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn as_image(bytes: &[u8], cap: usize) -> Result<PastedImage, String> {
    if bytes.len() > cap {
        return Err("over the image size limit".into());
    }
    let media_type = sniff(bytes).ok_or("not a PNG, JPEG, GIF or WebP image")?;
    Ok(PastedImage {
        media_type: media_type.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// This machine, its network, or nowhere: never fetched from a paste.
fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // carrier-grade NAT, 100.64/10
                || o[0] == 0
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments, 192.0.0/24
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking, 198.18/15
                || o[0] >= 240 // reserved, 240/4
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] & 0xffc0) == 0xfec0 // site local (deprecated, still routed by some)
                // An IPv4 address inside v6: mapped (::ffff:a.b.c.d),
                // compatible (::a.b.c.d) or NAT64's 64:ff9b::/96 — judged
                // as the IPv4 address it reaches (review 2026-10-18).
                || v.to_ipv4().is_some_and(|m| is_local(IpAddr::V4(m)))
                || (s[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
                    && is_local(IpAddr::V4(std::net::Ipv4Addr::new(
                        (s[6] >> 8) as u8,
                        s[6] as u8,
                        (s[7] >> 8) as u8,
                        s[7] as u8,
                    ))))
        }
    }
}

/// The host as an address when it is one; `None` for a name.
fn host_ip(url: &Url) -> Result<Option<IpAddr>, String> {
    let host = url.host_str().ok_or("no host")?;
    Ok(host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok())
}

/// The address to connect to for `url`, refused when it is local (unless
/// `allow_local`, for the tests' own server).
async fn checked_addr(url: &Url, allow_local: bool) -> Result<SocketAddr, String> {
    let port = url.port_or_known_default().ok_or("no port")?;
    let ip = match host_ip(url)? {
        Some(ip) => ip,
        None => tokio::net::lookup_host((url.host_str().unwrap_or_default(), port))
            .await
            .map_err(|_| "the address did not resolve".to_string())?
            .map(|a| a.ip())
            // Every address it resolves to must pass; the first is used.
            .try_fold(None, |first: Option<IpAddr>, ip| {
                if is_local(ip) && !allow_local {
                    Err("a local address".to_string())
                } else {
                    Ok(first.or(Some(ip)))
                }
            })?
            .ok_or("the address did not resolve")?,
    };
    if is_local(ip) && !allow_local {
        return Err("a local address".into());
    }
    Ok(SocketAddr::new(ip, port))
}

/// GET `url` as an image: redirects followed by hand (each hop checked and
/// pinned), the body read up to `cap` bytes, the whole within `budget`.
async fn fetch(
    mut url: Url,
    allow_local: bool,
    budget: Duration,
    cap: usize,
) -> Result<PastedImage, String> {
    let deadline = tokio::time::Instant::now() + budget;
    let late = || "timed out".to_string();
    for _ in 0..=MAX_REDIRECTS {
        let addr = checked_addr(&url, allow_local).await?;
        let mut b = reqwest::Client::builder()
            // No proxy: a proxy would resolve the name itself, past the
            // check and the pin above (review 2026-10-18).
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
        if host_ip(&url)?.is_none() {
            b = b.resolve(url.host_str().unwrap_or_default(), addr);
        }
        let client = b.build().map_err(|e| e.to_string())?;
        let mut resp = tokio::time::timeout_at(
            deadline,
            client
                .get(url.clone())
                .header(
                    reqwest::header::ACCEPT,
                    "image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8",
                )
                .send(),
        )
        .await
        .map_err(|_| late())?
        .map_err(|e| {
            if e.is_timeout() {
                late()
            } else {
                "the server could not be reached".to_string()
            }
        })?;
        let status = resp.status();
        if status.is_redirection() {
            let to = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("a redirect with nowhere to go")?;
            url = web_url(
                url.join(to)
                    .map_err(|_| "a bad redirect".to_string())?
                    .as_str(),
            )?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("the server answered {}", status.as_u16()));
        }
        if resp.content_length().is_some_and(|n| n as usize > cap) {
            return Err("over the image size limit".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = tokio::time::timeout_at(deadline, resp.chunk())
            .await
            .map_err(|_| late())?
            .map_err(|e| {
                if e.is_timeout() {
                    late()
                } else {
                    "the download broke off".to_string()
                }
            })?
        {
            if body.len() + chunk.len() > cap {
                return Err("over the image size limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        return as_image(&body, cap);
    }
    Err("too many redirects".into())
}

/// The image the web archive holds for `url`, if it holds it.
pub fn find_in_webarchive(archive: &[u8], url: &str) -> Option<PastedImage> {
    let v = plist::Value::from_reader(std::io::Cursor::new(archive)).ok()?;
    let subs = v.as_dictionary()?.get("WebSubresources")?.as_array()?;
    subs.iter().find_map(|s| {
        let d = s.as_dictionary()?;
        if d.get("WebResourceURL")?.as_string()? != url {
            return None;
        }
        as_image(d.get("WebResourceData")?.as_data()?, MAX_IMAGE_BYTES).ok()
    })
}

#[cfg(target_os = "macos")]
fn pasteboard_image(url: &str) -> Option<PastedImage> {
    find_in_webarchive(&pasteboard_data("com.apple.webarchive")?, url)
}

/// The general pasteboard's data of one type, copied out.
#[cfg(target_os = "macos")]
fn pasteboard_data(kind: &str) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let kind = std::ffi::CString::new(kind).ok()?;
    objc2::rc::autoreleasepool(|_| unsafe {
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return None;
        }
        let ty: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: kind.as_ptr()];
        if ty.is_null() {
            return None;
        }
        let data: *mut AnyObject = msg_send![pb, dataForType: ty];
        if data.is_null() {
            return None;
        }
        let len: usize = msg_send![data, length];
        let ptr: *const std::ffi::c_void = msg_send![data, bytes];
        if ptr.is_null() || len == 0 {
            return None;
        }
        Some(std::slice::from_raw_parts(ptr.cast::<u8>(), len).to_vec())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn png() -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.extend_from_slice(&[0u8; 40]);
        v
    }

    /// A one-request-at-a-time server on 127.0.0.1 answering every request
    /// with `reply` (a whole HTTP response), or never answering.
    async fn serve(reply: Option<Vec<u8>>) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else {
                    return;
                };
                let reply = reply.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    match reply {
                        Some(r) => {
                            let _ = s.write_all(&r).await;
                        }
                        None => tokio::time::sleep(Duration::from_secs(30)).await,
                    }
                });
            }
        });
        format!("http://{addr}")
    }

    fn ok(ct: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        r.extend_from_slice(body);
        r
    }

    #[tokio::test]
    async fn an_image_comes_back_as_base64_typed_by_its_bytes() {
        // The server calls it text/plain; the bytes say PNG.
        let base = serve(Some(ok("text/plain", &png()))).await;
        let got = fetch(
            Url::parse(&format!("{base}/a.png")).unwrap(),
            true,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(got.media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(got.data)
                .unwrap(),
            png()
        );
    }

    #[tokio::test]
    async fn a_local_address_is_refused_without_a_request() {
        let base = serve(Some(ok("image/png", &png()))).await;
        let err = fetch(
            Url::parse(&format!("{base}/a.png")).unwrap(),
            false,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(err, "a local address");
        for u in [
            "http://localhost:8642/x",
            "http://[::1]/x",
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/x",
        ] {
            assert_eq!(
                fetch(Url::parse(u).unwrap(), false, TIMEOUT, MAX_IMAGE_BYTES)
                    .await
                    .unwrap_err(),
                "a local address",
                "{u}"
            );
        }
    }

    #[tokio::test]
    async fn over_the_cap_not_an_image_and_errors_are_refused() {
        let big = serve(Some(ok("image/png", &[png(), vec![0u8; 500]].concat()))).await;
        let e = fetch(Url::parse(&format!("{big}/a")).unwrap(), true, TIMEOUT, 100)
            .await
            .unwrap_err();
        assert_eq!(e, "over the image size limit");
        let html = serve(Some(ok("text/html", b"<html>nope</html>"))).await;
        let e = fetch(
            Url::parse(&format!("{html}/a")).unwrap(),
            true,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "not a PNG, JPEG, GIF or WebP image");
        let missing = serve(Some(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ))
        .await;
        let e = fetch(
            Url::parse(&format!("{missing}/a")).unwrap(),
            true,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "the server answered 404");
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let base = serve(None).await;
        let t = std::time::Instant::now();
        let e = fetch(
            Url::parse(&format!("{base}/a")).unwrap(),
            true,
            Duration::from_millis(400),
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "timed out");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_redirect_is_followed_and_checked() {
        let target = serve(Some(ok("image/png", &png()))).await;
        let hop = serve(Some(format!("HTTP/1.1 302 Found\r\nLocation: {target}/b.png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes())).await;
        let got = fetch(
            Url::parse(&format!("{hop}/a")).unwrap(),
            true,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(got.media_type, "image/png");
        // Only http(s) is followed.
        let ftp = serve(Some(b"HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec())).await;
        let e = fetch(
            Url::parse(&format!("{ftp}/a")).unwrap(),
            true,
            TIMEOUT,
            MAX_IMAGE_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "not a web address");
    }

    #[test]
    fn a_web_archive_gives_the_image_for_its_url() {
        let mut sub = plist::Dictionary::new();
        sub.insert(
            "WebResourceURL".into(),
            plist::Value::String("https://example.com/a.png".into()),
        );
        sub.insert(
            "WebResourceMIMEType".into(),
            plist::Value::String("image/png".into()),
        );
        sub.insert("WebResourceData".into(), plist::Value::Data(png()));
        let mut root = plist::Dictionary::new();
        root.insert(
            "WebSubresources".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(sub)]),
        );
        let mut bytes = Vec::new();
        plist::Value::Dictionary(root)
            .to_writer_binary(&mut bytes)
            .unwrap();
        let got = find_in_webarchive(&bytes, "https://example.com/a.png").unwrap();
        assert_eq!(got.media_type, "image/png");
        assert!(find_in_webarchive(&bytes, "https://example.com/other.png").is_none());
        assert!(find_in_webarchive(b"not a plist", "https://example.com/a.png").is_none());
    }

    /// The pasteboard read runs (its messages' types check out in a debug
    /// build) and finds nothing under a type nobody writes; his clipboard is
    /// only read.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_pasteboard_read_runs_and_finds_no_unknown_type() {
        assert!(pasteboard_data("com.nightloom.test-382-no-such-type").is_none());
    }

    /// Live, by hand (the wave 11 probe runs it between a WebKit copy and
    /// putting the clipboard back): the copied page's image `NL382_URL` is
    /// found in Safari's web archive on the pasteboard.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn live_a_webkit_copy_holds_its_images() {
        let url = std::env::var("NL382_URL").expect("NL382_URL");
        let got = pasteboard_image(&url).expect("the image is in the pasteboard's web archive");
        assert_eq!(got.media_type, "image/png");
        println!("found {url}: {} base64 chars", got.data.len());
    }

    /// Review 2026-10-18: an IPv4 local address wrapped in IPv6, and the
    /// reserved IPv4 ranges, are local too.
    #[test]
    fn local_addresses_in_every_spelling_are_local() {
        for a in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "198.18.0.1",
            "192.0.0.8",
            "240.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::c0a8:101",
            "fec0::1",
            "fd00::1",
        ] {
            assert!(is_local(a.parse().unwrap()), "{a} should be local");
        }
        for a in ["93.184.216.34", "2606:2800:220:1::1", "64:ff9b::5db8:d822"] {
            assert!(!is_local(a.parse().unwrap()), "{a} should not be local");
        }
    }

    #[test]
    fn only_web_addresses_are_taken() {
        assert!(web_url("https://example.com/a.png").is_ok());
        assert!(web_url("file:///etc/passwd").is_err());
        assert!(web_url("data:image/png;base64,AAAA").is_err());
    }
}
