// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { clock12 as faceClock12 } from "../nightshiftFace";
import * as api from "../api";
import type { NightshiftRow, RevertPreview, ShiftSummary } from "../types";
import { READ_KEY, app, reflectTabs, addToast } from "../state.svelte";

// ---- nightshift ----

export function showNightshift(): void {
  app.view = "nightshift";
  app.leftTab = "nightshift";
  app.openNote = null;
  // The page is a tab (backlog 140): one in the workspace; a second
  // click activates it wherever it sits. Landed here as well as by the
  // effect, so the click works when the view is already Nightshift but
  // its tab is in the background of the other pane.
  reflectTabs();
  void refreshNightshift();
}

/**
 * Re-read every project's Nightshift row, then point the surface at the
 * open project. There is no separate Nightshift selection any more: the
 * page shows the project in the top-left chip (Swaraag's round-2 point 12
 * — two project lists with two selections was the confusing part), so this
 * always re-selects `app.project`, which re-watches its root and re-reads
 * the Review screens.
 */
export async function refreshNightshift(): Promise<void> {
  app.nightshift.loading = true;
  app.nightshift.error = null;
  try {
    app.nightshift.rows = await api.nightshiftProjects();
    app.nightshift.defaultRunner = await api.nightshiftDefaultRunner();
  } catch (e) {
    app.nightshift.error = String(e);
    addToast(String(e));
    return;
  } finally {
    app.nightshift.loading = false;
  }
  await selectNightshiftProject(app.project?.id ?? null);
}

/**
 * Keep the Nightshift surface on the open project. Called wherever
 * `app.project` can change (`refreshProjects` runs after every open, create
 * and import); a no-op when nothing moved, so the frequent refreshes cost
 * nothing.
 */
export async function syncNightshiftProject(): Promise<void> {
  const id = app.project?.id ?? null;
  if (id === app.nightshift.selected) return;
  // A project registered a moment ago (New project…, the importer) is not in
  // `rows` yet, and selecting an unknown id dead-ends on "not in the project
  // list yet" until the nav button re-reads the rows (review F8). Re-read
  // them here instead; refreshNightshift re-selects the open project itself.
  if (id && !app.nightshift.rows.some((r) => r.id === id)) {
    await refreshNightshift();
    return;
  }
  await selectNightshiftProject(id);
}

/** Bumped by every selectNightshiftProject; a call that finds itself
 *  superseded after its awaits stops rather than overwriting the newer one
 *  (review F9: two switches inside one unwatch round trip). */
let selectSeq = 0;

/** Re-read one row in place — what a `nightshift-change` event triggers. */
export async function refreshNightshiftRow(id: string): Promise<void> {
  try {
    const fresh = await api.nightshiftProject(id);
    const i = app.nightshift.rows.findIndex((r) => r.id === id);
    if (i >= 0) app.nightshift.rows[i] = fresh;
    else app.nightshift.rows.push(fresh);
  } catch {
    // The row it replaces is left as-is; a live watch failing quietly here
    // is better than a toast on every filesystem hiccup.
  }
}

/**
 * Point the surface at a project — the open one, in practice (see
 * `syncNightshiftProject`) — or at nothing. Unwatches the previous root,
 * drops everything read for it, watches the new one when it has a contract,
 * and re-reads the Review screens.
 */
export async function selectNightshiftProject(id: string | null): Promise<void> {
  const seq = ++selectSeq;
  const prev = app.nightshift.selected;
  if (prev && prev !== id) {
    try {
      await api.nightshiftUnwatch(prev);
    } catch {
      // Best-effort: an unwatch failing leaves an extra watch running, not a
      // broken UI.
    }
  }
  if (seq !== selectSeq) return;
  if (prev !== id) {
    // Everything below is about the previous project.
    app.nightshift.mornings = [];
    app.nightshift.shifts = [];
    app.nightshift.selectedShift = null;
    app.nightshift.log = "";
    app.nightshift.diff = null;
    app.nightshift.blockers = null;
    app.nightshift.selectedBlocker = null;
    app.nightshift.notes = [];
    app.nightshift.selectedNote = null;
    app.nightshift.noteText = null;
    app.nightshift.items = null;
    app.nightshift.selectedItem = null;
    app.nightshift.planDraft = null;
    app.nightshift.planPath = null;
    app.nightshift.pending = null;
    app.nightshift.usage = null;
    app.nightshift.interview = null;
    app.nightshift.interviewDraft = { open: false, idea: "", reply: "" };
    app.nightshift.editDrafts = {};
  }
  app.nightshift.selected = id;
  // Only a root can be watched; a project without a contract (the Enable
  // card) has nothing to subscribe to, and asking would toast an error.
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (id && row?.nightshift) {
    try {
      await api.nightshiftWatch(id);
    } catch (e) {
      addToast(String(e));
    }
  }
  if (seq !== selectSeq) return;
  await loadNightshiftReview();
}

