/**
 * Every hand-off, logged for scoring (nightshift item 757, 2026-11-16; his
 * words: "make sure ur tracking everything and jus in my daily usage of
 * handoffs and stuff over the next few days hopefully we get enough data").
 *
 * Two kinds of line go to `<config>/logs/handoffs.jsonl` (the Rust side,
 * `src-tauri/src/handoff_log.rs`, appends and stamps them):
 *
 * - **`handoff`**, when a next chat opens from a hand-off — by the card's
 *   *Continue with this prompt* (`route: "card"`, with item 747's carry), the
 *   no-prompt line's *Continue in a new chat* (`"box"`: the text is put in
 *   the box, unsent) or the hand-off made while he is away (`"unattended"`).
 *   It holds what the hand-off carried: the goal, the first message as sent,
 *   his ticked messages word for word, the list built from the tool calls
 *   (uncapped, with the card's caps beside it, so the caps can be tuned), the
 *   fixed-sections check and what the wrap-up cost. His messages left
 *   unticked are listed by id, date, length and quoted share only — never
 *   their text, which the hand-off did not carry.
 * - **`next_turn`**, one per turn for the first `NEXT_TURNS` turns of a chat
 *   that continues a hand-off: the files it read, edited and named in shell
 *   commands, its commits — what the next chat really needed.
 *
 * The scorer (`nightshift-code/bin/handoffscore.py`) joins them by chat id
 * (`to_chat` = `chat`). Nothing is sent anywhere; a line that cannot be
 * written is dropped, never a failed hand-off.
 */
import * as api from "./api";
import {
  artifactsOf,
  isTicked,
  quoteWords,
  splitGoal,
  MAX_COMMITS,
  MAX_EDITED,
  MAX_READ,
  MAX_SHELL,
  MAX_SUBAGENTS,
  type Carry,
} from "./handoffCarry";
import { viewGet, viewSet } from "./viewState";
import type { SessionEvent } from "./types";

/** The log's file, under `<config>/logs/`. */
export const HANDOFF_LOG = "handoffs.jsonl";
/** The record's shape; bumped when a field changes meaning. */
export const LOG_VERSION = 1;
/** How many of the next chat's turns are logged. */
export const NEXT_TURNS = 30;

export type HandoffRoute = "card" | "box" | "unattended";

export interface HandoffOpened {
  route: HandoffRoute;
  /** The chat handed off from, and the log index of its reply with the prompt. */
  from: string | null;
  index: number | null;
  /** The next chat. */
  to: string;
  /** The first message as sent (or, for `"box"`, as put in the box). */
  sent: string;
  /** The card's carry (route `"card"`), and his goal and ticks on the card. */
  carry?: Carry | null;
  goal?: string | null;
  ticks?: Readonly<Record<string, boolean>>;
}

/** The `handoff` line for a next chat just opened. */
export function handoffRecord(h: HandoffOpened): Record<string, unknown> {
  const carry = h.carry ?? null;
  const ticks = h.ticks ?? {};
  const promptGoal = carry ? carry.goal : splitGoal(h.sent).goal;
  const edited = h.goal !== null && h.goal !== undefined;
  const goal = (edited ? h.goal! : promptGoal).replace(/\s+/g, " ").trim();
  const rec: Record<string, unknown> = {
    kind: "handoff",
    v: LOG_VERSION,
    route: h.route,
    from_chat: h.from,
    from_index: h.index,
    to_chat: h.to,
    goal,
    goal_from: !goal ? "none" : edited && goal !== promptGoal ? "card" : "prompt",
    prompt_goal: promptGoal,
    sent: h.sent,
    sent_chars: h.sent.length,
  };
  if (!carry) return { ...rec, carry: false };
  return {
    ...rec,
    carry: true,
    messages: carry.messages,
    quoted: carry.quoted,
    // Every listed message by id; text only for the ones that went.
    unquoted: carry.unquoted.map((m) => ({
      id: m.id,
      when: m.when,
      carried: m.carried,
      ticked: isTicked(m, ticks),
      words: quoteWords(m.text).length,
      quoted: Math.round(m.quoted * 100) / 100,
    })),
    ticked: carry.unquoted.filter((m) => isTicked(m, ticks)).map((m) => ({ id: m.id, when: m.when, text: m.text })),
    artifacts: carry.artifacts,
    caps: { edited: MAX_EDITED, read: MAX_READ, shell: MAX_SHELL, commits: MAX_COMMITS, subagents: MAX_SUBAGENTS },
    missing: carry.missing,
    cost: carry.cost,
  };
}

/** Whether a chat continues a hand-off: its log opens with a `handoff` fork. */
export function handoffParent(events: readonly SessionEvent[]): { session: string; index: number } | null {
  const first = events[0];
  if (first?.event !== "session_created" || first.forked_from?.reason !== "handoff") return null;
  return { session: first.forked_from.session, index: first.forked_from.index };
}

/**
 * The `next_turn` lines of chat `chat` for its turns after `after` (1-based;
 * a turn is one of his live messages and what answered it), up to
 * `NEXT_TURNS`. Every turn in the log is taken as finished: this runs at a
 * turn's end. Empty for a chat that does not continue a hand-off.
 */
export function nextTurnRecords(
  chat: string,
  events: readonly SessionEvent[],
  live: readonly boolean[],
  after: number,
): Record<string, unknown>[] {
  const parent = handoffParent(events);
  if (!parent) return [];
  const starts: number[] = [];
  for (let i = 0; i < events.length; i++) if (live[i] && events[i].event === "user_message") starts.push(i);
  const out: Record<string, unknown>[] = [];
  for (let n = after + 1; n <= Math.min(starts.length, NEXT_TURNS); n++) {
    const a = starts[n - 1];
    const b = n < starts.length ? starts[n] : events.length;
    const a2 = artifactsOf(events.slice(a, b), live.slice(a, b), b - a);
    const start = events[a];
    let tools = 0;
    for (let i = a; i < b; i++) {
      const e = events[i];
      if (live[i] && e.event === "assistant_message") tools += e.blocks.filter((x) => x.type === "tool_use").length;
    }
    out.push({
      kind: "next_turn",
      v: LOG_VERSION,
      chat,
      forked_from: parent,
      turn: n,
      user_at: "at" in start ? start.at : null,
      edited: a2.edited,
      read: a2.read,
      shell: a2.shell,
      commits: a2.commits.map((c) => c.sha),
      subagents: a2.subagents.length,
      tools,
    });
  }
  return out;
}

function send(record: Record<string, unknown>): void {
  // Best effort: a log that cannot be written changes nothing he sees.
  void api.logHandoff(record).catch(() => {});
}

/** A next chat opened from a hand-off: its `handoff` line. */
export function noteHandoffOpened(h: HandoffOpened): void {
  send(handoffRecord(h));
}

function markKey(chat: string): string {
  return `handofflog:${chat}`;
}

/**
 * At a turn's end in chat `chat`: the `next_turn` lines of its turns not yet
 * logged. The last turn logged is kept per chat (`viewState`), so a relaunch
 * does not log a turn twice; a turn redone after a rewind keeps its first
 * line (the scorer keeps the last line per chat and turn).
 */
export function noteNextTurns(chat: string | null, events: readonly SessionEvent[], live: readonly boolean[]): void {
  if (!chat) return;
  const after = viewGet(markKey(chat), 0);
  if (after >= NEXT_TURNS) return;
  const recs = nextTurnRecords(chat, events, live, after);
  if (recs.length === 0) return;
  for (const r of recs) send(r);
  viewSet(markKey(chat), recs[recs.length - 1].turn as number, 0);
}
