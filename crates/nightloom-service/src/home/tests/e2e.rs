//! Item 763's end-to-end run: Home's built-in scan job fires at a fake
//! 8:00 AM on the jobs clock; the host makes Home's chat (read-only, the
//! automatic hand-off on) and runs the scan as a real turn against a
//! stand-in `claude`; the run's end writes the page, the feed rows and the
//! push; a later message of his lands in the same chat and resumes the
//! same agent session; once the chat is past the soft mark and idle, his
//! next message hands off in place — a divider on the log, a fresh agent
//! session, and the wire carrying the brief with his words.

#![cfg(unix)]

use std::sync::Arc;

use chrono::{DateTime, Utc};
use nightloom_core::{ChatKind, ChatMode, Session, SessionEvent};
use tokio::sync::{Mutex, broadcast};

use crate::agent::{AgentSpec, AskGate, ClaudeCodeAgent};
use crate::agent_turn::{AgentTurnRun, ApprovalPrompt, ProjectGrant, TurnEnv, run_agent_turn};
use crate::jobs::{Jobs, Prep};
use crate::remote::api::{Running, UsageReply};
use crate::remote::{
    ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState, SendRequest,
};
use crate::turn::{TurnEvent, TurnInput};

/// A stand-in `claude`: run N records its argv and stdin line, answers
/// `<root>/replyN` (or "ok") as session `s-N`, with `<root>/tokensN` input
/// tokens (or 1000).
fn stand_in(root: &std::path::Path) -> String {
    let d = root.display();
    let body = format!(
        r##"#!/bin/sh
D="{d}"
n=$(cat "$D/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/n"
printf '%s\n' "$@" > "$D/argv$n"
head -n 1 > "$D/stdin$n"
reply=$(cat "$D/reply$n" 2>/dev/null || echo ok)
tokens=$(cat "$D/tokens$n" 2>/dev/null || echo 1000)
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-opus-5-5","permissionMode":"default","session_id":"s-'$n'"}}'
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"'"$reply"'"}}],"usage":{{"input_tokens":'$tokens',"output_tokens":50}}}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"message_delta","delta":{{"stop_reason":"end_turn"}},"usage":{{"input_tokens":'$tokens',"output_tokens":50}}}}}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"'"$reply"'","session_id":"s-'$n'","stop_reason":"end_turn","usage":{{"input_tokens":'$tokens',"output_tokens":50}}}}'
"##
    );
    let path = root.join("claude-stand-in");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

struct Env;

#[async_trait::async_trait]
impl TurnEnv for Env {
    fn event(&self, _chat: &str, _event: &TurnEvent) {}
    fn notice(&self, _text: String) {}
    fn approval(&self, _prompt: &ApprovalPrompt<'_>) {}
    async fn grant_to_project(&self, _dir: &std::path::Path) -> ProjectGrant {
        ProjectGrant::NoProject
    }
}

/// The host: one chat log (Home's), one agent, the jobs store.
struct E2eHost {
    config: std::path::PathBuf,
    jobs: Arc<Jobs>,
    tx: broadcast::Sender<Event>,
    session: Mutex<Option<Session>>,
    agent: Mutex<ClaudeCodeAgent>,
    push: Arc<crate::push::Push>,
}

impl E2eHost {
    /// One turn in Home's chat, as the window sends it: the agent resumes
    /// whatever session the log says is current.
    async fn turn(&self, text: &str) {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().expect("the chat exists");
        let mut agent = self.agent.lock().await;
        agent.set_resume(session.agent_session().map(|(_, id)| id.to_string()));
        let ask = AskGate::new();
        let chat = session.id.clone();
        let cancel = tokio_util::sync::CancellationToken::new();
        run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session,
                chat_id: &chat,
                input: TurnInput::from(text),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: None,
                ask: &ask,
            },
            &Env,
        )
        .await
        .expect("the turn ran");
    }
}

