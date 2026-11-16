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

pub(crate) async fn prepare(state: &AppState, prep: Prep) -> Result<String, String> {
    let (dir, workspace) = match prep.project.as_deref() {
        Some(p) => {
            let ws = state.workspaces.lock().await;
            let project = ws
                .registry
                .find(p)
                .ok_or_else(|| "its project is gone from the Mac".to_string())?;
            (project.session_dir(), Some(project.workspace_dir()))
        }
        None => (state.default_log_dir.clone(), None),
    };
    let project_open = prep.project == state.active().await.map(|p| p.id);
    let want = if prep.read_only {
        ChatKind::Chat
    } else {
        ChatKind::Build
    };
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
                let session: &mut Session = &mut open;
                if session.kind() != want {
                    chat_ops::set_kind(session, want, None);
                }
            } else {
                let path = dir.join(format!("{chat}.jsonl"));
                blocking(move || -> Result<(), String> {
                    let mut session = Session::load(path).map_err(|e| e.to_string())?;
                    if session.kind() != want {
                        chat_ops::set_kind(&mut session, want, None);
                    }
                    Ok(())
                })
                .await?;
            }
            chat
        }
        None => {
            let title = prep.title.clone();
            blocking(move || -> Result<String, String> {
                let mut session = Session::start(&dir, ChatMode::Normal, ChatKind::Build)
                    .map_err(|e| e.to_string())?;
                session.record_title_by(title, nightloom_core::TitleBy::User);
                if want == ChatKind::Chat {
                    chat_ops::set_kind(&mut session, want, None);
                }
                Ok(session.id.clone())
            })
            .await?
        }
    };
    state
        .agents
        .reserve_for_job(&id, prep.read_only, project_open, workspace.as_deref())?;
    Ok(id)
}
