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
import { artifactsSummary, artifactsText, capWords, composeFirstMessage, costText, emptyArtifacts, SECTIONS, WORDS_CAP_TOKENS, type Carry } from "./handoffCarry";
import { keptGet, keptSet } from "./keptFolds.svelte";
import { viewGet, viewSet } from "./viewState";
import { hasHiddenChars } from "./shellRun";
import { foldMotion } from "./foldMotion";
import type { SessionMeta } from "./types";
import type { HandoffOpened } from "./handoffLog";
import { placeMenu } from "./floatMenu";
import type { NextModelRow } from "./nextChatModel.svelte";
import { REVIEW_TIP, reviewBusy, reviewCancellable, reviewLabel, reviewLine, type ReviewState } from "./chatReview.svelte";

/** Item 796: "Review this chat" on the card — where its review stands, and
 *  the two things the button does (start one; open the saved page). */
export interface ReviewHook {
  state: ReviewState;
  start: () => void;
  open: (path: string) => void;
  /** Item 857: stop the running review (its Cancel). */
  cancel: () => void;
}

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
  /** Item 857: may return the click's work, so the button comes back if it
   *  did not continue (a refusal, a failure) rather than stay greyed. */
  onContinue: () => void | Promise<void>;
  /** Item 756: a minimize or a restore done on the card, with its inverse,
   *  for the chat's undo stack (⌘Z restores what a minimize folded). */
  onFold?: (minimized: boolean, undo: () => void, redo: () => void) => void;
  /** Item 796: the retrospective; absent (no button) for a chat with no
   *  Claude Code session, which has no transcript to digest. */
  review?: ReviewHook | null;
  /** Item 705: the *Next chat* model pick — the same value as the hand-off
   *  card's; absent (no button) off the Claude Code engine. */
  model?: ModelHook | null;
}

/** Item 705: what the card's model pick shows and does. */
export interface ModelHook {
  /** The model's name, and whether it is the default (this chat's). */
  name: string;
  isDefault: boolean;
  rows: NextModelRow[];
  pick: (id: string) => void;
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

// ---- item 756: the card minimized to one line ----
//
// Kept on disk (`viewState`) like the goal: a card he folded stays folded
// across a scroll, a chat switch and a relaunch (practices §7). Folding hides
// the card's parts and drops none of them: the goal and ticks are on disk
// already, and the fields stay in the page, hidden.

/** The class on a card minimized to its one line. */
export const MINIMIZED_CLASS = "handoff-minimized";
/** The – button in the card's head, and the one line a minimized card shows;
 *  `liveHtml` has no counterpart for either. */
export const MIN_CLASS = "handoff-min";
export const MINI_CLASS = "handoff-mini";

function minKey(chat: string, index: number): string {
  return `${carryKey(chat, index)}|min`;
}

export function cardMinimized(chat: string, index: number): boolean {
  return viewGet(minKey(chat, index), false);
}

export function setCardMinimized(chat: string, index: number, on: boolean): void {
  viewSet(minKey(chat, index), on, false);
}

/** What the one line says: the goal as the card's field has it, else the
 *  prompt's first line without its "Goal:" lead. */
export function miniText(next: Pick<NextChat, "chat" | "index" | "prompt" | "carry">): string {
  const typed = carryGoal(next.chat, next.index);
  const goal = (typed ?? next.carry?.goal ?? "").trim();
  if (goal) return goal;
  const first = next.prompt.split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/^\s*goal\s*:\s*/i, "").trim();
}

/** What *Continue with this prompt* sends for this card: the prompt alone
 *  without a carry, else goal, prompt, his ticked messages, the list, the cost. */
export function nextChatMessage(next: Pick<NextChat, "chat" | "index" | "prompt" | "carry">): string {
  if (!next.carry) return next.prompt;
  return composeFirstMessage(next.carry, carryGoal(next.chat, next.index));
}

/** Item 757: what the hand-off log records for this card's *Continue* — the
 *  carry, and his goal and ticks as the click reads them. */
