use crate::{DIM, RESET};
use anyhow::{Context, Result};
use nightloom_core::{
    ContentBlock, ProviderError, SegmentKind, Session, SessionEvent, SystemPrompt, Thinking, Usage,
};
use nightloom_service::{
    AutoApprove, Chat, Decision, PendingCall, PromptConfig, ProviderKind, TurnEvent, prompt, store,
    tools,
};
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(clap::Args, Clone)]
pub struct ChatArgs {
    /// anthropic | openai | openai-chat | gemini | groq | openrouter
    #[arg(long, default_value = "anthropic")]
    provider: ProviderKind,

    /// Model ID (each provider has a default; openai-chat requires one)
    #[arg(long)]
    model: Option<String>,

    /// Override the provider's API base URL (e.g. http://localhost:11434/v1)
    #[arg(long)]
    base_url: Option<String>,

    /// Extra system-prompt text, appended after the built-in preamble
    #[arg(long)]
    system: Option<String>,

    /// Skip the built-in preamble (identity, environment, project instructions)
    #[arg(long)]
    bare: bool,

    /// Don't attach the per-turn status block (time, tasks, context)
    #[arg(long)]
    no_sidecar: bool,

    /// Reasoning control: default | budget=N | effort=LEVEL (support varies by provider)
    #[arg(long)]
    thinking: Option<Thinking>,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Enable the built-in tools: read/write/edit files, list_dir, glob,
    /// grep, bash, current_time, todo_write, compact_context. File tools are confined to the
    /// working directory; bash is not. Calls that can change the machine ask
    /// first unless --no-approval is set.
    #[arg(long)]
    tools: bool,

    /// Run tool calls without asking. For unattended runs — the model gets to
    /// write files and run shell commands with no one watching.
    #[arg(long, visible_alias = "yolo")]
    no_approval: bool,

    /// Send one prompt, print the reply, and exit (no REPL)
    #[arg(long)]
    once: Option<String>,

    /// Resume a session by ID (full UUID or unambiguous prefix)
    #[arg(long, value_name = "SESSION", conflicts_with_all = ["continue_", "no_log"])]
    resume: Option<String>,

    /// Resume the most recently modified session in the log dir
    #[arg(long = "continue", conflicts_with = "no_log")]
    continue_: bool,

    /// Don't write a session log
    #[arg(long)]
    no_log: bool,

    /// Directory for session logs
    #[arg(long, default_value = ".nightloom/sessions")]
    log_dir: PathBuf,
}

fn build_chat(args: &ChatArgs) -> Result<Chat> {
    let (provider, model) = nightloom_service::connect(
        args.provider,
        args.model.clone(),
        None,
        args.base_url.clone(),
        Some(Box::new(|e: &ProviderError, attempt: u32| {
            eprintln!("{DIM}transient provider error (attempt {attempt}): {e}; retrying…{RESET}");
        })),
    )
    .with_context(|| format!("cannot build provider {}", args.provider))?;
    let mut chat = Chat::new(provider, model);
    // `--bare` drops every discovered layer; `--system` is the shell-supplied
    // one and survives either way, appended last.
    let on = !args.bare;
    chat.system = prompt::assemble(&PromptConfig {
        identity: on,
        environment: on,
        project_instructions: on,
        user_memory: on,
        cwd: std::env::current_dir().context("cannot read the current directory")?,
        custom: args.system.clone(),
    });
    chat.thinking = args.thinking.clone().unwrap_or(Thinking::Default);
    chat.max_tokens = args.max_tokens;
    // Gives the sidecar's context gauge a denominator; `None` for a model
    // the table doesn't cover, which the gauge reports as a bare count.
    chat.context_limit = nightloom_service::context_limit(args.provider, &chat.model);
    chat.price = nightloom_service::price(args.provider, &chat.model);
    if args.tools {
        chat.tools = tools::builtin();
        chat.approver = approver(args);
        // Tied to the same flag rather than always on: `compact_context` is
        // still a tool, and a run that asked for no tools should not quietly
        // get a tools array — it changes what the provider is sent.
        chat.enable_self_compaction();
        // The subagent is built from the same arguments, so it gets the same
        // provider, model and tool set. Its `task` tool is stripped and its
        // approver replaced by the engine, so this cannot recurse or slip
        // past the gate.
        let sub_args = args.clone();
        chat.enable_subagents(Arc::new(move || {
            build_chat(&sub_args).map_err(|e| e.to_string())
        }));
    }
    if args.no_sidecar {
        chat.sidecar = Vec::new();
    }
    Ok(chat)
}

