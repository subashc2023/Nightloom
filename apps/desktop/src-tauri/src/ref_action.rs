//! A card's action (nightshift item 993d), as the window's one command:
//! his click in an event's or an email's card runs one connector call in
//! its own throwaway Haiku process (`nightloom_service::ref_action`).
//!
//! **This command is the only caller of `ref_action::mint`**, and the
//! window calls it only from a card's confirm button (`refAct.ts`). No
//! tool of Nightloom's server, no listener route and no message into a
//! chat reaches it: a model cannot start an action (blocker 2304).

use crate::power;
use nightloom_service::home::reach::{self, Status};
use nightloom_service::ref_action::{self, Act, Call, Heads, Item, Receipt, Seen};
use nightloom_service::{ClaudeCodeAgent, PassSpec, TurnEvent, project};
use tauri::State;
use tokio_util::sync::CancellationToken;

/// One pinned call in its own process: the account checks, the pass, the
/// turn, the deadline. Returns what the turn saw of the call and the
/// action's folder (still on disk, for the caller to read the pass's state
/// and remove). `Err`: it could not start, nothing ran.
async fn run_call(
    power: &power::Holder,
    item: &Item,
    call: &Call,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<(Result<(), String>, Vec<Seen>, std::path::PathBuf), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    // The account must be one Home reaches and he left on: the last check's
    // own row, never the link's word for it.
    let accounts = reach::accounts(&config);
    let account = accounts
        .iter()
        .find(|a| a.connector == item.src && a.claude_ai)
        .ok_or("this link's account is not one Home reaches")?;
    if !account.on {
        return Err("that account is turned off for Home".into());
    }
    if account.status != Status::Connected {
        return Err("that account is signed out or did not answer the last check".into());
    }
    // Safe mode leaves his connectors out of the process: refused before a
    // pass exists, so nothing can run (993d review).
    ref_action::refuse_under_safe_mode(safe_mode.unwrap_or(false))?;
    let exe =
        std::env::current_exe().map_err(|e| format!("could not find Nightloom itself: {e}"))?;
    // The action's own fresh folder: one click, one pass, gone afterwards.
    static CLICKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = config.join("ref-actions").join(format!(
        "{}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        CLICKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let scratch = std::env::temp_dir().join("nightloom-ref-action");
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not make the action's scratch folder: {e}"))?;
    let pass = PassSpec::new(
        binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "claude".into()),
        Vec::new(),
    );
    // Every other connector is left out of this process's tool list.
    let blocked = accounts
        .iter()
        .filter(|a| a.claude_ai && a.connector != item.src)
        .map(|a| a.connector.clone())
        .collect();
    let spec = ref_action::spec_for(
        &pass,
        &scratch,
        vec![
            exe.to_string_lossy().into_owned(),
            "--permission-hook".into(),
        ],
        &dir,
        blocked,
    );
    ref_action::mint(&dir, call, chrono::Utc::now())?;
    let _awake = power.acquire();
    let cancel = CancellationToken::new();
    // Stopped once the pass can no longer let anything through (993d review).
    let deadline = ref_action::stop_at_deadline(&cancel);
    let mut seen: Vec<Seen> = Vec::new();
    let tool = call.tool.clone();
    let ran = ClaudeCodeAgent::new(spec)
        .run_turn(
            ref_action::message(call).as_str(),
            &cancel,
            &mut |event| match event {
                TurnEvent::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } if name == tool => seen.push(Seen::of_result(&content, is_error)),
                TurnEvent::ToolDenied { name, reason, .. } if name == tool => {
                    seen.push(Seen::Denied { reason });
                }
                _ => {}
            },
        )
        .await;
    deadline.abort();
    Ok((ran.map(|_| ()).map_err(|e| e.to_string()), seen, dir))
}

/// Run his click. `Err` is a click that could not start (nothing was
/// sent); a call that started and failed is a [`Receipt`] saying how.
#[tauri::command]
pub(crate) async fn ref_act(
    power: State<'_, power::Holder>,
    item: Item,
    act: Act,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<Receipt, String> {
    let call = ref_action::call_for(&item, &act)?;
    // A mail on its way is written down first: a quit mid-call leaves this
    // file, and the next launch says it may have gone (993e review, 7).
    let journal = journal_dir().map(|d| {
        d.join(format!(
            "{}-{}.json",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    });
    if call.sends
        && let Some(path) = &journal
    {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(path));
        let line = ref_action::receipt(
            &act,
            &[Seen::Result {
                content: String::new(),
                is_error: false,
            }],
            true,
        )
        .text;
        let _ = std::fs::write(
            path,
            serde_json::json!({ "what": line, "item": item.name, "at": chrono::Utc::now() })
                .to_string(),
        );
    }
    let out = run_call(&power, &item, &call, binary, safe_mode).await;
    let done = match out {
        Err(e) => Err(e),
        Ok((ran, seen, dir)) => {
            let receipt = ref_action::settle(&act, &seen, &dir);
            let spent = ref_action::spent(&dir);
            let _ = std::fs::remove_dir_all(&dir);
            match ran {
                Ok(()) => Ok(receipt),
                // The process failed: what is known is whether the call was let through.
                Err(_) if spent || !seen.is_empty() => Ok(receipt),
                Err(e) => Err(format!(
                    "the action could not start, so nothing was sent: {e}"
                )),
            }
        }
    };
    if let Some(path) = &journal {
        let _ = std::fs::remove_file(path);
    }
    done
}

/// Read an email's own headers (993e review, finding 1): who it is from,
/// to and cc, and its subject — what a reply's confirm shows and pins.
/// One read-only `get_message` call, run like an action.
#[tauri::command]
pub(crate) async fn ref_read(
    power: State<'_, power::Holder>,
    item: Item,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<Heads, String> {
    let call = ref_action::read_call(&item)?;
    let (ran, seen, dir) = run_call(&power, &item, &call, binary, safe_mode).await?;
    let _ = std::fs::remove_dir_all(&dir);
    let answer = seen.iter().rev().find_map(|s| match s {
        Seen::Result { content, is_error } => Some((content, *is_error)),
        Seen::Denied { .. } => None,
    });
    match answer {
        Some((content, false)) => ref_action::heads_of(content),
        Some((content, true)) => Err(format!(
            "the connector said: {}",
            content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(200)
                .collect::<String>()
        )),
        None => Err(match ran {
            Err(e) => format!("the message could not be read: {e}"),
            Ok(()) => "the message could not be read (no answer came back)".into(),
        }),
    }
}

fn journal_dir() -> Option<std::path::PathBuf> {
    project::config_dir().map(|c| c.join("ref-actions").join("going"))
}

/// The mails that were on their way when Nightloom last quit or died
/// (their journal entries outlived the call): read once and cleared, for
/// the window to say they may have gone (993e review, finding 7).
#[tauri::command]
pub(crate) fn ref_unfinished() -> Vec<String> {
    let Some(dir) = journal_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = e.path();
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
        {
            let what = v["what"].as_str().unwrap_or("A mail");
            let item = v["item"].as_str().unwrap_or("");
            out.push(if item.is_empty() {
                what.to_string()
            } else {
                format!("{what} · {item}")
            });
        }
        let _ = std::fs::remove_file(&path);
    }
    out
}
