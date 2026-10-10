/**
 * The phone page's handlers in the Mac's window (item 246, wave 1, agent
 * 1B; before it, nightshift backlog 091 Shape B and 132).
 *
 * Everything the phone does to a chat reaches this window as an event from
 * `remote.rs` and runs through the same state function a click here runs —
 * `saveEdit`, `removeTurn`, `rewindTo`, `deleteSession`, `applyDraft` … —
 * so the transcript, the undo stack, the drafts and the sidebar see a phone
 * action exactly as his own. The window answers each call through
 * `remote_done(id, ok, json)` (the general form of `remote_sent`): the
 * reply, or the sentence the phone is shown as a 409.
 *
 * A chat that is not the open one is opened first — in its own project
 * when that is not the open one (`remote.rs` looks the project up) —
 * refused with a sentence while a turn runs in the chat on screen, unless
 * the action is in that same chat (blocker 665's default). Actions that
 * are refused mid-turn on the Mac are refused mid-turn here too, in words.
 *
 * How a refusal is told from success: the state functions report a
 * refusal as a toast (or `app.error`) and leave the log as it was, so a
 * call that changed no log and raised a toast is a refusal, and the
 * toast's words are the phone's sentence.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { pastOf } from "./asideHistory.svelte";
import {
  app,
  applyDraft,
  askAside,
  asideAsking,
  asidesOf,
  dismissAside,
  followUpAside,
  type Aside,
  type AsideTurn,
  cancelTurn,
  chatKind,
  chooseLayerVersion,
  compactSession,
  continueChat,
  councilFor,
  deleteSession,
  editContextItems,
  forgetProject,
  liveChats,
  openChatSubagents,
  openSession,
  promptLayersOff,
  refreshNotes,
  refreshProjects,
  refreshSessions,
  remoteNewChat,
  remoteSend,
  removeBlock,
  removeTurn,
  renameProject,
  resolveApproval,
  restoreBlock,
  restoreTurn,
  resumeAfterLimit,
  rewindTo,
  runCapture,
  runDream,
  saveEdit,
  saveReplyEdit,
  setCheckpoint,
  setCouncilFor,
  setPromptLayer,
  setPromptLayerText,
  switchAside,
  switchChatKind,
  useEngine,
  useProject,
} from "./state.svelte";
import { EDITABLE_LAYERS } from "./types";
import { MAX_SEATS, MIN_SEATS, type CouncilPrefs, type CouncilRequest } from "./council";
import type { ApprovalDecision, ChatKind, DocumentInput, EditableLayer, ImageInput, LayerChoice, PromptLayer, SessionEvent } from "./types";
import type { SubagentLimits } from "./catalog";
import { modelList } from "./modelList.svelte";

// ---- the wire shapes (design §4; 1A's `remote/api.rs` is the contract) ----

/** One message action, tagged by `op` (serde `tag = "op"`, snake_case). */
export type ChatAction =
  | { op: "edit"; index: number; text: string; mode: "save" | "send"; block?: number | null }
  | { op: "remove"; index: number }
  | { op: "restore"; index: number }
  | { op: "remove_block"; index: number; block: number }
  | { op: "restore_block"; index: number; block: number }
  | { op: "rewind"; to: number }
  | { op: "unrewind"; of: number }
  | { op: "fork"; upto: number }
  | { op: "continue" }
  | { op: "compact" }
  | { op: "delete" }
  | { op: "undelete" }
  | { op: "kind"; kind: string }
  | { op: "resume_limit" }
  | { op: "budget"; decision: string; text?: string | null }
  | { op: "checkpoint"; index: number };

/** The chat now showing (a fork's new id) and its log; `note` when the
 *  action did something other than change the log now (wave 5: a resume
 *  scheduled, an edit's send queued). */
export interface ActReply {
  chat: string | null;
  events: SessionEvent[];
  note?: string;
}

/** What the rail shows the phone (blocker 666: no keys, no folders). */
export interface RemoteRail {
  engine: "provider" | "claude-code";
  provider: string;
  model: string;
  /** The Claude Code picker's models (item 272, `model-list.json`). */
  models: string[];
  effort: string;
  fallback: string;
  thinking: string;
  limits: SubagentLimits;
  approval: boolean;
  ask: boolean;
  plan: boolean;
  subagents_auto: boolean;
  fork_mode: boolean;
  council: CouncilPrefs;
  connected: boolean;
  connecting: boolean;
  /** A change made while a turn runs waits for it (backlog 214). */
  deferred: boolean;
  error: string | null;
}

