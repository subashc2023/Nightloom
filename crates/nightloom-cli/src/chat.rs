use crate::{DIM, RESET, sessions, tools};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Provider, Session, SessionEvent, StreamEvent, Thinking, Usage,
    tool::{defs, run_tool},
};
use nightloom_providers::{ProviderKind, retry::Retry};
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
    // Transient failures (rate limits, overload, dropped connections) retry
    // with backoff before a request has streamed anything.
    let provider = Box::new(Retry::new(provider).on_retry(Box::new(|e, attempt| {
        eprintln!("{DIM}transient provider error (attempt {attempt}): {e}; retrying…{RESET}");
    })));
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

/// Run one user turn: record it, stream the reply to stdout, record the
/// reply. With `--tools`, tool calls are executed and their results looped
/// back to the provider until it answers in text (capped per turn).
async fn run_turn(
    provider: &dyn Provider,
    model: &str,
    session: &mut Session,
    args: &ChatArgs,
    input: &str,
) -> Result<()> {
    const MAX_ROUNDS: usize = 8;
    session.record_user(input);
    let tools = if args.tools {
        tools::builtin()
    } else {
        Vec::new()
    };

    for round in 1..=MAX_ROUNDS {
        let request = ChatRequest {
            model: model.to_string(),
            system: args.system.clone(),
            messages: session.messages(),
            max_tokens: args.max_tokens,
            temperature: None,
            thinking: args.thinking.clone().unwrap_or(Thinking::Default),
            tools: defs(&tools),
        };

        // Blocks are assembled in stream order: Anthropic requires thinking
        // to precede the tool_use it led to, and interleaved thinking means
        // thinking/text/tool_use can alternate within one message.
        // A signature with no visible text still marks a real block (adaptive
        // models can emit only empty deltas); it must be kept for replay.
        fn flush_thinking(
            buf: &mut String,
            blocks: &mut Vec<ContentBlock>,
            signature: Option<String>,
        ) {
            if !buf.is_empty() || signature.is_some() {
                blocks.push(ContentBlock::Thinking {
                    text: std::mem::take(buf),
                    signature,
                });
            }
        }
        fn flush_text(buf: &mut String, blocks: &mut Vec<ContentBlock>) {
            if !buf.is_empty() {
                blocks.push(ContentBlock::Text {
                    text: std::mem::take(buf),
                });
            }
        }

        let mut stream = provider.stream_chat(request).await?;
        let mut stdout = io::stdout();
        let mut blocks = Vec::new();
        let mut text_buf = String::new();
        let mut thinking_buf = String::new();
        let mut in_thinking = false;
        let mut usage = Usage::default();
        let mut stop_reason = None;
        let mut calls = Vec::new();
        let mut interrupted = false;
        let mut stream_err = None;

        let ctrl_c = tokio::signal::ctrl_c();
        tokio::pin!(ctrl_c);
        loop {
            let event = tokio::select! {
                _ = &mut ctrl_c => {
                    interrupted = true;
                    break;
                }
                next = stream.next() => match next {
                    Some(Ok(event)) => event,
                    Some(Err(e)) => {
                        stream_err = Some(e);
                        break;
                    }
                    None => break,
                },
            };
            match event {
                StreamEvent::TextDelta(delta) => {
                    // Signed thinking was already flushed by ThinkingSignature;
                    // this closes unsigned thinking when text starts.
                    flush_thinking(&mut thinking_buf, &mut blocks, None);
                    if in_thinking {
                        write!(stdout, "{RESET}\n\n")?;
                        in_thinking = false;
                    }
                    write!(stdout, "{delta}")?;
                    stdout.flush()?;
                    text_buf.push_str(&delta);
                }
                StreamEvent::ThinkingDelta(delta) => {
                    flush_text(&mut text_buf, &mut blocks);
                    if !in_thinking {
                        write!(stdout, "{DIM}")?;
                        in_thinking = true;
                    }
                    write!(stdout, "{delta}")?;
                    stdout.flush()?;
                    thinking_buf.push_str(&delta);
                }
                StreamEvent::ThinkingSignature(sig) => {
                    flush_thinking(&mut thinking_buf, &mut blocks, Some(sig));
                }
                StreamEvent::RedactedThinking { data } => {
                    flush_thinking(&mut thinking_buf, &mut blocks, None);
                    flush_text(&mut text_buf, &mut blocks);
                    if in_thinking {
                        write!(stdout, "{RESET}\n\n")?;
                        in_thinking = false;
                    }
                    writeln!(stdout, "{DIM}[redacted thinking]{RESET}")?;
                    stdout.flush()?;
                    blocks.push(ContentBlock::RedactedThinking { data });
                }
                StreamEvent::ToolUse { id, name, input } => {
                    flush_thinking(&mut thinking_buf, &mut blocks, None);
                    flush_text(&mut text_buf, &mut blocks);
                    if in_thinking {
                        write!(stdout, "{RESET}\n\n")?;
                        in_thinking = false;
                    }
                    // Value's Display is compact single-line JSON.
                    writeln!(stdout, "{DIM}⚒ {name} {input}{RESET}")?;
                    stdout.flush()?;
                    blocks.push(ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    calls.push((id, name, input));
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
        // Cancel the in-flight request before touching the session.
        drop(stream);

        flush_thinking(&mut thinking_buf, &mut blocks, None);
        flush_text(&mut text_buf, &mut blocks);

        if interrupted || stream_err.is_some() {
            // These calls will never get results, and a tool_use without a
            // result is invalid on replay — drop them from the record. The
            // thinking/text streamed so far is kept.
            blocks.retain(|b| !matches!(b, ContentBlock::ToolUse { .. }));
            if !blocks.is_empty() {
                let reason = if interrupted { "interrupted" } else { "error" };
                session.record_assistant(model, blocks, Some(reason.into()), usage);
            }
            if let Some(e) = stream_err {
                return Err(e.into());
            }
            println!("{DIM}interrupted{RESET}");
            return Ok(());
        }

        // A tool-only response has no text; recording an empty text block
        // would replay as one, which providers reject. An entirely empty
        // reply still records one.
        if calls.is_empty()
            && !blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Text { .. }))
        {
            blocks.push(ContentBlock::Text {
                text: String::new(),
            });
        }
        session.record_assistant(model, blocks, stop_reason, usage);

        if calls.is_empty() {
            break;
        }
        // Execute even on the last round so no call is left without a
        // result in the session; just don't go back to the provider.
        for (id, name, input) in calls {
            let result = run_tool(&tools, &id, &name, input).await;
            if let ContentBlock::ToolResult {
                content, is_error, ..
            } = &result
            {
                let prefix = if *is_error { "error: " } else { "" };
                println!(
                    "{DIM}  → {prefix}{}{RESET}",
                    sessions::one_line(content, 80)
                );
            }
            session.record_tool_result(&result);
        }
        if round == MAX_ROUNDS {
            println!("{DIM}warning: reached {MAX_ROUNDS} tool rounds this turn; stopping{RESET}");
            break;
        }
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
