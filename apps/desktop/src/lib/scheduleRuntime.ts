/**
 * The app's side of scheduled send (nightshift backlog 224): what a tick
 * reads and does, from the live state. Kept apart from `schedule.ts` and
 * `scheduled.svelte.ts` so those run in the suite without the backend.
 *
 * Since backlog 535 every step is keyed by the entry's own chat and
 * project, never by "the open chat":
 *
 * - **Where it goes.** `sendInChat` (state.svelte.ts): into the entry's
 *   chat — on screen when that is the chat he is looking at, else off
 *   screen in its own chat and project, the view untouched. ~~`openSession`
 *   and the newest mounted composer's drain~~, which sent into whatever
 *   chat and project were open by then (his College message landed in
 *   another project's chat, then went a second time).
 * - **What it runs on.** The backend keeps the chat's agent spec from the
 *   moment something is scheduled in it (`reserveChatAgent`), so the turn
 *   runs in its own project whatever is open at its time. After a relaunch
 *   that spec is gone: a chat of the open project goes on the rail's, and
 *   a chat of a closed project waits, naming the project, until it is
 *   opened (nightshift blocker 1719).
 * - **When.** The backend's clock (`wake.rs`): `arm` tells it the next
 *   check, and its `wake-due` event runs the tick — a hidden window's own
 *   timers do not.
 *
 * Each mounted composer still registers its drain: the API-key engine runs
 * one turn at a time in the chat on screen, so there a due message joins
 * that chat's queue and the composer sends it.
 */
import { tick } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { app, chatRuns, limitWakeDue, refreshPlanUsage, resumeAfterLimit, sendInChat } from "./state.svelte";
import { enqueueMessage } from "./drafts.svelte";
import * as api from "./api";
import { deliverTo, isLimited, type ChatProject, type Delivery, type Scheduled, type TickDeps } from "./schedule";
import {
  logEveryIntervalTick,
  restoreScheduled,
  runScheduleTick,
  scheduleSend,
  scheduled,
  startScheduleClock,
} from "./scheduled.svelte";
import { RESUME_MARGIN_MS } from "./limit";

const drains: Array<() => Promise<void>> = [];

async function drain(): Promise<void> {
  // A chat just opened mounts its composer on the next flush.
  await tick();
  await drains.at(-1)?.();
}

function log(text: string): void {
  void api.scheduleLog(text).catch(() => {});
}

/** The entry's chat is the chat on screen, in the project that is open. */
function onScreen(s: Scheduled): boolean {
  return s.key === app.activeSessionId && (app.project?.id ?? null) === (s.project?.id ?? null);
}

function projectName(p: ChatProject): string {
  return p.name ? `the project “${p.name}”` : p.id === null ? "the unfiled chats" : "its project";
}

/** Where chat `key` lives, from its log on disk (the backend looks in
 *  every project's chats folder); null when none has it. */
async function homeOf(key: string): Promise<ChatProject | null> {
  const h = await api.chatHome(key);
  return h.found ? { id: h.project, name: h.name } : null;
}

/**
 * Whether the entry's chat can take the message now, and if not the real
 * cause, in the row's words. Asks the backend about that chat and project
 * by id; opens nothing.
 */
export async function readyFor(s: Scheduled): Promise<Delivery> {
  if (!app.connection) return { ok: false, why: "waiting — no engine is connected" };
  if (!s.project)
    return { ok: false, why: "waiting — its chat was not found in any project (Cancel puts the words back in the box)" };
  if (app.connection.engine !== "claude-code") {
    // One turn at a time, in the chat on screen (the API-key engine).
    if (onScreen(s) && !app.busy) return { ok: true };
    return { ok: false, why: "waiting — open this chat: the API-key engine sends only in the chat on screen" };
  }
  try {
    await api.canSendInChat(s.key, s.project.id);
    return { ok: true };
  } catch (e) {
    const why = String(e);
    if (/project is not open/.test(why))
      return { ok: false, why: `waiting — open ${projectName(s.project)} and it sends by itself` };
    if (/log could not be read/.test(why)) {
      // Moved to another project since it was scheduled? Look again.
      let home: ChatProject | null = null;
      try {
        home = await homeOf(s.key);
      } catch {
        // said below
      }
      if (home && home.id !== s.project.id) {
        s.project = home;
        return { ok: false, why: `waiting — its chat moved to ${projectName(home)}; trying there` };
      }
      return { ok: false, why: "waiting — its chat was not found (Cancel puts the words back in the box)" };
    }
    if (/not connected/.test(why)) return { ok: false, why: "waiting — Claude Code is not connected" };
    return { ok: false, why: `waiting — ${why}` };
  }
}

/** Hand the message to its chat. A refusal before anything was sent puts
 *  it back as a waiting scheduled message — or, if the chat has another
 *  by then, at the head of the chat's own queue; never dropped. */
