use crate::{DIM, RESET};
use anyhow::{Context, Result};
use nightloom_core::tool::Tool;
use nightloom_core::{
    BlockKind, BlockSource, ContentBlock, ProviderError, SegmentKind, Session, SessionEvent,
    SystemPrompt, Thinking, Usage,
};
use nightloom_service::credentials;
use nightloom_service::tools::{Reviewer, Root};
use nightloom_service::{
    AutoApprove, Chat, Decision, KnowledgeContext, PendingCall, ProjectContext, PromptConfig,
    ProviderKind, TurnEvent, knowledge, mcp, project, prompt, store, tools,
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
    pub(crate) model: Option<String>,

    /// Override the provider's API base URL (e.g. http://localhost:11434/v1)
    #[arg(long)]
    base_url: Option<String>,

    /// Extra system-prompt text, appended after the built-in preamble
    #[arg(long)]
    pub(crate) system: Option<String>,

    /// Skip the built-in preamble (identity, environment, project instructions)
    #[arg(long)]
    pub(crate) bare: bool,

    /// Don't attach the per-turn status block (time, tasks, context)
    #[arg(long)]
    no_sidecar: bool,

    /// Reasoning control: default | budget=N | effort=LEVEL (support varies by provider)
    #[arg(long)]
    thinking: Option<Thinking>,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Enable the built-in tools: read/write/edit files, list_dir, glob,
    /// grep, bash, current_time, todo_write and the web
    /// tools (compact_context is --self-compact). File tools are confined to the
    /// working directory; bash is not. Calls that can change the machine ask
    /// first unless --no-approval is set.
    #[arg(long)]
    pub(crate) tools: bool,

    /// Run tool calls without asking. For unattended runs — the model gets to
    /// write files and run shell commands with no one watching.
    #[arg(long, visible_alias = "yolo")]
    pub(crate) no_approval: bool,

    /// Send one prompt, print the reply, and exit (no REPL)
    #[arg(long)]
    pub(crate) once: Option<String>,

    /// Resume a session by ID (full UUID or unambiguous prefix)
    #[arg(long, value_name = "SESSION", conflicts_with_all = ["continue_", "no_log"])]
    resume: Option<String>,

    /// Resume the most recently modified session in the log dir
    #[arg(long = "continue", conflicts_with = "no_log")]
    continue_: bool,

    /// Don't write a session log
    #[arg(long)]
    no_log: bool,

    /// Directory for session logs. Defaults to this folder's store under
    /// ~/.nightloom (NIGHTLOOM_HOME overrides where that is).
    #[arg(long)]
    log_dir: Option<PathBuf>,

    /// Skip MCP servers configured in .nightloom/mcp.json
    #[arg(long)]
    no_mcp: bool,

    /// Don't offer the review tool, even where a second provider's key is set
    #[arg(long)]
    no_review: bool,

    /// Don't offer the web tools (web_fetch, web_search)
    #[arg(long)]
    no_web: bool,

    /// Don't give the model the knowledge base: no @kb tree, no index in the
    /// preamble. Its own flag rather than riding on --tools, because turning
    /// tools on has always meant "may write inside this folder" and the vault
    /// is a second directory, outside it.
    #[arg(long)]
    no_knowledge: bool,

    /// Let the model ask for its own history to be summarised, by offering it
    /// `compact_context`. Opt-in rather than on with --tools: a compaction
    /// supersedes everything before it, and /compact is always available.
    #[arg(long)]
    self_compact: bool,

    /// After a compaction — /compact, or the model's own compact_context —
    /// run a dream pass over the memory inbox when observations are pending.
    /// Opt-in because it spends a provider turn unattended; a compaction is
    /// the trigger the evidence supports, being the moment a conversation's
    /// detail is already being traded away.
    #[arg(long, conflicts_with = "no_knowledge")]
    auto_dream: bool,

    /// Which model dreams, as provider[:model] — e.g.
    /// openrouter:deepseek/deepseek-v4-flash. Defaults to this chat's own
    /// provider and model.
    #[arg(long, value_name = "TARGET", requires = "auto_dream")]
    dream_target: Option<String>,

    /// Drive a signed-in agent CLI instead of calling a provider API, so the
    /// turn is billed to that CLI's login — a Claude subscription rather than
    /// an API key. Claude Code then owns the loop, the tools and the history,
    /// so --thinking, --self-compact, /context and /rewind do not apply.
    #[arg(long, value_name = "KIND")]
    pub(crate) agent: Option<AgentKind>,

    /// The agent executable, for a version manager or a checkout
    #[arg(long, default_value = "claude", value_name = "PATH")]
    pub(crate) agent_binary: String,

    /// Stop an agent turn once it has spent this much (USD)
    #[arg(long, value_name = "USD")]
    pub(crate) agent_budget: Option<f64>,
}

