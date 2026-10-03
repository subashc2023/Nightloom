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
 * A note typed under a *running* agent is held (089's shape) — the CLI has
 * no way into a running child, and a fake one would corrupt its log (the
 * item's Not-to-do) — and goes as the first question once the agent has
 * finished and nothing is running in the chat on screen: `deliverDue`,
 * which `App.svelte` calls whenever that changes. A Stop ends the turn and
 * with it the agent, so a held note goes then too.
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

const STORE_KEY = "nightloom.subagentAsk.v1";

interface Stored {
  notes: Record<string, { text: string; at: string }[]>;
  drafts: Record<string, string>;
  adopted: Record<string, string>;
}

function load(): Stored {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      return { notes: p.notes ?? {}, drafts: p.drafts ?? {}, adopted: p.adopted ?? {} };
    }
  } catch {
    // unreadable: start empty
  }
  return { notes: {}, drafts: {}, adopted: {} };
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
export async function askSubagent(row: SubagentRow, text: string): Promise<"sent" | "held"> {
  const key = keyOf(row);
  const said = text.trim();
  if (!said) return "held";
  (agentAsk.notes[key] ??= []).push({ text: said, at: new Date().toISOString() });
  save();
  if (agentLive(row)) return "held";
  const went = await deliver(row);
  return went ? "sent" : "held";
}

/** Every held note whose agent has finished, while nothing runs on screen. */
export async function deliverDue(): Promise<void> {
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
