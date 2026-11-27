//! A card's action (nightshift item 993d), as the window's one command:
//! his click in an event's or an email's card runs one connector call in
//! its own throwaway Haiku process (`nightloom_service::ref_action`).
//!
//! **This file is the only caller of `ref_action::mint`**, from two
//! places, each his own press: the window's card confirm button
//! (`refAct.ts`, the `ref_act` command) and, since item 993f, the phone's
//! sheet — through the listener's `/home/ref/act`, which runs only a call
//! a tap of his on the phone was minted for (`nightloom_service::ref_gate`)
//! and reaches [`run_act`] through the Mac's `Host::ref_act`. No tool of
//! Nightloom's server and no message into a chat reaches either: a model
//! cannot start an action (blocker 2304).

use crate::power;
use nightloom_service::home::reach::{self, Status};
use nightloom_service::ref_action::{self, Act, Call, Heads, Item, Receipt, Seen, Unfinished};
use nightloom_service::ref_gate;
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

/// Run his click in the window. `Err` is a click that could not start
/// (nothing was sent); a call that started and failed is a [`Receipt`]
/// saying how. The one gate shared with the phone (993f) goes first: no
/// send while the phone holds a mail for this item or one is going, and
/// none while the "may have gone" lock either screen set stands.
#[tauri::command]
pub(crate) async fn ref_act(
    power: State<'_, power::Holder>,
    item: Item,
    act: Act,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<Receipt, String> {
    let call = ref_action::call_for(&item, &act)?;
    let key = ref_action::item_key(&item);
    let config = project::config_dir();
    let mail = ref_gate::is_mail(&call);
    if mail && let Some(why) = config.as_ref().and_then(|c| ref_gate::maybe_of(c, &key)) {
        return Err(format!("it may have gone already: {why}"));
    }
    if call.sends {
        ref_gate::with(|g| g.begin_here(&key, chrono::Utc::now()))?;
    }
    let out = run_act(&power, item, act, binary, safe_mode).await;
    if call.sends {
        let done = matches!(&out, Ok(r) if r.outcome == "done");
        ref_gate::with(|g| g.end(&key, done, chrono::Utc::now()));
        if let (Ok(r), Some(c)) = (&out, &config)
            && r.outcome == "unknown"
            && mail
        {
            ref_gate::maybe_mark(c, &key, &r.text);
        }
    }
    out
}

/// One action, from either screen, once his press let it through: the
/// journal, the pinned call in its own process, the receipt.
pub(crate) async fn run_act(
    power: &power::Holder,
    item: Item,
    act: Act,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<Receipt, String> {
    let call = ref_action::call_for(&item, &act)?;
    // A mail on its way is written down first: a quit mid-call leaves this
    // entry, and the next launch says it may have gone (993e review, 7). It
    // is this send's own: only its end below removes it (re-review, N5).
    let journal = if call.sends {
        let (what, mail) = ref_action::going_words(&act);
        let entry = Unfinished {
            key: ref_action::item_key(&item),
            what,
            item: item.name.clone(),
            mail,
        };
        journal_dir()
            .and_then(|d| ref_action::journal_begin(&d, launch(), &entry, chrono::Utc::now()).ok())
    } else {
        None
    };
    let out = run_call(power, &item, &call, binary, safe_mode).await;
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
        ref_action::journal_end(path);
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
    read_heads(&power, item, binary, safe_mode).await
}

/// [`ref_read`]'s work, for the window and the phone's sheet (993f).
pub(crate) async fn read_heads(
    power: &power::Holder,
    item: Item,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<Heads, String> {
    let call = ref_action::read_call(&item)?;
    let (ran, seen, dir) = run_call(power, &item, &call, binary, safe_mode).await?;
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

/// This run of the app, as the journal names it: the pid and when the
/// first entry was asked for (a later run with a reused pid differs).
fn launch() -> &'static str {
    static LAUNCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LAUNCH.get_or_init(|| {
        format!(
            "{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        )
    })
}

/// The mails that were on their way when Nightloom last quit or died
/// (their journal entries outlived the call): read once and cleared, for
/// the window to say they may have gone (993e review, finding 7). This
/// run's own entries stay: their sends are still going (re-review, N5).
#[tauri::command]
pub(crate) fn ref_unfinished() -> Vec<Unfinished> {
    let left: Vec<Unfinished> = journal_dir()
        .map(|d| ref_action::journal_take(&d, launch()))
        .unwrap_or_default();
    // The phone's sheet shows the same lock (993f).
    if let Some(c) = project::config_dir() {
        for u in left.iter().filter(|u| u.mail && !u.key.is_empty()) {
            ref_gate::maybe_mark(
                &c,
                &u.key,
                &format!(
                    "Nightloom quit while {} was going. It may have gone: check Sent in Gmail before sending again.",
                    u.what
                ),
            );
        }
    }
    left
}

/// The "may have gone" lock of an item as the Mac keeps it for both
/// screens (993f): set by an unknown outcome on either, cleared by "I
/// checked: not sent" on either.
#[tauri::command]
pub(crate) fn ref_lock(key: String, mark: Option<String>) -> Option<String> {
    let config = project::config_dir()?;
    if let Some(why) = mark.as_deref().filter(|w| !w.is_empty()) {
        ref_gate::maybe_mark(&config, &key, why);
    }
    ref_gate::maybe_of(&config, &key)
}

/// He checked Gmail's Sent (on the Mac's card): the lock goes for both screens.
#[tauri::command]
pub(crate) fn ref_checked(key: String) {
    if let Some(c) = project::config_dir() {
        ref_gate::maybe_clear(&c, &key);
    }
}
