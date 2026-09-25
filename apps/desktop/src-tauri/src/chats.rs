//! The chats the backend holds, one lock per chat (nightshift backlog 159,
//! pass 2 step A1, 2026-09-24).
//!
//! Until this step the shell held one `Mutex<Option<Session>>`: the open
//! chat. A turn locked it from its first append to its last, so every
//! command that touched "the open chat" — opening another, New chat, a
//! project switch, a transcript read, a prompt-layer edit — waited for the
//! turn to end (blocker 206: "why is anything waiting until a reply
//! finishes in the first place?"). Here each chat has its own lock, and
//! which chat is open (the *focus*) is a separate, short-lived fact:
//!
//! - **Opening is a focus, not a swap.** `open` points the focus at a chat
//!   and never waits on another chat's lock. A chat already held — the one
//!   whose turn is running — is reused rather than loaded a second time,
//!   so a log never has two writers.
//! - **A turn holds its own chat's lock, and nothing else here.** The
//!   commands that work on the open chat lock the focused one: when he has
//!   moved to chat B, they lock B and answer at once while A streams.
//! - **Held = focused ∪ in use.** On every focus change the chats that are
//!   neither focused nor locked by anyone (`Arc::strong_count == 1`) are
//!   dropped, so an idle chat is reloaded from disk next time, as before.
//!
//! The index (`inner`) is a std mutex that is never held across an
//! `.await`: a leaf under every other lock in `AppState`. What it guards
//! is only the map and the focus; the sessions are behind their own async
//! locks.
//!
//! - **A command reads its chat once** (A3, 2026-09-25; A2 review finding
//!   2): [`Target`] is the focus and its log taken together, and a command
//!   that locks an agent and a log locks both from it, so a switch between
//!   the two locks cannot put chat A's turn into chat B's log.
//!
//! ~~Not this step (A2): the Claude Code agent is still one per window, so a
//! second chat's *send* still waits for the first chat's turn.~~ (done in A2,
//! `agents.rs`.)

use nightloom_core::{ChatKind, ChatMode, Session};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// One chat's log, behind its own lock.
pub type Log = Arc<AsyncMutex<Session>>;

/// A chat's log, locked — owned, so it outlives the index's guard.
pub type Held = OwnedMutexGuard<Session>;

#[derive(Default)]
struct Inner {
    /// The open chat's id; `None` is New chat (the pending state of
    /// `AppState::pending_mode`). Invariant: `Some(id)` ⇒ `held` has `id`.
    focus: Option<String>,
    held: HashMap<String, Log>,
    /// The chat the latest turn ran in: what the window re-syncs at a
    /// turn's end when he browsed away (and, for a New chat's first turn,
    /// the only way it learns the id before the turn reports it).
    last_turn: Option<String>,
    /// The chat New chat's first message made and focused, until the focus
    /// next moves (backlog 159, A3): a second command aimed at that same
    /// New chat finds it here instead of making another.
    made_from_new: Option<String>,
}

/// The chat a command is about, read **once** (backlog 159, A3; A2 review
/// finding 2). A command that read the focus twice — once for the agent,
/// again for the log — could pair chat A's agent with chat B's log when he
/// switched chats between the two reads, and a send then ran A's
/// `--resume` into B's log. It holds the chat's log handle, so the chat
/// stays held until the command is done with it.
pub struct Target {
    id: Option<String>,
    log: Option<Log>,
}

impl Target {
    /// The chat's id, `None` on New chat.
    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    /// The chat, locked: waits only on its own turn. Nothing on New chat.
    pub async fn lock(&self) -> Open {
        match &self.log {
            Some(log) => Open(Some(log.clone().lock_owned().await)),
            None => Open(None),
        }
    }
}

/// See the module docs.
#[derive(Default)]
pub struct Chats {
    inner: Mutex<Inner>,
}

/// The open chat, locked, or nothing when New chat is open — the shape the
/// commands had with `Mutex<Option<Session>>`, so `as_ref` / `as_mut` read
/// as they did.
pub struct Open(Option<Held>);

impl Open {
    pub fn as_ref(&self) -> Option<&Session> {
        self.0.as_deref()
    }

