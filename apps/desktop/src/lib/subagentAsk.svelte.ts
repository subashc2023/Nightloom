/**
 * Talking to a subagent directly (nightshift backlog 157) — the stateful
 * half: the notes held for a running agent, the draft under its tab, the
 * chat each agent was adopted into, and the send.
 *
 * Why a new chat (measured, `subagentAsk.ts`): the CLI resumes no
 * subagent, so the first question carries the agent's run into a chat of
 * its own ("↳ agent: …", same project), and every later question is an
 * ordinary turn there. The parent chat is never written to.
 *
 * ~~A note typed under a *running* agent is held (089's shape) — the CLI has
 * no way into a running child~~ — since backlog 295 (2026-10-04) a note
 * under a running agent is **steered**: queued in the chat's directory by
 * the agent's id (`api.steerSubagent`), and the brief hook hands it to that
 * agent with its next tool call, once, as `additionalContext` (measured on
 * CLI 2.1.289: the child acted on it in its next step). The window polls
 * the chat's record (`syncSteers`) and marks the note delivered, with the
 * time and the call it rode on. A note the agent never reached — it made
 * no further call, or a Stop ended it — is taken back from the queue and
 * goes the old way: held, then the first question once the agent has
 * finished and nothing is running in the chat on screen (`deliverDue`,
 * which `App.svelte` calls whenever that changes). A note that cannot be
 * queued at all (no chat id yet, no agent id) is held from the start.
 *
 * Kept in `localStorage` (per window, best-effort, every access guarded):
 * a held note and a half-typed question are his words, and a reload must
 * not drop them (practices §7). A note leaves the store only when it is
 * sent or he takes it back into the box.
 */
import {
  addToast,
  app,
  newSession,
  openSession,
  refreshSessions,
  renameSession,
  send,
  subagentRunning,
  type SubagentRow,
} from "./state.svelte";
import { adoptedChatOf, adoptedPrompt, adoptedTitle, agentKey, carryOfSubagent, splitAdopted } from "./subagentAsk";
import * as api from "./api";

const STORE_KEY = "nightloom.subagentAsk.v1";

/** A note sent into a running agent (backlog 295). Kept after delivery,
 *  so its tab marks where and when it arrived. */
export interface Steered {
  id: string;
  text: string;
  /** When he sent it (ISO). */
  at: string;
  /** The chat whose directory holds the queue, and the agent's id there. */
  session: string;
  agentId: string;
  tellMain: boolean;
  /** Set once the hook handed it over (ISO), with the call it rode on. */
  deliveredAt?: string;
  tool?: string;
  toolUseId?: string;
}

interface Stored {
  notes: Record<string, { text: string; at: string }[]>;
  drafts: Record<string, string>;
  adopted: Record<string, string>;
  steered: Record<string, Steered[]>;
  /** "Tell the main chat too" under a running agent's box (backlog 295). */
  tellMain: boolean;
}

function load(): Stored {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      return {
        notes: p.notes ?? {},
        drafts: p.drafts ?? {},
        adopted: p.adopted ?? {},
        steered: p.steered ?? {},
        tellMain: p.tellMain ?? false,
      };
    }
  } catch {
    // unreadable: start empty
  }
  return { notes: {}, drafts: {}, adopted: {}, steered: {}, tellMain: false };
}

export const agentAsk = $state<Stored>(load());

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(agentAsk));
  } catch {
    // storage refused: the state still holds it for this run
  }
}

export function keyOf(row: Pick<SubagentRow, "tool_use_id">): string {
  return agentKey(row.tool_use_id);
}

/** The chat this agent was adopted into: the window's record, else the
 *  chat list's first messages (a record lost with the storage). */
export function adoptedChat(row: Pick<SubagentRow, "session" | "tool_use_id">): string | null {
  return agentAsk.adopted[keyOf(row)] ?? adoptedChatOf(app.sessions, row.tool_use_id);
}

export function setAgentDraft(key: string, text: string): void {
  if (text) agentAsk.drafts[key] = text;
  else delete agentAsk.drafts[key];
  save();
}

/** Whether the chat `session` is running a turn now, on screen or off. */
function chatRunning(session: string | null): boolean {
  if (session === null) return app.busy && app.activeSessionId === null;
  if (app.background[session]) return true;
  if (app.parked && app.parked.session === session) return true;
  return app.busy && app.activeSessionId === session;
}