/// Which agent CLI `--agent` drives.
///
/// An enum with one arm rather than a bool, because the shape generalizes:
/// Codex, Gemini CLI and OpenCode all speak a streaming JSON dialect over a
/// signed-in session, and the seam here is the translator, not the flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum AgentKind {
    /// Anthropic's Claude Code, billed to your Claude plan
    ClaudeCode,
}

/// Where this run's session logs live.
///
/// An explicit `--log-dir` wins. Otherwise: the project registered on this
/// folder, if one is — which is what makes `--continue` here resume the chat
/// the desktop app was having in the same folder — and an ad-hoc store keyed
/// by the path when nobody has registered it, which is the ordinary case for
/// a CLI run in a directory the user never named.
///
/// The registry is read and never written. Running the CLI somewhere is not a
/// statement that the folder is a project, and a tool that quietly filled the
/// desktop's project list with every directory you happened to `cd` into
/// would be a worse tool.
fn log_dir(args: &ChatArgs) -> PathBuf {
    if let Some(explicit) = &args.log_dir {
        return explicit.clone();
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    project::Registry::load()
        .find_by_workspace(&cwd)
        .map(|p| p.session_dir())
        .unwrap_or_else(|| project::store_for(&cwd).join(project::SESSIONS_DIR))
}

/// Tools from MCP servers, shared rather than owned.
///
/// `Arc` because subagents get the same connections: a `Chat` owns
/// `Box<dyn Tool>`, and building a subagent's tool set by reconnecting would
/// start a second copy of every server process.
type SharedTools = Vec<Arc<dyn Tool>>;

fn build_chat(args: &ChatArgs, mcp_tools: &[Arc<dyn Tool>]) -> Result<Chat> {
    let (provider, model) = nightloom_service::connect(
        args.provider,
        args.model.clone(),
        // Stored first, then the environment — the same resolver the desktop
        // uses, so a key set in either shell works in both.
        credentials::provider_key(args.provider),
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
    let cwd = std::env::current_dir().context("cannot read the current directory")?;
    let vault = vault(args);
    chat.system = prompt::assemble(&PromptConfig {
        identity: on,
        environment: on,
        project_instructions: on,
        user_memory: on,
        // The CLI's project is wherever it was run: one folder, and its
        // `.agents` — the same docspace the desktop shows for that folder,
        // and inside the tree the file tools are already rooted at, so it
        // needs nothing but a relative path to reach. Tied to `--tools`
        // because an index of files the model has no way to read is a
        // paragraph of wasted prompt.
        project: (on && args.tools).then(|| ProjectContext {
            name: cwd
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| cwd.display().to_string()),
            notes_dir: cwd.join(project::AGENTS_DIR),
        }),
        // The same vault wherever the CLI was run, which is the whole point:
        // it is the user's, not the folder's. Tied to `--tools` on the
        // docspace's argument, and to `--bare` like every other layer.
        knowledge: (on && args.tools)
            .then(|| vault.clone().map(|dir| KnowledgeContext { dir }))
            .flatten(),
        cwd: cwd.clone(),
        custom: args.system.clone(),
    });
    chat.thinking = args.thinking.clone().unwrap_or(Thinking::Default);
    chat.max_tokens = args.max_tokens;
    // Gives the sidecar's context gauge a denominator; `None` for a model
    // the table doesn't cover, which the gauge reports as a bare count.
    chat.context_limit = nightloom_service::context_limit(args.provider, &chat.model);
    chat.price = nightloom_service::price(args.provider, &chat.model);
    if args.tools {
        chat.tools = tools::builtin_in(workspace_root(&cwd, vault.as_deref()));
        // Cloned Arcs, not fresh connections: every subagent shares the one
        // set of server processes started at launch.
        chat.tools.extend(
            mcp_tools
                .iter()
                .map(|t| Box::new(t.clone()) as Box<dyn Tool>),
        );
        // The memory inbox rides the knowledge flag: `--no-knowledge` turns
        // the memory system off whole, vault and inbox alike. `remember`
        // itself needs no vault — an observation is judged and filed by the
        // dream pass, not here — so it is gated on the config dir instead.
        if !args.no_knowledge
            && let Some(config) = project::config_dir()
        {
            let source = cwd.file_name().map(|n| n.to_string_lossy().into_owned());
            chat.tools
                .push(Box::new(tools::Remember::new(config, source)));
        }
        chat.approver = approver(args);
        // Off unless asked for. It is still a tool, so it needs --tools to
        // be on at all — a run that asked for no tools should not quietly get
        // a tools array, which changes what the provider is sent — but the
        // second question is separate: the rest of the set acts on the
        // workspace, and this one acts on the conversation.
        if args.self_compact {
            chat.enable_self_compaction();
        }
        // The subagent is built from the same arguments, so it gets the same
        // provider, model and tool set. Its `task` tool is stripped and its
        // approver replaced by the engine, so this cannot recurse or slip
        // past the gate.
        let sub_args = args.clone();
        let sub_mcp = mcp_tools.to_vec();
        chat.enable_subagents(Arc::new(move || {
            build_chat(&sub_args, &sub_mcp).map_err(|e| e.to_string())
        }));
        if !args.no_web {
            // `web_search` is here only when a backend key is set, so the
            // tool set genuinely differs between machines — see
            // `tools::web_tools`. Both are `Mutating`, so both pass through
            // the same gate as `bash`.
            chat.tools.extend(tools::web_tools(credentials::search_key));
        }
        if !args.no_review {
            // Cloned first: the bench excludes whatever lineage is under
            // review, so it needs the model this chat actually resolved to,
            // and `chat` is about to be borrowed mutably.
            let model = chat.model.clone();
            let bench = reviewers(args, &model, mcp_tools);
            // Deliberately the workspace and not the vault. A reviewer runs on
            // a *second vendor*, and the vault is the user's personal
            // knowledge; there is no reason a critic reading a document in
            // this folder needs it, and "no reason to" is the wrong guarantee
            // when the alternative is not handing it over at all.
            chat.enable_reviews(bench, Root::new(&cwd));
        }
    }
    if args.no_sidecar {
        chat.sidecar = Vec::new();
    }
    Ok(chat)
}

/// The knowledge vault this run may reach.
///
/// `None` for `--no-knowledge`, and `None` when there is no user config
/// directory to keep one in — a stripped environment with no `HOME`, which
/// reads as "no vault" the same way it already reads as "no user memory".
fn vault(args: &ChatArgs) -> Option<PathBuf> {
    if args.no_knowledge {
        return None;
    }
    knowledge::vault_dir()
}

/// The tree the file tools may reach: the folder the CLI was run in, plus the
/// vault when there is one.
fn workspace_root(cwd: &std::path::Path, vault: Option<&std::path::Path>) -> Root {
    let root = Root::new(cwd.to_path_buf());
    match vault {
        Some(dir) => root.with_vault(dir.to_path_buf()),
        None => root,
    }
}

/// The curated bench, resolved into buildable reviewers.
///
/// Which reviewers exist, and whether they route through OpenRouter, is
/// [`tools::bench`]'s decision rather than this shell's — the desktop asks
/// the same question and the two must not answer it differently. All that is
/// left here is the half only a shell can do: build a `Chat` for a named
/// provider and model, which is the same `build_chat` everything else uses,
/// so a reviewer gets the same preamble, workspace and MCP connections before
/// `review` strips it to the read-only tools.
fn reviewers(args: &ChatArgs, model: &str, mcp_tools: &[Arc<dyn Tool>]) -> Vec<Reviewer> {
    tools::bench(args.provider, model, ProviderKind::has_credentials)
        .into_iter()
        .map(|spec| {
            let mut sub = args.clone();
            sub.provider = spec.kind;
            sub.model = Some(spec.model);
            // Belonged to the provider being replaced: a base URL pointed at
            // a local server is not where this reviewer lives.
            sub.base_url = None;
            let mcp = mcp_tools.to_vec();
            Reviewer::new(
                spec.name,
                spec.description,
                Arc::new(move || build_chat(&sub, &mcp).map_err(|e| e.to_string())),
            )
        })
        .collect()
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
        Session::with_log(log_dir(args)).context("failed to create session log")
    }
}