    pub fn as_mut(&mut self) -> Option<&mut Session> {
        self.0.as_deref_mut()
    }
}

/// The open chat is locked: its own turn is running.
#[derive(Debug)]
pub struct Busy;

impl Chats {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        // A panic while the index was held leaves a map and an id, both
        // still coherent; refusing every later command would be worse.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The open chat's id, `None` on New chat.
    pub fn focus(&self) -> Option<String> {
        self.inner().focus.clone()
    }

    fn focused(&self) -> Option<Log> {
        let inner = self.inner();
        inner
            .focus
            .as_ref()
            .and_then(|id| inner.held.get(id).cloned())
    }

    /// The open chat and its log, read together, once — what a command
    /// that locks both an agent and a chat aims at ([`Target`]).
    pub fn target(&self) -> Target {
        let inner = self.inner();
        let id = inner.focus.clone();
        let log = id.as_ref().and_then(|id| inner.held.get(id).cloned());
        Target { id, log }
    }

    /// The open chat, locked: waits only on *that* chat's turn.
    pub async fn lock_focused(&self) -> Open {
        match self.focused() {
            Some(log) => Open(Some(log.lock_owned().await)),
            None => Open(None),
        }
    }

    /// The open chat without waiting; `Err(Busy)` while its turn runs.
    pub fn try_lock_focused(&self) -> Result<Open, Busy> {
        match self.focused() {
            Some(log) => log
                .try_lock_owned()
                .map(|g| Open(Some(g)))
                .map_err(|_| Busy),
            None => Ok(Open(None)),
        }
    }

    /// A held chat by id or unique id prefix (the sidebar's ids may be
    /// short), with its full id.
    pub fn find(&self, id: &str) -> Option<(String, Log)> {
        let inner = self.inner();
        if let Some(log) = inner.held.get(id) {
            return Some((id.to_string(), log.clone()));
        }
        let mut hits = inner.held.iter().filter(|(k, _)| k.starts_with(id));
        match (hits.next(), hits.next()) {
            (Some((k, log)), None) => Some((k.clone(), log.clone())),
            _ => None,
        }
    }

    /// Focus a chat already held (a running turn's, or the open one) and
    /// return its log; `None` when it is not held and must be loaded.
    pub fn focus_held(&self, id: &str) -> Option<Log> {
        let (full, log) = self.find(id)?;
        let mut inner = self.inner();
        inner.focus = Some(full);
        inner.made_from_new = None;
        prune(&mut inner);
        Some(log)
    }