/** A rail change from the phone; absent fields are left as they are. */
export interface RailPatch {
  engine?: "provider" | "claude-code";
  model?: string;
  effort?: string;
  fallback?: string;
  thinking?: string;
  limits?: Partial<SubagentLimits>;
  ask?: boolean;
  plan?: boolean;
  subagents_auto?: boolean;
  fork_mode?: boolean;
  council?: CouncilPrefs;
}

export type LayerChange =
  | { off: PromptLayer[] }
  | { kind: EditableLayer; text: string | null }
  | { kind: PromptLayer; choice: LayerChoice };

export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

// ---- answering ----

/** The window's answer to call `id`. Never throws: a window that cannot
 *  reach Rust leaves the phone to its timeout. */
export function done(id: number, ok: boolean, json: unknown): void {
  void invoke("remote_done", { id, ok, json: json ?? null }).catch(() => {});
}

/** Run `work` and answer `id` with its value, or with its error's words. */
export async function answer(id: number, work: () => Promise<unknown>): Promise<void> {
  try {
    done(id, true, await work());
  } catch (e) {
    done(id, false, sentence(e));
  }
}

function sentence(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^Error: /, "");
}

const newestToast = (): number => app.toasts.at(-1)?.id ?? 0;

/** The words of the first toast raised since `mark`, if any. */
function toastSince(mark: number): string | null {
  return app.toasts.find((t) => t.id > mark)?.text ?? null;
}

/**
 * Run a state function that reports a refusal as a toast or `app.error`
 * and leaves the log alone. `false` from it, or no change to the log, is a
 * refusal; its toast (or the error) is the sentence.
 */
async function attempt(what: string, run: () => Promise<unknown>, changed?: () => boolean): Promise<void> {
  const before = app.events;
  const error = app.error;
  const mark = newestToast();
  const out = await run();
  const ok = out !== false && (changed ? changed() : app.events !== before);
  if (!ok) {
    const why = toastSince(mark) ?? (app.error !== error ? app.error : null);
    throw new Error(why ?? `the Mac did not ${what}`);
  }
}

const RUNNING_HERE = "this chat is running a turn on the Mac — try again when it ends";

/** Said when the phone stopped waiting before the window started (132 (d)). */
export const GAVE_UP = "the phone stopped waiting before the Mac began, so nothing was started — send it again";

/**
 * Just before a turn starts for the phone's call `id`: is the phone still
 * waiting (backlog 132 (d), `remote_claim`)? After its deadline it was
 * told the Mac did not answer and may send again — a turn started now
 * would be a second one. No id (a call from before wave 5), or a backend
 * without the command, keeps today's behaviour: yes.
 */
export async function claim(id: number | undefined): Promise<boolean> {
  if (id == null) return true;
  try {
    return (await invoke<boolean>("remote_claim", { id })) !== false;
  } catch {
    return true;
  }
}

async function mustClaim(id: number | undefined): Promise<void> {
  if (!(await claim(id))) throw new Error(GAVE_UP);
}

