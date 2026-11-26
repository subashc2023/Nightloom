//! `AgentSpec`'s methods: the CLI's argv, settings and hooks (moved from `agent/mod.rs`, item 981).

use super::*;

impl AgentSpec {
    /// `add_folder`'s `PreToolUse` entry (nightshift item 613): this
    /// binary's `--permission-hook` on the chat's directory — the one the
    /// brief's hook and the server's `--budget-dir` already name — on
    /// [`crate::tools::add_folder::GATE_MATCHER`], failing closed. `None`
    /// before a turn has pointed the directory (no tool is served then).
    pub fn folder_gate_entry(&self) -> Option<serde_json::Value> {
        self.own_gate_entry(
            crate::tools::add_folder::GATE_MATCHER,
            FOLDER_GATE_FAIL_CLOSED,
        )
    }

    /// `request_secret`'s `PreToolUse` entry (item 766): the same hook on
    /// the same directory as [`folder_gate_entry`](Self::folder_gate_entry),
    /// on [`crate::secret::GATE_MATCHER`], failing closed.
    pub fn secret_gate_entry(&self) -> Option<serde_json::Value> {
        self.own_gate_entry(crate::secret::GATE_MATCHER, SECRET_GATE_FAIL_CLOSED)
    }

    /// `ask_user_to_drive`'s `PreToolUse` entry (item 872): the same hook
    /// on the same directory, on [`crate::home::drive::GATE_MATCHER`],
    /// failing closed.
    pub fn drive_gate_entry(&self) -> Option<serde_json::Value> {
        self.own_gate_entry(crate::home::drive::GATE_MATCHER, DRIVE_GATE_FAIL_CLOSED)
    }

