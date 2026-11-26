//! Running a turn: [`ClaudeCodeAgent`] drives the CLI process (moved from `agent/mod.rs`, item 981).

use super::*;

/// Runs turns by driving the CLI, reporting progress as [`TurnEvent`]s.
/// A deferred call's resume runs on the stdin shape with nothing written
/// (backlog 374). Measured on CLI 2.1.301 (nightshift `374-375-review.md`,
/// M3): resumed that way, a session that holds **no** deferred call prints
/// nothing and waits on stdin until its EOF, then exits 0 — where the old
/// argv resume failed at once. So a resume that has printed nothing after
/// this long has its feed closed and ends instead of hanging the turn.
/// A real resume prints its first line within a second or two (M2: 0.7 s).
pub const SILENT_RESUME: Duration = Duration::from_secs(30);

/// How long a turn whose main thread is idle may stay open after the plan's
/// usage limit was seen on its stream (nightshift backlog 543a, his report
/// of 2026-11-10 ~6:30 AM: "Three helpers are running … and then silence").
/// The reply had ended with helpers running in the background, so the
/// process — and the turn — were held open for them (329); the limit then
/// stopped the helpers, nothing more came, and the turn sat there, neither
/// running nor paused, until he sent a message that drew the 429 itself.
/// The grace is for what the CLI still does on its own — a helper's
/// notification, the main thread's wake and its own 429 `result`, which
/// end the turn the ordinary way; past it Nightloom closes the turn, and
/// the outcome carries the limit, so the window marks the chat paused at
/// once and resumes it at the reset.
pub const LIMIT_GRACE: Duration = Duration::from_secs(20);

pub struct ClaudeCodeAgent {
    pub(super) spec: AgentSpec,
    /// The model id the CLI last resolved [`AgentSpec::model`] to.
    ///
    /// Kept beside the spec rather than written into it, because the two are
    /// different facts: the spec holds what to *ask* for, and asking for
    /// `sonnet` next turn is right — pinning yesterday's snapshot into the
    /// request would quietly stop following the alias the user chose. This is
    /// what to *call* the answer, which matters wherever a model id is looked
    /// up rather than displayed: an alias is in no limits or pricing table.
    resolved: Option<String>,
    /// A call a Stop left pending, refused on disk for the next turn's hook
    /// to deliver, with the session it is pending in (the whole-project
    /// review of 2026-09-16, F1). The next turn that resumes that session
    /// opens with the refusal as its first line — a `tool_result` for a
    /// call its process never announced — so its translator is seeded
    /// from this, as a resume's is, and the result renders under the
    /// call's own name rather than `unknown`. Cleared by [`Self::follow_on`]
    /// once a turn has landed. (The log side is the recorder's: it drops a
    /// result for a call the turn never opened.)
    pub(super) refused: Option<(String, DeferredCall)>,
    /// The seats' budget ledger the next `run_turn` continues, as its
    /// chair (nightshift backlog 187): set by [`Self::arm_chair`] once the
    /// caller has decided the chair runs, taken by that one turn. Without
    /// it a turn starts its own ledger, whatever the seats left behind.
    chair: std::sync::Mutex<Option<i64>>,
    /// The message's timing line (nightshift item 256): set by
    /// `run_agent_turn` around the chat's own processes — not a council
    /// seat's, an aside's or a name's — which mark when the CLI was
    /// spawned, said `init`, and sent its first text.
    timing: Option<std::sync::Arc<crate::turn_timing::TurnTiming>>,
    /// How long a deferred call's resume on stdin may print nothing before
    /// its feed is closed ([`SILENT_RESUME`]); a field so a test can
    /// shorten it.
    pub(super) silent_resume: Duration,
    /// [`LIMIT_GRACE`]; a field so a test can shorten it.
    pub(super) limit_grace: Duration,
    /// The next message's process, started while he types (item 256,
    /// [`warm`]); taken by [`Self::run_turn`] when it is the same command.
    pub(super) warm: warm::WarmSlot,
    /// Messages he sends into the running turn (backlog 328, [`inbox`]).
    inbox: inbox::Inbox,
    /// The secrets he typed on a card for this chat (item 766): every
    /// line the CLI prints is scrubbed of them before anything reads it.
    scrub: crate::secret::Scrub,
}

impl ClaudeCodeAgent {
    pub fn new(spec: AgentSpec) -> Self {
        Self {
            spec,
            resolved: None,
            refused: None,
            chair: std::sync::Mutex::new(None),
            timing: None,
            silent_resume: SILENT_RESUME,
            limit_grace: LIMIT_GRACE,
            warm: warm::WarmSlot::default(),
            inbox: inbox::Inbox::default(),
            scrub: crate::secret::Scrub::default(),
        }
    }

    /// The chat's inbox (backlog 328): what he sends while a turn runs
    /// goes into that turn through it. Shared — the window holds a clone
    /// for the turn's length.
    pub fn inbox(&self) -> inbox::Inbox {
        self.inbox.clone()
    }

    /// Start the next message's `claude` process now, so the start-up
    /// (the CLI, his hooks, the MCP servers) is done before Send (item
    /// 256, [`warm`]). `true` when one was started; `false` when the same
    /// one is already waiting. The turn uses it only if nothing about the
    /// command changed by then.
    pub fn prewarm(&self) -> std::io::Result<bool> {
        // A dev home's foreign session (item 1011): nothing to start.
        if self
            .spec
            .resume
            .as_deref()
            .is_some_and(|id| super::dev_guard::foreign_resume(id).is_some())
        {
            return Ok(false);
        }
        self.warm
            .fill(warm::Key::of(&self.spec, &self.spec.stdin_args()))
    }

    /// Mark this turn's stages on `timing` from the next process on, until
    /// set back to `None` (item 256).
    pub fn set_timing(&mut self, timing: Option<std::sync::Arc<crate::turn_timing::TurnTiming>>) {
        self.timing = timing;
    }

    /// The next `run_turn` is the chair of the council whose seats just
    /// ran: it continues their budget ledger rather than starting one
    /// (backlog 187). A no-op when there is no seats ledger to continue.
    pub fn arm_chair(&self) {
        let ledger = self
            .spec
            .brief
            .as_ref()
            .and_then(|b| brief::seats_ledger(&b.dir));
        if let Ok(mut c) = self.chair.lock() {
            *c = ledger;
        }
    }

    /// What the CLI resolved the model to on the last completed turn.
    ///
    /// `None` before the first one, and the CLI reports it on a line that
    /// arrives before any event — so a caller that has to name the model
    /// *while* a turn streams has this answer only from a turn before it.
    pub fn resolved_model(&self) -> Option<&str> {
        self.resolved.as_deref()
    }

    pub fn spec(&self) -> &AgentSpec {
        &self.spec
    }

