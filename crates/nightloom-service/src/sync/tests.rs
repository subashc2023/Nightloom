//! The sync over loopback: a real listener (`Server::start_for_test`) with
//! a sync home, the Mac's push and pull through [`Client`], and scratch
//! folders for both machines. No network beyond 127.0.0.1; no real model.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use nightloom_core::{ChatKind, ChatMode, Session, SessionEvent};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use super::fork::{self, rewrite_cli};
use super::pull::{self, MacSide};
use super::push::{self, MacSnapshot, PushCache};
use super::*;
use crate::agent::cli_session::{self, MEASURED_VERSION};
use crate::agent_turn::AGENT;
use crate::project::Project;
use crate::remote::{
    ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState, Server,
};

const TOKEN: &str = "test-token-not-a-secret";

fn scratch(name: &str) -> PathBuf {
    crate::project::set_config_dir(
        std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
    );
    let dir = std::env::temp_dir().join(format!("nl-sync-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A Claude Code session file of the measured shape, dummy content: two
/// nodes and a bookkeeping line, every node in `cwd`, plus a sidechain
/// node in a subfolder and one elsewhere.
fn cli_fixture(sid: &str, cwd: &str) -> String {
    let node = |uuid: &str, parent: Option<&str>, kind: &str, at: &str, text: &str| {
        json!({
            "parentUuid": parent, "isSidechain": false, "type": kind, "uuid": uuid,
            "timestamp": "2026-09-30T10:00:00.000Z", "userType": "external",
            "cwd": at, "sessionId": sid, "version": MEASURED_VERSION,
            "message": { "role": kind, "content": text },
        })
        .to_string()
    };
    [
        node("u1", None, "user", cwd, "hello"),
        node("a1", Some("u1"), "assistant", cwd, "hi"),
        node(
            "a2",
            Some("a1"),
            "assistant",
            &format!("{cwd}/sub"),
            "in a subfolder",
        ),
        node("a3", Some("a2"), "assistant", "/elsewhere", "elsewhere"),
        json!({"type": "last-prompt", "lastPrompt": "hello", "sessionId": sid}).to_string(),
    ]
    .join("\n")
        + "\n"
}

/// A Nightloom log in `dir` naming CLI session `sid`.
fn chat_with_cli(dir: &Path, sid: &str) -> Session {
    let mut s = Session::start(dir, ChatMode::Normal, ChatKind::Build).unwrap();
    s.record_user("hello from a test");
    s.record_agent_session(AGENT, sid);
    s
}

fn project(id: &str, name: &str, workspace: &Path, away: bool) -> Project {
    Project {
        id: id.into(),
        name: name.into(),
        workspace: Some(workspace.to_path_buf()),
        source: None,
        extra_folders: Vec::new(),
        available_away: away,
        created: Utc::now(),
        last_opened: Utc::now(),
    }
}

/// Every file under `root`, relative.
fn tree(root: &Path) -> BTreeSet<PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().strip_prefix(root).unwrap().to_path_buf())
        .collect()
}

/// A host that serves nothing but its sync home.
struct SyncOnly(Arc<SyncServer>, broadcast::Sender<Event>);

#[async_trait::async_trait]
impl Host for SyncOnly {
    async fn state(&self) -> RemoteState {
        RemoteState::default()
    }
    async fn chats(&self, _: Option<&str>) -> Result<Vec<ChatRow>, String> {
        Ok(Vec::new())
    }
    async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
        Ok(Vec::new())
    }
    async fn transcript(&self, _: Option<&str>, _: &str) -> Result<Vec<SessionEvent>, String> {
        Err("no".into())
    }
    async fn send(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("no".into())
    }
    async fn new_chat(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("no".into())
    }
    async fn rename(&self, _: &str, _: &str) -> Result<(), String> {
        Err("no".into())
    }
    async fn open(&self, _: &str) -> Result<(), String> {
        Err("no".into())
    }
    async fn approve(&self, _: ApproveRequest) -> Result<(), String> {
        Err("no".into())
    }
    async fn cancel(&self, _: Option<&str>) -> Result<(), String> {
        Err("no".into())
    }
    fn events(&self) -> broadcast::Receiver<Event> {
        self.1.subscribe()
    }
    fn asset(&self, _: &str) -> Option<Asset> {
        None
    }
    fn sync(&self) -> Option<Arc<SyncServer>> {
        Some(self.0.clone())
    }
}

