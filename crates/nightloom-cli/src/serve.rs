//! `nightloom serve`: the phone page and Claude Code turns with the desktop
//! app closed (nightshift item 268, step 1; `nightloom_service::serve`).
//!
//! Binds the Mac's tailnet address only (the listener's own rule), takes
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
    /// The tailnet address to bind; found from Tailscale when absent.
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
    let host = ServeHost::new(cfg, Registry::load());
    let server = Server::start(ip, args.port, token.clone(), host as Arc<dyn remote::Host>)
        .await
        .map_err(|e| anyhow!(e))?;
    let scheme = if server.https() { "https" } else { "http" };
    println!(
        "nightloom serve: {scheme}://{} (home {}, lock {})",
        server.addr(),
        config.display(),
        lock.path().display()
    );
    println!(
        "phone setup: {}",
        token::setup_url(
            &server.addr().ip().to_string(),
            server.addr().port(),
            "<token>"
        )
    );
    println!("Ctrl-C stops it; the desktop app can open once it has.");
    tokio::signal::ctrl_c()
        .await
        .context("waiting for Ctrl-C")?;
    server.stop().await;
    drop(lock);
    Ok(())
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
