/**
 * "Review this chat" on the hand-off card (nightshift item 796, from item
 * 793's survey §4 #3 — Devin's Session Insights). Three steps, one press:
 *
 * 1. **Digest** (`retro_digest`, no model): the chat's Claude Code
 *    transcript read by a script — tool errors and denials, repeated
 *    calls, cache misses and their cost, tokens by tool and helper, the
 *    instruction files read, his corrections verbatim, each with its line.
 * 2. **Review**: one aside (`ask_aside` — a throwaway fork of the chat's
 *    session on its warm cache, nothing recorded in the chat) asked to turn
 *    the digest into an issue timeline, what was read and then contradicted
 *    by him, and at most three proposed rule changes as diffs. Its `seq` is
 *    out of the aside cards' range, so no card draws it.
 * 3. **Save** (`retro_save`): the page goes under the chat's thread (or the
 *    project's `retrospectives/`), a new file each time; nothing is applied
 *    — each change is a `- [ ]` line for his tick.
 *
 * Where it stands is kept per card (chat and reply): in memory while it
 * runs, and the saved page's path on disk (`viewState`), so the card says
 * "Open the review" after a chat switch or a relaunch (practices §7). A
 * review running when the app quits is lost with its aside; the card then
 * offers the press again.
 *
 * Item 857 (his report, 2026-11-18: Review "kind of stuck", then Continue
 * "nothing is happening… both of the buttons are blocked out"): the review
 * never holds the card. *Continue* goes at once while one runs — the
 * review keeps going beside the new chat and its page still saves, with a
 * toast saying where (`notify`); `continue_session` no longer waits on the
 * aside's hold of the chat's agent. A running review has a Cancel
 * (`cancelReview`), and each step a time limit that ends in an error line
 * (`REVIEW_TIMEOUT_MS`, `DIGEST_TIMEOUT_MS`).
 */

import * as api from "./api";
import { viewGet, viewSet } from "./viewState";
import type { AsideResult } from "./types";

export type ReviewPhase = "idle" | "digest" | "review" | "saving" | "saved" | "error";

export interface ReviewState {
  phase: ReviewPhase;
  /** The saved page, once saved. */
  path?: string;
  /** The review pass's CLI estimate, when it gave one. */
  cost?: number | null;
  /** Why it stopped, in a sentence. */
  error?: string;
  /** The digest's counts, for the card's line. */
  issues?: number;
  corrections?: number;
}

/** What one card's review needs. */
export interface ReviewTarget {
  chat: string;
  /** The reply the card is on. */
  index: number;
  /** The chat's live Claude Code session: the transcript the digest reads. */
  agentSession: string;
  title: string;
  /** The chat's thread, or null: where the page goes. */
  thread: string | null;
}

export interface ReviewDeps {
  digest: (agentSession: string) => Promise<api.RetroDigest>;
  ask: (text: string, seq: number) => Promise<AsideResult>;
  save: (chat: string, title: string, thread: string | null, review: string, cost: number | null, digest: string) => Promise<string>;
  /** The chat open in the window now: the aside runs on that one. */
  openChat: () => string | null;
}

/** Item 857: what a run takes beyond its steps — Cancel, the toast, the limits. */
export interface ReviewOptions extends ReviewDeps {
  /** Item 857: stop the review's aside (`cancel_aside`), on Cancel or a timeout. */
  cancel: (seq: number) => Promise<unknown>;
  /** Item 857: a sentence for him when the review ends while its chat is
   *  not on screen (he continued from the card): where the page went. */
  notify: (text: string) => void;
  /** Item 857: how long each step may take, in ms. */
  reviewTimeoutMs: number;
  digestTimeoutMs: number;
}

/**
 * Item 857: the review pass's limit. Asides measured on his Mac
 * (`~/.nightloom/logs/turn-timing.log`, 164 asides, 2026-10-01 to
 * 2026-11-18): median 14 s, 95th percentile 36 s, longest 51 s; the review
 * he pressed on 2026-11-18 took 34 s. Five minutes is six times the
 * longest: a pass past it is stuck, not slow.
 */
