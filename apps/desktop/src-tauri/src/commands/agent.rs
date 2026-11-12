//! The connect_agent command: the Claude Code agent's connect, open chats, the pass engine and the agent version (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// The default binary, matching the CLI's `--agent-binary`.
pub(crate) const AGENT_BINARY: &str = "claude";

/// Refuse a command that edits the conversation while the agent engine is
/// live.
///
/// Rewinding, compacting and eliding all work by changing what the *log*
/// projects onto the next request. On this engine nothing projects: the next
/// turn is `--resume <id>` against a history Claude Code keeps, so every one
/// of them would rewrite the window and leave the conversation exactly as it
/// was. A control that appears to work and does nothing is worse than one
/// that is not offered, so the UI hides these and this is the backstop under
/// that — the two have to agree, and only one of them is checkable.
///
/// **Lifted for `rewind`, `edit_message`, `remove_message` and
/// `fork_session` on 2026-09-15 (nightshift backlog 062).** Those four now
/// change Claude Code's history too: they copy the CLI's session file with
/// the change made, under a new id, and point the next turn at the copy
/// (`edit_on_cli`). `compact` and `edit_context` keep the guard — a
/// compaction is the CLI's own business inside its history, and the
/// context panel's elision is the same marker `remove_message` records,
/// reached from a view that on this engine itemizes the preamble alone.
pub(crate) async fn not_in_agent_mode(state: &AppState, what: &str) -> Result<(), String> {
    // The flag, not the lock (backlog 159, A1): a turn holds the agent.
    if state.agent_live.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(context_ops::not_on_claude_code(what));
    }
    Ok(())
}

/// Connect the Claude Code engine: turns run through the signed-in CLI and
/// are billed to the subscription rather than to an API key.
///
/// Deliberately a command of its own rather than a `provider` value on
/// [`connect`]. Almost none of that call's arguments mean anything here — no
/// base URL, no thinking mode, no sidecar, no MCP list, no reviewers —
/// because Claude Code assembles its own prompt and runs its own loop. A
/// shared entry point would be one whose arguments are mostly inert, which
/// is the shape that invites a knob to be silently ignored.
///
/// The preamble is the one layer that crosses. It used to be withheld on the
/// same reasoning, and the result was a chat that started knowing nothing a
/// chat on the other engine knows — not the user's standing instructions,
/// not the project's `AGENTS.md`, not which notes exist. Claude Code owns
/// the identity and the environment; the rest is ours to know and goes in
/// `--append-system-prompt` ahead of the library prompt
/// ([`nightloom_service::agent_preamble`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect_agent(
    state: State<'_, AppState>,
    binary: Option<String>,
    model: Option<String>,
    workspace: Option<String>,
    tools: bool,
    approval: Option<bool>,
    safe_mode: Option<bool>,
    budget: Option<f64>,
    system: Option<String>,
    preamble: Option<bool>,
    ask: Option<bool>,
    plan: Option<bool>,
    prompt_suggestions: Option<bool>,
    effort: Option<String>,
    fallback_model: Option<String>,
    subagents_auto: Option<bool>,
    limits: Option<nightloom_service::agent::brief::SubagentLimits>,
    fork_mode: Option<bool>,
    claude_ai_connectors: Option<bool>,
    claude_ai_blocked: Option<Vec<String>>,
    browser: Option<bool>,
    holds: State<'_, prompt_hold::Pending>,
    cold: Option<bool>,
    auto_layers: Option<bool>,
    update_now: Option<Vec<SegmentKind>>,
    subagent_rules: Option<String>,
) -> Result<ConnectedInfo, String> {
    // Never a silent hang (nightshift item 220): the installed app sat at
    // "connecting…" for forty minutes with nothing to say what it waited
    // on. The body records each wait; past the deadline the rail gets an
    // error naming it, and `~/.nightloom/logs/connect.log` a line.
    let stage = connect_deadline::Stage::new();
    let log = connect_deadline::log_path();
    // Its line in the startup log too (item 220, 2026-09-26), beside the
    // reopen and the vault read it used to wait behind.
    startup_log::timed(
        "connect_agent",
        connect_deadline::run(
            &stage,
            connect_deadline::CONNECT_TIMEOUT,
            log.as_deref(),
            connect_agent_body(
                &stage,
                &state,
                binary,
                model,
                workspace,
                tools,
                approval,
                safe_mode,
                budget,
                system,
                preamble,
                ask,
                plan,
                prompt_suggestions,
                effort,
                fallback_model,
                subagents_auto,
                limits,
                fork_mode,
                claude_ai_connectors,
                claude_ai_blocked,
                browser,
                &holds,
                cold,
                auto_layers,
                update_now,
                subagent_rules,
            ),
        ),
    )
    .await
}