/** Whether the agent can still be working: its row says running and its
 *  chat's turn has not ended (a Stop ends both, whatever the row says). */
export function agentLive(row: SubagentRow): boolean {
  return subagentRunning(row) && chatRunning(row.session);
}

export function setTellMain(on: boolean): void {
  agentAsk.tellMain = on;
  save();
}

/** Put a held note back into the tab's box, joined to what is there. */
export function takeBackNote(key: string, index: number): void {
  const list = agentAsk.notes[key];
  if (!list || !list[index]) return;
  const [note] = list.splice(index, 1);
  if (list.length === 0) delete agentAsk.notes[key];
  const draft = agentAsk.drafts[key];
  agentAsk.drafts[key] = draft ? `${draft}\n\n${note.text}` : note.text;
  save();
}

let sending = false;

/**
 * Ask the agent `row` something from its tab. A running agent's question
 * is held; a finished one's goes now — into the chat it was adopted into,
 * or into a new one that carries its run. The chat on screen becomes that
 * chat, since a turn runs in the open chat; the tab shows the answer too.
 * Anything that cannot go now (a turn runs in the chat on screen and could
 * not be moved aside) is held and goes with `deliverDue`.
 */
export async function askSubagent(row: SubagentRow, text: string): Promise<"sent" | "held" | "steered"> {
  const key = keyOf(row);
  const said = text.trim();
  if (!said) return "held";
  if (agentLive(row) && (await steer(row, said))) return "steered";
  (agentAsk.notes[key] ??= []).push({ text: said, at: new Date().toISOString() });
  save();
  if (agentLive(row)) return "held";
  const went = await deliver(row);
  return went ? "sent" : "held";
}

/** The chat whose directory a running agent's notes go into: its row's,
 *  else (a New chat's first turn) the chat that turn named. */
function steerChat(row: SubagentRow): string | null {
  return row.session ?? app.budgetSession ?? null;
}

/**
 * Send `text` into the running agent `row` (backlog 295). Recorded in the
 * store first — his words survive a failed call — then queued for the
 * hook. `false` when it could not be queued; the caller holds it instead.
 */
async function steer(row: SubagentRow, text: string): Promise<boolean> {
  const session = steerChat(row);
  if (!session || !row.task_id) return false;
  const key = keyOf(row);
  const note: Steered = {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    text,
    at: new Date().toISOString(),
    session,
    agentId: row.task_id,
    tellMain: agentAsk.tellMain,
  };
  (agentAsk.steered[key] ??= []).push(note);
  save();
  try {
    await api.steerSubagent(session, note.agentId, note.id, text, row.description || null, note.tellMain);
  } catch {
    dropSteered(key, note.id);
    return false;
  }
  startSteerPoll();
  return true;
}

function dropSteered(key: string, id: string): void {
  const list = agentAsk.steered[key];
  if (!list) return;
  const i = list.findIndex((n) => n.id === id);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) delete agentAsk.steered[key];
  save();
}

/** Notes sent into an agent that have not reached it yet. */
export function steerPending(): Array<[string, Steered]> {
  const out: Array<[string, Steered]> = [];
  for (const [key, list] of Object.entries(agentAsk.steered)) {
    for (const n of list) if (!n.deliveredAt) out.push([key, n]);
  }
  return out;
}

/**
 * Take back a sent note that has not reached the agent yet: back into the
 * box, as a held note is. `false` when it had already gone (it is then
 * marked delivered on the next read).
 */
export async function takeBackSteered(key: string, id: string): Promise<boolean> {
  const n = agentAsk.steered[key]?.find((x) => x.id === id);
  if (!n || n.deliveredAt) return false;
  let took = false;
  try {
    took = await api.unsteerSubagent(n.session, n.agentId, n.id);
  } catch {
    took = false;
  }
  if (!took) {
    addToast("That note already reached the agent");
    await syncSteers();
    return false;
  }
  dropSteered(key, id);
  const draft = agentAsk.drafts[key];
  agentAsk.drafts[key] = draft ? `${draft}\n\n${n.text}` : n.text;
  save();
  return true;
}

/**
 * Read each chat's record and mark what was delivered. A note whose agent
 * is no longer live and that never went is taken back from the queue and
 * held — it goes as the first question (`deliverDue`), the held path.
 */