async fn listen(sync: Arc<SyncServer>) -> (Server, Client) {
    let (tx, _) = broadcast::channel(4);
    let server = Server::start_for_test(
        "127.0.0.1:0".parse().unwrap(),
        TOKEN.into(),
        Arc::new(SyncOnly(sync, tx)),
    )
    .await
    .unwrap();
    let client = Client::new(&format!("http://{}", server.addr()), TOKEN).unwrap();
    (server, client)
}

/// The Mac's side for a test: a config, a vault, a CLI folder, projects.
struct Mac {
    root: PathBuf,
    snap: MacSnapshot,
}

fn mac(root: &Path, projects: Vec<Project>) -> Mac {
    let config = root.join("config");
    let vault = config.join("knowledge");
    fs::create_dir_all(vault.join("topic")).unwrap();
    fs::write(config.join("AGENTS.md"), "user memory").unwrap();
    fs::write(vault.join("topic").join("note.md"), "a vault note").unwrap();
    fs::write(vault.join(".hidden"), "never sent").unwrap();
    Mac {
        root: root.to_path_buf(),
        snap: MacSnapshot {
            config,
            vault,
            projects,
            claude_projects: root.join("claude-projects"),
        },
    }
}

/// Push into a loopback listener: only `mirror/` changes on the server,
/// the second push of an unchanged snapshot sends nothing, a changed log is
/// the one file sent, and an unmarked project sends nothing at all.
#[tokio::test]
async fn a_push_writes_only_under_mirror_sends_only_changes_and_nothing_unmarked() {
    let root = scratch("push");
    let ws_marked = root.join("ws-marked");
    let ws_unmarked = root.join("ws-unmarked");
    fs::create_dir_all(&ws_marked).unwrap();
    fs::create_dir_all(&ws_unmarked).unwrap();
    fs::write(ws_marked.join("AGENTS.md"), "project memory").unwrap();
    fs::write(ws_unmarked.join("AGENTS.md"), "SECRET-PROJECT memory").unwrap();
    let marked = project(
        &uuid::Uuid::new_v4().to_string(),
        "Marked",
        &ws_marked,
        true,
    );
    let unmarked_id = uuid::Uuid::new_v4().to_string();
    let unmarked = project(&unmarked_id, "SECRET-PROJECT", &ws_unmarked, false);
    let m = mac(&root, vec![marked.clone(), unmarked.clone()]);

    // A chat in each, each with a CLI file; an incognito chat in the marked one.
    let sid = uuid::Uuid::new_v4().to_string();
    let chat = chat_with_cli(&marked.session_dir(), &sid);
    let slug = cli_session::project_folder(&ws_marked);
    fs::create_dir_all(m.snap.claude_projects.join(&slug)).unwrap();
    fs::write(
        m.snap
            .claude_projects
            .join(&slug)
            .join(format!("{sid}.jsonl")),
        cli_fixture(&sid, &ws_marked.to_string_lossy()),
    )
    .unwrap();
    let secret_sid = uuid::Uuid::new_v4().to_string();
    let secret_chat = chat_with_cli(&unmarked.session_dir(), &secret_sid);
    let mut incognito =
        Session::start(marked.session_dir(), ChatMode::Incognito, ChatKind::Build).unwrap();
    incognito.record_user("incognito words");

    let home = root.join("server-home");
    fs::create_dir_all(home.join("projects")).unwrap();
    fs::write(home.join("holder.lock"), "serve").unwrap();
    let before = tree(&home);
    let sync = Arc::new(SyncServer::new(&home, root.join("server-claude")));
    let (server, client) = listen(sync.clone()).await;

    let mut cache = PushCache::default();
    let mut skipped = Vec::new();
    let out = push::collect(&m.snap, &mut cache, &mut skipped);
    assert!(skipped.is_empty(), "{skipped:?}");
    let paths: Vec<&str> = out.iter().map(|o| o.entry.path.as_str()).collect();
    for p in &paths {
        assert!(!p.contains(&unmarked_id), "an unmarked project's file: {p}");
        assert!(
            !p.contains(&secret_chat.id),
            "an unmarked project's chat: {p}"
        );
        assert!(!p.contains(&incognito.id), "an incognito chat: {p}");
        assert!(
            !p.contains(&secret_sid),
            "an unmarked project's CLI file: {p}"
        );
    }
    let report = push::send(&client, out, skipped).await.unwrap();
    assert_eq!(report.sent, report.files);
    assert_eq!(report.removed, 0);

    // Only `mirror/` changed.
    let after = tree(&home);
    let new: Vec<&PathBuf> = after.difference(&before).collect();
    assert!(!new.is_empty());
    for p in &new {
        assert!(
            p.starts_with(MIRROR_DIR),
            "written outside mirror/: {}",
            p.display()
        );
    }
    let mirror = home.join(MIRROR_DIR);
    let base = format!("projects/{}", marked.id);
    for want in [
        "AGENTS.md".to_string(),
        "knowledge/topic/note.md".into(),
        "projects.json".into(),
        format!("{base}/AGENTS.md"),
        format!("{base}/sessions/{}.jsonl", chat.id),
        format!("claude/{slug}/{sid}.jsonl"),
    ] {
        assert!(mirror.join(&want).is_file(), "missing {want}");
    }
    assert!(!mirror.join("knowledge/.hidden").exists());
    // Byte for byte, and read-only.
    assert_eq!(
        fs::read(mirror.join(format!("{base}/sessions/{}.jsonl", chat.id))).unwrap(),
        fs::read(chat.log_path().unwrap()).unwrap()
    );
    assert!(
        fs::metadata(mirror.join("AGENTS.md"))
            .unwrap()
            .permissions()
            .readonly()
    );
    // Nothing of the unmarked project anywhere on the server.
    for p in tree(&home) {
        let text = fs::read_to_string(home.join(&p)).unwrap_or_default();
        assert!(!text.contains("SECRET-PROJECT"), "{}", p.display());
        assert!(!p.to_string_lossy().contains(&unmarked_id));
    }
    assert_eq!(
        Layout::new(&home).projects(),
        vec![MirrorProject {
            id: marked.id.clone(),
            name: "Marked".into()
        }]
    );

    // Unchanged: the manifest goes, no file follows.
    let mut skipped = Vec::new();
    let again = push::collect(&m.snap, &mut cache, &mut skipped);
    let report = push::send(&client, again, skipped).await.unwrap();
    assert_eq!(report.sent, 0);

    // One chat grows: it alone is sent.
    let mut chat = Session::load(chat.log_path().unwrap()).unwrap();
    chat.record_user("a second message");
    let mut skipped = Vec::new();
    let third = push::collect(&m.snap, &mut cache, &mut skipped);
    let report = push::send(&client, third, skipped).await.unwrap();
    assert_eq!(report.sent, 1);
    assert_eq!(
        fs::read(mirror.join(format!("{base}/sessions/{}.jsonl", chat.id))).unwrap(),
        fs::read(chat.log_path().unwrap()).unwrap()
    );

    // He unmarks the project: its copies leave the server at the next push.
    let mut unmarked_now = m.snap.clone();
    unmarked_now.projects[0].available_away = false;
    let mut skipped = Vec::new();
    let fourth = push::collect(&unmarked_now, &mut cache, &mut skipped);
    let report = push::send(&client, fourth, skipped).await.unwrap();
    assert!(report.removed >= 3, "{report:?}");
    assert!(!mirror.join(&base).exists());
    assert!(mirror.join("AGENTS.md").is_file());

    // A wrong token is refused before anything is read.
    let bad = Client::new(&format!("http://{}", server.addr()), "wrong").unwrap();
    let err = push::send(&bad, Vec::new(), Vec::new()).await.unwrap_err();
    assert!(err.contains("refused the token"), "{err}");
    server.stop().await;
    let _ = m.root;
    fs::remove_dir_all(&root).ok();
}

