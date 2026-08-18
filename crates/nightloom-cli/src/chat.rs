use crate::{DIM, RESET, sessions};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Provider, Session, SessionEvent, StreamEvent, Thinking, Usage,
};
use nightloom_providers::ProviderKind;
use std::io::{self, Write};
use std::path::PathBuf;

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

fn build_provider(args: &ChatArgs) -> Result<(Box<dyn Provider>, String)> {
    let provider = args
        .provider
        .from_env(args.base_url.clone())
        .with_context(|| format!("cannot build provider {}", args.provider))?;
    let Some(model) = args
        .model
        .clone()
        .or_else(|| args.provider.default_model().map(String::from))
    else {
        bail!("--model is required for provider {}", args.provider);
    };
    Ok((provider, model))
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
        Some(sessions::find_by_prefix(&args.log_dir, prefix)?)
    } else if args.continue_ {
        Some(sessions::latest(&args.log_dir)?)
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
        println!("{DIM}  you › {}{RESET}", sessions::one_line(text, 100));
    }
    if let Some(blocks) = last_assistant {
        let text: String = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        println!("{DIM}  model › {}{RESET}", sessions::one_line(&text, 100));
    }
}

/// Run one user turn: record it, stream the reply to stdout, record the reply.
async fn run_turn(
    provider: &dyn Provider,
    model: &str,
    session: &mut Session,
    args: &ChatArgs,
    input: &str,
) -> Result<()> {
    session.record_user(input);
    let request = ChatRequest {
        model: model.to_string(),
        system: args.system.clone(),
        messages: session.messages(),
        max_tokens: args.max_tokens,
        temperature: None,
        thinking: args.thinking.clone().unwrap_or(Thinking::Default),
        tools: Vec::new(),
    };

    let mut stream = provider.stream_chat(request).await?;
    let mut stdout = io::stdout();
    let mut text = String::new();
    let mut thinking = String::new();
    let mut in_thinking = false;
    let mut usage = Usage::default();
    let mut stop_reason = None;

    while let Some(event) = stream.next().await {
        match event? {
            StreamEvent::TextDelta(delta) => {
                if in_thinking {
                    write!(stdout, "{RESET}\n\n")?;
                    in_thinking = false;
                }
                write!(stdout, "{delta}")?;
                stdout.flush()?;
                text.push_str(&delta);
            }
            StreamEvent::ThinkingDelta(delta) => {
                if !in_thinking {
                    write!(stdout, "{DIM}")?;
                    in_thinking = true;
                }
                write!(stdout, "{delta}")?;
                stdout.flush()?;
                thinking.push_str(&delta);
            }
            StreamEvent::Usage(u) => usage = u,
            StreamEvent::End { stop_reason: r } => stop_reason = r,
            _ => {}
        }
    }
    if in_thinking {
        write!(stdout, "{RESET}")?;
    }
    writeln!(stdout)?;

    let mut blocks = Vec::new();
    if !thinking.is_empty() {
        blocks.push(ContentBlock::Thinking { text: thinking });
    }
    blocks.push(ContentBlock::Text { text });
    session.record_assistant(model, blocks, stop_reason, usage);
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
    let (provider, model) = build_provider(&args)?;
    let mut session = open_session(&args)?;

    if let Some(prompt) = args.once.clone() {
        run_turn(provider.as_ref(), &model, &mut session, &args, &prompt).await?;
        return Ok(());
    }

    println!(
        "nightloom v{} — {}:{}",
        env!("CARGO_PKG_VERSION"),
        provider.name(),
        model
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
        if let Err(e) = run_turn(provider.as_ref(), &model, &mut session, &args, &line).await {
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
