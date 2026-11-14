/**
 * *Continue with this prompt* on a reply's next-chat card (nightshift item
 * 506, 2026-11-05; his words in backlog/506: "why are there both?"). The one
 * hand-off surface: the card in the chat's latest finished reply carries the
 * button, and under the prompt one folded line that opens to the read order
 * Nightloom adds above it, so everything the button sends is on the card.
 *
 * Which reply, and the text, are read from the reply's source through
 * `extractStartPrompt`, never from the drawn HTML: a card is matched to that
 * text, so a look-alike `<div class="handoff-card">` in a reply's raw HTML
 * gets nothing, and what is sent is what `extractHandoff` keeps. Nothing here
 * reads the wrap-up's stage: a model that hands off by itself gets it too.
 *
 * The reply's HTML is patched and replaced while it streams, so the controls
 * go in after each render, as `codeCopy.ts` does, and `liveHtml` skips them.
 */

import { extractStartPrompt } from "./handoff.svelte";
import { keptGet, keptSet } from "./keptFolds.svelte";
import { hasHiddenChars } from "./shellRun";
import type { SessionMeta } from "./types";

export const CONTINUE_LABEL = "Continue with this prompt";
export const CONTINUED_LABEL = "Continued";
/** The folded line under the prompt, in his agent's words (blocker 1659). */
export const READ_ORDER_LINE = "Nightloom adds its read order above this";
/** The row under the prompt; `liveHtml` has no counterpart for it. */
export const GO_CLASS = "handoff-go";

/** What a reply's card needs: all of it read again at each render and click. */
export interface NextChat {
  /** The chat the reply is in, and the reply's log index. */
  chat: string;
  index: number;
  /** The prompt, as `extractStartPrompt` keeps it. */
  prompt: string;
  /** The text above it, shown read-only; blank when there is none. */
  readOrder: string;
  /** This reply has already been continued from. */
  used: boolean;
  /** Why the button cannot be pressed now, or null. */
  blocked: string | null;
  onContinue: () => void;
}

/** A reply as `Transcript` holds it, as much as this asks of it. */
export interface ReplyRow {
  kind: string;
  index: number;
  superseded: boolean;
  removed: boolean;
  segs?: { kind: string; text?: string }[];
}

/**
 * The reply that carries the button: the last one standing (not rewound
 * away, not removed), and only if it holds a prompt; an older reply's card
 * never does. Null too when the prompt has characters that do not show: what
 * shows must be what is sent, so such a card keeps Copy alone.
 */
export function continuableReply(rows: readonly ReplyRow[]): { index: number; prompt: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== "assistant" || r.superseded || r.removed) continue;
    const text = (r.segs ?? [])
      .filter((s) => s.kind === "text")
      .map((s) => s.text ?? "")
      .join("\n");
    const prompt = extractStartPrompt(text);
    return prompt && !hasHiddenChars(prompt) ? { index: r.index, prompt } : null;
  }
  return null;
}

/**
 * Whether a chat was continued from this reply, read from the listing so it
 * holds after a relaunch: a child linked with `reason: "handoff"`, cut after
 * the reply (`forked_from.index` is the parent's length at the click). A
 * child cut before it does not count: he stayed, and this is a later card.
 */
export function continuedFromReply(
  sessions: readonly Pick<SessionMeta, "forked_from">[],
  chat: string,
  index: number,
): boolean {
  return sessions.some(
    (s) => s.forked_from?.session === chat && s.forked_from.reason === "handoff" && s.forked_from.index > index,
  );
}

/** Of the `pre`s drawn, the last whose text is the prompt, or null. */
export function matchingBlock<T>(blocks: readonly { el: T; text: string }[], prompt: string): T | null {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].text.trim() === prompt) return blocks[i].el;
  return null;
}

function goRow(next: NextChat, read: () => NextChat | null | undefined): HTMLElement {
  const row = document.createElement("div");
  row.className = GO_CLASS;
  const details = document.createElement("details");
  details.className = "handoff-order";
  const summary = document.createElement("summary");
  summary.textContent = READ_ORDER_LINE;
  const body = document.createElement("div");
  body.className = "handoff-order-text";
  details.append(summary, body);
  // Every view keeps its state (practices §7): the fold survives a chat switch.
  const foldKey = `fold:${next.chat}|${next.index}|read-order`;
  details.open = keptGet(foldKey, false);
  details.addEventListener("toggle", () => keptSet(foldKey, details.open, false));
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ns-btn accent small handoff-continue";
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = read();
    if (!now || b.disabled || now.used || now.blocked) return;
    b.disabled = true;
    now.onContinue();
  });
  row.append(details, b);
  return row;
}

/**
 * The controls under the card that holds the prompt, or under a legacy
 * `start-prompt` block; anything else loses them, since `liveHtml` re-uses
 * nodes for whatever comes next at their place.
 */
export function addContinueControls(root: HTMLElement, read: () => NextChat | null | undefined): void {
  const next = read();
  const blocks = Array.from(root.querySelectorAll("pre.handoff-text, pre.prose-block")).map((el) => ({
    el,
    text: el.querySelector("code")?.textContent ?? "",
  }));
  const pre = next ? matchingBlock(blocks, next.prompt) : null;
  // Right after the block: inside the card, or beside a legacy block, which has no card.
  const after = pre;
  let row: HTMLElement | null = null;
  for (const have of Array.from(root.querySelectorAll<HTMLElement>(`.${GO_CLASS}`))) {
    if (after && have.previousElementSibling === after && !row) row = have;
    else have.remove();
  }
  if (!next || !after) return;
  if (!row) {
    row = goRow(next, read);
    after.after(row);
  }
  const details = row.querySelector("details");
  const body = row.querySelector(".handoff-order-text");
  const b = row.querySelector("button");
  const order = next.readOrder.trim();
  if (details) details.hidden = !order;
  if (body && body.textContent !== order) body.textContent = order;
  if (b) {
    const label = next.used ? CONTINUED_LABEL : CONTINUE_LABEL;
    if (b.textContent !== label) b.textContent = label;
    b.disabled = next.used || next.blocked !== null;
    b.title = next.used
      ? "This reply has been continued in a new chat"
      : (next.blocked ?? "Open a new chat and send this prompt as its first message");
  }
}

/** Svelte action for a reply's `.markdown` element. */
export function handoffGo(node: HTMLElement, next?: NextChat | null) {
  let params = next;
  const add = () => addContinueControls(node, () => params);
  add();
  const obs = new MutationObserver(add);
  obs.observe(node, { childList: true, subtree: true });
  return {
    update(n?: NextChat | null) {
      params = n;
      add();
    },
    destroy: () => obs.disconnect(),
  };
}