export function cardLog(next: Pick<NextChat, "chat" | "index" | "carry">): Pick<HandoffOpened, "route" | "carry" | "goal" | "ticks"> {
  return { route: "card", carry: next.carry ?? null, goal: carryGoal(next.chat, next.index), ticks: carryTicks(next.chat, next.index) };
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

/** Item 850: ~~the tickable list~~ — his words go word for word, by
 *  themselves, within the auto hand-off's cap; one line says so. */
export function hisLine(carry: Pick<Carry, "words">): string {
  const n = carry.words.length;
  const { dropped } = capWords(carry.words);
  const lead = `Your ${n} ${n === 1 ? "message" : "messages"} since the last hand-off go${n === 1 ? "es" : ""} to the next chat word for word`;
  return dropped ? `${lead} — the oldest ${dropped} past the ${WORDS_CAP_TOKENS / 1000}k-token cap stay in this chat's log` : lead;
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
    c.words.map((m) => m.id).join(","),
    artifactsSummary(c.artifacts),
    costText(c.cost),
    c.missing === null ? "-" : c.missing.join(","),
  ].join("|");
}

/**
 * Item 747's parts of the card, above the button: the goal field, his
 * words that go word for word (item 850: one line, ~~a tickable list~~), the list Nightloom built
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

  if (carry.words.length > 0) box.append(el("div", "handoff-line handoff-his-line", hisLine(carry)));

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
    // Item 857: a click that did not continue leaves the button pressable;
    // before, it stayed greyed until something else redrew the card.
    void Promise.resolve(now.onContinue()).finally(() => {
      const after = read();
      if (b.isConnected) b.disabled = !after || after.used || after.blocked !== null;
    });
  });
  row.append(details, b);
  return row;
}

/** Item 796: the button and its line, in the row before *Continue*. */
export const REVIEW_CLASS = "handoff-review";
export const REVIEW_LINE_CLASS = "handoff-review-line";
/** Item 857: Cancel beside a running review. */
export const REVIEW_CANCEL_CLASS = "handoff-review-cancel";
export const REVIEW_CANCEL_LABEL = "Cancel review";

function syncReview(row: HTMLElement, next: NextChat, read: () => NextChat | null | undefined): void {
  let b = row.querySelector<HTMLButtonElement>(`:scope > button.${REVIEW_CLASS}`);
  let line = row.querySelector<HTMLElement>(`:scope > .${REVIEW_LINE_CLASS}`);
  let cancel = row.querySelector<HTMLButtonElement>(`:scope > button.${REVIEW_CANCEL_CLASS}`);
  const hook = next.review;
  if (!hook) {
    b?.remove();
    line?.remove();
    cancel?.remove();
    return;
  }
  if (!b) {
    b = el("button", `ns-btn ghost small ${REVIEW_CLASS}`);
    b.type = "button";
    const btn = b;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = read()?.review;
      if (!now || btn.disabled) return;
      if (now.state.phase === "saved" && now.state.path) now.open(now.state.path);
      else if (!reviewBusy(now.state)) now.start();
    });
    const go = row.querySelector(":scope > button.handoff-continue");
    if (go) go.before(btn);
    else row.append(btn);
  }
  if (!cancel) {
    cancel = el("button", `ns-btn ghost small ${REVIEW_CANCEL_CLASS}`, REVIEW_CANCEL_LABEL);
    cancel.type = "button";
    cancel.title = "Stop the review pass; nothing is saved";
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      read()?.review?.cancel();
    });
    b.before(cancel);
  }
  if (!line) {
    line = el("div", REVIEW_LINE_CLASS);
    line.setAttribute("aria-live", "polite");
    row.append(line);
  }
  const s = hook.state;
  const stoppable = reviewCancellable(s);
  if (cancel.hidden === stoppable) cancel.hidden = !stoppable;
  const label = reviewLabel(s);
  if (b.textContent !== label) b.textContent = label;
  // A review waits for a running turn as an aside would; it is not started under one.
  const blocked = s.phase !== "saved" && next.blocked !== null;
  const off = reviewBusy(s) || blocked;
  if (b.disabled !== off) b.disabled = off;
  const tip = s.phase === "saved" ? (s.path ?? "") : blocked ? (next.blocked ?? "") : REVIEW_TIP;
  if (b.title !== tip) b.title = tip;
  const text = reviewLine(s);
  if (line.textContent !== text) line.textContent = text;
  line.hidden = !text;
  line.classList.toggle("handoff-warn", s.phase === "error");
}

