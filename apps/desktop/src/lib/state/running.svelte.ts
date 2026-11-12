// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { tick } from "svelte";
import * as api from "../api";
import { sameChoice, wantedChoice } from "../chatChoice";
import { chatName } from "../notify";
import { canDetach, firstUserText, inOtherProject, keptPaneLogs, liveHost, paneChatOf, type PaneChat } from "../browse";
import * as tabs from "../tabs";
import { FirstSeen, doingOf, quoteLine, sortRuns, type RunEntry, type RunKind } from "../running";
import { rememberScroll } from "../scroll.svelte";
import type { ApprovalRequest, SessionEvent, Usage } from "../types";
import { asideStash, chatHome, type AsideTurn, type Aside } from "./asides.svelte";
import { leaveNote } from "./notes.svelte";
import { useProject } from "./projects.svelte";
import { subagentRunning } from "./segments.svelte";
import { bannerChat } from "./resumes.svelte";
import { chatChoice } from "./connection.svelte";
import { type Segment, app, startingIn, runningChatName, type TurnCtx, fg, openSession } from "../state.svelte";

/** The turns in `app.background`, by chat. */
export const bgTurns = new Map<string, TurnCtx>();

/** The background turn's chat id that `chat` names (the full id or a
 *  prefix, as the phone may send), or `null` when that chat is not
 *  running in the background (A3). */
export function backgroundTurnOf(chat: string): string | null {
  if (bgTurns.has(chat)) return chat;
  const hits = [...bgTurns.keys()].filter((id) => id.startsWith(chat));
  return hits.length === 1 ? hits[0] : null;
}

/** A background chat's name, for its toasts and banners. ~~"another
 *  chat" when it has no sidebar row~~ — A4: an ephemeral chat has none,
 *  nor a New chat the list has not re-read yet; its first message names
 *  it, quoted. */
export function backgroundName(id: string, events?: SessionEvent[]): string {
  const b = app.background[id];
  // In another project (blocker 630): the list on screen is not its own,
  // so the name it had when it left the screen, and where it is.
  const where = b && inOtherProject(b, app.project?.id ?? null) ? ` in ${b.projectName ?? "unfiled chats"}` : "";
  const s = where ? undefined : app.sessions.find((x) => x.id === id);
  if (s) return chatName(s.title, s.first_user);
  if (b?.name) return b.name + where;
  const first = firstUserText(events ?? b?.events ?? []);
  return (first ? `“${chatName(null, first)}”` : "a chat off screen") + where;
}

/** Where a chat going off screen runs, and what its list calls it (A4). */
export function whereItRuns(id: string): { project: string | null; projectName: string | null; name: string | null } {
  const s = app.sessions.find((x) => x.id === id);
  return {
    project: app.project?.id ?? null,
    projectName: app.project?.name ?? null,
    name: s ? chatName(s.title, s.first_user) : null,
  };
}

/** Whether the project can be left or switched now (blocker 630, "allow"):
 *  a running chat goes off screen and keeps its turn. The one wait is a
 *  New chat's first turn before its first event names the chat — it has
 *  no id to be kept under yet. */
export function canLeaveProject(): boolean {
  // Re-read as the first event names the chat (`fg` is not state).
  void app.liveVersion;
  if (app.parked) return fg !== null && canDetach(app.connection?.engine, fg.chat);
  return canLeaveRunning();
}

/** Open a chat running off screen, from anywhere (A4): its own project
 *  first when that is not the open one; the chat then comes back on
 *  screen, streaming, as from its tab. */
export async function openRunningChat(id: string): Promise<void> {
  const b = app.background[id];
  if (b && inOtherProject(b, app.project?.id ?? null)) {
    await useProject(b.project ?? null);
    if ((app.project?.id ?? null) !== (b.project ?? null)) return;
  }
  // Its restored tab may have brought it back already.
  if (app.background[id] || app.activeSessionId !== id) await openSession(id);
}

/**
 * Open the chat a waiting notice names, at its card (nightshift item 523):
 * a chat off screen comes back on screen (in its own project), a parked
 * turn's chat is returned to, the chat on screen leaves a note or page for
 * its transcript — then the card is scrolled into view and focused.
 */
