//! HTTPS for the phone listener, from Tailscale's own certificate
//! (nightshift backlog 246, wave 3; design §2.7; blocker 660).
//!
//! The phone's microphone, its wake lock and a service worker all need a
//! secure context, and the listener is plain HTTP on the tailnet address.
//! Tailscale issues a free Let's Encrypt certificate for the machine's
//! `<machine>.<tailnet>.ts.net` name once "HTTPS Certificates" is switched
//! on in its admin console — his switch (blocker 660), which also publishes
//! the machine's name in the public Certificate Transparency logs. Until
//! it is on, nothing here runs: [`load`] answers `None` when the files are
//! absent and the listener stays plain HTTP, exactly as before.
//!
//! The files live in `<config dir>/remote/` as `cert.pem` and `key.pem`,
//! written by `tailscale cert` ([`refresh`]); the listener serves TLS
//! itself with them on the same tailnet-only bind ([`TlsListener`]).

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

/// How long one client gets to finish its handshake. A tailnet peer that
/// opens a socket and says nothing must not hold the accept loop.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);

/// `<config dir>/remote/`.
pub fn dir() -> Option<PathBuf> {
    crate::project::config_dir().map(|d| d.join("remote"))
}

/// The certificate and key paths under `dir`.
pub fn files(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join("cert.pem"), dir.join("key.pem"))
}

/// The server's TLS configuration from `dir`'s files: `None` when either is
/// absent (HTTPS not set up — plain HTTP, as before), `Err` with a sentence
/// when they are there and unreadable.
pub fn load(dir: &Path) -> Option<Result<Arc<rustls::ServerConfig>, String>> {
    let (cert, key) = files(dir);
    if !cert.is_file() || !key.is_file() {
        return None;
    }
    Some(config(&cert, &key))
}

