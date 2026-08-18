use crate::{DIM, RESET};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use nightloom_core::{ChatRequest, ContentBlock, Provider, Session, StreamEvent, Thinking, Usage};
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
    let mut session = new_session(&args)?;

    if let Some(prompt) = args.once.clone() {
        run_turn(provider.as_ref(), &model, &mut session, &args, &prompt).await?;
        return Ok(());
    }

    println!("nightloom v{} — {}:{}", env!("CARGO_PKG_VERSION"), provider.name(), model);
    if let Some(path) = session.log_path() {
        println!("{DIM}session log: {}{RESET}", path.display());
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
        println!("{DIM}session usage: {} in / {} out{RESET}", u.input_tokens, u.output_tokens);
    }
    Ok(())
}