export const REVIEW_TIMEOUT_MS = 5 * 60_000;
/** The digest is a script over the transcript, no model: two minutes. */
export const DIGEST_TIMEOUT_MS = 2 * 60_000;

/** A review stopped by his Cancel or a time limit, with its sentence. */
class Stopped extends Error {}

/** Item 857: each running review's stop, by card. */
const stops: Record<string, (why: string) => void> = {};

export const CANCELLED_LINE = "You cancelled the review — press Review this chat to run it again.";

const live = $state<Record<string, ReviewState>>({});

function key(chat: string, index: number): string {
  return `${chat}|${index}`;
}

function pathKey(chat: string, index: number): string {
  return `retro:${key(chat, index)}|path`;
}

/** Where this card's review stands: running or failed from memory, saved from disk. */
export function reviewOf(chat: string, index: number): ReviewState {
  const now = live[key(chat, index)];
  if (now) return now;
  const path = viewGet(pathKey(chat, index), "");
  return path ? { phase: "saved", path } : { phase: "idle" };
}

export function reviewBusy(s: ReviewState): boolean {
  return s.phase === "digest" || s.phase === "review" || s.phase === "saving";
}

/** The aside's `seq`: past any card's, so the window draws none of it. */
let seq = 2 ** 40;

const defaults: ReviewOptions = {
  digest: (s) => api.retroDigest(s),
  ask: (text, n) => api.askAside(text, n),
  save: (...a) => api.retroSave(...a),
  openChat: () => null,
  cancel: (n) => api.cancelAside(n),
  notify: () => {},
  reviewTimeoutMs: REVIEW_TIMEOUT_MS,
  digestTimeoutMs: DIGEST_TIMEOUT_MS,
};

/** Item 857: stop this card's running review; false when none runs. The
 *  card shows the cancelled line at once; a page already saving is kept. */