/// The consent policy for this run, or `None` for no gate at all.
///
/// [`AutoApprove`] is what makes this one prompt per *tool* rather than one
/// per call: reads and task-list writes never surface, and "always" is
/// remembered for the life of the process.
fn approver(args: &ChatArgs) -> Option<Arc<dyn nightloom_service::Approver>> {
    if args.no_approval {
        return None;
    }
    if !io::stdin().is_terminal() {
        // Piped stdin still answers the prompt — it just answers with
        // whatever is in the pipe, and with EOF once that runs out, which
        // refuses every remaining call. That is the safe outcome but a
        // baffling one to debug from the model's side, so say it once up
        // front rather than once per call.
        eprintln!(
            "{DIM}warning: stdin is not a terminal, so approval prompts will be answered from \
             the pipe and every call after it is exhausted will be refused. Pass --no-approval \
             to run tools unattended.{RESET}"
        );
    }
    Some(Arc::new(AutoApprove::from_fn(ask_approval)))
}

/// Ask the terminal about one call.
///
/// Synchronous on purpose: the REPL reads its own input this way, and by the
/// time a tool runs the round's stream is finished and dropped, so there is
/// nothing left for this task to poll while it waits for a human.
fn ask_approval(call: &PendingCall<'_>) -> Decision {
    let mut stdout = io::stdout();
    // Its own line, flushed: `run_turn` has been streaming into this terminal
    // and the cursor is wherever the last delta left it.
    let _ = write!(
        stdout,
        "\n{DIM}⚠ {} wants to run{RESET} {}\n  [y] allow  [a] always allow {}  [n] deny — \
         or type a reason › ",
        call.name,
        store::one_line(&call.input.to_string(), 160),
        call.name,
    );
    let _ = stdout.flush();

    let mut line = String::new();
    if io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
        return Decision::Deny(
            "there is no one at the terminal to approve this; the run is unattended".into(),
        );
    }
    match line.trim() {
        "y" | "yes" => Decision::Allow,
        "a" | "always" => Decision::AllowAlways,
        // Anything else is a refusal, and whatever was typed is what the
        // model is told — "use the test script instead" is a far more useful
        // answer than a bare no, and this is the only place to say it.
        "n" | "no" | "" => Decision::Deny(String::new()),
        reason => Decision::Deny(reason.to_string()),
    }
}

/// One dim line naming the layers the preamble actually picked up — a
/// projection of the assembled prompt, not a second run of the discovery.
fn prompt_summary(system: &SystemPrompt) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut project_at: Option<usize> = None;
    let mut project = 0usize;
    for segment in system.segments() {
        match segment.kind {
            SegmentKind::Identity => parts.push("identity".into()),
            SegmentKind::Environment => parts.push("environment".into()),
            SegmentKind::UserMemory => parts.push("user memory".into()),
            SegmentKind::ProjectInstructions => {
                // Collapse the walk's files into one count, in place.
                project += 1;
                if project_at.is_none() {
                    project_at = Some(parts.len());
                    parts.push(String::new());
                }
            }
            SegmentKind::Custom => parts.push("--system".into()),
            _ => {}
        }
    }
    if let Some(i) = project_at {
        let plural = if project == 1 { "" } else { "s" };
        parts[i] = format!("{project} project file{plural}");
    }
    (!parts.is_empty()).then(|| format!("prompt: {}", parts.join(", ")))
}

fn new_session(args: &ChatArgs) -> Result<Session> {
    if args.no_log {
        Ok(Session::new())
    } else {
        Session::with_log(&args.log_dir).context("failed to create session log")
    }
}

fn open_session(args: &ChatArgs) -> Result<Session> {
    let path = if let Some(prefix) = &args.resume {
        Some(store::find_by_prefix(&args.log_dir, prefix)?)
    } else if args.continue_ {
        Some(store::latest(&args.log_dir)?)
    } else {
        None
    };
    match path {
        Some(path) => Session::load(&path)
            .with_context(|| format!("failed to load session {}", path.display())),
        None => new_session(args),
    }
}

/// Enough context to pick the conversation back up: turn counts plus the
/// last exchange.
fn print_recap(session: &Session) {
    let mut user_turns = 0;
    let mut assistant_turns = 0;
    let mut last_user = None;
    let mut last_assistant = None;
    for (_, event) in session.live_events() {
        match event {
            SessionEvent::UserMessage { text, .. } => {
                user_turns += 1;
                last_user = Some(text.as_str());
            }
            SessionEvent::AssistantMessage { blocks, .. } => {
                assistant_turns += 1;
                last_assistant = Some(blocks);
            }
            _ => {}
        }
    }
    println!(
        "{DIM}resumed session {} — {user_turns} user / {assistant_turns} assistant turns{RESET}",
        session.id
    );
    if let Some(text) = last_user {
        println!("{DIM}  you › {}{RESET}", store::one_line(text, 100));
    }
    if let Some(blocks) = last_assistant {
        let text: String = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        println!("{DIM}  model › {}{RESET}", store::one_line(&text, 100));
    }
}