    fn own_gate_entry(&self, matcher: &str, fail_closed: &str) -> Option<serde_json::Value> {
        let brief = self.brief.as_ref()?;
        let binary = brief.hook.first()?;
        if brief.dir.as_os_str().is_empty() {
            return None;
        }
        let mut words = vec![
            ask::shell_quote(binary),
            ask::shell_quote("--permission-hook"),
            ask::shell_quote(&brief.dir.to_string_lossy()),
        ];
        if self.folder_side {
            words.push(ask::shell_quote(own_browser::SIDE_ARG));
        }
        words.push(fail_closed.to_string());
        Some(serde_json::json!({
            "matcher": matcher,
            "hooks": [{ "type": "command", "command": words.join(" ") }]
        }))
    }

    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            binary: "claude".into(),
            workspace: workspace.into(),
            model: None,
            effort: None,
            fallback_model: None,
            tools: None,
            allowed_tools: Vec::new(),
            permission_mode: None,
            system_prompt: None,
            append_system_prompt: None,
            system_prompt_snapshot_off: false,
            safe_mode: false,
            auto_memory: true,
            auto_compact: true,
            prompt_suggestions: false,
            resume: None,
            fork_session: false,
            max_budget_usd: None,
            subagent_limits: None,
            max_turns: None,
            use_subscription: true,
            add_dirs: Vec::new(),
            mcp_config: None,
            no_session_persistence: false,
            ask: None,
            brief: None,
            chat_policy: false,
            born_chat: false,
            fork_mode: true,
            claude_ai_connectors: false,
            home_gated_writes: false,
            home_chat: false,
            claude_ai_blocked: Vec::new(),
            browser: false,
            playwright: None,
            folder_side: false,
            side_cache_mark: false,
            aside_cards: false,
            incognito: false,
            denied_reads: Vec::new(),
            extra_args: Vec::new(),
        }
    }

    /// Shape the spec for a chat started in `mode`. `Normal` changes nothing.
    /// Both other modes confine the CLI to [`READ_ONLY_TOOLS`] — unless the
    /// caller had already asked for no tools at all, which stays no tools —
    /// and `Ephemeral` also asks the CLI to keep no session of its own.
    ///
    /// One method rather than two fields the shell sets in step, so the
    /// ladder (ephemeral is incognito and then some) is written down once.
    pub fn apply_mode(&mut self, mode: ChatMode) {
        if !mode.writes_nothing() {
            return;
        }
        match &self.tools {
            Some(t) if t.is_empty() => {}
            _ => {
                self.tools = Some(READ_ONLY_TOOLS.iter().map(|t| (*t).to_string()).collect());
            }
        }
        if mode == ChatMode::Ephemeral {
            self.no_session_persistence = true;
            // Ask needs `--resume`, and an ephemeral chat's CLI session
            // cannot be resumed (see `no_session_persistence`): a deferred
            // call there would be a prompt whose answer has nowhere to go.
            // The read-only list above leaves nothing that would pause
            // anyway; this makes the fact explicit rather than incidental.
            self.ask = None;
            // Playwright's tools are MCP tools, which the list does not
            // narrow: with no card to show, its gate refuses (backlog 367).
            if let Some(pw) = &mut self.playwright {
                pw.no_card = true;
            }
        }
    }

    /// Make this the chat that knows nothing about him (nightshift backlog
    /// 405, blocker 1513) — for a chat whose mode writes nothing, beside
    /// [`apply_mode`](Self::apply_mode), after the shell has chosen the
    /// chat's own empty folder ([`crate::incognito::workspace`]) and built
    /// the prompt without the project's layers. Here: no `--add-dir` (the
    /// vault and the extra folders), no auto memory, none of his settings
    /// files, skills or other MCP servers ([`incognito`](Self::incognito)),
    /// neither his claude.ai connectors nor his own Chrome, and every read
    /// of `denied` refused. Narrows, never widens.
    pub fn apply_incognito(&mut self, denied: Vec<PathBuf>) {
        self.incognito = true;
        self.auto_memory = false;
        self.add_dirs.clear();
        self.claude_ai_connectors = false;
        self.claude_ai_blocked.clear();
        self.browser = false;
        self.denied_reads = denied;
    }

    /// Shape the spec for a chat of `kind` (nightshift backlog 102,
    /// 2026-09-16). `Build` changes nothing. `Chat` confines the CLI to
    /// [`READ_ONLY_TOOLS`] exactly as [`apply_mode`](Self::apply_mode)
    /// does for a chat that writes nothing — the same five, the same
    /// "no tools stays no tools" — and nothing else: the folder is the
    /// caller's to choose (`workspace` is set at construction, and a Chat's
    /// is the neutral one from `prompt::chat_dir`), and the Chat
    /// instructions travel in the prompt. Narrows, never widens, so the
    /// order it is applied in relative to `apply_mode` does not matter.
    pub fn apply_kind(&mut self, kind: ChatKind) {
        if kind != ChatKind::Chat {
            return;
        }
        match &self.tools {
            Some(t) if t.is_empty() => {}
            _ => {
                self.tools = Some(READ_ONLY_TOOLS.iter().map(|t| (*t).to_string()).collect());
            }
        }
    }

    /// The policy half of a kind (nightshift backlog 144): `kind` is what
    /// the chat may do now, `declared` what its declaration was built for
    /// ([`apply_kind`](Self::apply_kind) with `Session::declared_kind`).
    /// A Chat over a Claude Code declaration gets the refusing hook
    /// ([`chat_policy`](Self::chat_policy)); every other pairing changes
    /// nothing — a Chat declared as a Chat has nothing to refuse, and a
    /// Claude Code chat has nothing withdrawn.
    pub fn apply_kind_policy(&mut self, kind: ChatKind, declared: ChatKind) {
        self.chat_policy = kind == ChatKind::Chat && declared == ChatKind::Build;
        self.born_chat = kind == ChatKind::Chat && declared == ChatKind::Chat;
    }

    /// Whether this spec refuses the tools that act through MCP — the
    /// connector writes, the browser, the preview (item 759): a Chat over
    /// a Claude Code declaration, or a born Chat.
    pub fn refuses_mcp_writers(&self) -> bool {
        self.chat_policy || self.born_chat
    }

    /// What the approval switch means on a headless run: `auto` when it is
    /// on, `bypassPermissions` when it is off.
    ///
    /// Neither is Nightloom's own gate, which is a live prompt with nobody
    /// to answer it here. `auto` is the CLI's classifier deciding each call
    /// — the mode a Pro or Max terminal session already starts in — and on a
    /// `-p` run it **denies rather than waits** when it cannot approve: the
    /// docs say a non-interactive run "has no prompt to fall back to", so
    /// "the action doesn't run and Claude keeps working" (`external`,
    /// code.claude.com/docs/en/permission-modes, 2026-09-14). Where auto
    /// mode is unavailable to the session, the CLI starts in manual instead,
    /// which headless is a denial too; nothing here can hang.
    ///
    /// `dontAsk` was the previous answer, and with the empty allowlist a
    /// fresh install has it refused every write, command and fetch — a chat
    /// on which nothing but reads ran. Blocker 045 in the nightshift repo
    /// records the switch and the reasoning.
    pub fn headless_permission_mode(approval: bool) -> &'static str {
        if approval {
            "auto"
        } else {
            "bypassPermissions"
        }
    }

    /// The argument vector for one text-only turn, prompt on argv.
    ///
    /// Split out from spawning so it can be asserted on directly — the same
    /// shape the provider adapters are tested in, where the unit under test
    /// is the request that would have gone out rather than the reply.
    /// `pub(crate)` so the dream's test can assert on its own invocation.
    pub(crate) fn args(&self, prompt: &str) -> Vec<String> {
        self.argv(Shape::Prompt(prompt))
    }

    /// The argument vector for one turn whose user message arrives on
    /// stdin as a `stream-json` line — the shape a turn with attachments
    /// takes, since argv carries text and nothing else.
    pub(super) fn stdin_args(&self) -> Vec<String> {
        self.argv(Shape::Stdin)
    }

    /// The argument vector that continues a deferred call: `-p` with no
    /// prompt at all, and `--resume` doing the work. The CLI accepts the
    /// missing prompt only for a session holding a deferred call
    /// (`external`, the hooks doc; measured 2026-09-16), which is the one
    /// case this is built for.
    pub(crate) fn resume_args(&self) -> Vec<String> {
        self.argv(Shape::Resume)
    }

    /// A side process — an aside, a checkpoint fork — launches a browser
    /// of its own, as before item 508: it must not act on the page the
    /// chat's browser is on while the chat, or the user, is using it.
    fn own_browser_for_side(&mut self) {
        if let Some(cfg) = &self.mcp_config
            && let Some(cfg) = own_browser::with_endpoint(cfg, None)
        {
            self.mcp_config = Some(cfg);
        }
    }

    /// The spec for an **aside** (2026-09-16, nightshift backlog 081): a
    /// side question answered from the chat's context, off the chat's
    /// warm cache, kept out of its history — what the CLI's interactive
    /// `/btw` does, which `-p` refuses ("`/btw` isn't available in this
    /// environment", measured). `None` when the chat has no CLI session
    /// yet: there is nothing to ask beside.
    ///
    /// Everything that shapes the cached prefix — the model, the tools,
    /// the MCP servers, the prompt tool, the system prompt — stays as the
    /// chat has it, because the prefix is what makes an aside cheap.
    /// Measured on Haiku against a 30-tool session (`081-report`, M3): the
    /// same tools under `dontAsk` read 32,052 of the prefix back and wrote
    /// 242; `--tools ""` read **0** and wrote 10,360; `plan` mode read 0
    /// and wrote 44,176. So an aside is not toolless — it is harmless:
    /// `dontAsk` refuses anything that would prompt, a read inside the
    /// workspace may still happen, and it has no `--max-turns` of its own
    /// (2, then 20, until 2026-11-12): it takes the chat's, unbounded.
    /// `--fork-session` keeps the chat's session
    /// untouched (the next real turn saw nothing of the aside, M2) and
    /// `--no-session-persistence` keeps the fork off the disk (no file
    /// appeared, M3's last row). The Ask position's hook is not
    /// registered — a deferral would park the aside on a prompt — but its
    /// prompt tool stays named, or the offered tools change and the
    /// prefix with them.
    pub fn aside(&self) -> Option<AgentSpec> {
        self.resume.as_ref()?;
        let mut spec = self.clone();
        spec.fork_session = true;
        spec.no_session_persistence = true;
        // An Auto chat's aside (and keep-warm ping) stays on `auto`, as its
        // checkpoint fork does ([`AskMode::AutoFork`]): the permission mode
        // is part of the cached prefix. Measured 2026-11-16 (CLI 2.1.326,
        // Opus 5.5, requests captured against a closed local port, no
        // model call): `auto`, `plan` and `bypassPermissions` send one Bash
        // tool description, `default` and `dontAsk` another (two sentences
        // more), so a `dontAsk` aside of an Auto chat read 0 of 53,579 and
        // wrote it all (cache-miss.jsonl, 5:43 PM). On Fable 5.2 the two
        // modes sent the same text. ~~An aside of an Auto chat is `dontAsk`
        // (backlog 294)~~ — superseded by this measurement.
        // The same measurement covers the other chats (item 774, blocker
        // 2037, his yes 2026-11-16): a Plan chat's aside runs in `plan`
        // ([`AskMode::PlanAside`]); a chat without the Ask hook keeps
        // `dontAsk` when it runs in `default`/`dontAsk`, and takes `plan`
        // when it runs in `auto` or `bypassPermissions` (approval off) —
        // the read-only mode of the chat's class, which can do nothing the
        // chat could not ([`Self::side_permission_mode`]).
        match spec.ask.as_ref().map(|a| a.mode) {
            Some(mode) => {
                let side = match mode {
                    // ExitingToAuto runs `auto` too (its one resume).
                    AskMode::Auto | AskMode::AutoFork | AskMode::ExitingToAuto => AskMode::AutoFork,
                    AskMode::Plan | AskMode::PlanAside => AskMode::PlanAside,
                    AskMode::Ask | AskMode::Aside => AskMode::Aside,
                };
                if side == AskMode::Aside {
                    spec.permission_mode = Some("dontAsk".into());
                }
                if let Some(ask) = &mut spec.ask {
                    ask.mode = side;
                }
            }
            None => {
                spec.permission_mode = Some(
                    Self::side_permission_mode(
                        self.permission_mode.as_deref(),
                        self.model.as_deref(),
                    )
                    .into(),
                );
            }
        }
        // No brief either: the aside is one question on the warm cache,
        // and its settings carry no hook (the test below pins that).
        spec.brief = None;
        // Playwright's gate stays (the tools are listed), never deferring
        // (backlog 367).
        if let Some(pw) = &mut spec.playwright {
            pw.side = true;
        }
        spec.folder_side = true;
        spec.side_cache_mark = true;
        spec.own_browser_for_side();
        Some(spec)
    }

    /// An aside's spec with his own model or effort for it (nightshift
    /// backlog 283, 2026-10-02): the aside's composer has the main chat's
    /// pickers, defaulting to the chat's own. `None` keeps the chat's,
    /// which is the default and the cheap case — the prefix is read back
    /// from the chat's cache only by the model that wrote it, so another
    /// model pays to write the chat's context again (the picker says so).
    /// An empty string is the CLI's default: no flag.
    pub fn aside_with(&self, model: Option<&str>, effort: Option<&str>) -> Option<AgentSpec> {
        let mut spec = self.aside()?;
        if let Some(m) = model {
            let m = m.trim();
            spec.model = (!m.is_empty()).then(|| m.to_string());
            // The mode follows the model he picked (item 802): Haiku under
            // `plan` runs Sonnet, so a no-hook chat's Haiku aside keeps
            // `dontAsk`.
            if self.ask.is_none() {
                spec.permission_mode = Some(
                    Self::side_permission_mode(
                        self.permission_mode.as_deref(),
                        spec.model.as_deref(),
                    )
                    .into(),
                );
            }
        }
        if let Some(e) = effort {
            let e = e.trim();
            spec.effort = (!e.is_empty()).then(|| e.to_string());
        }
        Some(spec)
    }

    /// Seat an aside's spec on its own place (nightshift item 919, his
    /// bug 2026-11-23): `seat.dir` is the aside's own ask directory, where
    /// its cards' answers, its Playwright replies and its browser's hold
    /// live — never the chat's, so approving in the aside approves nothing
    /// in the chat — and `seat.endpoint` the app's browser for the aside,
    /// a tab of its own in the browser pane (`None` keeps the headless
    /// browser of its server's own). Only an aside the window asked is
    /// seated: a keep-warm ping, which nobody watches, never is.
    ///
    /// What changes is the hook registration and the MCP server's browser
    /// argument, nothing the model is shown: the tools, the flags and the
    /// permission mode stay the aside's, so it reads the chat's cache as
    /// before (pinned by the parity test in `aside_parity`).
    pub fn seat_aside(&mut self, seat: &AsideSeat) {
        if let Some(ask) = &mut self.ask
            && ask.mode == AskMode::Aside
        {
            ask.dir = seat.dir.clone();
            self.aside_cards = true;
        }
        if let Some(pw) = &mut self.playwright {
            pw.dir = seat.dir.clone();
            pw.wait = !pw.no_card;
        }
        if let Some(endpoint) = &seat.endpoint
            && self.playwright.is_some()
            && let Some(cfg) = &self.mcp_config
            && let Some(cfg) = own_browser::with_endpoint(cfg, Some(endpoint))
        {
            self.mcp_config = Some(cfg);
        }
    }

    /// A keep-warm ping's spec (nightshift backlog 582; [`crate::keep_warm`]):
    /// the aside's shape — a fork of the chat's session that keeps no file
    /// of its own, everything that shapes the cached prefix as the chat has
    /// it — held to one round, since it has nothing to answer. `None`
    /// without a session to fork.
    ///
    /// A chat without the Ask hook that runs in `auto` or
    /// `bypassPermissions` (approval off) pings in its own mode, not the
    /// aside's `plan` (item 774, blocker 2037): the same tool text, no
    /// plan-mode reminder on the one-word prompt, and one round of a fixed
    /// prompt can do nothing the chat could not.
    pub fn keep_warm_ping(&self) -> Option<AgentSpec> {
        let mut spec = self.aside()?;
        spec.max_turns = Some(1);
        if self.ask.is_none()
            && let Some(mode @ ("auto" | "bypassPermissions")) = self.permission_mode.as_deref()
        {
            spec.permission_mode = Some(mode.into());
        }
        Some(spec)
    }

    /// The permission mode this spec's requests go out under: the Ask
    /// position's when it has one (it overrides), else the spec's own —
    /// `None` is the CLI's default (`args`'s rule).
    pub fn sent_permission_mode(&self) -> Option<&str> {
        match &self.ask {
            Some(ask) => Some(ask.mode.permission_mode()),
            None => self.permission_mode.as_deref(),
        }
    }

    /// The tool text a request sends on `model` under `mode`, as a class
    /// (item 959): two requests in one class send the same tools, so a
    /// cache entry one writes the other reads. Only what was measured;
    /// anything else is `None` and matches nothing.
    /// - Fable 5.2: every mode one text (item 774, 2026-11-16).
    /// - Opus 5.5: `default`/`dontAsk` one, `auto`/`plan`/`bypassPermissions`
    ///   another (item 774).
    /// - Haiku: `default`, `dontAsk`, `auto`, `bypassPermissions` one; under
    ///   `plan` the CLI runs Sonnet, another model (item 802).
    /// - Sonnet 5.5: `default` and `dontAsk` one (item 959, 2026-11-25: a
    ///   `dontAsk` aside's write was read 95.5% by a `default` send, run S2).
    ///
    /// No mode is the CLI's `default`. A model without a family name (the
    /// CLI's default model) is not known here: `None`.
    pub fn tool_text_class(model: Option<&str>, mode: Option<&str>) -> Option<u8> {
        let m = model?.to_ascii_lowercase();
        let mode = mode.unwrap_or("default");
        if m.contains("fable") {
            return Some(0);
        }
        if m.contains("haiku") {
            return matches!(mode, "default" | "dontAsk" | "auto" | "bypassPermissions")
                .then_some(0);
        }
        if m.contains("opus") {
            return match mode {
                "default" | "dontAsk" => Some(1),
                "auto" | "plan" | "bypassPermissions" => Some(2),
                _ => None,
            };
        }
        if m.contains("sonnet") {
            return matches!(mode, "default" | "dontAsk").then_some(1);
        }
        None
    }

    /// Whether `side` — an aside or keep-warm ping of this chat, perhaps
    /// on another model — wrote a cache entry the chat's own next send
    /// would read **if the chat switched to the side's model** (item 959):
    /// it marks the chat's prefix (`side_cache_mark`, tether off) and its
    /// tool text on that model is the chat's (`tool_text_class`). Measured:
    /// after a Sonnet aside on a cold Haiku chat, the chat's send on Sonnet
    /// read 96.3% (933b run C2), and 95.5% under `default` (959 run S2).
    pub fn side_marks_chat_on_its_model(&self, side: &AgentSpec) -> bool {
        if !side.side_cache_mark {
            return false;
        }
        let model = side.model.as_deref();
        match (
            Self::tool_text_class(model, side.sent_permission_mode()),
            Self::tool_text_class(model, self.sent_permission_mode()),
        ) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }

    /// The permission mode an aside of a chat without the Ask hook runs
    /// in, given the chat's (item 774, blocker 2037). Measured 2026-11-16,
    /// CLI 2.1.326, requests captured against a closed local port (no
    /// model call; nightshift `2037-asidemodes-report-2026-11-16.md`): on
    /// Opus 5.5 `default` and `dontAsk` send one tool text, `auto`, `plan`
    /// and `bypassPermissions` another (the Bash description), the system
    /// prompt the same in all five; on Fable 5.2 all five send the same.
    /// So a chat in the second class gets `plan`, the class's mode that
    /// edits nothing; every other chat — the CLI's default included, and
    /// any mode not measured — keeps `dontAsk`, which refuses anything
    /// that would prompt.
    ///
    /// **Haiku** (item 802, wave O's finding, 2026-11-17): `--model haiku`
    /// runs `claude-haiku-5-5` under `default`, `dontAsk`, `auto` and
    /// `bypassPermissions` — one tool text, one system prompt — but
    /// **Sonnet 5.5 under `plan`** (the request's model, CLI 2.1.326,
    /// measured). So a Haiku chat in `auto` or `bypassPermissions` keeps
    /// its aside in `dontAsk`, which runs Haiku and reads the chat's
    /// cache; `plan` would run another model and read none of it. A Haiku
    /// chat that itself runs `plan` runs Sonnet already, so its aside
    /// stays in `plan`. The model is matched by name (`haiku` in the alias
    /// or the full id), since the swap is the CLI's per model family.
    pub fn side_permission_mode(chat: Option<&str>, model: Option<&str>) -> &'static str {
        let haiku = model.is_some_and(|m| m.to_ascii_lowercase().contains("haiku"));
        match chat {
            Some("plan") => "plan",
            Some("auto" | "bypassPermissions") if !haiku => "plan",
            _ => "dontAsk",
        }
    }

    /// The spec for a **checkpoint fork** (nightshift backlog 104, pass 3;
    /// the module doc of [`fork`] has the design): a second CLI process on
    /// the chat's session, forked (`--fork-session`) from a chosen message
    /// — the hook appends `--resume-session-at <uuid>` — that does a
    /// helper's long task and reports. `None` without a session to fork or
    /// with fork mode off.
    ///
    /// Everything that shapes the cached prefix stays as the chat has it,
    /// as for an aside: the fork exists to read the checkpoint's prefix
    /// from the cache, not to re-write it. What differs: the fork keeps no
    /// session file of its own (its report is the deliverable); under Ask
    /// ~~or Plan~~ it runs as an aside does — `dontAsk`, no Ask hook (under
    /// Plan, `plan`, no Ask hook, since 2026-11-17: see the body) — since a
    /// deferral from a side process would park it on a card nobody's turn
    /// is waiting for; the brief hook stays, so its calls are judged by the
    /// message's budget and its own spawns by the caps; `--max-turns` is
    /// left to the budget.
    pub fn checkpoint_fork(&self) -> Option<AgentSpec> {
        self.resume.as_ref()?;
        if !self.fork_mode {
            return None;
        }
        let mut spec = self.clone();
        spec.fork_session = true;
        spec.no_session_persistence = true;
        // No card waits on a fork: Playwright runs only if allowed already
        // (backlog 367).
        if let Some(pw) = &mut spec.playwright {
            pw.side = true;
        }
        spec.folder_side = true;
        spec.own_browser_for_side();
        // The fork stays in the chat's tool-text class, as its aside does
        // (item 774, blocker 2037; wave O, 2026-11-17). ~~Under Plan the
        // fork ran `dontAsk`~~: `dontAsk` and `plan` send another Bash
        // description on Opus 5.5, and `--model haiku` under `plan` runs
        // Sonnet 5.5 where `dontAsk` runs Haiku (CLI 2.1.326, measured), so
        // a Plan chat's fork missed the checkpoint's prefix. Now an Auto
        // chat's fork — and that of the
        // one resume of an approved plan going to Auto
        // ([`AskMode::ExitingToAuto`], `auto` too, which also ran
        // `dontAsk`) — is [`AskMode::AutoFork`]; a Plan chat's is
        // [`AskMode::PlanAside`]: `plan`, so it still edits nothing, no
        // Ask hook; an Ask chat's stays `dontAsk`, its `default`'s class.
        if let Some(ask) = &mut spec.ask {
            match ask.mode {
                // An Auto chat's fork stays on `auto`, as it ran before
                // the position asked questions (backlog 294).
                AskMode::Auto | AskMode::AutoFork | AskMode::ExitingToAuto => {
                    ask.mode = AskMode::AutoFork;
                }
                AskMode::Plan | AskMode::PlanAside => ask.mode = AskMode::PlanAside,
                AskMode::Ask | AskMode::Aside => {
                    ask.mode = AskMode::Aside;
                    spec.permission_mode = Some("dontAsk".into());
                }
            }
        }
        Some(spec)
    }

    /// The checkpoint fork's command line, written beside the brief for
    /// the hook ([`fork::ForkSpec`]): `-p ""` in front for the task, the
    /// environment the turn runs with. The uuid is not here — the hook
    /// reads the checkpoint file and appends `--resume-session-at`.
    pub fn fork_spec(&self) -> Option<fork::ForkSpec> {
        let spec = self.checkpoint_fork()?;
        Some(fork::ForkSpec {
            binary: spec.binary.clone(),
            workspace: spec.workspace.clone(),
            argv: spec.argv(Shape::Prompt("")),
            env: spec
                .env_set()
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            env_remove: spec.env_removed().iter().map(|k| k.to_string()).collect(),
        })
    }

    /// The variables a turn's process is given, beyond what it inherits
    /// ([`Self::env_removed`] is the other half). Shared by [`ClaudeCodeAgent::drive`]
    /// and the fork's spec, so the two processes run alike.
    pub fn env_set(&self) -> Vec<(&'static str, String)> {
        let mut env: Vec<(&'static str, String)> = Vec::new();
        if !self.auto_compact {
            // The belt to the setting's braces (`AgentSpec::auto_compact`).
            env.push(("DISABLE_AUTO_COMPACT", "1".into()));
        }
        // The CLI's own subagent limits (backlog 165): concurrency and
        // nesting depth are environment, read by the CLI at each spawn.
        env.extend(self.subagent_limits.unwrap_or_default().env());
        if self.fork_mode {
            // Fork subagents (backlog 104): the environment spelling beside
            // the `--settings` one, as the survey's M2c ran it.
            env.push(("CLAUDE_CODE_FORK_SUBAGENT", "1".into()));
        }
        // His claude.ai connectors (backlog 235): off unless the chat said on.
        env.extend(connectors::env(self.claude_ai_connectors));
        // A new session's reminders in its first user message (item 758,
        // [`flat`]): on only for a new session or one that began so.
        if self.flat_reminders() {
            env.push((
                flat::CAPS_ENV,
                flat::caps_value(std::env::var(flat::CAPS_ENV).ok().as_deref()),
            ));
        }
        // A side request marks the chat's own prefix (`side_cache_mark`).
        if self.side_cache_mark {
            env.push((TETHER_OFF_ENV, "false".into()));
        }
        // Nightloom's mark on its own `claude` processes (backlog 435): his
        // `~/.claude/hooks/notify.sh` exits quietly when it is set, since
        // Nightloom raises its own banner. Inherited by the CLI's hooks.
        env.push((NIGHTLOOM_MARKER_ENV, "1".into()));
        env
    }

    /// Whether this process sends the reminders inside the user's message
    /// (item 758, [`flat`]): a process starting a session does, and one
    /// resuming a session that started so; every older session keeps the
    /// CLI's default shape, which switching would re-write in full.
    pub fn flat_reminders(&self) -> bool {
        match self.resume.as_deref() {
            None => true,
            Some(id) => flat::is_flat(id),
        }
    }

    /// The variables kept out of a turn's process.
    pub fn env_removed(&self) -> &'static [&'static str] {
        if self.use_subscription {
            // Claude Code prefers an API key over the subscription whenever
            // one is set, silently. `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
            // are set when Nightloom itself was launched from a Claude Code
            // session; inherited they make the child think it is a nested
            // run of its own.
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
            ]
        } else {
            &[]
        }
    }

    /// The three shapes differ in the first arguments only. A prompt goes
    /// on argv as `-p <prompt>`; the stdin shape is `-p --input-format
    /// stream-json`, saying the message is coming on stdin; a resume of a
    /// deferred call is `-p` alone. The rest is identical, which is the
    /// property that keeps the resume path and every flag test valid for
    /// every shape without a second copy of each.
    fn argv(&self, shape: Shape<'_>) -> Vec<String> {
        let mut a: Vec<String> = vec!["-p".into()];
        match shape {
            Shape::Prompt(p) => a.push(p.into()),
            Shape::Stdin => {
                a.push("--input-format".into());
                a.push("stream-json".into());
                // The CLI's receipts for each stdin message (nightshift
                // backlog 328, measured on 2.1.294): `command_lifecycle`
                // lines `queued` / `started` / `completed` by the line's
                // uuid, which is how the window learns a message he sent
                // mid-turn reached the turn ([`inbox`]). The replayed
                // `user` line itself translates to nothing.
                a.push("--replay-user-messages".into());
            }
            Shape::Resume => {}
        }
        a.extend([
            "--output-format".into(),
            "stream-json".into(),
            // Required by the CLI alongside stream-json, and the reason
            // there are deltas to render at all rather than one block at
            // the end of the turn.
            "--verbose".into(),
            "--include-partial-messages".into(),
            // A subagent's text and thinking as `assistant`/`user` lines
            // carrying `parent_tool_use_id` (2026-09-16, nightshift backlog
            // 075; `external`, the headless reference: v2.1.211+, "at every
            // nesting depth"). Measured on 2.1.263 with an Explore subagent
            // (`m075-1-forward.jsonl` against `m075-2-noforward.jsonl`): the
            // child's final text arrived as one whole `assistant` line and
            // its thinking blocks came empty **with or without the flag**,
            // so on this release it changes nothing that was seen; it is
            // sent for the documented guarantee, since what the flag
            // gates is the CLI's to decide per release, and the translator
            // reads the lines the same either way.
            "--forward-subagent-text".into(),
        ]);
        if let Some(m) = &self.model {
            a.push("--model".into());
            a.push(m.clone());
        }
        if let Some(e) = &self.effort {
            a.push("--effort".into());
            a.push(e.clone());
        }
        if let Some(f) = &self.fallback_model {
            a.push("--fallback-model".into());
            a.push(f.clone());
        }
        if let Some(tools) = &self.tools {
            a.push("--tools".into());
            // `--tools` takes a variadic list; the empty set is the empty
            // string, which is how the CLI spells "no tools".
            if tools.is_empty() {
                a.push(String::new());
            } else {
                a.extend(tools.iter().cloned());
            }
        }
        if !self.allowed_tools.is_empty() {
            a.push("--allowedTools".into());
            a.extend(self.allowed_tools.iter().cloned());
        }
        // The connectors he unticked, when they are on at all (backlog 235);
        // off, the environment hides every one and this is empty.
        let blocked = connectors::disallowed(self.claude_ai_connectors, &self.claude_ai_blocked);
        if !blocked.is_empty() {
            a.push("--disallowedTools".into());
            a.extend(blocked);
        }
        // Claude in Chrome (backlog 353): always one of the two, so the
        // CLI's own default never decides for a chat.
        a.push(
            if self.browser {
                "--chrome"
            } else {
                "--no-chrome"
            }
            .into(),
        );
        // Ask overrides the mode: the hook decides first, and what it
        // does not catch falls to Manual, which headless is a refusal the
        // transcript shows — never a silent classifier approval.
        match (&self.ask, &self.permission_mode) {
            (Some(ask), _) => {
                a.push("--permission-mode".into());
                a.push(ask.mode.permission_mode().into());
            }
            (None, Some(mode)) => {
                a.push("--permission-mode".into());
                a.push(mode.clone());
            }
            (None, None) => {}
        }
        // One `--settings` for everything sent inline: the CLI keeps only
        // the last one given (measured 2026-09-16, `auto_memory`'s doc), so
        // the Ask hook and the memory switch share a JSON object.
        let mut settings = serde_json::Map::new();
        // Claude Code's built-in chart plugin off, in every shape (nightshift
        // items 697 + 698, measured on CLI 2.1.325): `cc-plugin-easel` adds
        // "If a tool named mcp__easel__chart is available…" to the system
        // prompt's environment section only when its hook module has loaded
        // in time — a race, so the same chat's prompt differed between runs
        // (1 of 7 replays of one chat's argv), and every flip rewrote the
        // whole context past the tools (a turn, a keep-warm ping or an aside
        // read 12,781 and wrote 270k). Nightloom draws no CLI charts, so
        // nothing is lost. Both spellings: the plugin's own name and its
        // short alias.
        settings.insert(
            "enabledPlugins".into(),
            serde_json::json!({ "cc-plugin-easel@builtin": false, "easel@builtin": false }),
        );
        if let Some(ask) = &self.ask {
            // Under the Chat policy the Ask hook pauses only what the
            // policy leaves (backlog 147): a call both hooks match would
            // show a prompt whose answer cannot matter.
            // A seated aside of an asking chat (item 919) matches what the
            // chat's own hook does, and waits for the aside's card.
            let seated =
                ask.mode == AskMode::Aside && self.aside_cards && !ask.dir.as_os_str().is_empty();
            let base = if seated {
                AskMode::Ask.matcher()
            } else {
                ask.mode.matcher()
            };
            let matcher = if self.chat_policy {
                ask_matcher_under_chat_policy(base, self.browser)
            } else if self.born_chat {
                ask_matcher_in_born_chat(base, self.browser)
            } else {
                base.to_string()
            };
            if seated && !matcher.is_empty() {
                let mut entry = ask::hook_entry(&ask.hook, &ask.dir, &matcher, &[ask::WAIT_ARG]);
                entry["hooks"][0]["timeout"] = ask::WAIT_TIMEOUT_SECS.into();
                settings.insert("hooks".into(), serde_json::json!({ "PreToolUse": [entry] }));
            }
            if !matches!(ask.mode, AskMode::Aside | AskMode::PlanAside)
                && !matcher.is_empty()
                && let Ok(serde_json::Value::Object(hook)) = serde_json::from_str::<serde_json::Value>(
                    &ask::settings_json_matching(&ask.hook, &ask.dir, &matcher),
                )
            {
                settings.extend(hook);
            }
            a.push("--permission-prompt-tool".into());
            a.push(ask::PROMPT_TOOL.into());
        }
        if self.refuses_mcp_writers() {
            // A second `PreToolUse` entry beside the Ask hook's, in the same
            // array — the CLI runs every matching entry, and a deny from
            // any of them stands. The command is an `echo` of the reply,
            // so no program of Nightloom's has to be found for it to work.
            // The policy's own entry is a Chat-over-Claude-Code's; a born
            // Chat's tool list already holds only the readers (item 759).
            let reply = serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": CHAT_POLICY_REASON,
                }
            })
            .to_string();
            let entry = serde_json::json!({
                "matcher": CHAT_POLICY_MATCHER,
                "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
            });
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    if self.chat_policy {
                        pre.push(entry);
                    }
                    // The preview runs a command (item 430): it passes the
                    // policy's matcher as `mcp__` and is refused here, as
                    // the shell is.
                    let reply = serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": PREVIEW_UNDER_CHAT_POLICY_REASON,
                        }
                    })
                    .to_string();
                    pre.push(serde_json::json!({
                        "matcher": PREVIEW_TOOL_MATCHER,
                        "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
                    }));
                    // The browser's tools pass the policy's matcher as
                    // `mcp__` (backlog 353, blocker 1414): refused here.
                    if self.browser {
                        let reply = serde_json::json!({
                            "hookSpecificOutput": {
                                "hookEventName": "PreToolUse",
                                "permissionDecision": "deny",
                                "permissionDecisionReason": BROWSER_UNDER_CHAT_POLICY_REASON,
                            }
                        })
                        .to_string();
                        pre.push(serde_json::json!({
                            "matcher": BROWSER_TOOLS_MATCHER,
                            "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
                        }));
                    }
                    // The connector tools that write or send (item 759):
                    // the policy's matcher lets every `mcp__` through.
                    let reply = serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": connector_writes::REASON,
                        }
                    })
                    .to_string();
                    // Where a card can show (the Ask hook is there and this
                    // is not an aside), a connector action that is not a
                    // known read asks him instead, and so does `remember`
                    // (item 783, blockers 2033 and 2032); Nightloom's own
                    // note writes stay refused. Elsewhere the refusal
                    // stands as it was.
                    match &self.ask {
                        Some(ask)
                            if !matches!(ask.mode, AskMode::Aside | AskMode::PlanAside)
                                && !ask.dir.as_os_str().is_empty() =>
                        {
                            // Home's mail and calendar writers (item 845,
                            // 846 §7 step 5): out of the refusal, and asked
                            // about on their own card, one call at a time.
                            let known = if self.home_gated_writes {
                                connector_writes::KNOWN_WRITES_MATCHER_HOME
                            } else {
                                connector_writes::KNOWN_WRITES_MATCHER
                            };
                            pre.push(serde_json::json!({
                                "matcher": known,
                                "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
                            }));
                            pre.push(ask::hook_entry(
                                &ask.hook,
                                &ask.dir,
                                connector_writes::CARD_MATCHER,
                                &[ask::READ_ONLY_ARG],
                            ));
                            if self.home_gated_writes {
                                pre.push(ask::hook_entry(
                                    &ask.hook,
                                    &ask.dir,
                                    connector_writes::HOME_GATED_MATCHER,
                                    &[ask::READ_ONLY_ARG],
                                ));
                            }
                        }
                        _ => pre.push(serde_json::json!({
                            "matcher": connector_writes::MATCHER,
                            "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
                        })),
                    }
                }
            }
        }
        // Home's own writer outside the read-only hold (item 872): the
        // read-only chat's entries above gate or refuse it; anywhere else
        // in Home's project nothing would, so it is refused here — by
        // `echo`, so no program has to be found for the refusal to work.
        if self.home_chat && !self.refuses_mcp_writers() {
            let reply = serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": connector_writes::HOME_OWN_WRITER_UNHELD,
                }
            })
            .to_string();
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(serde_json::json!({
                        "matcher": connector_writes::HOME_OWN_WRITER_MATCHER,
                        "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
                    }));
                }
            }
        }
        // Playwright's gate (backlog 367): its own entry in every position,
        // the Chat policy's included — the policy lets `mcp__` through, and
        // the gate asks as it would anywhere.
        if let Some(pw) = &self.playwright {
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(pw.hook_entry());
                }
            }
        }
        // The plan tools on Auto (backlog 294, blocker 1030): offered with
        // the prompt tool, refused in words. Not beside the Chat policy,
        // whose own deny already covers them.
        if let Some(ask) = &self.ask
            && ask.mode.is_auto()
            && !self.chat_policy
        {
            let reply = serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": ask::PLAN_TOOLS_ON_AUTO,
                }
            })
            .to_string();
            let entry = serde_json::json!({
                "matcher": ask::PLAN_TOOLS_MATCHER,
                "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
            });
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(entry);
                }
            }
        }
        // The subagent brief's hook (backlog 152), a third `PreToolUse`
        // entry in the same array. ~~On `Agent|Task` alone: every position
        // but the Chat policy's (which refuses the call)~~ — since pass 2
        // of backlog 165 (2026-09-22) the entry matches every tool and is
        // registered in every position, the Chat policy's and a council
        // seat's included: the same hook enforces the message's budget on
        // each call, and only a spawn goes on to the brief (which the
        // policy's own deny still wins over, backlog 147's measurement).
        if let Some(brief) = &self.brief
            && !brief.dir.as_os_str().is_empty()
        {
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(brief::hook_entry(&brief.hook, &brief.dir));
                }
                // The same hook on each user message (nightshift 561): a
                // fresh usage line before the model answers, so a reply
                // written before any tool call does not quote an older
                // message's figure.
                let prompt = hooks
                    .entry(brief::PROMPT_EVENT)
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(prompt) = prompt {
                    prompt.push(brief::prompt_hook_entry(&brief.hook, &brief.dir));
                }
            }
        }
        // `add_folder`'s gate (nightshift item 613): its own entry in every
        // position, as Playwright's is, and last of the entries — wherever
        // the chat's directory is known (the tool is served there,
        // `--budget-dir`).
        // `request_secret`'s gate (item 766) beside it, the same way.
        // `ask_user_to_drive`'s (item 872) after them, the same way.
        for entry in [
            self.folder_gate_entry(),
            self.secret_gate_entry(),
            self.drive_gate_entry(),
        ]
        .into_iter()
        .flatten()
        {
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(entry);
                }
            }
        }
        if !self.auto_memory {
            settings.insert("autoMemoryEnabled".into(), serde_json::Value::Bool(false));
        }
        // An incognito chat's refused reads (backlog 405), in the same one
        // JSON: a flag source, so it holds under the empty
        // `--setting-sources` below (measured, 405 report M0).
        if !self.denied_reads.is_empty() {
            settings.insert(
                "permissions".into(),
                serde_json::json!({
                    "deny": crate::incognito::deny_rules(&self.denied_reads)
                }),
            );
        }
        if !self.auto_compact {
            settings.insert("autoCompactEnabled".into(), serde_json::Value::Bool(false));
        }
        if self.fork_mode {
            // Fork mode (backlog 104): the settings spelling of the switch,
            // in the same one JSON, beside the environment spelling
            // (`env_set`) — the survey's M2c ran both and got the fork.
            settings.insert(
                "env".into(),
                serde_json::json!({ "CLAUDE_CODE_FORK_SUBAGENT": "1" }),
            );
        }
        if !settings.is_empty() {
            a.push("--settings".into());
            a.push(serde_json::Value::Object(settings).to_string());
        }
        if let Some(s) = &self.system_prompt {
            a.push("--system-prompt".into());
            a.push(s.clone());
        }
        if let Some(s) = &self.append_system_prompt {
            a.push("--append-system-prompt".into());
            a.push(s.clone());
        }
        if self.system_prompt_snapshot_off {
            a.push("--system-prompt-snapshot".into());
            a.push("off".into());
        }
        if self.fork_mode {
            // The checkpoint helper's roster entry (backlog 104): a flag,
            // not a settings source, so it stands under safe mode's empty
            // `--setting-sources` too (measured in the pass-3 report).
            a.push("--agents".into());
            a.push(fork::agents_json());
        }
        if self.safe_mode || self.incognito {
            // Not `--safe-mode`: see the field doc's table — that flag
            // drops the `--mcp-config` server with everything else. No
            // setting source at all is what leaves Nightloom's server
            // standing while the host's CLAUDE.md, hooks and allowlist go.
            a.push("--setting-sources".into());
            a.push(String::new());
            a.push("--strict-mcp-config".into());
            a.push("--disable-slash-commands".into());
        }
        // Never a real session from a dev scratch home (item 1011): the
        // backstop under every process this spec builds — a prewarm, a
        // checkpoint fork — beside the turn's own refusal in `drive_as`.
        if let Some(id) = self
            .resume
            .as_ref()
            .filter(|id| dev_guard::foreign_resume(id).is_none())
        {
            a.push("--resume".into());
            a.push(id.clone());
            // Meaningless without a session to fork, so never sent alone.
            if self.fork_session {
                a.push("--fork-session".into());
            }
        }
        if let Some(budget) = self.max_budget_usd {
            a.push("--max-budget-usd".into());
            a.push(budget.to_string());
        }
        if let Some(n) = self.max_turns {
            a.push("--max-turns".into());
            a.push(n.to_string());
        }
        for dir in &self.add_dirs {
            a.push("--add-dir".into());
            a.push(dir.to_string_lossy().into_owned());
        }
        if let Some(cfg) = &self.mcp_config {
            a.push("--mcp-config".into());
            a.push(cfg.clone());
        }
        if self.no_session_persistence {
            a.push("--no-session-persistence".into());
        }
        if self.prompt_suggestions {
            a.push("--prompt-suggestions".into());
            a.push("true".into());
        }
        a.extend(self.extra_args.iter().cloned());
        // No NUL in any argument (nightshift backlog 307): the OS cannot
        // pass one, and a single NUL anywhere — a layer file's bytes in the
        // system prompt — made every chat in a project fail to start with
        // "nul byte found in provided data". Dropped here as the last line
        // of defense; the layers themselves keep binary out.
        for arg in &mut a {
            if arg.contains('\0') {
                *arg = arg.replace('\0', "");
            }
        }
        a
    }
}

