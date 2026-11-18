//! A stand-in for the desktop around Claude's browser (nightshift item
//! 508), for checks that must not launch the app: it owns one chat's
//! browser exactly as the app does (`claude_browser::Browsers`, the pinned
//! helper, the per-chat socket) and doubles as the permission hook.
//!
//!   claude_browser_host <ask dir> <chat id>      the host
//!   claude_browser_host --permission-hook <dir>  the hook, as the app's binary is
//!
//! The host prints one JSON line — the socket, and the `--mcp-config` and
//! `--settings` a `claude -p` of this chat would be given — then one line
//! per browser event (frames counted, not printed), and takes commands on
//! stdin: `status`, `hold on|off`, `watch on|off`, `input <json>`,
//! `nav <action> [url]`, `frames`, `close`, `quit`.

#[cfg(unix)]
#[tokio::main]
async fn main() {
    use nightloom_service::agent::own_browser::{self, PlaywrightGate};
    use nightloom_service::claude_browser::{Browsers, Event};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::AsyncBufReadExt;

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--permission-hook") {
        if let Err(e) = nightloom_service::agent::ask::run_hook(&args[1..]) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    let (Some(ask_dir), Some(chat)) = (args.first().map(PathBuf::from), args.get(1)) else {
        eprintln!("usage: claude_browser_host <ask dir> <chat id>");
        std::process::exit(2);
    };
    let Some(install) = own_browser::locate() else {
        eprintln!("Playwright is not installed");
        std::process::exit(2);
    };
    let browsers = Arc::new(Browsers::new(nightloom_service::preview::short_socket_dir()));
    let frames = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&frames);
    browsers.set_on_event(Arc::new(move |chat, e| match e {
        Event::Frame { .. } => {
            counted.fetch_add(1, Ordering::Relaxed);
        }
        Event::Status(s) => println!(
            "{}",
            serde_json::json!({"event": "status", "chat": chat, "status": s})
        ),
        Event::Dialog { kind, message } => println!(
            "{}",
            serde_json::json!({"event": "dialog", "chat": chat, "kind": kind, "message": message})
        ),
    }));
    let socket = browsers
        .endpoint(chat, &ask_dir)
        .expect("the chat's socket");
    let out = std::env::temp_dir().join("nightloom-playwright-check");
    let exe = std::env::current_exe().expect("this binary");
    let gate = PlaywrightGate {
        hook: vec![
            exe.to_string_lossy().into_owned(),
            "--permission-hook".into(),
        ],
        dir: ask_dir.clone(),
        side: false,
        no_card: false,
    };
    println!(
        "{}",
        serde_json::json!({
            "socket": socket,
            "mcp_config": serde_json::json!({"mcpServers": {
                own_browser::SERVER_NAME: own_browser::server_entry_at(&install, &out, &socket)
            }}).to_string(),
            "settings": serde_json::json!({"hooks": {"PreToolUse": [gate.hook_entry()]}}).to_string(),
        })
    );
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        let (word, rest) = line.split_once(' ').unwrap_or((line, ""));
        let reply = match word {
            "status" => serde_json::json!({"status": browsers.status(chat)}),
            "hold" => match browsers.hold(chat, rest == "on").await {
                Ok(s) => serde_json::json!({"hold": s}),
                Err(e) => serde_json::json!({"error": e}),
            },
            "watch" => {
                browsers.watch(chat, rest == "on").await;
                serde_json::json!({"watch": rest == "on"})
            }
            "input" => match serde_json::from_str(rest) {
                Ok(v) => match browsers.input(chat, v).await {
                    Ok(()) => serde_json::json!({"input": "sent"}),
                    Err(e) => serde_json::json!({"error": e}),
                },
                Err(e) => serde_json::json!({"error": e.to_string()}),
            },
            "nav" => {
                let (action, url) = rest.split_once(' ').unwrap_or((rest, ""));
                match browsers
                    .nav(chat, action, Some(url).filter(|u| !u.is_empty()))
                    .await
                {
                    Ok(()) => serde_json::json!({"nav": action}),
                    Err(e) => serde_json::json!({"error": e}),
                }
            }
            "frames" => serde_json::json!({"frames": frames.load(Ordering::Relaxed)}),
            "close" => {
                browsers.close(chat).await;
                serde_json::json!({"closed": true})
            }
            "quit" => break,
            _ => serde_json::json!({"error": format!("unknown command {word:?}")}),
        };
        println!("{reply}");
    }
    browsers.shutdown_all();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Claude's browser runs on macOS and Linux only");
}
