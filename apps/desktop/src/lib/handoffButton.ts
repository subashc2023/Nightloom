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
import { artifactsSummary, artifactsText, composeFirstMessage, costText, emptyArtifacts, isTicked, SECTIONS, type Carry } from "./handoffCarry";
import { keptGet, keptSet } from "./keptFolds.svelte";
import { viewGet, viewSet } from "./viewState";
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
  /** Item 747: what the card adds to the prompt — the goal, his unquoted
   *  messages, the artifact list, the cost; absent, the prompt goes alone. */
  carry?: Carry | null;
  onContinue: () => void;
}

// ---- item 747: the goal he typed and the messages he ticked, per card ----
//
// Kept on disk (`viewState`), not for the run only: a goal typed on a card is
// his work, and a relaunch must not lose it (practices §7).

/** No goal typed on this card: the prompt's own stands. */
const UNSET = "\u0000";

function carryKey(chat: string, index: number): string {
  return `carry:${chat}|${index}`;
}

/** The goal he typed on the card (blank: send none); null when he has not touched it. */
export function carryGoal(chat: string, index: number): string | null {
  const v = viewGet(`${carryKey(chat, index)}|goal`, UNSET);
  return v === UNSET ? null : v;
}

export function setCarryGoal(chat: string, index: number, goal: string | null): void {
  viewSet(`${carryKey(chat, index)}|goal`, goal ?? UNSET, UNSET);
}