    /// Focus a chat just loaded from disk. If a copy is held after all (a
    /// race with a turn that started meanwhile), the held one wins and the
    /// loaded copy is dropped, so the log keeps one writer.
    pub fn open(&self, session: Session) -> Log {
        let mut inner = self.inner();
        let id = session.id.clone();
        let log = inner
            .held
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(session)))
            .clone();
        inner.focus = Some(id);
        inner.made_from_new = None;
        prune(&mut inner);
        log
    }

    /// New chat: nothing open, the next chat made at its first message.
    pub fn focus_new(&self) {
        let mut inner = self.inner();
        inner.focus = None;
        inner.made_from_new = None;
        prune(&mut inner);
    }

    /// The open chat's log, or a new chat of `mode` and `kind` made now and
    /// focused — atomically, so two commands racing on New chat make one
    /// chat, as they did when both queued on the one session lock. The
    /// flag says whether it was made here.
    pub fn focused_or_start(
        &self,
        mode: ChatMode,
        kind: ChatKind,
        log_dir: &Path,
    ) -> Result<(Log, bool), String> {
        let mut inner = self.inner();
        if let Some(log) = inner.focus.as_ref().and_then(|id| inner.held.get(id)) {
            return Ok((log.clone(), false));
        }
        let session = crate::start_session(mode, kind, log_dir).map_err(|e| e.to_string())?;
        let id = session.id.clone();
        let log = Arc::new(AsyncMutex::new(session));
        inner.held.insert(id.clone(), log.clone());
        inner.focus = Some(id.clone());
        inner.made_from_new = Some(id);
        Ok((log, true))
    }

    /// [`focused_or_start`](Self::focused_or_start), locked.
    pub async fn lock_or_start(
        &self,
        mode: ChatMode,
        kind: ChatKind,
        log_dir: &Path,
    ) -> Result<(Held, bool), String> {
        let (log, created) = self.focused_or_start(mode, kind, log_dir)?;
        Ok((log.lock_owned().await, created))
    }

    /// [`lock_or_start`](Self::lock_or_start) for the chat `target` read
    /// when the command began, not whatever is open by the time it gets
    /// here (backlog 159, A3; A2 review finding 2). A chat target is that
    /// chat. A New chat target makes a chat — focused if New chat is still
    /// open; if a racing command on the same New chat made one already, it
    /// is that one; and if he has opened another chat since, the new one is
    /// made without taking the focus from the chat he is looking at.
    pub async fn lock_or_start_at(
        &self,
        target: &Target,
        mode: ChatMode,
        kind: ChatKind,
        log_dir: &Path,
    ) -> Result<(Held, bool), String> {
        if let Some(log) = &target.log {
            return Ok((log.clone().lock_owned().await, false));
        }
        let (log, created) = {
            let mut inner = self.inner();
            match inner.focus.clone() {
                // Made here, under the same lock that read the focus as New
                // chat (A3 review, 2026-09-25): letting go and calling
                // `focused_or_start` re-read the focus, and a chat opened in
                // between got this New chat's first message.
                None => {
                    let session =
                        crate::start_session(mode, kind, log_dir).map_err(|e| e.to_string())?;
                    let id = session.id.clone();
                    let log = Arc::new(AsyncMutex::new(session));
                    inner.held.insert(id.clone(), log.clone());
                    inner.focus = Some(id.clone());
                    inner.made_from_new = Some(id);
                    (log, true)
                }
                Some(id) if inner.made_from_new.as_ref() == Some(&id) => {
                    match inner.held.get(&id) {
                        Some(log) => (log.clone(), false),
                        None => return Err("the new chat went away".into()),
                    }
                }
                Some(_) => {
                    let session =
                        crate::start_session(mode, kind, log_dir).map_err(|e| e.to_string())?;
                    let id = session.id.clone();
                    let log = Arc::new(AsyncMutex::new(session));
                    inner.held.insert(id, log.clone());
                    (log, true)
                }
            }
        };
        Ok((log.lock_owned().await, created))
    }

    /// Drop a chat that is being deleted. `Err(Busy)` while its turn runs;
    /// `Ok(true)` when it was the open chat (New chat is open now).
    pub fn forget(&self, id: &str) -> Result<bool, Busy> {
        let mut inner = self.inner();
        let Some(log) = inner.held.get(id) else {
            return Ok(false);
        };
        if log.try_lock().is_err() {
            return Err(Busy);
        }
        inner.held.remove(id);
        let was_open = inner.focus.as_deref() == Some(id);
        if was_open {
            inner.focus = None;
        }
        Ok(was_open)
    }

    /// Record that a turn runs in `id`.
    pub fn mark_turn(&self, id: &str) {
        self.inner().last_turn = Some(id.to_string());
    }

    /// The chat the latest turn ran in.
    pub fn last_turn(&self) -> Option<String> {
        self.inner().last_turn.clone()
    }

    /// The held log of the chat the latest turn ran in.
    pub fn last_turn_log(&self) -> Option<Log> {
        let inner = self.inner();
        inner
            .last_turn
            .as_ref()
            .and_then(|id| inner.held.get(id).cloned())
    }

    /// The chats whose lock someone holds right now — a running turn's,
    /// in practice — without waiting on any of them.
    pub fn running(&self) -> Vec<String> {
        let inner = self.inner();
        let mut ids: Vec<String> = inner
            .held
            .iter()
            .filter(|(_, log)| log.try_lock().is_err())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
}