/** A clock time for him: 12-hour, "3:42 PM". */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Make `chat` the open chat, in `project` when the chat lives there
 * (blocker 665's default: the window follows the phone). Refused while a
 * turn runs in the chat on screen: leaving it is not the phone's call.
 */
export async function ensureChat(chat: string, project: string | null): Promise<void> {
  const here = chat === app.activeSessionId && (!project || project === app.project?.id);
  if (here) return;
  if (app.busy) throw new Error("the Mac is running a turn in the chat on its screen — try again when it ends, or act in that chat");
  if (project && project !== app.project?.id) {
    await useProject(project);
    if (app.project?.id !== project) throw new Error("the Mac could not open that chat's project");
  }
  await openSession(chat);
  if (app.activeSessionId !== chat) {
    throw new Error(app.error ? `the Mac could not open that chat: ${app.error}` : "the Mac could not open that chat");
  }
}

const reply = (): ActReply => ({ chat: app.activeSessionId, events: app.events });
/** The reply for `chat` without opening it: its log when it is open. */
const replyOf = (chat: string): ActReply => (chat === app.activeSessionId ? reply() : { chat, events: [] });

/** A fork is now the open chat: as `sendEdit` does it, without the send. */
function takeFork(res: { events: SessionEvent[]; session: string }): void {
  app.events = res.events;
  switchAside(res.session); // the fork starts with no asides (backlog 203)
  app.activeSessionId = res.session;
  app.error = null;
  app.agentTurn = null;
  void refreshSessions();
}

/** One `ChatAction` on `chat`, as the Mac's own button runs it. `id` is
 *  the phone's call, claimed (132 (d)) before anything that starts a turn
 *  or cannot be taken back by the phone's retry: a fork, a delete, a send. */
export async function runAct(chat: string, project: string | null, action: ChatAction, id?: number): Promise<ActReply> {
  // By id, no open needed: the delete and its undo work on the list, and
  // a budget answer on the running turn's own chat.
  switch (action.op) {
    case "delete": {
      await mustClaim(id);
      const mark = newestToast();
      await deleteSession(chat);
      const why = toastSince(mark);
      if (why) throw new Error(why);
      return { chat, events: [] };
    }
    case "undelete": {
      const full = await api.restoreSession(chat);
      await refreshSessions();
      return { chat: full, events: [] };
    }
    case "budget": {
      const d = action.decision;
      if (d !== "continue" && d !== "stop" && d !== "wrap") throw new Error(`no budget answer ${d}`);
      await api.budgetOverride(chat, d, action.text ?? undefined);
      return chat === app.activeSessionId ? reply() : { chat, events: [] };
    }
    case "resume_limit": {
      // 132 (b): refused when nothing in this chat is paused, and never
      // toggled off from the phone (a second press on the Mac cancels).
      const p = app.limitPause;
      if (!p || p.session !== chat) throw new Error("nothing in this chat is paused by the usage limit");
      if (app.limitResumeAt != null) {
        return { ...replyOf(chat), note: `already scheduled for ${clock(app.limitResumeAt)}` };
      }
    }
  }
  await ensureChat(chat, project);
  // Everything below is refused mid-turn on the Mac (the running turn
  // would record its reply after the change landed); the resume is the
  // one that belongs to a paused turn.
  if (app.busy && action.op !== "resume_limit") throw new Error(RUNNING_HERE);
  switch (action.op) {
    case "edit": {
      if (action.block != null) {
        if (action.mode === "send") throw new Error("a reply's block is saved, not sent");
        await attempt("save the edit", () => saveReplyEdit(action.index, [{ block: action.block!, text: action.text }]));
        return reply();
      }
      if (action.mode === "save") {
        await attempt("save the edit", () => saveEdit(action.index, action.text));
        return reply();
      }
      // Edit and send: fork before the turn, open the fork, send into it —
      // `sendEdit`'s steps, with the send the phone's (untyped) one so the
      // answer comes back now and not at the turn's end.
      if (!app.connection) throw new Error("no engine is connected on the Mac — connect one there first");
      await mustClaim(id);
      const res = await api.editMessage(action.index, action.text, "send");
      takeFork(res);
      // 132 (c): a queued send is said, so the phone draws no live turn.
      const out = await remoteSend(null, action.text);
      return out === "queued" ? { ...reply(), note: "queued — it goes when the Mac's running turn ends" } : reply();
    }
    case "remove":
      await attempt("remove it", () => removeTurn(action.index));
      return reply();
    case "restore":
      await attempt("restore it", () => restoreTurn(action.index));
      return reply();
    case "remove_block":
      await attempt("remove it", () => removeBlock(action.index, action.block, false));
      return reply();
    case "restore_block":
      await attempt("restore it", () => restoreBlock(action.index, action.block));
      return reply();
    case "rewind":
      await attempt("rewind", () => rewindTo(action.to));
      return reply();
    case "unrewind":
      app.events = await api.unrewind(action.of);
      return reply();
    case "fork":
      await mustClaim(id);
      takeFork(await api.forkSession(action.upto));
      return reply();
    case "continue": {
      const from = app.activeSessionId;
      await attempt("continue the chat", () => continueChat(), () => app.activeSessionId !== from);
      return reply();
    }
    case "compact":
      if (!app.connection) throw new Error("no engine is connected on the Mac — connect one there first");
      await attempt("compact the chat", () => compactSession());
      return reply();
    case "kind": {
      const kind = action.kind as ChatKind;
      if (kind !== "build" && kind !== "chat") throw new Error(`no chat kind ${action.kind}`);
      if (chatKind(app.events) === kind) return reply();
      if (app.connecting) throw new Error("the Mac is connecting — try again in a moment");
      await attempt("switch the chat's kind", () => switchChatKind(kind), () => chatKind(app.events) === kind);
      return reply();
    }
    case "resume_limit": {
      const p = app.limitPause;
      const mark = newestToast();
      resumeAfterLimit();
      if (app.limitResumeAt != null) {
        return { ...reply(), note: `scheduled for ${clock(app.limitResumeAt)}, 30 s after the window resets` };
      }
      // Sent at once — or refused by the Mac with a toast, the pause kept.
      if (app.limitPause === p && p) throw new Error(toastSince(mark) ?? "the Mac did not resume the chat");
      return { ...reply(), note: "resumed" };
    }
    case "checkpoint": {
      const mark = newestToast();
      const before = app.checkpoint;
      await setCheckpoint(action.index);
      if (app.checkpoint === before) throw new Error(toastSince(mark) ?? "the Mac did not set the checkpoint");
      return reply();
    }
  }
  throw new Error(`no chat action ${(action as { op: string }).op}`);
}

/** The Context page's reads for the open chat. `layers.sources` (wave 2,
 *  2B's patch note) is each editable layer's file text — what the Mac's
 *  editor opens with when the chat has no text of its own — so the
 *  phone's editor never seeds from the segment as sent, which is wrapped
 *  and would be saved back double-wrapped. Inside `layers` because the
 *  service passes that through as JSON; a top-level field would drop. */
async function contextOf(): Promise<{ view: unknown; layers: unknown; pending: unknown }> {
  const [view, layers, pending, ...files] = await Promise.all([
    api.contextView(),
    api.promptLayers(),
    api.promptPending().catch(() => null),
    ...EDITABLE_LAYERS.map((k) => api.promptLayerFile(k).catch(() => null)),
  ]);
  const sources = Object.fromEntries(EDITABLE_LAYERS.map((k, i) => [k, files[i] ?? null]));
  return { view, layers: { ...(layers as object), sources }, pending };
}

export async function runContext(chat: string, project: string | null): Promise<unknown> {
  await ensureChat(chat, project);
  return contextOf();
}

export async function runEditContext(chat: string, project: string | null, targets: number[], remove: boolean): Promise<unknown> {
  await ensureChat(chat, project);
  if (app.busy) throw new Error(RUNNING_HERE);
  const mark = newestToast();
  const res = await editContextItems(targets, remove);
  if (!res) throw new Error(toastSince(mark) ?? "the Mac did not change the context");
  return res.view;
}

export async function runLayers(chat: string, project: string | null, change: LayerChange): Promise<unknown> {
  await ensureChat(chat, project);
  if (app.busy || app.connecting) throw new Error(RUNNING_HERE);
  if ("off" in change) {
    // One switch at a time, as the popover flips them.
    const want = new Set(change.off);
    const now = new Set(promptLayersOff(app.events));
    for (const l of new Set([...want, ...now])) {
      if (want.has(l) !== now.has(l)) await setPromptLayer(l, !want.has(l));
    }
  } else if ("choice" in change) {
    await chooseLayerVersion(change.kind, change.choice);
  } else {
    const mark = newestToast();
    if (!(await setPromptLayerText(change.kind, change.text))) {
      throw new Error(toastSince(mark) ?? "the Mac did not change the layer");
    }
  }
  return contextOf();
}

// ---- the rail ----

export function railOf(): RemoteRail {
  const d = app.draft;
  return {
    engine: d.engine,
    provider: d.provider,
    model: d.engine === "claude-code" ? d.agentModel : d.model,
    models: [...modelList.models],
    effort: d.agentEffort,
    fallback: d.agentFallback,
    thinking: d.thinkingMode,
    limits: d.agentLimits,
    approval: d.approval,
    ask: d.agentAsk,
    plan: d.agentPlan,
    subagents_auto: d.agentSubagentsAuto,
    fork_mode: d.agentForkMode,
    council: councilFor(app.activeSessionId),
    connected: app.connection !== null,
    connecting: app.connecting,
    deferred: app.busy,
    error: app.connectError,
  };
}

/** Check a patch before any of it lands, so a bad field changes nothing. */
export function checkRail(p: RailPatch): void {
  if (p.engine !== undefined && p.engine !== "claude-code" && p.engine !== "provider") throw new Error(`no engine ${p.engine}`);
  if (p.effort !== undefined && !(EFFORTS as readonly string[]).includes(p.effort)) throw new Error(`no effort level ${p.effort}`);
  if (p.model !== undefined && !p.model.trim()) throw new Error("a model must be named");
  if (p.council !== undefined) {
    const n = p.council.seats?.length ?? 0;
    if (n < MIN_SEATS || n > MAX_SEATS) throw new Error(`a council has ${MIN_SEATS} to ${MAX_SEATS} seats`);
  }
  if (p.limits) {
    for (const [k, v] of Object.entries(p.limits)) {
      if (k === "off" || k === "model") continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`the limit ${k} must be a number from 0`);
    }
  }
}

