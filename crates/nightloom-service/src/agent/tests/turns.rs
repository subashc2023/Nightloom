use super::*;

/// A stand-in CLI for the stop path: announces a call, then parks. On
/// SIGINT it does what 2.1.263 did (`m074-4-sigint-tool.jsonl`): the
/// call's error result, the interrupt line, a `result` with
/// `aborted_tools`, exit 0. `sleep … & wait` rather than a foreground
/// sleep so the trap runs at once.
#[cfg(unix)]
fn stand_in(dir: &std::path::Path, body: &str) -> String {
    let path = dir.join("claude-stand-in");
    std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// Backlog 374: a deferred call's resume runs on the stdin shape with
/// the chat's inbox, so a message he sends while it runs — while its
/// subagents run, in his case — is written to the CLI and taken, rather
/// than held for the end of the last subagent. The stand-in records its
/// argv, waits for his line, and says it started it.
#[cfg(unix)]
#[tokio::test]
async fn a_deferred_resume_takes_a_message_he_sends_while_it_runs() {
    let dir = std::env::temp_dir().join(format!("nightloom-374-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let argv = dir.join("argv");
    let body = format!(
        r##"printf '%s\n' "$@" > '{argv}'
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-374"}}'
read -r line
id=$(printf '%s' "$line" | sed 's/.*"uuid":"\([^"]*\)".*/\1/')
printf '%s\n' "{{\"type\":\"command_lifecycle\",\"command_uuid\":\"$id\",\"state\":\"started\"}}"
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"s-374","stop_reason":"end_turn","usage":{{"input_tokens":1,"output_tokens":1}}}}'
cat >/dev/null
"##,
        argv = argv.display()
    );
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, &body);
    s.resume = Some("s-374".into());
    let agent = ClaudeCodeAgent::new(s);
    let inbox = agent.inbox();
    let id = uuid::Uuid::new_v4().to_string();
    let call = ask::DeferredCall {
        id: "toolu_d".into(),
        name: "Bash".into(),
        input: serde_json::json!({}),
    };
    let cancel = CancellationToken::new();
    let mut delivered = Vec::new();
    {
        let mut on_event = |e| match e {
            TurnEvent::AgentInit { .. } => inbox.send(&id, "while it runs").unwrap(),
            TurnEvent::MessageDelivered { id, .. } => delivered.push(id),
            _ => {}
        };
        let run = agent.resume_deferred(&call, &cancel, &mut on_event);
        tokio::time::timeout(std::time::Duration::from_secs(10), run)
            .await
            .expect("the stand-in ended on the EOF after its result")
            .unwrap();
    }
    assert_eq!(delivered, vec![id.clone()]);
    let args = std::fs::read_to_string(&argv).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert!(
        args.windows(2)
            .any(|w| w == ["--input-format", "stream-json"]),
        "{args:?}"
    );
    assert!(
        args.windows(2).any(|w| w == ["--resume", "s-374"]),
        "{args:?}"
    );
    assert!(!inbox.is_open(), "closed at the result");
}

/// Item 732's stand-in: records its argv and the one stdin line (empty
/// when stdin is null), prints an init and a result, then reads stdin
/// to its EOF — so a process whose stdin is never closed hangs, and the
/// caller's timeout says so. Returns `(argv, stdin line)`.
#[cfg(unix)]
async fn shape_of_732<F, Fut>(resume: Option<&str>, run: F) -> (Vec<String>, String)
where
    F: FnOnce(AgentSpec) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let dir = std::env::temp_dir().join(format!("nightloom-732-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (argv, stdin) = (dir.join("argv"), dir.join("stdin"));
    let body = format!(
        r##"printf '%s\n' "$@" > '{argv}'
line=''
read -r line
printf '%s' "$line" > '{stdin}'
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"dontAsk","session_id":"s-732"}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"s-732","stop_reason":"end_turn","usage":{{"input_tokens":1,"output_tokens":1}}}}'
cat >/dev/null
exit 0
"##,
        argv = argv.display(),
        stdin = stdin.display()
    );
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, &body);
    s.resume = resume.map(str::to_string);
    tokio::time::timeout(std::time::Duration::from_secs(10), run(s))
        .await
        .expect("the process ended after its one reply");
    let args = std::fs::read_to_string(&argv).unwrap();
    let line = std::fs::read_to_string(&stdin).unwrap_or_default();
    (args.lines().map(str::to_string).collect(), line)
}

#[cfg(unix)]
fn on_stdin_732(args: &[String], line: &str, text: &str) {
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--input-format" && w[1] == "stream-json"),
        "{args:?}"
    );
    assert!(!args.iter().any(|a| a == text), "prompt on argv: {args:?}");
    assert!(line.contains("\"type\":\"user\""), "{line}");
    assert!(line.contains(&text[..20.min(text.len())]), "{line}");
}

/// Item 732: an aside on a chat with a session sends its question on
/// stdin, as the chat's turn does (725's capture: the argv shape words
/// the Bash tool differently and misses the chat's cache), and still
/// ends after its one reply.
#[cfg(unix)]
#[tokio::test]
async fn an_aside_sends_its_question_on_stdin_like_a_turn() {
    let text = "what did we decide about the bar";
    let (args, line) = shape_of_732(Some("s-732"), |s| async move {
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        let out = agent
            .ask_aside(text.into(), None, None, None, &cancel, &mut |_| {})
            .await
            .expect("a session to ask beside")
            .unwrap();
        assert!(out.result_seen);
    })
    .await;
    on_stdin_732(&args, &line, text);
    assert!(args.iter().any(|a| a == "--fork-session"), "{args:?}");
}

/// Item 732: a keep-warm ping goes on stdin too, held to one round.
#[cfg(unix)]
#[tokio::test]
async fn a_keep_warm_ping_sends_its_prompt_on_stdin_like_a_turn() {
    let (args, line) = shape_of_732(Some("s-732"), |s| async move {
        let cancel = CancellationToken::new();
        let out = crate::keep_warm::ping(&s, &cancel).await.unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
    })
    .await;
    on_stdin_732(&args, &line, crate::keep_warm::PING_PROMPT);
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--max-turns" && w[1] == "1"),
        "{args:?}"
    );
}

/// Item 732: a council seat forked from the chat's session goes on
/// stdin too.
#[cfg(unix)]
#[tokio::test]
async fn a_forked_council_seat_sends_its_prompt_on_stdin_like_a_turn() {
    let text = "seat prompt: weigh the two designs";
    let (args, line) = shape_of_732(Some("s-732"), |s| async move {
        let seat = crate::council::seat_spec(&s, &crate::council::Seat::subscription("opus"));
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        let out = agent
            .run_with(&seat, text, &cancel, &mut |_| {})
            .await
            .unwrap();
        assert!(out.result_seen);
    })
    .await;
    on_stdin_732(&args, &line, text);
    assert!(args.iter().any(|a| a == "--fork-session"), "{args:?}");
}

/// Item 732: the chat's own turn keeps the stdin shape it had.
#[cfg(unix)]
#[tokio::test]
async fn the_chat_turn_still_sends_its_text_on_stdin() {
    let text = "the chat's own turn text";
    let (args, line) = shape_of_732(Some("s-732"), |s| async move {
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        agent.run_turn(text, &cancel, &mut |_| {}).await.unwrap();
    })
    .await;
    on_stdin_732(&args, &line, text);
    assert!(!args.iter().any(|a| a == "--fork-session"), "{args:?}");
}