#[async_trait::async_trait]
impl Host for E2eHost {
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
        let guard = self.session.lock().await;
        let path = guard.as_ref().unwrap().log_path().unwrap().to_path_buf();
        Ok(Session::load(&path).unwrap().events().to_vec())
    }
    async fn send(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("a job never sends this way".into())
    }
    async fn send_with(&self, _chat: Option<&str>, req: SendRequest) -> Result<Handed, String> {
        self.turn(&req.text).await;
        Ok(Handed::Sent)
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
        self.tx.subscribe()
    }
    fn asset(&self, _: &str) -> Option<Asset> {
        None
    }
    fn jobs(&self) -> Option<Arc<Jobs>> {
        Some(self.jobs.clone())
    }
    fn push(&self) -> Option<Arc<crate::push::Push>> {
        Some(self.push.clone())
    }
    async fn job_prepare(&self, prep: Prep) -> Result<String, String> {
        // Blocker 2041: the scan asks for Home's model and effort.
        assert_eq!(
            prep.model,
            Some((super::MODEL.to_string(), super::EFFORT.to_string()))
        );
        // Blocker 2041: the scan asks for Home's model and effort.
        assert_eq!(
            prep.model,
            Some((super::MODEL.to_string(), super::EFFORT.to_string()))
        );
        let mut guard = self.session.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.id.clone());
        }
        let logs = self.config.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let mut s = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        s.record_title_by(prep.title.clone(), nightloom_core::TitleBy::User);
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);
        let id = crate::jobs::hold_on_disk(
            &path,
            crate::jobs::kind_for(prep.read_only),
            prep.auto_hand_off,
        )?;
        *guard = Some(Session::load(&path).unwrap());
        Ok(id)
    }
    async fn running(&self) -> Result<Running, String> {
        Ok(Running::default())
    }
    async fn usage(&self) -> Result<UsageReply, String> {
        Err("no reading".into())
    }
}

fn read(root: &std::path::Path, name: &str) -> String {
    std::fs::read_to_string(root.join(name)).unwrap_or_default()
}

/// Move the newest reply's time back `secs` on disk (he stepped away),
/// and read the log again as the window would after a restart.
fn age_last_reply(session: &mut Session, secs: i64) {
    let path = session.log_path().unwrap().to_path_buf();
    let text = std::fs::read_to_string(&path).unwrap();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let i = lines
        .iter()
        .rposition(|l| l.contains("\"event\":\"assistant_message\""))
        .unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&lines[i]).unwrap();
    let at: DateTime<Utc> = v["at"].as_str().unwrap().parse().unwrap();
    v["at"] = serde_json::json!(at - chrono::Duration::seconds(secs));
    // Item 792: the cache edge runs from the request's send.
    if let Some(sent) = v["sent_at"].as_str() {
        let sent: DateTime<Utc> = sent.parse().unwrap();
        v["sent_at"] = serde_json::json!(sent - chrono::Duration::seconds(secs));
    }
    lines[i] = v.to_string();
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    *session = Session::load(&path).unwrap();
}