/**
 * Everything the Review screens show for the selected project: the newest
 * morning page and the list of pages, the shifts, the blockers. Read in one
 * go rather than per tab so the tab counts in the header are right before a
 * tab is opened.
 */
export async function loadNightshiftReview(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) {
    app.nightshift.morning = null;
    app.nightshift.mornings = [];
    app.nightshift.shifts = [];
    app.nightshift.blockers = null;
    app.nightshift.notes = [];
    app.nightshift.items = null;
    return;
  }
  await Promise.all([
    loadNightshiftMorning(),
    loadMornings(),
    loadShifts(),
    loadBlockers(),
    loadNotes(),
    loadItems(),
    // The backend holds a timer across project switches and webview
    // reloads; the chip must show it wherever the surface lands, not only
    // once the Plan screen mounts (review F3).
    loadPendingLaunch(),
  ]);
}

/**
 * What a change event re-reads. The runner writes `status.json` many times a
 * shift and `run.log` continuously, so only the lists the paths touch are
 * re-read; the morning page always is, since the newest one is what the
 * header's "new" pill hangs on.
 */
export async function refreshNightshiftReview(paths: string[]): Promise<void> {
  const touches = (prefix: string) => paths.some((p) => p.startsWith(prefix));
  const jobs: Promise<void>[] = [loadNightshiftMorning()];
  if (touches("mornings/")) jobs.push(loadMornings());
  if (touches("shifts/")) jobs.push(loadShifts().then(() => loadShiftLog()).then(refreshLiveDiff));
  if (touches("blockers/")) jobs.push(loadBlockers());
  if (touches("notes/")) jobs.push(loadNotes());
  if (touches("backlog/")) jobs.push(loadItems());
  await Promise.all(jobs);
}

/**
 * Runs → Changes for a live shift is `head_at_start..HEAD`, which grows with
 * every unit commit; showDiff reads it once and skips a repeat request for
 * the same key, so a running shift's diff went stale (review F10). Re-read
 * it when the shift list changes and the shown diff is a live shift's.
 */
let liveDiffCommits = "";
async function refreshLiveDiff(): Promise<void> {
  const d = app.nightshift.diff;
  if (!d || d.kind !== "shift" || d.loading) return;
  const shift = app.nightshift.shifts.find((s) => s.id === d.key);
  if (!shift?.live) return;
  // `shifts/` changes on every run.log line; only a landed unit moves HEAD.
  const commits = (shift.status?.units ?? []).map((u) => u.commit ?? "").join(",");
  if (commits === liveDiffCommits) return;
  liveDiffCommits = commits;
  app.nightshift.diff = null;
  await showDiff("shift", d.key);
}

export async function loadMornings(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.mornings = await api.nightshiftMornings(id);
  } catch (e) {
    addToast(String(e));
  }
}

/** Open a page by name, or the newest with `null`. Opening marks it read. */
export async function openMorning(name: string | null): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.morning = await api.nightshiftMorning(id, name ?? undefined);
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (app.nightshift.morning) markMorningRead(app.nightshift.morning.name);
}

export function morningIsRead(projectId: string, name: string): boolean {
  return (app.nightshift.read[projectId] ?? []).includes(name);
}

export function markMorningRead(name: string): void {
  const id = app.nightshift.selected;
  if (!id) return;
  const list = app.nightshift.read[id] ?? [];
  if (list.includes(name)) return;
  app.nightshift.read[id] = [...list, name];
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(app.nightshift.read));
  } catch {
    // best-effort
  }
  // The page's notice leaves the bell (nightshift backlog 069).
  app.centre.notices = app.centre.notices.filter((n) => n.id !== `morning:${id}:${name}`);
}

export async function loadShifts(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    const shifts = await api.nightshiftShifts(id);
    // Newest first: ids are timestamps, so the string order is the time order.
    shifts.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    app.nightshift.shifts = shifts;
  } catch (e) {
    addToast(String(e));
    return;
  }
  const still = app.nightshift.shifts.some(
    (s) => s.id === app.nightshift.selectedShift,
  );
  if (!still) {
    app.nightshift.selectedShift = app.nightshift.shifts[0]?.id ?? null;
    app.nightshift.diff = null;
    await loadShiftLog();
  }
}

