//! The away server's reads (nightshift item 246, wave 4 4A, read half;
//! item 268): what `nightloom serve` answers for the phone's rail, Running
//! sheet, usage line, search, notes and project list — the routes of the
//! design note's §4 that the Mac's host answers from its window or straight
//! from disk.
//!
//! Free functions over a [`Places`] (the home, the unfiled chats, the
//! registry's projects and the phone's current project), so `serve.rs`'s
//! `Host` impl forwards each method in a line and the tests run each one
//! on a scratch home. The rail itself is [`crate::rail_store`].
//!
//! Each read does what the Mac does, read for read: notes follow the Mac's
//! scope rules (`main.rs` `scope_dir`, `check_fixed_name`); a note deleted
//! from the phone is copied to `<home>/trash/notes/<when>/<scope>/<name>`
//! first (blocker 685); search is the Mac's `search_everywhere` over the
//! service's own pieces; usage is `plan_usage::read` + `usage::summary`;
//! projects go through `project.rs`'s registry functions, and forgetting
//! one never deletes a file.

use std::path::{Path, PathBuf};

use nightloom_core::{Session, SessionEvent};

use crate::project::{self, NewProjectFolder, NewProjectPath, Note, Project, Registry};
use crate::remote::ProjectRow;
use crate::remote::api::{
    NOTE_SCOPES, NewProjectRequest, Running, RunningChat, SearchScope, UsageReply,
};
use crate::store;
use crate::store::search::{ChatSource, NoteSource, SearchResult};

/// The sentence the usage line carries when this machine has no plan file
/// (a Linux server has neither the Claude app's sample nor a CLI cache).
pub const PLAN_ON_THE_MAC: &str =
    "the plan window is read on the Mac; this server has no plan file";

/// The folder under the home a deleted note is copied to first (685).
pub const TRASH_DIR: &str = "trash";

/// The Nightloom home `serve` runs on (`NIGHTLOOM_HOME`, else
/// `~/.nightloom`): where the rail, the trash and the user-level notes live.
pub fn home() -> Result<PathBuf, String> {
    project::config_dir().ok_or_else(|| "no Nightloom home (no HOME or NIGHTLOOM_HOME)".into())
}

/// Where the reads look: what `serve`'s state says, copied out from under
/// its locks so no read holds one.
#[derive(Debug, Clone)]
pub struct Places {
    /// The Nightloom home (`<config>`).
    pub home: PathBuf,
    /// The unfiled chats (`<config>/unfiled/sessions`).
    pub unfiled: PathBuf,
    /// Every registered project.
    pub projects: Vec<Project>,
    /// The phone's current project (`None`: unfiled).
    pub active: Option<Project>,
}

impl Places {
    /// From `serve`'s state: its unfiled folder, its registry and the id of
    /// the phone's current project.
    pub fn of(home: PathBuf, unfiled: &Path, registry: &Registry, active: Option<&str>) -> Self {
        let projects = registry.projects();
        let active = active.and_then(|id| projects.iter().find(|p| p.id == id).cloned());
        Self {
            home,
            unfiled: unfiled.to_path_buf(),
            projects,
            active,
        }
    }

    /// These places with `project` as the current one (item 300 B1: the
    /// project on the phone's screen, not the host's open one): `None`
    /// keeps the current, `unfiled` is No project, and an id this host
    /// does not know is refused rather than read as the current one.
    pub fn for_project(mut self, project: Option<&str>) -> Result<Self, String> {
        match project {
            None => {}
            Some(crate::serve::NO_PROJECT_ID) => self.active = None,
            Some(id) => {
                let found = self.projects.iter().find(|p| p.id == id).cloned();
                self.active = Some(found.ok_or_else(|| format!("no project {id}"))?);
            }
        }
        Ok(self)
    }