/**
 * Merge `p` into the rail and connect once, as the Mac's rail does — a
 * change made while a turn runs is kept and connected when it ends
 * (`applyDraft` defers it, backlog 214), and `deferred` says so.
 */
export async function runSetRail(p: RailPatch): Promise<RemoteRail> {
  checkRail(p);
  if (p.engine !== undefined && p.engine !== app.draft.engine) await useEngine(p.engine);
  const d = app.draft;
  let touched = false;
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K] | undefined) => {
    if (v === undefined || d[k] === v) return;
    d[k] = v;
    touched = true;
  };
  if (p.model !== undefined) {
    if (d.engine === "claude-code") set("agentModel", p.model.trim());
    else set("model", p.model.trim());
  }
  set("agentEffort", p.effort);
  set("agentFallback", p.fallback);
  set("thinkingMode", p.thinking);
  set("agentAsk", p.plan === true ? true : p.ask);
  set("agentPlan", p.ask === false ? false : p.plan);
  set("agentSubagentsAuto", p.subagents_auto);
  set("agentForkMode", p.fork_mode);
  if (p.limits) {
    const next = { ...d.agentLimits, ...p.limits, off: { ...d.agentLimits.off, ...(p.limits.off ?? {}) } } as SubagentLimits;
    if (JSON.stringify(next) !== JSON.stringify(d.agentLimits)) {
      d.agentLimits = next;
      touched = true;
    }
  }
  if (p.council) setCouncilFor(app.activeSessionId, { seats: p.council.seats, mode: p.council.mode });
  if (touched) await applyDraft();
  return railOf();
}