export function cancelReview(chat: string, index: number): boolean {
  const stop = stops[key(chat, index)];
  if (!stop) return false;
  stop(CANCELLED_LINE);
  return true;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m >= 1 ? `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}

/** Run the three steps for one card; never throws — a failure is the card's state. */
export async function runReview(t: ReviewTarget, deps: Partial<ReviewOptions> = {}): Promise<ReviewState> {
  const d = { ...defaults, ...deps };
  const k = key(t.chat, t.index);
  if (live[k] && reviewBusy(live[k])) return live[k];
  const set = (s: ReviewState): ReviewState => {
    live[k] = s;
    return s;
  };
  // Item 857: his Cancel, or a step's time limit, ends the wait at once.
  let stop!: (why: string) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = (why) => reject(new Stopped(why));
  });
  stopped.catch(() => {});
  stops[k] = (why) => stop(why);
  const within = <T>(p: Promise<T>, ms: number, late: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Stopped(late)), ms);
    });
    return Promise.race([p, stopped, limit]).finally(() => clearTimeout(timer));
  };
  // A review that ends while its chat is not on screen says so in a toast.
  const away = (s: ReviewState): ReviewState => {
    if (d.openChat() !== t.chat) {
      const name = t.title.trim() ? `“${t.title.trim()}”` : "the chat you left";
      d.notify(s.phase === "saved" ? `The review of ${name} is saved: ${(s.path ?? "").split("/").slice(-1)[0]}` : `The review of ${name} stopped: ${s.error ?? "no reason given"}`);
    }
    return s;
  };
  try {
    set({ phase: "digest" });
    let digest: api.RetroDigest;
    try {
      digest = await within(d.digest(t.agentSession), d.digestTimeoutMs, `The transcript took over ${minutes(d.digestTimeoutMs)} to read and was stopped — press again to retry.`);
    } catch (e) {
      if (e instanceof Stopped) return set({ phase: "error", error: e.message });
      return set({ phase: "error", error: `The transcript did not read: ${String(e)}` });
    }
    // The aside forks the chat open in the window: if he moved on while the
    // digest read, it would review the wrong chat.
    if (d.openChat() !== t.chat) {
      return set({ phase: "error", error: "You switched chats before the review started — open this chat and press again." });
    }
    const counts = { issues: digest.issues, corrections: digest.corrections };
    set({ phase: "review", ...counts });
    const n = ++seq;
    let answer: AsideResult;
    try {
      answer = await within(d.ask(digest.prompt, n), d.reviewTimeoutMs, `The review pass ran past ${minutes(d.reviewTimeoutMs)} and was stopped — press again to retry.`);
    } catch (e) {
      if (e instanceof Stopped) {
        // The aside is stopped too, so nothing runs on unseen.
        void d.cancel(n).catch(() => {});
        return away(set({ phase: "error", error: e.message, ...counts }));
      }
      return away(set({ phase: "error", error: `The review pass did not run: ${String(e)}`, ...counts }));
    }
    if (answer.is_error || !answer.answer.trim()) {
      const why = answer.notices?.[0] ?? (answer.answer.trim() || "no answer");
      return away(set({ phase: "error", error: `The review pass failed: ${why}`, ...counts }));
    }
    // The answer is in hand: the page is written whatever happens now, so
    // a Cancel past this point cannot lose a review that is already paid for.
    delete stops[k];
    set({ phase: "saving", ...counts });
    try {
      const path = await d.save(t.chat, t.title, t.thread, answer.answer, answer.cost_usd ?? null, digest.markdown);
      viewSet(pathKey(t.chat, t.index), path, "");
      return away(set({ phase: "saved", path, cost: answer.cost_usd ?? null, ...counts }));
    } catch (e) {
      return away(set({ phase: "error", error: `The page did not save: ${String(e)}`, ...counts }));
    }
  } finally {
    delete stops[k];
  }
}

/** The button's words for a state. */
export function reviewLabel(s: ReviewState): string {
  switch (s.phase) {
    case "digest":
      return "Reading the transcript…";
    case "review":
      return "Reviewing…";
    case "saving":
      return "Saving the review…";
    case "saved":
      return "Open the review";
    default:
      return "Review this chat";
  }
}

export const REVIEW_TIP =
  "A script digests this chat's transcript (no model), then one aside on the warm cache writes a page: " +
  "an issue timeline, rules you corrected, at most three proposed changes. Nothing is applied without your tick.";

/** Item 857: what *Continue* does while a review runs, said on the card. */
export const BESIDE_LINE = "Continue won't wait: the review keeps running and saves its page — or Cancel it.";

/** The line under the button, or "" for none. */
export function reviewLine(s: ReviewState): string {
  const usd = (x: number) => (x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);
  switch (s.phase) {
    case "digest":
      return BESIDE_LINE;
    case "review":
      return `Digest: ${s.issues ?? 0} tool issues, ${s.corrections ?? 0} corrections — the review pass runs as an aside. ${BESIDE_LINE}`;
    case "saving":
      return `Digest: ${s.issues ?? 0} tool issues, ${s.corrections ?? 0} corrections — saving the page.`;
    case "saved": {
      const name = (s.path ?? "").split("/").slice(-1)[0];
      const cost = s.cost != null ? `, ${usd(s.cost)}` : "";
      return `Review saved: ${name}${cost}.`;
    }
    case "error":
      return s.error ?? "The review stopped.";
    default:
      return "";
  }
}

/** For the suite: forget what memory holds. */
export function resetReviews(): void {
  for (const k of Object.keys(live)) delete live[k];
  for (const k of Object.keys(stops)) delete stops[k];
}

/** Item 857: whether this card's review can still be cancelled (digest or review pass, not the save). */
export function reviewCancellable(s: ReviewState): boolean {
  return s.phase === "digest" || s.phase === "review";
}