fn open_session(args: &ChatArgs) -> Result<Session> {
    let path = if let Some(prefix) = &args.resume {
        Some(store::find_by_prefix(&log_dir(args), prefix)?)
    } else if args.continue_ {
        Some(store::latest(&log_dir(args))?)
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
pub(crate) fn render(
    stdout: &mut io::Stdout,
    in_thinking: &mut bool,
    event: TurnEvent,
) -> io::Result<()> {
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
        let label = if c.text.is_empty() && c.images + c.documents > 0 {
            attachment_label(c.images, c.documents)
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

/// Itemize what the next request will carry, largest contributors visible.
///
/// The numbers in the left column are *event indices*, not display positions
/// — the opposite of `/rewind`, and for the opposite reason. A checkpoint
/// list is filtered, so an index there would point at something the user
/// never saw; this list is the context itself, one line per block, and the
/// index is the handle `/context drop` needs. Several lines sharing an index
/// is the honest rendering: an assistant turn that thought and then called a
/// tool is one event, and dropping it drops both.
fn show_context(chat: &Chat, session: &Session) {
    let view = chat.context_view(session);
    let floor = if view.totals.is_complete() { "" } else { "≥" };

    match (view.context_limit, view.fraction_used()) {
        (Some(limit), Some(frac)) => println!(
            "\ncontext: {floor}{} of {} tokens ({:.0}%)",
            thousands(view.totals.tokens),
            thousands(limit),
            frac * 100.0
        ),
        // No limit means no denominator, so no percentage — the same rule
        // the sidecar gauge follows rather than inventing a window.
        _ => println!(
            "\ncontext: {floor}{} tokens (no known limit for {})",
            thousands(view.totals.tokens),
            chat.model
        ),
    }
    if !view.totals.is_complete() {
        println!(
            "{DIM}  {} item(s) carry tokens that cannot be estimated (images, \
             documents), so the total is a floor{RESET}",
            view.totals.unestimated
        );
    }

    if !view.system.is_empty() {
        println!("\n{DIM}system prompt{RESET}");
        for seg in &view.system {
            let anchor = if seg.cache_anchor {
                format!("{DIM}  (cache anchor){RESET}")
            } else {
                String::new()
            };
            println!("  {:>9}  {}{anchor}", size_cell(seg.size), seg.name);
        }
    }

    println!("\n{DIM}conversation{RESET}");
    for msg in &view.messages {
        for block in &msg.blocks {
            let slot = match block.source {
                BlockSource::Event { index } => format!("{index:>4}"),
                // Nothing in the log to point at: it is composed fresh every
                // turn and vanishes from the next one on its own.
                BlockSource::Sidecar => "   ~".to_string(),
                _ => "   ?".to_string(),
            };
            let label = kind_label(block.kind);
            // `one_line` adds its own ellipsis, so `block.truncated` (which
            // reports the view's own 280-character cut) must not add a second.
            let preview = store::one_line(&block.preview, 46);
            let mark = if block.elided { " [removed]" } else { "" };
            println!(
                "  {slot}  {:>9}  {label:<12} {DIM}{preview}{RESET}{mark}",
                size_cell(block.size)
            );
        }
    }

    let elided = view.elided_events();
    if !elided.is_empty() {
        println!(
            "\n{DIM}{} item(s) removed; /context keep <n>… restores them{RESET}",
            elided.len()
        );
    }
    println!("{DIM}/context drop <n>… removes an item's content from the next request{RESET}");
}

/// A size cell: estimated tokens, or a byte count where no estimate is
/// honest. Never a guessed token figure — an image sized "1,024 tokens"
/// would be a number somebody could act on and nobody could defend.
fn size_cell(size: nightloom_core::Size) -> String {
    match size.tokens {
        Some(t) => format!("{} tok", thousands(t)),
        None => format!("{} KB", thousands((size.bytes / 1024).max(1) as u64)),
    }
}

/// How an uncaptioned turn is listed, since its text says nothing.
fn attachment_label(images: usize, documents: usize) -> String {
    let mut parts = Vec::new();
    if images > 0 {
        parts.push(format!(
            "{images} image{}",
            if images == 1 { "" } else { "s" }
        ));
    }
    if documents > 0 {
        parts.push(format!(
            "{documents} document{}",
            if documents == 1 { "" } else { "s" }
        ));
    }
    format!("({})", parts.join(", "))
}

fn kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Text => "text",
        BlockKind::Image => "image",
        BlockKind::Document => "document",
        BlockKind::Thinking => "thinking",
        BlockKind::RedactedThinking => "thinking*",
        BlockKind::ToolUse => "tool call",
        BlockKind::ReasoningRef => "reasoning",
        BlockKind::ToolResult => "tool result",
        BlockKind::Sidecar => "sidecar",
        _ => "?",
    }
}

fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `/context drop 3 7` and `/context keep 3`.
fn edit_context(session: &mut Session, verb: &str, args: &str) {
    let mut targets = Vec::new();
    for token in args.split_whitespace() {
        match token.parse::<usize>() {
            Ok(n) => targets.push(n),
            Err(_) => {
                eprintln!("not an item number: {token}");
                return;
            }
        }
    }
    if targets.is_empty() {
        eprintln!("usage: /context {verb} <n>…, with numbers from /context");
        return;
    }

    let result = match verb {
        "drop" => session.elide(targets),
        _ => session.unelide(targets),
    };
    match result {
        Ok(0) => println!("{DIM}nothing changed{RESET}"),
        Ok(n) if verb == "drop" => {
            println!("{DIM}{n} item(s) removed from the context{RESET}");
            // Both of these are the gap between what the user just saw
            // happen and what actually happened, which is where surprises
            // live. The log line mirrors what /rewind says about files.
            println!(
                "{DIM}the content stays in the session log — /context keep <n>… restores it{RESET}"
            );
            println!(
                "{DIM}the prompt cache is invalidated from here on, so the next turn costs \
                 full price for what follows{RESET}"
            );
        }
        Ok(n) => println!("{DIM}{n} item(s) restored{RESET}"),
        Err(e) => eprintln!("cannot {verb}: {e}"),
    }
}

/// Rename the session by hand.
///
/// The escape hatch the generated name needs rather than a nicety: a name is
/// written once, from the first exchange, and a long conversation that has
/// moved on keeps describing where it started. Re-naming it automatically
/// would mean paying for a model call on some guess about when a chat has
/// drifted, which is not a judgement the engine is in a position to make —
/// and the user, who can see both the name and the conversation, is.
///
/// A rename is an append like everything else here: the old name stays in
/// the log and the projection takes the latest.
fn rename(session: &mut Session, name: &str) {
    if name.is_empty() {
        eprintln!("{DIM}usage: /name <text>{RESET}");
        return;
    }
    session.record_title(name);
    println!("{DIM}named “{name}”{RESET}");
}

/// Returns whether a compaction landed during the turn — the model asking
/// through `compact_context` and the engine honouring it at the boundary —
/// which is what `--auto-dream` keys on.
async fn run_turn(chat: &Chat, session: &mut Session, input: &str) -> Result<bool> {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let ctrl_c = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });

    let mut stdout = io::stdout();
    let mut in_thinking = false;
    let mut compacted = false;
    let result = chat
        .run_turn(session, input, &cancel, &mut |event| {
            if matches!(event, TurnEvent::Compacted { .. }) {
                compacted = true;
            }
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
    Ok(compacted)
}

/// Compact the session (Ctrl-C cancellable), reporting the outcome. Returns
/// whether the compaction actually landed, for `--auto-dream`.
async fn run_compact(chat: &Chat, session: &mut Session) -> Result<bool> {
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
        return Ok(false);
    }
    println!(
        "{DIM}compacted — earlier turns replaced by a summary ({} chars):{RESET}",
        outcome.summary.chars().count()
    );
    println!("{DIM}{}{RESET}", outcome.summary);
    Ok(true)
}

/// The dream pass `--auto-dream` runs after a compaction landed.
///
/// The check is here rather than at the call sites: nothing pending means
/// nothing printed and nothing spent, so a compaction with an empty inbox
/// costs no extra output. Failures are reported and swallowed — a REPL that
/// died because an unattended consolidation hit a provider error would be
/// losing the conversation over the housekeeping.
async fn auto_dream(args: &ChatArgs) {
    if !args.auto_dream {
        return;
    }
    let Some(config) = project::config_dir() else {
        return;
    };
    if nightloom_service::observe::pending_count_in(&config) == 0 {
        return;
    }
    let spec = match dream_spec(args) {
        Ok(spec) => spec,
        Err(e) => {
            eprintln!("{DIM}auto-dream skipped: {e:#}{RESET}");
            return;
        }
    };
    println!(
        "{DIM}auto-dream: consolidating the memory inbox ({}{}){RESET}",
        spec.provider,
        spec.model
            .as_deref()
            .map(|m| format!(":{m}"))
            .unwrap_or_default()
    );
    if let Err(e) = crate::dream::consolidate(spec).await {
        eprintln!("{DIM}auto-dream failed: {e:#}{RESET}");
    }
}

/// Resolve `--dream-target` (provider[:model]) into a spec, defaulting to
/// the chat's own provider and model.
fn dream_spec(args: &ChatArgs) -> Result<crate::dream::DreamSpec> {
    let (provider, model) = match args.dream_target.as_deref() {
        None => (args.provider, args.model.clone()),
        Some(target) => {
            let (provider, model) = match target.split_once(':') {
                Some((p, m)) => (p, Some(m.to_string())),
                None => (target, None),
            };
            let kind = provider.parse().map_err(|e: String| {
                anyhow::anyhow!("--dream-target {target}: {e} (expected provider[:model])")
            })?;
            (kind, model)
        }
    };
    Ok(crate::dream::DreamSpec {
        provider,
        model,
        // The base URL belongs to the chat's provider; carrying it onto a
        // different one would aim the dream at the wrong host.
        base_url: (provider == args.provider)
            .then(|| args.base_url.clone())
            .flatten(),
        thinking: None,
        max_tokens: 8192,
    })
}

pub(crate) fn prompt_line() -> Result<Option<String>> {
    print!("\nyou › ");
    io::stdout().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        return Ok(None); // EOF
    }
    Ok(Some(line.trim().to_string()))
}