// ---- running, projects ----

export function runningNow(): unknown {
  return {
    chats: liveChats().map((c) => ({
      chat: c.session,
      title: c.name,
      on_screen: c.onScreen,
      since: c.startedAt,
      waiting: c.waiting,
    })),
    subagents: openChatSubagents(),
    budget: app.turnBudget,
    // Wave 2 (2A): the service's `Running` has these slots.
    asides: asidesRunning(),
    dream: app.dreaming ? { running: true } : null,
    capture: app.capturing ? { running: true } : null,
  };
}

// ---- dream and capture (wave 5) ----

export type PassKind = "dream" | "capture";

/** A `pass-event` for the phone's stream: started, then done or failed
 *  with the toast the Mac showed. */
export interface PassEvent {
  kind: PassKind;
  state: "started" | "done" | "failed";
  text: string | null;
}

/**
 * The Mac's Dream or Capture button, from the phone: refused while either
 * runs (they share one lock), else started — the answer comes at once —
 * and its end goes out as a `pass-event` with the Mac's own toast.
 */
export async function runPass(kind: PassKind): Promise<{ status: "started" }> {
  if (kind !== "dream" && kind !== "capture") throw new Error(`no pass ${String(kind)}`);
  if (app.dreaming) throw new Error("a dream is already running");
  if (app.capturing) throw new Error("a capture is already running");
  const mark = newestToast();
  const run = kind === "dream" ? runDream() : runCapture();
  void emit("pass-event", { kind, state: "started", text: null } satisfies PassEvent).catch(() => {});
  void run.then(() => {
    const text = toastSince(mark);
    const failed = !!text && /^(dream|capture) failed/.test(text);
    void emit("pass-event", { kind, state: failed ? "failed" : "done", text } satisfies PassEvent).catch(() => {});
  });
  return { status: "started" };
}

// ---- what the window says of itself (wave 5) ----

/** `/api/state`'s `limit_pause` (the service's `LimitPause`, Unix seconds). */
export interface LimitPauseWire {
  chat: string | null;
  resets_at: number | null;
  window: string | null;
  text: string;
  subagents: string[];
  resume_at: number | null;
}

/** The window's palette and pause as `remote.rs` keeps them. */
export function windowState(): { palette: string | null; limit_pause: LimitPauseWire | null } {
  const p = app.limitPause;
  const secs = (ms: number | null | undefined) => (ms == null ? null : Math.floor(ms / 1000));
  return {
    palette: app.palette ?? null,
    limit_pause: p
      ? {
          chat: p.session,
          resets_at: secs(p.resetsAtMs),
          window: p.window,
          text: p.text,
          subagents: p.subagents,
          resume_at: secs(app.limitResumeAt),
        }
      : null,
  };
}

let lastWindowState = "";
let windowFeed: ReturnType<typeof setInterval> | null = null;

/** Tell `remote.rs` the palette and the pause when either changed. */
export function sendWindowState(): void {
  const now = JSON.stringify(windowState());
  if (now === lastWindowState) return;
  lastWindowState = now;
  void emit("remote-window-state", JSON.parse(now)).catch(() => {
    lastWindowState = "";
  });
}

/** Every second, cheaply: a JSON compare, an event only on a change. */
export function startWindowStateFeed(everyMs = 1000): void {
  if (windowFeed !== null) return;
  lastWindowState = "";
  sendWindowState();
  windowFeed = setInterval(sendWindowState, everyMs);
}

export function stopWindowStateFeed(): void {
  if (windowFeed !== null) clearInterval(windowFeed);
  windowFeed = null;
  lastWindowState = "";
}

/** `pid` is the project's id (`id` is the call's, on the wire). */
export type ProjectOp =
  | { op: "new"; name: string; instructions?: string | null }
  | { op: "open"; pid: string }
  | { op: "rename"; pid: string; name: string }
  | { op: "forget"; pid: string };

