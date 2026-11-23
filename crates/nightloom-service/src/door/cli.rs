//! `nightloom chat …` (and the desktop binary's `--chat …`): the door
//! from a terminal or a script. Parsed by hand, as `mcp_server::parse_args`
//! is, because the desktop binary has no clap.
//!
//! Exit codes are the script's signal: 0 done (with `--wait`: the reply is
//! there), 1 failed or refused, 2 the chat needs him (a permission, a
//! question, a plan, the usage limit), 3 still running when `--timeout`
//! ran out. A usage error is 1, never 2.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::client::{self, Waited};
use super::{ChatView, Listing, Request, Sent, stamp12};

/// The flag the desktop binary takes this under.
pub const DESKTOP_FLAG: &str = "--chat";
/// Who a start is marked with when `--as` names nobody.
pub const AS_ENV: &str = "NIGHTLOOM_DOOR_AS";
const DEFAULT_AS: &str = "the command line";
const DEFAULT_TIMEOUT_SECS: u64 = 30 * 60;

pub const USAGE: &str = "\
Start, message and read Nightloom chats from outside the app.

  chat list [<project>] [--limit N]         the chats, newest first
  chat show <id> [--last N | --all]         one chat: its state and last messages
  chat start <project> \"<prompt>\"           a new chat (its id is printed)
  chat send <id> \"<message>\"                a message into a chat

Flags:
  --wait          (show, start, send) wait until the chat stops, then print its reply
  --timeout <s>   how long --wait waits (default 1800)
  --json          machine-readable output
  --title <t>     (start) the chat's name; else the prompt's first line
  --read-only     (start) the chat may read but not change files
  --as <who>      (start) who the sidebar says started it (else $NIGHTLOOM_DOOR_AS)
  A prompt or message of - is read from standard input. An id may be its first few characters.

Exit: 0 done · 1 failed or refused · 2 the chat needs you · 3 still running at the timeout.
list and show always work. start and send work only while Nightloom (or `nightloom serve`)
is running and Settings → Outside control is set to \"Start and message\".";

/// What the arguments ask for.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub what: What,
    pub json: bool,
    pub wait: bool,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq)]
pub enum What {
    Help,
    List {
        project: Option<String>,
        limit: Option<usize>,
    },
    Show {
        chat: String,
        last: Option<usize>,
    },
    Start {
        project: String,
        text: String,
        title: Option<String>,
        read_only: bool,
        by: Option<String>,
    },
    Send {
        chat: String,
        text: String,
        by: Option<String>,
    },
}

pub fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut pos: Vec<String> = Vec::new();
    let (mut json, mut wait, mut read_only, mut all, mut help) =
        (false, false, false, false, false);
    let (mut limit, mut last, mut timeout) = (None, None, None);
    let (mut title, mut by) = (None, None);
    let mut it = args.iter();
    let mut flags = true;
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        let number = |name: &str, v: String| {
            v.parse::<u64>()
                .map_err(|_| format!("{name} takes a whole number, not {v:?}"))
        };
        match arg.as_str() {
            "--" if flags => flags = false,
            "--json" if flags => json = true,
            "--wait" if flags => wait = true,
            "--read-only" if flags => read_only = true,
            "--all" if flags => all = true,
            "--help" | "-h" if flags => help = true,
            "--limit" if flags => limit = Some(number("--limit", value("--limit")?)? as usize),
            "--last" if flags => last = Some(number("--last", value("--last")?)? as usize),
            "--timeout" if flags => timeout = Some(number("--timeout", value("--timeout")?)?),
            "--title" if flags => title = Some(value("--title")?),
            "--as" if flags => by = Some(value("--as")?),
            // `-` alone is "read standard input", not a flag.
            a if flags && a.starts_with("--") => {
                return Err(format!("unknown flag {a}"));
            }
            _ => pos.push(arg.clone()),
        }
    }
    let mut pos = pos.into_iter();
    let sub = pos.next();
    let mut need = |what: &str| pos.next().ok_or_else(|| format!("{what} is missing"));
    let what = match sub.as_deref() {
        None | Some("help") => What::Help,
        Some(_) if help => What::Help,
        Some("list") => What::List {
            project: pos.next(),
            limit,
        },
        Some("show") => What::Show {
            chat: need("the chat's id")?,
            last: if all { Some(usize::MAX) } else { last },
        },
        Some("start") => What::Start {
            project: need("the project")?,
            text: need("the prompt")?,
            title,
            read_only,
            by,
        },
        Some("send") => What::Send {
            chat: need("the chat's id")?,
            text: need("the message")?,
            by,
        },
        Some(other) => {
            return Err(format!(
                "unknown command {other:?}: the commands are list, show, start and send"
            ));
        }
    };
    if let Some(extra) = pos.next() {
        return Err(format!(
            "unexpected argument {extra:?} — put a prompt with spaces in quotes"
        ));
    }
    Ok(Parsed {
        what,
        json,
        wait,
        timeout: Duration::from_secs(timeout.unwrap_or(DEFAULT_TIMEOUT_SECS)),
    })
}