/// The Mac's model list (item 272) goes up as `mirror/model-list.json`,
/// byte for byte, even with no project marked; a change is sent again; a
/// list deleted on the Mac leaves the server at the next push.
#[tokio::test]
async fn the_model_list_goes_up_as_is_and_leaves_when_the_mac_drops_it() {
    let root = scratch("models");
    let m = mac(&root, Vec::new());
    let list = m.snap.config.join(MODEL_LIST_FILE);
    fs::write(&list, r#"{"models": ["opus", "a-fake-model"]}"#).unwrap();

    let home = root.join("server-home");
    fs::create_dir_all(&home).unwrap();
    let sync = Arc::new(SyncServer::new(&home, root.join("server-claude")));
    let (server, client) = listen(sync).await;
    let mirrored = home.join(MIRROR_DIR).join("model-list.json");

    let mut cache = PushCache::default();
    let mut skipped = Vec::new();
    let out = push::collect(&m.snap, &mut cache, &mut skipped);
    assert!(skipped.is_empty(), "{skipped:?}");
    assert!(out.iter().any(|o| o.entry.path == "model-list.json"));
    push::send(&client, out, skipped).await.unwrap();
    assert_eq!(fs::read(&mirrored).unwrap(), fs::read(&list).unwrap());

    // Changed on the Mac: it alone is sent.
    fs::write(&list, r#"{"models": ["sonnet"], "away_default": "sonnet"}"#).unwrap();
    let mut skipped = Vec::new();
    let out = push::collect(&m.snap, &mut cache, &mut skipped);
    let report = push::send(&client, out, skipped).await.unwrap();
    assert_eq!(report.sent, 1);
    assert_eq!(fs::read(&mirrored).unwrap(), fs::read(&list).unwrap());

    // Gone from the Mac: gone from the server.
    fs::remove_file(&list).unwrap();
    let mut skipped = Vec::new();
    let out = push::collect(&m.snap, &mut cache, &mut skipped);
    let report = push::send(&client, out, skipped).await.unwrap();
    assert_eq!(report.removed, 1, "{report:?}");
    assert!(!mirrored.exists());

    server.stop().await;
    fs::remove_dir_all(&root).ok();
}

/// The server refuses a path outside the mirror's shapes and a body whose
/// hash does not match.
#[test]
fn the_server_refuses_odd_paths_and_bad_hashes() {
    let root = scratch("refuse");
    let sync = SyncServer::new(root.join("home"), root.join("claude"));
    for bad in [
        "../escape",
        "projects/p/sessions/../../x.jsonl",
        "holder.lock",
        "projects/p/notes.md",
        "projects/p/sessions/.listing.json",
        "claude/x/y/z.jsonl",
    ] {
        assert!(
            sync.put(bad, &manifest::sha256_hex(b"x"), b"x").is_err(),
            "{bad}"
        );
    }
    assert!(matches!(
        sync.put("AGENTS.md", &manifest::sha256_hex(b"other"), b"x"),
        Err(mirror::PutError::Hash)
    ));
    assert!(
        sync.put("AGENTS.md", &manifest::sha256_hex(b"x"), b"x")
            .is_ok()
    );
    assert_eq!(tree(&root.join("home")).len(), 2); // the file and the index
    fs::remove_dir_all(&root).ok();
}

/// Outbox → pull → ack: a chat started on the server comes to the Mac's
/// project with its CLI file under the Mac's folder and its `cwd` fields
/// rewritten; the server's copy goes read-only and leaves the outbox; a
/// Mac file in the way is never overwritten; a running chat waits.
#[tokio::test]
async fn outbox_pull_ack_round_trip_never_overwrites_and_leaves_the_server_copy_read_only() {
    let root = scratch("pull");
    let home = root.join("server-home");
    let server_claude = root.join("server-claude");
    let pid = uuid::Uuid::new_v4().to_string();
    let server_ws = PathBuf::from("/srv/nightloom/ws").join(&pid);

    // On the server: a chat in project `pid`, its CLI file in the server's folder.
    let sessions = home.join("projects").join(&pid).join("sessions");
    let sid = uuid::Uuid::new_v4().to_string();
    let chat = chat_with_cli(&sessions, &sid);
    let slug = cli_session::project_folder(&server_ws);
    fs::create_dir_all(server_claude.join(&slug)).unwrap();
    let server_cli = server_claude.join(&slug).join(format!("{sid}.jsonl"));
    fs::write(&server_cli, cli_fixture(&sid, &server_ws.to_string_lossy())).unwrap();
    // A second chat whose id the Mac already has (with other contents).
    let clash = chat_with_cli(&sessions, &uuid::Uuid::new_v4().to_string());
    // A third chat, running a turn now.
    let running = chat_with_cli(&home.join("unfiled").join("sessions"), "run-1");

    let busy_id = running.id.clone();
    let busy: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(Some(busy_id.clone())));
    let b = busy.clone();
    let sync = Arc::new(SyncServer::new(&home, &server_claude).with_busy(Arc::new(
        move |c: &str| b.lock().unwrap().as_deref() == Some(c),
    )));
    let (server, client) = listen(sync.clone()).await;

    let outbox = sync.outbox().unwrap();
    let ids: Vec<&str> = outbox.iter().map(|e| e.chat.as_str()).collect();
    assert!(ids.contains(&chat.id.as_str()) && ids.contains(&clash.id.as_str()));
    assert!(!ids.contains(&busy_id.as_str()), "a running chat waits");

    // On the Mac: the same project, in its own folder; the clash in the way.
    let mac_ws = root.join("mac-ws");
    fs::create_dir_all(&mac_ws).unwrap();
    let mac_project = project(&pid, "Shared", &mac_ws, true);
    fs::create_dir_all(mac_project.session_dir()).unwrap();
    let in_the_way = mac_project
        .session_dir()
        .join(format!("{}.jsonl", clash.id));
    fs::write(&in_the_way, "the Mac's own file\n").unwrap();
    let side = MacSide {
        projects: vec![mac_project.clone()],
        unfiled_sessions: root.join("mac-unfiled"),
        claude_projects: root.join("mac-claude"),
        chat_dir: Some(root.join("mac-chat")),
        unfiled_cwd: root.join("mac-home"),
    };
    let report = pull::run(&client, &side).await.unwrap();
    assert_eq!(report.placed.len(), 1, "{report:?}");
    assert_eq!(report.skipped.len(), 1, "{report:?}");
    assert!(report.skipped[0].contains("left as it is"), "{report:?}");
    assert_eq!(fs::read(&in_the_way).unwrap(), b"the Mac's own file\n");

    // The log, byte for byte, in the Mac's project.
    let placed = &report.placed[0];
    assert_eq!(
        placed.log,
        mac_project.session_dir().join(format!("{}.jsonl", chat.id))
    );
    assert_eq!(
        fs::read(&placed.log).unwrap(),
        fs::read(chat.log_path().unwrap()).unwrap()
    );
    // The CLI file under the Mac folder's slug, its cwd fields moved.
    let mac_cli = side
        .claude_projects
        .join(cli_session::project_folder(&mac_ws))
        .join(format!("{sid}.jsonl"));
    assert_eq!(placed.cli.as_deref(), Some(mac_cli.as_path()));
    let text = fs::read_to_string(&mac_cli).unwrap();
    let cwds: Vec<String> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mac = mac_ws.to_string_lossy().to_string();
    assert_eq!(
        cwds,
        vec![
            mac.clone(),
            mac.clone(),
            format!("{mac}/sub"),
            "/elsewhere".to_string()
        ]
    );
    assert!(!text.contains("/srv/nightloom"));
    assert!(cli_session::CliSession::parse(&text).is_ok());

    // The server: the taken chat is read-only and out of the outbox; the
    // clash and the running chat stay.
    assert!(
        fs::metadata(chat.log_path().unwrap())
            .unwrap()
            .permissions()
            .readonly()
    );
    assert!(
        !fs::metadata(clash.log_path().unwrap())
            .unwrap()
            .permissions()
            .readonly()
    );
    let left: Vec<String> = sync.outbox().unwrap().into_iter().map(|e| e.chat).collect();
    assert_eq!(left, vec![clash.id.clone()]);
    assert!(Layout::new(&home).needs_fork(chat.log_path().unwrap()));
    assert!(!Layout::new(&home).needs_fork(clash.log_path().unwrap()));

    // The running chat's turn ends: it comes down on the next pass.
    *busy.lock().unwrap() = None;
    let report = pull::run(&client, &side).await.unwrap();
    assert!(
        report.placed.iter().any(|p| p.chat == busy_id),
        "{report:?}"
    );
    assert!(
        side.unfiled_sessions
            .join(format!("{busy_id}.jsonl"))
            .is_file()
    );

    // A pass cut off before its ack places nothing twice and acks again.
    let again = pull::place(
        &side,
        &mirror::OutboxEntry {
            chat: chat.id.clone(),
            project: Some(pid.clone()),
            log_size: 0,
            log_sha256: manifest::sha256_hex(&fs::read(chat.log_path().unwrap()).unwrap()),
            cli: None,
        },
        &fs::read(chat.log_path().unwrap()).unwrap(),
        None,
    );
    assert!(again.is_ok(), "{again:?}");
    server.stop().await;
    fs::remove_dir_all(&root).ok();
}

/// A send to a mirrored chat forks it: a new server-owned chat whose log
/// names the original and whose CLI copy has a new id and the server's
/// folder; the mirrored log and CLI file stay byte-identical.
#[test]
fn a_fork_leaves_the_original_byte_identical() {
    let root = scratch("fork");
    let home = root.join("server-home");
    let layout = Layout::new(&home);
    let pid = uuid::Uuid::new_v4().to_string();
    let mac_ws = "/Users/someone/Documents/Nightloom/projects/x";
    let sid = uuid::Uuid::new_v4().to_string();
    // As a push leaves it.
    let original = chat_with_cli(&layout.sessions(&pid), &sid);
    let original_log = original.log_path().unwrap().to_path_buf();
    let mac_slug = cli_session::project_folder(Path::new(mac_ws));
    let mirrored_cli = layout.claude().join(&mac_slug).join(format!("{sid}.jsonl"));
    fs::create_dir_all(mirrored_cli.parent().unwrap()).unwrap();
    fs::write(&mirrored_cli, cli_fixture(&sid, mac_ws)).unwrap();
    let log_before = fs::read(&original_log).unwrap();
    let cli_before = fs::read(&mirrored_cli).unwrap();
    assert!(layout.needs_fork(&original_log));

    let server_claude = root.join("server-claude");
    let server_ws = root.join("server-ws");
    let sync = SyncServer::new(&home, &server_claude);
    let forked = sync.fork(Some(&pid), &original_log, &server_ws).unwrap();
    assert!(forked.warning.is_none(), "{:?}", forked.warning);

    assert_eq!(fs::read(&original_log).unwrap(), log_before);
    assert_eq!(fs::read(&mirrored_cli).unwrap(), cli_before);

    // The fork: in the server's own project folder, so it comes down.
    assert_eq!(
        forked.log,
        home.join("projects")
            .join(&pid)
            .join("sessions")
            .join(format!("{}.jsonl", forked.chat))
    );
    let session = Session::load(&forked.log).unwrap();
    assert_eq!(session.id, forked.chat);
    let from = session.forked_from().unwrap();
    assert_eq!(from.session, original.id);
    assert_eq!(from.reason.as_deref(), Some(FORK_REASON));
    let new_sid = forked.cli_session.clone().unwrap();
    assert_ne!(new_sid, sid);
    assert_eq!(session.agent_session(), Some((AGENT, new_sid.as_str())));
    assert!(!session.messages().is_empty());
    // Its CLI copy: under the server folder's slug, new id, server cwd.
    let copy = forked.cli_file.clone().unwrap();
    assert_eq!(
        copy,
        server_claude
            .join(cli_session::project_folder(&server_ws))
            .join(format!("{new_sid}.jsonl"))
    );
    let parsed = cli_session::CliSession::parse(&fs::read_to_string(&copy).unwrap()).unwrap();
    assert_eq!(parsed.id(), new_sid);
    let text = fs::read_to_string(&copy).unwrap();
    assert!(text.contains(&*server_ws.to_string_lossy()));
    assert!(!text.contains(mac_ws));
    // It is in the outbox, so it comes home beside the original.
    let outbox = sync.outbox().unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].chat, forked.chat);
    assert_eq!(outbox[0].project.as_deref(), Some(pid.as_str()));
    assert_eq!(outbox[0].cli.as_ref().unwrap().session_id, new_sid);

    // A mirrored chat whose CLI file never came still forks, with a warning.
    let lone = chat_with_cli(&layout.sessions(&pid), "missing-sid");
    let forked = sync
        .fork(Some(&pid), lone.log_path().unwrap(), &server_ws)
        .unwrap();
    assert!(forked.cli_session.is_none());
    assert!(forked.warning.unwrap().contains("did not come with it"));
    fs::remove_dir_all(&root).ok();
}