/// How one turn's user message reaches the CLI — see [`AgentSpec::argv`].
#[derive(Debug, Clone, Copy)]
enum Shape<'a> {
    Prompt(&'a str),
    Stdin,
    Resume,
}

/// How a background pass — a dream, a capture — drives the CLI
/// (2026-09-16, nightshift backlog 070).
///
/// A chat's connection carries a dozen settings; a pass needs four of them,
/// and this is the shape that says which. The binary, the model alias and
/// safe mode are the rail's own, so a pass runs on whatever the user
/// already trusts a chat with; the subscription default is
/// [`AgentSpec::use_subscription`]'s, for its reason — the pass exists so a
/// dream bills the plan and not a key, and an inherited key would silently
/// undo that. Nothing of a chat's crosses: no preamble (the pass has its own
/// instruction), no `--add-dir` (the target folder is the working
/// directory, and the one file it must not reach lives above it), no
/// resume (each target is one fresh turn).
///
/// `server` is how Nightloom's MCP server is started — the program and its
/// leading arguments, `[<desktop binary>, "--mcp-serve"]` from the app and
/// `[nightloom, "mcp-serve"]` from the CLI. A dream appends
/// `--dream <json>` so the server serves `propose_instructions` and nothing
/// else (`mcp_server::DreamServe`); a capture starts no server at all.
#[derive(Debug, Clone)]
pub struct PassSpec {
    pub binary: String,
    /// Model alias (`haiku`, `sonnet`) or a full id; `None` is the CLI's
    /// default, as for a chat.
    pub model: Option<String>,
    pub safe_mode: bool,
    pub use_subscription: bool,
    pub server: Vec<String>,
}

impl PassSpec {
    pub fn new(binary: impl Into<String>, server: Vec<String>) -> Self {
        Self {
            binary: binary.into(),
            model: None,
            safe_mode: false,
            use_subscription: true,
            server,
        }
    }

    /// An [`AgentSpec`] rooted at `cwd` with this pass's settings and
    /// nothing else set: the caller names the tools, the permission mode,
    /// the system prompt and the server. Kept as the one place the four
    /// carried settings are copied across, so a dream and a capture cannot
    /// differ in which of the rail's settings they honour.
    pub fn spec_in(&self, cwd: impl Into<PathBuf>) -> AgentSpec {
        let mut spec = AgentSpec::new(cwd);
        spec.binary = self.binary.clone();
        spec.model = self.model.clone();
        spec.safe_mode = self.safe_mode;
        spec.use_subscription = self.use_subscription;
        spec
    }
}