function start(s: Scheduled): void {
  const copy: Scheduled = { ...s, attachments: (s.attachments ?? []).map((a) => ({ ...a })) };
  const refused = (why: string) => {
    log(`refused ${s.key.slice(0, 8)} ${why}`);
    if (!restoreScheduled(copy, `waiting — ${why}`)) enqueueMessage(s.key, copy.text, copy.attachments ?? []);
  };
  if (app.connection?.engine !== "claude-code") {
    // The API-key engine: this chat is on screen and idle (`readyFor`).
    enqueueMessage(
      s.key,
      s.text,
      (s.attachments ?? []).map((a) => ({ ...a })),
    );
    void drain();
    return;
  }
  sendInChat(
    s.key,
    s.project ?? { id: app.project?.id ?? null, name: app.project?.name ?? null },
    s.text,
    copy.attachments ?? [],
    refused,
  );
}

export const scheduleDeps: TickDeps = {
  now: () => Date.now(),
  async limited() {
    // File reads only (no model call): the reading the top bar shows.
    await refreshPlanUsage(false);
    return isLimited(app.planUsage, Date.now());
  },
  deliver: (s) =>
    deliverTo(s, {
      running: (key) => chatRuns(key),
      // With its files and images (backlog 531): the queue persists them
      // as it does a held message's, and the chat's own turn end sends them.
      enqueue: (key, text, attachments) =>
        void enqueueMessage(
          key,
          text,
          attachments.map((a) => ({ ...a })),
        ),
      ready: readyFor,
      start,
    }),
  home: homeOf,
  arm: (atMs) => void api.armWake("scheduled", atMs).catch(() => {}),
  // While its chat is on screen and connected, the backend keeps the spec
  // it would run on now — the one a later send off screen uses.
  keep: (s) => {
    if (s.state !== "waiting" && s.state !== "retrying") return;
    if (onScreen(s) && app.connection?.engine === "claude-code" && !app.connecting)
      void api.reserveChatAgent(s.key, true).catch(() => {});
  },
  log,
};

/** Keep the open chat's spec for the message just scheduled in it. */
export function scheduledHere(key: string): void {
  if (app.connection?.engine === "claude-code") void api.reserveChatAgent(key, true).catch(() => {});
  log(`scheduled ${key.slice(0, 8)} project=${app.project?.id ?? "unfiled"}`);
}

let listening = false;
function listenForWakes(): void {
  if (listening) return;
  listening = true;
  // The backend's clock (backlog 535): the time has come, whatever this
  // page's timers are doing; and the Mac woke.
  void listen<string>("wake-due", (e) => {
    if (e.payload === "scheduled") {
      log(`tick wake-due entries=${Object.keys(scheduled).length}`);
      void runScheduleTick();
    } else if (e.payload === "limit") limitWakeDue();
  }).catch(() => {});
  void listen("system-woke", () => {
    void runScheduleTick();
    limitWakeDue();
  }).catch(() => {});
}

let probed = false;
/**
 * A debug build's timing probe (item 535m, `wake::probe`): a message for a
 * chat that does not exist, due at the launch-relative time the run asked
 * for — its first `kept … waiting` line is the delivery attempt — and a
 * limit resume for a chat that does not exist. A release build is never
 * given a time, so this does nothing there.
 */
async function startProbe(): Promise<void> {
  if (probed) return;
  probed = true;
  let p: { due_ms: number[]; limit_ms: number | null };
  try {
    p = await api.scheduleProbe();
  } catch {
    return;
  }
  for (const due of p.due_ms) {
    logEveryIntervalTick(true);
    // The key's first 8 characters are what the log prints: the due time's
    // last digits, so two probes tell apart.
    const key = `p${String(due).slice(-7)}-probe`;
    const ok = scheduleSend(key, "timing probe", "time", due, false, [], { id: null, name: null });
    log(`probe scheduled ${key.slice(0, 8)} due=${new Date(due).toISOString()} ok=${ok}`);
  }
  if (p.limit_ms !== null && !app.limitPause) {
    app.limitPause = {
      session: `probe-limit-${p.limit_ms}`,
      resetsAtMs: p.limit_ms - RESUME_MARGIN_MS,
      window: "five_hour",
      text: "timing probe",
      subagents: [],
      agents: [],
      hitAtMs: Date.now(),
    };
    resumeAfterLimit();
    log(`probe limit due=${new Date(p.limit_ms).toISOString()} armed=${app.limitResumeAt !== null}`);
  }
}

/** The clock and the backend's wakes, from app start (535f, the review's
 *  535-3): ~~started only when a chat composer mounted~~ — a relaunch onto
 *  a note, the Nightshift page or a web tab ticked nothing and armed no
 *  wake until he opened a chat, so a scheduled message (and the limit
 *  resume) went late again. Idempotent. */
export function startScheduleRuntime(): void {
  listenForWakes();
  startScheduleClock(scheduleDeps);
  void startProbe();
}

/** A composer's drain, newest first (the API-key engine's send); also
 *  starts the clock if app start has not yet. Returns the undo. */
export function registerScheduleDrain(fn: () => Promise<void>): () => void {
  drains.push(fn);
  startScheduleRuntime();
  return () => {
    const i = drains.lastIndexOf(fn);
    if (i >= 0) drains.splice(i, 1);
  };
}