/** A project change from the phone, through the Mac's own functions. The
 *  new-project form's draft on the Mac is not touched. */
export async function runProject(p: ProjectOp): Promise<unknown> {
  const mark = newestToast();
  switch (p.op) {
    case "new": {
      if (!p.name.trim()) throw new Error("a project needs a name");
      const project = await api.newProject(p.name.trim(), null, p.instructions ?? "");
      await refreshProjects();
      return project;
    }
    case "open":
      await useProject(p.pid);
      if (app.project?.id !== p.pid) throw new Error(toastSince(mark) ?? "the Mac could not open that project");
      return app.project;
    case "rename": {
      if (!p.name.trim()) throw new Error("a project needs a name");
      await renameProject(p.pid, p.name.trim());
      const why = toastSince(mark);
      if (why) throw new Error(why);
      return app.projects.find((x) => x.id === p.pid) ?? null;
    }
    case "forget": {
      await forgetProject(p.pid);
      if (app.projects.some((x) => x.id === p.pid)) throw new Error(toastSince(mark) ?? "the Mac did not forget that project");
      return null;
    }
  }
}

// ---- asides (item 246, wave 2, 2A) ----
// The wire shapes are 2C's (`246w2-patch-2c-to-2a.md`), with the thread
// added so the phone can follow up in one: `246w2-patch-p2a-to-p2c.md`.

/** `remote-aside`'s body: a question (`POST …/aside`), or a stop of the
 *  exchange numbered `cancel` (`POST …/aside/cancel {seq}`). */
export type AsideOp = { text: string; thread?: number | null } | { cancel: number };

/** The 202's body: the chat, the thread asked in, and the exchange's
 *  number, which its `aside-event`s carry (`null` for a stop). */
export interface AsideStarted {
  chat: string;
  thread: number;
  seq: number | null;
}

/** `aside-event`'s payload on the phone's stream. `delta` is relayed by
 *  `remote.rs` from the backend's `aside-delta` (no `chat`: the backend
 *  does not know it); `done` and `error` are told from here when an
 *  exchange the phone asked ends. */
export type AsideEvent =
  | { kind: "delta"; seq: number; text: string }
  | { kind: "done"; chat: string; thread: number; seq: number; answer: string; is_error: false; cost_usd: null }
  | { kind: "error"; chat: string; thread: number; seq: number; error: string; answer: string; cancelled: boolean };

/** One exchange as `GET /api/chats/{id}/asides` lists it, newest last:
 *  the closed threads' (Past) first, then the open cards'. */
export interface AsideRow {
  thread: number | null;
  key: string | null;
  open: boolean;
  name: string | null;
  quote: string | null;
  seq: number | null;
  question: string;
  answer: string;
  error: string | null;
  cancelled: boolean;
  asking: boolean;
  /** When a Past thread was closed (ISO); null for an open card. */
  at: string | null;
}

const stillAsking = (t: AsideTurn): boolean => t.answer === null && t.error === null && !t.cancelled;

function newestSeq(list: readonly Aside[]): number {
  let n = 0;
  for (const a of list) for (const t of a.turns) n = Math.max(n, t.seq);
  return n;
}

/** The exchange a call just opened: the one numbered past `before`. */
function openedSince(list: readonly Aside[], before: number): { thread: Aside; turn: AsideTurn } | null {
  for (const thread of list) {
    for (const turn of thread.turns) if (turn.seq > before) return { thread, turn };
  }
  return null;
}

function emitAsideEvent(e: AsideEvent): void {
  void emit("aside-event", e).catch(() => {});
}

/** How exchange `seq` of `chat`'s thread `thread` ended, as the card shows
 *  it; a thread closed meanwhile reads as cancelled with nothing. */
function endOf(chat: string, thread: number, seq: number): AsideEvent {
  const t = asidesOf(chat)
    .find((a) => a.id === thread)
    ?.turns.find((u) => u.seq === seq);
  const answer = t ? (t.answer ?? t.partial) : "";
  if (t && !t.cancelled && t.error === null) {
    return { kind: "done", chat, thread, seq, answer, is_error: false, cost_usd: null };
  }
  const cancelled = !t || t.cancelled;
  return { kind: "error", chat, thread, seq, error: t?.error ?? "the aside was cancelled", answer, cancelled };
}

/**
 * An aside from the phone, through the Mac's own functions: a question
 * with no thread is what the composer's aside does (`askAside`: it follows
 * up the newest answered composer thread, else opens a card); a named
 * thread is its card's reply box (`followUpAside`), or its question box
 * when it is a passage's draft; a cancel is the card's × while it asks
 * (`dismissAside`: what had arrived stays, marked). The aside forks the
 * open chat, so a question opens `chat` first (blocker 665's rule); a
 * cancel opens nothing. Answers as soon as the exchange exists; its
 * deltas and its end go out as `aside-event`s.
 */