    /// The chats folder of the current project, or the unfiled one.
    fn this_dir(&self) -> PathBuf {
        self.active
            .as_ref()
            .map(Project::session_dir)
            .unwrap_or_else(|| self.unfiled.clone())
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---- running ----

/// One chat whose turn runs now, as `serve` knows it.
#[derive(Debug, Clone)]
pub struct Busy {
    /// The chat's id, as the turn slot holds it.
    pub chat: String,
    /// Its unanswered approval prompts.
    pub waiting: usize,
}

/// `GET /api/running`: the chats running now (one at most on `serve`,
/// blocker 672), each with its project, title and the time its turn
/// started — the last message's time, as the Mac's `liveChats` reads it.
/// No subagents, budget, asides, dream or capture on this host.
pub async fn running(places: Places, busy: Vec<Busy>) -> Result<Running, String> {
    blocking(move || {
        let chats = busy.into_iter().map(|b| running_chat(&places, b)).collect();
        Ok(Running {
            chats,
            ..Running::default()
        })
    })
    .await
}

fn running_chat(places: &Places, busy: Busy) -> RunningChat {
    let found = find_chat(places, &busy.chat);
    let (project, log) = match found {
        Some((project, path)) => (project, Session::load(path).ok()),
        None => (None, None),
    };
    let title = log
        .as_ref()
        .and_then(chat_title)
        .unwrap_or_else(|| "the new chat".into());
    let since = log.as_ref().and_then(turn_started);
    RunningChat {
        chat: Some(log.as_ref().map(|s| s.id.clone()).unwrap_or(busy.chat)),
        project,
        title,
        since,
        on_screen: false,
        waiting: busy.waiting,
    }
}

/// The chat's log and the project it is in: the current project first,
/// then the unfiled chats, then every other project.
fn find_chat(places: &Places, chat: &str) -> Option<(Option<String>, PathBuf)> {
    let mut dirs: Vec<(Option<String>, PathBuf)> = Vec::new();
    if let Some(p) = &places.active {
        dirs.push((Some(p.id.clone()), p.session_dir()));
    }
    dirs.push((None, places.unfiled.clone()));
    for p in &places.projects {
        if places.active.as_ref().is_none_or(|a| a.id != p.id) {
            dirs.push((Some(p.id.clone()), p.session_dir()));
        }
    }
    dirs.into_iter().find_map(|(project, dir)| {
        store::find_by_prefix(&dir, chat)
            .ok()
            .map(|path| (project, path))
    })
}

/// The chat's name, or its opening message, on one line.
fn chat_title(session: &Session) -> Option<String> {
    let text = session.title().map(str::to_string).or_else(|| {
        session.events().iter().find_map(|e| match e {
            SessionEvent::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
    })?;
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        out.push('…');
    }
    Some(out)
}

/// When the running turn started: its message's time, unix ms.
fn turn_started(session: &Session) -> Option<i64> {
    session.events().iter().rev().find_map(|e| match e {
        SessionEvent::UserMessage { at, .. } => Some(at.timestamp_millis()),
        _ => None,
    })
}

// ---- usage ----

/// `GET /api/usage`: the plan's windows and the ledger's summary, read off
/// disk as the Mac's host reads them. On a machine with no plan file (the
/// away server) the plan part is empty (`source: "none"`) and the ledger
/// carries [`PLAN_ON_THE_MAC`] as `plan_note` — a sentence, not an error.
pub async fn usage() -> Result<UsageReply, String> {
    blocking(|| {
        let plan = crate::plan_usage::read();
        let mut ledger =
            serde_json::to_value(crate::usage::summary()).map_err(|e| e.to_string())?;
        if let Some(note) = plan_note(&plan)
            && let Some(map) = ledger.as_object_mut()
        {
            map.insert("plan_note".into(), note.into());
        }
        Ok(UsageReply { plan, ledger })
    })
    .await
}

/// [`PLAN_ON_THE_MAC`] when `plan` read nothing.
pub fn plan_note(plan: &crate::plan_usage::PlanUsage) -> Option<&'static str> {
    (plan.source == "none" || plan.source.is_empty()).then_some(PLAN_ON_THE_MAC)
}

// ---- search ----

/// The chat folders and note folders a search scope covers — the Mac's
/// `search_everywhere`: `this` the current project's chats (or the unfiled
/// ones), `all` every project's chats plus the unfiled ones, `notes` the
/// current project's docspace and the vault.
pub fn search_sources(places: &Places, scope: SearchScope) -> (Vec<ChatSource>, Vec<NoteSource>) {
    let chats = match scope {
        SearchScope::This => vec![ChatSource {
            project: None,
            dir: places.this_dir(),
        }],
        SearchScope::All => store::search::all_sources(&places.projects, &places.unfiled),
        SearchScope::Notes => Vec::new(),
    };
    let notes = match scope {
        SearchScope::Notes => {
            let mut sources = Vec::new();
            if let Some(p) = &places.active {
                sources.push(NoteSource {
                    scope: "project",
                    dir: p.notes_dir(),
                });
            }
            sources.push(NoteSource {
                scope: "knowledge",
                dir: crate::knowledge::vault_dir_in(&places.home),
            });
            sources
        }
        _ => Vec::new(),
    };
    (chats, notes)
}

/// `GET /api/search`: the Mac's search-everywhere result.
pub async fn search(places: Places, q: &str, scope: SearchScope) -> Result<SearchResult, String> {
    let q = q.to_string();
    blocking(move || {
        let (chats, notes) = search_sources(&places, scope);
        store::search::search(&chats, &notes, &q).map_err(|e| e.to_string())
    })
    .await
}

// ---- notes ----

/// The one file a fixed-file scope names (the Mac's `NoteScope::fixed_name`).
fn fixed_name(scope: &str) -> Option<&'static str> {
    match scope {
        "instructions" | "memory" => Some("AGENTS.md"),
        "chat" => Some("CHAT.md"),
        _ => None,
    }
}

/// The folder a scope names on this host, or why there is none — the
/// Mac's `scope_dir`, over `serve`'s home and current project.
pub fn note_dir(places: &Places, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "project" => places
            .active
            .as_ref()
            .map(Project::notes_dir)
            .ok_or_else(|| "no project is open, so there is no shared notes folder".into()),
        "knowledge" => Ok(crate::knowledge::vault_dir_in(&places.home)),
        "instructions" => places
            .active
            .as_ref()
            .map(Project::workspace_dir)
            .ok_or_else(|| "no project is open, so there are no project instructions".into()),
        "memory" | "chat" => Ok(places.home.clone()),
        // `prompt::model_instructions_dir`, for this home.
        "models" => Ok(places.home.join("models")),
        other => Err(format!(
            "`{other}` is not a notes scope ({})",
            NOTE_SCOPES.join(", ")
        )),
    }
}

