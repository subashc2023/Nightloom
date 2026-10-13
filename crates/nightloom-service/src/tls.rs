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
//! itself with them on the same tailnet-only bind ([`TlsListener`]), and a
//! running listener renews them daily ([`keep_fresh`]) and serves the new
//! pair without a restart ([`Certs`]).

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::sign::CertifiedKey;
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

/// The certificate the listener serves, re-read from `dir`'s files on
/// [`Certs::reload`] — so a renewal reaches new connections without a
/// restart of the listener (the phone's open streams keep theirs).
#[derive(Debug)]
pub struct Certs {
    dir: PathBuf,
    current: std::sync::RwLock<Arc<CertifiedKey>>,
}

impl Certs {
    /// `None` when either file is absent (HTTPS not set up — plain HTTP,
    /// as before), `Err` with a sentence when they are there and unreadable.
    pub fn load(dir: &Path) -> Option<Result<Arc<Self>, String>> {
        let (cert, key) = files(dir);
        if !cert.is_file() || !key.is_file() {
            return None;
        }
        Some(read(&cert, &key).map(|k| {
            Arc::new(Self {
                dir: dir.to_path_buf(),
                current: std::sync::RwLock::new(Arc::new(k)),
            })
        }))
    }

    /// Read the files again. A pair that does not read keeps the one being
    /// served, and says why.
    pub fn reload(&self) -> Result<(), String> {
        let (cert, key) = files(&self.dir);
        let fresh = read(&cert, &key)?;
        *self.current.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(fresh);
        Ok(())
    }

    /// The directory the files are read from.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The server configuration that serves whatever was last loaded.
    pub fn server_config(self: &Arc<Self>) -> Arc<rustls::ServerConfig> {
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_no_client_auth()
            .with_cert_resolver(self.clone());
        // The listener speaks HTTP/1.1 only (axum's `http1`), which the voice
        // socket's upgrade needs anyway.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(config)
    }
}

impl rustls::server::ResolvesServerCert for Certs {
    fn resolve(&self, _: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(
            self.current
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        )
    }
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn read(cert: &Path, key: &Path) -> Result<CertifiedKey, String> {
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("{}: {e}", cert.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{}: {e}", cert.display()))?;
    if chain.is_empty() {
        return Err(format!("{} holds no certificate", cert.display()));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| format!("{}: {e}", key.display()))?;
    CertifiedKey::from_der(chain, key, &provider())
        .map_err(|e| format!("the certificate and key do not make a pair: {e}"))
}

/// How often a running listener asks Tailscale to renew (design §2.7):
/// Tailscale's certificates last 90 days and it replaces one only as it
/// nears expiry, so a daily ask keeps a listener that runs for months on a
/// valid certificate.
pub const RENEW_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// Keep `certs` fresh until `stop`: at once, then every `every`, run
/// `renew` (in the listener, `tailscale cert` through [`refresh`]) and
/// reload the files after it succeeds. A failure is logged and the
/// certificate being served stays.
pub async fn keep_fresh<F, Fut>(
    certs: Arc<Certs>,
    every: Duration,
    stop: tokio_util::sync::CancellationToken,
    renew: F,
) where
    F: Fn(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tick.tick() => {}
        }
        let outcome = tokio::select! {
            _ = stop.cancelled() => return,
            r = renew(certs.dir().to_path_buf()) => r,
        };
        match outcome.and_then(|()| certs.reload()) {
            Ok(()) => {}
            Err(e) => eprintln!("remote: could not renew the HTTPS certificate: {e}"),
        }
    }
}

/// [`keep_fresh`]'s `renew` in the listener: this machine's tailnet name,
/// then `tailscale cert` for it into `dir`.
pub async fn renew_from_tailscale(dir: PathBuf) -> Result<(), String> {
    let domain = tokio::time::timeout(Duration::from_secs(10), tailnet_domain())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "Tailscale did not say this machine's name".to_string())?;
    refresh(&dir, &domain).await
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

    // A second throwaway certificate (same recipe), to tell a reload apart.
    const CERT_2: &str = "-----BEGIN CERTIFICATE-----
MIIBpzCCAUygAwIBAgIUC26L0BWqKKH1XSHaONoz/2TPpLIwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQbmlnaHRsb29tLXRlc3QtMjAgFw0yNjEwMDYwMTIzMzhaGA8y
MTI2MDkxMjAxMjMzOFowGzEZMBcGA1UEAwwQbmlnaHRsb29tLXRlc3QtMjBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABANJCDG7XQ4R0ds5hPEMtQ7IdZQwGzPKTZtf
RJ8h+usQDPh/Zsy4zy+hQzN6E3utBpVEhIqbsrt6vC12xgO2bQyjbDBqMB0GA1Ud
DgQWBBTqNEsdj0TftTLUODk8eghJ6xDW1DAfBgNVHSMEGDAWgBTqNEsdj0TftTLU
ODk8eghJ6xDW1DAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwDAYDVR0TAQH/
BAIwADAKBggqhkjOPQQDAgNJADBGAiEAn3m7LSRK4jNfsm90HDVFEFJ/fPreCX17
4a9YYHmpEroCIQCZbuksWsMZQcqLoqQVt+zg+AxxzCDtPqGx3qqs4tUKTA==
-----END CERTIFICATE-----
";
    const KEY_2: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg4upHlCzriqHwYa7s