/// What a run prints and how it exits. Kept apart from the printing so a
/// test reads it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    fn fail(e: impl Into<String>) -> Self {
        Self {
            stderr: e.into(),
            code: 1,
            ..Self::default()
        }
    }
}

/// The listing as a terminal reads it.
pub fn render_list(l: &Listing) -> String {
    if l.chats.is_empty() {
        return "no chats".into();
    }
    let mut out = String::new();
    for c in &l.chats {
        let by = c
            .started_by
            .as_ref()
            .map(|b| format!("  [started by {b}]"))
            .unwrap_or_default();
        out.push_str(&format!(
            "{}  {:<14}  {}  {}  {}{}\n",
            c.id,
            if c.state == super::State::Idle {
                c.kind.as_str()
            } else {
                c.state.word()
            },
            stamp12(&c.modified),
            c.project.as_deref().unwrap_or("Unfiled"),
            c.title,
            by
        ));
    }
    if l.total > l.chats.len() {
        out.push_str(&format!(
            "… {} of {} shown (--limit N for more)\n",
            l.chats.len(),
            l.total
        ));
    }
    out.push_str(match (l.holder.is_some(), l.writes) {
        (false, _) => "Nightloom is not running: every chat is idle; start and send need it open.",
        (true, false) => {
            "Read only: start and send are off (Nightloom's Settings → Outside control)."
        }
        (true, true) => "start and send are on.",
    });
    out
}

/// One chat as a terminal reads it.
pub fn render_view(v: &ChatView) -> String {
    let c = &v.line;
    let mut out = format!(
        "{} — {} — {}\n{}{}{}\n",
        if c.title.is_empty() {
            "(no name)"
        } else {
            &c.title
        },
        c.project.as_deref().unwrap_or("Unfiled"),
        c.id,
        c.state.word(),
        c.needs
            .as_ref()
            .map(|n| format!(": {n}"))
            .unwrap_or_default(),
        c.started_by
            .as_ref()
            .map(|b| format!(" · started from outside by {b}"))
            .unwrap_or_default(),
    );
    if v.messages_total > v.messages.len() {
        out.push_str(&format!(
            "(the last {} of {} messages; --all for every one)\n",
            v.messages.len(),
            v.messages_total
        ));
    }
    for m in &v.messages {
        out.push_str(&format!(
            "\n{} ({}):\n{}\n",
            if m.who == "user" { "you" } else { "assistant" },
            stamp12(&m.at),
            m.text.trim_end()
        ));
    }
    out.trim_end().to_string()
}

fn outcome_word(w: &Waited) -> &'static str {
    match w {
        Waited::Replied(_) => "replied",
        Waited::Failed(_) => "failed",
        Waited::NeedsHim(_) => "needs_you",
        Waited::StillRunning(_) => "still_running",
    }
}

/// A wait's end as output: the reply on stdout (`whole`: the chat as
/// `show` prints it), anything else said on stderr.
fn waited(chat: &str, w: Waited, json_out: bool, whole: bool) -> Output {
    let code = w.exit_code();
    if json_out {
        let v = match &w {
            Waited::Failed(e) => json!({ "chat": chat, "outcome": "failed", "error": e }),
            Waited::Replied(v) | Waited::NeedsHim(v) | Waited::StillRunning(v) => json!({
                "chat": chat,
                "outcome": outcome_word(&w),
                "reply": v.last_reply().map(|m| m.text.clone()),
                "view": v,
            }),
        };
        return Output {
            stdout: v.to_string(),
            stderr: String::new(),
            code,
        };
    }
    let body = |v: &ChatView| {
        if whole {
            render_view(v)
        } else {
            v.last_reply()
                .map(|m| m.text.trim_end().to_string())
                .unwrap_or_default()
        }
    };
    match w {
        Waited::Replied(v) => Output {
            stdout: body(&v),
            stderr: String::new(),
            code,
        },
        Waited::Failed(e) => Output {
            stderr: e,
            code,
            ..Output::default()
        },
        Waited::NeedsHim(v) => Output {
            stdout: if whole {
                render_view(&v)
            } else {
                String::new()
            },
            stderr: format!(
                "the chat needs you: {} — then: chat show {} --wait",
                v.line.needs.as_deref().unwrap_or("answer it in Nightloom"),
                v.line.id
            ),
            code,
        },
        Waited::StillRunning(v) => Output {
            stdout: if whole {
                render_view(&v)
            } else {
                String::new()
            },
            stderr: format!(
                "still running at the timeout — pick it up with: chat show {} --wait",
                v.line.id
            ),
            code,
        },
    }
}

fn who(by: Option<String>) -> String {
    by.or_else(|| std::env::var(AS_ENV).ok())
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_AS.into())
}