    /// Hold this agent to the Chat policy when the chat's log says it is a
    /// Chat over a Claude Code declaration (`kind` / `declared`, as
    /// [`AgentSpec::apply_kind_policy`]) and the spec it was made from
    /// does not (nightshift item 746's review): a spec built for another
    /// chat, or before the log's kind changed, must never run a read-only
    /// chat's turn with the writers. Only ever tightens; `true` when it
    /// changed the spec. A process kept warm under the old spec is not
    /// used — its command differs (the hook rides `--settings`).
    pub fn hold_to_kind_policy(&mut self, kind: ChatKind, declared: ChatKind) -> bool {
        let want = kind == ChatKind::Chat && declared == ChatKind::Build;
        // A born Chat's MCP denies too (item 759), on the same terms.
        let born = kind == ChatKind::Chat && declared == ChatKind::Chat;
        let mut changed = false;
        if want && !self.spec.chat_policy {
            self.spec.chat_policy = true;
            changed = true;
        }
        if born && !self.spec.born_chat {
            self.spec.born_chat = true;
            changed = true;
        }
        changed
    }

    /// Adopt the session the last turn opened, so the next one continues it.
    /// A fork asked for by [`Self::fork_on_next_turn`] is done once the CLI
    /// has named the new session: the next turn resumes *that*, plainly.
    pub fn follow_on(&mut self, outcome: &AgentOutcome) {
        // Not under `--no-session-persistence`: the CLI names a session id
        // for that turn too, but saved nothing under it, and resuming it
        // ends the next turn with `error_during_execution` — every second
        // message of an ephemeral chat (his report, 2026-09-17). There the
        // replay in the message is the conversation, and `resume` stays as
        // it was (`None` for an ephemeral chat).
        if let Some(id) = outcome
            .session_id
            .as_ref()
            .filter(|_| !self.spec.no_session_persistence)
        {
            self.spec.resume = Some(id.clone());
            self.spec.fork_session = false;
        }
        if let Some(model) = &outcome.model {
            self.resolved = Some(model.clone());
        }
        // A turn has landed: the refusal it opened with, if any, is delivered.
        self.refused = None;
    }

    /// Remember a deferred call the shell refused on disk without running
    /// it (a Stop while the prompt was up), pending in `session`: the next
    /// turn resuming that session opens with its result (see the field).
    /// Nothing to remember without a session to resume.
    pub fn note_refused(&mut self, session: Option<&str>, call: DeferredCall) {
        self.refused = session.map(|s| (s.to_string(), call));
    }

    /// Point at a specific session, or at none.
    ///
    /// What a windowed shell needs and a REPL does not: chats are switched
    /// between rather than run one after another, so opening one has to
    /// carry its agent session with it and starting a new one has to let go
    /// of the old — which `follow_on` alone cannot express, only ever moving
    /// forward.
    pub fn set_resume(&mut self, id: Option<String>) {
        self.spec.resume = id.filter(|s| !s.is_empty());
    }

    /// Let every later process of this connection read `dir` — the card's
    /// *Allow, and this folder…* (nightshift backlog 143, pass 2), taken
    /// mid-turn so the resume that carries the allow already has it
    /// (measured 2026-09-17: a `--resume … --add-dir` reads the folder
    /// with no second prompt). Once; a folder already granted is not
    /// sent twice. The shell rebuilds `add_dirs` from the project and the
    /// log at every connect, so this holds until then and the record
    /// takes over.
    /// The list of secrets to scrub from this agent's lines (item 766): the
    /// turn's own, shared with its recorder.
    pub fn set_scrub(&mut self, scrub: crate::secret::Scrub) {
        self.scrub = scrub;
    }

    pub fn grant_dir(&mut self, dir: PathBuf) {
        // Never a folder an incognito chat may not read (backlog 405).
        if self.spec.denied_reads.iter().any(|d| dir.starts_with(d)) {
            return;
        }
        if !self.spec.add_dirs.contains(&dir) {
            self.spec.add_dirs.push(dir);
        }
    }

    /// Make the next turn a fork of the session pointed at: the CLI mints
    /// a new id, the original stays as it was, and [`Self::follow_on`]
    /// adopts the new id when the turn lands (backlog 080). A no-op with
    /// nothing to resume. For a fork that keeps the whole history; a fork
    /// that cuts is `cli_session`'s copy.
    pub fn fork_on_next_turn(&mut self) {
        if self.spec.resume.is_some() {
            self.spec.fork_session = true;
        }
    }

    /// Point the Ask position's files at `dir` — the open chat's ask
    /// directory, which the shell knows only once the chat exists. A
    /// no-op on a connection that is not asking.
    ///
    /// Also writes the *Subagents run on auto* switch into the chat's
    /// rules there (backlog 152): the hook is another process and reads
    /// only the directory, so the rail's position has to be on disk
    /// before the turn's first subagent call. Best-effort — a directory
    /// that cannot be written (a test's placeholder path) leaves the
    /// file as it was, and an absent field reads as the default.
    ///
    /// The subagent brief's file goes to the same directory (backlog 152)
    /// — in every position, since a subagent gets no preamble in any of
    /// them — written only when it changed.
    pub fn set_ask_dir(&mut self, dir: PathBuf) {
        if let Some(pw) = &mut self.spec.playwright {
            pw.dir = dir.clone();
        }
        if let Some(ask) = &mut self.spec.ask {
            ask.dir = dir.clone();
            let _ = AskDir::new(&ask.dir).set_subagents_auto(ask.subagents_auto);
        }
        // The chat's preview (nightshift item 430): the server's arguments
        // name the chat whose folder this is, so its `preview` tool reaches
        // this chat's preview and no other.
        if let (Some(cfg), Some(chat)) = (&self.spec.mcp_config, dir.file_name())
            && let Some(cfg) = crate::preview::with_chat(cfg, &chat.to_string_lossy())
        {
            self.spec.mcp_config = Some(cfg);
        }
        // The chat's budget ledger (item 538): Nightloom's own server is
        // told the directory, so its `set_budget` writes this chat's ledger.
        if self.spec.brief.is_some()
            && let Some(cfg) = &self.spec.mcp_config
            && let Some(cfg) = budget::with_budget_dir(cfg, &dir)
        {
            self.spec.mcp_config = Some(cfg);
        }
        if let Some(brief) = &mut self.spec.brief {
            brief.dir = dir;
            let _ = brief::write(&brief.dir, &brief.text);
            // The limits beside it, for the hook (backlog 165).
            let _ = brief::write_limits(&brief.dir, &self.spec.subagent_limits.unwrap_or_default());
            // And the chat's model, for "always the chat's model" (257).
            brief::write_chat_model(&brief.dir, self.spec.model.as_deref());
        }
    }

    /// Attach the chat's Playwright server to the browser the app owns for
    /// it (nightshift item 508): `endpoint` is the app's socket for this
    /// chat ([`crate::claude_browser::Browsers::endpoint`]), `None` a
    /// browser of the server's own, as before. Called before each turn,
    /// after [`Self::set_ask_dir`]; a no-op on a chat with no Playwright.
    pub fn set_browser_endpoint(&mut self, endpoint: Option<&std::path::Path>) {
        if self.spec.playwright.is_none() {
            return;
        }
        if let Some(cfg) = &self.spec.mcp_config
            && let Some(cfg) = own_browser::with_endpoint(cfg, endpoint)
        {
            self.spec.mcp_config = Some(cfg);
        }
    }

    /// Whether the connection is in the Plan position.
    pub fn planning(&self) -> bool {
        self.spec
            .ask
            .as_ref()
            .is_some_and(|a| a.mode == AskMode::Plan)
    }