export async function openWaiting(chat: string | null, id: string): Promise<void> {
  if (chat !== null && app.background[chat]) await openRunningChat(chat);
  // While its turn runs `openSession` only brings it forward: back from a
  // parked look-away, out of a note, or its tab to the front.
  else if (chat !== null) await openSession(chat);
  else if (app.view !== "chat") leaveNote();
  // The card is drawn once the chat's transcript is; give it a moment.
  for (let i = 0; i < 40; i++) {
    await tick();
    const card = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-ask-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: "center" });
      card.focus({ preventScroll: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A chat's name for a waiting notice (item 523). */
export function waitingChatName(chat: string | null, where: "screen" | "background" | "parked"): string {
  if (where === "background" && chat !== null) return backgroundName(chat);
  if (where === "parked") return runningChatName();
  return bannerChat();
}

/** Every chat whose turn runs now (A4), for the Running-tasks panel and
 *  the top bar's chip: the screen's (or parked) turn first, then each
 *  off screen, oldest first. `waiting` counts its unanswered prompts. */
export interface LiveChat {
  session: string | null;
  name: string;
  onScreen: boolean;
  startedAt: number | null;
  usage: Usage | null;
  waiting: number;
}
export function liveChats(): LiveChat[] {
  // (A4, blocker 630: a row's name says which project it runs in when that
  // is not the open one — `backgroundName`.)
  const started = (events: SessionEvent[]): number | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "user_message") {
        const t = Date.parse(e.at);
        return Number.isNaN(t) ? null : t;
      }
    }
    return null;
  };
  const out: LiveChat[] = [];
  if (app.busy) {
    const session = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
    const events = app.parked ? app.parked.events : app.events;
    const host = liveHost(app);
    out.push({
      session,
      name: session ? backgroundName(session, events) : "the new chat",
      onScreen: !app.parked,
      startedAt: started(events),
      usage: host.liveUsage,
      waiting: app.pendingApprovals.length,
    });
  }
  for (const b of Object.values(app.background)) {
    out.push({
      session: b.session,
      name: backgroundName(b.session, b.events),
      onScreen: false,
      startedAt: started(b.events),
      usage: b.liveUsage,
      // A budget stop the hook holds for his answer (backlog 189) waits on
      // him too.
      waiting: b.approvals.length + (b.budget?.pending_since_ms ? 1 : 0),
    });
  }
  return out;
}

/**
 * The connection's context window, when it is known to be chat `id`'s
 * (559, the review's 534-2): built for that chat, or for a choice of model
 * and engine that chat's own recorded choice equals — and no connect is
 * running. Otherwise null, so a reading keeps the window stored for the
 * chat rather than taking the previous chat's.
 */
export function connectionWindowFor(id: string | null): number | null {
  const limit = app.connection?.contextLimit ?? null;
  const built = app.connectedFor;
  if (limit === null || !built || app.connecting) return null;
  if (built.chat === id) return limit;
  const wanted = wantedChoice(chatChoice.choices, id);
  return wanted && sameChoice(wanted, built.choice) ? limit : null;
}

/** Whether a turn runs in any chat — on screen, parked or off screen
 *  (A4's gates audit): what a CLI update waits on, where `app.busy` is
 *  "the chat on screen runs". ~~Leaving the project too~~ — blocker 630
 *  ("allow"): `canLeaveProject`. */
export function turnsRunning(): boolean {
  return app.busy || app.parked !== null || Object.keys(app.background).length > 0;
}

/** Whether chat `id`'s own turn runs (A4): its sidebar row cannot be
 *  deleted while it does (the backend refuses it too). */
export function chatRuns(id: string): boolean {
  if (app.background[id] || startingIn.has(id)) return true;
  if (!app.busy) return false;
  const running = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
  return running === id;
}

/** Start times for work that records none (backlog 309). */
const runSeen = new FirstSeen();

/** Where chat `id` lives, for the running list (backlog 309): an off-screen
 *  turn's record says; the chat on screen (or parked) is the open
 *  project's; else the project it was opened in this launch. */