/** The newest shift's status — what the header's state chip reads. */
export function latestShift(): ShiftSummary | null {
  return app.nightshift.shifts[0] ?? null;
}

export async function selectShift(id: string | null): Promise<void> {
  if (app.nightshift.selectedShift === id) return;
  app.nightshift.selectedShift = id;
  app.nightshift.diff = null;
  await loadShiftLog();
}

export async function loadShiftLog(): Promise<void> {
  const id = app.nightshift.selected;
  const shift = app.nightshift.selectedShift;
  if (!id || !shift) {
    app.nightshift.log = "";
    return;
  }
  try {
    app.nightshift.log = await api.nightshiftShiftLog(id, shift);
  } catch (e) {
    app.nightshift.log = `(could not read run.log: ${String(e)})`;
  }
}

/** Show one unit's commit, or the whole shift's `head_at_start..HEAD`. */
export async function showDiff(
  kind: "unit" | "shift",
  key: string,
): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  const cur = app.nightshift.diff;
  if (cur && cur.kind === kind && cur.key === key && !cur.error) return;
  app.nightshift.diff = { kind, key, text: "", loading: true, error: null };
  try {
    const text =
      kind === "unit"
        ? await api.nightshiftDiff(id, key)
        : await api.nightshiftShiftDiff(id, key);
    // Still the one asked for? A slow read for a diff nobody is looking at
    // any more must not overwrite the one they are.
    const now = app.nightshift.diff;
    if (now && now.kind === kind && now.key === key) {
      app.nightshift.diff = { kind, key, text, loading: false, error: null };
    }
  } catch (e) {
    const now = app.nightshift.diff;
    if (now && now.kind === kind && now.key === key) {
      app.nightshift.diff = {
        kind,
        key,
        text: "",
        loading: false,
        error: String(e),
      };
    }
  }
}

