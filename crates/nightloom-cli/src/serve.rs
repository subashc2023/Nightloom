//! `nightloom serve`: the phone page and Claude Code turns with the desktop
//! app closed (nightshift item 268, step 1; `nightloom_service::serve`).
//!
//! Binds the Mac's tailnet address only (the listener's own rule) unless
//! `NIGHTLOOM_SERVE_PUBLIC=1` (the Fly image, `deploy/`), takes
//! the Nightloom home's holder lock, and runs until Ctrl-C. Never reads the
//! keychain: the phone's token comes from `NIGHTLOOM_REMOTE_TOKEN` or a file
//! (`<config>/remote/serve-token`, made on first run, mode 0600).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use nightloom_service::project::{self, Registry};
use nightloom_service::remote::{self, Server, tailnet, token};
use nightloom_service::serve::{self, HomeLock, ServeConfig, ServeHost};

#[derive(clap::Args, Debug)]
pub struct ServeArgs {
    /// The port (the desktop's default is 8642; use another while the
    /// desktop runs on a different home).
    #[arg(long, default_value_t = remote::DEFAULT_PORT)]
    port: u16,
    /// The tailnet address to bind; found from Tailscale when absent. Any
    /// address with `NIGHTLOOM_SERVE_PUBLIC=1` (behind a TLS proxy).
    #[arg(long)]
    ip: Option<std::net::IpAddr>,
    /// The Claude Code binary.
    #[arg(long, default_value = "claude")]
    claude: String,
    /// The model alias every turn asks for (the CLI's default when absent).
    #[arg(long)]
    model: Option<String>,
    /// The built phone page (`apps/desktop/dist`); API only when absent.
    #[arg(long)]
    assets: Option<PathBuf>,
    /// A file holding the bearer token (default `<config>/remote/serve-token`).
    #[arg(long)]
    token_file: Option<PathBuf>,
}

pub async fn run(args: ServeArgs) -> Result<()> {
    let config = project::config_dir()
        .ok_or_else(|| anyhow!("no Nightloom home — set HOME or NIGHTLOOM_HOME"))?;
    // The one-holder rule: the lock first, then — on the default home,
    // which a desktop from before the lock may be using — any desktop.
    let lock = HomeLock::take(&config, "nightloom serve").map_err(|e| anyhow!(e))?;
    if std::env::var_os("NIGHTLOOM_HOME").is_none() && serve::desktop_running() {
        bail!(
            "the Nightloom desktop app is running — quit it first; \
             the desktop app and `nightloom serve` never both hold the chats"
        );
    }
    let ip = match args.ip {
        Some(ip) => ip,
        None => tailnet::address()
            .map(std::net::IpAddr::V4)
            .ok_or_else(|| anyhow!("no Tailscale address on this machine — is Tailscale up?"))?,
    };
    let token = read_token(args.token_file.clone(), &config)?;
    let mut cfg = ServeConfig::for_home(&config);
    cfg.binary = nightloom_service::resolve_binary(&args.claude);
    cfg.model = args.model.filter(|m| !m.trim().is_empty());
    cfg.hook_exe = std::env::current_exe().ok();
    cfg.assets = args.assets;
    let host = ServeHost::new(cfg, Registry::load()) as Arc<dyn remote::Host>;
    let host_for_idle = host.clone();
    // The away server on Fly (item 268 step 2, blocker 673): any address,
    // behind Fly's TLS, only when asked for by name; the tailnet rule
    // otherwise.
    let server = if public() {
        Server::start_public(ip, args.port, token.clone(), host).await
    } else {
        Server::start(ip, args.port, token.clone(), host).await
    }
    .map_err(|e| anyhow!(e))?;
    let scheme = if server.https() { "https" } else { "http" };
    println!(
        "nightloom serve: {scheme}://{} (home {}, lock {})",
        server.addr(),
        config.display(),
        lock.path().display()
    );
    // With HTTPS the page must be opened by the certificate's name, not
    // the bare address (item 246, the Mac's HTTPS).
    let name = if server.https() {
        nightloom_service::tls::tailnet_domain().await
    } else {
        None
    };
    let setup = match name {
        Some(name) => format!("https://{name}:{}/#token=<token>", server.addr().port()),
        None => token::setup_url(
            &server.addr().ip().to_string(),
            server.addr().port(),
            "<token>",
        ),
    };
    println!("phone setup: {setup}");
    println!("Ctrl-C stops it; the desktop app can open once it has.");
    // Item 781: on the away server, exit by itself after a quiet spell
    // (Fly's proxy auto-stop is off; it would cut a running job).
    match idle_exit_minutes() {
        Some(min) => {
            println!("exits after {min} quiet minutes with no job due or running");
            let host = host_for_idle;
            let jobs = host.jobs();
            let started = chrono::Utc::now();
            let mut every = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tokio::select! {
                    r = tokio::signal::ctrl_c() => { r.context("waiting for Ctrl-C")?; break; }
                    _ = every.tick() => {
                        let now = chrono::Utc::now();
                        let busy = host.state().await.busy;
                        let keep = jobs.as_ref().is_some_and(|j| {
                            j.keeps_up(now, chrono::Duration::minutes(serve::KEEP_UP_AHEAD_MINUTES))
                        });
                        if serve::idle_exit_due(
                            started,
                            remote::last_used(),
                            now,
                            chrono::Duration::minutes(min),
                            busy,
                            keep,
                        ) {
                            println!("quiet for {min} minutes with nothing due: stopping");
                            break;
                        }
                    }
                }
            }
        }
        None => tokio::signal::ctrl_c()
            .await
            .context("waiting for Ctrl-C")?,
    }
    server.stop().await;
    drop(lock);
    Ok(())
}

