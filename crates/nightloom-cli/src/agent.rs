//! `--agent claude-code`: the REPL over Claude Code instead of a provider.
//!
//! The whole point of this module is how little there is of it. Rendering is
//! [`chat::render`] unchanged, because the engine underneath emits the same
//! [`TurnEvent`]s the provider path does — so the terminal cannot tell which
//! engine produced a turn, which is the property that makes this worth
//! having rather than a second half-built front end.
//!
//! What is *not* here is the other half of the trade: no approval prompt, no
//! `/context`, no `/rewind`, no sidecar. Claude Code owns the loop, so it
//! owns those, and the ones it has are its own.

use crate::chat::{ChatArgs, render};
use crate::{DIM, RESET};
use anyhow::{Context, Result};
use nightloom_service::{AgentSpec, ClaudeCodeAgent};
use std::io;
use tokio_util::sync::CancellationToken;

/// Build the spec from the flags the chat REPL already takes.
///
/// Mapped rather than duplicated: `--model`, `--tools`, `--no-approval` and
/// `--once` mean the same thing to a reader whichever engine is running, and
/// a parallel set of `--agent-*` copies of each would be four more flags
/// saying the same four things.
fn spec(args: &ChatArgs) -> Result<AgentSpec> {
    let cwd = std::env::current_dir().context("no working directory")?;
    let mut spec = AgentSpec::new(cwd);
    spec.binary = args.agent_binary.clone();
    spec.model = args.model.clone();
    spec.max_budget_usd = args.agent_budget;
    // `--bare` means "don't inherit instructions you didn't write here" in
    // the provider path, where it drops the preamble. Safe mode is the same
    // sentence addressed to the CLI's own configuration — and specifically
    // not `--bare`, which would drop the OAuth login with it and bill the
    // API for every turn.
    spec.safe_mode = args.bare;
    spec.append_system_prompt = args.system.clone();

    if !args.tools {
        spec.tools = Some(Vec::new());
    } else {
        // Headless has no way to ask, so the two honest settings are "deny
        // anything not already permitted" and "run everything". Nightloom's
        // own gate is a live prompt and has no equivalent here; saying so is
        // better than implying the familiar one is running.
        spec.permission_mode = Some(if args.no_approval {
            "bypassPermissions".into()
        } else {
            "dontAsk".into()
        });
    }
    Ok(spec)
}

pub async fn run(args: ChatArgs) -> Result<()> {
    let mut agent = ClaudeCodeAgent::new(spec(&args)?);

    if let Some(prompt) = args.once.clone() {
        turn(&agent, &prompt).await?;
        return Ok(());
    }

    println!(
        "nightloom v{} — agent: {} ({})",
        env!("CARGO_PKG_VERSION"),
        agent.spec().binary,
        agent.spec().model.as_deref().unwrap_or("default model"),
    );
    println!(
        "{DIM}workspace: {}{RESET}",
        agent.spec().workspace.display()
    );
    // Said out loud because it is the whole reason to be on this path, and
    // because the failure is silent: with a key in the environment the CLI
    // would bill the API and nothing in the transcript would show it.
    println!(
        "{DIM}auth: {}{RESET}",
        if agent.spec().use_subscription {
            "your Claude subscription (ANTHROPIC_API_KEY withheld from the CLI)"
        } else {
            "inherited environment — an API key here bills the API, not your plan"
        }
    );
    println!(
        "{DIM}tools: {}{RESET}",
        match (&agent.spec().tools, agent.spec().permission_mode.as_deref()) {
            (Some(t), _) if t.is_empty() => "off — Claude Code runs with no tools".into(),
            (_, Some("bypassPermissions")) =>
                "on, approval off — Claude Code writes files and runs commands unasked".to_string(),
            (_, mode) => format!(
                "on, {} — Nightloom's approval prompt does not apply here",
                mode.unwrap_or("default")
            ),
        }
    );
    println!("{DIM}the loop, tools and history are Claude Code's; /quit exits{RESET}");

    loop {
        let Some(line) = crate::chat::prompt_line()? else {
            break;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if matches!(line, "/quit" | "/exit") {
            break;
        }
        if line == "/new" {
            agent = ClaudeCodeAgent::new(spec(&args)?);
            println!("{DIM}new session{RESET}");
            continue;
        }
        match turn(&agent, line).await {
            // Carrying the id forward is what makes this a conversation
            // rather than a run of unrelated one-shots — the history lives
            // in Claude Code's session, so resuming it is the only way to
            // have one at all.
            Ok(Some(outcome)) => agent.follow_on(&outcome),
            Ok(None) => {}
            Err(e) => eprintln!("{DIM}error: {e}{RESET}"),
        }
    }
    Ok(())
}

/// One turn, rendered through the shared renderer. Returns the outcome so
/// the caller can carry the session forward.
async fn turn(
    agent: &ClaudeCodeAgent,
    prompt: &str,
) -> Result<Option<nightloom_service::AgentOutcome>> {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let ctrl_c = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });

    let mut stdout = io::stdout();
    let mut in_thinking = false;
    let result = agent
        .run_turn(prompt, &cancel, &mut |event| {
            let _ = render(&mut stdout, &mut in_thinking, event);
        })
        .await;
    ctrl_c.abort();
    if in_thinking {
        print!("{RESET}");
    }
    println!();

    let outcome = result?;
    for notice in &outcome.notices {
        println!("{DIM}{notice}{RESET}");
    }
    // The plan window is the only figure here that is about what this turn
    // actually spent. The dollar estimate is what the same turn *would* have
    // cost on the API, which is worth showing precisely because it is the
    // number not being charged — but it must not read as a bill.
    if let Some(plan) = &outcome.rate_limit {
        let window = plan.window.as_deref().unwrap_or("plan");
        let status = plan.status.as_deref().unwrap_or("unknown");
        let overage = if plan.using_overage {
            ", on overage"
        } else {
            ""
        };
        println!("{DIM}plan: {window} window {status}{overage}{RESET}");
    }
    if let Some(cost) = outcome.cost_usd {
        println!("{DIM}~${cost:.4} on the API — not charged on a subscription{RESET}");
    }
    Ok(Some(outcome))
}