/// The path rewrite on its own: the file's own `cwd` and what is under it
/// move; anything else stays; ids change only when asked; the shape guard
/// refuses a file of another major version; untouched lines stay as bytes.
#[test]
fn the_cli_path_rewrite_moves_only_the_session_folder() {
    let text = cli_fixture("s-1", "/srv/ws");
    let moved = rewrite_cli(&text, Path::new("/Users/me/proj"), None).unwrap();
    let lines: Vec<Value> = moved
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines[0]["cwd"], "/Users/me/proj");
    assert_eq!(lines[1]["cwd"], "/Users/me/proj");
    assert_eq!(lines[2]["cwd"], "/Users/me/proj/sub");
    assert_eq!(lines[3]["cwd"], "/elsewhere");
    assert!(lines.iter().all(|l| l["sessionId"] == "s-1"));
    // The bookkeeping line had nothing to change: the same bytes.
    assert_eq!(moved.lines().nth(4), text.lines().nth(4));
    // A prefix that is not a folder boundary is not moved.
    let tricky = cli_fixture("s-1", "/srv/ws").replace("/elsewhere", "/srv/wsX");
    let moved = rewrite_cli(&tricky, Path::new("/m"), None).unwrap();
    assert!(moved.contains("\"/srv/wsX\""));
    // A new id, everywhere it is named.
    let renamed = rewrite_cli(&text, Path::new("/m"), Some("s-2")).unwrap();
    assert!(!renamed.contains("\"s-1\""));
    assert_eq!(renamed.matches("\"s-2\"").count(), 5);
    // Another major version is refused, not copied.
    let future = text.replace(MEASURED_VERSION, "3.0.0");
    assert!(rewrite_cli(&future, Path::new("/m"), None).is_err());
}