    /// The card's Approve on a deferred `ExitPlanMode` (backlog 085),
    /// called **before** the resume that carries the allow. For the Ask
    /// pick nothing changes yet: the resume must run in `plan` mode for
    /// the tool to succeed (the table on [`AskSpec`]), and the hook keeps
    /// deferring. For the Auto pick the resume is the one-off
    /// [`AskMode::ExitingToAuto`] shape. Either way [`Self::plan_exited`]
    /// follows the resume. A no-op on a connection that is not in the
    /// Plan position — a plan the model entered on its own mid-Ask
    /// (`EnterPlanMode`) is approved in place and the chat stays Ask,
    /// which is what the rail still shows.
    pub fn plan_approved(&mut self, then: PlanThen) {
        if let Some(ask) = &mut self.spec.ask
            && ask.mode == AskMode::Plan
            && then == PlanThen::Auto
        {
            ask.mode = AskMode::ExitingToAuto;
        }
    }

    /// After the approval's resume: the chat takes the position the card
    /// picked — Ask (the hook stays, `default` mode) or Auto (no hook,
    /// `auto`, exactly what the switch's Auto position sends).
    pub fn plan_exited(&mut self) {
        match self.spec.ask.as_ref().map(|a| a.mode) {
            Some(AskMode::Plan) => {
                if let Some(ask) = &mut self.spec.ask {
                    ask.mode = AskMode::Ask;
                }
            }
            // ~~`ask = None`, the Auto position with no hook~~ — since
            // backlog 294 (2026-10-03) the Auto position keeps the hook on
            // the question alone ([`AskMode::Auto`]).
            Some(AskMode::ExitingToAuto) => {
                if let Some(ask) = &mut self.spec.ask {
                    ask.mode = AskMode::Auto;
                }
                self.spec.permission_mode = Some(Self::auto_mode().into());
            }
            _ => {}
        }
    }

