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

const defaults: ReviewDeps = {
  digest: (s) => api.retroDigest(s),
  ask: (text, n) => api.askAside(text, n),
  save: (...a) => api.retroSave(...a),
  openChat: () => null,
};

/** Run the three steps for one card; never throws — a failure is the card's state. */
export async function runReview(t: ReviewTarget, deps: Partial<ReviewDeps> = {}): Promise<ReviewState> {
  const d = { ...defaults, ...deps };
  const k = key(t.chat, t.index);
  if (live[k] && reviewBusy(live[k])) return live[k];
  const set = (s: ReviewState): ReviewState => {
    live[k] = s;
    return s;
  };
  set({ phase: "digest" });
  let digest: api.RetroDigest;
  try {
    digest = await d.digest(t.agentSession);
  } catch (e) {
    return set({ phase: "error", error: `The transcript did not read: ${String(e)}` });
  }
  // The aside forks the chat open in the window: if he moved on while the
  // digest read, it would review the wrong chat.
  if (d.openChat() !== t.chat) {
    return set({ phase: "error", error: "You switched chats before the review started — open this chat and press again." });
  }
  const counts = { issues: digest.issues, corrections: digest.corrections };
  set({ phase: "review", ...counts });
  let answer: AsideResult;
  try {
    answer = await d.ask(digest.prompt, ++seq);
  } catch (e) {
    return set({ phase: "error", error: `The review pass did not run: ${String(e)}`, ...counts });
  }
  if (answer.is_error || !answer.answer.trim()) {
    const why = answer.notices?.[0] ?? (answer.answer.trim() || "no answer");
    return set({ phase: "error", error: `The review pass failed: ${why}`, ...counts });
  }
  set({ phase: "saving", ...counts });
  try {
    const path = await d.save(t.chat, t.title, t.thread, answer.answer, answer.cost_usd ?? null, digest.markdown);
    viewSet(pathKey(t.chat, t.index), path, "");
    return set({ phase: "saved", path, cost: answer.cost_usd ?? null, ...counts });
  } catch (e) {
    return set({ phase: "error", error: `The page did not save: ${String(e)}`, ...counts });
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

/** The line under the button, or "" for none. */
export function reviewLine(s: ReviewState): string {
  const usd = (x: number) => (x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);
  switch (s.phase) {
    case "review":
    case "saving":
      return `Digest: ${s.issues ?? 0} tool issues, ${s.corrections ?? 0} corrections — the review pass runs as an aside.`;
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
}