fn check_fixed_name(scope: &str, name: &str) -> Result<(), String> {
    if let Some(fixed) = fixed_name(scope)
        && name.trim() != fixed
    {
        return Err(format!("{scope} names only {fixed}, not {name}"));
    }
    Ok(())
}

/// `GET /api/notes?scope=`: a folder scope's notes; a fixed-file scope is
/// one file, not a folder to list.
pub fn notes_list(places: &Places, scope: &str) -> Result<Vec<Note>, String> {
    if fixed_name(scope).is_some() {
        return Err(format!("{scope} is one file, not a folder to list"));
    }
    Ok(project::list_notes(&note_dir(places, scope)?))
}

/// `GET /api/notes/{scope}/{name}`. A fixed file or a model's file that
/// does not exist yet reads as empty, as on the Mac, so the editor opens
/// on it.
pub fn note_read(places: &Places, scope: &str, name: &str) -> Result<String, String> {
    check_fixed_name(scope, name)?;
    let dir = note_dir(places, scope)?;
    if let Some(fixed) = fixed_name(scope)
        && !dir.join(fixed).is_file()
    {
        return Ok(String::new());
    }
    if scope == "models" && !dir.join(name.trim()).is_file() {
        return Ok(String::new());
    }
    project::read_note(&dir, name)
}

/// `PUT /api/notes/{scope}/{name}`: write (a new note too).
pub fn note_write(places: &Places, scope: &str, name: &str, text: &str) -> Result<(), String> {
    check_fixed_name(scope, name)?;
    project::write_note(&note_dir(places, scope)?, name, text).map(|_| ())
}