    fn auto_mode() -> &'static str {
        AgentSpec::headless_permission_mode(true)
    }

    /// Run one turn to completion, streaming events as they arrive.
    ///
    /// A bare `&str` converts, so a text-only call reads as it always did;
    /// attachments are the case that has to say so, and they change how the
    /// turn is handed over. Text alone goes on argv as `-p`, the shape every
    /// flag test asserts on. Images or documents cannot — argv is text — so
    /// that turn is written to the CLI's stdin as one `stream-json` user
    /// line instead ([`protocol::user_line`]), which is how the Agent SDK
    /// sends an image and was verified live on 2.1.263, `--resume` included.
    /// Keeping argv for the common case means the attachment path is the
    /// only thing that changed when it was added.
    ///
    /// Cancellation kills the process tree rather than dropping the future.
    /// The reasoning is `tools::shell`'s: the CLI spawns its own children —
    /// it *is* a process supervisor — and a killed parent leaves them
    /// holding the pipes, so the read the kill was meant to end goes on
    /// waiting. There is no orphaned-`tool_use` hazard here, because the
    /// transcript the tool results belong to is Claude Code's own.
    pub async fn run_turn(
        &self,
        input: impl Into<TurnInput>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        let input = input.into();
        // A fresh turn, a fresh spawn count for the Agent hook's cap —
        // and, since pass 2 of backlog 165, the message's budget ledger
        // started from the window reading on hand (or continued, for the
        // chair of a council whose seats just ran).
        let chair = self.chair.lock().ok().and_then(|mut c| c.take());
        if let Some(brief) = &self.spec.brief {
            brief::write_chat_model(&brief.dir, self.spec.model.as_deref());
            brief::begin_turn(
                &brief.dir,
                &self.spec.subagent_limits.unwrap_or_default(),
                chair.map_or(brief::TurnPhase::Turn, brief::TurnPhase::Chair),
            );
            // A cap his message states (item 538): the backstop, in the
            // fresh ledger until the model's own `set_budget` replaces it.
            budget::declare_from_message(
                &brief.dir,
                &input.text,
                chrono::Utc::now().timestamp_millis(),
            );
        }
        let mut translator = match &self.refused {
            Some((session, call)) if self.spec.resume.as_deref() == Some(session) => {
                Translator::resuming(call)
            }
            _ => Translator::new(),
        };
        // The window as each `rate_limit_event` reports it, written beside
        // the brief for the Agent hook's usage-aware cap (backlog 165).
        if let Some(brief) = &self.spec.brief
            && !brief.dir.as_os_str().is_empty()
        {
            translator.usage_sink = Some(brief.dir.clone());
        }
        // The chat's own turn: its text on stdin, and the waiting process
        // taken if it is this command (item 256).
        self.drive_as(
            &self.spec,
            Some(input),
            translator,
            true,
            None,
            cancel,
            on_event,
        )
        .await
    }

    /// Continue the turn a deferred call paused (2026-09-16, nightshift
    /// backlog 084): the process that exited on `call` is gone, the
    /// answer is in the chat's ask directory, and this runs `-p --resume
    /// <id>` — no prompt — so the hook is asked again and the call runs or
    /// is refused. The caller has already pointed [`AgentSpec::resume`] at
    /// the session that deferred. Events stream as for any turn; the first
    /// is the deferred call's own result, paired by name from `call`.
    ///
    /// Since backlog 374 (2026-10-18) it runs on the stdin shape with the
    /// chat's inbox, as the chat's own turn does: measured on 2.1.301
    /// (nightshift `notes/runner-design/374-report.md`, M2), `-p
    /// --input-format stream-json --resume <id>` with stdin held open and
    /// nothing written resumes the deferred call on its own, and a line
    /// written later is taken at once. Before, the resume had no stdin, so
    /// a message he sent while it ran — four background subagents' worth,
    /// in his case — waited for the very end.
    pub async fn resume_deferred(
        &self,
        call: &DeferredCall,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        self.drive_as(
            &self.spec,
            None,
            Translator::resuming(call),
            true,
            None,
            cancel,
            on_event,
        )
        .await
    }

    /// Answer a side question from the chat's context without adding to
    /// it (backlog 081; [`AgentSpec::aside`] has the shape and the
    /// measurements). `None` when there is no session to ask beside.
    /// Events stream as for a turn, into a caller's own sink — the chat's
    /// recorder must not see them. Nothing of the agent changes: not the
    /// session it resumes, not the model it resolved.
    ///
    /// Since backlog 283 the question is a whole [`TurnInput`] — the
    /// aside's composer attaches images and documents as the chat's does —
    /// and `model` / `effort` override the chat's for this aside only
    /// ([`AgentSpec::aside_with`]).
    ///
    /// Since item 404 (2026-10-20) an aside has a timing line of its own in
    /// `turn-timing.log`, as the chat's turns do (`timing`): an aside that
    /// sat on the moon for minutes left no trace of where it waited.
    pub async fn ask_aside(
        &self,
        input: TurnInput,
        model: Option<&str>,
        effort: Option<&str>,
        timing: Option<std::sync::Arc<crate::turn_timing::TurnTiming>>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Option<Result<AgentOutcome, AgentError>> {
        self.ask_aside_at(input, model, effort, None, timing, cancel, on_event)
            .await
    }

    /// [`Self::ask_aside`] seated on the aside's own place (nightshift item
    /// 919, [`AgentSpec::seat_aside`]): its own browser tab and its own
    /// approval cards. `None` is the unseated aside, as before.
    #[allow(clippy::too_many_arguments)]
    pub async fn ask_aside_at(
        &self,
        input: TurnInput,
        model: Option<&str>,
        effort: Option<&str>,
        seat: Option<&AsideSeat>,
        timing: Option<std::sync::Arc<crate::turn_timing::TurnTiming>>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Option<Result<AgentOutcome, AgentError>> {
        let mut spec = self.spec.aside_with(model, effort)?;
        if let Some(seat) = seat {
            spec.seat_aside(seat);
        }
        // Item 766 (merge round T review, 2026-11-17): the aside's card is
        // a live view like the window's — its deltas are held and scrubbed
        // as the turn's are, and its final text too. Before, the caller
        // joined the raw deltas into the answer it showed and kept.
        let mut hold = crate::secret::DeltaHold::new(self.scrub.clone());
        let mut held = |e: TurnEvent| {
            for shown in hold.pass(&e) {
                on_event(shown);
            }
        };
        let out = self
            .drive_as(
                &spec,
                Some(input),
                Translator::new(),
                false,
                timing,
                cancel,
                &mut held,
            )
            .await;
        for shown in hold.finish() {
            on_event(shown);
        }
        Some(out.map(|o| self.scrubbed(o)))
    }

    /// An outcome with its final text scrubbed (item 766).
    fn scrubbed(&self, mut outcome: AgentOutcome) -> AgentOutcome {
        if !self.scrub.is_empty() {
            outcome.text = self.scrub.text(&outcome.text);
        }
        outcome
    }

    /// Learn the secrets he typed on a card for `chat` (item 766), for a
    /// run outside a turn — an aside asked before the chat's first turn
    /// since launch, when no turn has loaded them yet. Values already
    /// known are not added twice.
    pub fn learn_secrets(&self, chat: &str) {
        self.learn_secrets_from(&crate::secret::Store::default(), chat);
    }

    /// [`learn_secrets`](Self::learn_secrets) from a named store.
    pub fn learn_secrets_from(&self, store: &crate::secret::Store, chat: &str) {
        for s in store.all(chat) {
            self.scrub.add(s);
        }
    }

    /// One turn under a spec the caller shaped — a council seat
    /// (`council::seat_spec`; nightshift backlog 149, 2026-09-17): the
    /// chat's spec re-pointed at another model, forked from the chat's
    /// session, its events into the caller's own sink. Nothing of the
    /// agent changes, as for an aside; `&self` is read only, so N of
    /// these run at once over one agent.
    pub async fn run_with(
        &self,
        spec: &AgentSpec,
        input: impl Into<TurnInput>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        // Item 766 (merge round T review): a seat's deltas are a live view
        // too — held and scrubbed as the turn's and an aside's are.
        let mut hold = crate::secret::DeltaHold::new(self.scrub.clone());
        let mut held = |e: TurnEvent| {
            for shown in hold.pass(&e) {
                on_event(shown);
            }
        };
        let out = self
            .drive(
                spec,
                Some(input.into()),
                Translator::new(),
                cancel,
                &mut held,
            )
            .await;
        for shown in hold.finish() {
            on_event(shown);
        }
        out.map(|o| self.scrubbed(o))
    }

    /// One CLI process, whichever shape: a prompt on argv, attachments on
    /// stdin, or a deferred resume with neither.
    async fn drive(
        &self,
        spec: &AgentSpec,
        input: Option<TurnInput>,
        translator: Translator,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        self.drive_as(spec, input, translator, false, None, cancel, on_event)
            .await
    }

    /// [`Self::drive`]; `chat` for the chat's own turn, whose text goes on
    /// stdin and which may take the waiting process (item 256, [`warm`]).
    /// `timing` marks this process's stages on a line of its own (an
    /// aside's, item 404) in place of the chat turn's.
    #[allow(clippy::too_many_arguments)]
    async fn drive_as(
        &self,
        spec: &AgentSpec,
        input: Option<TurnInput>,
        mut translator: Translator,
        chat: bool,
        timing: Option<std::sync::Arc<crate::turn_timing::TurnTiming>>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        // Item 1011: a dev scratch home never resumes (or forks) a session
        // whose file is in a folder of the real home's — the main chat, an
        // aside, a council seat, a keep-warm ping all come through here.
        if let Some(id) = spec.resume.as_deref()
            && let Some(file) = super::dev_guard::foreign_resume(id)
        {
            return Err(AgentError::ForeignSession(super::dev_guard::refusal(
                id, &file,
            )));
        }
        let attached = input
            .as_ref()
            .is_some_and(|i| !i.images.is_empty() || !i.documents.is_empty());
        // The chat's deferred resume (no input) goes on stdin too (374):
        // the stdin shape with nothing written resumes the deferred call.
        //
        // A side process that resumes the chat's session — a keep-warm
        // ping, an aside, a council seat — takes the stdin shape as well
        // (item 732): the CLI words its Bash tool differently for a prompt
        // on argv (a 600000 ms background default against a turn's
        // 1800000, measured in 725's capture), which breaks the cached
        // prefix right after the system prompt, so every aside rebuilt the
        // chat. It still takes its one message and the EOF at its `result`
        // (`held_stdin` below), so it exits after one reply; a waiting
        // process stays the chat's own (`taken`); a session-less one-shot
        // keeps argv, as it shares no cache.
        let piped = attached
            || match &input {
                Some(i) => (chat || spec.resume.is_some()) && warm::suits_stdin(&i.text),
                None => chat,
            };
        let (args, stdin) = match &input {
            _ if piped => (spec.stdin_args(), Stdio::piped()),
            // Null rather than inherited: with a terminal on the other end
            // the CLI waits three seconds for piped input that is never
            // coming, on every turn.
            Some(input) => (spec.args(&input.text), Stdio::null()),
            None => (spec.resume_args(), Stdio::null()),
        };
        let key = warm::Key::of(spec, &args);
        // Whether this process starts or continues a flat session (758).
        let flat_run = spec.flat_reminders();
        // The running cost this process restores (item 675): a resumed or
        // forked process's `total_cost_usd` starts from its session's, and
        // the outcome carries only what this process added. Read before
        // the message goes in; a process that waited (`warm`) restored the
        // same line — nothing writes the chat's transcript between turns.
        let restored = spec
            .resume
            .as_deref()
            .and_then(crate::session_figures::restored_cost);
        // Never for a deferred resume: a waiting process is one that has
        // not yet been given its message, which a resume has none of.
        let (taken, warm_miss) = if chat && piped && input.is_some() {
            match self.warm.take_or_why(&key) {
                Ok(t) => (Some(t), None),
                Err(why) => (None, Some(why.to_string())),
            }
        } else {
            (None, None)
        };
        let warm_start = taken.is_some();
        let warm_age = taken.as_ref().map(|(_, age)| *age);
        let mut child = match taken {
            Some((child, _)) => child,
            None => key
                .command(stdin)
                .spawn()
                .map_err(|source| AgentError::Spawn {
                    binary: spec.binary.clone(),
                    source,
                })?,
        };
        // The turn's timing line (item 256): the spawn (or the waiting
        // process taken), the CLI's `init` line, the model's first streamed
        // event and its first text. Only the chat's own turn sets it.
        let timing = timing.or_else(|| self.timing.clone());
        if let Some(t) = &timing {
            t.mark(crate::turn_timing::Mark::Spawned);
            t.set_warm(warm_start);
            if let Some(age) = warm_age {
                t.set_warm_age(age);
            }
            // Item 722: a cold turn says why it found nothing to take.
            if let Some(why) = warm_miss {
                t.set_warm_miss(why);
            }
        }
        let mut init_seen = timing.is_none();
        let mut event_seen = timing.is_none();
        let mut text_seen = timing.is_none();

        // Written from its own task and then closed. A PDF near the cap is
        // tens of megabytes of base64, far past what a pipe buffers, and the
        // CLI only drains stdin as it parses — so a write awaited here, in
        // front of the stdout loop, could sit forever against a child that
        // is itself blocked writing a line nobody is reading yet. Dropping
        // the handle is the EOF that tells the CLI the turn's input is
        // complete; without it the process stays open waiting for a second
        // message.
        //
        // The chat's own turn keeps its stdin open while it runs (backlog
        // 328): the writer takes lines from a feed, the opening message
        // first, then whatever he sends mid-turn through [`inbox`], and
        // the feed's end is the EOF — at a `result` with nothing of his
        // waiting, at a Stop, or when the process ends.
        let inbox = (chat && piped).then(|| self.inbox.clone());
        let mut held_stdin: Option<tokio::sync::mpsc::UnboundedSender<String>> = None;
        if piped && let Some(mut stdin) = child.stdin.take() {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            // A deferred resume (374) has no opening line: the CLI resumes
            // the call on its own and the feed carries only what he sends.
            if let Some(input) = &input {
                let _ = tx.send(protocol::user_line(input));
            }
            match &inbox {
                Some(inbox) => inbox.open(tx),
                // Any other process takes its one message, and the EOF once
                // its `result` is read (backlog 332): a CLI whose stdin ends
                // exits after its reply, and on its way out it drops what
                // it has not yet written to a reader running behind
                // (measured: 65,536 bytes arrived, the rest and the result
                // never did — `w5a-report.md`).
                None => held_stdin = Some(tx),
            }
            tokio::spawn(async move {
                // A child that exits before reading — a bad flag, a failed
                // login — closes the pipe first, and the write error says no
                // more than the exit status and stderr tail already will.
                while let Some(line) = rx.recv().await {
                    if stdin.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
                let _ = stdin.shutdown().await;
            });
        }
        // The last main-thread call, for where a mid-turn message landed.
        let mut last_call: Option<String> = None;
        let mut after_result = false;
        // The main-thread call the CLI aborted since the last call began
        // (backlog 341): a Send now's evidence that a step was stopped.
        let mut stopped: Option<String> = None;

        let stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            let text = String::from_utf8_lossy(&buf).into_owned();
            stderr_tail(&text).to_string()
        });

        let mut lines = LossyLines::new(stdout);
        let mut interrupted = false;
        // Why the read loop ended early, when it did (backlog 332).
        let mut read_error: Option<String> = None;
        let mut any_line = false;
        // Main-thread prose drawn this turn (item 723): a reply that ends
        // with none, but a `result` text, draws that text at the end.
        let mut main_text = false;
        // A deferred resume with nothing written (374): if it prints
        // nothing at all, the session held no deferred call — close the
        // feed so the CLI exits rather than waiting on stdin for ever.
        let silent = tokio::time::sleep(self.silent_resume);
        tokio::pin!(silent);
        let mut watch_silence = piped && input.is_none();
        // The usage limit seen on the stream (543a): when, and whether the
        // main thread is idle (its `result` read, no command begun since).
        let mut limit_at: Option<tokio::time::Instant> = None;
        let mut main_idle = false;
        let mut limit_ended = false;
        // The budget's wakes (item 538): the chat's ledger is looked at on
        // a slow tick while the turn's stdin is open, and a wake a helper's
        // call left there is written to a main thread that sits idle.
        let budget_dir = inbox
            .as_ref()
            .and(spec.brief.as_ref())
            .map(|b| b.dir.clone())
            .filter(|d| !d.as_os_str().is_empty());
        let mut budget_tick = tokio::time::interval(BUDGET_TICK);
        budget_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Item 633: the running Bash commands' passing text.
        let mut bash_tails = bash_tail::BashTails::new();
        let mut tail_tick = tokio::time::interval(bash_tail::TICK);
        tail_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Item 761: the spawns the Agent hook holds for a sibling's first
        // reply, shown on their rows as passing text while they wait.
        let mut held_tick = tokio::time::interval(HELD_TICK);
        held_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut held_shown: std::collections::BTreeSet<String> = Default::default();
        let mut spawn_seen: Option<tokio::time::Instant> = None;

        loop {
            // A subagent's end the main thread was not told of (406): the
            // wake's deadline, recomputed after every line.
            let wake_due = inbox.as_ref().and_then(|i| i.wake_due());
            let next = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    interrupted = true;
                    break;
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(
                    wake_due.unwrap_or_else(std::time::Instant::now),
                )), if wake_due.is_some() => {
                    if let Some(w) = inbox
                        .as_ref()
                        .and_then(|i| i.fire_wake_at(std::time::Instant::now()))
                    {
                        on_event(TurnEvent::Woke { text: w.text, agents: w.agents });
                    }
                    continue;
                }
                _ = tokio::time::sleep_until(
                    limit_at.unwrap_or_else(tokio::time::Instant::now) + self.limit_grace,
                ), if limit_at.is_some() => {
                    // Still working (a command of the main thread's runs):
                    // it meets the limit itself and says so; look again.
                    // Or a background command of its own runs (543c): a
                    // build is not killed for the limit — its end wakes the
                    // main thread, whose 429 ends the turn.
                    let commands = inbox
                        .as_ref()
                        .is_some_and(|i| !i.commands_running().is_empty());
                    if !main_idle || commands {
                        limit_at = Some(tokio::time::Instant::now());
                        continue;
                    }
                    // Idle, held open for helpers the limit has stopped:
                    // nothing more will come. Closed as a Stop closes it,
                    // so the CLI ends the turn in its session file.
                    limit_ended = true;
                    interrupted = true;
                    break;
                }
                _ = budget_tick.tick(), if budget_dir.is_some() => {
                    if let (Some(dir), Some(inbox)) = (&budget_dir, &inbox) {
                        let helpers = inbox.agents();
                        let idle = inbox.idle_with_agents();
                        let dir = dir.clone();
                        let now_ms = chrono::Utc::now().timestamp_millis();
                        let running = !helpers.is_empty();
                        let d = dir.clone();
                        // The wakes, and the chat's helpers when one is
                        // still warm (item 693), by the main transcript
                        // the hook recorded; and the usage line, once per
                        // band crossed, to a main thread idle on helpers
                        // (938).
                        let listed = helpers.clone();
                        let (wakes, earlier, usage) = tokio::task::spawn_blocking(move || {
                            // The week on hand: a weekly cap's wakes and the
                            // no-cap weekly hard wake (935, 936), and the
                            // usage line's figure (938).
                            let week = brief::week_on_hand(now_ms);
                            let wakes = budget::take_wakes(&d, now_ms, running, idle, week);
                            let earlier = (!wakes.is_empty())
                                .then(|| brief::read_turn_budget(&d).and_then(|b| b.main_transcript))
                                .flatten()
                                .and_then(|t| brief::continuable_agents_lines(&t, now_ms));
                            let usage = budget::take_usage_line(
                                &d,
                                now_ms,
                                running,
                                idle,
                                week,
                                Some(&listed),
                            );
                            (wakes, earlier, usage)
                        })
                        .await
                        .unwrap_or_default();
                        let wake =
                            budget::with_earlier(budget::wake_text(&wakes, Some(&helpers)), earlier);
                        let text = match (wake, &usage) {
                            (Some(w), Some(u)) => Some(format!("{w}\n{}", u.text)),
                            (w, u) => w.or_else(|| u.as_ref().map(|u| u.text.clone())),
                        };
                        if let Some(text) = text {
                            if inbox.note_if_idle(&text) {
                                if let Some(u) = &usage {
                                    let d = dir.clone();
                                    let u = u.clone();
                                    let _ = tokio::task::spawn_blocking(move || {
                                        budget::record_idle_usage(&d, &u)
                                    })
                                    .await;
                                }
                                let top = wakes.iter().max_by_key(|w| w.at_ms);
                                let mut kind: Vec<String> =
                                    wakes.iter().map(|w| w.kind.as_str().to_string()).collect();
                                if usage.is_some() {
                                    kind.push("usage".to_string());
                                }
                                on_event(TurnEvent::BudgetWake {
                                    text,
                                    kind,
                                    pct: top
                                        .map(|w| w.pct)
                                        .or(usage.as_ref().and_then(|u| u.pct)),
                                    cap: top
                                        .and_then(|w| w.cap)
                                        .or(usage.as_ref().and_then(|u| u.cap)),
                                    window: top.map(|w| w.window.as_str().to_string()),
                                });
                            } else {
                                // Not idle after all: back for the main
                                // thread's next call, or the next look; the
                                // usage line is not recorded, so the next
                                // look finds it due again.
                                budget::put_back(&dir, wakes);
                            }
                        }
                    }
                    continue;
                }
                _ = held_tick.tick(), if budget_dir.is_some()
                    && (!held_shown.is_empty()
                        || spawn_seen.is_some_and(|t| t.elapsed() < HELD_WINDOW)) => {
                    if let Some(dir) = &budget_dir {
                        let held = stagger::read_held(dir);
                        for (id, h) in &held {
                            if held_shown.insert(id.clone()) {
                                on_event(TurnEvent::ToolOutput {
                                    tool_use_id: id.clone(),
                                    lines: vec![h.text.clone()],
                                });
                            }
                        }
                        let gone: Vec<String> =
                            held_shown.iter().filter(|id| !held.contains_key(*id)).cloned().collect();
                        for id in gone {
                            held_shown.remove(&id);
                            on_event(TurnEvent::ToolOutput { tool_use_id: id, lines: Vec::new() });
                        }
                    }
                    continue;
                }
                _ = tail_tick.tick(), if bash_tails.active() => {
                    for (tool_use_id, lines) in bash_tails.poll() {
                        let lines = if self.scrub.is_empty() {
                            lines
                        } else {
                            lines.iter().map(|l| self.scrub.text(l)).collect()
                        };
                        on_event(TurnEvent::ToolOutput { tool_use_id, lines });
                    }
                    continue;
                }
                _ = &mut silent, if watch_silence && !any_line => {
                    watch_silence = false;
                    // A message he sent in the silence is on its way in:
                    // its turn will print, so the feed stays open — closed
                    // now, the CLI would still run it and the window would
                    // send it again as untaken.
                    if inbox.as_ref().is_some_and(|i| i.has_waiting()) {
                        continue;
                    }
                    if let Some(inbox) = &inbox {
                        inbox.close();
                    }
                    held_stdin = None;
                    continue;
                }
                line = lines.next_line() => line,
            };
            match next {
                Ok(Some(line)) => {
                    any_line = true;
                    // Item 766: no secret he typed reaches anything below.
                    let line = if self.scrub.is_empty() {
                        line
                    } else {
                        self.scrub.json_line(&line)
                    };
                    // Item 658: by the `type` key, not the line's start.
                    let kind = protocol::line_type(&line);
                    if !init_seen && line.contains(r#""subtype":"init""#) {
                        init_seen = true;
                        if let Some(t) = &timing {
                            t.mark(crate::turn_timing::Mark::Init);
                        }
                    }
                    if !event_seen && kind == Some("stream_event") {
                        event_seen = true;
                        if let Some(t) = &timing {
                            t.mark(crate::turn_timing::Mark::FirstEvent);
                        }
                    }
                    if let Some(inbox) = &inbox {
                        match inbox.on_line(&line) {
                            Some(inbox::Effect::Taken(t)) => {
                                let after = delivered_after(
                                    t.now,
                                    stopped.as_deref(),
                                    after_result,
                                    last_call.as_deref(),
                                );
                                after_result = false;
                                stopped = None;
                                on_event(TurnEvent::MessageDelivered {
                                    id: t.id,
                                    text: t.text,
                                    after,
                                    images: t.images,
                                    documents: t.documents,
                                });
                            }
                            Some(inbox::Effect::Relayed(r)) => {
                                on_event(TurnEvent::Relayed {
                                    to: r.to,
                                    agent_id: r.agent_id,
                                    text: r.text,
                                    ok: r.ok,
                                    detail: r.detail,
                                });
                            }
                            Some(inbox::Effect::Result { running, .. }) => {
                                after_result = true;
                                // The reply ended with its subagents still
                                // running (backlog 329): the window asks him
                                // whether to wait or stop them.
                                if !running.is_empty() {
                                    on_event(TurnEvent::StillRunning { tasks: running });
                                }
                            }
                            None => {}
                        }
                    }
                    // A nested spawn's report for an idle main thread
                    // (backlog 329): the hook queued it for the main
                    // thread's next call, and an idle main thread makes
                    // none — so it goes on stdin, after the hook has run
                    // (the spawn's `task_started`, or its refusal's result).
                    if let Some(inbox) = &inbox
                        && inbox.idle_with_agents()
                        && (line.contains(r#""subtype":"task_started""#)
                            || (kind == Some("user") && line.contains(r#""is_error":true"#)))
                        && let Some(dir) = spec.brief.as_ref().map(|b| b.dir.clone())
                        && !dir.as_os_str().is_empty()
                        && let Some(note) = steer::take(
                            &dir,
                            steer::MAIN,
                            "stdin",
                            "",
                            chrono::Utc::now().timestamp_millis(),
                        )
                    {
                        // Not taken after all (a Stop closed the feed):
                        // back for the main thread's next call.
                        if !inbox.note_if_idle(&note) {
                            let _ = steer::queue(
                                &dir,
                                steer::MAIN,
                                steer::Queued {
                                    id: format!("nested-back-{}", uuid::Uuid::new_v4()),
                                    text: note,
                                    at_ms: chrono::Utc::now().timestamp_millis(),
                                    about: None,
                                    raw: true,
                                },
                            );
                        }
                    }
                    if held_stdin.is_some() && kind == Some("result") {
                        held_stdin = None;
                    }
                    if kind == Some("result") {
                        main_idle = true;
                    } else if main_idle
                        && kind == Some("system")
                        && line.contains(r#""subtype":"init""#)
                    {
                        main_idle = false;
                    }
                    let events = translator.push(&line);
                    let (started, ended) = translator.take_bash();
                    for (call, task) in started {
                        let session = translator.session_id().unwrap_or_default().to_string();
                        bash_tails.start(call, task, session);
                    }
                    for call in ended {
                        bash_tails.end(&call);
                    }
                    if limit_at.is_none() && translator.limited() {
                        limit_at = Some(tokio::time::Instant::now());
                    }
                    for event in events {
                        if let TurnEvent::ToolCall { name, .. } = &event {
                            last_call = Some(name.clone());
                            stopped = None;
                        }
                        // Item 761: a spawn's call (the main thread's or a
                        // helper's) opens the held file's look; its
                        // tool_use is on the stream before its hook runs.
                        let spawn_call = match &event {
                            TurnEvent::ToolCall { name, .. } => brief::is_spawn(name),
                            TurnEvent::Subagent { event, .. } => matches!(
                                &**event,
                                TurnEvent::ToolCall { name, .. } if brief::is_spawn(name)
                            ),
                            _ => false,
                        };
                        if spawn_call {
                            spawn_seen = Some(tokio::time::Instant::now());
                        }
                        // Item 656: a foreground Bash call's spool is looked
                        // for from the call — its `task_started` comes ~3 s in.
                        if let TurnEvent::ToolCall { id, name, input } = &event
                            && name == "Bash"
                            && input.get("run_in_background").and_then(|v| v.as_bool())
                                != Some(true)
                            && let Some(session) = translator.session_id()
                        {
                            bash_tails.call(id.clone(), session.to_string());
                        }
                        if let TurnEvent::ToolResult { tool_use_id, .. } = &event {
                            bash_tails.end(tool_use_id);
                        }
                        if let TurnEvent::ToolResult {
                            name,
                            content,
                            is_error,
                            ..
                        } = &event
                            && is_aborted(content, *is_error)
                        {
                            stopped = Some(name.clone());
                        }
                        if matches!(&event, TurnEvent::TextDelta { text } if !text.is_empty()) {
                            main_text = true;
                        }
                        if !text_seen && matches!(event, TurnEvent::TextDelta { .. }) {
                            text_seen = true;
                            if let Some(t) = &timing {
                                t.mark(crate::turn_timing::Mark::FirstText);
                            }
                        }
                        on_event(event);
                    }
                }
                Ok(None) => break,
                // A broken pipe says no more than the exit status will —
                // but a reply that ends here is cut off, and says so below.
                Err(e) => {
                    read_error = Some(e.to_string());
                    break;
                }
            }
        }
        drop(held_stdin);

        // How the stop went, for the one notice the turn shows: the CLI
        // closed the turn on the interrupt, or had to be killed.
        let mut stop = "interrupted";
        // A Stop takes back what he sent that the turn has not taken yet
        // (measured run f: cancel, EOF, SIGINT — the CLI cancels it and
        // exits). It is still in the window's queue.
        if interrupted && let Some(inbox) = &inbox {
            inbox.stop();
        }
        if interrupted {
            // Interrupt first (2026-09-16, nightshift backlog 074), kill
            // only if that does not end the process. On the interrupt the
            // CLI closes the turn itself — the open call gets an error
            // result, the stream ends on a `result` line — and its session
            // file says the turn is over, so the next `--resume` answers
            // the next message instead of carrying on with the work that
            // was stopped (measured: `INTERRUPT_GRACE`'s doc). A kill
            // leaves neither. Everything the CLI writes on its way out is
            // translated here, into the same events as the rest of the
            // turn.
            let ended = if interrupt(&child).await {
                tokio::time::timeout(INTERRUPT_GRACE, async {
                    // Until the end of the stream (or a broken pipe): the
                    // process is on its way out either way.
                    while let Ok(Some(line)) = lines.next_line().await {
                        // Item 466 (2026-10-29): the `result` line is the
                        // turn closed in its session, and the end of what
                        // the window waits for. The process's own way out
                        // (an exit held up on a slow connection) is
                        // `wind_down`'s, in the background: read to the end
                        // of the stream, a Stop that had already worked
                        // took the whole grace and was then called a kill.
                        let closed = protocol::line_type(&line) == Some("result");
                        for event in translator.push(&line) {
                            on_event(event);
                        }
                        if closed {
                            break;
                        }
                    }
                })
                .await
                .is_ok()
            } else {
                false
            };
            if ended {
                stop = "interrupted — Claude Code ended the turn";
            } else {
                stop = "interrupted — killed after the interrupt went unanswered";
                kill_tree(&mut child).await;
                // Whatever was already buffered is still worth translating,
                // but a reader that cannot finish must not hold the turn
                // open.
                // `KILLED_DRAIN`, not the 2 s it was (item 466): what the
                // CLI wrote before the kill is in the pipe already and reads
                // at once; the rest of a longer wait was only ever for a
                // child of its holding the pipe open, with nothing to say.
                let _ = tokio::time::timeout(KILLED_DRAIN, async {
                    while let Ok(Some(line)) = lines.next_line().await {
                        for event in translator.push(&line) {
                            on_event(event);
                        }
                    }
                })
                .await;
            }
        }

        // Whatever is still waiting went nowhere: the window keeps it.
        if let Some(inbox) = &inbox {
            inbox.close();
        }
        // A stopped turn ends here (item 466): the process's exit and its
        // stderr tail (which a stop never shows) are waited for in the
        // background, so a CLI slow to exit — or a grandchild holding its
        // pipes — no longer holds the Stop on screen.
        if interrupted {
            wind_down(child, stderr_task);
            let mut outcome = translator.finish();
            outcome.cost_usd = crate::session_figures::own_cost(outcome.cost_usd, restored);
            // The CLI's `result` on an interrupt is `is_error: true` with
            // `subtype: "error_during_execution"` (`terminal_reason:
            // "aborted_tools"` or `"aborted_streaming"`); that is the
            // stop's own record, not a failed turn — so neither the flag
            // nor the translator's "ended: …" notice for it stands, and
            // the log's stop reason stays what a kill always left it.
            outcome.is_error = false;
            outcome.api_error = None;
            outcome
                .notices
                .retain(|n| n != "ended: error_during_execution");
            // 543a: not his Stop — the limit left the turn nothing to wait for.
            outcome.notices.push(if limit_ended {
                "paused — the plan's usage limit stopped the helpers this turn was waiting on"
                    .into()
            } else {
                stop.into()
            });
            if flat_run && !spec.no_session_persistence {
                mark_flat(&outcome);
            }
            return Ok(outcome);
        }
        let status = child.wait().await?;
        let stderr = stderr_task.await.unwrap_or_default();
        let mut outcome = translator.finish();
        outcome.cost_usd = crate::session_figures::own_cost(outcome.cost_usd, restored);

        // A stream that ended before its `result` line (backlog 332): what
        // arrived is kept, and the reply says it was cut off and why,
        // rather than ending silently mid-word with no usage.
        if !outcome.result_seen && any_line {
            let mut reason = cut_off_reason(read_error.as_deref(), &status.to_string());
            // Item 896: the CLI's own last error line ("Connection error
            // (… ENOTFOUND …)") is the only word on why; it rides along.
            if let Some(why) = last_error_line(&stderr) {
                reason.push_str(": ");
                reason.push_str(&why);
            }
            outcome.notices.push(format!("cut off — {reason}"));
            outcome.cut_off = Some(reason);
        }
        // Item 723: a reply that arrived whole — the CLI's streamed request
        // failed and it retried without streaming — is drawn from its
        // `assistant` line by the translator, and said once. The backstop:
        // a turn that drew no prose but whose `result` names a reply draws
        // that, so an "ok" turn never ends with nothing on screen.
        let plain_end = outcome.result_seen
            && !outcome.is_error
            && outcome.api_error.is_none()
            && outcome.limit.is_none()
            && outcome.deferred.is_none();
        if outcome.whole_rounds > 0 {
            outcome.notices.push(WHOLE_REPLY_NOTICE.into());
        }
        if plain_end && !main_text && !outcome.text.trim().is_empty() {
            on_event(TurnEvent::TextDelta {
                text: outcome.text.clone(),
            });
            outcome.notices.push(RESULT_ONLY_NOTICE.into());
        }
        // The process line on the timing log (item 723): whether the
        // `result` came, how many streamed events and the exit. Never
        // stderr (blocker 2006): the timing log carries no paths; the
        // turn's error message still shows it.
        if let Some(t) = &timing {
            t.set_process(process_note(
                outcome.result_seen,
                outcome.stream_events,
                &status.to_string(),
            ));
        }
        // A process that printed nothing at all for a message (item 723)
        // is a failure whatever its exit: an "ok" with nothing drawn and
        // nothing said is what he saw. A deferred resume printing nothing
        // is the session holding no deferred call (374), and is not this.
        if !any_line && input.is_some() {
            return Err(AgentError::Failed {
                binary: spec.binary.clone(),
                status: format!("{status}, and printed nothing"),
                stderr,
            });
        }
        // An API error the CLI ended the turn with (backlog 202) is said
        // out loud; the stop reason in the log carries it too.
        if let Some(e) = &outcome.api_error
            && !outcome.notices.contains(e)
        {
            outcome.notices.push(e.clone());
        }
        // A non-zero exit with nothing translated is a startup failure —
        // an unknown flag, a missing binary path, an unauthenticated CLI —
        // and the stderr tail is the only thing that explains it. A run that
        // did stream is reported through the outcome instead, since the CLI
        // prints in-run failures as the result on stdout.
        // The session this flat process saved — a new one, or a fork's new
        // id — is resumed flat from now on (item 758, [`flat`]).
        if flat_run && !spec.no_session_persistence {
            mark_flat(&outcome);
        }
        if !status.success() && outcome.text.is_empty() && outcome.session_id.is_none() {
            return Err(AgentError::Failed {
                binary: spec.binary.clone(),
                status: status.to_string(),
                stderr,
            });
        }
        Ok(outcome)
    }
}

/// The session a flat process saved — a new one, or a fork's new id — is
/// resumed flat from now on (item 758, [`flat`]); a stopped turn too.
fn mark_flat(outcome: &AgentOutcome) {
    if let Some(id) = &outcome.session_id {
        flat::mark(id);
    }
}

/// Where the running turn took a mid-turn message (backlog 328), for its
/// row and the log. A Send now (339) reads "at once, stopping <call>" only
/// on evidence that the step was stopped — the CLI aborted that call before
/// taking the message (backlog 341); a CLI that ignored `priority: "now"`
/// took it at the next step like any other, and the row says so.
pub(super) fn delivered_after(
    now: bool,
    stopped: Option<&str>,
    after_result: bool,
    last_call: Option<&str>,
) -> String {
    if now && let Some(name) = stopped {
        return format!("at once, stopping {name}");
    }
    if after_result {
        return "after the reply".to_string();
    }
    match last_call {
        Some(name) => format!("after {name}"),
        None => "at the start".to_string(),
    }
}

/// Whether a call's result is the CLI aborting it (backlog 341). Measured
/// on 2.1.296 (`339-measurements/timeline-promote2.txt`): a Send now's
/// Bash came back `is_error: true`, "Command was aborted before
/// completion".
pub(super) fn is_aborted(content: &str, is_error: bool) -> bool {
    is_error && content.to_ascii_lowercase().contains("aborted")
}

/// The notice on a reply that arrived whole rather than streamed (item 723).
pub const WHOLE_REPLY_NOTICE: &str = "reply arrived in one piece — Claude Code's streamed request failed and it retried without streaming";

/// The notice on a reply drawn from the `result` line alone (item 723):
/// nothing of it arrived as prose before the turn ended.
pub const RESULT_ONLY_NOTICE: &str =
    "reply drawn from Claude Code's final result — none of it arrived while it ran";

/// The timing line's process part (item 723): `result seen` or `no
/// result`, the streamed events and the exit. Stderr stays out (blocker
/// 2006): it may hold a path, which the timing log promises never to carry.
fn process_note(result_seen: bool, events: u32, status: &str) -> String {
    let result = if result_seen {
        "result seen"
    } else {
        "no result"
    };
    format!("{result}, {events} stream events, {status}")
}

/// Why a reply ended before its `result` line (backlog 332), in his words.
fn cut_off_reason(read_error: Option<&str>, status: &str) -> String {
    match read_error {
        Some(e) => format!("reading Claude Code's output failed ({e})"),
        None => format!("Claude Code's output ended before the reply finished ({status})"),
    }
}

/// The last non-empty line of the CLI's stderr tail, cut to a sentence's
/// length (item 896): what a run that died mid-stream said on its way out.
fn last_error_line(stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())?;
    let mut out: String = line.chars().take(200).collect();
    if line.chars().count() > 200 {
        out.push('…');
    }
    Some(out)
}

/// The CLI's stdout, line by line, never failing on a byte that is not
/// UTF-8 (backlog 332): `lines()` turns one such byte — a line cut
/// mid-character, say — into an error that ended the turn; this replaces
/// it with U+FFFD and reads on.
struct LossyLines<R> {
    inner: BufReader<R>,
    buf: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> LossyLines<R> {
    fn new(r: R) -> Self {
        Self {
            inner: BufReader::new(r),
            buf: Vec::new(),
        }
    }

    /// Cancel safe, as `lines()` was: a read dropped mid-line (the
    /// `select!` on Stop) leaves its bytes in `buf` for the next call.
    async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        self.inner.read_until(b'\n', &mut self.buf).await?;
        if self.buf.is_empty() {
            return Ok(None);
        }
        let mut line = std::mem::take(&mut self.buf);
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        Ok(Some(String::from_utf8_lossy(&line).into_owned()))
    }
}
