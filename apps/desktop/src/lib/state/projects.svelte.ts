// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { projectSwitch } from "../projectSwitch.svelte";
import * as api from "../api";
import { refreshWithin } from "../afterWrite";
import { withProject, withoutProject } from "../projectRows";
import { canDetach } from "../browse";
import * as tabs from "../tabs";
import { loadSavedWorkspaces, rebuild } from "../tabsStore";
import type { ProjectInfo, NewProjectPath } from "../types";
import { switchAside } from "./asides.svelte";
import { syncNightshiftProject } from "./nightshift.svelte";
import { leaveNote } from "./notes.svelte";
import { reflectTabs, closeTab, dropNoteTabs, dropProjectTabs, tabsKeyNow, terminalHooks, flushTabs, resolveTabContent } from "./tabs.svelte";
import { saveLastProject, app, applyDraft, activateTab, refreshSessions, clearPendingThread, defaultKind, fg, detach, promoteParked, addToast } from "../state.svelte";

// ---- projects ----

export async function refreshProjects(): Promise<void> {
  try {
    app.projects = await api.listProjects();
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Keep the open project in step with the list it is a row of. `app.project`
  // is otherwise a snapshot taken at open/connect/rename, and `exists` is a
  // fact about the disk that changes underneath it — so the Welcome pane went
  // on saying the folder was gone after it came back, while the project menu,
  // reading this same list, said it was fine. Two answers to one question,
  // and the warning's own "until it comes back" was the one that was wrong.
  //
  // Only a matching row updates it. A project missing from the list has been
  // forgotten, and closing it is `forgetProject`'s job — doing it here would
  // put a second, silent close in the one function everything else calls to
  // refresh.
  const open = app.project;
  if (open) {
    const fresh = app.projects.find((p) => p.id === open.id);
    if (fresh) app.project = fresh;
  }
  // The Nightshift page follows the open project (round 2, point 12).
  void syncNightshiftProject();
}

/**
 * Re-read both note stores.
 *
 * Called after every turn, which is the visible half of shared knowledge: a
 * note the model just left appears in the sidebar without a reload. Both are
 * refreshed together because the model can write to either.
 */
export async function refreshNotes(): Promise<void> {
  // As a tree since item 457: the same notes, plus the folders (an empty
  // one is still a place to drop a note) and whether the list is whole.
  if (app.project) {
    try {
      const t = await api.listNoteTree("project");
      app.notes = t.notes;
      app.noteFolders.project = t.folders;
      app.notesComplete.project = t.complete;
    } catch {
      // A store that cannot be listed shows as empty; the failure surfaces
      // when something is actually read or written.
      app.notes = [];
      app.noteFolders.project = [];
      app.notesComplete.project = true;
    }
  } else {
    app.notes = [];
    app.noteFolders.project = [];
    app.notesComplete.project = true;
  }
  try {
    const t = await api.listNoteTree("knowledge");
    app.vault = t.notes;
    app.noteFolders.knowledge = t.folders;
    app.notesComplete.knowledge = t.complete;
  } catch {
    app.vault = [];
    app.noteFolders.knowledge = [];
    app.notesComplete.knowledge = true;
  }
  await refreshProposals();
}

/**
 * Re-list the dream's pending proposals for both fixed files. With the
 * notes rather than on its own timer: a dream that proposed has just
 * refreshed the notes, and the badge should appear on the same tick as the
 * memory notes it filed.
 */
export async function refreshProposals(): Promise<void> {
  app.proposals.instructions = app.project
    ? await api.listProposals("instructions").catch(() => [])
    : [];
  app.proposals.memory = app.knowledge ? await api.listProposals("memory").catch(() => []) : [];
}

/** Where the vault is. Read on launch and after Settings repoints it. */
export async function refreshKnowledge(): Promise<void> {
  try {
    app.knowledge = await api.knowledgeInfo();
  } catch {
    app.knowledge = null;
  }
}

/** Where new projects go. Read on launch and after Settings repoints it. */
export async function refreshProjectsFolder(): Promise<void> {
  try {
    app.projectsFolder = await api.projectsFolderInfo();
  } catch {
    app.projectsFolder = null;
  }
}

/**
 * Point new projects at a folder, or back at the default with null. Moves
 * nothing; the projects already made are registered by their own paths.
 */
export async function useProjectsFolder(dir: string | null): Promise<void> {
  try {
    app.projectsFolder = await api.setProjectsFolder(dir);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Point the knowledge base at a folder, or back at the default with null.
 *
 * Re-connects afterwards, because the vault is part of what `connect` roots
 * the file tools at and indexes into the preamble — leaving it would have the
 * sidebar showing one folder and the model reading another.
 */
export async function useKnowledgeDir(dir: string | null): Promise<void> {
  try {
    app.knowledge = await api.setKnowledgeDir(dir);
  } catch (e) {
    addToast(String(e));
    return;
  }
  // The open note may not exist in the new vault.
  if (app.openNote?.scope === "knowledge") leaveNote();
  dropNoteTabs("knowledge");
  // ~~await refreshNotes()~~ first (backlog 211's leftovers, 2026-09-26):
  // the vault's notes are re-read in the background under the limit; the
  // reconnect, which is what points the model at the new vault, goes now.
  void refreshWithin("pointing the vault elsewhere", [refreshNotes]);
  await applyDraft();
}

/**
 * Open a project (or, with null, leave the one that is open) and re-point
 * everything at it.
 *
 * One function rather than a handful the callers compose, because the order
 * matters and getting it wrong is silent: the backend has to know the project
 * before `connect` reads it — the project decides the workspace — and the
 * chat list has to be re-read after, since it comes from the project folder.
 */
export async function useProject(id: string | null): Promise<void> {
  // ~~`if (app.busy) return;`~~, ~~`if (turnsRunning()) return;`~~ (A4's
  // first gates audit) — blocker 630, "allow": the chat on screen that is
  // running goes off screen and keeps its turn, its record naming this
  // project; only a New chat's first turn, not yet named, waits.
  if (app.busy || app.parked) {
    if (app.parked && fg && canDetach(app.connection?.engine, fg.chat)) promoteParked();
    else if (app.busy) detach();
    if (app.busy || app.parked) {
      addToast("This chat's first turn is just starting — switch projects in a moment");
      return;
    }
  }
  try {
    if (id) {
      app.project = await api.openProject(id);
    } else {
      await api.closeProject();
      app.project = null;
    }
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Item 598: the open chat is cleared now and the project's own re-opened
  // only once its lists are read; the new-chat page that showed in the gap
  // is covered meanwhile (`projectSwitch.svelte.ts`, `Welcome.svelte`).
  projectSwitch.on = true;
  try {
    saveLastProject(app.project?.id ?? null);
    // ~~The workspace just left is dropped~~ — since backlog 201 it is
    // written under its project first (while its chat is still the open
    // one, so an aside tab of it finds its threads), and the new project's
    // comes back at the end (`restoreTabs`), once its lists are read.
    flushTabs();
    tabsOwner = null;
    // The chat left keeps its asides (backlog 203): without this its cards
    // stayed on the pending chat and went with the first send into the new
    // chat, saved under that chat's id too.
    switchAside(null);
    app.activeSessionId = null;
    clearPendingThread();
    app.events = [];
    // The tabs were the list just left too (backlog 099): a workspace is a
    // project's, as an editor's is a folder's. The view that stays (the
    // Nightshift page, below) lands in the fresh workspace at the end.
    app.tabs = tabs.emptyWorkspace();
    // The pending kind was chosen for the list just left; the backend reset
    // its copy in `open_project` / `close_project` (nightshift backlog 061).
    app.pendingMode = "normal";
    // The kind follows the list too (nightshift backlog 102): Claude Code in
    // a project with a folder, Chat unfiled or in a folderless project. The
    // backend reset its copy to build, so it is told — the same call the
    // button makes, on a chat that is already closed.
    app.pendingKind = defaultKind();
    try {
      await api.newSession(undefined, app.pendingKind);
    } catch {
      // The first New chat click sends it again.
    }
    app.error = null;
    // Switching projects from the Nightshift page stays on it — the page
    // follows the open project (round 2, point 12); everywhere else it is a
    // navigation to the new project's chat. The New project form in front
    // stays in front too (backlog 394): it is the workspace's, not the
    // project's, and he is still filling it in.
    const formFront = app.view === "new-project" && app.newProjectOpen;
    if (app.view !== "nightshift" && !formFront) app.view = "chat";
    app.openNote = null;
    reflectTabs();
    // ~~The connect, then the list, the chats and the notes, each awaited~~
    // (backlog 211's leftovers, 2026-09-26): the three re-reads run together,
    // beside the connect, and settle within `REFRESH_LIMIT_MS` whatever the
    // disk does — a late answer still lands. The tabs wait for them, since
    // the lists decide which tabs survive.
    await Promise.all([
      applyDraft(),
      refreshWithin("opening " + (app.project?.name ?? "unfiled chats"), [
        refreshProjects,
        refreshSessions,
        refreshNotes,
      ]),
    ]);
    // The project's own tabs (backlog 201). On the Nightshift page the page
    // stays in front and lands in the restored workspace.
    const stay = app.view === "nightshift" || formFront;
    await restoreTabs({ show: !stay, newProjectFront: formFront });
    if (stay) reflectTabs();
  } finally {
    projectSwitch.on = false;
  }
}

/**
 * Open project…: pick a folder and open it as a project.
 *
 * `createProject` is idempotent on the path, so choosing a folder that is
 * already a project opens it rather than erroring — which is what someone who
 * navigated back to it meant. This was *New project…* until 2026-09-14
 * (backlog 047): making a project is now a form (`showNewProject`), and
 * this is the flow for work that already has a folder — imported, cloned,
 * or simply not on the list.
 */
export async function openProjectFolder(): Promise<void> {
  let path: string | null = null;
  try {
    path = await api.pickFolder();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!path) return; // cancelled
  try {
    const project = await api.createProject(path);
    // Its row from the answer; the list is re-read behind (backlog 211).
    app.projects = withProject(app.projects, project);
    void refreshWithin("opening " + project.name, [refreshProjects]);
    await useProject(project.id);
    void offerPracticesClaudeMd(project, path);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Backlog 432: a folder opened by Open project… with no `CLAUDE.md` gets an
 * offer, never a write — a toast whose button adds the practices
 * `CLAUDE.md`. Nothing when it has one, or when there is no
 * `~/.claude/practices/practices.md` for the line to import.
 */
export async function offerPracticesClaudeMd(project: ProjectInfo, path: string): Promise<void> {
  const offer = await api.claudeMdOffer(path).catch(() => null);
  if (!offer || offer.exists || !offer.practices) return;
  addToast(`${project.name} has no CLAUDE.md, so your practices file does not load in its chats.`, {
    label: "Add CLAUDE.md",
    run: () => {
      void api.addPracticesClaudeMd(project.id).then(
        (written) =>
          addToast(written ? `Added CLAUDE.md to ${project.name} with your practices line.` : `${project.name} already has a CLAUDE.md — left as it is.`),
        (e) => addToast(String(e)),
      );
    },
  });
}

// ---- the New project form ----

/**
 * New project…: the form in the centre pane (backlog 047, 2026-09-14). A
 * screen rather than a modal because it replaces Welcome, the page it is
 * reached from; the draft lives in `app.newProjectDraft` and survives every
 * way out of the screen except Create and Discard.
 */
export function showNewProject(): void {
  app.newProjectOpen = true;
  app.overlay = null;
  app.view = "new-project";
  app.openNote = null;
  app.proposalReview = null;
  // The form is a tab (backlog 140); landed here as well as by the
  // effect, so a click with the form already the view still finds it.
  reflectTabs();
}

/** Leave the form. The draft stays — Escape and Cancel both come here.
 *  The form is a tab (backlog 140): leaving closes its tab and lands the
 *  neighbour, as the note view's ← Chat does. */
export function closeNewProject(): void {
  // ~~Only from the form in front, closing the front tab~~ — since backlog
  // 394 the tab is open until this (or Create, Discard, its ×), wherever
  // it sits, so it is found anywhere and the flag goes down with it.
  app.newProjectOpen = false;
  const tab = tabs.findAnywhere(app.tabs, { kind: "new-project" });
  if (tab) {
    void closeTab(tab.id);
    return;
  }
  if (app.view === "new-project") app.view = "chat";
}

/** Drop the draft and leave. Behind a confirmation in the form. */
export function discardNewProject(): void {
  app.newProjectDraft = { name: "", instructions: "", pickedPath: null };
  closeNewProject();
}

/**
 * The folder row's Change…: the native picker, for "I already have work
 * somewhere". Picking replaces the resolved path with the picked one; a
 * cancel leaves whatever was there.
 */
export async function pickNewProjectFolder(): Promise<void> {
  try {
    const picked = await api.pickFolder(
      "Choose the project's folder",
      app.newProjectDraft.pickedPath ?? app.projectsFolder?.dir,
    );
    if (picked) app.newProjectDraft.pickedPath = picked;
  } catch (e) {
    addToast(String(e));
  }
}

/** The form's live folder row: what the backend would make for this name. */
export function resolveNewProjectPath(name: string): Promise<NewProjectPath> {
  return api.resolveNewProjectPath(name);
}

/**
 * Create: make the folder, write the instructions, register, open. No
 * picker appears. The draft is cleared only once the project exists, so a
 * refusal (a folder already holding work, a name that makes no slug) leaves
 * the form as it was with the reason in a toast.
 */
export async function createNewProject(): Promise<boolean> {
  if (app.busy) return false;
  const d = app.newProjectDraft;
  try {
    // Backlog 432: the practices CLAUDE.md, when the box is ticked and
    // there is a practices file for its line to import. The backend writes
    // it only where the folder has none.
    const offer = d.claudeMd === false ? null : await api.claudeMdOffer(d.pickedPath ?? "").catch(() => null);
    const claudeMd = !!offer?.practices && !offer.exists;
    const project = await api.newProject(d.name, d.pickedPath, d.instructions, claudeMd);
    app.newProjectDraft = { name: "", instructions: "", pickedPath: null };
    // Its tab closes with Create (backlog 394); the switch below shows the
    // new project's strip, so nothing lands in its place here.
    app.newProjectOpen = false;
    const formTab = tabs.findAnywhere(app.tabs, { kind: "new-project" });
    if (formTab) tabs.close(app.tabs, formTab.id);
    // ~~The list and the folder re-read before the form closed~~ (backlog
    // 211's leftovers, 2026-09-26: the form stayed up for as long as a
    // listing could hang). The row comes from the answer, the form closes
    // at once, and the re-reads follow in the background — the folder's
    // because it now exists if it did not, and the Settings pane's line
    // reads off `exists`.
    app.projects = withProject(app.projects, project);
    void refreshWithin("creating " + project.name, [refreshProjects, refreshProjectsFolder]);
    app.view = "chat";
    void useProject(project.id);
    return true;
  } catch (e) {
    addToast(String(e));
    return false;
  }
}

/**
 * Import a claude.ai export: pick the archive, pick where the projects go,
 * write them, then show the list.
 *
 * One dialog, for the archive. There used to be a second asking where the
 * projects should be created, which stopped being a question worth asking
 * once a project stopped being a folder: an imported one is instructions,
 * documents and conversations, and the folder it was made to live in only
 * ever existed to give it an identity.
 */
export async function importFromClaude(): Promise<void> {
  let archive: string | null = null;
  try {
    archive = await api.pickExport();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!archive) return; // cancelled

  addToast("Importing…");
  try {
    const result = await api.importClaude(archive, true);
    // The toast at once; the new rows follow the re-read (backlog 211).
    void refreshWithin("importing", [refreshProjects]);
    addToast(`Imported ${result.summary}`);
    // The memory summaries that were too long for AGENTS.md: their file
    // points at the full text and someone owes a short version. Named, so
    // the toast says which projects rather than only how many.
    if (result.needs_condensing.length > 0) {
      const names = result.needs_condensing.map(([name]) => name).join(", ");
      addToast(`Memory to condense in AGENTS.md: ${names}`);
    }
    for (const warning of result.warnings.slice(0, 3)) addToast(warning);
  } catch (e) {
    addToast(String(e));
  }
}

export async function renameProject(id: string, name: string): Promise<void> {
  try {
    const project = await api.renameProject(id, name);
    if (app.project?.id === id) app.project = project;
    // The row renamed in place; the re-read follows (backlog 211).
    app.projects = withProject(app.projects, project);
    void refreshWithin("renaming " + name, [refreshProjects]);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Drop a project from the list. Nothing on disk is touched, and the toast
 * says so — a "remove" next to a folder full of work has to be unambiguous.
 */
export async function forgetProject(id: string): Promise<void> {
  const wasOpen = app.project?.id === id;
  try {
    await api.forgetProject(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  addToast(
    "Removed from the list — the folder, its notes and its chats are untouched on disk.",
  );
  // The row goes at once; the re-read follows (backlog 211).
  app.projects = withoutProject(app.projects, id);
  void refreshWithin("forgetting a project", [refreshProjects]);
  dropProjectTabs(id);
  if (wasOpen) await useProject(null);
}

export async function revealFolder(path?: string): Promise<void> {
  try {
    await api.reveal(path);
  } catch (e) {
    addToast(String(e));
  }
}

// ---- the workspace across a quit (nightshift backlog 201) ----

/**
 * The project the workspace in `app.tabs` belongs to, as a store key
 * (`tabsStore.ts`), or null while it belongs to none yet — at launch
 * until `restoreTabs` has run, and during a project switch. Nothing is
 * saved while it is null, so the one New chat tab a launch opens with
 * never overwrites the stored workspace it is about to be replaced by.
 */
export let tabsOwner: string | null = null;

/**
 * Put back the open project's stored workspace (backlog 201): at launch
 * and after a project switch, once the chat, note and project lists are
 * read (they decide which tabs survive). With nothing stored, or nothing
 * that survives, the workspace stays as it is. `show` (the default)
 * brings the focused pane's front tab forward through the tab's own
 * opener — a chat's transcript is read, no turn is started; a caller
 * that keeps the page in front (a switch on the Nightshift page) passes
 * false. At launch only — no shell open yet — the docks' shells reopen,
 * fresh, in the project's folder. A malformed store costs the layout,
 * never the launch.
 */
export async function restoreTabs(opts: { show?: boolean; newProjectFront?: boolean } = {}): Promise<void> {
  const key = tabsKeyNow();
  let reopenShells: { pane: string; count: number }[] = [];
  try {
    const saved = typeof localStorage === "undefined" ? undefined : loadSavedWorkspaces(localStorage)[key];
    const rebuilt = saved ? rebuild(saved, resolveTabContent) : null;
    if (rebuilt) {
      app.tabs = rebuilt.ws;
      reopenShells = rebuilt.shells;
    }
  } catch {
    // The layout is lost; the launch is not.
  }
  // The New project tab, while open, is the workspace's (backlog 394):
  // first in the focused pane whatever project's strip this is, in front
  // when it was in front.
  if (app.newProjectOpen) {
    tabs.pinNewProject(app.tabs, opts.newProjectFront ?? app.view === "new-project");
  }
  tabsOwner = key;
  if (opts.show !== false) {
    try {
      await activateTab(tabs.activeTab(tabs.focusedPane(app.tabs)).id);
    } catch {
      // The tab stays; its content opens on the next click.
    }
  }
  const hooks = terminalHooks;
  if (hooks && reopenShells.length > 0 && !hooks.any()) {
    for (const s of reopenShells) {
      try {
        await hooks.open(s.pane, s.count);
      } catch {
        // A shell that cannot open says so in its own toast.
      }
    }
  }
}