/// [`connect_agent`]'s work, each wait named on `stage` first.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect_agent_body(
    stage: &connect_deadline::Stage,
    state: &AppState,
    binary: Option<String>,
    model: Option<String>,
    workspace: Option<String>,
    tools: bool,
    approval: Option<bool>,
    safe_mode: Option<bool>,
    budget: Option<f64>,
    system: Option<String>,
    preamble: Option<bool>,
    ask: Option<bool>,
    plan: Option<bool>,
    prompt_suggestions: Option<bool>,
    effort: Option<String>,
    fallback_model: Option<String>,
    subagents_auto: Option<bool>,
    limits: Option<nightloom_service::agent::brief::SubagentLimits>,
    fork_mode: Option<bool>,
    // His claude.ai connectors (nightshift backlog 235, blocker 490): off
    // unless the rail said on; the ones he unticked stay hidden when on.
    claude_ai_connectors: Option<bool>,
    claude_ai_blocked: Option<Vec<String>>,
    // Claude in Chrome (nightshift backlog 353, blocker 1412): off unless
    // the rail said on.
    browser: Option<bool>,
    // Nightshift backlog 174: the chat's cache timer reads cold, the
    // Settings default takes changes then, and *Update now* by layer.
    holds: &prompt_hold::Pending,
    cold: Option<bool>,
    auto_layers: Option<bool>,
    update_now: Option<Vec<SegmentKind>>,
    // His subagent rules in words for this chat (nightshift backlog 291):
    // the rail's box, or the Settings default; stated in the subagent
    // rules layer (293) with the limits and the fork switch.
    subagent_rules: Option<String>,
) -> Result<ConnectedInfo, String> {
    // Same rule as `connect`: an open project wins over the rail's saved
    // folder, or a chat filed under a project would be running somewhere
    // else entirely.
    stage.set("the open project (the workspaces lock)");
    let active = state.active().await;
    // Everything this connect needs of the open chat, read once and never
    // waiting on its turn (item 220): the log on disk while a turn holds it.
    let open = open_chat(state, active.as_ref(), stage).await;
    let kind = open.kind;
    let declared = open.declared;
    let workspace = match &active {
        Some(project) => project.workspace_dir(),
        None => workspace
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    };
    // The folder a switch to Claude Code named wins over the project's
    // (nightshift backlog 144), as in `connect`.
    // Checked for existence by `open_chat`, off the runtime (item 261).
    let workspace = open.kind_workspace.clone().unwrap_or(workspace);
    // A Chat runs in the neutral directory whatever the project or the
    // rail said (nightshift backlog 102; `chat_workspace`): the CLI's cwd,
    // its per-cwd session files and its auto memory all land there, and
    // the project's tree is not read as the chat's own. By the declaration
    // (backlog 144): a Chat that was born Claude Code stays in its folder
    // — measured, the CLI resumes a session from any folder and the cwd is
    // not in the cached prefix, but the folder's memory and CLAUDE.md are
    // what the CLI loads, and the switch is meant to change nothing there.
    let workspace = chat_workspace(declared, workspace);
    // An incognito chat knows nothing about him (nightshift backlog 405,
    // blocker 1513): the CLI runs in an empty folder of the chat's own,
    // outside the project and `~/.nightloom`, so no project name is in its
    // cwd, its per-cwd files or an `--add-dir`; `seen` is the project as
    // the model sees it — none. The window's `active` stays for the rail.
    let mode = open.mode;
    let incognito = mode.writes_nothing();
    let workspace = if incognito {
        nightloom_service::incognito::workspace(open.chat.as_deref())
    } else {
        workspace
    };
    let seen = active.as_ref().filter(|_| !incognito);

    let mut spec = AgentSpec::new(workspace.clone());
    spec.binary = binary
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| AGENT_BINARY.into());
    spec.model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    spec.max_budget_usd = budget.filter(|b| *b > 0.0);
    // The subagent limits (backlog 165): the CLI's two as environment at
    // spawn, Nightloom's four written beside the brief for the hook.
    spec.subagent_limits = limits;
    // Fork mode (nightshift backlog 104, pass 3; blocker 288): the rail's
    // per-chat switch, on unless it said off.
    spec.fork_mode = fork_mode.unwrap_or(true);
    spec.safe_mode = safe_mode.unwrap_or(false);
    // His claude.ai connectors (backlog 235; blocker 490, his words: "by
    // default no"): off unless the rail said on — and a rail that says
    // nothing, an older one included, is off.
    spec.claude_ai_connectors = claude_ai_connectors.unwrap_or(false);
    spec.claude_ai_blocked = claude_ai_blocked.unwrap_or_default();
    // Claude in Chrome (backlog 353): his real browser, so off unless the
    // rail said on — and a rail that says nothing, an older one, is off.
    spec.browser = browser.unwrap_or(false);
    // Effort and the fallback model (backlog 076), as the rail spelled
    // them; empty is the CLI's default and no fallback.
    spec.effort = effort
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    spec.fallback_model = fallback_model
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty());
    // Off unless the shell asked (nightshift backlog 083): the CLI waits
    // for the prediction before it exits, about six seconds a turn.
    spec.prompt_suggestions = prompt_suggestions.unwrap_or(false);
    // A chat does not compact (nightshift backlog 086): the shell's
    // hand-off — a wrap-up into HANDOFF.md and a linked new chat — is what
    // its window filling means. Only a chat: a dream or a capture keeps the
    // CLI's own compaction, having nothing else (the whole-project review
    // of 2026-09-16, F4).
    spec.auto_compact = false;
    // Same vault call and the same project context `connect` builds, and
    // gated on the same switch: off means "nothing but what I typed" on
    // both engines. The library prompt is the trailer rather than the
    // config's `custom` layer, so it stays recognisable as what the shell
    // passed and still wins by position.
    let preamble = preamble.unwrap_or(true);
    let knowledge = preamble
        .then(nightloom_service::knowledge::vault_dir)
        .flatten()
        .filter(|_| !incognito);
    // The vault sits outside every workspace, and the preamble is about to
    // name it by its real path; granting the directory is what makes that
    // path one the CLI will open rather than route to a classifier that,
    // headless, can only decline (nightshift blocker 050; `AgentSpec::add_dirs`
    // says what the grant covers).
    spec.add_dirs = knowledge.iter().cloned().collect();
    // The same grant names the folder the note organisers work in (item
    // 472, `--notes` below).
    let notes_root = knowledge.clone();
    // The extra folders (nightshift backlog 143): the project's and the
    // chat's own, each granted the same way — readable without a prompt,
    // edits under the permission mode (`external`, the CLI's permissions
    // reference, via blocker 050).
    let granted = if incognito {
        Vec::new()
    } else {
        open.granted.clone()
    };
    spec.add_dirs.extend(granted.iter().map(|(p, _)| p.clone()));
    // Built as segments and rendered from them, so the Context popover can
    // show the same segments the flag carries rather than a re-parse of the
    // string (see `PromptBuilt`). The chat's own exclusions apply here as on
    // the other engine, plus the one layer that exists only here.
    let mut off = open.off.clone();
    // Backlog 405: never the project's layers or the vault index.
    if incognito {
        off.extend(nightloom_service::incognito::LAYERS_OFF);
    }
    let edits = open.edits.clone();
    // The CLI's own memory is a layer the chat can switch off like the
    // rest (nightshift backlog 088), but never one Nightloom assembles:
    // the kind reaches the CLI as a setting, not as text.
    spec.auto_memory = !off.contains(&SegmentKind::CliMemory);
    // The subagents layer says `reusable` only when the roster has it: the
    // user's own agent file, dropped under safe mode (nightshift backlog 251).
    let reusable = !spec.safe_mode
        && !incognito
        && nightloom_service::usage::claude_dir()
            .is_some_and(|c| c.join("agents").join("reusable.md").exists());
    // Nightshift 575: a Claude Code that reads the folder's `AGENTS.md`
    // itself (by version, safe mode, the CLAUDE.md files on the path and
    // his `instructionFiles` setting) gets no second copy from the walk.
    // Its version is asked once per install, off the runtime.
    let cli_agents_md = if preamble && !incognito {
        let (bin, safe, cwd) = (spec.binary.clone(), spec.safe_mode, workspace.clone());
        tokio::task::spawn_blocking(move || {
            nightloom_service::start_context::spawned_cli_reads_agents_md(&bin, !safe, &cwd)
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };
    let prompt = nightloom_service::agent_prompt_with(
        &PromptConfig {
            identity: false,
            environment: false,
            project_instructions: preamble,
            user_memory: preamble,
            // By the alias the rail sent (`opus`, `sonnet`), not the dated id
            // the CLI resolves it to: that arrives with the first turn, after
            // this prompt is built once for the session. So on this engine
            // the file is named after the alias, and a chat on the CLI's
            // default model (no alias) reads none.
            model: preamble.then(|| spec.model.clone()).flatten(),
            // The Chat instructions ride the preamble switch like the
            // model's file (nightshift backlog 102); appended after the
            // CLI's own prompt, which stays underneath a Chat. By the
            // declaration (backlog 144): the layer is in the prompt, and
            // a switch must not rewrite the prompt.
            chat_instructions: preamble && declared == ChatKind::Chat,
            project: preamble
                .then(|| {
                    seen.map(|p| ProjectContext {
                        name: p.name.clone(),
                        notes_dir: p.notes_dir(),
                    })
                })
                .flatten(),
            knowledge: knowledge.map(|dir| KnowledgeContext { dir }),
            // The thread layer (backlog 271), on the preamble switch.
            thread: preamble
                .then(|| thread_context(seen, open.thread.as_deref()))
                .flatten(),
            cwd: workspace.clone(),
            custom: None,
            edits: edits.clone(),
        }
        .without(&off),
        system.as_deref(),
        nightloom_service::EngineLayers {
            engine_note: !off.contains(&SegmentKind::EngineNote),
            // The pacing rule and the subagent practices (backlog 250,
            // 251): on by default, each a row of its own on the Context page.
            pacing: !off.contains(&SegmentKind::Pacing),
            subagents: !off.contains(&SegmentKind::Subagents),
            reusable,
            // What the layer says about the model follows the rail's
            // "Subagents use" (nightshift 257, blocker 584).
            subagent_model: spec.subagent_limits.unwrap_or_default().model,
            // The subagent rules layer (backlog 291 + 293): his words, the
            // limits and the fork switch; a row of its own on the Context page.
            subagent_rules: (!off.contains(&SegmentKind::SubagentRules)).then_some(
                nightloom_service::SubagentRules {
                    words: subagent_rules.as_deref().unwrap_or(""),
                    limits: spec.subagent_limits.unwrap_or_default(),
                    fork_mode: spec.fork_mode,
                },
            ),
            // Nightshift 573: <pacing> names only the limits that are on,
            // and is absent when the budget and the stop line both are.
            limits: spec.subagent_limits,
            cli_agents_md,
            // Backlog 405: the engine note names only what an incognito
            // chat's server serves.
            incognito,
        },
    );
    // A changed layer waits for the chat's cold moment (nightshift backlog
    // 174, `prompt_hold`): the held text goes out while the cache is warm.
    let prompt = {
        stage.set("the chats folder (the workspaces lock)");
        let log_dir = state.log_dir().await;
        // `chat` is the chat this connection is built for, whatever its
        // mode; `id` is the one whose hold is kept (an ephemeral chat
        // keeps nothing on disk).
        let (chat, id, has_cli) = (open.chat.clone(), open.hold_id.clone(), open.has_cli);
        let file = id.as_deref().map(|id| prompt_hold::file_for(&log_dir, id));
        let held = file.as_deref().and_then(prompt_hold::load);
        let r = prompt_hold::resolve(
            &prompt,
            held.as_ref(),
            has_cli,
            &prompt_hold::Ask {
                cold: cold.unwrap_or(true),
                auto: auto_layers.unwrap_or(true),
                // A layer he switched off or gave its own text is his
                // click already: taken now, like *Update now*.
                now: update_now
                    .unwrap_or_default()
                    .into_iter()
                    .chain(off.iter().copied())
                    .chain(edits.keys().copied())
                    // The Preamble switch off is every layer at once.
                    .chain(SegmentKind::LAYERS.iter().copied().filter(|_| !preamble))
                    // A thread bound, unbound or switched (backlog 271) is
                    // his click too; a Start here the model rewrote under
                    // the same thread waits for the cold moment like any
                    // changed file.
                    .chain(thread_rebound(held.as_ref(), &prompt).then_some(SegmentKind::Thread))
                    .collect(),
            },
        );
        if let Some(f) = &file
            && let Err(e) = prompt_hold::save(f, &r.hold)
        {
            eprintln!("prompt hold not saved at {}: {e}", f.display());
        }
        spec.system_prompt_snapshot_off = r.hold.snapshot_off;
        // New chat: the first turn creates the chat and writes this hold
        // under its id (`Pending::bind_new_chat`, from `send_agent`).
        stage.set("the prompt-hold view (the prompt-hold locks)");
        *holds.unsaved.lock().await = chat.is_none().then(|| r.hold.clone());
        *holds.view.lock().await = prompt_hold::PendingView {
            session: chat,
            layers: r.pending,
            // Changed subagent rules on a warm chat (backlog 293): carried
            // by its next message (`send_agent`).
            rules_note: r.rules_note,
        };
        *holds.file.lock().await = file;
        r.prompt
    };
    spec.append_system_prompt = prompt.render_flat();
    // What the subagent brief takes beyond the preamble's own segments
    // (nightshift backlog 152): the extra-folders note, when there is one.
    let mut brief_notes: Vec<String> = Vec::new();
    // The model is told which extra folders it may open, by their real
    // paths — the CLI's tools take absolute paths, and a grant the model
    // does not know about is one it never uses (backlog 143). Under the
    // engine-note switch like the other notes.
    if !granted.is_empty() && !off.contains(&SegmentKind::EngineNote) {
        let list: Vec<String> = granted
            .iter()
            .map(|(p, source)| format!("{} ({source})", p.display()))
            .collect();
        let note = format!(
            "<extra-folders>\nBesides the working directory, this chat may read and edit \
             these folders, by their absolute paths: {}. Notes and AGENTS.md stay in the \
             working directory.\n</extra-folders>",
            list.join("; ")
        );
        brief_notes.push(note.clone());
        spec.append_system_prompt = Some(match spec.append_system_prompt.take() {
            Some(s) => format!("{s}\n\n{note}"),
            None => note,
        });
    }
    // The subagent brief (nightshift backlog 152, 2026-09-17): the
    // project's instructions and the engine note, prepended to every
    // subagent's task by a hook on the `Agent` tool — the child gets none
    // of `--append-system-prompt` otherwise (measured; `agent::brief`).
    // Composed here, beside the preamble it is cut from; registered below
    // with the tools, since a subagent is one.
    let brief_text = nightloom_service::agent::brief::compose(&prompt, &brief_notes);
    if tools {
        // Headless has no way to ask, so the window's approval prompt does
        // not run here: it gates calls the engine is about to run, and this
        // engine runs its own. On means the CLI's `auto` — its classifier
        // decides, and a call it cannot approve is denied rather than left
        // waiting for an answer nobody can give (see the helper's doc, and
        // nightshift blocker 045 for why this is no longer `dontAsk`). Off
        // is `bypassPermissions`.
        spec.permission_mode =
            Some(AgentSpec::headless_permission_mode(approval.unwrap_or(true)).into());
        // The Ask position (2026-09-16, nightshift backlog 084): the CLI
        // pauses on each call a person should decide, this binary is its
        // hook, and the window asks. Only with approval on — off is "run
        // everything", and Ask is the opposite of that.
        // The Plan position (backlog 085) is Ask under `plan` mode — the
        // same hook and prompt tool, nothing edited until the card's plan
        // is approved — so it implies Ask and is subject to the same rule.
        let plan = plan.unwrap_or(false) && approval.unwrap_or(true);
        let ask = (ask.unwrap_or(false) || plan) && approval.unwrap_or(true);
        // The Auto position asks the model's questions too (nightshift
        // backlog 294, 2026-10-03): the same hook and prompt tool, the hook
        // on `AskUserQuestion` alone, so any position with approval on
        // carries them. Off (`bypassPermissions`) stays without (blocker
        // 1033).
        let questions = approval.unwrap_or(true);
        // The CLI lists AskUserQuestion and the plan tools only when a
        // prompt tool is named (084's M1), but its descriptions assume a
        // terminal; nothing tells the model a person is here and sees a
        // form. One paragraph, Ask and Plan only, so the other positions'
        // prompts are byte-identical to before (2026-09-16, his "make a
        // judgement call").
        if ask && !off.contains(&SegmentKind::EngineNote) {
            let note = "<ask-note>\nA person is watching this chat in Nightloom and answers \
                        in the window: a tool call that needs approval pauses for them, \
                        AskUserQuestion shows them a form, and a plan shows them a card \
                        with Approve and Keep planning. When a choice is theirs to make \
                        — a design call, a tradeoff, an ambiguous request — ask with \
                        AskUserQuestion rather than guessing; they expect it here.\n\
                        </ask-note>";
            spec.append_system_prompt = Some(match spec.append_system_prompt.take() {
                Some(s) => format!("{s}\n\n{note}"),
                None => note.to_string(),
            });
        } else if questions && !off.contains(&SegmentKind::EngineNote) {
            // The Auto position's form of it (backlog 294, blocker 1034):
            // nothing else pauses there, so the note says only the question.
            let note = nightloom_service::agent::ask::AUTO_NOTE;
            spec.append_system_prompt = Some(match spec.append_system_prompt.take() {
                Some(s) => format!("{s}\n\n{note}"),
                None => note.to_string(),
            });
        }
        // What a subagent must be told (nightshift backlog 152, his
        // fallback, kept whether or not the brief hook is registered): a
        // child starts with nothing of this conversation. The paragraph
        // says what Nightloom hands it and what the parent's task must
        // carry; under Ask, that a child's calls run or are refused by
        // the switch, never paused. Under the engine-note switch.
        if !off.contains(&SegmentKind::EngineNote) {
            let handed = if brief_text.is_some() {
                "Nightloom puts the project's instructions and the engine note above in \
                 front of its task automatically; everything else it needs must be in \
                 the task you write"
            } else {
                "it is handed nothing of this preamble, so its task must carry what it \
                 needs of it — the vault alias and directory, the project's rules, \
                 which of Nightloom's tools to use"
            };
            let note = format!(
                "<subagent-note>\nA subagent you spawn (the Agent tool) starts with none \
                 of this conversation: {handed}: what to do, which files or vault notes \
                 to read, where to write, and what to report back. Under the Ask \
                 position a subagent cannot pause for the person's approval — its calls \
                 either run unasked (the chat's Subagents-run-on-auto switch, on by \
                 default) or are refused with a reason it will repeat to you — so give \
                 a subagent only work you would let run, and make the calls that need \
                 an approval yourself.\n</subagent-note>"
            );
            spec.append_system_prompt = Some(match spec.append_system_prompt.take() {
                Some(s) => format!("{s}\n\n{note}"),
                None => note,
            });
        }
        // Nightloom's own tools on this engine — search_chats, read_chat,
        // remember, fetch_page — served by the binary the app is running as
        // (`--mcp-serve` at the top of `main`), because the CLI is not on
        // PATH on most machines that have the app. Inside `if tools` on
        // purpose: `--tools ""` does not disable MCP tools, and a connection
        // that asked for none should not get four. Under safe mode the CLI's
        // `--strict-mcp-config` makes this the only server, which is the
        // point (nightshift backlog 046).
        if let Ok(exe) = std::env::current_exe() {
            let mut args = vec!["--mcp-serve".to_string()];
            if let Some(p) = seen {
                args.push("--project".into());
                args.push(p.id.clone());
            }
            // ~~The server for a chat that writes nothing serves no
            // `remember`; the two readers and the fetch stay (2026-09-15).~~
            // Since backlog 405 (2026-10-24) such a chat's server is
            // `--incognito`: no `remember`, and none of the readers of his
            // chats, memory or Notion either; the fetch stays.
            if incognito {
                args.push("--incognito".into());
            }
            // The vault this chat was granted, for the note organisers
            // (item 472); none for an incognito chat, which has no vault.
            if let Some(dir) = &notes_root {
                args.push("--notes".into());
                args.push(dir.to_string_lossy().into_owned());
            }
            // The chat's folder, for `send_file` (nightshift backlog 343).
            args.push("--root".into());
            args.push(workspace.to_string_lossy().into_owned());
            // The chat's preview (nightshift item 430): the app's socket;
            // `set_ask_dir` adds the chat before each turn.
            if let Some(sock) = preview::socket() {
                args.push("--preview".into());
                args.push(sock.to_string_lossy().into_owned());
            }
            if questions {
                // The permission host the CLI is pointed at, which must be a
                // tool that exists (`agent::ask::PROMPT_TOOL` has the
                // measurement); served by the same process as the rest.
                args.push("--ask".into());
                spec.ask = Some(nightloom_service::agent::AskSpec {
                    hook: vec![
                        exe.to_string_lossy().into_owned(),
                        "--permission-hook".into(),
                    ],
                    // Per chat; `send_agent` points it at the open chat's
                    // directory before each turn, once the chat exists.
                    dir: PathBuf::new(),
                    mode: if plan {
                        nightloom_service::agent::AskMode::Plan
                    } else if ask {
                        nightloom_service::agent::AskMode::Ask
                    } else {
                        nightloom_service::agent::AskMode::Auto
                    },
                    // *Subagents run on auto* (nightshift backlog 152): the
                    // rail's switch, on unless it said off; written into
                    // the chat's rules by `set_ask_dir` before each turn.
                    subagents_auto: subagents_auto
                        .unwrap_or(nightloom_service::agent::ask::SUBAGENTS_AUTO_DEFAULT),
                });
            }
            // The brief's hook is the same binary with another flag;
            // `send_agent` points it at the chat's directory with the ask
            // files, and the file is written there (backlog 152).
            if let Some(text) = brief_text.clone() {
                spec.brief = Some(nightloom_service::agent::BriefSpec {
                    hook: vec![exe.to_string_lossy().into_owned(), "--subagent-hook".into()],
                    dir: PathBuf::new(),
                    text,
                });
            }
            let mut servers = serde_json::Map::new();
            servers.insert(
                nightloom_service::mcp_server::SERVER_NAME.into(),
                serde_json::json!({
                    "command": exe.to_string_lossy(),
                    "args": args,
                }),
            );
            // Playwright, Claude's own browser (nightshift backlog 367,
            // blocker 1413): in every Claude Code chat when installed, each
            // call gated by an approval card in every position.
            nightloom_service::agent::own_browser::add_to(
                &mut spec,
                &mut servers,
                vec![
                    exe.to_string_lossy().into_owned(),
                    "--permission-hook".into(),
                ],
            );
            spec.mcp_config = Some(serde_json::json!({ "mcpServers": servers }).to_string());
        }
    } else {
        spec.tools = Some(Vec::new());
    }
    // After the tool decision above, which it narrows and never widens:
    // the measured read-only list for either non-normal mode, and no CLI
    // session file for an ephemeral one (`AgentSpec::apply_mode`).
    spec.apply_mode(mode);
    // Backlog 405: no `--add-dir`, auto memory, settings files, skills,
    // other MCP servers, connectors or Chrome, and every folder of his
    // refused to Read, Glob and Grep (`AgentSpec::apply_incognito`).
    if incognito {
        let projects = state.workspaces.lock().await.registry.projects();
        spec.apply_incognito(nightloom_service::incognito::denied_roots(
            project::config_dir().as_deref(),
            &projects,
        ));
    }
    // And the kind's own narrowing (nightshift backlog 102): a Chat gets
    // the same five read-only tools; the folder was chosen above. By the
    // declaration (backlog 144) — and the policy over it: a Chat that was
    // born Claude Code keeps every tool listed and gets the hook that
    // refuses the writers (`AgentSpec::chat_policy`), which is what keeps
    // the cached prefix across the switch.
    spec.apply_kind(declared);
    spec.apply_kind_policy(kind, declared);

    // Probed rather than assumed. A missing or unrunnable binary is the
    // overwhelmingly likely first failure on this engine, and finding out at
    // connect gives the rail something to show instead of a turn that dies
    // with a process error the first time the user sends anything.
    // Item 231: a probe that answered for this same file is not waited
    // for again; `connect_deadline::probe` says why and sets the stage.
    let cache = connect_deadline::probe_cache_path();
    let (resolved_binary, version) = connect_deadline::probe(
        stage,
        cache.as_deref(),
        &spec.binary,
        &resolve_binary(&spec.binary),
        |b: String| async move { agent_version(&b).await },
    )
    .await?;

    // Pick the conversation back up if the open chat already has one. This
    // is the case where a session was started on the agent, the rail was
    // switched to a provider and back — without it the transcript would
    // carry on and the agent would have forgotten all of it.
    //
    // Not under `--no-session-persistence` (review 2026-09-17, C): an
    // ephemeral chat's log carries the id the CLI reported, but the CLI
    // saved nothing under it, and a `--resume` of it ends the next turn
    // with `error_during_execution` — the same failure `follow_on` was
    // taught to avoid on 2026-09-17, reached here by any rail change.
    if !spec.no_session_persistence
        && let Some(id) = open.resume.clone()
    {
        spec.resume = Some(id);
    }
    // The window, from the id the CLI last reported for this chat when the
    // alias names that family (nightshift backlog 216): every reconnect —
    // a chat reopened, a note saved, a pick — used to reset it to unknown.
    let window = {
        let focused = state.chats.lock_focused().await;
        let reported = focused.as_ref().and_then(last_model);
        nightloom_service::claude_code_window(spec.model.as_deref(), reported.as_deref())
    };

    let info = ConnectedInfo {
        provider: AGENT.into(),
        model: spec.model.clone().unwrap_or_else(|| "default".into()),
        // ~~Unknown until the CLI names the model it resolved~~ (216): an
        // alias like `sonnet` is not in the limits table, so it is read off
        // the id this chat's last turn reported; a chat that has not run on
        // the alias's family yet still waits for its first turn's report.
        context_limit: window,
        // No per-token bill under a subscription, and the CLI's own dollar
        // figure is an estimate of what the API *would* have charged. Left
        // `None` so the cost readout never renders it as money spent; the
        // rail shows it per turn, saying what it is.
        price: None,
        mcp: Vec::new(),
        reviewers: Vec::new(),
        workspace: workspace.to_string_lossy().into_owned(),
        project: active.as_ref().map(ProjectInfo::of),
        search: None,
        // The vault's index is on the request now, with its real directory
        // in the engine note — but this field is the folder Nightloom's file
        // tools are rooted at, and nothing here roots any: Claude Code owns
        // its own file access. Said as `None` rather than echoed, so the
        // rail's chip keeps meaning what it says.
        knowledge: None,
        engine: AGENT.into(),
        agent: Some(AgentInfo {
            binary: resolved_binary,
            version,
            subscription: spec.use_subscription,
            // What the CLI is actually started in: Ask is Manual mode with
            // the hook, which `args()` sends as `default` whatever the
            // field says; Plan is `plan` with the same hook (backlog 085).
            permission_mode: match spec.ask.as_ref().map(|a| a.mode) {
                Some(nightloom_service::agent::AskMode::Plan) => Some("plan (ask)".into()),
                Some(nightloom_service::agent::AskMode::Auto) => Some("auto (questions)".into()),
                Some(_) => Some("default (ask)".into()),
                None => spec.permission_mode.clone(),
            },
            safe_mode: spec.safe_mode,
            effort: spec.effort.clone(),
            fallback_model: spec.fallback_model.clone(),
            resume: spec.resume.clone(),
        }),
        // By path only: the CLI's tools take the absolute path (backlog 143).
        folders: granted
            .iter()
            .map(|(path, source)| FolderInfo {
                path: path.to_string_lossy().into_owned(),
                source: (*source).into(),
                alias: None,
            })
            .collect(),
    };
    let spec_model = spec.model.clone();
    // Built with the open chat's resume (above): the open chat's agent
    // now, and the spec every other chat's next agent is made from
    // (backlog 159, A2). A running turn keeps the agent it runs on.
    state
        .agents
        .connect(ClaudeCodeAgent::new(spec), state.chats.focus().as_deref());
    state
        .agent_live
        .store(true, std::sync::atomic::Ordering::SeqCst);
    stage.set("the provider engine's chat and the built prompt (their locks)");
    *state.chat.lock().await = None;
    *state.prompt.lock().await = PromptBuilt {
        off,
        edits,
        thread: thread_context(active.as_ref(), open.thread.as_deref()),
        // By the alias, as the prompt above looked it up.
        model: spec_model,
        cwd: Some(workspace),
        agent: Some(prompt),
        mode,
        kind,
        cli_agents_md,
    };
    Ok(info)
}

/// What `connect_agent` reads of the open chat — read once, at the start
/// (nightshift item 220, 2026-09-25). It used to lock the open chat seven
/// times over the connect, and each lock waited for that chat's running
/// turn: a rail change during a turn sat at "connecting…" for the turn's
/// whole length, with every other command on that chat queued behind it
/// (the item-136 family). A running turn never loses its agent to a connect
/// (`Agents::connect`), so nothing here needs the turn to end.
pub(crate) struct OpenChat {
    pub(crate) kind: ChatKind,
    pub(crate) declared: ChatKind,
    pub(crate) kind_workspace: Option<PathBuf>,
    /// The extra folders that exist — filled by [`open_chat`] from
    /// `candidates` on a blocking thread (item 261); empty from
    /// [`open_chat_of`], which never touches the disk.
    pub(crate) granted: Vec<(PathBuf, &'static str)>,
    pub(crate) candidates: FolderCandidates,
    pub(crate) off: Vec<SegmentKind>,
    pub(crate) edits: BTreeMap<SegmentKind, String>,
    /// The chat's research thread (backlog 271).
    thread: Option<String>,
    pub(crate) mode: ChatMode,
    /// The chat the connection is built for, whatever its mode.
    chat: Option<String>,
    /// The chat whose prompt hold is kept (not an ephemeral one).
    pub(crate) hold_id: Option<String>,
    /// Whether the chat has a Claude Code session already.
    pub(crate) has_cli: bool,
    /// The Claude Code session to `--resume`.
    pub(crate) resume: Option<String>,
}

/// The pure half of [`open_chat`]: the same answers `session_kind`,
/// `layers_off` and the rest give, from one read of the chat.
pub(crate) fn open_chat_of(
    session: Option<&Session>,
    active: Option<&Project>,
    pending_mode: ChatMode,
    pending_kind: ChatKind,
) -> OpenChat {
    let (chat, hold_id, has_cli) = match session {
        Some(s) if s.mode() != ChatMode::Ephemeral => (
            Some(s.id.clone()),
            Some(s.id.clone()),
            s.agent_session().is_some_and(|(a, _)| a == AGENT),
        ),
        Some(s) => (Some(s.id.clone()), None, false),
        None => (None, None, false),
    };
    OpenChat {
        kind: kind_of(session, pending_kind),
        declared: session.map(Session::declared_kind).unwrap_or(pending_kind),
        kind_workspace: session.and_then(|s| s.kind_workspace().map(Path::to_path_buf)),
        granted: Vec::new(),
        candidates: folder_candidates(active, session),
        off: session
            .map(|s| s.prompt_layers_off().to_vec())
            .unwrap_or_default(),
        edits: session
            .map(|s| s.prompt_layer_edits().clone())
            .unwrap_or_default(),
        thread: session.and_then(|s| s.thread().map(str::to_string)),
        mode: mode_of(session, pending_mode),
        chat,
        hold_id,
        has_cli,
        resume: session.and_then(resume_of),
    }
}

/// The open chat as `connect_agent` needs it, without waiting on its turn:
/// the held log when it is free, else the log on disk — what the turn has
/// appended so far, as `open_session` reads a running chat. Only an
/// incognito chat, which keeps no log, still waits for its turn (under the
/// connect's deadline, which names that wait).
pub(crate) async fn open_chat(
    state: &AppState,
    active: Option<&Project>,
    stage: &connect_deadline::Stage,
) -> OpenChat {
    let mut open = read_open_chat(state, active, stage).await;
    // The disk, asked off the runtime thread and under a stage of its own
    // (item 261): the 35 s wedge of 2026-09-28 was billed to "the pending
    // chat mode and kind (their locks)" because every stat here ran
    // inside that stage, synchronously, where the connect's deadline could
    // not fire until the stat returned.
    stage.set("the chat's folders on disk (a stat of each; a slow disk)");
    let candidates = std::mem::take(&mut open.candidates);
    let kind_workspace = open.kind_workspace.take();
    let checked = blocking(move || -> Result<_, String> {
        Ok((
            existing_folders(candidates),
            kind_workspace.filter(|p| p.is_dir()),
        ))
    })
    .await;
    if let Ok((granted, kind_workspace)) = checked {
        open.granted = granted;
        open.kind_workspace = kind_workspace;
    }
    open
}

/// [`open_chat`]'s reads of memory and of the chat's log.
pub(crate) async fn read_open_chat(
    state: &AppState,
    active: Option<&Project>,
    stage: &connect_deadline::Stage,
) -> OpenChat {
    stage.set("the pending chat mode and kind (their locks)");
    let pending_mode = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let target = state.chats.target();
    if let Ok(open) = target.try_lock() {
        return open_chat_of(open.as_ref(), active, pending_mode, pending_kind);
    }
    if let Some(id) = target.id().map(str::to_string) {
        stage.set("the open chat's log on disk (its turn holds the chat)");
        let dir = state.log_dir().await;
        let loaded = blocking(move || -> Result<Session, String> {
            let path = store::find_by_prefix(&dir, &id).map_err(|e| e.to_string())?;
            Session::load(path).map_err(|e| e.to_string())
        })
        .await;
        if let Ok(session) = loaded {
            return open_chat_of(Some(&session), active, pending_mode, pending_kind);
        }
    }
    stage.set("the open chat's lock (an incognito chat's turn is running)");
    let open = target.lock().await;
    open_chat_of(open.as_ref(), active, pending_mode, pending_kind)
}

/// Which agent a recorded [`SessionEvent::AgentSession`] belongs to.
pub(crate) const AGENT: &str = "claude-code";

/// What a background pass — a dream, a capture — runs on: a provider, or
/// the Claude Code engine (2026-09-16, nightshift backlog 070). The
/// frontend sends the same `provider` string it sends `connect`, with
/// [`AGENT`] as the one value that is not a `ProviderKind`; routing on it
/// here rather than in a second command keeps one lock, one cancel token
/// and one event channel per pass whichever engine runs it.
#[derive(Debug, PartialEq)]
pub(crate) enum PassEngine {
    Provider(ProviderKind),
    Agent,
}

pub(crate) fn pass_engine(provider: &str) -> Result<PassEngine, String> {
    if provider == AGENT {
        return Ok(PassEngine::Agent);
    }
    Ok(PassEngine::Provider(provider.parse()?))
}

/// The CLI settings a pass on the Claude Code engine carries: the rail's
/// binary (the default when blank, as `connect_agent`), the alias from
/// Settings → Knowledge, the rail's safe mode, and this binary as the MCP
/// server — the same `current_exe() --mcp-serve` a chat's server runs as,
/// because it is the one binary the app can always find. The subscription
/// stays on: a pass exists to bill the plan.
pub(crate) fn pass_spec(
    binary: Option<String>,
    model: Option<String>,
    safe_mode: Option<bool>,
) -> Result<PassSpec, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot find this binary to serve propose_instructions from: {e}"))?;
    let mut pass = PassSpec::new(
        binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| AGENT_BINARY.into()),
        vec![exe.to_string_lossy().into_owned(), "--mcp-serve".into()],
    );
    pass.model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    pass.safe_mode = safe_mode.unwrap_or(false);
    Ok(pass)
}