/// Where a note deleted now is kept: `<home>/trash/notes/<when>/<scope>/
/// <name>`, `<when>` the local time to the second (the Mac host's
/// `note_trash`), with `-2`, `-3`, … when that copy already exists.
pub fn note_trash_path(home: &Path, scope: &str, name: &str) -> PathBuf {
    let when = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let base = home.join(TRASH_DIR).join("notes");
    let name = name.trim().trim_start_matches('/');
    let mut n = 1;
    loop {
        let stamp = if n == 1 {
            when.clone()
        } else {
            format!("{when}-{n}")
        };
        let path = base.join(stamp).join(scope).join(name);
        if !path.exists() {
            return path;
        }
        n += 1;
    }
}

/// `DELETE /api/notes/{scope}/{name}`: copied to the trash first (685) and
/// only then removed; if the copy cannot be made the note stays and the
/// phone is told why. A fixed file is emptied, never deleted.
pub fn note_delete(places: &Places, scope: &str, name: &str) -> Result<(), String> {
    if let Some(fixed) = fixed_name(scope) {
        return Err(format!(
            "{fixed} is not deleted from here — empty it instead"
        ));
    }
    let dir = note_dir(places, scope)?;
    let file = project::note_file(&dir, name)?;
    if !file.is_file() {
        return Err(format!("there is no note {name}"));
    }
    let trash = note_trash_path(&places.home, scope, name);
    let kept = trash
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::copy(&file, &trash).map(|_| ()));
    if let Err(e) = kept {
        return Err(format!(
            "could not keep a copy of the note in the trash, so it was not deleted: {e}"
        ));
    }
    project::delete_note(&dir, name)
}

// ---- projects ----

fn row(project: &Project, active: Option<&str>) -> ProjectRow {
    ProjectRow {
        id: project.id.clone(),
        name: project.name.clone(),
        active: active == Some(project.id.as_str()),
    }
}

/// `POST /api/projects`: a new project, its folder `<projects folder>/
/// <slug of the name>` (the Mac's form with no folder picked; the picker
/// is Mac-only, blocker 666), `AGENTS.md` written when instructions are
/// given. Not opened — as on the Mac, opening is its own step.
pub fn project_new(
    home: &Path,
    registry: &mut Registry,
    req: &NewProjectRequest,
    active: Option<&str>,
) -> Result<ProjectRow, String> {
    let folder = project::projects_folder_in(home, registry);
    let target = NewProjectPath::resolve(&req.name, &folder);
    let made = registry.new_project(
        &req.name,
        NewProjectFolder::Resolved(target.path),
        req.instructions.as_deref(),
    )?;
    Ok(row(&made, active))
}

/// `POST /api/projects/{id}/open`: make `id` the phone's current project
/// (and forget the current chat when the project changes, since a chat is
/// looked up in its project's folder).
pub fn project_open(
    registry: &mut Registry,
    active: &mut Option<String>,
    active_chat: &mut Option<String>,
    id: &str,
) -> Result<ProjectRow, String> {
    let project = registry
        .find(id)
        .cloned()
        .ok_or_else(|| format!("no project {id}"))?;
    registry.touch(id);
    if active.as_deref() != Some(id) {
        *active_chat = None;
    }
    *active = Some(project.id.clone());
    Ok(row(&project, Some(id)))
}

/// `POST /api/projects/{id}/rename`: the name in the list; the folder is
/// not renamed.
pub fn project_rename(
    registry: &mut Registry,
    active: Option<&str>,
    id: &str,
    name: &str,
) -> Result<ProjectRow, String> {
    let renamed = registry.rename(id, name)?;
    Ok(row(&renamed, active))
}

