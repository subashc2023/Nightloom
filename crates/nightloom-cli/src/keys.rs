//! `nightloom keys` — the OS credential store, from the terminal.
//!
//! The store was reachable only from the desktop's settings pane, which made
//! the CLI env-or-nothing and, worse, made the two shells disagree: a key
//! entered in the app was invisible here, and the only symptom was a 401 in
//! one shell and a working session in the other.
//!
//! So this is not a convenience wrapper over a desktop feature. It is the
//! other half of making the store shared — someone who only ever uses the
//! CLI has no way to *populate* it otherwise, and `set` is what a headless
//! box or a first install actually needs.

use crate::{DIM, RESET};
use anyhow::{Result, bail};
use nightloom_providers::ProviderKind;
use nightloom_service::credentials::{self, KeySource};
use nightloom_service::tools::SearchBackend;
use std::io::{IsTerminal, Read, Write};

#[derive(clap::Args)]
pub struct KeysArgs {
    #[command(subcommand)]
    command: Option<KeysCommand>,
}

#[derive(clap::Subcommand)]
enum KeysCommand {
    /// Show which providers and search backends have a key, and where from
    List,
    /// Store a key, read from stdin or prompted for
    Set(SetArgs),
    /// Remove a stored key (the environment is left alone)
    Rm(RmArgs),
}

#[derive(clap::Args)]
struct SetArgs {
    /// Provider (anthropic, openai, gemini, groq, openrouter) or search
    /// backend (tavily, brave, exa)
    target: String,
}

#[derive(clap::Args)]
struct RmArgs {
    /// Provider or search backend to forget
    target: String,
}

/// What a name on the command line refers to.
///
/// Providers and search backends share one namespace here because they share
/// one from the user's point of view — both are "a thing I have an API key
/// for" — and asking which kind it was before saying the name would be a
/// question with no purpose. They do *not* share one in the store, which is
/// what [`credentials`] namespaces `search:` for.
enum Target {
    Provider(ProviderKind),
    Search(SearchBackend),
}

impl Target {
    fn parse(name: &str) -> Result<Self> {
        if let Ok(kind) = name.parse::<ProviderKind>() {
            return Ok(Self::Provider(kind));
        }
        if let Some(backend) = SearchBackend::from_name(name) {
            return Ok(Self::Search(backend));
        }
        bail!(
            "unknown target {name:?}\n  providers: {}\n  search:    {}",
            ProviderKind::ALL
                .iter()
                .map(|k| k.label())
                .collect::<Vec<_>>()
                .join(", "),
            SearchBackend::ALL
                .iter()
                .map(|b| b.name())
                .collect::<Vec<_>>()
                .join(", "),
        )
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Provider(kind) => kind.label(),
            Self::Search(backend) => backend.name(),
        }
    }

    fn env_key(&self) -> &'static str {
        match self {
            Self::Provider(kind) => kind.env_key(),
            Self::Search(backend) => backend.env_key(),
        }
    }

    fn source(&self) -> Option<KeySource> {
        match self {
            Self::Provider(kind) => credentials::provider_key_source(*kind),
            Self::Search(backend) => credentials::search_key_source(*backend),
        }
    }
}

pub fn run(args: KeysArgs) -> Result<()> {
    match args.command {
        // Bare `nightloom keys` is the question people actually have.
        None | Some(KeysCommand::List) => list(),
        Some(KeysCommand::Set(a)) => set(&a.target),
        Some(KeysCommand::Rm(a)) => remove(&a.target),
    }
}

fn list() -> Result<()> {
    if !credentials::store_available() {
        println!(
            "{DIM}built without a credential store; only environment variables are read{RESET}"
        );
    }
    let width = ProviderKind::ALL
        .iter()
        .map(|k| k.label().len())
        .chain(SearchBackend::ALL.iter().map(|b| b.name().len()))
        .max()
        .unwrap_or(0);

    println!("providers");
    for kind in ProviderKind::ALL {
        row(
            kind.label(),
            width,
            credentials::provider_key_source(kind),
            kind.env_key(),
        );
    }

    // Only the first backend with a key is ever queried, so a second one set
    // is inert — and a list that showed two as configured with no hint of
    // which answers would be actively misleading.
    let active = nightloom_service::tools::search_backend(credentials::search_key);
    println!("\nsearch");
    for backend in SearchBackend::ALL {
        row(
            backend.name(),
            width,
            credentials::search_key_source(backend),
            backend.env_key(),
        );
        if active == Some(backend) {
            println!("{DIM}{:width$}    ^ answers web_search{RESET}", "");
        }
    }

    println!(
        "\n{DIM}a stored key wins over the environment; `keys set <name>` to store one{RESET}"
    );
    Ok(())
}

fn row(name: &str, width: usize, source: Option<KeySource>, env_key: &str) {
    match source {
        Some(KeySource::Stored) => println!("  {name:width$}  stored"),
        Some(KeySource::Env) => println!("  {name:width$}  {DIM}env ({env_key}){RESET}"),
        None => println!("  {name:width$}  {DIM}—{RESET}"),
    }
}

fn set(name: &str) -> Result<()> {
    let target = Target::parse(name)?;
    if !credentials::store_available() {
        bail!(
            "this build has no credential store; set {} in the environment instead",
            target.env_key()
        );
    }
    let key = read_key(&target)?;
    if key.is_empty() {
        bail!("no key given; nothing stored");
    }
    match &target {
        Target::Provider(kind) => credentials::set_provider_key(*kind, &key)?,
        Target::Search(backend) => credentials::set_search_key(*backend, &key)?,
    }
    println!("stored a key for {}", target.label());
    // A stored key wins, so an environment variable that was doing the job
    // until a second ago has silently stopped. Saying so here is cheaper than
    // the alternative, which is finding out via a 401 from the wrong account.
    if std::env::var(target.env_key()).is_ok() {
        println!(
            "{DIM}note: {} is also set; the stored key wins from now on{RESET}",
            target.env_key()
        );
    }
    Ok(())
}

/// The key from stdin when it is piped, and from a prompt when it is not.
///
/// Never from the command line. An argument lands in shell history and is
/// visible in `ps` to every other user on the box, which for a credential is
/// not a trade worth making for four saved keystrokes.
///
/// The typed key *is* echoed — hiding it wants a terminal-mode dependency
/// for one prompt — so the prompt says so rather than letting someone
/// assume otherwise over a shared screen, and names the pipe that avoids it.
fn read_key(target: &Target) -> Result<String> {
    let mut buf = String::new();
    if std::io::stdin().is_terminal() {
        print!(
            "key for {} (visible as you type; pipe it in to avoid that): ",
            target.label()
        );
        std::io::stdout().flush()?;
        std::io::stdin().read_line(&mut buf)?;
    } else {
        std::io::stdin().read_to_string(&mut buf)?;
    }
    Ok(buf.trim().to_string())
}

fn remove(name: &str) -> Result<()> {
    let target = Target::parse(name)?;
    match &target {
        Target::Provider(kind) => credentials::clear_provider_key(*kind)?,
        Target::Search(backend) => credentials::clear_search_key(*backend)?,
    }
    // Removing an entry that was not there is success, so the useful thing to
    // report is the state that results — which may well still be "has a key",
    // from the environment this command deliberately does not touch.
    match target.source() {
        Some(KeySource::Env) => println!(
            "removed the stored key for {}; {} is still set and will be used",
            target.label(),
            target.env_key()
        ),
        Some(KeySource::Stored) => println!(
            "removed a stored key for {}, but another remains",
            target.label()
        ),
        None => println!("{} now has no key", target.label()),
    }
    Ok(())
}
