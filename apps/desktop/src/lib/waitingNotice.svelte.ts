/**
 * The bottom-right notice that a chat is waiting on him (nightshift item 523, 2026-11-09; his words: "it
 * isn't even shown to me if i'm anywhere else in the app that i have this thing waiting on me. some like
 * popup in the bottom right that doesn't disappear unless i click x that can jump me straight to the
 * question").
 *
 * One notice per chat with a prompt he cannot see right now — a question, a permission prompt, a plan, a
 * browser prompt — stacked, oldest at the bottom. It stays until he closes it (×, for that prompt only: the
 * chat's next prompt gets a new one) or the prompt is answered. A click opens the chat and scrolls to the card.
 *
 * "Cannot see" is measured, not guessed: each card on screen reports whether any of it is in the viewport
 * (`setCardVisible`, an IntersectionObserver in ApprovalPrompt.svelte), and a prompt with no visible card —
 * another chat's, a parked turn's, the open chat's scrolled away or behind a note — gets the notice.
 */
import { askKind, type AskKind } from "./askReply";
import type { ApprovalRequest } from "./types";

export interface WaitingNotice {
  /** The chat that waits (`null`: a new chat's first turn). */
  chat: string | null;
  /** Its oldest unseen prompt: the card a click scrolls to, and what × closes. */
  id: string;
  kind: AskKind;
  /** Its name as the list has it. */
  name: string;
  /** How many of its prompts wait (a second can only follow the first's answer, so this is 1 in practice). */
  count: number;
  /** Where it is: the chat on screen, one running off screen, or the parked turn's. */
  where: "screen" | "background" | "parked";
}

/** The cards on screen with any part in the viewport, by call id; and the prompts he closed the notice for. */
export const waitingView = $state<{ visible: Record<string, true>; closed: Record<string, true> }>({ visible: {}, closed: {} });

/** A card reports whether it can be seen. `false` (or the card leaving the page) forgets it. */
export function setCardVisible(id: string, visible: boolean): void {
  if (visible) waitingView.visible[id] = true;
  else delete waitingView.visible[id];
}

/**
 * The action every prompt card wears: its call id on the element (what a notice's click scrolls to) and
 * whether any of it is in the viewport, kept up to date; forgotten when the card leaves the page. Without
 * an IntersectionObserver (a test's DOM) a mounted card counts as seen.
 */
export function trackCard(node: HTMLElement, id: string): { destroy(): void } {
  node.dataset.askId = id;
  if (typeof IntersectionObserver === "undefined") {
    setCardVisible(id, true);
    return { destroy: () => setCardVisible(id, false) };
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) setCardVisible(id, e.isIntersecting);
  });
  io.observe(node);
  return {
    destroy() {
      io.disconnect();
      setCardVisible(id, false);
    },
  };
}

/** × on a notice: closed for that prompt until it is answered. */
export function closeWaiting(id: string): void {
  waitingView.closed[id] = true;
}

/** Forget closes for prompts that no longer wait, so the record cannot grow. */
export function pruneClosed(waiting: ReadonlySet<string>): void {
  for (const id of Object.keys(waitingView.closed)) if (!waiting.has(id)) delete waitingView.closed[id];
}

export interface WaitingSource {
  /** The chat on screen and its prompts — or, while a turn is parked, that turn's. */
  active: string | null;
  pending: readonly ApprovalRequest[];
  /** The parked turn's chat, when one is parked: `pending` is its, and it is off screen. */
  parked: { session: string | null } | null;
  background: Readonly<Record<string, { session: string; approvals: readonly ApprovalRequest[] }>>;
  visible: Readonly<Record<string, true>>;
  closed: Readonly<Record<string, true>>;
  /** A chat's name for the notice. */
  nameOf: (chat: string | null, where: WaitingNotice["where"]) => string;
}

/** The notices to show, oldest chat first (the stack draws the newest on top). */
export function waitingNotices(s: WaitingSource): WaitingNotice[] {
  const out: WaitingNotice[] = [];
  const add = (chat: string | null, approvals: readonly ApprovalRequest[], where: WaitingNotice["where"]) => {
    // A parked or background chat has no card on screen whatever the record says.
    const unseen = approvals.filter((r) => where !== "screen" || !s.visible[r.id]);
    const open = unseen.filter((r) => !s.closed[r.id]);
    if (open.length === 0) return;
    out.push({ chat, id: open[0].id, kind: askKind(open[0].name), name: s.nameOf(chat, where), count: unseen.length, where });
  };
  if (s.parked) add(s.parked.session, s.pending, "parked");
  else add(s.active, s.pending, "screen");
  for (const b of Object.values(s.background)) add(b.session, b.approvals, "background");
  return out;
}

/** Every prompt that waits anywhere, for `pruneClosed`. */
export function waitingIds(s: Pick<WaitingSource, "pending" | "background">): Set<string> {
  const ids = new Set(s.pending.map((r) => r.id));
  for (const b of Object.values(s.background)) for (const r of b.approvals) ids.add(r.id);
  return ids;
}

/** At most this many notices are drawn; the rest are counted on a last line. */
export const MAX_SHOWN = 4;

const WHAT: Record<AskKind, string> = {
  question: "has a question for you",
  plan: "has a plan waiting for your approval",
  browser: "is asking to use the browser",
  call: "is asking for permission",
};

/** The notice's words: the chat, what it waits for, and what a click does. */
export function noticeText(n: Pick<WaitingNotice, "name" | "kind" | "where">): { title: string; what: string; go: string } {
  return {
    title: n.name,
    what: WHAT[n.kind],
    go: n.where === "screen" ? "Go to it" : "Open the chat",
  };
}