/** His ticks on the card's list, by message id; a message not in it follows its default. */
export function carryTicks(chat: string, index: number): Record<string, boolean> {
  try {
    const v = JSON.parse(viewGet(`${carryKey(chat, index)}|ticks`, "") || "{}") as unknown;
    const out: Record<string, boolean> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "boolean") out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

export function setCarryTick(chat: string, index: number, id: string, on: boolean): void {
  const ticks = carryTicks(chat, index);
  ticks[id] = on;
  viewSet(`${carryKey(chat, index)}|ticks`, JSON.stringify(ticks), "");
}

/** What *Continue with this prompt* sends for this card: the prompt alone
 *  without a carry, else goal, prompt, his ticked messages, the list, the cost. */
export function nextChatMessage(next: Pick<NextChat, "chat" | "index" | "prompt" | "carry">): string {
  if (!next.carry) return next.prompt;
  return composeFirstMessage(next.carry, carryGoal(next.chat, next.index), carryTicks(next.chat, next.index));
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

/** The class of the block above the button that holds item 747's parts. */
export const CARRY_CLASS = "handoff-carry";
/** Longer than this, a listed message is clamped with a *more* button. */
const LONG_MESSAGE = 220;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A fold whose open state is kept for the chat (practices §7). */
function keptDetails(cls: string, key: string): { details: HTMLDetailsElement; summary: HTMLElement } {
  const details = el("details", cls);
  const summary = document.createElement("summary");
  details.append(summary);
  details.open = keptGet(key, false);
  details.addEventListener("toggle", () => keptSet(key, details.open, false));
  return { details, summary };
}

function hisSummary(carry: Carry, ticks: Record<string, boolean>): string {
  const n = carry.unquoted.length;
  const ticked = carry.unquoted.filter((m) => isTicked(m, ticks)).length;
  const lead = `${n} of your ${carry.messages} ${carry.messages === 1 ? "message" : "messages"} in this chat ${n === 1 ? "is" : "are"} not quoted in the hand-off`;
  return ticked > 0 ? `${lead} — ${ticked} ticked to carry over word for word` : `${lead} — tick any to carry over word for word`;
}

/** What identifies a carry block's content: anything else, it is rebuilt. */
function carrySig(next: NextChat): string {
  const c = next.carry;
  if (!c) return "";
  return [
    next.chat,
    next.index,
    c.goal,
    c.messages,
    c.unquoted.map((m) => m.id).join(","),
    artifactsSummary(c.artifacts),
    costText(c.cost),
    c.missing === null ? "-" : c.missing.join(","),
  ].join("|");
}

/**
 * Item 747's parts of the card, above the button: the goal field, his
 * messages the hand-off does not quote (tickable), the list Nightloom built
 * from the tool calls, whether the fixed sections were written, and what the
 * wrap-up cost. All of what the button sends beyond the prompt is here.
 */
function carryBlock(next: NextChat, read: () => NextChat | null | undefined): HTMLElement {
  const carry = next.carry as Carry;
  const { chat, index } = next;
  const box = el("div", CARRY_CLASS);
  box.dataset.sig = carrySig(next);

  const goal = el("label", "handoff-goal");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "handoff-goal-input";
  input.placeholder = "What the next chat is for — sent as its first line";
  input.setAttribute("aria-label", "Goal for the next chat");
  input.spellcheck = false;
  input.value = carryGoal(chat, index) ?? carry.goal;
  input.addEventListener("input", () => setCarryGoal(chat, index, input.value === carry.goal ? null : input.value));
  goal.append(el("span", "handoff-goal-label", "Goal"), input);
  box.append(goal);

  if (carry.unquoted.length > 0) {
    const { details, summary } = keptDetails("handoff-his", `fold:${chat}|${index}|his`);
    const sync = () => {
      summary.textContent = hisSummary(carry, carryTicks(chat, index));
    };
    sync();
    const list = el("div", "handoff-his-list");
    const ticks = carryTicks(chat, index);
    for (const m of carry.unquoted) {
      const row = el("label", "handoff-his-row");
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = isTicked(m, ticks);
      tick.addEventListener("change", () => {
        if (read()?.used) return;
        setCarryTick(chat, index, m.id, tick.checked);
        sync();
      });
      const text = el("span", "handoff-his-text", m.text);
      const when = el("span", "handoff-his-when", m.carried ? `${m.when} · carried from an earlier chat` : m.when);
      const body = el("span", "handoff-his-body");
      body.append(when, text);
      row.append(tick, body);
      if (m.text.length > LONG_MESSAGE || m.text.includes("\n")) {
        text.classList.add("clamped");
        const more = el("button", "handoff-his-more", "more");
        more.type = "button";
        more.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const open = text.classList.toggle("clamped") === false;
          more.textContent = open ? "less" : "more";
        });
        body.append(more);
      }
      list.append(row);
    }
    details.append(list);
    box.append(details);
  } else if (carry.messages > 0) {
    box.append(el("div", "handoff-line", `All ${carry.messages} of your messages in this chat are quoted in the hand-off.`));
  }

  if (!emptyArtifacts(carry.artifacts)) {
    const { details, summary } = keptDetails("handoff-made", `fold:${chat}|${index}|made`);
    summary.textContent = `Nightloom adds what this chat touched, from its tool calls: ${artifactsSummary(carry.artifacts)}`;
    details.append(el("div", "handoff-made-text", artifactsText(carry.artifacts)));
    box.append(details);
  }
  if (carry.missing !== null) {
    box.append(
      el(
        "div",
        carry.missing.length ? "handoff-line handoff-warn" : "handoff-line",
        carry.missing.length
          ? `HANDOFF.md section: ${SECTIONS.length - carry.missing.length} of ${SECTIONS.length} fixed sections written — missing: ${carry.missing.join("; ")}`
          : `HANDOFF.md section: all ${SECTIONS.length} fixed sections written (${SECTIONS.map((s) => s.split(" (")[0]).join(" · ")})`,
      ),
    );
  }
  const cost = costText(carry.cost);
  if (cost) box.append(el("div", "handoff-line handoff-cost", `${cost}.`));
  return box;
}

/** Put the carry block in the row, or take it out; rebuilt only when what it
 *  shows changed, so a goal being typed and a list being ticked stay put. */
function syncCarry(row: HTMLElement, next: NextChat, read: () => NextChat | null | undefined): void {
  const have = row.querySelector<HTMLElement>(`:scope > .${CARRY_CLASS}`);
  if (!next.carry) {
    have?.remove();
    return;
  }
  let box = have;
  if (!box || box.dataset.sig !== carrySig(next)) {
    box = carryBlock(next, read);
    if (have) have.replaceWith(box);
    else row.prepend(box);
  }
  for (const c of Array.from(box.querySelectorAll<HTMLInputElement>("input"))) {
    if (c.disabled !== next.used) c.disabled = next.used;
  }
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
  syncCarry(row, next, read);
  const details = row.querySelector<HTMLDetailsElement>(":scope > details.handoff-order");
  const body = row.querySelector(":scope > .handoff-order > .handoff-order-text");
  const b = row.querySelector<HTMLButtonElement>(":scope > button.handoff-continue");
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
