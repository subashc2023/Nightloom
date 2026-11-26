/**
 * The Needs-you view, as data (nightshift item 753, 2026-11-16): one list of
 * everything across every project, grouped by state —
 *
 *   Waiting on you   a call or question card in a running chat; a chat whose
 *                    turn ended on a question (`askTag.ts`); an open blocker
 *   Ready for review a chat whose turn finished (or failed) since he last
 *                    had it open; a shipped item in its review window
 *   Working          everything running: chats, helpers, passes
 *   Decided for you  (item 968) an open blocker whose default was applied —
 *                    work went ahead on it, nothing waits; folded, no count
 *
 * Item 968 (911 C): "Waiting on you" — the badge's one number — is only what
 * needs him: held blockers, a chat's question or approval card, a proposed
 * change to instructions or memory still pending.
 *
 * — each row answerable in place where an answer is words. Pure: the store
 * (`needsBoard.svelte.ts`) reads the app and calls these; `needsYou753.test.ts`
 * pins them.
 */
import type { RunEntry } from "./running";
import type { Ask } from "./askTag";

export type NeedState = "waiting" | "decided" | "review" | "working";
export const NEED_STATES: NeedState[] = ["waiting", "decided", "review", "working"];
export const NEED_LABEL: Record<NeedState, string> = {
  waiting: "Waiting on you",
  decided: "Decided for you — say if wrong",
  review: "Ready for review",
  working: "Working",
};
export const NEED_EMPTY: Record<NeedState, string> = {
  waiting: "Nothing waits on you.",
  decided: "Nothing was decided for you.",
  review: "Nothing has finished since you last looked.",
  working: "Nothing is running.",
};

export type NeedKind = "card" | "ask" | "blocker" | "proposal" | "done" | "failed" | "shipped" | "run";

/** Item 968: a proposed change to a project's instructions or his own memory, still pending his review. */
export interface PendingProposal {
  /** The bell's id for it (`proposalNoticeId`), which the row's Review opens. */
  id: string;
  /** "A change to nightshift-code's instructions". */
  title: string;
  why: string;
  project: string | null;
  projectName: string | null;
  /** Unix ms, when the proposal says. */
  at: number | null;
}

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
  /** Item 968: a proposal row's id, which its Review opens. */
  proposal?: string;
}