/// Item 732: a one-shot with no session to share a cache with keeps the
/// prompt on argv and a null stdin, and a slash command on a side
/// process stays on argv (`warm::suits_stdin`), as before.
#[cfg(unix)]
#[tokio::test]
async fn a_session_less_one_shot_and_a_slash_command_keep_argv() {
    let text = "one-shot with no session";
    let (args, line) = shape_of_732(None, |s| async move {
        let agent = ClaudeCodeAgent::new(s.clone());
        let cancel = CancellationToken::new();
        agent
            .run_with(&s, text, &cancel, &mut |_| {})
            .await
            .unwrap();
    })
    .await;
    assert_eq!(args.get(1).map(String::as_str), Some(text), "{args:?}");
    assert!(!args.iter().any(|a| a == "--input-format"), "{args:?}");
    assert!(line.is_empty(), "{line}");

    let slash = "/context";
    let (args, line) = shape_of_732(Some("s-732"), |s| async move {
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        agent
            .ask_aside(slash.into(), None, None, None, &cancel, &mut |_| {})
            .await
            .unwrap()
            .unwrap();
    })
    .await;
    assert_eq!(args.get(1).map(String::as_str), Some(slash), "{args:?}");
    assert!(!args.iter().any(|a| a == "--input-format"), "{args:?}");
    assert!(line.is_empty(), "{line}");
}

/// 374 review: a deferred resume of a session that holds no deferred
/// call prints nothing and waits on stdin (measured, M3). The stand-in
/// does the same — reads stdin to its EOF, prints nothing, exits 0 — and
/// the resume must end on its own once the silence runs out, not hang.
#[cfg(unix)]
#[tokio::test]
async fn a_silent_deferred_resume_ends_instead_of_waiting_on_stdin() {
    let dir = std::env::temp_dir().join(format!("nightloom-374s-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, "cat >/dev/null\n");
    s.resume = Some("s-none".into());
    let mut agent = ClaudeCodeAgent::new(s);
    agent.silent_resume = Duration::from_millis(300);
    let call = ask::DeferredCall {
        id: "toolu_gone".into(),
        name: "Bash".into(),
        input: serde_json::json!({}),
    };
    let cancel = CancellationToken::new();
    let mut on_event = |_e: TurnEvent| {};
    let run = agent.resume_deferred(&call, &cancel, &mut on_event);
    let ended = tokio::time::timeout(Duration::from_secs(10), run).await;
    assert!(ended.is_ok(), "the resume hung on stdin");
    assert!(!agent.inbox().is_open());
}

#[cfg(unix)]
const ENDS_ON_INTERRUPT: &str = r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":["Bash"],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","session_id":"stop-1"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_stop","name":"Bash","input":{"command":"python3 -c ..."}}]},"parent_tool_use_id":null}'
trap 'kill $child 2>/dev/null
printf "%s\n" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"The user doesn'"'"'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\",\"is_error\":true,\"tool_use_id\":\"toolu_stop\"}]},\"parent_tool_use_id\":null}"
printf "%s\n" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]},\"parent_tool_use_id\":null}"
printf "%s\n" "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"terminal_reason\":\"aborted_tools\",\"num_turns\":3,\"session_id\":\"stop-1\",\"stop_reason\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}"
exit 0' INT
sleep 30 >/dev/null 2>&1 & child=$!
wait
"##;

/// Stop sends the interrupt first and takes what the CLI writes on
/// its way out: the open call is closed by the CLI's own error result
/// (not the recorder's orphan marker), the session id is on the
/// outcome, the notice says the CLI ended the turn, and the CLI's
/// `is_error: true` on that result is not a failed turn.
#[cfg(unix)]
#[tokio::test]
async fn stop_interrupts_first_and_keeps_what_the_cli_writes_on_the_way_out() {
    let dir = std::env::temp_dir().join(format!("nightloom-stop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, ENDS_ON_INTERRUPT);
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut events = Vec::new();
    let started = std::time::Instant::now();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if matches!(e, TurnEvent::ToolCall { .. }) {
                trigger.cancel();
            }
            events.push(e);
        })
        .await
        .unwrap();
    assert!(
        started.elapsed() < INTERRUPT_GRACE,
        "the CLI ended the turn; nothing waited for the kill"
    );
    let result = events.iter().find_map(|e| match e {
        TurnEvent::ToolResult {
            tool_use_id,
            is_error,
            content,
            ..
        } if tool_use_id == "toolu_stop" => Some((*is_error, content.clone())),
        _ => None,
    });
    let (is_error, content) = result.expect("the call's result came from the CLI");
    assert!(is_error);
    assert!(content.contains("doesn't want to proceed"), "{content}");
    assert_eq!(outcome.session_id.as_deref(), Some("stop-1"));
    assert!(!outcome.is_error, "a stop is not a failed turn");
    assert_eq!(
        outcome.notices,
        vec!["interrupted — Claude Code ended the turn".to_string()],
        "one notice, one toast"
    );
}

/// Items 440 + 441: a CLI with no connection — it retries the call,
/// one `api_retry` line per try with `error: "unknown"` and no status
/// (CLI 2.1.312's shape) — until Stop, then closes the turn as an
/// interrupt does mid-stream (`aborted_streaming`).
#[cfg(unix)]
const RETRIES_UNTIL_INTERRUPT: &str = r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-opus-4-5","permissionMode":"default","session_id":"offline-1"}'
trap 'printf "%s\n" "{\"type\":\"system\",\"subtype\":\"api_retry\",\"attempt\":3,\"max_retries\":10,\"retry_delay_ms\":2000,\"error_status\":null,\"error\":\"unknown\"}"
printf "%s\n" "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"terminal_reason\":\"aborted_streaming\",\"num_turns\":1,\"session_id\":\"offline-1\",\"stop_reason\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}"
exit 0' INT
n=1
while [ $n -le 2 ]; do
  printf '{"type":"system","subtype":"api_retry","attempt":%d,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown"}\n' $n
  n=$((n+1))
done
sleep 30 >/dev/null 2>&1 & child=$!
wait
"##;

