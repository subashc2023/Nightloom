//! The Claude Code agents the window holds, one per chat (nightshift
//! backlog 159, pass 2 step A2, 2026-09-25).
//!
//! Until this step there was one `Mutex<Option<ClaudeCodeAgent>>` for the
//! window, and a turn held it from its first line to its last: a second
//! chat's *send* waited for the first chat's turn (A1's report, "What A2
//! must do next"). Here each chat has its own agent behind its own lock,
//! so two chats run turns at once (blocker 196: "yes"; blocker 206:
//! nothing waits):
//!
//! - **The rail's connection is a spec, not an agent.** `connect_agent`
//!   builds the spec for the chat on screen and hands it here with the
//!   agent made from it. That agent becomes the open chat's; every chat
//!   that has no agent yet, or one built by an older connection, gets a
//!   fresh one from the newest spec the next time something asks for it.
//!   A chat whose turn is running keeps the agent it runs on — a connect
//!   never swaps an agent out from under a turn — and is rebuilt after.
//! - **An agent's `--resume` is its own chat's.** A fresh agent is pointed
//!   at its chat's recorded session when it is made; from then on its
//!   turns carry the id forward themselves, as the one agent did. Nothing
//!   re-points one agent between chats any more, so A1's
//!   `agent_readopt` bridge is gone.
//! - **New chat has an agent of its own** (`pending`), made from the spec
//!   like any other; the first turn's chat takes it over (`adopt_new`).
//!
//! The index is a std mutex never held across an `.await`, a leaf under
//! every other lock, like `chats::Chats`. The lock order is unchanged:
//! a chat's agent, then that chat's log.

use nightloom_service::agent::{AgentSpec, ClaudeCodeAgent};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// One chat's agent, behind its own lock.
pub type Slot = Arc<AsyncMutex<ClaudeCodeAgent>>;

struct Entry {
    /// The connection generation it was built from.
    generation: u64,
    slot: Slot,
}

#[derive(Default)]
struct Inner {
    /// Bumped by every connect and disconnect.
    generation: u64,
    /// The newest connection's spec; `None` is "not on the agent engine".
    spec: Option<AgentSpec>,
    /// New chat's agent, until its first turn names the chat.
    pending: Option<Entry>,
    per_chat: HashMap<String, Entry>,
    /// The spec kept for a chat that has a scheduled message (backlog
    /// 535), by chat: what a send into it off screen runs on when the
    /// chat has no agent left — its own project's, whatever is open.
    reserved: HashMap<String, AgentSpec>,
}

/// See the module docs.
#[derive(Default)]
pub struct Agents {
    inner: Mutex<Inner>,
}

/// A chat's agent, locked — or nothing, off the agent engine. The shape
/// the commands had with `MutexGuard<Option<ClaudeCodeAgent>>`, so
/// `as_ref` / `as_mut` / `is_some` read as they did.
pub struct Guard(Option<OwnedMutexGuard<ClaudeCodeAgent>>);

impl Guard {
    pub fn new(held: OwnedMutexGuard<ClaudeCodeAgent>) -> Self {
        Self(Some(held))
    }

    pub fn none() -> Self {
        Self(None)
    }

    pub fn as_ref(&self) -> Option<&ClaudeCodeAgent> {
        self.0.as_deref()
    }

    pub fn as_mut(&mut self) -> Option<&mut ClaudeCodeAgent> {
        self.0.as_deref_mut()
    }

    pub fn is_some(&self) -> bool {
        self.0.is_some()
    }

    /// The agent's slot, for [`Agents::adopt_new`].
    ///
    /// # Panics
    /// On `Guard::none()`: only a held agent has a slot.
    pub fn slot(&self) -> &Slot {
        OwnedMutexGuard::mutex(self.0.as_ref().expect("a held agent"))
    }
}

/// What [`Agents::slot`] found for a chat.
pub enum Found {
    /// Off the agent engine.
    Off,
    /// The chat's agent: current, or an older one its running turn holds.
    Ready(Slot),
    /// The chat needs an agent made from the newest spec
    /// ([`Agents::make`]), which needs the chat's resume first.
    Make,
}

fn usable(entry: &Entry, generation: u64) -> bool {
    // An older agent is still the chat's while its turn holds it: the
    // command then waits on its own chat's turn, never another's.
    entry.generation == generation || entry.slot.try_lock().is_err()
}

