use crate::{DIM, RESET};
use anyhow::{Context, Result};
use nightloom_core::{ContentBlock, ProviderError, Session, SessionEvent, Thinking, Usage};
use nightloom_service::{Chat, ProviderKind, TurnEvent, store, tools};
use std::io::{self, Write};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
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

    /// System prompt
    #[arg(long)]
    system: Option<String>,

    /// Reasoning control: default | budget=N | effort=LEVEL (support varies by provider)
    #[arg(long)]
    thinking: Option<Thinking>,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Enable the built-in tools (current_time, read_file, list_dir)
    #[arg(long)]
    tools: bool,

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
        args.base_url.clone(),
        Some(Box::new(|e: &ProviderError, attempt: u32| {
            eprintln!("{DIM}transient provider error (attempt {attempt}): {e}; retrying…{RESET}");
        })),
    )
    .with_context(|| format!("cannot build provider {}", args.provider))?;
    let mut chat = Chat::new(provider, model);
    chat.system = args.system.clone();
    chat.thinking = args.thinking.clone().unwrap_or(Thinking::Default);
    chat.max_tokens = args.max_tokens;
    if args.tools {
        chat.tools = tools::builtin();
    }
    Ok(chat)
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
    for event in session.events() {
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
    if args.resume.is_some() || args.continue_ {
        print_recap(&session);
    }
    println!("{DIM}/new starts a fresh session, /quit exits{RESET}");

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
            _ => {}
        }
        println!();
        if let Err(e) = run_turn(&chat, &mut session, &line).await {
            eprintln!("\nerror: {e:#}");
        }
    }

    let u = session.total_usage();
    if u != Usage::default() {
        println!(
            "{DIM}session usage: {} in / {} out{RESET}",
            u.input_tokens, u.output_tokens
        );
    }
    Ok(())
}