/// `place_new` never replaces: an existing different file is an error and
/// stays; the same bytes are "already there".
#[test]
fn placing_never_overwrites() {
    let root = scratch("place");
    let f = root.join("a").join("x.jsonl");
    assert_eq!(
        fork::place_new(&f, b"one").unwrap(),
        fork::Placement::Written
    );
    assert_eq!(
        fork::place_new(&f, b"one").unwrap(),
        fork::Placement::AlreadyThere
    );
    assert!(fork::place_new(&f, b"two").is_err());
    assert_eq!(fs::read(&f).unwrap(), b"one");
    // No temp file left beside it.
    assert_eq!(fs::read_dir(root.join("a")).unwrap().count(), 1);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn the_layout_allows_only_its_shapes() {
    for ok in [
        "AGENTS.md",
        "projects.json",
        "model-list.json",
        "knowledge/a.md",
        "knowledge/x/y/z.md",
        "projects/p1/AGENTS.md",
        "projects/p1/sessions/0b6e-a.jsonl",
        "claude/-Users-me-x/abc.jsonl",
    ] {
        assert!(Layout::allowed(ok), "{ok}");
    }
    for bad in [
        "knowledge",
        "projects/p1/sessions/a.txt",
        "projects/p1/notes/a.md",
        "claude/abc.jsonl",
        "holder.lock",
        "remote/serve-token",
        "knowledge/../model-list.json",
        "projects/p1/model-list.json",
    ] {
        assert!(!Layout::allowed(bad), "{bad}");
    }
    assert_eq!(encode_segment("a b#c.jsonl"), "a%20b%23c.jsonl");
}

/// The Remote card's self-test: an answer is timed; nothing listening is
/// a sentence, not a hang.
#[tokio::test]
async fn the_probe_times_an_answer_and_names_a_refusal() {
    let root = scratch("probe");
    let sync = Arc::new(SyncServer::new(root.join("home"), root.join("claude")));
    let (server, _client) = listen(sync).await;
    let url = format!("http://{}/api/state", server.addr());
    assert!(probe(&url, Some(TOKEN)).await.is_ok());
    let refused = probe(&url, Some("wrong")).await.unwrap_err();
    assert!(refused.contains("refused"), "{refused}");
    let addr = server.addr();
    server.stop().await;
    let none = probe(&format!("http://{addr}/api/state"), Some(TOKEN))
        .await
        .unwrap_err();
    assert!(
        none.contains("nothing answers") || none.contains("no answer"),
        "{none}"
    );
    fs::remove_dir_all(&root).ok();
}