/// Start the configured MCP servers, reporting each on stderr.
///
/// A server that fails to start costs a line and nothing else. Failing the
/// whole run because one of several servers is misconfigured would make MCP
/// too brittle to leave switched on, and the tools that did connect are still
/// worth having.
async fn connect_mcp(args: &ChatArgs) -> SharedTools {
    if args.no_mcp || !args.tools {
        return Vec::new();
    }
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let config = mcp::McpConfig::discover(&workspace);
    if config.is_empty() {
        return Vec::new();
    }
    let mut shared: SharedTools = Vec::new();
    for report in mcp::connect_all(&config, &workspace).await {
        match report.outcome {
            Ok(tools) => {
                println!("{DIM}mcp: {} — {} tools{RESET}", report.name, tools.len());
                shared.extend(tools.into_iter().map(Arc::from));
            }
            Err(e) => eprintln!("{DIM}mcp: {} unavailable — {e}{RESET}", report.name),
        }
    }
    shared
}

pub async fn run(args: ChatArgs) -> Result<()> {
    // Before anything reads a log directory or indexes a docspace. A folder
    // whose chats and notes are still in `.nightloom/` has them moved into
    // this folder's store, so `--continue` opens the conversation that was
    // actually happening here rather than starting a new one beside it. Said
    // out loud, on the same argument the desktop's toast makes: files inside
    // a folder the user chose were moved, and that is not a silent operation.
    if args.log_dir.is_none()
        && let Ok(cwd) = std::env::current_dir()
        && let Some(line) = project::migrate(&cwd).summary()
    {
        eprintln!("nightloom: {line}");
    }
    // A mistyped --dream-target is an argument error, and finding that out
    // at the first compaction — possibly hours in, possibly unattended — is
    // the wrong moment.
    if args.auto_dream {
        dream_spec(&args)?;
    }
    let mcp_tools = connect_mcp(&args).await;
    let mut chat = build_chat(&args, &mcp_tools)?;
    let mut session = open_session(&args)?;

    if let Some(prompt) = args.once.clone() {
        let compacted = run_turn(&chat, &mut session, &prompt).await?;
        if compacted {
            auto_dream(&args).await;
        }
        return Ok(());
    }
    // After the one-shot path, deliberately. `--once` is a single answer to a
    // single question, and doubling what it costs to label a log the user is
    // unlikely to come back to is the wrong trade; a REPL session is exactly
    // the one they will.
    chat.enable_titles();

    println!(
        "nightloom v{} — {}:{}",
        env!("CARGO_PKG_VERSION"),
        chat.provider.name(),
        chat.model
    );
    if let Some(path) = session.log_path() {
        println!("{DIM}session log: {}{RESET}", path.display());
    }
    if let Some(title) = session.title() {
        println!("{DIM}“{title}”{RESET}");
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
    if args.tools {
        // Named for two reasons, both about what the user cannot otherwise
        // see. Turning tools on has always meant "may write inside this
        // folder", and the vault is a second directory outside it — a change
        // in reach belongs on screen. And a vault that has been repointed is
        // invisible from here: a model quietly reading the wrong folder looks
        // exactly like a model that has forgotten everything.
        println!(
            "{DIM}{}{RESET}",
            match vault(&args) {
                Some(dir) => format!("knowledge: @kb — {}", dir.display()),
                None if args.no_knowledge => "knowledge: off (--no-knowledge)".to_string(),
                None => "knowledge: off — no user config directory to keep a vault in".to_string(),
            }
        );
        // The nudge that makes dreaming periodic without making it automatic:
        // an unattended pass spends real money, so the user runs it — but
        // only if something tells them there is a backlog to run it on.
        if !args.no_knowledge
            && let Some(config) = project::config_dir()
        {
            let pending = nightloom_service::observe::pending_count_in(&config);
            if pending > 0 {
                println!(
                    "{DIM}memory: {pending} observation{} awaiting `nightloom dream`{RESET}",
                    if pending == 1 { "" } else { "s" }
                );
            }
        }
    }
    // Named at startup like the vault and the search chain: an unattended
    // pass that spends money should not be a surprise when it fires.
    // Validated on entry, so the spec resolves here.
    if args.auto_dream
        && let Ok(spec) = dream_spec(&args)
    {
        println!(
            "{DIM}auto-dream: on — a compaction consolidates the inbox via {}{}{RESET}",
            spec.provider,
            spec.model
                .as_deref()
                .map(|m| format!(":{m}"))
                .unwrap_or_default()
        );
    }
    if args.tools && !args.no_web {
        // Said out loud because the failure is otherwise invisible: a model
        // with no `web_search` does not report that it has none, it simply
        // never searches, and the user is left wondering why it guessed.
        println!(
            "{DIM}{}{RESET}",
            match tools::search_backends(credentials::search_key).as_slice() {
                // Every key is named, not just the first: they are a chain,
                // and a second one is what keeps search working when the
                // first is rejected or runs out of credit.
                [] => format!(
                    "web: web_fetch only — set {} for web_search",
                    tools::SearchBackend::ALL.map(|b| b.env_key()).join(", ")
                ),
                chain => format!(
                    "web: web_fetch and web_search via {}",
                    chain
                        .iter()
                        .map(|b| b.label())
                        .collect::<Vec<_>>()
                        .join(", then ")
                ),
            }
        );
    }
    if let Some(notice) = session.load_report().summary() {
        // Loud rather than dim: a log that did not read back cleanly is the
        // one thing here the user may want to act on before typing.
        eprintln!("{DIM}warning: {notice}{RESET}");
    }
    if args.resume.is_some() || args.continue_ {
        print_recap(&session);
    }
    println!(
        "{DIM}/new starts a fresh session, /compact summarizes it in place, /quit exits{RESET}"
    );
    println!("{DIM}/context itemizes what the next request carries, /rewind undoes a turn{RESET}");
    println!("{DIM}/name renames the session for the listing{RESET}");

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
                match run_compact(&chat, &mut session).await {
                    Ok(true) => auto_dream(&args).await,
                    Ok(false) => {}
                    Err(e) => eprintln!("error: {e:#}"),
                }
                continue;
            }
            "/rewind" => {
                list_checkpoints(&session);
                continue;
            }
            "/context" => {
                show_context(&chat, &session);
                continue;
            }
            _ => {}
        }
        if let Some(arg) = line.strip_prefix("/name ") {
            rename(&mut session, arg.trim());
            continue;
        }
        if line == "/name" {
            match session.title() {
                Some(title) => println!("{DIM}“{title}” — /name <text> to change it{RESET}"),
                None => println!("{DIM}unnamed — /name <text> to name it{RESET}"),
            }
            continue;
        }
        if let Some(arg) = line.strip_prefix("/rewind ") {
            rewind_to(&mut session, arg.trim());
            continue;
        }
        if let Some(arg) = line.strip_prefix("/context drop ") {
            edit_context(&mut session, "drop", arg);
            continue;
        }
        if let Some(arg) = line.strip_prefix("/context keep ") {
            edit_context(&mut session, "keep", arg);
            continue;
        }
        println!();
        let was_named = session.title().is_some();
        let compacted = match run_turn(&chat, &mut session, &line).await {
            Ok(compacted) => compacted,
            Err(e) => {
                eprintln!("\nerror: {e:#}");
                false
            }
        };
        // Said once, when it happens: the name is what `nightloom sessions`
        // will list this conversation under, and a feature that spends a
        // provider call should say that it did.
        if !was_named && let Some(title) = session.title() {
            println!("{DIM}named “{title}”{RESET}");
        }
        if compacted {
            auto_dream(&args).await;
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