/// The model the last recorded exchange ran on, whatever superseded it since.
///
/// Read off the whole log rather than the live projection: a compaction or a
/// rewind changes what the next request carries and says nothing about which
/// snapshot the CLI resolves an alias to.
pub(crate) fn last_model(session: &Session) -> Option<String> {
    session.events().iter().rev().find_map(|e| match e {
        SessionEvent::AssistantMessage { model, .. } if !model.is_empty() => Some(model.clone()),
        _ => None,
    })
}

/// Ask the binary what it is, so a connect fails here rather than mid-turn.
///
/// Resolved through [`resolve_binary`] rather than spawned by name, and this
/// is the entry point where that matters most: a GUI process on macOS gets
/// launchd's minimal `PATH` and never reads a login shell, so the default
/// `claude` did not resolve for any macOS user who installed Claude Code the
/// documented way — the connect failed with "not found" while the identical
/// default worked from a terminal. The resolved path is returned so the rail
/// can show which binary actually answered rather than the name it was asked
/// for; the two differ exactly when this fallback did something.
pub(crate) async fn agent_version(binary: &str) -> Result<(String, Option<String>), String> {
    let resolved = resolve_binary(binary);
    let out = tokio::process::Command::new(&resolved)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!(
                "could not start {binary}: not found. Looked in {}. Install Claude Code, or give the rail an absolute path to it.",
                searched_locations().join(", ")
            ),
            _ => format!("could not start {binary}: {e}"),
        })?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((resolved, (!text.is_empty()).then_some(text)))
}