/// Terminal rendering of one turn event. Thinking prints dim; the
/// `in_thinking` flag tracks the open dim span across events.
fn render(stdout: &mut io::Stdout, in_thinking: &mut bool, event: TurnEvent) -> io::Result<()> {
    let close_thinking = |stdout: &mut io::Stdout, in_thinking: &mut bool| -> io::Result<()> {
        if *in_thinking {
            write!(stdout, "{RESET}\n\n")?;
            *in_thinking = false;
        }
        Ok(())
    };
    match event {
        TurnEvent::TextDelta { text } => {
            close_thinking(stdout, in_thinking)?;
            write!(stdout, "{text}")?;
            stdout.flush()
        }
        TurnEvent::ThinkingDelta { text } => {
            if !*in_thinking {
                write!(stdout, "{DIM}")?;
                *in_thinking = true;
            }
            write!(stdout, "{text}")?;
            stdout.flush()
        }
        TurnEvent::RedactedThinking => {
            close_thinking(stdout, in_thinking)?;
            writeln!(stdout, "{DIM}[redacted thinking]{RESET}")
        }
        TurnEvent::ToolCall { name, input, .. } => {
            close_thinking(stdout, in_thinking)?;
            // Value's Display is compact single-line JSON.
            writeln!(stdout, "{DIM}⚒ {name} {input}{RESET}")
        }
        TurnEvent::ToolResult {
            content, is_error, ..
        } => {
            let prefix = if is_error { "error: " } else { "" };
            writeln!(
                stdout,
                "{DIM}  → {prefix}{}{RESET}",
                store::one_line(&content, 80)
            )
        }
        TurnEvent::ToolDenied { name, reason, .. } => {
            close_thinking(stdout, in_thinking)?;
            let reason = if reason.is_empty() {
                String::new()
            } else {
                format!(": {reason}")
            };
            writeln!(stdout, "{DIM}  → denied, {name} did not run{reason}{RESET}")
        }
        TurnEvent::Compacted { summary } => {
            writeln!(
                stdout,
                "
{DIM}context compacted at the model's request — {} chars of summary{RESET}",
                summary.len()
            )
        }
        TurnEvent::RoundLimit { rounds } => {
            writeln!(
                stdout,
                "{DIM}warning: reached {rounds} tool rounds this turn; stopping{RESET}"
            )
        }
        _ => Ok(()),
    }
}

/// Run one user turn, streaming to stdout. Ctrl-C cancels the in-flight
/// request; the service records the partial reply either way.
/// The turns this session can be rewound to, numbered for `/rewind N`.
///
/// Numbered from 1 in display order rather than by event index: the index is
/// a position in the log, which counts assistant messages and tool results
/// too, so "rewind to 4" would land somewhere the user never sees.
fn list_checkpoints(session: &Session) {
    let points = session.checkpoints();
    if points.is_empty() {
        println!("{DIM}nothing to rewind to yet{RESET}");
        return;
    }
    println!("{DIM}rewind to a turn with /rewind <n>:{RESET}");
    for (n, c) in points.iter().enumerate() {
        let label = if c.text.is_empty() && c.images > 0 {
            format!(
                "({} image{})",
                c.images,
                if c.images == 1 { "" } else { "s" }
            )
        } else {
            store::one_line(&c.text, 72)
        };
        println!("{DIM}  {:>3}. {label}{RESET}", n + 1);
    }
}

fn rewind_to(session: &mut Session, arg: &str) {
    let points = session.checkpoints();
    let Ok(n) = arg.parse::<usize>() else {
        eprintln!("usage: /rewind <n>, where n is a turn from /rewind");
        return;
    };
    let Some(point) = n.checked_sub(1).and_then(|i| points.get(i)) else {
        eprintln!("no turn {n}; /rewind lists them");
        return;
    };
    let label = store::one_line(&point.text, 60);
    match session.rewind(point.index) {
        Ok(dropped) => {
            println!("{DIM}rewound to \"{label}\" — {dropped} events dropped{RESET}");
            // Said plainly because it is the one thing a rewind does not do,
            // and the gap between "the conversation forgot it" and "the disk
            // forgot it" is where someone loses work.
            println!("{DIM}files written by tools are untouched{RESET}");
        }
        Err(e) => eprintln!("cannot rewind: {e}"),
    }
}