export interface NeedSources {
  runs: readonly RunEntry[];
  /** Turns that ended off screen, and questions still open, by chat. */
  ended: readonly EndedTurn[];
  /** The chat on screen, when its last reply holds an unanswered question. */
  here: { chat: string; name: string; project: string | null; projectName: string | null; ask: Ask } | null;
  blockers: readonly OpenBlocker[];
  shipped: readonly ShippedItem[];
  /** Item 968: proposals still pending; absent reads as none. */
  proposals?: readonly PendingProposal[];
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
  // -- waiting: proposals still pending (item 968)
  for (const p of [...(s.proposals ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id))) {
    rows.push({
      id: `proposal:${p.id}`,
      state: "waiting",
      kind: "proposal",
      tag: "proposal",
      title: p.title,
      detail: p.why,
      where: p.projectName ?? "your memory",
      project: p.project,
      chat: null,
      at: p.at,
      reply: null,
      replyHint: "",
      proposal: p.id,
    });
  }
  // -- open blockers: a held one waits on him; one whose default went ahead is "decided for you" (item 968)
  for (const b of [...s.blockers].sort((a, b) => Number(b.held) - Number(a.held) || a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id))) {
    rows.push({
      id: `blocker:${b.project}:${b.id}`,
      state: b.held ? "waiting" : "decided",
      kind: "blocker",
      tag: `${b.held ? "held " : ""}blocker ${b.id}`,
      title: b.question,
      detail: b.guess ? (b.held ? `Default: ${b.guess}` : `Went ahead on: ${b.guess}`) : "",
      where: b.projectName,
      project: b.project,
      chat: null,
      at: null,
      reply: "answer-blocker",
      replyHint: b.held ? "Your decision, in your words" : "Wrong? Your decision, in your words",
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

/** The groups: Waiting, Ready for review and Working always (an empty one says so); Decided for you only
 *  while it has rows (item 968). */
export function groupNeeds(rows: readonly NeedRow[]): NeedGroup[] {
  return NEED_STATES.map((state) => ({ state, label: NEED_LABEL[state], rows: rows.filter((r) => r.state === state) })).filter(
    (g) => g.state !== "decided" || g.rows.length > 0,
  );
}

/** The badge's number: what waits on him (item 968: never a decided blocker, never what is to review). */
export function waitingCount(rows: readonly NeedRow[]): number {
  return rows.filter((r) => r.state === "waiting").length;
}

/**
 * Item 995: THE Needs-you number — the one every surface shows (the top pill, the sidebar's Home row, Home's
 * Watching tab and its status line, the bell's foot line): every waiting row (held blockers, proposals, a chat's
 * question or card) plus Home's Start cards. Before 995 each surface counted its own subset, so Home said
 * "Nothing needs you" beside a pill that said 5.
 */
export function needCount(rows: readonly NeedRow[], cards = 0): number {
  return waitingCount(rows) + Math.max(0, cards);
}

/** "needs you" for one, "need you" otherwise. */
export function needWord(n: number): string {
  return n === 1 ? "needs you" : "need you";
}

/** The badge's words: "2 need you"; with nothing waiting but something to review, "to review" with no number
 *  (item 968: the one number counts only what needs him — `n` is 0); empty with neither. Item 995: Home's Start
 *  cards (`cards`) are in the one number. */
export function badgeWords(rows: readonly NeedRow[], cards = 0): { n: number; word: string; waiting: boolean } | null {
  const w = needCount(rows, cards);
  if (w > 0) return { n: w, word: needWord(w), waiting: true };
  const r = rows.filter((x) => x.state === "review").length;
  return r > 0 ? { n: 0, word: "to review", waiting: false } : null;
}

/**
 * Item 968: a project's blockers as the counts show them — `held` (waits on him: the hot number) and `open`
 * (every open one, decided ones included). From the loaded list when there is one, else the project row's
 * counts; an older backend without `held_blockers` reads as every open one held (nothing hidden).
 */
export function blockerCounts(
  list: readonly { status: string; fields?: Record<string, string> }[] | null | undefined,
  info: { open_blockers: number; held_blockers?: number } | null | undefined,
): { held: number; open: number; decided: number } {
  const open = list ? list.filter((b) => b.status === "open").length : (info?.open_blockers ?? 0);
  const held = list ? list.filter((b) => b.status === "open" && isHeld(b.fields)).length : (info?.held_blockers ?? open);
  return { held, open, decided: Math.max(0, open - held) };
}

/** Item 968: a blocker held for him — `default: held` in its front matter (the phone's `/home/held` rule). */
export function isHeld(fields: Record<string, string> | undefined | null): boolean {
  return (fields?.default ?? "").trim() === "held";
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

// ---- Home's own list (item 945) ----

/** The rows Nightshift's files put on the board: a project's open blockers and its shipped items. Item 968's
 *  proposals are the dream's, not his chats', so Home leaves them to the Needs-you view too. */
const NIGHTSHIFT_KINDS: readonly NeedKind[] = ["blocker", "shipped", "proposal"];

export interface HomeNeeds {
  /** What Home lists under Needs you: questions, cards, and turns that finished unseen — never what is running. */
  rows: NeedRow[];
  /** Left to the Needs-you view (he answers these where he runs Nightshift): how many of each. */
  blockers: number;
  shipped: number;
  /** Item 995: of `blockers`, the held ones (they wait on him and are in the one number). */
  held: number;
  /** Item 995: proposals pending (in the one number; not listed on Home). */
  proposals: number;
  /** Item 995: the one number (`needCount`) over every row — what Home's line and every badge say. */
  waiting: number;
}

/**
 * Item 945: Home's Needs you is what waits on him in his chats. Nightshift's open blockers and shipped items are
 * not Home's to announce — he manages those where he runs Nightshift (his words) — so they are counted, not
 * listed; the Needs-you view still shows and answers every one.
 */
export function homeNeeds(rows: readonly NeedRow[], cards = 0): HomeNeeds {
  const mine = rows.filter((r) => r.state !== "working");
  return {
    held: mine.filter((r) => r.kind === "blocker" && r.state === "waiting").length,
    proposals: mine.filter((r) => r.kind === "proposal" && r.state === "waiting").length,
    waiting: needCount(rows, cards),
    rows: mine.filter((r) => !NIGHTSHIFT_KINDS.includes(r.kind)),
    // Every open blocker, held or decided: the quiet line under Home's list counts them as before (item 945).
    blockers: mine.filter((r) => r.kind === "blocker").length,
    shipped: mine.filter((r) => r.kind === "shipped").length,
  };
}

/** The one quiet line under Home's list: "15 blockers · 24 shipped items"; empty with neither. */
export function nightshiftWords(n: { blockers: number; shipped: number }): string {
  const parts: string[] = [];
  if (n.blockers > 0) parts.push(n.blockers === 1 ? "1 blocker" : `${n.blockers} blockers`);
  if (n.shipped > 0) parts.push(n.shipped === 1 ? "1 shipped item" : `${n.shipped} shipped items`);
  return parts.join(" · ");
}

/**
 * Item 995: the quiet line on Home for what it does not list — the counts agree with the pill: held blockers and
 * proposals (both in the one number), then shipped items to review. Blockers whose default went ahead ("decided
 * for you") are not counted (item 968: folded, no count). "4 held blockers · 1 proposal · 20 shipped items to
 * review"; empty with none.
 */
export function elsewhereWords(n: { held: number; proposals: number; shipped: number }): string {
  const parts: string[] = [];
  if (n.held > 0) parts.push(n.held === 1 ? "1 held blocker" : `${n.held} held blockers`);
  if (n.proposals > 0) parts.push(n.proposals === 1 ? "1 proposal" : `${n.proposals} proposals`);
  if (n.shipped > 0) parts.push(n.shipped === 1 ? "1 shipped item to review" : `${n.shipped} shipped items to review`);
  return parts.join(" · ");
}

/**
 * Item 945: a kept turn he has now seen — its chat is the one on screen, in the chat view, with the window in
 * front. A finish is dropped; a question stays until the log shows it answered (`answered`).
 */
export function seenNow(kept: EndedTurn | undefined, o: { onScreen: boolean; focused: boolean; answered: boolean }): boolean {
  if (!kept || !o.onScreen || !o.focused) return false;
  return !kept.ask || o.answered;
}