export async function loadBlockers(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.blockers = await api.nightshiftBlockers(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const list = app.nightshift.blockers.blockers;
  const still = list.some((b) => b.id === app.nightshift.selectedBlocker);
  if (!still) {
    // Open first, as the list is shown.
    const first = list.find((b) => b.status === "open") ?? list[0];
    app.nightshift.selectedBlocker = first?.id ?? null;
  }
}

export function selectBlocker(id: string): void {
  app.nightshift.selectedBlocker = id;
}

// ---- Start: backlog and plan (3.6, 3.7) ----

/** Re-read `backlog/*` and `order.json` — what both Start screens list. */
export async function loadItems(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.items = await api.nightshiftItems(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const list = app.nightshift.items.items;
  const still = list.some((i) => i.id === app.nightshift.selectedItem);
  if (!still) app.nightshift.selectedItem = list[0]?.id ?? null;
}

/** Select an item for the Backlog screen's main column. */
export function selectItem(id: string): void {
  app.nightshift.selectedItem = id;
}

/** Scaffold a new item, re-read the backlog, select it. Returns the id. */
export async function newItem(title: string, kind: string): Promise<string | null> {
  const id = app.nightshift.selected;
  if (!id) return null;
  try {
    const created = await api.nightshiftNewItem(id, title, kind);
    await loadItems();
    app.nightshift.selectedItem = created;
    return created;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

// ---- the intake interview (item 005) ----

/** Begin an interview with the idea; the interviewer's first questions
 *  stream in. Replaces one in progress. */
export async function startInterview(idea: string): Promise<boolean> {
  const id = app.nightshift.selected;
  if (!id) return false;
  app.nightshift.interview = {
    messages: [{ role: "user", text: idea }],
    streaming: "",
    busy: true,
    model: null,
  };
  try {
    const view = await api.nightshiftInterviewStart(id, idea);
    if (app.nightshift.interview) {
      app.nightshift.interview.messages = view.messages;
      app.nightshift.interview.model = view.model;
    }
    return true;
  } catch (e) {
    addToast(String(e));
    if (app.nightshift.interview) app.nightshift.interview.messages = [{ role: "user", text: idea }];
    return false;
  } finally {
    if (app.nightshift.interview) app.nightshift.interview.busy = false;
  }
}

export async function sendInterview(text: string): Promise<void> {
  const id = app.nightshift.selected;
  const iv = app.nightshift.interview;
  if (!id || !iv || iv.busy) return;
  iv.messages.push({ role: "user", text });
  iv.busy = true;
  try {
    const view = await api.nightshiftInterviewSend(id, text);
    iv.messages = view.messages;
    iv.model = view.model;
  } catch (e) {
    // The backend dropped the refused turn; the pane matches, and the text
    // goes back so a rephrase does not start from nothing.
    iv.messages = iv.messages.filter((m, i) => !(i === iv.messages.length - 1 && m.role === "user" && m.text === text));
    iv.lastRefused = text;
    addToast(String(e));
  } finally {
    iv.busy = false;
  }
}

/** What the backend holds, for a Backlog screen that comes back mid-interview. */
export async function loadInterview(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    const view = await api.nightshiftInterviewState(id);
    app.nightshift.interview = view
      ? { messages: view.messages, streaming: "", busy: false, model: view.model }
      : null;
  } catch {
    // An older backend without the command: no interview to show.
    app.nightshift.interview = null;
  }
}

export async function cancelInterview(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftInterviewCancel(id);
  } catch (e) {
    addToast(String(e));
  }
  app.nightshift.interview = null;
}

/** Close the interview: the item is written with the transcript beside it,
 *  the backlog re-read, the new item selected. Returns its id. */
export async function writeInterviewItem(): Promise<string | null> {
  const id = app.nightshift.selected;
  const iv = app.nightshift.interview;
  if (!id || !iv || iv.busy) return null;
  iv.busy = true;
  try {
    const written = await api.nightshiftInterviewWrite(id);
    app.nightshift.interview = null;
    await loadItems();
    app.nightshift.selectedItem = written.id;
    addToast(`Item ${written.id} written — ${written.title}`);
    return written.id;
  } catch (e) {
    addToast(String(e));
    iv.busy = false;
    return null;
  }
}

/** Delete an item — to backlog/trash/, never unlinked — then re-read. */
export async function deleteItem(id: string): Promise<string | null> {
  const proj = app.nightshift.selected;
  if (!proj) return null;
  try {
    const went = await api.nightshiftDeleteItem(proj, id);
    delete app.nightshift.editDrafts[id];
    await loadItems();
    if (app.nightshift.selectedItem === id) app.nightshift.selectedItem = null;
    addToast(`Item ${id} moved to ${went}`);
    return went;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** Save an item's edited text, then re-read the backlog. */
export async function saveItem(itemId: string, text: string): Promise<boolean> {
  const id = app.nightshift.selected;
  if (!id) return false;
  try {
    await api.nightshiftWriteItem(id, itemId, text);
    delete app.nightshift.editDrafts[itemId];
    await loadItems();
    return true;
  } catch (e) {
    addToast(String(e));
    return false;
  }
}

/**
 * Rewrite `backlog/order.json` to `order`, then re-read the backlog so the
 * rows and their position numbers reflect it. Refused by the backend while a
 * shift is live — callers disable the drag in that case rather than relying
 * on this to fail quietly.
 */
export async function reorderItems(order: string[]): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftSetOrder(id, order);
  } catch (e) {
    addToast(String(e));
    return;
  }
  await loadItems();
}

/**
 * A fresh plan the way `shiftctl plan synth` would write it, seeded from the
 * project's current backlog and order — for the Plan screen to start
 * editing locally. Writes nothing; every subsequent edit (selection,
 * reorder, kind, bounds) mutates `planDraft` in place until Launch.
 */
export async function synthPlan(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) return;
  try {
    app.nightshift.planDraft = await api.nightshiftSynthPlan(id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Launch tonight: write `planDraft` to `shifts/<id>/plan.json`, then launch
 * the runner on it. Both are refused in cases the backend's error already
 * names (a live shift, a plan that already exists, a non-macOS host) — those
 * surface as toasts rather than being predicted here.
 */
export async function writeAndLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  const plan = app.nightshift.planDraft;
  if (!id || !plan) return;
  app.nightshift.launching = true;
  try {
    const path = await api.nightshiftWritePlan(id, plan);
    app.nightshift.planPath = path;
    const pid = await api.nightshiftLaunch(id, path);
    addToast(`Launched shift ${plan.shift_id} — pid ${pid}`);
    await Promise.all([refreshNightshiftRow(id), loadNightshiftReview()]);
    // Runs keeps whichever shift was last looked at; the one just launched
    // is the one worth following (first launch from the app, 2026-09-12:
    // Runs opened on yesterday's shift while tonight's ran).
    await selectShift(plan.shift_id);
  } catch (e) {
    addToast(String(e));
  } finally {
    app.nightshift.launching = false;
  }
}

/**
 * Hold the draft and launch it at `fireAtMs` (the Start field's "when usage
 * resets" and "at a time"). The backend keeps the timer; the app shows it as
 * `app.nightshift.pending` and, in the state chip, "launches at …". Nothing
 * is written until it fires.
 */
export async function scheduleLaunch(fireAtMs: number): Promise<void> {
  const id = app.nightshift.selected;
  const plan = app.nightshift.planDraft;
  if (!id || !plan) return;
  app.nightshift.launching = true;
  try {
    app.nightshift.pending = await api.nightshiftScheduleLaunch(id, plan, fireAtMs);
    addToast(`Shift held — launches ${clockOf(fireAtMs)}`);
  } catch (e) {
    addToast(String(e));
  } finally {
    app.nightshift.launching = false;
  }
}

export async function cancelLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftCancelLaunch(id);
    app.nightshift.pending = null;
    addToast("Scheduled launch cancelled");
  } catch (e) {
    addToast(String(e));
  }
}

/** What the backend is holding for the selected project, if anything. */
export async function loadPendingLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.pending = await api.nightshiftPendingLaunch(id);
  } catch {
    // An older backend without the command: no pending launch to show.
    app.nightshift.pending = null;
  }
}

