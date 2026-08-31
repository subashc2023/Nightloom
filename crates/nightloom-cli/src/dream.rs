//! `nightloom dream` — consolidate the observation log into the vault.
//!
//! The shell's half is thin on purpose: connect a provider, wire Ctrl-C,
//! render the stream, and report. Everything that decides what a dream may
//! touch — the vault-rooted tool set, the system prompt, the ground rules,
//! the git snapshots, the watermark — lives in `nightloom_service::dream`,
//! where the enforcement sits next to the decisions.

use crate::{DIM, RESET, chat};
use anyhow::{Context, Result, bail};
use nightloom_core::Thinking;
use nightloom_service::dream::{self, GitNote};
use nightloom_service::{Chat, ProviderKind, credentials, knowledge, observe, project};
use std::io;
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub struct DreamArgs {
    /// anthropic | openai | openai-chat | gemini | groq | openrouter
    #[arg(long, default_value = "anthropic")]
    provider: ProviderKind,

    /// Model ID (each provider has a default; openai-chat requires one)
    #[arg(long)]
    model: Option<String>,

    /// Override the provider's API base URL
    #[arg(long)]
    base_url: Option<String>,

    /// Reasoning control: default | budget=N | effort=LEVEL
    #[arg(long)]
    thinking: Option<Thinking>,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Print the pending observations and exit; consolidate nothing
    #[arg(long)]
    dry_run: bool,
}

/// Everything a dream pass needs to know about which model runs it.
///
/// The `dream` subcommand and the REPL's `--auto-dream` both build one of
/// these and hand it to [`consolidate`], so the two paths cannot drift into
/// preparing the pass differently.
#[derive(Clone)]
pub struct DreamSpec {
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub thinking: Option<Thinking>,
    pub max_tokens: u32,
}

pub async fn run(args: DreamArgs) -> Result<()> {
    let Some(config) = project::config_dir() else {
        bail!("no user config directory — there is nowhere for an observation log to live");
    };
    if args.dry_run {
        let backlog = observe::backlog_in(&config);
        if backlog.pending.is_empty() {
            println!("nothing to dream about — no unconsolidated observations.");
        } else {
            println!(
                "{} observation{} awaiting consolidation:",
                backlog.pending.len(),
                if backlog.pending.len() == 1 { "" } else { "s" }
            );
            for p in &backlog.pending {
                let source = p.obs.source.as_deref().unwrap_or("—");
                println!(
                    "{DIM}  {} · {source} · {}:{RESET} {}",
                    p.obs.at.format("%Y-%m-%d %H:%M"),
                    p.obs.kind.as_str(),
                    p.obs.text
                );
            }
        }
        if backlog.unreadable > 0 {
            println!(
                "{DIM}({} line{} this build could not read were skipped){RESET}",
                backlog.unreadable,
                if backlog.unreadable == 1 { "" } else { "s" }
            );
        }
        return Ok(());
    }
    consolidate(DreamSpec {
        provider: args.provider,
        model: args.model,
        base_url: args.base_url,
        thinking: args.thinking,
        max_tokens: args.max_tokens,
    })
    .await
}

