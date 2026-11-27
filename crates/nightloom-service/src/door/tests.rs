//! The door's tests: the reads, the switch, the wait's four ends, the
//! command line and the MCP tools — over a real socket and a host that
//! writes real logs, with no model.
//!
//! The door is a Unix socket (`server::open` refuses elsewhere), so the
//! tests that open one run on Unix only; their fake host goes unused on
//! Windows (item 1021).
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nightloom_core::message::ContentBlock;
use nightloom_core::{ChatKind, ChatMode, Session, SessionEvent, TitleBy, Usage};
use tokio::sync::broadcast;

use super::client::{self, Waited};
use super::*;
use crate::jobs::Prep;
use crate::remote::api::{LimitPause, Running, RunningChat};
use crate::remote::{ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState};

/// A home under `/tmp` (a socket's path must be short) with one project.
fn home(name: &str) -> (PathBuf, String) {
    let config = PathBuf::from("/tmp").join(format!("nl767-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&config);
    std::fs::create_dir_all(&config).unwrap();
    let mut registry = Registry::load_in(&config);
    let project = registry.create("Lanternfish", None, None).unwrap();
    (config, project.id)
}

fn sessions(config: &Path, project: &str) -> PathBuf {
    config.join(PROJECTS_DIR).join(project).join(SESSIONS_DIR)
}

fn reply(session: &mut Session, text: &str) {
    session.record_assistant(
        "test-model",
        vec![ContentBlock::Text { text: text.into() }],
        Some("end_turn".into()),
        Usage::default(),
    );
}

/// A chat with one exchange. Its id.
fn chat(dir: &Path, title: &str, user: &str, answer: &str) -> String {
    let mut s = Session::start(dir, ChatMode::Normal, ChatKind::Build).unwrap();
    s.record_title_by(title, TitleBy::User);
    s.record_user(user);
    reply(&mut s, answer);
    s.id.clone()
}

/// What the fake host does with a message.
#[derive(Clone, Copy, PartialEq)]
enum Turn {
    /// Runs, then replies.
    Replies,
    /// Runs, then asks him something and stays there.
    Asks,
    /// Runs, then ends with nothing said.
    Dies,
    /// Never starts.
    Nothing,
}

struct FakeHost {
    config: PathBuf,
    project: String,
    turn: Turn,
    /// The running chat and its unanswered prompts.
    running: Arc<Mutex<Option<(String, usize)>>>,
    paused: Mutex<Option<String>>,
    tx: broadcast::Sender<Event>,
    prepared: Mutex<Vec<Prep>>,
}

impl FakeHost {
    fn new(config: &Path, project: &str, turn: Turn) -> Arc<Self> {
        Arc::new(Self {
            config: config.to_path_buf(),
            project: project.to_string(),
            turn,
            running: Arc::default(),
            paused: Mutex::new(None),
            tx: broadcast::channel(4).0,
            prepared: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl Host for FakeHost {
    async fn state(&self) -> RemoteState {
        RemoteState::default()
    }
    async fn chats(&self, _project: Option<&str>) -> Result<Vec<ChatRow>, String> {
        Ok(Vec::new())
    }
    async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
        Ok(vec![ProjectRow {
            id: self.project.clone(),
            name: "Lanternfish".into(),
            active: false,
            home: false,
        }])
    }
    async fn transcript(
        &self,
        _project: Option<&str>,
        _id: &str,
    ) -> Result<Vec<SessionEvent>, String> {
        Ok(Vec::new())
    }
    async fn send(&self, _chat: Option<&str>, _text: &str) -> Result<Handed, String> {
        Err("not the door's road".into())
    }
    async fn new_chat(&self, _project: Option<&str>, _text: &str) -> Result<Handed, String> {
        Err("not the door's road".into())
    }
    async fn rename(&self, _chat: &str, _title: &str) -> Result<(), String> {
        Ok(())
    }
    async fn open(&self, _chat: &str) -> Result<(), String> {
        Ok(())
    }
    async fn approve(&self, _req: ApproveRequest) -> Result<(), String> {
        Ok(())
    }
    async fn cancel(&self, _chat: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn events(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
    fn asset(&self, _path: &str) -> Option<Asset> {
        None
    }
    fn kind(&self) -> &'static str {
        "serve"
    }
    async fn running(&self) -> Result<Running, String> {
        Ok(Running {
            chats: self
                .running
                .lock()
                .unwrap()
                .iter()
                .map(|(chat, waiting)| RunningChat {
                    chat: Some(chat.clone()),
                    project: None,
                    title: String::new(),
                    since: None,
                    on_screen: false,
                    waiting: *waiting,
                })
                .collect(),
            ..Running::default()
        })
    }
    async fn limit_pause(&self) -> Option<LimitPause> {
        self.paused.lock().unwrap().clone().map(|chat| LimitPause {
            chat: Some(chat),
            resets_at: Some(1_795_000_000),
            window: Some("five_hour".into()),
            text: String::new(),
            subagents: Vec::new(),
            resume_at: None,
        })
    }
    async fn job_prepare(&self, prep: Prep) -> Result<String, String> {
        self.prepared.lock().unwrap().push(prep.clone());
        let dir = sessions(&self.config, prep.project.as_deref().unwrap());
        match prep.chat {
            Some(chat) => Ok(chat),
            None => {
                let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
                s.record_title_by(prep.title, TitleBy::User);
                Ok(s.id.clone())
            }
        }
    }
    async fn job_send(
        &self,
        project: Option<&str>,
        chat: &str,
        text: &str,
    ) -> Result<Handed, String> {
        let path = sessions(&self.config, project.unwrap()).join(format!("{chat}.jsonl"));
        Session::load(&path).unwrap().record_user(text);
        if self.turn == Turn::Nothing {
            return Ok(Handed::Sent);
        }
        *self.running.lock().unwrap() = Some((chat.to_string(), 0));
        let (turn, running, text) = (self.turn, self.running.clone(), text.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            match turn {
                Turn::Replies => {
                    reply(&mut Session::load(&path).unwrap(), &format!("echo: {text}"));
                    *running.lock().unwrap() = None;
                }
                Turn::Asks => {
                    if let Some(r) = running.lock().unwrap().as_mut() {
                        r.1 = 1;
                    }
                }
                _ => *running.lock().unwrap() = None,
            }
        });
        Ok(Handed::Sent)
    }
}

/// A home with a door open over a fake host.
fn open(name: &str, turn: Turn) -> (PathBuf, String, Arc<FakeHost>) {
    let (config, project) = home(name);
    let host = FakeHost::new(&config, &project, turn);
    server::open(&config, host.clone()).unwrap();
    (config, project, host)
}

fn quick() -> (Duration, Duration) {
    (Duration::from_millis(15), Duration::from_millis(400))
}

async fn wait_for(config: &Path, sent: &Sent) -> Waited {
    let (poll, grace) = quick();
    client::wait_with(
        config,
        &sent.chat,
        Some(sent.replies),
        Duration::from_secs(5),
        Some(1),
        poll,
        grace,
    )
    .await
}

fn start(text: &str) -> Request {
    Request::Start {
        project: "lanternfish".into(),
        text: text.into(),
        title: None,
        read_only: false,
        by: "a  test\nscript".into(),
    }
}

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

#[test]
fn the_switch_is_off_until_set_and_survives_a_read() {
    let (config, _) = home("switch");
    assert!(!access(&config).writes, "read-only by default");
    set_access(&config, Access { writes: true }).unwrap();
    assert!(access(&config).writes);
    std::fs::write(config.join(DIR).join("access.json"), "not json").unwrap();
    assert!(!access(&config).writes, "an unreadable switch is off");
    let _ = std::fs::remove_dir_all(&config);
}

#[test]
fn a_who_is_one_short_line() {
    assert_eq!(clean_by("  a  test\nscript "), "a test script");
    assert_eq!(clean_by("\u{7}"), "outside");
    assert_eq!(clean_by(&"x".repeat(90)).chars().count(), 40);
}

#[test]
fn a_project_is_named_by_id_name_or_the_start_of_one() {
    let ps = vec![
        ("p1".to_string(), "Nightloom".to_string()),
        ("p2".to_string(), "Nightshift".to_string()),
    ];
    assert_eq!(pick_project(&ps, "p2").unwrap().1, "Nightshift");
    assert_eq!(pick_project(&ps, "nightloom").unwrap().0, "p1");
    assert_eq!(pick_project(&ps, "nightsh").unwrap().0, "p2");
    let both = pick_project(&ps, "night").unwrap_err();
    assert!(both.contains("p1") && both.contains("p2"), "{both}");
    let none = pick_project(&ps, "zebra").unwrap_err();
    assert!(none.contains("Nightloom, Nightshift"), "{none}");
}

#[test]
fn reads_work_from_the_disk_and_never_serve_an_incognito_chat() {
    let (config, project) = home("reads");
    let dir = sessions(&config, &project);
    let id = chat(&dir, "Parsnips", "how do parsnips grow", "slowly, in sand");
    let hidden = {
        let mut s = Session::start(&dir, ChatMode::Incognito, ChatKind::Build).unwrap();
        s.record_user("a secret");
        s.id.clone()
    };
    let unfiled = config.join(crate::capture::UNFILED).join(SESSIONS_DIR);
    let loose = chat(&unfiled, "Loose", "hello", "hi");

    let all = list(&config, None, None, &Live::default()).unwrap();
    let ids: Vec<&str> = all.chats.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&id.as_str()) && ids.contains(&loose.as_str()));
    assert!(!ids.contains(&hidden.as_str()), "incognito is not listed");
    assert!(!all.writes && all.holder.is_none());
    let one = list(&config, Some("LANTERN"), None, &Live::default()).unwrap();
    assert_eq!(one.chats.len(), 1);
    assert_eq!(one.chats[0].project.as_deref(), Some("Lanternfish"));

    // A prefix finds it; the view holds the conversation, not a tool's.
    let v = show(&config, &id[..8], None, &Live::default()).unwrap();
    assert_eq!(v.line.title, "Parsnips");
    assert_eq!((v.replies, v.messages.len()), (1, 2));
    assert_eq!(v.last_reply().unwrap().text, "slowly, in sand");
    assert_eq!(v.line.state, State::Idle);
    assert!(
        show(&config, &hidden, None, &Live::default())
            .unwrap_err()
            .contains("incognito")
    );
    assert!(
        find(&config, "../registry").is_err(),
        "an id is never a path"
    );
    assert!(find(&config, "zzzz").unwrap_err().contains("no chat"));

    // What the holder knows is laid over the disk's rows.
    let live = Live {
        running: vec![(id.clone(), 2)],
        paused: None,
        holder: Some("mac".into()),
    };
    let v = show(&config, &id, Some(1), &live).unwrap();
    assert_eq!(v.line.state, State::Waiting);
    assert!(v.line.needs.unwrap().starts_with("2 prompts are"));
    assert_eq!((v.messages.len(), v.messages_total), (1, 2));
    let _ = std::fs::remove_dir_all(&config);
}

#[tokio::test]
async fn with_nothing_holding_the_home_reads_answer_and_writes_say_why() {
    let (config, project) = home("nobody");
    let id = chat(&sessions(&config, &project), "T", "q", "a");
    let l: Listing = client::ask_as(
        &config,
        &Request::List {
            project: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(l.chats.len(), 1);
    assert!(l.holder.is_none());
    let s: Status = client::ask_as(&config, &Request::Status { chat: id.clone() })
        .await
        .unwrap();
    assert_eq!(s.state, State::Idle);
    // Off: the switch is named. On: the missing holder is.
    let e = client::ask(&config, &start("go")).await.unwrap_err();
    assert_eq!(e, WRITES_OFF);
    set_access(&config, Access { writes: true }).unwrap();
    let e = client::ask(&config, &start("go")).await.unwrap_err();
    assert_eq!(e, NO_HOLDER);
    let out = cli::run(&config, &args(&["send", &id, "more"])).await;
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("not running"), "{}", out.stderr);
    let _ = std::fs::remove_dir_all(&config);
}

#[cfg(unix)] // opens the door's Unix socket
#[tokio::test]
async fn a_write_is_refused_until_he_switches_it_on_then_starts_marked_and_replies() {
    let (config, project, host) = open("start", Turn::Replies);
    let e = client::ask(&config, &start("count the parsnips"))
        .await
        .unwrap_err();
    assert_eq!(e, WRITES_OFF);
    assert!(host.prepared.lock().unwrap().is_empty(), "nothing was made");

    set_access(&config, Access { writes: true }).unwrap();
    let sent: Sent = client::ask_as(&config, &start("count the parsnips\nall of them"))
        .await
        .unwrap();
    assert_eq!(sent.project.as_deref(), Some("Lanternfish"));
    let prep = host.prepared.lock().unwrap()[0].clone();
    assert_eq!(prep.project.as_deref(), Some(project.as_str()));
    assert_eq!(prep.title, "count the parsnips");
    assert!(!prep.read_only);
    assert_eq!(started(&config)[&sent.chat].by, "a test script");

    let Waited::Replied(v) = wait_for(&config, &sent).await else {
        panic!("the reply did not arrive");
    };
    assert_eq!(
        v.last_reply().unwrap().text,
        "echo: count the parsnips\nall of them"
    );
    assert_eq!(v.line.started_by.as_deref(), Some("a test script"));
    assert_eq!(v.holder.as_deref(), Some("serve"));

    // A second message into it keeps its kind, and its reply is the new one.
    let again: Sent = client::ask_as(
        &config,
        &Request::Send {
            chat: sent.chat[..8].to_string(),
            text: "and the carrots".into(),
            by: String::new(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (again.chat.as_str(), again.replies),
        (sent.chat.as_str(), 1)
    );
    let prep = host.prepared.lock().unwrap()[1].clone();
    assert_eq!(prep.chat.as_deref(), Some(sent.chat.as_str()));
    assert!(!prep.read_only);
    let Waited::Replied(v) = wait_for(&config, &again).await else {
        panic!("the second reply did not arrive");
    };
    assert_eq!(v.last_reply().unwrap().text, "echo: and the carrots");
    let l: Listing = client::ask_as(
        &config,
        &Request::List {
            project: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    assert!(l.writes);
    assert_eq!(l.chats[0].started_by.as_deref(), Some("a test script"));
    let _ = std::fs::remove_dir_all(&config);
}

#[cfg(unix)] // opens the door's Unix socket
#[tokio::test]
async fn a_wait_ends_needing_him_failed_or_still_running() {
    // The chat asks: exit 2, and a send into it is refused, not queued.
    let (config, _, host) = open("asks", Turn::Asks);
    set_access(&config, Access { writes: true }).unwrap();
    let sent: Sent = client::ask_as(&config, &start("delete the shed"))
        .await
        .unwrap();
    let w = wait_for(&config, &sent).await;
    assert_eq!(w.exit_code(), 2);
    let Waited::NeedsHim(v) = w else { panic!() };
    assert!(v.line.needs.unwrap().starts_with("1 prompt is waiting"));
    let e = client::ask(
        &config,
        &Request::Send {
            chat: sent.chat.clone(),
            text: "hurry".into(),
            by: String::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e, RUNNING);
    // The usage limit is the same exit, with its own sentence.
    *host.running.lock().unwrap() = None;
    *host.paused.lock().unwrap() = Some(sent.chat.clone());
    let Waited::NeedsHim(v) = wait_for(&config, &sent).await else {
        panic!()
    };
    assert_eq!(v.line.state, State::Paused);
    assert!(v.line.needs.unwrap().contains("usage limit"));
    let _ = std::fs::remove_dir_all(&config);

    // The turn ends with nothing said: exit 1.
    let (config, _, _) = open("dies", Turn::Dies);
    set_access(&config, Access { writes: true }).unwrap();
    let sent: Sent = client::ask_as(&config, &start("x")).await.unwrap();
    let w = wait_for(&config, &sent).await;
    assert!(
        matches!(&w, Waited::Failed(e) if e.contains("without a reply")),
        "{w:?}"
    );
    assert_eq!(w.exit_code(), 1);
    let _ = std::fs::remove_dir_all(&config);

    // No turn starts: exit 1 once the grace is over, not before.
    let (config, _, _) = open("nothing", Turn::Nothing);
    set_access(&config, Access { writes: true }).unwrap();
    let sent: Sent = client::ask_as(&config, &start("x")).await.unwrap();
    let w = wait_for(&config, &sent).await;
    assert!(
        matches!(&w, Waited::Failed(e) if e.contains("no turn started")),
        "{w:?}"
    );
    let _ = std::fs::remove_dir_all(&config);

    // Still running at the timeout: exit 3, the chat untouched.
    let (config, project, host) = open("long", Turn::Replies);
    let id = chat(&sessions(&config, &project), "Long", "q", "a");
    *host.running.lock().unwrap() = Some((id.clone(), 0));
    let w = client::wait_with(
        &config,
        &id,
        None,
        Duration::from_millis(80),
        None,
        Duration::from_millis(15),
        Duration::from_millis(400),
    )
    .await;
    assert_eq!(w.exit_code(), 3);
    let _ = std::fs::remove_dir_all(&config);
}

#[test]
fn the_command_line_parses_and_never_exits_two_for_a_typo() {
    let p = cli::parse(&args(&[
        "start",
        "Lanternfish",
        "do it",
        "--wait",
        "--as",
        "night",
        "--read-only",
    ]))
    .unwrap();
    assert!(p.wait && !p.json);
    assert_eq!(
        p.what,
        cli::What::Start {
            project: "Lanternfish".into(),
            text: "do it".into(),
            title: None,
            read_only: true,
            by: Some("night".into()),
        }
    );
    // `-` is a prompt (standard input), and `--` ends the flags.
    let p = cli::parse(&args(&["send", "abc", "--", "--json"])).unwrap();
    assert_eq!(
        p.what,
        cli::What::Send {
            chat: "abc".into(),
            text: "--json".into(),
            by: None
        }
    );
    let p = cli::parse(&args(&["send", "abc", "-"])).unwrap();
    assert!(matches!(p.what, cli::What::Send { text, .. } if text == "-"));
    assert_eq!(
        cli::parse(&args(&["show", "abc", "--all"])).unwrap().what,
        cli::What::Show {
            chat: "abc".into(),
            last: Some(usize::MAX)
        }
    );
    assert_eq!(cli::parse(&[]).unwrap().what, cli::What::Help);
    assert_eq!(
        cli::parse(&args(&["start", "--help"])).unwrap().what,
        cli::What::Help
    );
    for bad in [
        &["start", "P"][..],
        &["frob"],
        &["list", "--nope"],
        &["start", "P", "a", "b"],
        &["show", "x", "--last", "many"],
    ] {
        assert!(cli::parse(&args(bad)).is_err(), "{bad:?}");
    }
}

#[cfg(unix)] // opens the door's Unix socket
#[tokio::test]
async fn the_command_line_starts_waits_and_prints_the_reply() {
    let (config, project, _) = open("cli", Turn::Replies);
    let before = chat(&sessions(&config, &project), "Before", "q", "a");
    let out = cli::run(&config, &args(&["list"])).await;
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains(&before) && out.stdout.contains("Lanternfish"));
    assert!(
        out.stdout.ends_with(
            "Read only: start and send are off (Nightloom's Settings → Outside control)."
        ),
        "{}",
        out.stdout
    );
    assert!(
        out.stdout.contains(" AM  ") || out.stdout.contains(" PM  "),
        "12-hour: {}",
        out.stdout
    );

    let out = cli::run(&config, &args(&["start", "Lanternfish", "hello"])).await;
    assert_eq!((out.code, out.stdout.as_str()), (1, ""));
    assert!(out.stderr.contains("Settings → Outside control"));

    set_access(&config, Access { writes: true }).unwrap();
    let out = cli::run(
        &config,
        &args(&["start", "Lanternfish", "hello", "--as", "nightshift"]),
    )
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    let id = out.stdout.clone();
    assert!(store::is_log_id(&id) && out.stderr.starts_with("started in Lanternfish"));
    let out = cli::run(&config, &args(&["show", &id, "--wait"])).await;
    assert_eq!(out.code, 0);
    assert!(
        out.stdout.contains("echo: hello")
            && out.stdout.contains("started from outside by nightshift")
    );

    let out = cli::run(&config, &args(&["send", &id, "again", "--wait", "--json"])).await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    let v: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(v["outcome"], "replied");
    assert_eq!(v["reply"], "echo: again");
    assert_eq!(v["chat"], id.as_str());
    let out = cli::run(&config, &args(&["start", "Nowhere", "hello"])).await;
    assert!(out.code == 1 && out.stderr.contains("no project called"));
    let _ = std::fs::remove_dir_all(&config);
}

#[cfg(unix)] // opens the door's Unix socket
#[tokio::test]
async fn the_four_tools_list_show_start_and_send() {
    use nightloom_core::tool::CancellationToken;
    use serde_json::json;
    let (config, _, _) = open("tools", Turn::Replies);
    let tools = tools::tools(config.clone(), Some("Claude desktop".into()));
    let names: Vec<String> = tools.iter().map(|t| t.def().name).collect();
    assert_eq!(names, ["chat_list", "chat_show", "chat_start", "chat_send"]);
    let c = CancellationToken::new();
    let by = |n: &str| tools.iter().find(|t| t.def().name == n).unwrap();

    // Listed always; refused, with where the switch is, until it is on.
    let e = by("chat_start")
        .call(json!({"project": "Lanternfish", "prompt": "hi"}), &c)
        .await
        .unwrap_err();
    assert_eq!(e, WRITES_OFF);
    set_access(&config, Access { writes: true }).unwrap();
    let out = by("chat_start")
        .call(
            json!({"project": "Lanternfish", "prompt": "hi", "wait_seconds": 5}),
            &c,
        )
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        (v["outcome"].as_str(), v["reply"].as_str()),
        (Some("replied"), Some("echo: hi"))
    );
    let id = v["chat"].as_str().unwrap().to_string();
    assert_eq!(started(&config)[&id].by, "Claude desktop");

    let out = by("chat_send")
        .call(json!({"chat": id, "message": "more"}), &c)
        .await
        .unwrap();
    assert!(out.contains("\"outcome\": \"sent\""), "{out}");
    let out = by("chat_show")
        .call(json!({"chat": id, "wait_seconds": 5}), &c)
        .await
        .unwrap();
    assert!(out.contains("echo: more"), "{out}");
    let out = by("chat_list").call(json!({}), &c).await.unwrap();
    assert!(
        out.contains(&id) && out.contains("\"writes\": true"),
        "{out}"
    );
    assert!(
        by("chat_show")
            .call(json!({}), &c)
            .await
            .unwrap_err()
            .contains("chat is required")
    );
    let _ = std::fs::remove_dir_all(&config);
}

#[tokio::test]
async fn mcp_serve_outside_serves_the_four_and_says_what_they_are() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (config, _) = home("mcp");
    let mut a =
        crate::mcp_server::parse_args(&args(&["--outside", "--as", "Claude desktop"])).unwrap();
    assert!(a.outside && a.outside_as.as_deref() == Some("Claude desktop"));
    a.project = None;
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(crate::mcp_server::serve(config.clone(), a, sr, sw));
    let (cr, mut cw) = tokio::io::split(client_io);
    let mut lines = BufReader::new(cr).lines();
    for line in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
    ] {
        cw.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }
    let init: serde_json::Value =
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert!(
        init["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("Outside control")
    );
    let listed: serde_json::Value =
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["chat_list", "chat_show", "chat_start", "chat_send"]);
    let _ = std::fs::remove_dir_all(&config);
}

/// Not a test: the end-to-end run's home. With `NL767_E2E_HOME` set, makes
/// that folder a Nightloom home with one project, "Scratch", whose
/// workspace is `<home>-work`. Does nothing otherwise.
#[test]
#[ignore = "fixture for the end-to-end run"]
fn make_the_end_to_end_home() {
    let Ok(dir) = std::env::var("NL767_E2E_HOME") else {
        return;
    };
    let config = PathBuf::from(dir);
    std::fs::create_dir_all(&config).unwrap();
    let work = PathBuf::from(format!("{}-work", config.display()));
    std::fs::create_dir_all(&work).unwrap();
    let mut registry = Registry::load_in(&config);
    registry.create("Scratch", Some(work), None).unwrap();
}
