/**
 * The Needs-you view, as data (nightshift item 753, 2026-11-16): one list of
 * everything across every project, grouped by state —
 *
 *   Waiting on you   a call or question card in a running chat; a chat whose
 *                    turn ended on a question (`askTag.ts`); an open blocker
 *   Ready for review a chat whose turn finished (or failed) since he last
 *                    had it open; a shipped item in its review window
 *   Working          everything running: chats, helpers, passes
 *
 * — each row answerable in place where an answer is words. Pure: the store
 * (`needsBoard.svelte.ts`) reads the app and calls these; `needsYou753.test.ts`
 * pins them.
 */
import type { RunEntry } from "./running";
import type { Ask } from "./askTag";

export type NeedState = "waiting" | "review" | "working";
export const NEED_STATES: NeedState[] = ["waiting", "review", "working"];
export const NEED_LABEL: Record<NeedState, string> = {
  waiting: "Waiting on you",
  review: "Ready for review",
  working: "Working",
};
export const NEED_EMPTY: Record<NeedState, string> = {
  waiting: "Nothing waits on you.",
  review: "Nothing has finished since you last looked.",
  working: "Nothing is running.",
};

export type NeedKind = "card" | "ask" | "blocker" | "done" | "failed" | "shipped" | "run";

/** A chat's turn that ended while he was not looking at it (kept by the store). */
export interface EndedTurn {
  chat: string;
  name: string;
  project: string | null;
  projectName: string | null;
  /** Unix ms. */
  at: number;
  failed: boolean;
  /** The question it ended on, still unanswered. */
  ask: Ask | null;
}

export interface OpenBlocker {
  project: string;
  projectName: string;
  id: string;
  question: string;
  /** `## What I would have done, and why`. */
  guess: string;
  /** `default: held` in its front matter: nothing proceeds without him. */
  held: boolean;
  raised: string;
}

export interface ShippedItem {
  project: string;
  projectName: string;
  id: string;
  title: string;
  /** The day it shipped, `YYYY-MM-DD`, when the item says. */
  shipped: string;
}

export interface NeedRow {
  /** Stable, for keyed lists and the kept reply drafts. */
  id: string;
  state: NeedState;
  kind: NeedKind;
  /** The few words on the left: "question", "blocker 1220", "finished". */
  tag: string;
  title: string;
  /** The second line: the question, what it is doing, the default. */
  detail: string;
  /** Project name, "unfiled chats", "memory". */
  where: string;
  project: string | null;
  /** The chat a click opens; null when there is none. */
  chat: string | null;
  at: number | null;
  /** What the row's reply box does; null for a row with nothing to type to. */
  reply: "answer-ask" | "answer-blocker" | "message" | "follow-up" | null;
  replyHint: string;
  /** A turn-end question's answers, as buttons. */
  ask?: Ask;
  blocker?: string;
  item?: string;
}

export interface NeedSources {
  runs: readonly RunEntry[];
  /** Turns that ended off screen, and questions still open, by chat. */
  ended: readonly EndedTurn[];
  /** The chat on screen, when its last reply holds an unanswered question. */
  here: { chat: string; name: string; project: string | null; projectName: string | null; ask: Ask } | null;
  blockers: readonly OpenBlocker[];
  shipped: readonly ShippedItem[];
  /** Chats with a turn running now: their kept rows are stale and not shown. */
  running: (chat: string) => boolean;
}

const UNFILED = "unfiled chats";