#[tokio::test]
async fn the_scan_lands_in_homes_one_chat_and_the_chat_hands_off_in_place() {
    let root = std::env::temp_dir().join(format!("nightloom-home-e2e-{}", uuid::Uuid::new_v4()));
    let config = root.join("nightloom");
    std::fs::create_dir_all(&config).unwrap();
    super::ensure_folder(&config).unwrap();
    std::fs::write(
        root.join("reply1"),
        "What happened: CI went red in Scorer. waiting: 1",
    )
    .unwrap();
    std::fs::write(root.join("tokens1"), "30000").unwrap();
    std::fs::write(root.join("reply2"), "Scorer CI failed at 3:10 AM.").unwrap();
    std::fs::write(root.join("tokens2"), "250000").unwrap();
    std::fs::write(root.join("reply3"), "fresh and fine").unwrap();
    // A job failed overnight: the scan must read it from the feed.
    super::append(
        &config,
        &super::FeedRow {
            at: Utc::now() - chrono::Duration::hours(5),
            kind: "job_failed".into(),
            label: Some("Scorer CI".into()),
            chat: None,
            project: None,
            line: "the run ended with no reply".into(),
        },
    );
    let mut spec = AgentSpec::new(&root);
    spec.binary = stand_in(&root);
    let (tx, _) = broadcast::channel(8);
    let host = Arc::new(E2eHost {
        config: config.clone(),
        jobs: Jobs::open_in(Jobs::dir_under(&config), Some("America/Los_Angeles".into())),
        tx,
        session: Mutex::new(None),
        agent: Mutex::new(ClaudeCodeAgent::new(spec)),
        push: crate::push::Push::open(crate::push::Push::dir_under(&config), "mac"),
    });

    // The built-in scan, made once.
    let made = Utc::now() - chrono::Duration::days(1);
    assert!(host.jobs.ensure_home_scan("home-project", made));
    assert!(!host.jobs.ensure_home_scan("home-project", made), "once");
    let job = host.jobs.list().remove(0).job;
    assert_eq!(job.id, super::SCAN_JOB_ID);
    assert_eq!(host.jobs.list()[0].every_words, "Every day at 8:00 AM");

    // The fake 8:00 AM: its due time.
    let eight = job.next_run;
    host.jobs.tick(host.as_ref(), eight).await;
    {
        let guard = host.session.lock().await;
        let s = guard.as_ref().unwrap();
        assert_eq!(s.kind(), ChatKind::Chat, "Home's chat is read-only");
        assert_eq!(
            s.auto_hand_off(),
            Some((crate::hand_off::SOFT_TOKENS, crate::hand_off::HARD_TOKENS))
        );
    }
    let wire1 = read(&root, "stdin1");
    assert!(wire1.contains("Morning scan"), "{wire1}");
    assert!(
        wire1.contains("Scorer CI"),
        "the facts carry the feed: {wire1}"
    );
    // Its end, on the next tick.
    host.jobs
        .tick(host.as_ref(), eight + chrono::Duration::seconds(40))
        .await;
    let rows = super::read_feed(&config);
    let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    // One row per run: the scan's own, no `job_done` beside it.
    assert_eq!(kinds, vec!["job_failed", "scan"], "{rows:?}");
    assert_eq!(rows[1].line, "Morning scan · 1 waiting");
    assert!(
        !super::is_job_run(&rows[1].chat.clone().unwrap()),
        "the run's end lets its chat go"
    );
    let date = host.jobs.list()[0].job.last.as_ref().unwrap().ended;
    let _ = date;
    let page = std::fs::read_dir(super::dir_in(&config).join("scans"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(
        std::fs::read_to_string(&page)
            .unwrap()
            .contains("CI went red")
    );
    let body = host.push.payload(
        &super::scan_note("CI went red. waiting: 1", Some("c".into()), None, false),
        1,
    );
    assert!(body.contains("Morning scan · 1 waiting") && !body.contains("CI went red"));

    // Later, he types in the same chat: same chat, same agent session.
    let chat_before = host.session.lock().await.as_ref().unwrap().id.clone();
    host.turn("what failed overnight?").await;
    let argv2 = read(&root, "argv2");
    assert!(argv2.contains("--resume\ns-1"), "{argv2}");
    assert!(!read(&root, "stdin2").contains("Hand-off"), "not idle yet");

    // Past the soft mark (250k) and its cache gone cold (item 792: the
    // hour past its send): his next message hands off in place.
    {
        let mut guard = host.session.lock().await;
        age_last_reply(guard.as_mut().unwrap(), 61 * 60);
    }
    host.turn("and the CI?").await;
    let guard = host.session.lock().await;
    let s = guard.as_ref().unwrap();
    assert_eq!(s.id, chat_before, "the same chat");
    let argv3 = read(&root, "argv3");
    assert!(
        !argv3.contains("--resume"),
        "a fresh agent session: {argv3}"
    );
    let wire3 = read(&root, "stdin3");
    assert!(wire3.contains("## Hand-off (in place)"), "{wire3}");
    assert!(
        wire3.contains("what failed overnight?"),
        "his words: {wire3}"
    );
    assert!(wire3.contains("and the CI?"), "his message: {wire3}");
    assert!(
        !wire3.contains("Scorer CI"),
        "the scan's facts are not his words"
    );
    // The divider sits on the log between his two messages, once.
    let ev = Session::load(s.log_path().unwrap())
        .unwrap()
        .events()
        .to_vec();
    let pos = |f: &dyn Fn(&SessionEvent) -> bool| ev.iter().position(f).unwrap();
    let hand = pos(&|e| matches!(e, SessionEvent::HandOff { reason, .. } if reason == "soft"));
    let his =
        pos(&|e| matches!(e, SessionEvent::UserMessage { text, .. } if text == "and the CI?"));
    assert!(hand < his);
    assert_eq!(
        ev.iter()
            .filter(|e| matches!(e, SessionEvent::HandOff { .. }))
            .count(),
        1
    );
    assert_eq!(s.agent_session(), Some(("claude-code", "s-3")));
    let _ = std::fs::remove_dir_all(&root);
}
