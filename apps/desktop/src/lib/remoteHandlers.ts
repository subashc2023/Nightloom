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
import { MAX_SEATS, MIN_SEATS, type CouncilPrefs, type CouncilRequest } from "./council";
import type { ApprovalDecision, ChatKind, DocumentInput, EditableLayer, ImageInput, LayerChoice, PromptLayer, SessionEvent } from "./types";
import type { SubagentLimits } from "./catalog";

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

/** The chat now showing (a fork's new id) and its log. */
export interface ActReply {
  chat: string | null;
  events: SessionEvent[];
}

/** What the rail shows the phone (blocker 666: no keys, no folders). */
export interface RemoteRail {
  engine: "provider" | "claude-code";
  provider: string;
  model: string;
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

/** A fork is now the open chat: as `sendEdit` does it, without the send. */
function takeFork(res: { events: SessionEvent[]; session: string }): void {
  app.events = res.events;
  switchAside(res.session); // the fork starts with no asides (backlog 203)
  app.activeSessionId = res.session;
  app.error = null;
  app.agentTurn = null;
  void refreshSessions();
}

/** One `ChatAction` on `chat`, as the Mac's own button runs it. */
export async function runAct(chat: string, project: string | null, action: ChatAction): Promise<ActReply> {
  // By id, no open needed: the delete and its undo work on the list, and
  // a budget answer on the running turn's own chat.
  switch (action.op) {
    case "delete": {
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
      const res = await api.editMessage(action.index, action.text, "send");
      takeFork(res);
      await remoteSend(null, action.text);
      return reply();
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
    case "resume_limit":
      resumeAfterLimit();
      return reply();
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

/** The Context page's reads for the open chat. */
async function contextOf(): Promise<{ view: unknown; layers: unknown; pending: unknown }> {
  const [view, layers, pending] = await Promise.all([
    api.contextView(),
    api.promptLayers(),
    api.promptPending().catch(() => null),
  ]);
  return { view, layers, pending };
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

/** `POST /api/chats/{id}/aside`'s body: a question, or a stop. */
export type AsideOp = { op: "ask"; text: string; thread?: number | null } | { op: "stop"; thread: number };

/** The 202's body: the thread asked in and the exchange's number, which
 *  the `aside-event` deltas carry (`null` for a stop). */
export interface AsideStarted {
  chat: string;
  thread: number;
  seq: number | null;
}

/** `aside-event`'s payload on the phone's stream. `delta` is relayed by
 *  `remote.rs` from the backend's `aside-delta`; `done` is told from here
 *  for an exchange the phone asked. */
export type AsideEvent =
  | { kind: "delta"; seq: number; text: string }
  | { kind: "done"; chat: string; thread: number; seq: number; answer: string; error: string | null; cancelled: boolean };

/** One thread as `GET /api/chats/{id}/asides` lists it. */
export interface AsideRow {
  id: number | null;
  key: string | null;
  open: boolean;
  name: string | null;
  quote: string | null;
  closed_at?: number;
  turns: { seq: number | null; question: string; answer: string; error: string | null; cancelled: boolean; asking: boolean }[];
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
function doneOf(chat: string, thread: number, seq: number): AsideEvent {
  const t = asidesOf(chat)
    .find((a) => a.id === thread)
    ?.turns.find((u) => u.seq === seq);
  return {
    kind: "done",
    chat,
    thread,
    seq,
    answer: t ? (t.answer ?? t.partial) : "",
    error: t?.error ?? null,
    cancelled: t ? t.cancelled : true,
  };
}

/**
 * An aside from the phone, through the Mac's own functions: a question
 * with no thread is what the composer's aside does (`askAside`: it follows
 * up the newest answered composer thread, else opens a card); a named
 * thread is its card's reply box (`followUpAside`), or its question box
 * when it is a passage's draft; a stop is the card's × while it asks
 * (`dismissAside`: what had arrived stays, marked). The aside forks the
 * open chat, so an ask opens `chat` first (blocker 665's rule). Answers
 * as soon as the exchange exists; its deltas and its end go out as
 * `aside-event`s.
 */
export async function runAsideOp(
  chat: string,
  project: string | null,
  op: AsideOp,
  tell: (e: AsideEvent) => void = emitAsideEvent,
): Promise<AsideStarted> {
  if (op.op === "stop") {
    const a = asidesOf(chat).find((x) => x.id === op.thread);
    if (!a) throw new Error("that aside is not open on the Mac");
    if (!asideAsking(a)) throw new Error("that aside is not answering");
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
  const end = () => tell(doneOf(here, thread, seq));
  void pending.then(end, end);
  return { chat: here, thread, seq };
}

/** `chat`'s threads for the phone: the open ones (the cards, or a stashed
 *  chat's), then the closed ones kept under Past — read-only, no chat
 *  opened. Drafts are the Mac's question boxes and stay there. */
export function asideRows(chat: string): AsideRow[] {
  const open: AsideRow[] = asidesOf(chat)
    .filter((a) => !a.draft)
    .map((a) => ({
      id: a.id,
      key: null,
      open: true,
      name: a.name ?? null,
      quote: a.quote?.text ?? null,
      turns: a.turns.map((t, i) => ({
        seq: t.seq,
        question: t.question,
        answer: t.answer ?? t.partial,
        error: t.error,
        cancelled: t.cancelled,
        asking: i === a.turns.length - 1 && stillAsking(t),
      })),
    }));
  const past: AsideRow[] = pastOf(chat).map((p) => ({
    id: null,
    key: p.key,
    open: false,
    name: p.thread.name ?? null,
    quote: p.thread.quote?.text ?? null,
    closed_at: p.closedAt,
    turns: p.thread.turns.map((t) => ({ seq: null, question: t.question, answer: t.answer, error: t.error, cancelled: t.cancelled, asking: false })),
  }));
  return [...open, ...past];
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
  /** Wave 3's; accepted and ignored here. */
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
  if (p.new) return remoteNewChat(p.project ?? null, p.text);
  if (p.project && p.project !== app.project?.id && p.chat) {
    await ensureChat(p.chat, p.project);
  }
  const images = p.images ?? [];
  const documents = p.documents ?? [];
  const council = p.council ?? null;
  if (council && app.connection && app.connection.engine !== "claude-code") throw new Error("a council runs on the Claude Code engine — switch the Mac to it first");
  // Through `remoteSend` with its files (1B's patch note 1): the turn is
  // not his typed input, and a busy chat refuses rather than queues.
  return remoteSend(p.chat, p.text, images, documents, council);
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
  await listen<{ chat: string }>("remote-open", (e) => {
    if (e.payload?.chat && !app.busy) void openSession(e.payload.chat);
  });
  await listen("remote-renamed", () => void refreshSessions());
  // Item 246, wave 1: every answered call.
  await listen<Chatted & { action: ChatAction }>("remote-act", (e) => {
    const { id, chat, project, action } = e.payload;
    void answer(id, () => runAct(chat, project ?? null, action));
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
}
