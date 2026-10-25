//! Incognito is the chat that knows nothing about him (nightshift backlog
//! 405, blocker 1513, 2026-10-24).
//!
//! Item 059 made an incognito chat one that *writes* nothing: no file
//! edits, no `remember`, no dream intake, invisible to the other chats.
//! It still *read* everything — the project's name and notes index, the
//! vault, the project's `AGENTS.md`, and on the Claude Code engine his
//! `~/.claude/CLAUDE.md` and the CLI's auto memory — and his screenshot of
//! 2026-10-20 shows one reading `~/.nightloom/knowledge/profile.md` when
//! asked what it knew about him. Since this item the same mode also knows
//! nothing about him:
//!
//! | kept | dropped |
//! |---|---|
//! | identity, environment (of the chat's own empty folder) | the project: its name and notes index ([`SegmentKind::ProjectNotes`]) |
//! | `~/.nightloom/AGENTS.md`, his general rules (blocker 1514) | the project's `AGENTS.md` walk ([`SegmentKind::ProjectInstructions`]) |
//! | the model's own file, `CHAT.md` | the vault index ([`SegmentKind::Knowledge`]), the research thread |
//! | the web | Claude Code's user `CLAUDE.md`, auto memory, skills, other MCP servers |
//!
//! and three things beyond the prompt: the engine runs in an empty folder
//! of the chat's own under the system's temporary folder
//! ([`workspace`]), so no project name is in its cwd, its environment
//! segment or an `--add-dir`; reads of [`denied_roots`] are refused on
//! both engines (the CLI by `permissions.deny` rules, measured in the
//! 405 report's M0; the API engine by `Root::with_denied`); and
//! Nightloom's MCP server is started `--incognito`, without the chat
//! search, memory and Notion tools ([`SERVER_DROPS`]).
//!
//! `~/.nightloom/AGENTS.md` stays by a stated rule rather than by reading
//! it: it is the file he called "model instructions or general rules", the
//! one layer of his own he asked to keep; whether it states facts about
//! him is his call (blocker 1514, default kept).

use std::path::{Path, PathBuf};

use nightloom_core::SegmentKind;

use crate::project::Project;

/// The prompt layers an incognito chat never assembles. Laid over the
/// chat's own exclusions with [`crate::PromptConfig::without`], so each is
/// "never read from disk", not "hidden from the view".
pub const LAYERS_OFF: [SegmentKind; 4] = [
    SegmentKind::ProjectInstructions,
    SegmentKind::ProjectNotes,
    SegmentKind::Knowledge,
    SegmentKind::Thread,
];

/// The tools of Nightloom's own MCP server an incognito chat's server does
/// not serve (`--incognito`): the other chats, where in memory a belief
/// lives, and his Notion — each of them his data.
pub const SERVER_DROPS: [&str; 6] = [
    "search_chats",
    "read_chat",
    "memory_where",
    "notion_search",
    "notion_read_page",
    "notion_list_children",
];

/// The folder under the system's temporary folder every incognito chat's
/// own folder sits in.
pub const DIR: &str = "nightloom-incognito";

/// The chat's own empty folder: `<tmp>/nightloom-incognito/<chat>`, or
/// `…/new` for a chat whose first message has not created it yet. Created
/// if missing; never inside the project or `~/.nightloom`. Claude Code
/// resumes a session from any folder (measured for backlog 144), so the
/// move from `new` to the chat's id on the next connect costs nothing.
pub fn workspace(chat: Option<&str>) -> PathBuf {
    workspace_in(&std::env::temp_dir(), chat)
}

/// [`workspace`] under `base`, for tests.
pub fn workspace_in(base: &Path, chat: Option<&str>) -> PathBuf {
    let leaf: String = chat
        .unwrap_or("new")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let leaf = if leaf.is_empty() || leaf.chars().all(|c| c == '_') {
        "new".to_string()
    } else {
        leaf
    };
    let dir = base.join(DIR).join(leaf);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Every folder an incognito chat may not read: Nightloom's config dir
/// (`config`, and `~/.nightloom` whatever `NIGHTLOOM_HOME` says), the
/// vault wherever it was pointed, Claude Code's `~/.claude`, and every
/// project Nightloom knows — its folder, its store and its extra folders.
/// Deduplicated, in a stable order.
pub fn denied_roots(config: Option<&Path>, projects: &[Project]) -> Vec<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .map(PathBuf::from);
    denied_roots_in(home.as_deref(), config, projects)
}