export async function runAsideOp(
  chat: string,
  project: string | null,
  op: AsideOp,
  tell: (e: AsideEvent) => void = emitAsideEvent,
): Promise<AsideStarted> {
  if ("cancel" in op) {
    const a = asidesOf(chat).find((x) => x.turns.some((t) => t.seq === op.cancel));
    if (!a) throw new Error("that aside is not open on the Mac");
    const t = asideAsking(a);
    if (!t || t.seq !== op.cancel) throw new Error("that aside is not answering");
    dismissAside(a);
    return { chat, thread: a.id, seq: null };
  }
  const text = (op.text ?? "").trim();
  if (!text) throw new Error("an aside needs a question");
  await ensureChat(chat, project);
  if (app.connection?.engine !== "claude-code") {
    throw new Error("an aside runs on the Claude Code engine — switch the Mac to it first");
  }
  const here = app.activeSessionId ?? chat;
  const before = newestSeq(app.asides);
  let pending: Promise<void>;
  if (op.thread !== undefined && op.thread !== null) {
    const a = app.asides.find((x) => x.id === op.thread);
    if (!a) throw new Error("that aside is not open on the Mac");
    if (asideAsking(a)) throw new Error("that aside is still answering — wait for it, or stop it");
    pending = a.draft ? askAside(text, a.quote, a) : followUpAside(text, a);
  } else {
    pending = askAside(text);
  }
  // Each of those numbers its exchange before its first wait.
  const opened = openedSince(app.asides, before);
  if (!opened) {
    await pending;
    throw new Error("the Mac did not ask the aside");
  }
  const thread = opened.thread.id;
  const seq = opened.turn.seq;
  const end = () => tell(endOf(here, thread, seq));
  void pending.then(end, end);
  return { chat: here, thread, seq };
}

/** `chat`'s aside exchanges for the phone, newest last: the closed
 *  threads' under Past, then the open cards' (or a stashed chat's) —
 *  read-only, no chat opened. Drafts are the Mac's question boxes and
 *  stay there. */
export function asideRows(chat: string): AsideRow[] {
  const past: AsideRow[] = [...pastOf(chat)]
    .sort((x, y) => x.closedAt - y.closedAt)
    .flatMap((p) =>
      p.thread.turns.map((t) => ({
        thread: null,
        key: p.key,
        open: false,
        name: p.thread.name ?? null,
        quote: p.thread.quote?.text ?? null,
        seq: null,
        question: t.question,
        answer: t.answer,
        error: t.error,
        cancelled: t.cancelled,
        asking: false,
        at: new Date(p.closedAt).toISOString(),
      })),
    );
  const open: AsideRow[] = asidesOf(chat)
    .filter((a) => !a.draft)
    .flatMap((a) =>
      a.turns.map((t, i) => ({
        thread: a.id,
        key: null,
        open: true,
        name: a.name ?? null,
        quote: a.quote?.text ?? null,
        seq: t.seq,
        question: t.question,
        answer: t.answer ?? t.partial,
        error: t.error,
        cancelled: t.cancelled,
        asking: i === a.turns.length - 1 && stillAsking(t),
        at: null,
      })),
    );
  return [...past, ...open];
}

/** Every exchange still asking, in any chat this window holds. */
function asidesRunning(): { chat: string; thread: number; seq: number; question: string }[] {
  const ids = new Set<string>(app.sessions.map((s) => s.id));
  if (app.activeSessionId) ids.add(app.activeSessionId);
  const out: { chat: string; thread: number; seq: number; question: string }[] = [];
  for (const chat of ids) {
    for (const a of asidesOf(chat)) {
      const t = asideAsking(a);
      if (t) out.push({ chat, thread: a.id, seq: t.seq, question: t.question });
    }
  }
  return out;
}

// ---- sending ----

export interface RemoteSendPayload {
  id: number;
  chat: string | null;
  text: string;
  new?: boolean;
  project?: string | null;
  images?: ImageInput[];
  documents?: DocumentInput[];
  council?: CouncilRequest | null;
  /** Said aloud in voice mode (wave 3): the turn runs "for the ear". */
  spoken?: boolean;
}

/**
 * A message from the phone. Text alone goes through `remoteSend` /
 * `remoteNewChat` as before; `project` opens that project first; a
 * message with a photo, a document or a council goes through `send` with
 * them, as the composer sends them — refused rather than queued while the
 * chat runs a turn, since the Mac's queue holds text (the phone keeps it).
 */