impl Agents {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The rail connected to the agent engine: `agent` is built for the
    /// chat on screen (`focus`, `None` on New chat) and becomes its agent,
    /// unless that chat's turn is running — then the turn keeps its agent
    /// and the chat gets one from this spec after.
    pub fn connect(&self, agent: ClaudeCodeAgent, focus: Option<&str>) {
        let mut inner = self.inner();
        inner.generation += 1;
        let generation = inner.generation;
        inner.spec = Some(agent.spec().clone());
        let entry = Entry {
            generation,
            slot: Arc::new(AsyncMutex::new(agent)),
        };
        let place = match focus {
            Some(id) => inner.per_chat.get(id),
            None => inner.pending.as_ref(),
        };
        if place.is_some_and(|e| e.slot.try_lock().is_err()) {
            return;
        }
        match focus {
            Some(id) => {
                inner.per_chat.insert(id.to_string(), entry);
            }
            None => inner.pending = Some(entry),
        }
        prune(&mut inner);
    }

    /// The rail went to a provider: no agent engine. Running turns keep
    /// their agents to the end; nothing new is made.
    pub fn disconnect(&self) {
        let mut inner = self.inner();
        inner.generation += 1;
        inner.spec = None;
        prune(&mut inner);
    }

    /// Whether a connection to the agent engine is live.
    pub fn connected(&self) -> bool {
        self.inner().spec.is_some()
    }

    /// The agent for `chat` (`None` = New chat), if there is one to use.
    pub fn slot(&self, chat: Option<&str>) -> Found {
        let inner = self.inner();
        let entry = match chat {
            Some(id) => inner.per_chat.get(id),
            None => inner.pending.as_ref(),
        };
        if let Some(e) = entry
            && usable(e, inner.generation)
        {
            return Found::Ready(e.slot.clone());
        }
        if inner.spec.is_none() {
            Found::Off
        } else {
            Found::Make
        }
    }

    /// `chat`'s own agent if one is still here, of any connection — the one
    /// its last turn ran on, built for its own project (blocker 1467: a
    /// queued message sent in the background after a switch to another
    /// project must not run on that project's spec).
    pub fn existing(&self, chat: &str) -> Option<Slot> {
        self.inner().per_chat.get(chat).map(|e| e.slot.clone())
    }

    /// Keep a spec for `chat` (backlog 535): its own agent's when it has an
    /// idle one of the newest connection, else — when it is the chat on
    /// screen (`focused`), which the newest connection was built for — the
    /// newest spec. `false` when there is none to keep; one kept before
    /// then stays.
    pub fn reserve(&self, chat: &str, focused: bool) -> bool {
        let mut inner = self.inner();
        let generation = inner.generation;
        let own = inner
            .per_chat
            .get(chat)
            .filter(|e| e.generation == generation)
            .and_then(|e| e.slot.try_lock().ok().map(|a| a.spec().clone()));
        let spec = match own {
            Some(spec) => Some(spec),
            None if focused => inner.spec.clone(),
            None => None,
        };
        match spec {
            Some(spec) => {
                inner.reserved.insert(chat.to_string(), spec);
                true
            }
            None => inner.reserved.contains_key(chat),
        }
    }

    /// The spec `chat` would run on now (backlog 582, keep-warm): its own
    /// idle agent's, else — when it is the chat on screen — the newest
    /// connection's. `None` while its turn holds the agent, or with none.
    pub fn spec_of(&self, chat: &str, focused: bool) -> Option<AgentSpec> {
        let inner = self.inner();
        match inner.per_chat.get(chat) {
            Some(e) => e.slot.try_lock().ok().map(|a| a.spec().clone()),
            None if focused => inner.spec.clone(),
            None => None,
        }
    }

    /// Whether `chat`'s agent is held now: its turn or an aside runs
    /// (backlog 582 — a keep-warm ping waits for it).
    pub fn busy(&self, chat: &str) -> bool {
        self.inner()
            .per_chat
            .get(chat)
            .is_some_and(|e| e.slot.try_lock().is_err())
    }

    /// Keep for chat `to` the spec chat `from` runs on (backlog 544): a
    /// hand-off made off screen starts the next linked chat in the same
    /// project and thread, on its parent's spec — its own idle agent's, or
    /// the one kept for it. `false` when the parent has neither.
    pub fn reserve_like(&self, from: &str, to: &str) -> bool {
        let mut inner = self.inner();
        let spec = inner
            .per_chat
            .get(from)
            .and_then(|e| e.slot.try_lock().ok().map(|a| a.spec().clone()))
            .or_else(|| inner.reserved.get(from).cloned());
        match spec {
            Some(spec) => {
                inner.reserved.insert(to.to_string(), spec);
                true
            }
            None => false,
        }
    }

    /// Let `chat`'s kept spec go (its scheduled message left or was
    /// cancelled).
    pub fn release(&self, chat: &str) {
        self.inner().reserved.remove(chat);
    }

    /// Whether a spec is kept for `chat`.
    pub fn reserved(&self, chat: &str) -> bool {
        self.inner().reserved.contains_key(chat)
    }