/// One consolidation pass: connect the spec's provider, run the dream, and
/// report on stdout. Quietly says so and spends nothing when the inbox is
/// empty.
pub async fn consolidate(spec: DreamSpec) -> Result<()> {
    let Some(config) = project::config_dir() else {
        bail!("no user config directory — there is nowhere for an observation log to live");
    };
    let backlog = observe::backlog_in(&config);
    if backlog.pending.is_empty() {
        println!("nothing to dream about — no unconsolidated observations.");
        if backlog.unreadable > 0 {
            println!(
                "{DIM}({} line{} this build could not read were skipped){RESET}",
                backlog.unreadable,
                if backlog.unreadable == 1 { "" } else { "s" }
            );
        }
        return Ok(());
    }

    let Some(vault) = knowledge::vault_dir() else {
        bail!("no user config directory — there is no vault to consolidate into");
    };
    // A first dream on a fresh install: the vault may not exist yet, and a
    // pass that starts by erroring on list_dir is a worse introduction than
    // an empty folder.
    std::fs::create_dir_all(&vault)
        .with_context(|| format!("cannot create the vault at {}", vault.display()))?;

    let (provider, model) = nightloom_service::connect(
        spec.provider,
        spec.model.clone(),
        credentials::provider_key(spec.provider),
        spec.base_url.clone(),
        None,
    )
    .with_context(|| format!("cannot build provider {}", spec.provider))?;
    let mut chat = Chat::new(provider, model);
    chat.thinking = spec.thinking.clone().unwrap_or(Thinking::Default);
    chat.max_tokens = spec.max_tokens;
    chat.context_limit = nightloom_service::context_limit(spec.provider, &chat.model);
    chat.price = nightloom_service::price(spec.provider, &chat.model);
    dream::prepare(&mut chat, &vault);

    println!(
        "dreaming over {} observation{} — {}:{} into {}",
        backlog.pending.len(),
        if backlog.pending.len() == 1 { "" } else { "s" },
        chat.provider.name(),
        chat.model,
        vault.display()
    );

    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let ctrl_c = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });
    let mut stdout = io::stdout();
    let mut in_thinking = false;
    let result = dream::run(&chat, &vault, &config, &cancel, &mut |event| {
        let _ = chat::render(&mut stdout, &mut in_thinking, event);
    })
    .await;
    ctrl_c.abort();
    if in_thinking {
        print!("{RESET}");
    }
    println!();

    let outcome = match result {
        Ok(Some(outcome)) => outcome,
        // Checked non-empty above; a concurrent consumer is the only way here.
        Ok(None) => {
            println!("nothing left to consolidate.");
            return Ok(());
        }
        Err(e) => bail!(e),
    };

    if outcome.interrupted {
        println!("{DIM}interrupted — nothing consumed; the same batch is offered next run{RESET}");
    } else {
        println!(
            "{DIM}consolidated {} observation{}{}{RESET}",
            outcome.consolidated,
            if outcome.consolidated == 1 { "" } else { "s" },
            match outcome.remaining {
                0 => String::new(),
                n => format!("; {n} left for the next run — run `nightloom dream` again"),
            }
        );
    }
    if outcome.unreadable > 0 {
        println!(
            "{DIM}{} log line{} this build could not read were skipped{RESET}",
            outcome.unreadable,
            if outcome.unreadable == 1 { "" } else { "s" }
        );
    }
    print_git(&outcome.git_before, &outcome.git_after);
    let mut spend = format!(
        "{} in, {} out",
        outcome.usage.input_tokens, outcome.usage.output_tokens
    );
    if let Some(usd) = outcome.cost_usd {
        spend.push_str(&format!(" — ${usd:.4}"));
    }
    println!("{DIM}{spend}{RESET}");
    Ok(())
}

/// One line about rollback, because that is what the snapshots are for.
/// Both snapshots ran on the same folder, so `after` carries the story;
/// `before` only matters when it failed and `after` did not.
fn print_git(before: &GitNote, after: &GitNote) {
    if let GitNote::Failed(e) = before
        && !matches!(after, GitNote::Failed(_))
    {
        println!("{DIM}pre-dream git snapshot failed: {e}{RESET}");
    }
    match after {
        GitNote::NotARepo => println!(
            "{DIM}the vault is not a git repository — no rollback for this pass; `git init` it \
             to get one{RESET}"
        ),
        GitNote::Committed { hash } if hash.is_empty() => {
            println!("{DIM}vault committed{RESET}");
        }
        GitNote::Committed { hash } => println!(
            "{DIM}vault committed ({hash}) — `git log -p` in the vault is the audit trail{RESET}"
        ),
        GitNote::Clean => println!("{DIM}vault unchanged{RESET}"),
        GitNote::Failed(e) => println!("{DIM}git snapshot failed: {e}{RESET}"),
    }
}