export async function runSend(p: RemoteSendPayload): Promise<"sent" | "queued"> {
  if (p.new) {
    await mustClaim(p.id);
    return remoteNewChat(p.project ?? null, p.text);
  }
  if (p.project && p.project !== app.project?.id && p.chat) {
    await ensureChat(p.chat, p.project);
  }
  // The chat is open: still wanted? (132 (d) — a late window starts no
  // second turn the phone's retry would also start.)
  await mustClaim(p.id);
  const images = p.images ?? [];
  const documents = p.documents ?? [];
  const council = p.council ?? null;
  if (council && app.connection && app.connection.engine !== "claude-code") throw new Error("a council runs on the Claude Code engine — switch the Mac to it first");
  // Through `remoteSend` with its files (1B's patch note 1): the turn is
  // not his typed input, and a busy chat refuses rather than queues.
  return remoteSend(p.chat, p.text, images, documents, council, p.spoken === true);
}

// ---- the listeners ----

type Chatted = { id: number; chat: string; project?: string | null };

/** Register every phone handler on the window. Called once from `init`. */
export async function installRemoteHandlers(): Promise<void> {
  // A message: what became of it goes back through `remote_sent` (132).
  await listen<RemoteSendPayload>("remote-send", (e) => {
    const { id } = e.payload;
    runSend(e.payload).then(
      (outcome) => void api.remoteSent(id, outcome === "queued", null).catch(() => {}),
      (err: unknown) => void api.remoteSent(id, false, sentence(err)).catch(() => {}),
    );
  });
  await listen<{
    id: string;
    name: string;
    decision: ApprovalDecision;
    reason?: string | null;
    answer?: unknown;
    then?: "ask" | "auto" | null;
  }>("remote-approve", (e) => {
    const { id, name, decision, reason, answer: ans, then } = e.payload;
    void resolveApproval(id, name, decision, reason ?? undefined, ans ?? undefined, then ?? undefined);
  });
  // The phone names the chat it shows (backlog 159, A3); `null` is the
  // chat on screen.
  await listen<{ chat?: string | null } | null>("remote-cancel", (e) => void cancelTurn(e.payload?.chat ?? null));
  // 132 (a): the open is answered — opened, or why not (blocker 665's
  // rule: never away from a chat running on the Mac's screen).
  await listen<Chatted>("remote-open", (e) => {
    const { id, chat, project } = e.payload;
    void answer(id, async () => {
      await ensureChat(chat, project ?? null);
      return { chat: app.activeSessionId };
    });
  });
  await listen("remote-renamed", () => void refreshSessions());
  // Item 246, wave 1: every answered call.
  await listen<Chatted & { action: ChatAction }>("remote-act", (e) => {
    const { id, chat, project, action } = e.payload;
    void answer(id, () => runAct(chat, project ?? null, action, id));
  });
  await listen<Chatted>("remote-context", (e) => {
    const { id, chat, project } = e.payload;
    void answer(id, () => runContext(chat, project ?? null));
  });
  await listen<Chatted & { targets: number[]; remove: boolean }>("remote-edit-context", (e) => {
    const { id, chat, project, targets, remove } = e.payload;
    void answer(id, () => runEditContext(chat, project ?? null, targets, remove));
  });
  await listen<Chatted & { change: LayerChange }>("remote-layers", (e) => {
    const { id, chat, project, change } = e.payload;
    void answer(id, () => runLayers(chat, project ?? null, change));
  });
  await listen<{ id: number; patch: RailPatch | null }>("remote-rail", (e) => {
    const { id, patch } = e.payload;
    void answer(id, async () => (patch ? runSetRail(patch) : railOf()));
  });
  await listen<{ id: number }>("remote-running", (e) => void answer(e.payload.id, async () => runningNow()));
  await listen<ProjectOp & { id: number }>("remote-project", (e) => {
    const { id, ...op } = e.payload;
    void answer(id, () => runProject(op as ProjectOp));
  });
  // A note written or deleted from the phone: the lists re-read. An open
  // note here keeps its editor and its draft.
  await listen("remote-notes-changed", () => void refreshNotes());
  // Wave 2 (2A): an aside asked or stopped, and a chat's threads read.
  await listen<Chatted & { aside: AsideOp }>("remote-aside", (e) => {
    const { id, chat, project, aside } = e.payload;
    void answer(id, () => runAsideOp(chat, project ?? null, aside));
  });
  await listen<{ id: number; chat: string }>("remote-asides", (e) => {
    const { id, chat } = e.payload;
    void answer(id, async () => asideRows(chat));
  });
  // Wave 5: Dream and Capture from the phone; the palette and the pause
  // for `/api/state`.
  await listen<{ id: number; kind: PassKind }>("remote-pass", (e) => {
    const { id, kind } = e.payload;
    void answer(id, () => runPass(kind));
  });
  startWindowStateFeed();
}