function homeOfChat(id: string | null): { project: string | null; where: string } {
  const named = (project: string | null, name: string | null | undefined) => ({
    project,
    where: name ?? (project === null ? "unfiled chats" : "another project"),
  });
  const b = id ? app.background[id] : undefined;
  if (b) return named(b.project ?? null, b.projectName);
  const here = id === null || id === app.activeSessionId || id === app.parked?.session;
  if (here || !id || !chatHome.has(id)) return named(app.project?.id ?? null, app.project?.name);
  const h = chatHome.get(id)!;
  return named(h.project, h.name);
}

/** A chat's name for the running list: its row's, its record's, its first
 *  message's (`backgroundName`); "the new chat" before it has an id. */
function chatLabel(id: string | null): string {
  if (!id) return "the new chat";
  const b = app.background[id];
  if (b) {
    const s = !inOtherProject(b, app.project?.id ?? null) ? app.sessions.find((x) => x.id === id) : undefined;
    if (s) return chatName(s.title, s.first_user);
    if (b.name) return b.name;
    const first = firstUserText(b.events);
    return first ? `“${chatName(null, first)}”` : "a chat off screen";
  }
  const s = app.sessions.find((x) => x.id === id);
  if (s) return chatName(s.title, s.first_user);
  if (id === app.parked?.session) return backgroundName(id, app.parked.events);
  if (id === app.activeSessionId) return backgroundName(id, app.events);
  return "a chat";
}

/**
 * Everything running now, in every project (nightshift backlogs 308 and
 * 309) — see `running.ts`. Read from the state that already says what runs,
 * so it is never out of step with it: the turn on screen or parked and each
 * off screen (a council when its seats are running), each running subagent
 * of a chat whose turn still runs (a row left `running` by a turn that has
 * ended is the CLI's and gone with it — `subagentAsk` reads them the same
 * way), each asking aside (on screen and stashed), the dream, the capture,
 * the daily pass, the Nightshift interview, and each project's live
 * Nightshift run (detached: it outlives a quit). Note edits are
 * `running.svelte.ts`'s, which adds them.
 */
export function runningWork(now: number = Date.now()): RunEntry[] {
  void app.liveVersion;
  void app.paneVersion;
  const out: RunEntry[] = [];
  const seatsRunning = (chat: string | null) =>
    app.subagents.filter((r) => r.session === chat && r.subagent_type === SEAT_TYPE && subagentRunning(r)).length;
  const turnRow = (
    session: string | null,
    segments: Segment[] | null | undefined,
    events: SessionEvent[],
    onScreen: boolean,
    waiting: boolean,
  ): void => {
    const seats = seatsRunning(session);
    const home = homeOfChat(session);
    out.push({
      id: `turn:${session ?? "new"}`,
      kind: seats > 0 ? "council" : "turn",
      ...home,
      session,
      chat: chatLabel(session),
      doing: waiting ? "waiting on you" : seats > 0 ? `${seats} seat${seats === 1 ? "" : "s"} answering` : doingOf(segments),
      startedAt: lastUserAt(events),
      onScreen,
      waiting,
      survivesQuit: false,
    });
  };
  if (app.busy) {
    const session = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
    const host = liveHost(app);
    turnRow(session, host.live?.segments, app.parked ? app.parked.events : app.events, !app.parked, app.pendingApprovals.length > 0);
  }
  for (const b of Object.values(app.background)) {
    turnRow(b.session, b.live?.segments, b.events, false, b.approvals.length > 0 || !!b.budget?.pending_since_ms);
  }
  const turnOf = new Map(out.map((r) => [r.session, r]));
  for (const r of app.subagents) {
    if (!subagentRunning(r)) continue;
    const parent = turnOf.get(r.session);
    if (!parent) continue;
    const seat = r.subagent_type === SEAT_TYPE;
    const what = r.description || r.subagent_type || "agent";
    out.push({
      id: `agent:${r.tool_use_id}`,
      kind: seat ? "council seat" : "subagent",
      project: parent.project,
      where: parent.where,
      session: r.session,
      chat: parent.chat,
      doing: seat ? `${shortSeat(r.model)}${r.segments.length ? ` — ${doingOf(r.segments)}` : ""}` : `${what} — ${doingOf(r.segments)}`,
      startedAt: r.startedAt,
      onScreen: parent.onScreen,
      waiting: false,
      survivesQuit: false,
    });
  }
  const asking = (t: AsideTurn) => t.answer === null && t.error === null && !t.cancelled;
  const asideRows = (session: string | null, list: Aside[]) => {
    for (const a of list) {
      const t = a.turns.find(asking);
      if (!t) continue;
      out.push({
        id: `aside:${a.id}:${t.seq}`,
        kind: "aside",
        ...homeOfChat(session),
        session,
        chat: chatLabel(session),
        doing: quoteLine(t.question),
        startedAt: t.startedAt ?? null,
        onScreen: session === app.activeSessionId,
        waiting: false,
        survivesQuit: false,
      });
    }
  };
  asideRows(app.activeSessionId, app.asides);
  for (const [session, list] of asideStash) if (session !== app.activeSessionId) asideRows(session, list);
  const flag = (key: RunKind, running: boolean, where: string, doing: string, survivesQuit = false, project: string | null = null) => {
    const startedAt = runSeen.mark(`${key}:${project ?? ""}`, running, now);
    if (!running) return;
    out.push({
      id: `${key}:${project ?? ""}`,
      kind: key,
      project,
      where,
      session: null,
      chat: "",
      doing,
      startedAt,
      onScreen: false,
      waiting: false,
      survivesQuit,
    });
  };
  // The daily pass sets the capture and dream flags in turn; it is the row.
  flag("daily pass", app.centre.dailyRunning, "memory", "capture → dream → tidy");
  flag("dream", app.dreaming && !app.centre.dailyRunning, "memory", app.dreamActivity || "sorting the inbox into memory");
  flag("capture", app.capturing && !app.centre.dailyRunning, "memory", "reading chat logs into the inbox");
  flag("interview", !!app.nightshift.interview?.busy, "Nightshift", "the item interview is answering");
  for (const r of app.centre.rows) {
    flag("nightshift", !!r.nightshift?.live, r.name, "a shift is running — it keeps running if the app quits", true, r.id);
  }
  return sortRuns(out);
}