/** The runner's usage probe, for the Start field. A probe that cannot
 *  answer leaves `usage` null and the field says so. */
export async function loadUsage(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.usage = await api.nightshiftUsage(id);
  } catch {
    app.nightshift.usage = null;
  }
}

/** `at 5:10 AM`, `at 5:10 AM tomorrow` or `at 5:10 AM Nov 12`, local time,
 *  for toasts and the chip — his 12-hour clock (item 611; was `at 05:10`). */
export function clockOf(ms: number, now: Date = new Date()): string {
  return `at ${faceClock12(ms, now)}`;
}

/** Re-read the flat file listing under `notes/` — what the Notes screen's
 *  tree is built from. */
export async function loadNotes(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.notes = await api.nightshiftNotes(id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Open a file by root-relative path in the Notes screen's main column. Not
 * limited to paths under `notes/` — `nightshift_read_file` reads anything
 * under the contract root, which is how "Open in Notes" on the Morning
 * screen can open `mornings/<name>` even though that file is not in the
 * `notes` tree.
 */
export async function openNote(path: string): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  app.nightshift.selectedNote = path;
  app.nightshift.noteText = null;
  try {
    const text = await api.nightshiftReadFile(id, path);
    // Still the one asked for? A slow read for a note no longer selected
    // must not overwrite the current one.
    if (app.nightshift.selectedNote === path) app.nightshift.noteText = text;
  } catch (e) {
    if (app.nightshift.selectedNote === path) {
      app.nightshift.noteText = null;
      addToast(String(e));
    }
  }
}

/** Write `## Answer` and flip the blocker to `answered`; re-read the list. */
export async function answerBlocker(id: string, answer: string): Promise<boolean> {
  const project = app.nightshift.selected;
  if (!project) return false;
  try {
    await api.nightshiftAnswerBlocker(project, id, answer);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await loadBlockers();
  return true;
}

export async function revertPreview(
  shiftId: string,
): Promise<RevertPreview | null> {
  const project = app.nightshift.selected;
  if (!project) return null;
  try {
    return await api.nightshiftRevertPreview(project, shiftId);
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** The confirmed revert. The caller has shown the preview and been told yes. */
export async function revertShift(
  shiftId: string,
): Promise<RevertPreview | null> {
  const project = app.nightshift.selected;
  if (!project) return null;
  try {
    const done = await api.nightshiftRevert(project, shiftId, true);
    addToast(`Reverted to ${done.target.slice(0, 7)} — ${done.commits} commits discarded`);
    await Promise.all([loadShifts(), refreshNightshiftRow(project)]);
    app.nightshift.diff = null;
    return done;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** The selected project's newest morning page, or null when it has none. */
export async function loadNightshiftMorning(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) {
    app.nightshift.morning = null;
    return;
  }
  try {
    app.nightshift.morning = await api.nightshiftMorning(id);
  } catch (e) {
    app.nightshift.morning = null;
    addToast(String(e));
  }
}

/**
 * **Enable Nightshift** on a project: scaffold `<workspace>/nightshift/` and
 * select it. The scaffold's notes are its caveats (a missing git repo, a
 * runner that is not installed) — surfaced as toasts since there is nowhere
 * in the list for them to live once the row replaces itself.
 */
export async function enableNightshift(
  id: string,
  runner?: string,
): Promise<void> {
  let row: NightshiftRow;
  let notes: string[];
  try {
    [row, notes] = await api.nightshiftEnable(id, undefined, runner);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const i = app.nightshift.rows.findIndex((r) => r.id === id);
  if (i >= 0) app.nightshift.rows[i] = row;
  else app.nightshift.rows.push(row);
  for (const note of notes) addToast(note);
  await selectNightshiftProject(id);
}