async fn run_turn(chat: &Chat, session: &mut Session, input: &str) -> Result<()> {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let ctrl_c = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });

    let mut stdout = io::stdout();
    let mut in_thinking = false;
    let result = chat
        .run_turn(session, input, &cancel, &mut |event| {
            // Rendering failures (closed stdout) aren't worth aborting over.
            let _ = render(&mut stdout, &mut in_thinking, event);
        })
        .await;
    ctrl_c.abort();

    if in_thinking {
        print!("{RESET}");
    }
    println!();
    let outcome = result?;
    if outcome.interrupted {
        println!("{DIM}interrupted{RESET}");
    }
    Ok(())
}

/// Compact the session (Ctrl-C cancellable), reporting the outcome.
async fn run_compact(chat: &Chat, session: &mut Session) -> Result<()> {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let ctrl_c = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });
    println!("{DIM}compacting session…{RESET}");
    let result = chat.compact(session, &cancel).await;
    ctrl_c.abort();

    let outcome = result?;
    if outcome.interrupted {
        println!("{DIM}compaction cancelled; session unchanged{RESET}");
        return Ok(());
    }
    println!(
        "{DIM}compacted — earlier turns replaced by a summary ({} chars):{RESET}",
        outcome.summary.chars().count()
    );
    println!("{DIM}{}{RESET}", outcome.summary);
    Ok(())
}

fn prompt_line() -> Result<Option<String>> {
    print!("\nyou › ");
    io::stdout().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        return Ok(None); // EOF
    }
    Ok(Some(line.trim().to_string()))
}

pub async fn run(args: ChatArgs) -> Result<()> {
    let chat = build_chat(&args)?;
    let mut session = open_session(&args)?;

    if let Some(prompt) = args.once.clone() {
        run_turn(&chat, &mut session, &prompt).await?;
        return Ok(());
    }

    println!(
        "nightloom v{} — {}:{}",
        env!("CARGO_PKG_VERSION"),
        chat.provider.name(),
        chat.model
    );
    if let Some(path) = session.log_path() {
        println!("{DIM}session log: {}{RESET}", path.display());
    }
    if !args.bare
        && let Some(line) = prompt_summary(&chat.system)
    {
        println!("{DIM}{line}{RESET}");
    }
    if args.tools {
        println!(
            "{DIM}{}{RESET}",
            if args.no_approval {
                "tools: on, approval off — file writes and shell commands run unasked"
            } else {
                "tools: on — anything that can change the machine asks first"
            }
        );
    }
    if args.resume.is_some() || args.continue_ {
        print_recap(&session);
    }
    println!(
        "{DIM}/new starts a fresh session, /compact summarizes it in place, /quit exits{RESET}"
    );

    loop {
        let Some(line) = prompt_line()? else {
            break;
        };
        match line.as_str() {
            "" => continue,
            "/quit" | "/exit" => break,
            "/new" => {
                session = new_session(&args)?;
                println!("{DIM}started new session {}{RESET}", session.id);
                continue;
            }
            "/compact" => {
                if let Err(e) = run_compact(&chat, &mut session).await {
                    eprintln!("error: {e:#}");
                }
                continue;
            }
            "/rewind" => {
                list_checkpoints(&session);
                continue;
            }
            _ => {}
        }
        if let Some(arg) = line.strip_prefix("/rewind ") {
            rewind_to(&mut session, arg.trim());
            continue;
        }
        println!();
        if let Err(e) = run_turn(&chat, &mut session, &line).await {
            eprintln!("\nerror: {e:#}");
        }
    }

    let u = session.total_usage();
    if u != Usage::default() {
        let mut line = format!("{} in / {} out", u.input_tokens, u.output_tokens);
        // Only when the host reports caching at all: no field means no rate,
        // which is not the same as a 0% hit.
        if let Some(rate) = u.cache_hit_rate() {
            line.push_str(&format!(" ({:.0}% cached)", rate * 100.0));
        }
        let cost = session.cost();
        if cost.usd > 0.0 || !cost.is_complete() {
            // A floor rather than a total when some exchange had no price;
            // saying "$0.02" for a session that was partly unpriced would be
            // a smaller number than the user actually owes.
            let approx = if cost.is_complete() { "" } else { "at least " };
            line.push_str(&format!(" — {approx}${:.4}", cost.usd));
        }
        println!("{DIM}session usage: {line}{RESET}");
    }
    Ok(())
}