/** Item 705: the *Next chat* pick on the card, before Review and Continue. */
export const MODEL_CLASS = "handoff-model";
export const MODEL_MENU_CLASS = "handoff-model-menu";

/** The open menu of a card's pick, and how to close it. */
let openModelMenu: { menu: HTMLElement; close: () => void } | null = null;

function closeModelMenu(): void {
  openModelMenu?.close();
}

/** The pick's menu: the shared HUD glass (`hud-m`), fixed by the button's
 *  rectangle as `floatMenu` places the composer's menus; one row per model. */
function openMenu(btn: HTMLButtonElement, read: () => NextChat | null | undefined): void {
  closeModelMenu();
  const hook = read()?.model;
  if (!hook) return;
  const menu = el("div", `${MODEL_MENU_CLASS} hud-m`);
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "The next chat's model");
  menu.tabIndex = -1;
  menu.append(el("div", "hud-head", "The next chat's model"));
  for (const r of hook.rows) {
    const row = el("button", "handoff-model-row");
    row.type = "button";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(r.on));
    row.tabIndex = -1;
    if (r.on) row.classList.add("hud-cur");
    row.append(el("span", "handoff-model-mark", r.on ? "\u2713" : ""), el("span", "handoff-model-label", r.label));
    if (r.detail) row.append(el("span", "handoff-model-detail", r.detail));
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      read()?.model?.pick(r.id);
      close();
      btn.focus({ preventScroll: true });
    });
    menu.append(row);
  }
  document.body.append(menu);
  const p = placeMenu(btn.getBoundingClientRect(), menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight, "right");
  menu.style.top = `${p.top}px`;
  menu.style.left = `${p.left}px`;
  menu.style.maxHeight = `${p.maxHeight}px`;
  const away = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !btn.contains(t)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus({ preventScroll: true });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  function close(): void {
    window.removeEventListener("pointerdown", away, true);
    menu.removeEventListener("keydown", keys);
    menu.remove();
    btn.setAttribute("aria-expanded", "false");
    if (openModelMenu?.menu === menu) openModelMenu = null;
  }
  window.addEventListener("pointerdown", away, true);
  menu.addEventListener("keydown", keys);
  btn.setAttribute("aria-expanded", "true");
  openModelMenu = { menu, close };
  (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
}

function syncModel(row: HTMLElement, next: NextChat, read: () => NextChat | null | undefined): void {
  let b = row.querySelector<HTMLButtonElement>(`:scope > button.${MODEL_CLASS}`);
  const hook = next.model;
  if (!hook) {
    if (b && openModelMenu) closeModelMenu();
    b?.remove();
    return;
  }
  if (!b) {
    b = el("button", `ns-btn ghost small ${MODEL_CLASS}`);
    b.type = "button";
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", "The model the next chat starts on");
    b.title = "The model the next chat opens on \u2014 this chat's unless picked; the hand-off card shows the same pick";
    b.append(el("span", "handoff-model-k", "Next chat"), el("span", "handoff-model-v"), el("span", "handoff-model-note"), el("span", "handoff-model-chev", "\u25BE"));
    const btn = b;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      if (openModelMenu && btn.getAttribute("aria-expanded") === "true") closeModelMenu();
      else openMenu(btn, read);
    });
    const before =
      row.querySelector(`:scope > button.${REVIEW_CANCEL_CLASS}`) ??
      row.querySelector(`:scope > button.${REVIEW_CLASS}`) ??
      row.querySelector(":scope > button.handoff-continue");
    if (before) before.before(btn);
    else row.append(btn);
  }
  const v = b.querySelector<HTMLElement>(".handoff-model-v");
  if (v && v.textContent !== hook.name) v.textContent = hook.name;
  const note = b.querySelector<HTMLElement>(".handoff-model-note");
  const noteText = hook.isDefault ? "this chat's" : "";
  if (note && note.textContent !== noteText) note.textContent = noteText;
  if (note) note.hidden = !noteText;
  if (b.disabled !== next.used) b.disabled = next.used;
}

/** The card's key attribute, so an undo finds the card it folded wherever it is drawn now. */
const CARD_KEY = "handoffKey";