/// `POST /api/projects/{id}/forget`: off the list; its folder, notes and
/// chats stay on disk (`Registry::forget`). The phone's current project
/// is cleared when it was this one.
pub fn project_forget(
    registry: &mut Registry,
    active: &mut Option<String>,
    active_chat: &mut Option<String>,
    id: &str,
) -> Result<(), String> {
    registry.forget(id)?;
    if active.as_deref() == Some(id) {
        *active = None;
        *active_chat = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rail_store;
    use crate::remote::api::{RailCouncil, RailPatch};
    use nightloom_core::{ChatKind, ChatMode};

    /// A scratch home: `<tmp>/nightloom-reads-<uuid>`, with the process's
    /// test config dir set as the crate's other tests set it (a project's
    /// chats folder is derived from it).
    fn scratch() -> PathBuf {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let dir = std::env::temp_dir().join(format!("nightloom-reads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn places(home: &Path, registry: &Registry, active: Option<&str>) -> Places {
        let unfiled = home.join("unfiled").join("sessions");
        std::fs::create_dir_all(&unfiled).unwrap();
        Places::of(home.to_path_buf(), &unfiled, registry, active)
    }

    #[test]
    fn the_rail_round_trips_and_refuses_what_the_phone_may_not_change() {
        let home = scratch();
        // No file: the defaults, `--model` shown as the model.
        let first = rail_store::load(&home).unwrap();
        assert_eq!(first, rail_store::RailSettings::default());
        assert_eq!(first.to_rail(Some("opus"), false).model, "opus");

        let patch = RailPatch {
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            plan: Some(true),
            limits: Some(serde_json::json!({ "per_turn": 3, "off": { "depth": true } })),
            council: Some(RailCouncil {
                seats: vec![
                    crate::council::Seat::subscription("opus"),
                    crate::council::Seat::subscription("sonnet"),
                ],
                mode: Default::default(),
            }),
            ..RailPatch::default()
        };
        let saved = rail_store::apply(&home, &patch).unwrap();
        let read = rail_store::load(&home).unwrap();
        assert_eq!(saved, read);
        let rail = read.to_rail(Some("opus"), true);
        assert_eq!(rail.model, "sonnet");
        assert_eq!(rail.effort, "high");
        assert!(rail.plan && rail.ask && rail.deferred);
        assert_eq!(rail.limits["per_turn"], 3);
        assert_eq!(rail.limits["off"]["depth"], true);
        assert_eq!(rail.council.as_ref().unwrap().seats.len(), 2);

        // A second partial patch keeps the first one's limits.
        rail_store::apply(
            &home,
            &RailPatch {
                limits: Some(serde_json::json!({ "concurrent": 2 })),
                ..RailPatch::default()
            },
        )
        .unwrap();
        let read = rail_store::load(&home).unwrap();
        let limits = read.limits.clone().unwrap();
        assert_eq!(
            (limits["per_turn"].clone(), limits["concurrent"].clone()),
            (3.into(), 2.into())
        );

        // The turn takes the saved model and effort; Plan rides the hook.
        let mut spec = crate::agent::AgentSpec::new(home.clone());
        spec.ask = Some(crate::agent::AskSpec {
            hook: vec!["x".into()],
            dir: PathBuf::new(),
            mode: crate::agent::AskMode::Ask,
            subagents_auto: true,
        });
        read.apply_model(&mut spec, Some("opus"));
        read.apply_ask(&mut spec);
        assert_eq!(spec.model.as_deref(), Some("sonnet"));
        assert_eq!(spec.effort.as_deref(), Some("high"));
        assert_eq!(spec.subagent_limits.unwrap().per_turn, 3);
        assert!(matches!(
            spec.ask.as_ref().unwrap().mode,
            crate::agent::AskMode::Plan
        ));

        // Refusals: each leaves the file as it was.
        let before = std::fs::read_to_string(rail_store::path(&home)).unwrap();
        for bad in [
            RailPatch {
                engine: Some("provider".into()),
                ..RailPatch::default()
            },
            RailPatch {
                effort: Some("huge".into()),
                ..RailPatch::default()
            },
            RailPatch {
                fork_mode: Some(true),
                ..RailPatch::default()
            },
            RailPatch {
                limits: Some(serde_json::json!({ "per_turn": -1 })),
                ..RailPatch::default()
            },
            RailPatch {
                council: Some(RailCouncil {
                    seats: vec![crate::council::Seat::subscription("opus")],
                    mode: Default::default(),
                }),
                ..RailPatch::default()
            },
        ] {
            let e = rail_store::apply(&home, &bad).unwrap_err();
            assert!(!e.is_empty());
        }
        assert_eq!(
            std::fs::read_to_string(rail_store::path(&home)).unwrap(),
            before
        );
        // Keys, folders and the CLI update are refused in words.
        let e = rail_store::check_patch_json(&serde_json::json!({ "api_key": "x" })).unwrap_err();
        assert!(e.contains("Mac only"), "{e}");
        assert!(rail_store::check_patch_json(&serde_json::json!({ "model": "opus" })).is_ok());

        // A file that does not read is not written over.
        std::fs::write(rail_store::path(&home), "{ not json").unwrap();
        assert!(rail_store::load(&home).is_err());
        assert!(
            rail_store::apply(
                &home,
                &RailPatch {
                    model: Some("opus".into()),
                    ..RailPatch::default()
                }
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(rail_store::path(&home)).unwrap(),
            "{ not json"
        );
        assert_eq!(
            rail_store::load_or_default(&home),
            rail_store::RailSettings::default()
        );
    }

    #[test]
    fn ask_off_drops_the_hook_and_the_mcp_ask_flag() {
        let home = scratch();
        let settings = rail_store::apply(
            &home,
            &RailPatch {
                ask: Some(false),
                ..RailPatch::default()
            },
        )
        .unwrap();
        let mut spec = crate::agent::AgentSpec::new(home.clone());
        spec.ask = Some(crate::agent::AskSpec {
            hook: vec!["x".into()],
            dir: PathBuf::new(),
            mode: crate::agent::AskMode::Ask,
            subagents_auto: true,
        });
        spec.mcp_config = Some(
            serde_json::json!({ "mcpServers": { "nightloom": { "command": "x",
                "args": ["mcp-serve", "--ask"] } } })
            .to_string(),
        );
        settings.apply_ask(&mut spec);
        assert!(spec.ask.is_none());
        assert!(!spec.mcp_config.unwrap().contains("--ask"));
    }

    /// Ask off on `auto` — the spec `serve` builds — is the Auto position
    /// (nightshift backlog 294): the hook stays, on the question alone,
    /// and the MCP server keeps `--ask` so the prompt tool resolves.
    #[test]
    fn ask_off_on_auto_keeps_the_hook_for_the_models_question() {
        let home = scratch();
        let settings = rail_store::apply(
            &home,
            &RailPatch {
                ask: Some(false),
                ..RailPatch::default()
            },
        )
        .unwrap();
        let mut spec = crate::agent::AgentSpec::new(home.clone());
        spec.permission_mode = Some("auto".into());
        spec.ask = Some(crate::agent::AskSpec {
            hook: vec!["x".into()],
            dir: PathBuf::new(),
            mode: crate::agent::AskMode::Ask,
            subagents_auto: true,
        });
        spec.mcp_config = Some(
            serde_json::json!({ "mcpServers": { "nightloom": { "command": "x",
                "args": ["mcp-serve", "--ask"] } } })
            .to_string(),
        );
        settings.apply_ask(&mut spec);
        assert_eq!(spec.ask.as_ref().unwrap().mode, crate::agent::AskMode::Auto);
        assert!(spec.mcp_config.unwrap().contains("--ask"));
    }

    /// Item 300 B1: instructions saved for the project on the phone's
    /// screen land in that project's AGENTS.md even while the host's
    /// current project is another; an unknown id is refused; `unfiled`
    /// has no project instructions.
    #[test]
    fn a_named_project_gets_its_own_instructions_not_the_current_ones() {
        let home = scratch();
        let mut registry = Registry::load_from(home.join("projects.json"));
        let garden_ws = home.join("garden");
        let bird_ws = home.join("bird");
        std::fs::create_dir_all(&garden_ws).unwrap();
        std::fs::create_dir_all(&bird_ws).unwrap();
        let garden = registry
            .create("Garden", Some(garden_ws.clone()), None)
            .unwrap();
        let bird = registry
            .create("Bird log", Some(bird_ws.clone()), None)
            .unwrap();
        // The host is in Garden; the phone shows Bird log.
        let p = places(&home, &registry, Some(&garden.id))
            .for_project(Some(&bird.id))
            .unwrap();
        note_write(&p, "instructions", "AGENTS.md", "Use metric units.").unwrap();
        assert_eq!(
            std::fs::read_to_string(bird_ws.join("AGENTS.md")).unwrap(),
            "Use metric units."
        );
        assert!(!garden_ws.join("AGENTS.md").exists(), "Garden untouched");
        // No project named: the current one, as before.
        let cur = places(&home, &registry, Some(&garden.id))
            .for_project(None)
            .unwrap();
        assert_eq!(
            cur.active.as_ref().map(|p| p.id.clone()),
            Some(garden.id.clone())
        );
        // `unfiled`: no project, so no instructions to write.
        let none = places(&home, &registry, Some(&garden.id))
            .for_project(Some(crate::serve::NO_PROJECT_ID))
            .unwrap();
        assert!(note_write(&none, "instructions", "AGENTS.md", "x").is_err());
        // An id this host does not know is refused, never the current one.
        assert!(
            places(&home, &registry, Some(&garden.id))
                .for_project(Some("nope"))
                .is_err()
        );
    }

    #[test]
    fn a_note_written_reads_back_and_its_delete_leaves_a_trash_copy() {
        let home = scratch();
        let registry = Registry::load_from(home.join("projects.json"));
        let p = places(&home, &registry, None);

        note_write(&p, "knowledge", "people/ada.md", "# Ada\nwrote the notes").unwrap();
        assert_eq!(
            note_read(&p, "knowledge", "people/ada.md").unwrap(),
            "# Ada\nwrote the notes"
        );
        let listed = notes_list(&p, "knowledge").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "people/ada.md");

        note_delete(&p, "knowledge", "people/ada.md").unwrap();
        assert!(notes_list(&p, "knowledge").unwrap().is_empty());
        let trash = home.join(TRASH_DIR).join("notes");
        let kept: Vec<PathBuf> = walk(&trash);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].ends_with("knowledge/people/ada.md"));
        assert_eq!(
            std::fs::read_to_string(&kept[0]).unwrap(),
            "# Ada\nwrote the notes"
        );

        // The fixed files: empty before written, never deleted, one name.
        assert_eq!(note_read(&p, "memory", "AGENTS.md").unwrap(), "");
        note_write(&p, "memory", "AGENTS.md", "be brief").unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "be brief"
        );
        assert!(note_delete(&p, "memory", "AGENTS.md").is_err());
        assert!(note_write(&p, "memory", "OTHER.md", "x").is_err());
        assert!(notes_list(&p, "chat").is_err());
        // The project scopes need a current project; a bad scope says so.
        assert!(notes_list(&p, "project").is_err());
        assert!(note_dir(&p, "secrets").is_err());
        // A model's file not yet written reads empty.
        assert_eq!(note_read(&p, "models", "opus.md").unwrap(), "");
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return out;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[tokio::test]
    async fn search_finds_a_word_in_a_fixture_log_and_running_names_its_chat() {
        let home = scratch();
        let mut registry = Registry::load_from(home.join("projects.json"));
        let ws = home.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let project = registry.create("Fixture", Some(ws), None).unwrap();
        let mut session =
            Session::start(project.session_dir(), ChatMode::Normal, ChatKind::Build).unwrap();
        session.record_user("where did the marmalade go");
        session.record_title_by("breakfast", nightloom_core::TitleBy::User);
        let chat = session.id.clone();
        drop(session);

        // `all`: found from no current project.
        let p = places(&home, &registry, None);
        let found = search(p.clone(), "marmalade", SearchScope::All)
            .await
            .unwrap();
        assert!(found.matches >= 1, "{found:?}");
        assert_eq!(found.groups.len(), 1);
        // `this` with no current project looks at the unfiled chats only.
        let none = search(p.clone(), "marmalade", SearchScope::This)
            .await
            .unwrap();
        assert_eq!(none.matches, 0);
        // `this` in the project finds it.
        let inside = places(&home, &registry, Some(&project.id));
        let here = search(inside.clone(), "marmalade", SearchScope::This)
            .await
            .unwrap();
        assert!(here.matches >= 1);
        // `notes` reaches the vault.
        note_write(&inside, "knowledge", "jam.md", "marmalade is orange").unwrap();
        let notes = search(inside.clone(), "marmalade", SearchScope::Notes)
            .await
            .unwrap();
        assert!(!notes.notes.is_empty());

        // Running: the busy chat found in its project, named, timed.
        let r = running(
            p,
            vec![Busy {
                chat: chat.clone(),
                waiting: 1,
            }],
        )
        .await
        .unwrap();
        assert_eq!(r.chats.len(), 1);
        let c = &r.chats[0];
        assert_eq!(c.chat.as_deref(), Some(chat.as_str()));
        assert_eq!(c.project.as_deref(), Some(project.id.as_str()));
        assert_eq!(c.title, "breakfast");
        assert!(c.since.is_some());
        assert_eq!(c.waiting, 1);
        assert!(r.asides.is_empty() && r.dream.is_none());
        assert!(running(inside, Vec::new()).await.unwrap().chats.is_empty());
    }

    #[test]
    fn projects_new_open_rename_forget_keep_every_file() {
        let home = scratch();
        let mut registry = Registry::load_from(home.join("projects.json"));
        // The projects folder, recorded for this home.
        let folder = home.join("projects-folder");
        crate::project::set_projects_folder_in(&home, Some(&folder)).unwrap();

        let made = project_new(
            &home,
            &mut registry,
            &NewProjectRequest {
                name: "Tea Notes".into(),
                instructions: Some("Be kind.".into()),
            },
            None,
        )
        .unwrap();
        assert!(!made.active);
        let dir = crate::project::normalize(&folder.join("Tea-Notes"));
        assert!(dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(),
            "Be kind.\n"
        );
        std::fs::write(dir.join("keep.txt"), "mine").unwrap();
        // A second with the same name is refused (the folder has files).
        assert!(
            project_new(
                &home,
                &mut registry,
                &NewProjectRequest {
                    name: "Tea Notes".into(),
                    instructions: None
                },
                None
            )
            .is_err()
        );

        let mut active = None;
        let mut active_chat = Some("old-chat".to_string());
        let opened = project_open(&mut registry, &mut active, &mut active_chat, &made.id).unwrap();
        assert!(opened.active);
        assert_eq!(active.as_deref(), Some(made.id.as_str()));
        assert_eq!(active_chat, None);
        assert!(project_open(&mut registry, &mut active, &mut active_chat, "nope").is_err());

        let renamed =
            project_rename(&mut registry, active.as_deref(), &made.id, "Tea and Notes").unwrap();
        assert_eq!(renamed.name, "Tea and Notes");
        assert!(renamed.active);
        assert!(dir.join("keep.txt").is_file(), "rename moves no folder");
        // On disk: a fresh registry reads the new name.
        let reread = Registry::load_from(home.join("projects.json"));
        assert_eq!(reread.find(&made.id).unwrap().name, "Tea and Notes");

        project_forget(&mut registry, &mut active, &mut active_chat, &made.id).unwrap();
        assert!(registry.find(&made.id).is_none());
        assert_eq!(active, None);
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "mine"
        );
        assert!(dir.join("AGENTS.md").is_file());
        assert!(project_forget(&mut registry, &mut active, &mut active_chat, &made.id).is_err());
    }

    #[test]
    fn usage_without_a_plan_file_says_so_instead_of_failing() {
        let empty = crate::plan_usage::PlanUsage {
            source: "none".into(),
            ..Default::default()
        };
        assert_eq!(plan_note(&empty), Some(PLAN_ON_THE_MAC));
        let read = crate::plan_usage::PlanUsage {
            source: "cli-cache".into(),
            five_hour: Some(12),
            ..Default::default()
        };
        assert_eq!(plan_note(&read), None);
    }
}