/** The council seat's own row type (`council.rs` `SEAT_TASK_TYPE`). */
const SEAT_TYPE = "council seat";
function shortSeat(model: string | undefined): string {
  return model ? `seat on ${model}` : "seat";
}

/** The newest message he sent in `events`, as a clock: a turn's start. */
function lastUserAt(events: SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === "user_message") {
      const t = Date.parse(e.at);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

/**
 * A click on a running row (backlog 309): its chat, in its own project,
 * at the foot of the transcript where the running turn is. A turn running
 * off screen comes back on screen streaming (`openRunningChat`); an aside's
 * chat opens with its cards. App-wide work has no chat and does nothing.
 */
export async function openRun(r: Pick<RunEntry, "session" | "project" | "onScreen">): Promise<void> {
  app.showTasks = false;
  const id = r.session;
  if (!id) return;
  // Opened at its foot: a chat never scrolled this launch opens there anyway.
  rememberScroll(id, 0, true);
  if (!r.onScreen) {
    if (app.background[id] || chatRuns(id)) {
      await openRunningChat(id);
    } else {
      if ((app.project?.id ?? null) !== r.project) {
        await useProject(r.project);
        if ((app.project?.id ?? null) !== r.project) return;
      }
      if (app.activeSessionId !== id) await openSession(id);
    }
  }
  app.toLatest++;
}

/** Whether chat `id` can be deleted now (A4's gates audit): ~~never while
 *  any turn runs~~ — any chat but a running one, on the Claude Code engine,
 *  where each chat has its own lock. ~~A provider turn, or a parked one,
 *  keeps the old rule.~~ Since A4 `browseFree()` is true on either engine,
 *  so a provider turn no longer keeps the old rule either: the backend's
 *  `forget` refuses only the chat whose lock is held (A4 review, struck
 *  2026-09-30). A parked turn still keeps it. */
export function canDeleteChat(id: string): boolean {
  if (chatRuns(id)) return false;
  return !app.busy || (browseFree() && !app.parked);
}

/**
 * What a pane draws of chat `id` (nightshift backlog 159, piece 5): its
 * live state wherever it is kept — off screen, parked, on screen — or its
 * log read for the pane. Null until that log has been read
 * (`loadPaneLog`).
 */
export function paneChat(id: string): PaneChat<Segment, ApprovalRequest> | null {
  return paneChatOf<Segment, ApprovalRequest>(app, id);
}

/** The chats the panes show now: each pane's active chat tab. */
function shownPaneChats(): Set<string> {
  const out = new Set<string>();
  for (const p of app.tabs.panes) {
    const c = tabs.activeTab(p).content;
    if (c.kind === "chat" && c.session) out.add(c.session);
  }
  return out;
}

/** Keep `events` as the pane log of chat `id` when a pane shows it, and
 *  let go of the logs no pane shows any more. */
export function keepPaneLog(id: string | null, events: SessionEvent[]): void {
  const shown = shownPaneChats();
  const next = keptPaneLogs(app.paneLogs, shown);
  if (id && shown.has(id)) next[id] = events;
  app.paneLogs = next;
}

const paneReads = new Set<string>();
/**
 * Read chat `id`'s log for the pane that shows it (piece 5): through
 * `transcript` with the chat named — held in memory (an ephemeral chat
 * too) or on disk, and never waiting on a turn. A failed read keeps what
 * the pane had; an empty log draws an empty pane.
 */
export async function loadPaneLog(id: string): Promise<void> {
  if (paneReads.has(id)) return;
  paneReads.add(id);
  try {
    const events = await api.transcript(false, id);
    // An ephemeral chat let go has no log anywhere: what the pane drew
    // stays rather than going blank.
    if (events.length === 0 && app.paneLogs[id]?.length) return;
    keepPaneLog(id, events);
  } catch {
    // The pane keeps what it had; the next turn's end reads it again.
  } finally {
    paneReads.delete(id);
  }
}

/** A turn that ran off screen has ended (piece 5): the pane showing its
 *  chat keeps the record it drew, then reads the log with the reply. */
export function refreshPaneLog(id: string, events: SessionEvent[]): void {
  if (!shownPaneChats().has(id)) return;
  keepPaneLog(id, events);
  void loadPaneLog(id);
}

/** Whether a chat can be opened while a turn runs without parking it —
 *  ~~the Claude Code engine's turns go to the background (A2)~~ either
 *  engine's since A4. */
export function browseFree(): boolean {
  return !!app.connection;
}

/** The provider turn running off screen, if one does (A4): the engine
 *  runs one at a time, so a message typed elsewhere meanwhile queues in
 *  its chat and sends when that turn ends. */
export function providerElsewhere(): string | null {
  for (const [id, t] of bgTurns) if (t.provider) return id;
  return null;
}
/** Its name, for the queue's toast. */
export function providerElsewhereName(): string | null {
  const id = providerElsewhere();
  return id ? backgroundName(id) : null;
}

/** Each mounted composer's drain, newest last (A4 review, 2026-09-29): a
 *  provider turn that ends off screen frees the engine, and the message
 *  queued behind it in the chat on screen goes, as its notice promised —
 *  ~~only through the continuation of the composer that sent the turn,
 *  which is another instance once a New chat's Welcome box gave way~~. */
export const providerDrains: Array<() => Promise<void>> = [];
export function registerProviderDrain(fn: () => Promise<void>): () => void {
  providerDrains.push(fn);
  return () => {
    const i = providerDrains.lastIndexOf(fn);
    if (i >= 0) providerDrains.splice(i, 1);
  };
}

/** The same composers' explicit drain (item 503): a block he ran has ended
 *  and the chat on screen is idle, so its output goes now. Explicit: a Stop's
 *  hold on the queue is about what he had queued, not what he just ran. */
const runDrains: Array<() => Promise<void>> = [];
export function registerRunDrain(fn: () => Promise<void>): () => void {
  runDrains.push(fn);
  return () => {
    const i = runDrains.lastIndexOf(fn);
    if (i >= 0) runDrains.splice(i, 1);
  };
}
export async function runDrainNow(): Promise<void> {
  await runDrains.at(-1)?.();
}

/** The chat of the turn on screen, read later (item 503): a New chat's first
 *  reply has a Run before the chat has an id, and the turn learns it. */
export function turnChatRef(): () => string | null {
  const t = fg;
  return () => t?.chat ?? null;
}

/** Whether the turn on screen can go to the background right now (A2):
 *  what lifts the New-chat refusals during a New chat's first turn. */
export function canLeaveRunning(): boolean {
  return !app.busy || (fg !== null && !app.parked && canDetach(app.connection?.engine, fg.chat));
}