/// Items 440 + 441: every try reaches the shell live as a `Retry` (one
/// status line there), and a Stop pressed during them ends with the one
/// stop notice — no "retrying after unknown (n/10)" notices, which the
/// shell toasted as a stack at the turn's end. (The shell drops that
/// one stop notice too when he pressed Stop himself: `turnNotices`.)
#[cfg(unix)]
#[tokio::test]
async fn stop_during_offline_retries_leaves_one_notice_and_live_retries() {
    let dir = std::env::temp_dir().join(format!("nightloom-441-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, RETRIES_UNTIL_INTERRUPT);
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut tries = Vec::new();
    let outcome = agent
        .run_turn("hi", &cancel, &mut |e| {
            if let TurnEvent::Retry {
                attempt,
                error,
                status,
                ..
            } = e
            {
                tries.push((attempt, error, status));
                if attempt == 2 {
                    trigger.cancel();
                }
            }
        })
        .await
        .unwrap();
    assert_eq!(
        tries,
        vec![
            (1, Some("unknown".to_string()), None),
            (2, Some("unknown".to_string()), None),
            (3, Some("unknown".to_string()), None),
        ],
        "each try live, the one the CLI wrote on its way out too"
    );
    assert!(!outcome.is_error, "a stop is not a failed turn");
    assert_eq!(
        outcome.notices,
        vec!["interrupted — Claude Code ended the turn".to_string()],
        "no retry notices: nothing stacks up for the turn's end"
    );
}

/// Item 430: the chat's id reaches the preview's server — each turn's
/// `set_ask_dir` names the chat whose folder it is, replacing the last.
#[test]
fn the_ask_dir_names_the_chat_to_the_preview_server() {
    let mut s = AgentSpec::new("/w");
    s.mcp_config = Some(
        serde_json::json!({"mcpServers": {"nightloom": {"command": "/app", "args": ["--mcp-serve", "--preview", "/s.sock"]}}})
            .to_string(),
    );
    let mut agent = ClaudeCodeAgent::new(s);
    agent.set_ask_dir(PathBuf::from("/logs/ask/chat-7"));
    agent.set_ask_dir(PathBuf::from("/logs/ask/chat-8"));
    let cfg = agent.spec.mcp_config.clone().unwrap();
    let v: serde_json::Value = serde_json::from_str(&cfg).unwrap();
    assert_eq!(
        v["mcpServers"]["nightloom"]["args"],
        serde_json::json!([
            "--mcp-serve",
            "--preview",
            "/s.sock",
            "--preview-chat",
            "chat-8"
        ])
    );
}

/// Item 430, step 1 (measured with a stand-in, no model): what
/// Nightloom's own turn end does to a server the CLI's process left
/// running. The stand-in starts `python3 -m http.server` the way a
/// model's `Bash` call would, prints its `result`, and exits on the EOF
/// Nightloom sends after it. `how` is the shell line that starts it.
#[cfg(unix)]
async fn server_after_turn(how: &str, stop: bool) -> (bool, bool, Duration, Option<u32>) {
    let dir = std::env::temp_dir().join(format!("nightloom-430-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let pidfile = dir.join("server.pid");
    let started = dir.join("started");
    let tail = if stop {
        // Parks in a call until the interrupt, as ENDS_ON_INTERRUPT does.
        "trap 'exit 0' INT\nsleep 30 >/dev/null 2>&1 & wait\n"
    } else {
        r#"printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"p-430","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
cat >/dev/null
"#
    };
    let body = format!(
        r##"printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":["Bash"],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","session_id":"p-430"}}'
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_srv","name":"Bash","input":{{"command":"serve"}}}}]}},"parent_tool_use_id":null}}'
cd '{dir}'
{how}
echo $! > '{pidfile}'
i=0; until python3 -c 'import socket,sys; socket.create_connection(("127.0.0.1",{port}),0.2)' 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done
touch '{started}'
{tail}"##,
        dir = dir.display(),
        pidfile = pidfile.display(),
        started = started.display(),
        how = how.replace("$PORT", &port.to_string()),
    );
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, &body);
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let t0 = std::time::Instant::now();
    let started_c = started.clone();
    let mut on_event = |_e: TurnEvent| {};
    let run = agent.run_turn("serve", &cancel, &mut on_event);
    let watcher = async move {
        if stop {
            while !started_c.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            trigger.cancel();
        }
    };
    let (ended, _) = tokio::join!(tokio::time::timeout(Duration::from_secs(20), run), watcher);
    let took = t0.elapsed();
    let ended = ended.is_ok();
    // After the turn: is the server still answering?
    tokio::time::sleep(Duration::from_millis(300)).await;
    let alive = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(500),
    )
    .is_ok();
    let pid = std::fs::read_to_string(&pidfile)
        .ok()
        .and_then(|p| p.trim().parse::<u32>().ok());
    if let Some(pid) = pid {
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    }
    (ended, alive, took, pid)
}

/// Item 430, step 1: a server started detached (`nohup … &`, output
/// to a file) outlives a turn that ends normally — Nightloom's turn
/// end closes the CLI's stdin and waits; it kills no process group.
#[cfg(unix)]
#[tokio::test]
async fn a_detached_server_outlives_a_turn_that_ends_normally() {
    let (ended, alive, took, pid) = server_after_turn(
        "nohup python3 -m http.server $PORT --bind 127.0.0.1 >server.log 2>&1 &",
        false,
    )
    .await;
    assert!(ended, "the turn did not end ({took:?})");
    assert!(pid.is_some());
    assert!(alive, "the server died with the turn ({took:?})");
}

/// Item 430, step 1: the same after a Stop — the interrupt goes to the
/// CLI's pid alone (`interrupt`, `kill_tree` on unix), not its group.
#[cfg(unix)]
#[tokio::test]
async fn a_detached_server_outlives_a_stopped_turn() {
    let (ended, alive, took, pid) = server_after_turn(
        "nohup python3 -m http.server $PORT --bind 127.0.0.1 >server.log 2>&1 &",
        true,
    )
    .await;
    assert!(ended, "the stopped turn did not end ({took:?})");
    assert!(pid.is_some());
    assert!(alive, "the server died with the stopped turn ({took:?})");
}

/// Item 430, step 1, measured 2026-10-27: a server started with a bare
/// `&` that keeps **the CLI's own** stdout and stderr holds the turn
/// open — Nightloom reads the CLI's output to its end, and the end
/// never comes while the server lives (the turn had not ended at 20 s).
/// The CLI's `Bash` tool gives a command its own pipes, not the CLI's
/// (`inferred`), so a model's `&` should not do this; a hook or MCP
/// server that backgrounds a child could. Ignored: it takes 20 s and
/// pins a fact, not a behaviour to keep. `-- --ignored` to re-measure.
#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn measure_a_server_holding_the_clis_output() {
    let (ended, alive, took, _) =
        server_after_turn("python3 -m http.server $PORT --bind 127.0.0.1 &", false).await;
    eprintln!("430 M3: turn ended = {ended}, alive after = {alive}, waited {took:?}");
    assert!(
        !ended,
        "the turn ended: the measurement changed, update the 430 report"
    );
}

/// The stream shape of backlog 332 (synthetic text, the same shape as
/// the 10/8 turn): `init`, the reply's text deltas — non-ASCII among
/// them — and then the end of the output with no `assistant` line and
/// no `result`, as when the CLI exits holding output it never wrote.
#[cfg(unix)]
const CUT_BEFORE_RESULT: &str = r###"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-opus-5-5","permissionMode":"auto","session_id":"cut-1"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":1}}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"## Findings\n\nA €50M fund — "}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"rolling, replies in a week; the rest appro"}}}'
exit 0
"###;

/// Backlog 332: a reply whose output ends before its `result` keeps
/// every word that arrived, and the outcome says it was cut off and
/// why — the stop reason the footer shows — instead of ending silently.
#[cfg(unix)]
#[tokio::test]
async fn a_stream_that_ends_before_its_result_keeps_the_text_and_says_cut_off() {
    let dir = std::env::temp_dir().join(format!("nightloom-cut-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, CUT_BEFORE_RESULT);
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let mut text = String::new();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if let TurnEvent::TextDelta { text: t } = e {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
    assert_eq!(
        text,
        "## Findings\n\nA €50M fund — rolling, replies in a week; the rest appro"
    );
    assert!(!outcome.result_seen);
    let why = outcome.cut_off.as_deref().expect("said to be cut off");
    assert!(why.contains("ended before the reply finished"), "{why}");
    assert!(
        outcome.notices.iter().any(|n| n.starts_with("cut off — ")),
        "{:?}",
        outcome.notices
    );
    assert_eq!(outcome.session_id.as_deref(), Some("cut-1"));
}

/// Backlog 332: a byte that is not UTF-8 no longer ends the read (it
/// was an `Err` from `lines()`, and the turn ended there, silently);
/// the line is read lossily and the reply runs on to its `result`.
#[cfg(unix)]
#[tokio::test]
async fn a_line_that_is_not_utf8_does_not_end_the_reply() {
    let dir = std::env::temp_dir().join(format!("nightloom-utf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(
        &dir,
        r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"u-1"}'
printf '{"type":"stream_event","bad":"\377"}\n'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"after the bad byte"}}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"after the bad byte","session_id":"u-1","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}'
"##,
    );
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let mut text = String::new();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if let TurnEvent::TextDelta { text: t } = e {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
    assert_eq!(text, "after the bad byte");
    assert!(outcome.result_seen);
    assert!(outcome.cut_off.is_none());
    assert_eq!(outcome.usage.output_tokens, 4);
}

/// Item 723 with a stand-in for the CLI's non-streaming fallback (his
/// chat 8e2f20a1): `init`, a retry, the reply as one whole `assistant`
/// line with no `stream_event`, the `result`. The reply is drawn, once,
/// and the turn says it came in one piece; the timing line names the
/// result, the zero events and the exit.
#[cfg(unix)]
#[tokio::test]
async fn a_reply_that_came_whole_is_drawn_and_said() {
    use crate::turn_timing::{self, TurnTiming};
    let dir = std::env::temp_dir().join(format!("nightloom-723a-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(
        &dir,
        r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"w-1"}'
printf '%s\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":529,"error":"overloaded"}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg_w","model":"m","role":"assistant","content":[{"type":"text","text":"ok"}]},"parent_tool_use_id":null,"session_id":"w-1"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"w-1","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}'
"##,
    );
    let mut agent = ClaudeCodeAgent::new(s);
    let timing = TurnTiming::begin(turn_timing::SERVE, None, None);
    agent.set_timing(Some(timing.clone()));
    let cancel = CancellationToken::new();
    let mut text = String::new();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if let TurnEvent::TextDelta { text: t } = e {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
    assert_eq!(text, "ok");
    assert!(outcome.result_seen);
    assert_eq!(outcome.stream_events, 0);
    assert!(
        outcome.notices.iter().any(|n| n == WHOLE_REPLY_NOTICE),
        "{:?}",
        outcome.notices
    );
    assert!(!outcome.notices.iter().any(|n| n == RESULT_ONLY_NOTICE));
    let note = timing.stages().process.expect("the process part");
    assert!(
        note.starts_with("result seen, 0 stream events, exit"),
        "{note}"
    );
}

/// Item 723's backstop: a turn that drew no prose at all but whose
/// `result` names a reply draws the `result` text, and says so.
#[cfg(unix)]
#[tokio::test]
async fn a_reply_only_in_the_result_is_drawn() {
    let dir = std::env::temp_dir().join(format!("nightloom-723b-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(
        &dir,
        r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"w-2"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"only here","session_id":"w-2","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}'
"##,
    );
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let mut text = String::new();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if let TurnEvent::TextDelta { text: t } = e {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
    assert_eq!(text, "only here");
    assert!(outcome.notices.iter().any(|n| n == RESULT_ONLY_NOTICE));
}

/// Item 723: a process that prints nothing for a message and exits 0
/// is a failure with its stderr, never a silent "ok".
#[cfg(unix)]
#[tokio::test]
async fn a_process_that_prints_nothing_is_an_error() {
    let dir = std::env::temp_dir().join(format!("nightloom-723c-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, "read -r line\necho 'went quiet' >&2\nexit 0\n");
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let err = agent
        .run_turn("go", &cancel, &mut |_| {})
        .await
        .expect_err("printed nothing");
    let msg = err.to_string();
    assert!(msg.contains("printed nothing"), "{msg}");
}

/// A turn the API's content filter stopped (backlog 202; the synthetic
/// line's fields as `ece63fa7….jsonl` l.48 recorded them, trimmed) ends
/// with the CLI's sentence as a notice, once, and as the outcome's
/// `api_error` for the log's stop reason.
#[cfg(unix)]
#[tokio::test]
async fn an_api_error_the_cli_ends_the_turn_with_becomes_one_notice() {
    let dir = std::env::temp_dir().join(format!("nightloom-apierr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(
        &dir,
        r#"printf '%s\n' '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error: Output blocked by content filtering policy"}],"usage":{"input_tokens":0,"output_tokens":0}},"parent_tool_use_id":null,"error":"unknown","isApiErrorMessage":true}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"API Error: Output blocked by content filtering policy","session_id":"apierr-1"}'
"#,
    );
    let agent = ClaudeCodeAgent::new(s);
    let outcome = agent
        .run_turn("go", &CancellationToken::new(), &mut |_| {})
        .await
        .unwrap();
    let text = "API Error: Output blocked by content filtering policy";
    assert!(outcome.is_error);
    assert_eq!(outcome.api_error.as_deref(), Some(text));
    assert_eq!(
        outcome.notices,
        vec![text.to_string()],
        "one notice, one toast"
    );
}

/// A CLI that ignores the interrupt is killed once the grace runs out,
/// as before; the notice says so.
#[cfg(unix)]
#[tokio::test]
async fn a_cli_that_ignores_the_interrupt_is_killed_after_the_grace() {
    let dir = std::env::temp_dir().join(format!("nightloom-stop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(
        &dir,
        "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"x\",\"tools\":[],\"mcp_servers\":[],\"model\":\"m\",\"permissionMode\":\"auto\",\"session_id\":\"stop-2\"}'\ntrap '' INT\nsleep 30 >/dev/null 2>&1 & wait\n",
    );
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let started = std::time::Instant::now();
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if matches!(e, TurnEvent::AgentInit { .. }) {
                trigger.cancel();
            }
        })
        .await
        .unwrap();
    assert!(started.elapsed() >= INTERRUPT_GRACE);
    assert!(started.elapsed() < INTERRUPT_GRACE + KILLED_DRAIN + Duration::from_secs(3));
    assert!(
        outcome
            .notices
            .iter()
            .any(|n| n.starts_with("interrupted — killed")),
        "{:?}",
        outcome.notices
    );
}

/// A path the user typed is honoured as typed. Second-guessing it would
/// override the one escape hatch the fallback leaves them.
#[test]
fn the_stderr_tail_is_cut_on_a_char_boundary() {
    let short = "plain";
    assert_eq!(stderr_tail(short), short);
    // `—` is three bytes; place it so the byte cut lands inside it.
    let mut text = "x".repeat(STDERR_TAIL + 1);
    text.insert(2, '—');
    let tail = stderr_tail(&text);
    assert!(tail.len() <= STDERR_TAIL);
    assert!(
        tail.chars().all(|c| c == 'x'),
        "the straddled dash is dropped whole"
    );
    // A cut that lands on a boundary keeps exactly the tail.
    let exact = "y".repeat(STDERR_TAIL + 10);
    assert_eq!(stderr_tail(&exact).len(), STDERR_TAIL);
}

/// Item 897: a Dock-launched app's PATH gains Homebrew; the inherited
/// order is kept and nothing is repeated. Unix only (item 979): its PATHs
/// are written with `:`, which Windows's `split_paths` does not split on
/// (`;` there), so CI's Windows job read "/usr/bin:/bin" as one entry.
#[cfg(unix)]
#[test]
fn a_launchd_path_is_widened_with_homebrew_in_order_without_duplicates() {
    let home = std::path::Path::new("/Users/someone");
    let got = widened_path(
        Some(std::ffi::OsStr::new("/usr/bin:/bin")),
        Some(home),
        |_| true,
    );
    let dirs: Vec<PathBuf> = std::env::split_paths(&got).collect();
    assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
    assert_eq!(dirs[1], PathBuf::from("/bin"));
    assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    assert!(dirs.contains(&home.join(".local/bin")));
    let mut seen = dirs.clone();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), dirs.len(), "no duplicates: {dirs:?}");
    // Inherited entries keep priority over a fallback dir they name.
    let got = widened_path(
        Some(std::ffi::OsStr::new("/x:/opt/homebrew/bin:/x")),
        None,
        |_| true,
    );
    let dirs: Vec<PathBuf> = std::env::split_paths(&got).collect();
    assert_eq!(dirs[0], PathBuf::from("/x"));
    assert_eq!(dirs[1], PathBuf::from("/opt/homebrew/bin"));
    assert_eq!(
        dirs.iter()
            .filter(|d| d.as_path() == std::path::Path::new("/x"))
            .count(),
        1
    );
    // A dir that does not exist is not added; no PATH at all still works.
    let got = widened_path(None, None, |d| {
        d == std::path::Path::new("/opt/homebrew/bin")
    });
    assert_eq!(got, std::ffi::OsString::from("/opt/homebrew/bin"));
}

#[test]
fn an_explicit_path_is_never_rewritten() {
    for named in ["/opt/claude/bin/claude", "./claude", "../tools/claude"] {
        assert_eq!(resolve_binary(named), named);
    }
}

/// A name nothing resolves comes back unchanged, so the error names
/// what was asked for rather than a directory invented here.
#[test]
fn an_unresolvable_name_is_returned_as_asked() {
    let name = "nightloom-no-such-binary-9f3a";
    assert_eq!(resolve_binary(name), name);
}

/// `PATH` is searched first and said first. Preferring a candidate
/// directory would silently run a stale install in front of the one the
/// user's version manager put on `PATH`.
#[test]
fn path_leads_the_places_that_are_searched() {
    assert_eq!(
        searched_locations().first().map(String::as_str),
        Some("PATH")
    );
}

/// Item 466's stand-ins, one per way a Stop can go (2026-10-29). The
/// init line, then on SIGINT:
/// - `prompt`: the CLI closes the turn and exits at once (online);
/// - `slow_ack`: it takes 3 s to write its `result` and exit (a CLI
///   whose abort waits on a stalled connection);
/// - `lingers`: it writes its `result` at once but its process stays up
///   8 s, holding stdout (an exit held up on the network); `lingers_322`
///   the same with 2.1.322's `result` line, `type` not first (658);
/// - `ignores`: it ignores the interrupt (a stalled CLI);
/// - `ignores_orphan`: as `ignores`, and a child it started holds its
///   pipes 8 s past the kill.
#[cfg(unix)]
fn stop_stand_in(kind: &str) -> String {
    let init = r#"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"stop-466"}'"#;
    let result = if kind == "lingers_322" {
        // Item 658: CLI 2.1.322's order, `type` not first.
        r#"printf '%s\n' '{"duration_api_ms":0,"stop_reason":null,"session_id":"stop-466","usage":{"input_tokens":0,"output_tokens":0},"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","num_turns":1}'"#
    } else {
        r#"printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","num_turns":1,"session_id":"stop-466","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}'"#
    };
    let on_int = match kind {
        "prompt" => "trap 'res; exit 0' INT",
        "slow_ack" => "trap 'sleep 3; res; exit 0' INT",
        "lingers" | "lingers_322" => "trap 'res; sleep 8; exit 0' INT",
        // Ignores it, and a process it started holds its stdout and
        // stderr 8 s past its kill (an MCP server, a hook).
        "ignores_orphan" => "trap '' INT\nsleep 8 &",
        _ => "trap '' INT",
    };
    format!("res() {{ {result}; }}\n{init}\n{on_int}\nsleep 30 >/dev/null 2>&1 & wait\nwait\n")
}

/// Click-to-ended for each stand-in: the Stop lands on the init line,
/// the clock runs until `run_turn` returns (what the window waits on).
#[cfg(unix)]
async fn time_stop(kind: &str) -> (Duration, Vec<String>) {
    let dir = std::env::temp_dir().join(format!("nightloom-466-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, &stop_stand_in(kind));
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut at: Option<std::time::Instant> = None;
    let outcome = agent
        .run_turn("go", &cancel, &mut |e| {
            if at.is_none() && matches!(e, TurnEvent::AgentInit { .. }) {
                at = Some(std::time::Instant::now());
                trigger.cancel();
            }
        })
        .await
        .unwrap();
    (at.expect("stopped at init").elapsed(), outcome.notices)
}

/// Item 543a (his report, 2026-11-10 ~6:30 AM): the reply ended with a
/// helper running in the background, the limit then rejected the
/// helper's request, and nothing more came — the turn sat open, neither
/// running nor paused. The stand-in is that stream: `init`, a helper's
/// `task_started`, the main `result`, a rejected `rate_limit_event`,
/// then silence with the process up. The turn now ends by itself after
/// the grace, carrying the limit and its reset, with the helper named.
#[cfg(unix)]
#[tokio::test]
async fn a_turn_idle_on_helpers_the_limit_stopped_ends_paused_by_itself() {
    let dir = std::env::temp_dir().join(format!("nightloom-543-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let body = r#"res() { printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","num_turns":1,"session_id":"lim-543","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}'; }
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"lim-543"}'
printf '%s\n' '{"type":"system","subtype":"task_started","task_id":"a8bb","tool_use_id":"toolu_HELPER","description":"funding scan","task_type":"local_agent"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Three helpers are running.","session_id":"lim-543","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1794321000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}'
trap 'res; exit 0' INT
sleep 30 >/dev/null 2>&1 & wait
wait
"#;
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, body);
    let mut agent = ClaudeCodeAgent::new(s);
    agent.limit_grace = Duration::from_millis(300);
    let cancel = CancellationToken::new();
    let began = std::time::Instant::now();
    let outcome = agent.run_turn("go", &cancel, &mut |_| {}).await.unwrap();
    let took = began.elapsed();
    assert!(took < Duration::from_secs(5), "the turn hung: {took:?}");
    let hit = outcome.limit.expect("the limit is on the outcome");
    assert_eq!(hit.resets_at, Some(1794321000));
    assert_eq!(hit.window.as_deref(), Some("five_hour"));
    assert!(!outcome.is_error);
    assert_eq!(
        outcome.notices,
        vec![
            "paused — the plan's usage limit stopped the helpers this turn was waiting on"
                .to_string()
        ]
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Item 538 (539's missing piece): a main thread that sits idle while
/// its helper runs is woken when usage nears the message's cap. The
/// stand-in is that stream — `init`, a helper's `task_started`, the main
/// `result` — and then it reads one more line from stdin and ends. His
/// message states the cap (the backstop writes it), the chat's wire
/// reading is within five points of it, and the drive loop's look
/// writes Nightloom's line, once, naming the helper.
#[cfg(unix)]
#[tokio::test]
async fn an_idle_main_thread_is_woken_near_the_cap_while_helpers_run() {
    let dir = std::env::temp_dir().join(format!("nightloom-538-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let got = dir.join("woke.txt");
    let body = r#"read -r first
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"cap-538"}'
printf '%s\n' '{"type":"system","subtype":"task_started","task_id":"a8bb","tool_use_id":"toolu_HELPER","description":"funding scan","task_type":"local_agent"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"A helper is running.","session_id":"cap-538","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
read -r wake
printf '%s\n' "$wake" > 'GOT'
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"cap-538"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Told it to wrap up.","session_id":"cap-538","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
"#
    .replace("GOT", &got.to_string_lossy());
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, &body);
    s.brief = Some(BriefSpec {
        hook: vec!["x".into()],
        dir: dir.clone(),
        text: "<nightloom-subagent-brief>b</nightloom-subagent-brief>".into(),
    });
    // Every limit off, as he runs: only the cap his message states binds.
    let mut limits = brief::SubagentLimits::default();
    limits.off.stop_at = true;
    limits.off.budget_pct = true;
    s.subagent_limits = Some(limits);
    // The chat's own reading, stamped ahead so this machine's gauge
    // never outranks it.
    brief::write_usage(
        &dir,
        46,
        None,
        chrono::Utc::now().timestamp_millis() + 60_000,
    );
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let mut woke = Vec::new();
    let began = std::time::Instant::now();
    agent
        .run_turn("use up to 50% of the 5h limit", &cancel, &mut |e| {
            if let TurnEvent::BudgetWake {
                text,
                kind,
                pct,
                cap,
                ..
            } = e
            {
                woke.push((text, kind, pct, cap));
            }
        })
        .await
        .unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(20),
        "the turn hung: {:?}",
        began.elapsed()
    );
    assert_eq!(woke.len(), 1, "{woke:?}");
    let (text, kind, pct, cap) = &woke[0];
    assert_eq!(
        (kind.as_slice(), *pct, *cap),
        (&["near".to_string()][..], Some(46), Some(50))
    );
    assert!(
        text.starts_with("[Nightloom, not from Swaraag: usage is at 46%")
            && text.contains("`a8bb` (\"funding scan\")")
            && text.contains("SendMessage"),
        "{text}"
    );
    // The line reached the process's stdin, as a user line.
    let line = std::fs::read_to_string(&got).unwrap();
    assert!(
        line.contains(r#""type":"user""#) && line.contains("Nightloom, not from Swaraag"),
        "{line}"
    );
    // Once: the ledger has it as fired, and nothing waits.
    let b = brief::read_turn_budget(&dir).unwrap();
    assert_eq!(
        b.cap.as_ref().map(|c| (c.percent, c.source.as_str())),
        Some((50, "message"))
    );
    assert!(b.wakes_fired.iter().any(|k| k == "near") && b.wakes_pending.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

/// 543a: a turn that is still working when the limit is seen is not cut
/// short — the main thread's own 429 ends it the ordinary way. The
/// stand-in sleeps 0.9 s, off the 200 ms grace's re-arm grid: at exactly
/// 1 s its result raced the timer under load (blocker 1961).
#[cfg(unix)]
#[tokio::test]
async fn a_working_turn_is_not_closed_by_the_limit_grace() {
    let dir = std::env::temp_dir().join(format!("nightloom-543b-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let body = r#"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"lim-543b"}'
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1794321000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}'
sleep 0.9
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"limit","session_id":"lim-543b","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
"#;
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, body);
    let mut agent = ClaudeCodeAgent::new(s);
    agent.limit_grace = Duration::from_millis(200);
    let cancel = CancellationToken::new();
    let outcome = agent.run_turn("go", &cancel, &mut |_| {}).await.unwrap();
    assert!(outcome.limit.is_some());
    assert!(outcome.result_seen);
    assert!(
        !outcome.notices.iter().any(|n| n.starts_with("paused —")),
        "{:?}",
        outcome.notices
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Item 466: a CLI that closes the turn on the interrupt but is slow to
/// exit ends the Stop at its `result` line — not 5 s later, and not
/// called a kill.
#[cfg(unix)]
#[tokio::test]
async fn a_stop_ends_at_the_result_line_not_at_the_slow_exit() {
    let (t, notices) = time_stop("lingers").await;
    assert!(t < Duration::from_secs(1), "{t:?}");
    assert_eq!(
        notices,
        vec!["interrupted — Claude Code ended the turn".to_string()]
    );
}

/// Item 466: after the kill, a child holding the CLI's pipes holds the
/// Stop no more than `KILLED_DRAIN` past the grace (was 3 s more).
#[cfg(unix)]
#[tokio::test]
async fn a_killed_cli_s_orphan_does_not_hold_the_stop() {
    let (t, _) = time_stop("ignores_orphan").await;
    assert!(t >= INTERRUPT_GRACE);
    assert!(
        t < INTERRUPT_GRACE + KILLED_DRAIN + Duration::from_millis(700),
        "{t:?}"
    );
}

/// Item 656's stand-in: the lines CLI 2.1.322 printed for one 8-second
/// foreground `./tick.sh` run with the app's own flags (measured
/// 2026-11-11, `656-report-2026-11-11.md`), verbatim but for the ids, and
/// the spool written beside them as the CLI writes it — `task_started`
/// arrives ~3 s after the command started, the spool already has lines,
/// and it is deleted before `task_notification`. The turn goes through
/// the real read loop: the tail, its tick, the event.
#[cfg(unix)]
async fn bash_tail_turn(result_line: &str, announced: bool) -> Vec<TurnEvent> {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let dir = std::env::temp_dir().join(format!("nightloom-656-{tag}"));
    std::fs::create_dir_all(&dir).unwrap();
    let session = format!("s656-{tag}");
    let task = format!("b656{}", &tag[..8]);
    // Where the CLI keeps it: `/tmp/claude-<uid>/<cwd slug>/<session>/tasks/`.
    let spool_root = std::path::PathBuf::from(format!("/tmp/claude-656t-{tag}"));
    let tasks = spool_root.join("-cwd-slug").join(&session).join("tasks");
    let spool = tasks.join(format!("{task}.output"));
    let lines = [
        format!(
            r#"{{"type":"system","subtype":"init","cwd":"x","session_id":"{session}","tools":["Bash"],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default"}}"#
        ),
        format!(
            r#"{{"type":"assistant","message":{{"model":"claude-haiku-5-5","id":"msg_011CgxW3PeGLfahq5oDdNbmm","type":"message","role":"assistant","content":[{{"type":"tool_use","id":"toolu_656","name":"Bash","input":{{"command":"./tick.sh","description":"Run tick.sh in the foreground from the working directory","run_in_background":false}},"caller":{{"type":"direct"}}}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{{"input_tokens":2,"cache_creation_input_tokens":12252,"cache_read_input_tokens":24142,"output_tokens":17}}}},"parent_tool_use_id":null,"session_id":"{session}","uuid":"a0ec972d-bcca-4050-bf9d-ea2a4aa20a23"}}"#
        ),
        format!(
            r#"{{"type":"system","subtype":"task_started","task_id":"{task}","run_id":"0mwd4gula-88b450f7","tool_use_id":"toolu_656","description":"Run tick.sh in the foreground from the working directory","is_backgrounded":false,"task_type":"local_bash","uuid":"f248cd06-05f2-4472-a088-384d9dbf23ae","session_id":"{session}"}}"#
        ),
        format!(
            r#"{{"type":"system","subtype":"task_notification","task_id":"{task}","run_id":"0mwd4gula-88b450f7","tool_use_id":"toolu_656","status":"completed","output_file":"","summary":"Run tick.sh in the foreground from the working directory","uuid":"61e5eac5-3bde-4a8f-9de9-4493b9b5836e","session_id":"{session}"}}"#
        ),
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"tool_use_id":"toolu_656","type":"tool_result","content":"line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8","is_error":false}}]}},"parent_tool_use_id":null,"session_id":"{session}","uuid":"c6efa4b2-ff34-4ec9-831b-9aabafffe610"}}"#
        ),
        result_line.replace("SESSION", &session),
    ];
    for (i, l) in lines.iter().enumerate() {
        // A command over before the CLI would announce it (< ~3 s):
        // no `task_started`, no `task_notification`.
        let l = if !announced && (i == 2 || i == 3) {
            String::new()
        } else {
            format!("{l}\n")
        };
        std::fs::write(dir.join(format!("l{i}.json")), l).unwrap();
    }
    let d = dir.display();
    let (t, s) = (tasks.display(), spool.display());
    let body = format!(
        r#"read -r line
cat '{d}/l0.json' '{d}/l1.json'
mkdir -p '{t}'; : > '{s}'
for i in 1 2; do echo "line $i" >> '{s}'; sleep 0.4; done
cat '{d}/l2.json'
for i in 3 4 5 6 7 8; do echo "line $i" >> '{s}'; sleep 0.4; done
rm -f '{s}'
cat '{d}/l3.json' '{d}/l4.json' '{d}/l5.json'
cat >/dev/null
"#
    );
    let mut spec = AgentSpec::new(&dir);
    spec.binary = stand_in(&dir, &body);
    let agent = ClaudeCodeAgent::new(spec);
    let cancel = CancellationToken::new();
    let mut events = Vec::new();
    let ended = {
        let mut on_event = |e| events.push(e);
        let run = agent.run_turn("run it", &cancel, &mut on_event);
        tokio::time::timeout(Duration::from_secs(20), run).await
    };
    let _ = std::fs::remove_dir_all(&spool_root);
    let _ = std::fs::remove_dir_all(&dir);
    ended.expect("the turn ends").unwrap();
    events
}

/// Item 656: the read loop turns the running command's spool into
/// `ToolOutput` events — after its `task_started`, before its result.
#[cfg(unix)]
#[tokio::test]
async fn a_running_foreground_bash_passes_its_spool_as_tool_output() {
    let events = bash_tail_turn(
        r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done","session_id":"SESSION","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
        true,
    )
    .await;
    let outs: Vec<&Vec<String>> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ToolOutput { tool_use_id, lines } if tool_use_id == "toolu_656" => {
                Some(lines)
            }
            _ => None,
        })
        .collect();
    eprintln!("656 tool_output events: {outs:?}");
    assert!(outs.len() >= 2, "{outs:?}");
    // From the call, not from `task_started` (656): line 1 alone first.
    assert_eq!(outs[0], &vec!["line 1".to_string()], "{outs:?}");
    assert!(outs.iter().all(|l| l.len() <= bash_tail::LINES));
    let last_out = events
        .iter()
        .rposition(|e| matches!(e, TurnEvent::ToolOutput { .. }))
        .unwrap();
    let result = events
        .iter()
        .position(|e| matches!(e, TurnEvent::ToolResult { .. }))
        .unwrap();
    assert!(last_out < result, "no passing text after the result");
}

/// Item 656: a command over before the CLI announces it (no
/// `task_started` at all — most commands) still passes its text.
#[cfg(unix)]
#[tokio::test]
async fn a_command_never_announced_still_passes_its_text() {
    let events = bash_tail_turn(
        r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done","session_id":"SESSION","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
        false,
    )
    .await;
    assert!(
        events.iter().any(
            |e| matches!(e, TurnEvent::ToolOutput { tool_use_id, .. } if tool_use_id == "toolu_656")
        ),
        "{events:?}"
    );
}

/// Item 656 with the real CLI (`cargo test -p nightloom-service --lib
/// live_656 -- --ignored --nocapture`): one Haiku turn running a 3-line,
/// 1.5-second script — under the ~3 s the CLI waits before announcing a
/// command — allowed by one rule, nothing else. Prints the events.
#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn live_656_a_short_command_passes_its_text_with_the_real_cli() {
    let dir = std::env::temp_dir().join(format!("nightloom-656-live-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("tick.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nfor i in 1 2 3; do echo line $i; sleep 0.5; done\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut spec = AgentSpec::new(&dir);
    spec.binary = "claude".into();
    spec.model = Some("haiku".into());
    spec.no_session_persistence = true;
    spec.permission_mode = Some("default".into());
    spec.allowed_tools = vec!["Bash(./tick.sh)".into()];
    let agent = ClaudeCodeAgent::new(spec);
    let cancel = CancellationToken::new();
    let t0 = std::time::Instant::now();
    let mut seen = Vec::new();
    {
        let mut on_event = |e: TurnEvent| match &e {
            TurnEvent::ToolCall { name, .. } => {
                seen.push(format!("{:.2} call {name}", t0.elapsed().as_secs_f64()))
            }
            TurnEvent::ToolOutput { lines, .. } => seen.push(format!(
                "{:.2} output {lines:?}",
                t0.elapsed().as_secs_f64()
            )),
            TurnEvent::ToolResult { .. } => {
                seen.push(format!("{:.2} result", t0.elapsed().as_secs_f64()))
            }
            TurnEvent::ToolDenied { .. } => {
                seen.push(format!("{:.2} denied", t0.elapsed().as_secs_f64()))
            }
            _ => {}
        };
        agent
            .run_turn(
                "Run exactly this Bash command in the foreground, then reply done: ./tick.sh",
                &cancel,
                &mut on_event,
            )
            .await
            .unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
    for s in &seen {
        println!("656 live: {s}");
    }
    assert!(seen.iter().any(|s| s.contains("output")), "{seen:?}");
}

/// Item 656, found on the way: 2.1.322's `result` line no longer starts
/// with `"type"` (measured: `{"duration_api_ms":…,"type":"result",…}`).
/// The turn still ends on it, and the command still passes its text.
#[cfg(unix)]
#[tokio::test]
async fn a_result_line_whose_type_is_not_first_still_ends_the_turn() {
    let events = bash_tail_turn(
        r#"{"duration_api_ms":2219,"stop_reason":"end_turn","session_id":"SESSION","total_cost_usd":0.004,"usage":{"input_tokens":1,"output_tokens":1},"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done"}"#,
        true,
    )
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TurnEvent::ToolOutput { .. }))
    );
}

/// Item 658: the Stop's drain ends at 2.1.322's `result` line too
/// (`type` not first), not at the kill 5 s later.
#[cfg(unix)]
#[tokio::test]
async fn a_stop_ends_at_a_result_line_whose_type_is_not_first() {
    let (t, notices) = time_stop("lingers_322").await;
    assert!(t < Duration::from_secs(1), "{t:?}");
    assert_eq!(
        notices,
        vec!["interrupted — Claude Code ended the turn".to_string()]
    );
}

/// Item 658: a turn with attachments (stdin held, no inbox, 332) gets
/// its EOF at the `result` line in either key order, so a CLI that
/// reads its stdin to the end exits; before, 2.1.322's order held the
/// stdin open and the turn never ended.
#[cfg(unix)]
#[tokio::test]
async fn an_attachment_turn_closes_its_stdin_at_the_result_in_either_order() {
    for result in [
        r#"{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"att-658","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
        r#"{"duration_api_ms":12,"stop_reason":"end_turn","session_id":"att-658","usage":{"input_tokens":1,"output_tokens":1},"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok"}"#,
    ] {
        let dir = std::env::temp_dir().join(format!("nightloom-658a-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let body = format!(
            "read -r line\nprintf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"x\",\"tools\":[],\"mcp_servers\":[],\"model\":\"m\",\"permissionMode\":\"auto\",\"session_id\":\"att-658\"}}'\nprintf '%s\\n' '{result}'\ncat >/dev/null\nexit 0\n"
        );
        let mut s = AgentSpec::new(&dir);
        s.binary = stand_in(&dir, &body);
        let agent = ClaudeCodeAgent::new(s.clone());
        let input = TurnInput {
            text: "what colour".into(),
            images: vec![nightloom_core::ImageInput {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
            documents: Vec::new(),
        };
        let cancel = CancellationToken::new();
        let mut on_event = |_e: TurnEvent| {};
        let run = agent.run_with(&s, input, &cancel, &mut on_event);
        let outcome = tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("the stdin was closed at the result")
            .unwrap();
        assert!(outcome.result_seen, "{result}");
        assert_eq!(outcome.session_id.as_deref(), Some("att-658"));
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Item 658: 543a's turn (idle on helpers the limit stopped) with
/// 2.1.322's `result` line: the main thread is idle at it, so the turn
/// still ends paused by itself. (543a's own test is the old order.)
#[cfg(unix)]
#[tokio::test]
async fn a_turn_idle_on_helpers_ends_paused_at_a_result_whose_type_is_not_first() {
    let dir = std::env::temp_dir().join(format!("nightloom-658b-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let body = r#"res() { printf '%s\n' '{"duration_api_ms":0,"stop_reason":null,"session_id":"lim-658","usage":{"input_tokens":0,"output_tokens":0},"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","num_turns":1}'; }
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"auto","session_id":"lim-658"}'
printf '%s\n' '{"type":"system","subtype":"task_started","task_id":"a8bb","tool_use_id":"toolu_HELPER","description":"funding scan","task_type":"local_agent"}'
printf '%s\n' '{"duration_api_ms":2219,"stop_reason":"end_turn","session_id":"lim-658","usage":{"input_tokens":1,"output_tokens":1},"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Three helpers are running."}'
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1794321000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}'
trap 'res; exit 0' INT
sleep 30 >/dev/null 2>&1 & wait
wait
"#;
    let mut s = AgentSpec::new(&dir);
    s.binary = stand_in(&dir, body);
    let mut agent = ClaudeCodeAgent::new(s);
    agent.limit_grace = Duration::from_millis(300);
    let cancel = CancellationToken::new();
    let began = std::time::Instant::now();
    let outcome = agent.run_turn("go", &cancel, &mut |_| {}).await.unwrap();
    let took = began.elapsed();
    assert!(took < Duration::from_secs(5), "the turn hung: {took:?}");
    let hit = outcome.limit.expect("the limit is on the outcome");
    assert_eq!(hit.resets_at, Some(1794321000));
    assert_eq!(
        outcome.notices,
        vec![
            "paused — the plan's usage limit stopped the helpers this turn was waiting on"
                .to_string()
        ]
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Item 466's measurement, printed (`--ignored --nocapture`).
#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn measure_466_stop_latency_claude_code() {
    for kind in ["prompt", "slow_ack", "lingers", "ignores", "ignores_orphan"] {
        let (t, notices) = time_stop(kind).await;
        println!("466 cli {kind}: {:.2} s {notices:?}", t.as_secs_f64());
    }
}

/// Item 1011: on a dev scratch home, a chat whose Claude Code session file
/// is in a folder of the real home's never starts a process — not the
/// chat's turn, not an aside, not a prewarm — and the turn says why. Its
/// own session still runs. The stand-in records that it ran at all.
#[cfg(unix)]
#[tokio::test]
async fn a_dev_home_never_resumes_his_real_session() {
    let (t, scope, real_dir, _) = super::dev_guard::tests::layout();
    let _g = super::dev_guard::test_scope(scope);
    let ran = t.path().join("ran");
    let body = format!(
        r##"printf '%s\n' "$@" >> '{ran}'
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"dontAsk","session_id":"0e1-own"}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"0e1-own","stop_reason":"end_turn","usage":{{"input_tokens":1,"output_tokens":1}}}}'
cat >/dev/null
exit 0
"##,
        ran = ran.display()
    );
    let his_before = std::fs::read(real_dir.join("bf71e603-aaaa.jsonl")).unwrap();
    let mut s = AgentSpec::new(t.path());
    s.binary = stand_in(t.path(), &body);
    s.resume = Some("bf71e603-aaaa".into());
    let agent = ClaudeCodeAgent::new(s.clone());
    let cancel = CancellationToken::new();
    assert!(
        !agent.prewarm().unwrap(),
        "no waiting process for his session"
    );
    let turn = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        agent.run_turn("hello", &cancel, &mut |_| {}),
    )
    .await
    .unwrap();
    match turn {
        Err(AgentError::ForeignSession(m)) => assert!(m.contains("bf71e603-aaaa"), "{m}"),
        other => panic!("expected the refusal, got {other:?}"),
    }
    let aside = agent
        .ask_aside("beside".into(), None, None, None, &cancel, &mut |_| {})
        .await
        .expect("a session to ask beside");
    assert!(matches!(aside, Err(AgentError::ForeignSession(_))));
    let seat = agent.run_with(&s, "seat", &cancel, &mut |_| {}).await;
    assert!(matches!(seat, Err(AgentError::ForeignSession(_))));
    assert!(!ran.exists(), "no process started");
    assert_eq!(
        std::fs::read(real_dir.join("bf71e603-aaaa.jsonl")).unwrap(),
        his_before
    );

    // The home's own session: the turn runs and resumes it.
    let mut own = s.clone();
    own.resume = Some("0e1-own".into());
    let agent = ClaudeCodeAgent::new(own);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        agent.run_turn("hello", &cancel, &mut |_| {}),
    )
    .await
    .unwrap()
    .unwrap();
    let argv = std::fs::read_to_string(&ran).unwrap();
    assert!(argv.contains("--resume\n0e1-own"), "{argv}");
}