/// Keep the focused chat, every chat someone still holds a handle to, and
/// every ephemeral chat.
///
/// Ephemeral (backlog 159, A2, 2026-09-25; blocker 358): its log is only
/// here, in memory, so dropping it when he looks away lost it — and with
/// a turn running in the background, looking away mid-turn is the point.
/// It stays held until the window goes (nothing reaches the disk, so
/// "nothing is kept" holds). ~~Dropped like any idle chat~~.
fn prune(inner: &mut Inner) {
    let focus = inner.focus.clone();
    inner.held.retain(|id, log| {
        Some(id) == focus.as_ref()
            || Arc::strong_count(log) > 1
            || log
                .try_lock()
                .map(|s| s.mode() == ChatMode::Ephemeral)
                .unwrap_or(true)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// What "answers at once" is measured against: generous for a loaded
    /// CI machine, and still nothing like a turn's length.
    const AT_ONCE: Duration = Duration::from_millis(500);

    fn chat() -> Session {
        Session::new()
    }

    /// Blocker 358's default (A2): an ephemeral chat's log lives only
    /// here, so looking away from it — its turn still running in the
    /// background, or done — must not drop it; an idle normal chat is on
    /// disk and still let go.
    #[test]
    fn an_ephemeral_chat_stays_held_when_he_looks_away() {
        let chats = Chats::default();
        let dir = std::env::temp_dir().join("nightloom-chats-ephemeral-test");
        let (log, created) = chats
            .focused_or_start(ChatMode::Ephemeral, ChatKind::Build, &dir)
            .unwrap();
        assert!(created);
        let id = log.try_lock().unwrap().id.clone();
        drop(log);
        chats.focus_new();
        assert!(chats.find(&id).is_some(), "the ephemeral chat was dropped");
        chats.open(chat());
        let normal = chats.focus().unwrap();
        chats.focus_new();
        assert!(
            chats.find(&normal).is_none(),
            "an idle normal chat stays held"
        );
    }

    /// The step's claim (backlog 159 A1): while chat A's turn holds A's
    /// lock, opening chat B, locking the open chat (B), New chat and a
    /// chat made at New chat's first message all return at once.
    #[tokio::test]
    async fn a_command_on_chat_b_returns_while_chat_a_is_locked() {
        let chats = Chats::default();
        let a = chat();
        let a_id = a.id.clone();
        chats.open(a);
        // A's turn: the lock taken the way `send_agent` takes it, and held.
        let (turn, created) = chats
            .lock_or_start(ChatMode::Normal, ChatKind::Build, Path::new("/nonexistent"))
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(turn.id, a_id);
        chats.mark_turn(&a_id);

        // Open B while A runs.
        let b = chat();
        let b_id = b.id.clone();
        chats.open(b);
        assert_eq!(chats.focus().as_deref(), Some(b_id.as_str()));
        let open = tokio::time::timeout(AT_ONCE, chats.lock_focused())
            .await
            .expect("locking chat B waited on chat A's turn");
        assert_eq!(open.as_ref().map(|s| s.id.clone()), Some(b_id.clone()));
        drop(open);
        assert!(chats.try_lock_focused().is_ok());

        // A is still held (its turn has it) and still reported running.
        assert_eq!(chats.running(), vec![a_id.clone()]);
        assert!(chats.find(&a_id).is_some());

        // New chat while A runs, then the first message's chat is made.
        chats.focus_new();
        let (made, created) = tokio::time::timeout(
            AT_ONCE,
            chats.lock_or_start(
                ChatMode::Ephemeral,
                ChatKind::Build,
                Path::new("/nonexistent"),
            ),
        )
        .await
        .expect("New chat's first message waited on chat A's turn")
        .unwrap();
        assert!(created);
        assert_ne!(made.id, a_id);
        drop(made);

        // Back to A while it runs: the held copy, not a second writer.
        let log = chats
            .focus_held(&a_id)
            .expect("A is held while its turn runs");
        assert!(log.try_lock().is_err());
        assert!(chats.try_lock_focused().is_err());
        drop(turn);
        assert!(chats.try_lock_focused().is_ok());
        assert_eq!(chats.last_turn().as_deref(), Some(a_id.as_str()));
    }

    /// A2 review finding 2 (A3): a command reads its chat once. He sends
    /// in A and switches to B before the command reaches the log: the
    /// message still lands in A, and B stays the chat on screen.
    #[tokio::test]
    async fn a_send_read_in_chat_a_lands_in_a_after_a_switch_to_b() {
        let chats = Chats::default();
        let a = chat();
        let a_id = a.id.clone();
        chats.open(a);
        let target = chats.target();
        assert_eq!(target.id(), Some(a_id.as_str()));
        let b = chat();
        let b_id = b.id.clone();
        chats.open(b);
        // A is idle and unfocused, but the target's handle keeps it held.
        assert!(chats.find(&a_id).is_some());
        let (held, created) = chats
            .lock_or_start_at(
                &target,
                ChatMode::Normal,
                ChatKind::Build,
                Path::new("/nonexistent"),
            )
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(held.id, a_id);
        assert_eq!(chats.focus().as_deref(), Some(b_id.as_str()));
        // B answers at once while A's lock is held.
        assert!(chats.try_lock_focused().is_ok());
        drop(held);
        assert_eq!(
            target.lock().await.as_ref().map(|s| s.id.clone()),
            Some(a_id)
        );
    }

    /// The same for New chat: a first message typed at New chat, then a
    /// switch to chat B before it lands, makes a new chat — not a message
    /// in B — and leaves B on screen. Two commands aimed at the same New
    /// chat still make one chat between them.
    #[tokio::test]
    async fn a_first_message_read_at_new_chat_never_lands_in_the_chat_opened_after() {
        let dir = std::env::temp_dir().join("nightloom-chats-target-test");
        let chats = Chats::default();
        chats.focus_new();
        let target = chats.target();
        assert_eq!(target.id(), None);
        let b = chat();
        let b_id = b.id.clone();
        chats.open(b);
        let (held, created) = chats
            .lock_or_start_at(&target, ChatMode::Ephemeral, ChatKind::Build, &dir)
            .await
            .unwrap();
        assert!(created);
        assert_ne!(held.id, b_id);
        assert_eq!(chats.focus().as_deref(), Some(b_id.as_str()));
        drop(held);

        // Two racing commands on one New chat: one chat made.
        chats.focus_new();
        let first = chats.target();
        let second = chats.target();
        let (made, created) = chats
            .lock_or_start_at(&first, ChatMode::Ephemeral, ChatKind::Build, &dir)
            .await
            .unwrap();
        assert!(created);
        let made_id = made.id.clone();
        drop(made);
        let (again, created) = chats
            .lock_or_start_at(&second, ChatMode::Ephemeral, ChatKind::Build, &dir)
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(again.id, made_id);
    }

    #[test]
    fn a_chat_left_and_idle_is_dropped_but_a_running_one_is_kept() {
        let chats = Chats::default();
        let a = chat();
        let a_id = a.id.clone();
        let log_a = chats.open(a);
        let guard = log_a.clone().try_lock_owned().unwrap();
        drop(log_a);
        chats.open(chat());
        assert!(chats.find(&a_id).is_some(), "a running chat stays held");
        drop(guard);
        chats.focus_new();
        assert!(chats.find(&a_id).is_none(), "an idle chat left is dropped");
    }

    #[test]
    fn reopening_a_held_chat_keeps_the_held_copy() {
        let chats = Chats::default();
        let a = chat();
        let a_id = a.id.clone();
        let first = chats.open(a);
        let mut again = Session::new();
        again.id = a_id.clone();
        let second = chats.open(again);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn deleting_a_running_chat_is_refused_and_an_open_one_leaves_new_chat() {
        let chats = Chats::default();
        let a = chat();
        let a_id = a.id.clone();
        let log = chats.open(a);
        let guard = log.try_lock_owned().unwrap();
        assert!(chats.forget(&a_id).is_err());
        drop(guard);
        assert!(chats.forget(&a_id).unwrap());
        assert_eq!(chats.focus(), None);
        assert!(!chats.forget("nothing-held").unwrap());
    }

    #[test]
    fn a_prefix_finds_a_held_chat_only_when_unique() {
        let chats = Chats::default();
        let mut a = Session::new();
        a.id = "abc-1".into();
        let mut b = Session::new();
        b.id = "abc-2".into();
        let _la = chats.open(a);
        let _lb = chats.open(b);
        assert_eq!(
            chats.find("abc-1").map(|(id, _)| id).as_deref(),
            Some("abc-1")
        );
        assert!(chats.find("abc").is_none());
        assert_eq!(
            chats.find("abc-2").map(|(id, _)| id).as_deref(),
            Some("abc-2")
        );
    }
}
