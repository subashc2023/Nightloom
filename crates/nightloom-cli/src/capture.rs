//! `nightloom capture` — read the session logs since their watermarks and
//! extract observations into the memory inbox.
//!
//! The dream's sibling and shaped like it: connect a provider, wire Ctrl-C,
//! render the stream, and report. Everything that decides what the pass
//! reads (conversation text only, never tool results), how it asks, what it
//! appends and when a log's watermark moves lives in
//! `nightloom_service::capture`; the pass prepares the chat itself, once
//! per source.

use crate::{DIM, RESET, chat};
use anyhow::{Context, Result, bail};
use nightloom_core::Thinking;
use nightloom_service::capture;
use nightloom_service::{Chat, ProviderKind, credentials, project};
use std::io;
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub struct CaptureArgs {
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

    /// Read the logs and print the would-be observations; append nothing
    /// and move no watermark. The provider is still called.
    #[arg(long)]
    dry_run: bool,
}

pub async fn run(args: CaptureArgs) -> Result<()> {
    let Some(config) = project::config_dir() else {
        bail!("no user config directory — there are no session logs to read");
    };
    let pending = capture::pending_count_in(&config);
    if pending == 0 {
        println!("nothing to capture — every chat is read up to its last line.");
        return Ok(());
    }

    let (provider, model) = nightloom_service::connect(
        args.provider,
        args.model.clone(),
        credentials::provider_key(args.provider),
        args.base_url.clone(),
        None,
    )
    .with_context(|| format!("cannot build provider {}", args.provider))?;
    let mut chat = Chat::new(provider, model);
    chat.thinking = args.thinking.clone().unwrap_or(Thinking::Default);
    chat.max_tokens = args.max_tokens;
    chat.context_limit = nightloom_service::context_limit(args.provider, &chat.model);
    chat.price = nightloom_service::price(args.provider, &chat.model);

    println!(
        "capturing from {pending} chat{} with something new — {}:{}{}",
        if pending == 1 { "" } else { "s" },
        chat.provider.name(),
        chat.model,
        if args.dry_run {
            " (dry run: nothing is appended)"
        } else {
            ""
        }
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
    let result = capture::run(&mut chat, &config, args.dry_run, &cancel, &mut |event| {
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
        // Checked non-empty above; a concurrent capture is the only way here.
        Ok(None) => {
            println!("nothing left to capture.");
            return Ok(());
        }
        Err(e) => bail!(e),
    };

    if args.dry_run {
        if outcome.drafted.is_empty() {
            println!("{DIM}nothing worth keeping in what was read{RESET}");
        }
        for obs in &outcome.drafted {
            let source = obs.source.as_deref().unwrap_or("—");
            println!(
                "{DIM}  {} · {source} · {}:{RESET} {}",
                obs.at.format("%Y-%m-%d %H:%M"),
                obs.kind.as_str(),
                obs.text
            );
        }
    }
    let verb = if args.dry_run {
        "would capture"
    } else {
        "captured"
    };
    println!(
        "{DIM}{}{verb} {} observation{} from {} chat{}{}{}{RESET}",
        if outcome.interrupted {
            "interrupted — "
        } else {
            ""
        },
        outcome.observations,
        if outcome.observations == 1 { "" } else { "s" },
        outcome.logs_read,
        if outcome.logs_read == 1 { "" } else { "s" },
        match outcome.skipped {
            0 => String::new(),
            n => format!(" ({n} line{} skipped)", if n == 1 { "" } else { "s" }),
        },
        match split_line(&outcome.per_project) {
            s if s.is_empty() => String::new(),
            s => format!(" — {s}"),
        }
    );
    if outcome.interrupted {
        println!(
            "{DIM}the chat it stopped in appended nothing; the ones before it are kept{RESET}"
        );
    }
    if outcome.deferred > 0 {
        println!(
            "{DIM}{} chat{} waiting for more turns before being read{RESET}",
            outcome.deferred,
            if outcome.deferred == 1 {
                " is"
            } else {
                "s are"
            }
        );
    }
    if outcome.incognito > 0 {
        println!(
            "{DIM}{} incognito chat{} seen and not read{RESET}",
            outcome.incognito,
            if outcome.incognito == 1 { "" } else { "s" }
        );
    }
    if outcome.remaining > 0 {
        println!(
            "{DIM}{} chat{} left for the next run — run `nightloom capture` again{RESET}",
            outcome.remaining,
            if outcome.remaining == 1 { "" } else { "s" }
        );
    }
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

/// "3 from Lanternfish, 1 unfiled" — the split by source, in the order
/// the dirs were walked.
fn split_line(per_project: &[(String, usize)]) -> String {
    per_project
        .iter()
        .map(|(name, n)| {
            if name == capture::UNFILED {
                format!("{n} unfiled")
            } else {
                format!("{n} from {name}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}