KrSHitMbXX5JIB6dEP006Riuv7OhRANCAAQDSQgxu10OEdHbOYTxDLUOyHWUMBsz
yk2bX0SfIfrrEAz4f2bMuM8voUMzehN7rQaVRISKm7K7erwtdsYDtm0M
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
        assert!(Certs::load(&d).is_none());
        std::fs::write(d.join("cert.pem"), "not a certificate").unwrap();
        assert!(Certs::load(&d).is_none(), "a key is needed too");
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let err = Certs::load(&d).unwrap().unwrap_err();
        assert!(err.contains("cert.pem"), "{err}");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        assert!(Certs::load(&d).unwrap().is_ok());
        // A key from another certificate is refused, not served.
        std::fs::write(d.join("key.pem"), KEY_2).unwrap();
        let err = Certs::load(&d).unwrap().unwrap_err();
        assert!(err.contains("do not make a pair"), "{err}");
    }

    /// The listener serves HTTPS with the files, and a client that stalls
    /// its handshake does not stop the next one being served.
    #[tokio::test]
    async fn the_listener_serves_https_and_a_stalled_handshake_does_not_block_it() {
        let d = scratch("serve");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let config = Certs::load(&d).unwrap().unwrap().server_config();
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

    fn served(certs: &Certs) -> Vec<u8> {
        certs.current.read().unwrap().cert[0].as_ref().to_vec()
    }

    fn der(pem: &str) -> Vec<u8> {
        CertificateDer::from_pem_slice(pem.as_bytes())
            .unwrap()
            .as_ref()
            .to_vec()
    }

    /// A renewed pair on disk is served to the next client without a
    /// restart, and a broken pair keeps the one being served.
    #[tokio::test]
    async fn a_reload_serves_the_new_certificate_and_a_bad_one_keeps_the_old() {
        let d = scratch("reload");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let certs = Certs::load(&d).unwrap().unwrap();
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let app = axum::Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let config = certs.server_config();
        let server = tokio::spawn(async move {
            axum::serve(TlsListener::new(tcp, config), app)
                .await
                .unwrap();
        });
        // A client that trusts only the second certificate.
        let trusts_2 = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(CERT_2.as_bytes()).unwrap())
            .tls_built_in_root_certs(false)
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let url = format!("https://localhost:{}/", addr.port());
        assert!(trusts_2.get(&url).send().await.is_err(), "still the first");
        std::fs::write(d.join("cert.pem"), CERT_2).unwrap();
        std::fs::write(d.join("key.pem"), KEY_2).unwrap();
        certs.reload().unwrap();
        let body = trusts_2
            .get(&url)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
        // Half a renewal (a new certificate, the old key) is refused and the
        // second pair stays served.
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        assert!(certs.reload().is_err());
        assert_eq!(served(&certs), der(CERT_2));
        server.abort();
    }

    /// The renewal runs at once and then on every tick, reloads after each
    /// success, keeps serving through a failure, and ends on `stop`.
    #[tokio::test]
    async fn keep_fresh_renews_at_start_and_on_each_tick_until_stopped() {
        let d = scratch("fresh");
        std::fs::write(d.join("cert.pem"), CERT).unwrap();
        std::fs::write(d.join("key.pem"), KEY).unwrap();
        let certs = Certs::load(&d).unwrap().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stop = tokio_util::sync::CancellationToken::new();
        let every = Duration::from_millis(400);
        let task = tokio::spawn(keep_fresh(certs.clone(), every, stop.clone(), {
            let calls = calls.clone();
            move |dir: PathBuf| {
                let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    match n {
                        // The first renewal: Tailscale wrote a new pair.
                        0 => {
                            std::fs::write(dir.join("cert.pem"), CERT_2).unwrap();
                            std::fs::write(dir.join("key.pem"), KEY_2).unwrap();
                            Ok(())
                        }
                        _ => Err("tailscale is down".to_string()),
                    }
                }
            }
        }));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(served(&certs), der(CERT_2), "reloaded after the renewal");
        tokio::time::sleep(every).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(served(&certs), der(CERT_2), "a failure keeps it");
        stop.cancel();
        task.await.unwrap();
        tokio::time::sleep(every * 3).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}