/// `NIGHTLOOM_SERVE_IDLE_EXIT_MIN` (item 781): minutes, when set and > 0.
fn idle_exit_minutes() -> Option<i64> {
    std::env::var(serve::IDLE_EXIT_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|m| *m > 0)
}

/// `NIGHTLOOM_SERVE_PUBLIC=1`: bind `--ip` even when it is not a tailnet
/// address (the Fly image sets it with `--ip 0.0.0.0`).
fn public() -> bool {
    std::env::var("NIGHTLOOM_SERVE_PUBLIC").is_ok_and(|v| v.trim() == "1")
}

/// The bearer: `NIGHTLOOM_REMOTE_TOKEN`, else the file, made on first run.
fn read_token(file: Option<PathBuf>, config: &std::path::Path) -> Result<String> {
    if let Ok(t) = std::env::var("NIGHTLOOM_REMOTE_TOKEN")
        && !t.trim().is_empty()
    {
        return Ok(t.trim().to_string());
    }
    let path = file.unwrap_or_else(|| config.join("remote").join("serve-token"));
    match std::fs::read_to_string(&path) {
        Ok(t) if !t.trim().is_empty() => Ok(t.trim().to_string()),
        Ok(_) => bail!("{} is empty", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let t = token::generate();
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            write_private(&path, &t)?;
            println!("a new phone token is in {}", path.display());
            Ok(t)
        }
        Err(e) => Err(anyhow!("{}: {e}", path.display())),
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, text: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(text.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, text: &str) -> Result<()> {
    std::fs::write(path, text)?;
    Ok(())
}

/// `nightloom jobs-knock`: the wake-up workflow (item 781).
#[derive(clap::Args, Debug)]
pub struct KnockArgs {
    /// The away server's URL (default: `~/.nightloom/away.json`'s).
    #[arg(long)]
    url: Option<String>,
    /// The job list (default: `~/.nightloom/remote/jobs/jobs.json`).
    #[arg(long)]
    jobs: Option<PathBuf>,
    /// Where to write it (default: print it).
    #[arg(long)]
    out: Option<PathBuf>,
}

pub fn knock(args: KnockArgs) -> Result<()> {
    use nightloom_service::jobs::{Job, Jobs, knock};
    use nightloom_service::sync::lease::MacAway;
    let config = project::config_dir()
        .ok_or_else(|| anyhow!("no Nightloom home — set HOME or NIGHTLOOM_HOME"))?;
    let path = args
        .jobs
        .unwrap_or_else(|| Jobs::dir_under(&config).join("jobs.json"));
    let all: Vec<Job> = match std::fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b).with_context(|| format!("{}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(anyhow!("{}: {e}", path.display())),
    };
    // Only the jobs the server keeps a copy of (projects marked away).
    let projects = Registry::load().projects();
    let away = MacAway::load(&config, &projects);
    let jobs: Vec<Job> = match &away {
        Some(a) => a.away_jobs(&all),
        None => all,
    };
    let url = match args.url {
        Some(u) => u,
        None => {
            #[derive(serde::Deserialize)]
            struct F {
                #[serde(default)]
                url: String,
            }
            let f: F = serde_json::from_slice(&std::fs::read(config.join("away.json"))?)?;
            f.url
        }
    };
    if url.trim().is_empty() {
        bail!("no away server URL — pass --url or set it in Settings → Away server");
    }
    let text = knock::workflow(&url, &jobs, chrono::Utc::now());
    match args.out {
        Some(out) => {
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&out, text)?;
            println!("wrote {} ({} job(s))", out.display(), jobs.len());
        }
        None => print!("{text}"),
    }
    Ok(())
}