    /// Make `chat`'s agent from the spec kept for it, pointed at `resume`;
    /// an agent it already has wins. `None` with no spec kept.
    pub fn make_reserved(&self, chat: &str, resume: Option<String>) -> Option<Slot> {
        let mut inner = self.inner();
        if let Some(e) = inner.per_chat.get(chat) {
            return Some(e.slot.clone());
        }
        let mut agent = ClaudeCodeAgent::new(inner.reserved.get(chat)?.clone());
        agent.set_resume(resume);
        let slot: Slot = Arc::new(AsyncMutex::new(agent));
        let generation = inner.generation;
        inner.per_chat.insert(
            chat.to_string(),
            Entry {
                generation,
                slot: slot.clone(),
            },
        );
        Some(slot)
    }

    /// Make `chat`'s agent from the newest spec, pointed at `resume`. If
    /// another command made one meanwhile, that one wins. `None` when the
    /// engine went away meanwhile.
    pub fn make(&self, chat: Option<&str>, resume: Option<String>) -> Option<Slot> {
        let mut inner = self.inner();
        let generation = inner.generation;
        let existing = match chat {
            Some(id) => inner.per_chat.get(id),
            None => inner.pending.as_ref(),
        };
        if let Some(e) = existing
            && usable(e, generation)
        {
            return Some(e.slot.clone());
        }
        let mut agent = ClaudeCodeAgent::new(inner.spec.clone()?);
        agent.set_resume(resume);
        let slot: Slot = Arc::new(AsyncMutex::new(agent));
        let entry = Entry {
            generation,
            slot: slot.clone(),
        };
        match chat {
            Some(id) => {
                inner.per_chat.insert(id.to_string(), entry);
            }
            None => inner.pending = Some(entry),
        }
        Some(slot)
    }

    /// New chat's first turn made chat `id`: the agent it runs on is that
    /// chat's now, and the next New chat gets a fresh one.
    pub fn adopt_new(&self, id: &str, slot: &Slot) {
        let mut inner = self.inner();
        let generation = match inner.pending.take() {
            Some(e) if Arc::ptr_eq(&e.slot, slot) => e.generation,
            other => {
                inner.pending = other;
                inner.generation
            }
        };
        inner.per_chat.insert(
            id.to_string(),
            Entry {
                generation,
                slot: slot.clone(),
            },
        );
    }

    /// Point `chat`'s agent at `resume` when it is idle. A running turn's
    /// agent carries its own; a chat with no agent reads its resume when
    /// one is made.
    pub fn adopt(&self, chat: Option<&str>, resume: Option<String>) {
        let slot = {
            let inner = self.inner();
            let entry = match chat {
                Some(id) => inner.per_chat.get(id),
                None => inner.pending.as_ref(),
            };
            entry.map(|e| e.slot.clone())
        };
        if let Some(slot) = slot
            && let Ok(mut agent) = slot.try_lock()
        {
            agent.set_resume(resume);
        }
    }

    /// Drop a chat's agent (the chat was deleted). Its running turn, if
    /// any, keeps the agent it holds.
    pub fn forget(&self, id: &str) {
        self.inner().per_chat.remove(id);
    }