/// [`denied_roots`] with the home given, for tests.
pub fn denied_roots_in(
    home: Option<&Path>,
    config: Option<&Path>,
    projects: &[Project],
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(config) = config {
        out.push(config.to_path_buf());
        out.push(crate::knowledge::vault_dir_in(config));
    }
    if let Some(home) = home {
        out.push(home.join(crate::project::DOT_DIR));
        out.push(home.join(".claude"));
    }
    for p in projects {
        out.push(p.workspace_dir());
        out.push(p.store_dir());
        out.extend(p.extra_folders.iter().cloned());
    }
    // `..` folded away lexically: a rule is matched against the path the
    // CLI opens, which has none.
    let mut out: Vec<PathBuf> = out.iter().map(|p| lexical(p)).collect();
    // Each also by its resolved spelling, where it differs (a symlinked
    // home, `/tmp` → `/private/tmp`): the CLI matches the path it opens.
    let resolved: Vec<PathBuf> = out.iter().filter_map(|p| p.canonicalize().ok()).collect();
    out.extend(resolved);
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()));
    out
}

/// `path` with `.` and `..` resolved by walking its components, without
/// touching the filesystem.
fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The Claude Code permission rules that refuse reads of `roots`: one
/// `Read(//abs/**)` for the tree and one for the folder itself. A `Read`
/// rule covers Read, Grep and Glob, holds under `bypassPermissions` and
/// under an empty `--setting-sources`, and a search from a parent folder
/// lists nothing inside it (all four measured, 405 report M0, CLI 2.1.310).
pub fn deny_rules(roots: &[PathBuf]) -> Vec<String> {
    let mut rules = Vec::new();
    for root in roots {
        let s = root.to_string_lossy();
        let s = s.trim_end_matches('/');
        if s.is_empty() {
            continue;
        }
        // An absolute path is `//path` in a permission rule; a single
        // slash would be read relative to the settings file.
        let abs = if s.starts_with('/') {
            format!("/{s}")
        } else {
            // A Windows path: the CLI's own spelling is `//c/Users/…`.
            format!("//{}", s.replace('\\', "/").replace(':', ""))
        };
        rules.push(format!("Read({abs}/**)"));
        rules.push(format!("Read({abs})"));
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KnowledgeContext, ProjectContext, PromptConfig};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nl-405-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project(id: &str, workspace: &Path) -> Project {
        let now = chrono::Utc::now();
        Project {
            id: id.into(),
            name: "Secret Project Name".into(),
            workspace: Some(workspace.to_path_buf()),
            source: None,
            extra_folders: vec![workspace.join("../elsewhere")],
            available_away: false,
            created: now,
            last_opened: now,
        }
    }

    /// The chat's folder is its own, empty, under the base, and a strange
    /// id cannot climb out of it.
    #[test]
    fn the_folder_is_the_chats_own_and_empty() {
        let base = temp("ws");
        let a = workspace_in(&base, Some("abc-123"));
        assert_eq!(a, base.join(DIR).join("abc-123"));
        assert!(a.is_dir());
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0);
        assert_eq!(workspace_in(&base, None), base.join(DIR).join("new"));
        let climb = workspace_in(&base, Some("../../etc"));
        assert!(climb.starts_with(base.join(DIR)), "{climb:?}");
        assert_eq!(workspace_in(&base, Some("..")), base.join(DIR).join("new"));
    }

    /// The config dir, the vault, `~/.nightloom`, `~/.claude`, and every
    /// project's folder, store and extra folders.
    #[test]
    fn every_place_of_his_is_denied() {
        let home = temp("home");
        let config = home.join(".nightloom-fixture");
        let ws = home.join("work/thing");
        let roots = denied_roots_in(Some(&home), Some(&config), &[project("p1", &ws)]);
        for want in [
            config.clone(),
            config.join("knowledge"),
            home.join(".nightloom"),
            home.join(".claude"),
            ws.clone(),
            home.join("work/elsewhere"),
        ] {
            assert!(roots.contains(&want), "{want:?} not in {roots:?}");
        }
        assert!(
            roots.iter().any(|r| r.ends_with("projects/p1")),
            "{roots:?}"
        );
    }

    #[test]
    fn deny_rules_are_absolute_and_cover_the_tree() {
        let rules = deny_rules(&[PathBuf::from("/Users/x/.nightloom/")]);
        assert_eq!(
            rules,
            vec![
                "Read(//Users/x/.nightloom/**)".to_string(),
                "Read(//Users/x/.nightloom)".to_string()
            ]
        );
    }

    /// The assembled prompt: a planted fact in the project's `AGENTS.md`,
    /// its notes, the vault and the project's name never reaches it; the
    /// user's general rules and the identity do.
    #[test]
    fn the_prompt_drops_the_project_the_vault_and_the_walk() {
        let root = temp("prompt");
        let ws = root.join("Secret Project Name");
        let notes = ws.join(".agents");
        let vault = root.join("knowledge");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&vault).unwrap();
        let fact = "Name: Testy McTestface, major: Basket Weaving";
        std::fs::write(ws.join("AGENTS.md"), fact).unwrap();
        std::fs::write(notes.join("profile.md"), fact).unwrap();
        std::fs::write(vault.join("profile.md"), fact).unwrap();
        let chat_dir = workspace_in(&root, Some("c1"));
        let full = PromptConfig {
            identity: true,
            environment: true,
            project_instructions: true,
            user_memory: false,
            model: None,
            chat_instructions: false,
            project: Some(ProjectContext {
                name: "Secret Project Name".into(),
                notes_dir: notes.clone(),
            }),
            knowledge: Some(KnowledgeContext { dir: vault.clone() }),
            thread: None,
            cwd: ws.clone(),
            custom: None,
            edits: Default::default(),
        };
        // Before: the leak this item closes.
        let before = crate::prompt::assemble(&full).render_flat().unwrap();
        assert!(before.contains("Testy"), "fixture must leak without 405");
        let after = crate::prompt::assemble(
            &PromptConfig {
                cwd: chat_dir.clone(),
                ..full
            }
            .without(&LAYERS_OFF),
        )
        .render_flat()
        .unwrap();
        for leak in ["Testy", "Basket", "Secret Project Name", "knowledge"] {
            assert!(!after.contains(leak), "{leak:?} in {after}");
        }
        assert!(after.contains("Nightloom"), "identity kept: {after}");
        assert!(after.contains(DIR), "environment names the chat's folder");
    }

    /// The Claude Code engine's note names only what an incognito chat's
    /// server serves: no other chats, no memory, no vault, no `~/.claude`.
    #[test]
    fn the_engine_note_names_nothing_the_server_withholds() {
        let cfg = PromptConfig {
            identity: false,
            environment: false,
            // A preamble for the note to follow: the chat's own rules text,
            // so nothing is read from disk.
            project_instructions: true,
            user_memory: false,
            model: None,
            chat_instructions: false,
            project: None,
            knowledge: None,
            thread: None,
            cwd: workspace_in(&temp("note"), None),
            custom: None,
            edits: [(SegmentKind::ProjectInstructions, "rules".to_string())]
                .into_iter()
                .collect(),
        };
        let layers = |incognito| crate::EngineLayers {
            engine_note: true,
            incognito,
            ..crate::EngineLayers::NONE
        };
        let render = |incognito| {
            crate::agent_prompt_with(&cfg, Some("library"), layers(incognito))
                .render_flat()
                .unwrap()
        };
        let normal = render(false);
        assert!(normal.contains("search_chats"), "{normal}");
        let inc = render(true);
        for gone in [
            "search_chats",
            "read_chat",
            "remember",
            "vault",
            ".claude",
            "memory",
        ] {
            assert!(!inc.contains(gone), "{gone} in {inc}");
        }
        assert!(inc.contains("mcp__nightloom__fetch_page"), "{inc}");
        assert!(inc.contains("Citing web sources"), "{inc}");
    }

    /// The Definition of done, live (not run by the suite: one real Haiku
    /// turn on the subscription). Run by hand with
    /// `NIGHTLOOM_LIVE_405_OUT=<dir> cargo test -p nightloom-service
    /// incognito::tests::live -- --ignored --nocapture`.
    ///
    /// A fixture home — `<out>/home/.nightloom` with a general rule in its
    /// `AGENTS.md`, a planted fact in `knowledge/profile.md`, and a project
    /// "Basket Weaving Lab" whose folder holds the same fact in `AGENTS.md`
    /// and its notes — and a spec built the way the desktop's
    /// `connect_agent_body` builds an incognito chat's (the prompt without
    /// [`LAYERS_OFF`], `apply_mode`, `apply_incognito`, Nightloom's server
    /// `--incognito` with the fixture as its home). His real `~/.nightloom`
    /// and `~/.claude` are in the denied list too, by the real `HOME`. The
    /// prompt, the CLI's arguments and the reply are written to `<out>`;
    /// the reply must name none of the planted facts or the project.
    #[tokio::test]
    #[ignore]
    async fn live_an_incognito_claude_code_chat_knows_nothing_about_him() {
        use crate::agent::{AgentSpec, ClaudeCodeAgent};
        use crate::turn::TurnEvent;
        use nightloom_core::ChatMode;
        use tokio_util::sync::CancellationToken;

        let out = PathBuf::from(std::env::var("NIGHTLOOM_LIVE_405_OUT").expect("an output dir"));
        let home = out.join("home");
        let config = home.join(".nightloom");
        let ws = home.join("work").join("Basket Weaving Lab");
        let fact =
            "Name: Testy McTestface. Major: Basket Weaving. Classes: BW 101, Advanced Knots.";
        std::fs::create_dir_all(config.join("knowledge")).unwrap();
        std::fs::create_dir_all(ws.join(".agents")).unwrap();
        std::fs::write(
            config.join("AGENTS.md"),
            "General rule: answer plainly and briefly.\n",
        )
        .unwrap();
        std::fs::write(config.join("knowledge").join("profile.md"), fact).unwrap();
        std::fs::write(ws.join("AGENTS.md"), fact).unwrap();
        std::fs::write(ws.join(".agents").join("about-me.md"), fact).unwrap();
        crate::project::set_config_dir(&config);
        let p = project("basket-weaving-lab", &ws);

        let chat_dir = workspace(Some("live-405"));
        let mut spec = AgentSpec::new(chat_dir.clone());
        spec.model = Some("haiku".into());
        spec.auto_compact = false;
        spec.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
        let prompt = crate::agent_prompt_with(
            &PromptConfig {
                identity: false,
                environment: false,
                project_instructions: true,
                user_memory: true,
                model: Some("haiku".into()),
                chat_instructions: false,
                project: Some(ProjectContext {
                    name: p.name.clone(),
                    notes_dir: p.notes_dir(),
                }),
                knowledge: Some(KnowledgeContext {
                    dir: config.join("knowledge"),
                }),
                thread: None,
                cwd: chat_dir.clone(),
                custom: None,
                edits: Default::default(),
            }
            .without(&LAYERS_OFF),
            None,
            crate::EngineLayers {
                engine_note: true,
                pacing: true,
                subagents: true,
                incognito: true,
                ..crate::EngineLayers::NONE
            },
        );
        spec.append_system_prompt = prompt.render_flat();
        let exe = std::env::current_dir()
            .unwrap()
            .join("../../target/debug/nightloom");
        if exe.exists() {
            spec.mcp_config = Some(
                serde_json::json!({ "mcpServers": { crate::mcp_server::SERVER_NAME: {
                    "command": exe.canonicalize().unwrap(),
                    "args": ["mcp-serve", "--incognito"],
                    "env": { "NIGHTLOOM_HOME": config },
                }}})
                .to_string(),
            );
        }
        spec.apply_mode(ChatMode::Incognito);
        spec.apply_incognito(denied_roots(Some(&config), std::slice::from_ref(&p)));

        // The exact question of the Definition of done; another by
        // `NIGHTLOOM_LIVE_405_Q` for a probe (asking it to read his files).
        let question = std::env::var("NIGHTLOOM_LIVE_405_Q")
            .unwrap_or_else(|_| "what do you know about me?".to_string());
        let question = question.as_str();
        let args = spec.args(question);
        std::fs::write(
            out.join("prompt.txt"),
            spec.append_system_prompt.clone().unwrap_or_default(),
        )
        .unwrap();
        std::fs::write(
            out.join("args.json"),
            serde_json::to_string_pretty(&args).unwrap(),
        )
        .unwrap();
        let mut calls: Vec<String> = Vec::new();
        let reply = ClaudeCodeAgent::new(spec)
            .run_turn(question, &CancellationToken::new(), &mut |e| match &e {
                TurnEvent::ToolCall { name, input, .. } => {
                    calls.push(format!("call {name} {input}"))
                }
                TurnEvent::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } => calls.push(format!(
                    "result {name} error={is_error}: {}",
                    content.chars().take(200).collect::<String>()
                )),
                TurnEvent::ToolDenied { name, reason, .. } => {
                    calls.push(format!("denied {name}: {reason}"))
                }
                _ => {}
            })
            .await
            .expect("the CLI ran");
        std::fs::write(out.join("reply.txt"), &reply.text).unwrap();
        std::fs::write(out.join("calls.txt"), calls.join("\n")).unwrap();
        println!("--- is_error {}\n--- said:\n{}", reply.is_error, reply.text);
        for c in &calls {
            println!("{c}");
        }
        for leak in [
            "Testy",
            "McTestface",
            "Basket",
            "Weaving",
            "Knots",
            "BW 101",
        ] {
            assert!(!reply.text.contains(leak), "{leak} in the reply");
        }
        // The account email Claude Code attaches (blocker 1515): no address.
        assert!(!reply.text.contains('@'), "an address in the reply");
        assert!(!reply.is_error, "the turn failed: {}", reply.text);
    }
}