/** Show a card minimized or whole: only classes and `hidden`, so nothing in it is dropped. */
function paintCard(card: HTMLElement, on: boolean): void {
  card.classList.toggle(MINIMIZED_CLASS, on);
  const line = card.querySelector<HTMLElement>(`:scope > .${MINI_CLASS}`);
  const btn = card.querySelector<HTMLElement>(`:scope > .${MIN_CLASS}`);
  if (line && line.hidden === on) line.hidden = !on;
  if (btn && btn.hidden !== on) btn.hidden = on;
}

/** Item 756: minimize or restore the card of `chat`'s reply `index`, wherever it is drawn. */
export function foldCard(chat: string, index: number, on: boolean): void {
  setCardMinimized(chat, index, on);
  const key = `${chat}|${index}`;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>(".handoff-card"))) {
    // Item 755: the same short motion an aside's card folds with.
    if (card.dataset[CARD_KEY] === key) void foldMotion(card, () => paintCard(card, on));
  }
}

/** His click (or Enter) on the – button or the one line: fold, move the focus to
 *  what stands now, and hand the inverse to the chat's undo stack. */
function clickFold(card: HTMLElement, read: () => NextChat | null | undefined, on: boolean): void {
  const now = read();
  if (!now || cardMinimized(now.chat, now.index) === on) return;
  const { chat, index } = now;
  foldCard(chat, index, on);
  card.querySelector<HTMLElement>(`:scope > .${on ? MINI_CLASS : MIN_CLASS}`)?.focus({ preventScroll: true });
  now.onFold?.(
    on,
    () => foldCard(chat, index, !on),
    () => foldCard(chat, index, on),
  );
}

/** Item 756: the – button in the card's head and the one line it folds to. */
function syncMinimize(card: HTMLElement, next: NextChat, read: () => NextChat | null | undefined): void {
  card.dataset[CARD_KEY] = `${next.chat}|${next.index}`;
  let btn = card.querySelector<HTMLButtonElement>(`:scope > button.${MIN_CLASS}`);
  if (!btn) {
    btn = el("button", `ns-btn ghost small ${MIN_CLASS}`, "\u2013");
    btn.type = "button";
    btn.setAttribute("aria-label", "Minimize the hand-off card");
    btn.title = "Minimize to one line \u2014 click the line, or \u2318Z, to open it again";
    const b = btn;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clickFold(card, read, true);
    });
    card.prepend(b);
  }
  let line = card.querySelector<HTMLElement>(`:scope > div.${MINI_CLASS}`);
  if (!line) {
    line = el("div", MINI_CLASS);
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.title = "Open the hand-off card again";
    line.append(el("span", "handoff-mini-tag", "Hand-off"), el("span", "handoff-mini-text"), el("span", "handoff-mini-open", "open"));
    line.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clickFold(card, read, false);
    });
    line.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      clickFold(card, read, false);
    });
    card.prepend(line);
  }
  const text = miniText(next);
  const span = line.querySelector<HTMLElement>(".handoff-mini-text");
  if (span && span.textContent !== text) span.textContent = text;
  const label = `Hand-off card, minimized: ${text}. Open it`;
  if (line.getAttribute("aria-label") !== label) line.setAttribute("aria-label", label);
  paintCard(card, cardMinimized(next.chat, next.index));
}

/** A card that no longer holds the controls loses item 756's parts too. */
function clearMinimize(card: Element): void {
  for (const n of Array.from(card.querySelectorAll(`:scope > .${MIN_CLASS}, :scope > .${MINI_CLASS}`))) n.remove();
  card.classList.remove(MINIMIZED_CLASS);
  if (card instanceof HTMLElement) delete card.dataset[CARD_KEY];
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
  const card = after?.parentElement?.classList.contains("handoff-card") ? after.parentElement : null;
  for (const c of Array.from(root.querySelectorAll(".handoff-card"))) if (c !== card || !next) clearMinimize(c);
  if (!next || !after) return;
  if (!row) {
    row = goRow(next, read);
    after.after(row);
  }
  syncCarry(row, next, read);
  syncReview(row, next, read);
  syncModel(row, next, read);
  if (card) syncMinimize(card, next, read);
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
      : (next.blocked ??
        (next.review && reviewBusy(next.review.state)
          ? "Open a new chat and send this prompt now — the review keeps running and saves its page"
          : "Open a new chat and send this prompt as its first message"));
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