    /// The chats whose agent is running a turn now, sorted.
    pub fn running(&self) -> Vec<String> {
        let inner = self.inner();
        let mut ids: Vec<String> = inner
            .per_chat
            .iter()
            .filter(|(_, e)| e.slot.try_lock().is_err())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
}

/// Keep what a later turn can use: agents of the current generation, and
/// any agent a running turn holds.
fn prune(inner: &mut Inner) {
    let generation = inner.generation;
    let live = inner.spec.is_some();
    inner
        .per_chat
        .retain(|_, e| (live && e.generation == generation) || e.slot.try_lock().is_err());
    if inner
        .pending
        .as_ref()
        .is_some_and(|e| !((live && e.generation == generation) || e.slot.try_lock().is_err()))
    {
        inner.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn agent(model: &str) -> ClaudeCodeAgent {
        let mut spec = AgentSpec::new(PathBuf::from("/tmp"));
        spec.model = Some(model.into());
        ClaudeCodeAgent::new(spec)
    }

    fn ready(found: Found) -> Slot {
        match found {
            Found::Ready(s) => s,
            _ => panic!("expected an agent"),
        }
    }

    /// Backlog 535: a chat with a scheduled message keeps its spec through
    /// later connects (a project switch reconnects, and prunes every idle
    /// agent), and a send into it off screen runs on that spec.
    #[tokio::test]
    async fn a_reserved_spec_outlives_later_connects_and_makes_the_chats_agent() {
        let agents = Agents::default();
        agents.connect(agent("college-opus"), Some("college"));
        assert!(agents.reserve("college", true), "the chat on screen");
        // He opens another project: a new connection, the old agent pruned.
        agents.connect(agent("value-haiku"), Some("value"));
        assert!(agents.existing("college").is_none());
        assert!(agents.reserved("college"));
        let slot = agents
            .make_reserved("college", Some("resume-c".into()))
            .expect("made from the kept spec");
        let a = slot.try_lock().unwrap();
        assert_eq!(a.spec().model.as_deref(), Some("college-opus"));
        assert_eq!(a.spec().resume.as_deref(), Some("resume-c"));
        drop(a);
        // The one made is the chat's now: asked again, the same agent.
        let again = agents.make_reserved("college", None).unwrap();
        assert!(Arc::ptr_eq(&slot, &again));
        agents.release("college");
        assert!(!agents.reserved("college"));
    }

    #[tokio::test]
    async fn reserve_takes_the_chats_own_idle_agent_else_the_newest_spec_only_for_the_focus() {
        let agents = Agents::default();
        assert!(
            !agents.reserve("a", true),
            "off the agent engine: nothing to keep"
        );
        agents.connect(agent("first"), Some("a"));
        agents.connect(agent("second"), Some("b"));
        // Chat a is not on screen and has no agent of this connection: the
        // newest spec is chat b's, not a's to keep.
        assert!(!agents.reserve("a", false));
        assert!(agents.make_reserved("a", None).is_none());
        // On screen, with its turn holding its agent: the newest spec.
        let b = ready(agents.slot(Some("b")));
        let _turn = b.lock_owned().await;
        assert!(agents.reserve("b", true));
        // One kept before stays when there is nothing newer to take.
        agents.connect(agent("third"), Some("c"));
        assert!(agents.reserve("b", false), "the earlier one stays");
    }

    #[tokio::test]
    async fn two_chats_lock_their_own_agents_at_once() {
        let agents = Agents::default();
        agents.connect(agent("haiku"), Some("a"));
        let a = ready(agents.slot(Some("a")));
        let _turn_a = a.lock_owned().await;
        // Chat B has no agent yet: one is made from the spec, and its lock
        // is free while A's turn holds A's.
        assert!(matches!(agents.slot(Some("b")), Found::Make));
        let b = agents.make(Some("b"), Some("resume-b".into())).unwrap();
        let turn_b = b
            .try_lock_owned()
            .expect("B's agent must not wait on A's turn");
        assert_eq!(turn_b.spec().resume.as_deref(), Some("resume-b"));
        assert_eq!(agents.running(), vec!["a".to_string(), "b".to_string()]);
    }

    #[tokio::test]
    async fn a_connect_never_swaps_a_running_turns_agent() {
        let agents = Agents::default();
        agents.connect(agent("haiku"), Some("a"));
        let a = ready(agents.slot(Some("a")));
        let turn = a.clone().lock_owned().await;
        agents.connect(agent("sonnet"), Some("a"));
        // Still the running turn's agent, so a command waits on its own turn.
        let again = ready(agents.slot(Some("a")));
        assert!(Arc::ptr_eq(&again, &a));
        drop(turn);
        // Idle now and built by an older connection: remade from the new spec.
        assert!(matches!(agents.slot(Some("a")), Found::Make));
        let remade = agents.make(Some("a"), None).unwrap();
        assert_eq!(remade.lock().await.spec().model.as_deref(), Some("sonnet"));
    }

    /// Backlog 205: the window reconnects with chat B's model when B is
    /// opened; chat A's running turn stays on A's model, and B's agent is
    /// B's.
    #[tokio::test]
    async fn another_chats_connect_leaves_a_running_turn_on_its_model() {
        let agents = Agents::default();
        agents.connect(agent("sonnet"), Some("a"));
        let a = ready(agents.slot(Some("a")));
        let turn = a.clone().lock_owned().await;
        agents.connect(agent("haiku"), Some("b"));
        let still = ready(agents.slot(Some("a")));
        assert!(Arc::ptr_eq(&still, &a));
        assert_eq!(turn.spec().model.as_deref(), Some("sonnet"));
        let b = ready(agents.slot(Some("b")));
        assert_eq!(b.lock().await.spec().model.as_deref(), Some("haiku"));
    }

    #[tokio::test]
    async fn new_chats_agent_goes_with_the_chat_it_made() {
        let agents = Agents::default();
        agents.connect(agent("haiku"), None);
        let pending = ready(agents.slot(None));
        agents.adopt_new("made", &pending);
        assert!(Arc::ptr_eq(&ready(agents.slot(Some("made"))), &pending));
        // The next New chat gets its own agent.
        assert!(matches!(agents.slot(None), Found::Make));
    }

    #[test]
    fn off_the_agent_engine_there_is_nothing_to_lock() {
        let agents = Agents::default();
        assert!(matches!(agents.slot(Some("a")), Found::Off));
        agents.connect(agent("haiku"), Some("a"));
        agents.disconnect();
        assert!(matches!(agents.slot(Some("a")), Found::Off));
        assert!(!agents.connected());
    }
}