/** Every row, in the order the groups list them. */
export function needRows(s: NeedSources): NeedRow[] {
  const rows: NeedRow[] = [];
  // -- waiting: cards in running chats
  for (const r of s.runs) {
    if (!r.waiting) continue;
    rows.push({
      id: `card:${r.id}`,
      state: "waiting",
      kind: "card",
      tag: "card",
      title: r.chat || r.kind,
      detail: "A call or a question is waiting for your answer on its card.",
      where: r.where,
      project: r.project,
      chat: r.session,
      at: r.startedAt,
      reply: null,
      replyHint: "",
    });
  }
  // -- waiting: turn-end questions (the chat on screen first)
  const asked = new Set<string>();
  const askRow = (chat: string, name: string, project: string | null, projectName: string | null, ask: Ask, at: number | null): NeedRow => ({
    id: `ask:${chat}`,
    state: "waiting",
    kind: "ask",
    tag: "question",
    title: name,
    detail: ask.question,
    where: projectName ?? UNFILED,
    project,
    chat,
    at,
    reply: "answer-ask",
    replyHint: ask.options.length ? "Or type another answer" : "Type your answer",
    ask,
  });
  if (s.here && !s.running(s.here.chat)) {
    asked.add(s.here.chat);
    rows.push(askRow(s.here.chat, s.here.name, s.here.project, s.here.projectName, s.here.ask, null));
  }
  const ended = [...s.ended].filter((e) => !s.running(e.chat)).sort((a, b) => b.at - a.at);
  for (const e of ended) {
    if (!e.ask || asked.has(e.chat)) continue;
    asked.add(e.chat);
    rows.push(askRow(e.chat, e.name, e.project, e.projectName, e.ask, e.at));
  }
  // -- waiting: open blockers, held ones first
  for (const b of [...s.blockers].sort((a, b) => Number(b.held) - Number(a.held) || a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id))) {
    rows.push({
      id: `blocker:${b.project}:${b.id}`,
      state: "waiting",
      kind: "blocker",
      tag: `${b.held ? "held " : ""}blocker ${b.id}`,
      title: b.question,
      detail: b.guess ? `Default: ${b.guess}` : "",
      where: b.projectName,
      project: b.project,
      chat: null,
      at: null,
      reply: "answer-blocker",
      replyHint: "Your decision, in your words",
      blocker: b.id,
    });
  }
  // -- review: turns that ended since he looked (not the ones still asking)
  for (const e of ended) {
    if (e.ask || asked.has(e.chat)) continue;
    rows.push({
      id: `done:${e.chat}`,
      state: "review",
      kind: e.failed ? "failed" : "done",
      tag: e.failed ? "failed" : "finished",
      title: e.name,
      detail: e.failed ? "Its turn failed." : "Its turn finished.",
      where: e.projectName ?? UNFILED,
      project: e.project,
      chat: e.chat,
      at: e.at,
      reply: "message",
      replyHint: "Reply in this chat",
    });
  }
  for (const i of [...s.shipped].sort((a, b) => b.shipped.localeCompare(a.shipped) || a.id.localeCompare(b.id))) {
    rows.push({
      id: `shipped:${i.project}:${i.id}`,
      state: "review",
      kind: "shipped",
      tag: `shipped ${i.id}`,
      title: i.title,
      detail: i.shipped ? `Shipped ${i.shipped}; silence closes it after 3 days.` : "Shipped; silence closes it after 3 days.",
      where: i.projectName,
      project: i.project,
      chat: null,
      at: null,
      reply: "follow-up",
      replyHint: "Something wrong? It becomes a new item",
      item: i.id,
    });
  }
  // -- working
  for (const r of s.runs) {
    if (r.waiting) continue;
    rows.push({
      id: `run:${r.id}`,
      state: "working",
      kind: "run",
      tag: r.kind,
      title: r.chat || r.where,
      detail: r.doing,
      where: r.where,
      project: r.project,
      chat: r.session,
      at: r.startedAt,
      reply: null,
      replyHint: "",
    });
  }
  return rows;
}

export interface NeedGroup {
  state: NeedState;
  label: string;
  rows: NeedRow[];
}

/** The three groups, always all three (an empty one says so). */
export function groupNeeds(rows: readonly NeedRow[]): NeedGroup[] {
  return NEED_STATES.map((state) => ({ state, label: NEED_LABEL[state], rows: rows.filter((r) => r.state === state) }));
}

/** The badge's number: what waits on him. */
export function waitingCount(rows: readonly NeedRow[]): number {
  return rows.filter((r) => r.state === "waiting").length;
}

/** The badge's words: "2 need you", "3 to review"; empty with neither. */
export function badgeWords(rows: readonly NeedRow[]): { n: number; word: string; waiting: boolean } | null {
  const w = waitingCount(rows);
  if (w > 0) return { n: w, word: w === 1 ? "needs you" : "need you", waiting: true };
  const r = rows.filter((x) => x.state === "review").length;
  return r > 0 ? { n: r, word: "to review", waiting: false } : null;
}

/** The message a shipped row's reply files as a new item's title: his words, whole, after what they are about. */
export function followUpTitle(item: string, title: string, words: string): string {
  const about = title.length > 48 ? `${title.slice(0, 47).trimEnd()}…` : title;
  return `Follow-up to ${item} (${about}): ${words.replace(/\s+/g, " ").trim()}`;
}

/** Keep the kept turns bounded: the newest `max`, a still-open question before a plain finish. */
export function trimEnded(rows: readonly EndedTurn[], max = 60): EndedTurn[] {
  return [...rows].sort((a, b) => Number(!!b.ask) - Number(!!a.ask) || b.at - a.at).slice(0, max);
}

/** The kept turns read back from storage; anything malformed is dropped. */
export function parseEnded(raw: string | null): EndedTurn[] {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is EndedTurn =>
        !!e && typeof e === "object" && typeof (e as EndedTurn).chat === "string" && typeof (e as EndedTurn).name === "string" && typeof (e as EndedTurn).at === "number",
    );
  } catch {
    return [];
  }
}