fn config(cert: &Path, key: &Path) -> Result<Arc<rustls::ServerConfig>, String> {
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("{}: {e}", cert.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{}: {e}", cert.display()))?;
    if chain.is_empty() {
        return Err(format!("{} holds no certificate", cert.display()));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| format!("{}: {e}", key.display()))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_no_client_auth()
    .with_single_cert(chain, key)
    .map_err(|e| format!("the certificate and key do not make a pair: {e}"))?;
    // The listener speaks HTTP/1.1 only (axum's `http1`), which the voice
    // socket's upgrade needs anyway.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Fetch or renew the machine's certificate into `dir` with `tailscale
/// cert`, for `domain` (`<machine>.<tailnet>.ts.net`, from
/// [`tailnet_domain`]). Tailscale keeps its own copy and renews it when it
/// nears expiry, so running this at each listener start is how a 90-day
/// certificate stays fresh. `Err` is Tailscale's own sentence — most often
/// that HTTPS certificates are not enabled for the tailnet.
pub async fn refresh(dir: &Path, domain: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (cert, key) = files(dir);
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("tailscale")
            .arg("cert")
            .arg("--cert-file")
            .arg(&cert)
            .arg("--key-file")
            .arg(&key)
            .arg(domain)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "tailscale cert took longer than a minute".to_string())?
    .map_err(|e| format!("could not run tailscale: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// This machine's tailnet name (`tailscale status --json`'s
/// `Self.DNSName`, the trailing dot dropped), or `None` without Tailscale.
pub async fn tailnet_domain() -> Option<String> {
    let out = tokio::process::Command::new("tailscale")
        .args(["status", "--json"])
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_string())
}

/// A TCP listener that hands axum only connections that finished a TLS
/// handshake. Handshakes run side by side, each with a deadline, so a peer
/// that connects and says nothing holds up no one; a failed one is dropped
/// — [`axum::serve::Listener::accept`] cannot fail.
pub struct TlsListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
    shaking: tokio::task::JoinSet<Option<(TlsStream<TcpStream>, SocketAddr)>>,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, config: Arc<rustls::ServerConfig>) -> Self {
        Self {
            tcp,
            acceptor: TlsAcceptor::from(config),
            shaking: tokio::task::JoinSet::new(),
        }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            tokio::select! {
                accepted = self.tcp.accept() => match accepted {
                    Ok((tcp, addr)) => {
                        let acceptor = self.acceptor.clone();
                        self.shaking.spawn(async move {
                            match tokio::time::timeout(HANDSHAKE_WAIT, acceptor.accept(tcp)).await {
                                Ok(Ok(tls)) => Some((tls, addr)),
                                _ => None,
                            }
                        });
                    }
                    // Out of file descriptors and the like: back off rather
                    // than spin, as axum's own TCP listener does.
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                },
                Some(done) = self.shaking.join_next(), if !self.shaking.is_empty() => {
                    if let Ok(Some(pair)) = done {
                        return pair;
                    }
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway self-signed certificate for 127.0.0.1 and localhost,
    // made for this test with openssl (EC P-256, valid to 2126). Its key
    // guards nothing.
    const CERT: &str = "-----BEGIN CERTIFICATE-----
MIIBozCCAUigAwIBAgIUbnAG5iMrho2mW2S6Z+sO2chkb9swCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwObmlnaHRsb29tLXRlc3QwIBcNMjYwOTMwMTAyODE2WhgPMjEy
NjA5MDYxMDI4MTZaMBkxFzAVBgNVBAMMDm5pZ2h0bG9vbS10ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEcvGdFKwZvWt1OUAe6sPqVu49Up/tLbI2p/4BNplt
M/rm67W2P6vRbrqGkOylQbl65oTepGBtzH5/4+hFuR3AV6NsMGowHQYDVR0OBBYE
FJ1Ueq+EzK2PE0WesoGMO/P0Z3DCMB8GA1UdIwQYMBaAFJ1Ueq+EzK2PE0WesoGM
O/P0Z3DCMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAMBgNVHRMBAf8EAjAA
MAoGCCqGSM49BAMCA0kAMEYCIQCuWEZFxRbwaFpkU22M1TOFEvJIxhsW+v1Fse9m
opj8hwIhAK5ePHaIABq3ukkYb73IdHxGpOYu59UST9SStE0R/kbL
-----END CERTIFICATE-----
";
    const KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFYn8rlnbws2nGWtA
lR+zD1N83X9p3AGWtCYucwcruzChRANCAARy8Z0UrBm9a3U5QB7qw+pW7j1Sn+0t
sjan/gE2mW0z+ubrtbY/q9FuuoaQ7KVBuXrmhN6kYG3Mfn/j6EW5HcBX
-----END PRIVATE KEY-----
";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-tls-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn no_files_is_plain_http_and_bad_files_are_a_sentence() {
        let d = scratch("absent");
        assert!(load(&d).is_none());
        std::fs::write(d.join("cert.pem"), "not a certificate").unwrap();
        assert!(load(&d).is_none(), "a key is needed too");
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let err = load(&d).unwrap().unwrap_err();
        assert!(err.contains("cert.pem"), "{err}");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        assert!(load(&d).unwrap().is_ok());
    }

    /// The listener serves HTTPS with the files, and a client that stalls
    /// its handshake does not stop the next one being served.
    #[tokio::test]
    async fn the_listener_serves_https_and_a_stalled_handshake_does_not_block_it() {
        let d = scratch("serve");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let config = load(&d).unwrap().unwrap();
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let app = axum::Router::new().route("/", axum::routing::get(|| async { "over tls" }));
        let server = tokio::spawn(async move {
            axum::serve(TlsListener::new(tcp, config), app)
                .await
                .unwrap();
        });
        // A peer that connects and says nothing.
        let _stalled = TcpStream::connect(addr).await.unwrap();
        let client = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(CERT.as_bytes()).unwrap())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let body = client
            .get(format!("https://localhost:{}/", addr.port()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "over tls");
        // Plain HTTP to the TLS port is refused, not served.
        assert!(
            reqwest::get(format!("http://127.0.0.1:{}/", addr.port()))
                .await
                .is_err()
        );
        server.abort();
    }
}