export async function syncSteers(): Promise<void> {
  const pending = steerPending();
  if (pending.length === 0) return;
  const sessions = [...new Set(pending.map(([, n]) => n.session))];
  for (const session of sessions) {
    let state: api.SteerState;
    try {
      state = await api.steerState(session);
    } catch {
      continue;
    }
    const went = new Map(state.delivered.map((d) => [`${d.agent_id}\u0000${d.id}`, d]));
    for (const [key, n] of pending) {
      if (n.session !== session) continue;
      const d = went.get(`${n.agentId}\u0000${n.id}`);
      if (d) {
        n.deliveredAt = new Date(d.delivered_at_ms).toISOString();
        n.tool = d.tool;
        n.toolUseId = d.tool_use_id;
        continue;
      }
      const row = app.subagents.find((r) => keyOf(r) === key);
      if (row && agentLive(row)) continue;
      // Finished (or gone) without another call: the held path.
      let took = false;
      try {
        took = await api.unsteerSubagent(n.session, n.agentId, n.id);
      } catch {
        took = false;
      }
      if (!took) continue; // went in between; the next read marks it
      dropSteered(key, n.id);
      (agentAsk.notes[key] ??= []).push({ text: n.text, at: n.at });
    }
  }
  save();
}

let steerTimer: ReturnType<typeof setInterval> | null = null;

/** Poll the record every 1.5 s while any sent note has not arrived. */
export function startSteerPoll(): void {
  if (steerTimer !== null) return;
  steerTimer = setInterval(() => {
    if (steerPending().length === 0) {
      if (steerTimer !== null) clearInterval(steerTimer);
      steerTimer = null;
      return;
    }
    void syncSteers();
  }, 1500);
}

/** Every held note whose agent has finished, while nothing runs on screen. */
export async function deliverDue(): Promise<void> {
  // A sent note its agent never reached becomes a held one first.
  if (steerPending().length > 0) {
    await syncSteers();
    // After a reload, the poll restarts here.
    if (steerPending().length > 0) startSteerPoll();
  }
  if (sending || app.busy) return;
  for (const row of app.subagents) {
    const key = keyOf(row);
    if (!agentAsk.notes[key]?.length || agentLive(row)) continue;
    await deliver(row);
    // One per call: the send is a whole turn, and the next is due when it ends.
    return;
  }
}

async function deliver(row: SubagentRow): Promise<boolean> {
  if (sending) return false;
  const key = keyOf(row);
  const notes = agentAsk.notes[key];
  if (!notes?.length) return false;
  if (!app.connection) {
    addToast("No engine is connected — the question to the agent is held under its tab");
    return false;
  }
  sending = true;
  try {
    const adopted = adoptedChat(row);
    if (adopted) await openSession(adopted);
    else await newSession(undefined, "build");
    const ready = !app.busy && app.activeSessionId === adopted;
    if (!ready) {
      addToast("A turn is running on screen — the question to the agent goes when it ends");
      return false;
    }
    const text = notes.map((n) => n.text).join("\n\n");
    const first = adopted === null;
    const wire = first ? adoptedPrompt(carryOfSubagent(row, row.session), text) : text;
    // Out of the store the moment it is on its way; the chat's log keeps it.
    delete agentAsk.notes[key];
    save();
    addToast(
      first
        ? `Asking “${row.description || "the agent"}” in a new chat that carries its run — the main chat is not told`
        : `Asking “${row.description || "the agent"}” in its chat`,
    );
    await send(wire);
    if (first) await claim(row, key);
    return true;
  } finally {
    sending = false;
  }
}

/** After the first turn: the chat that turn made is this agent's, named. */
async function claim(row: SubagentRow, key: string): Promise<void> {
  let id: string | null = null;
  const firstUser = app.events.find((e) => e.event === "user_message");
  if (app.activeSessionId && firstUser?.event === "user_message" && splitAdopted(firstUser.text).call === row.tool_use_id) {
    id = app.activeSessionId;
  } else {
    // He looked elsewhere during the turn: the chat list has it.
    await refreshSessions();
    id = adoptedChatOf(app.sessions, row.tool_use_id);
  }
  if (!id) return;
  agentAsk.adopted[key] = id;
  save();
  await renameSession(id, adoptedTitle(row));
}