fn text_of(text: String) -> Result<String, String> {
    if text != "-" {
        return Ok(text);
    }
    let mut all = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut all)
        .map_err(|e| format!("standard input could not be read: {e}"))?;
    Ok(all)
}

/// Run one command against the home at `config`.
pub async fn run(config: &Path, args: &[String]) -> Output {
    let p = match parse(args) {
        Ok(p) => p,
        Err(e) => return Output::fail(format!("{e}\n\n{USAGE}")),
    };
    match exec(config, p).await {
        Ok(out) => out,
        Err(e) => Output::fail(e),
    }
}

async fn exec(config: &Path, p: Parsed) -> Result<Output, String> {
    let ok = |stdout: String| Output {
        stdout,
        ..Output::default()
    };
    match p.what {
        What::Help => Ok(ok(USAGE.into())),
        What::List { project, limit } => {
            let l: Listing = client::ask_as(config, &Request::List { project, limit }).await?;
            Ok(ok(if p.json {
                serde_json::to_string(&l).map_err(|e| e.to_string())?
            } else {
                render_list(&l)
            }))
        }
        What::Show { chat, last } => {
            let v: ChatView = client::ask_as(config, &Request::Show { chat, last }).await?;
            if p.wait {
                let id = v.line.id.clone();
                let w = client::wait(config, &id, None, p.timeout, last).await;
                return Ok(waited(&id, w, p.json, true));
            }
            Ok(ok(if p.json {
                serde_json::to_string(&v).map_err(|e| e.to_string())?
            } else {
                render_view(&v)
            }))
        }
        What::Start {
            project,
            text,
            title,
            read_only,
            by,
        } => {
            let sent: Sent = client::ask_as(
                config,
                &Request::Start {
                    project,
                    text: text_of(text)?,
                    title,
                    read_only,
                    by: who(by),
                },
            )
            .await?;
            after_send(config, sent, &p_flags(p.json, p.wait, p.timeout), true).await
        }
        What::Send { chat, text, by } => {
            let text = text_of(text)?;
            let by = who(by);
            let send = Request::Send {
                chat: chat.clone(),
                text,
                by,
            };
            let sent: Sent = match client::ask_as(config, &send).await {
                // A send never interrupts: with --wait, the running turn
                // is waited out first, then the message goes.
                Err(e) if e == super::RUNNING && p.wait => {
                    let v: ChatView = client::ask_as(
                        config,
                        &Request::Show {
                            chat,
                            last: Some(1),
                        },
                    )
                    .await?;
                    let id = v.line.id.clone();
                    match client::wait(config, &id, None, p.timeout, Some(1)).await {
                        Waited::Replied(_) => client::ask_as(config, &send).await?,
                        other => return Ok(waited(&id, other, p.json, false)),
                    }
                }
                other => other?,
            };
            after_send(config, sent, &p_flags(p.json, p.wait, p.timeout), false).await
        }
    }
}

struct Flags {
    json: bool,
    wait: bool,
    timeout: Duration,
}

fn p_flags(json: bool, wait: bool, timeout: Duration) -> Flags {
    Flags {
        json,
        wait,
        timeout,
    }
}

async fn after_send(config: &Path, sent: Sent, f: &Flags, started: bool) -> Result<Output, String> {
    if f.wait {
        let w = client::wait(config, &sent.chat, Some(sent.replies), f.timeout, Some(1)).await;
        let mut out = waited(&sent.chat, w, f.json, false);
        if !f.json && started {
            // The id is the one thing a failed wait must not lose.
            out.stderr = format!("chat {}\n{}", sent.chat, out.stderr)
                .trim_end()
                .to_string();
        }
        return Ok(out);
    }
    if f.json {
        let v: Value = json!({ "chat": sent.chat, "project": sent.project, "outcome": "sent" });
        return Ok(Output {
            stdout: v.to_string(),
            ..Output::default()
        });
    }
    Ok(Output {
        stdout: sent.chat.clone(),
        stderr: format!(
            "{} — read the reply with: chat show {} --wait",
            if started {
                format!(
                    "started in {}",
                    sent.project.as_deref().unwrap_or("the unfiled chats")
                )
            } else {
                "sent".to_string()
            },
            sent.chat
        ),
        code: 0,
    })
}

/// Print `out` and give its exit code.
pub fn finish(out: Output) -> i32 {
    if !out.stdout.is_empty() {
        println!("{}", out.stdout);
    }
    if !out.stderr.is_empty() {
        eprintln!("{}", out.stderr);
    }
    out.code
}

/// The whole command on a runtime of its own, for a binary whose `main`
/// has none (the desktop's). The exit code.
pub fn run_blocking(args: &[String]) -> i32 {
    let Some(config) = crate::project::config_dir() else {
        eprintln!("no Nightloom home — set HOME or NIGHTLOOM_HOME");
        return 1;
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    finish(runtime.block_on(run(&config, args)))
}
