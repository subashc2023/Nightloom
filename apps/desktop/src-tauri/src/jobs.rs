//! The Mac's part of a recurring job's run (nightshift item 746): what
//! `Host::job_prepare` does here. The clock and the store are the
//! service's (`nightloom_service::jobs`); the run itself is the window's
//! off-screen send (`remote-job` → `sendInChat`, backlog 535), so the chat
//! on his screen does not change when a job fires.
//!
//! Two things are made true before each run:
//!
//! 1. **The job's chat exists and says what it may do.** Its log is made
//!    in the job's project as a Claude Code chat named for the job, and
//!    carries the Chat policy (`ChatKind::Chat` over a Build declaration)
//!    while the job is read-only — written through the chat's one writer
//!    when the window holds it, as a rename is.
//! 2. **The agent the run will use is held to that.** An off-screen send
//!    makes a chat's agent from the newest connection's spec, which was
//!    built for the chat on screen and carries *that* chat's policy. So a
//!    spec is kept for the job's chat with the policy set from the job
//!    (`Agents::reserve_for_job`), and an idle agent it already has under
//!    the other policy is dropped. Without this a read-only job would run
//!    with whatever the open chat may do.

use crate::*;
use nightloom_service::jobs::Prep;

/// A chat id as a file name: letters, digits and dashes only.
fn is_id(chat: &str) -> bool {
    !chat.is_empty() && chat.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The kind a job's chat is held to: a Chat (the policy over its Claude
/// Code declaration) while it is read-only, Claude Code once its plan is
/// approved.
fn kind_for(read_only: bool) -> ChatKind {
    if read_only {
        ChatKind::Chat
    } else {
        ChatKind::Build
    }
}

/// Put `want` on the chat's log, through the writer given, when it says
/// otherwise.
fn hold(session: &mut Session, want: ChatKind) {
    if session.kind() != want {
        chat_ops::set_kind(session, want, None);
    }
}

/// A job's new chat under `dir`: a Claude Code chat named for the job, held
/// to `want` from its first line. Its id.
fn make_chat(
    dir: &std::path::Path,
    title: String,
    want: ChatKind,
    auto: Option<(u64, u64)>,
) -> Result<String, String> {
    let mut session =
        Session::start(dir, ChatMode::Normal, ChatKind::Build).map_err(|e| e.to_string())?;
    session.record_title_by(title, nightloom_core::TitleBy::User);
    hold(&mut session, want);
    let path = session.log_path().map(std::path::Path::to_path_buf);
    drop(session);
    let path = path.ok_or_else(|| nightloom_service::jobs::UNHELD.to_string())?;
    nightloom_service::jobs::hold_on_disk(&path, want, auto)
}

pub(crate) async fn prepare(state: &AppState, prep: Prep) -> Result<String, String> {
    let mut home = None;
    let (dir, workspace) = match prep.project.as_deref() {
        Some(p) => {
            let ws = state.workspaces.lock().await;
            let project = ws
                .registry
                .find(p)
                .ok_or_else(|| "its project is gone from the Mac".to_string())?;
            if project.source.as_deref() == Some(nightloom_service::home::SOURCE) {
                home = Some(project.clone());
            }
            (project.session_dir(), Some(project.workspace_dir()))
        }
        None => (state.default_log_dir.clone(), None),
    };
    let log_dir = dir.clone();
    let project_open = prep.project == state.active().await.map(|p| p.id);
    let want = kind_for(prep.read_only);
    let existing = prep
        .chat
        .clone()
        .filter(|c| is_id(c) && dir.join(format!("{c}.jsonl")).is_file());
    let id = match existing {
        Some(chat) => {
            if let Some((_, log)) = state.chats.find(&chat) {
                // Held by the window (open, or running): its one writer.
                let mut open = log
                    .try_lock()
                    .map_err(|_| "its chat is running a turn".to_string())?;
                hold(&mut open, want);
                if let Some((soft, hard)) = prep.auto_hand_off {
                    open.set_auto_hand_off(soft, hard);
                }
            } else {
                // Written, then read back from the file (the review's away
                // finding: a log that refuses the write must not run).
                let path = dir.join(format!("{chat}.jsonl"));
                let auto = prep.auto_hand_off;
                blocking(move || nightloom_service::jobs::hold_on_disk(&path, want, auto)).await?;
            }
            chat
        }
        None => {
            let title = prep.title.clone();
            let auto = prep.auto_hand_off;
            blocking(move || make_chat(&dir, title, want, auto)).await?
        }
    };
    // Item 763 H4: Home runs whatever project is open, and after a
    // relaunch — its spec is built here, as the closed-app runner builds
    // it, when the window has none for it, and kept for its next runs.
    if let Some(project) = home.filter(|_| !project_open)
        && !state.agents.has_spec_for(&id)
    {
        let log = log_dir.join(format!("{id}.jsonl"));
        if let Some(spec) = blocking(move || Ok::<_, String>(home_spec(&project, &log))).await? {
            state.agents.keep_for_job(&id, spec);
        }
    }
    state
        .agents
        .reserve_for_job(&id, prep.read_only, project_open, workspace.as_deref())?;
    if let Some((model, effort)) = &prep.model {
        state.agents.pick_for_job(&id, model, effort)?;
    }
    // Item 804: Home's scan reads his mail and calendars — its chat gets
    // his connectors, less the ones he turned off for Home.
    if prep.connectors && prep.read_only {
        let config = nightloom_service::project::config_dir();
        // 804's review: the list of accounts the scan reads, checked again
        // when old or missing (no model request; a failure keeps the last).
        if let Some(c) = config.clone() {
            let bin = crate::commands::cli::cli_binary(None);
            let _ = tokio::task::spawn_blocking(move || {
                nightloom_service::home::reach::refresh_if_stale(&c, &bin, chrono::Utc::now())
            })
            .await;
        }
        let off = config
            .map(|c| nightloom_service::home::reach::off(&c))
            .unwrap_or_default();
        state.agents.connectors_for_job(&id, off)?;
    }
    Ok(id)
}

/// Home's agent spec for an off-screen run (item 763 H4): the one the
/// closed-app runner (`jobs_runner`, item 781) builds for the chat at
/// `log` — Home's folder, prompt, model and hooks, this binary's flag
/// words — so a run never borrows the open project's. `None` when the log
/// or the home cannot be read.
fn home_spec(
    project: &nightloom_service::project::Project,
    log: &std::path::Path,
) -> Option<nightloom_service::agent::AgentSpec> {
    let config = nightloom_service::project::config_dir()?;
    let session = Session::load(log).ok()?;
    let mut cfg = nightloom_service::serve::ServeConfig::for_home(&config);
    cfg.binary = nightloom_service::resolve_binary("claude");
    cfg.hook_exe = std::env::current_exe().ok();
    let host = nightloom_service::serve::ServeHost::new_mac_runner(
        cfg,
        nightloom_service::project::Registry::load(),
    );
    Some(host.spec_for(Some(project), &session))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_service::agent::{AgentSpec, ClaudeCodeAgent};

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-jobs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Item 746's review: a read-only job's new chat reads back, from its
    /// file, as a Chat over a Claude Code declaration — the pairing that
    /// carries the refusing hook — and an agent made from a spec without
    /// the policy (the on-screen chat's) is held to it at the turn.
    #[test]
    fn a_read_only_jobs_chat_is_a_chat_over_claude_code_and_holds_any_agent_to_it() {
        let d = dir("ro");
        let id = make_chat(&d, "Check CI".into(), kind_for(true), None).unwrap();
        let path = d.join(format!("{id}.jsonl"));
        assert!(path.is_file(), "the log exists, so the next run finds it");
        let session = Session::load(&path).unwrap();
        assert_eq!(session.kind(), ChatKind::Chat);
        assert_eq!(session.declared_kind(), ChatKind::Build);
        let mut agent = ClaudeCodeAgent::new(AgentSpec::new(d.clone()));
        assert!(!agent.spec().chat_policy);
        assert!(agent.hold_to_kind_policy(session.kind(), session.declared_kind()));
        assert!(agent.spec().chat_policy);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Approving the plan makes the chat Claude Code again; changing the
    /// message (read-only again) puts the Chat policy back on the log. The
    /// hold never loosens an agent: an approved chat's agent made under the
    /// policy stays under it until a new one is made.
    #[test]
    fn approving_and_taking_back_moves_the_logs_kind_and_the_hold_only_tightens() {
        let d = dir("flip");
        let id = make_chat(&d, "Tidy".into(), kind_for(true), None).unwrap();
        let path = d.join(format!("{id}.jsonl"));
        let mut s = Session::load(&path).unwrap();
        hold(&mut s, kind_for(false));
        let s = Session::load(&path).unwrap();
        assert_eq!(s.kind(), ChatKind::Build, "approved: written to the file");
        let mut open = ClaudeCodeAgent::new(AgentSpec::new(d.clone()));
        assert!(!open.hold_to_kind_policy(s.kind(), s.declared_kind()));
        assert!(!open.spec().chat_policy);
        let mut held = AgentSpec::new(d.clone());
        held.chat_policy = true;
        let mut held = ClaudeCodeAgent::new(held);
        assert!(!held.hold_to_kind_policy(s.kind(), s.declared_kind()));
        assert!(held.spec().chat_policy, "never loosened");
        let mut s = Session::load(&path).unwrap();
        hold(&mut s, kind_for(true));
        let s = Session::load(&path).unwrap();
        assert_eq!(s.kind(), ChatKind::Chat, "taken back");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_chat_id_is_a_plain_file_name() {
        assert!(is_id("3f2a-01bc"));
        assert!(!is_id(""));
        assert!(!is_id("../x"));
        assert!(!is_id("a/b"));
        assert!(!is_id("a.jsonl"));
    }
}

/// The job whose chat `chat` is (item 780), for the approval card under
/// the Mac's chat: `None` for any other chat.
#[tauri::command]
pub fn job_for_chat(app: AppHandle, chat: String) -> Option<nightloom_service::jobs::JobView> {
    crate::remote::jobs_store(&app)?
        .list()
        .into_iter()
        .find(|j| j.job.chat.as_deref() == Some(chat.as_str()))
}

/// An answer on the Mac's card (item 780), as the phone's `/api/jobs/{id}`
/// takes it: `approve` "once", "always" or "ask" (take back), or
/// `dismiss_wanted` (Keep read-only); item 812's `run_anyway` / `dismiss_confirm`.
#[tauri::command]
pub fn job_answer(
    app: AppHandle,
    id: String,
    patch: nightloom_service::jobs::JobPatch,
) -> Result<nightloom_service::jobs::JobView, String> {
    let jobs = crate::remote::jobs_store(&app).ok_or("this Mac keeps no jobs")?;
    // Only the approval: the card changes nothing else of the job.
    let patch = nightloom_service::jobs::JobPatch {
        approve: patch.approve,
        dismiss_wanted: patch.dismiss_wanted,
        // Item 812: the spend guard's Run anyway / Cancel card.
        run_anyway: patch.run_anyway,
        dismiss_confirm: patch.dismiss_confirm,
        ..Default::default()
    };
    jobs.patch(&id, patch, chrono::Utc::now())
}
