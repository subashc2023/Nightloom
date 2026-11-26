/**
 * Item 851 (his words: "if it could still be like some sort of like colour behind it … clearly a different
 * section, even though it's answered"): a reply's `<ask>` box (askTag.ts) once he has answered it. The card
 * that answered it (TurnAsk) keeps its animation and goes as it always did; the box left in the reply then
 * settles into a filled card — an opaque surface and a soft shadow (app.css, `.nl-ask[data-answered]`), an
 * "Answered" mark in its head, and the answer he picked marked among the options (`data-picked`), or his
 * typed words under them (`data-said`) when they are none of the options.
 *
 * "Answered" is the rule `pendingAsk` uses: a message of his after the reply. His answer is that message's
 * words (the card sends `Label` or `Label (note: …)`, `answerText`). Only attributes are set, so liveHtml's
 * patch (which tolerates decorated nodes) and a redraw both leave it consistent: a redraw drops them and the
 * observer puts them back.
 */

/** Which option his answer picked: the longest label his words are, or begin with (a note may follow);
 *  -1 when his words are none of them. */
export function pickedOption(options: readonly string[], said: string): number {
  const s = said.trim();
  let best = -1;
  options.forEach((o, i) => {
    const label = o.trim();
    if (!label) return;
    const hit = s === label || s.startsWith(`${label} (note:`) || s.startsWith(`${label}\n`);
    if (hit && (best < 0 || label.length > options[best].trim().length)) best = i;
  });
  return best;
}

const SAID_MAX = 160;

/**
 * Item 859 (his words: "supposedly it seems like it's a question, yet there's no actual question. There's no
 * way to answer anything", and of his second shot, the box above the live card: "what was the point of this
 * shit appearing twice"). Every `<ask>` box is in exactly one of four states, and none is a dead end:
 *
 * - `answered` — a message of his follows (851's filled card, the pick marked);
 * - `live` — the question card (TurnAsk) is drawn under the transcript for it: the box is hidden, so the
 *   question shows once, as the card; it comes back as the answered card once he answers;
 * - `closed` — no answer of his, and the chat went on past it (a later question, or more words after it):
 *   a filled card that says so in one line, its options still buttons that send the pick as his next message;
 * - `open` — no answer and no card (an aside, a chat whose card is not drawn): filled, options are buttons.
 */
export type AskBoxState = "answered" | "live" | "open" | "closed";

export interface AskBoxFacts {
  /** His words after the reply; null while none follow. */
  said: string | null;
  /** The last `<ask>` box in the transcript. */
  last: boolean;
  /** A TurnAsk card is drawn in the transcript. */
  cardDrawn: boolean;
  /** Words of Claude's follow the box (in its reply or a later one). */
  laterWords: boolean;
}

/** The note a box in each state carries (the line under its options); empty for none. */
export const ASK_OPEN_NOTE = "Pick an answer to send it as your next message.";
export const ASK_CLOSED_LATER_QUESTION = "Closed without your answer — a later question replaced it. Pick one to send it now.";
export const ASK_CLOSED_LATER_WORDS = "Closed without your answer — Claude carried on past it. Pick one to send it now.";

/** Which state a box is in, and its note. */
export function askBoxState(f: AskBoxFacts): { state: AskBoxState; note: string } {
  if (f.said !== null) return { state: "answered", note: "" };
  if (f.last && f.cardDrawn) return { state: "live", note: "" };
  if (!f.last) return { state: "closed", note: ASK_CLOSED_LATER_QUESTION };
  if (f.laterWords) return { state: "closed", note: ASK_CLOSED_LATER_WORDS };
  return { state: "open", note: ASK_OPEN_NOTE };
}

/** The DOM event a box's (or a closed question card's) option sends: the transcript that can send his
 *  next message takes it (`preventDefault`) and sends `answer`; a pane, which cannot, leaves it. */
export const ASK_ANSWER_EVENT = "nl-ask-answer";
export interface AskAnswerDetail {
  answer: string;
  ask: { question: string; options: string[] };
}

/** Dispatch his pick from `from`; true when a transcript took it. */
export function sendAskAnswer(from: HTMLElement, detail: AskAnswerDetail): boolean {
  const e = new CustomEvent<AskAnswerDetail>(ASK_ANSWER_EVENT, { bubbles: true, cancelable: true, detail });
  from.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Put one unanswered box in `state` (live, open or closed): its attributes and its options' button roles. */
function markUnanswered(box: HTMLElement, state: Exclude<AskBoxState, "answered">, note: string): void {
  if (box.dataset.answered) delete box.dataset.answered;
  if (box.dataset.said !== undefined) delete box.dataset.said;
  if (box.dataset.state !== state) box.dataset.state = state;
  if (note) {
    if (box.dataset.note !== note) box.dataset.note = note;
  } else if (box.dataset.note !== undefined) delete box.dataset.note;
  const pickable = state !== "live";
  const lis = Array.from(box.querySelectorAll<HTMLElement>(".nl-ask-o > li"));
  markStack(box, lis);
  for (const li of lis) {
    if (li.dataset.picked) delete li.dataset.picked;
    if (pickable) {
      if (li.getAttribute("role") !== "button") li.setAttribute("role", "button");
      if (li.getAttribute("tabindex") !== "0") li.setAttribute("tabindex", "0");
    } else {
      li.removeAttribute("role");
      li.removeAttribute("tabindex");
    }
  }
}

/** Words of Claude's after `box`: a later sibling in its reply with text, or a later reply's words. */
function wordsAfter(box: HTMLElement, node: HTMLElement, scope: Element): boolean {
  for (let n = box.nextElementSibling; n; n = n.nextElementSibling) if (n.textContent?.trim()) return true;
  for (const m of Array.from(scope.querySelectorAll<HTMLElement>(".markdown"))) {
    if (m === node || m.closest(".user-bubble") || (m.closest(".transcript") ?? m.ownerDocument.body) !== scope) continue;
    if (node.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING && m.textContent?.trim()) return true;
  }
  return false;
}

/** Mark one box as answered with his words (null: answered, words unknown). Idempotent. */
export function settleBox(box: HTMLElement, said: string | null): void {
  if (box.dataset.answered !== "1") box.dataset.answered = "1";
  if (box.dataset.state !== "answered") box.dataset.state = "answered";
  if (box.dataset.note !== undefined) delete box.dataset.note;
  if (box.dataset.sending !== undefined) delete box.dataset.sending;
  const items = Array.from(box.querySelectorAll<HTMLElement>(".nl-ask-o > li"));
  markStack(box, items);
  const pick = said === null ? -1 : pickedOption(
    items.map((li) => li.textContent ?? ""),
    said,
  );
  items.forEach((li, i) => {
    li.removeAttribute("role");
    li.removeAttribute("tabindex");
    if (i === pick) {
      if (li.dataset.picked !== "1") li.dataset.picked = "1";
    } else if (li.dataset.picked) delete li.dataset.picked;
  });
  const typed = pick < 0 && said ? (said.length > SAID_MAX ? `${said.slice(0, SAID_MAX - 1)}…` : said) : "";
  if (typed) {
    if (box.dataset.said !== typed) box.dataset.said = typed;
  } else if (box.dataset.said !== undefined) delete box.dataset.said;
}

/** His first message after `node` in the transcript, or null while none follows. */
function nextSaid(node: HTMLElement): string | null {
  const scope = node.closest(".transcript") ?? node.ownerDocument.body;
  for (const b of Array.from(scope.querySelectorAll<HTMLElement>(".user-bubble"))) {
    // Item 859: an aside card floats inside the chat's transcript; its bubbles are not his answer here.
    if ((b.closest(".transcript") ?? b.ownerDocument.body) !== scope) continue;
    if (node.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return (b.querySelector(".user-text")?.textContent ?? b.textContent ?? "").trim();
    }
  }
  return null;
}

/**
 * Item 884, option A (his pick, "Lowk like control row more than console"; his worry: "make sure it'll still
 * look good w like longer answer choices"): short answers sit side by side as buttons; once any answer of a
 * card is longer than ASK_STACK_CHARS, every answer of that card stacks full width (the same buttons), so no
 * card mixes a short button with a wrapped one.
 */
export const ASK_STACK_CHARS = 40;
export function askStacks(options: readonly string[]): boolean {
  return options.some((o) => o.trim().length > ASK_STACK_CHARS);
}

/** Mark a box `data-stack` when its answers stack (askStacks). Idempotent. */
function markStack(box: HTMLElement, items: HTMLElement[]): void {
  const stack = askStacks(items.map((li) => li.textContent ?? ""));
  if (stack) {
    if (box.dataset.stack !== "1") box.dataset.stack = "1";
  } else if (box.dataset.stack !== undefined) delete box.dataset.stack;
}

/** Item 884: the answer number a key press names (1–9, no modifier), else 0. */
export function numberKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): number {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return 0;
  return Number(e.key);
}

/** The action on a reply's Markdown: settles its `<ask>` boxes once he has answered. */
export function askSettled(node: HTMLElement) {
  let frame = 0;
  const run = () => {
    frame = 0;
    const boxes = Array.from(node.querySelectorAll<HTMLElement>(".nl-ask"));
    if (!boxes.length) return;
    const said = nextSaid(node);
    if (said === null) {
      // Item 859: unanswered — live (the card shows it), closed, or open; never a bare dead box.
      const scope = node.closest(".transcript") ?? node.ownerDocument.body;
      // Only this transcript's own (an aside's transcript may sit inside the chat's).
      const mine = (el: Element) => (el.closest(".transcript") ?? el.ownerDocument.body) === scope;
      const all = Array.from(scope.querySelectorAll<HTMLElement>(".nl-ask")).filter(mine);
      const cardDrawn = Array.from(scope.querySelectorAll("[data-turn-ask]")).some(mine);
      for (const b of boxes) {
        const { state, note } = askBoxState({ said, last: all[all.length - 1] === b, cardDrawn, laterWords: wordsAfter(b, node, scope) });
        markUnanswered(b, state as Exclude<AskBoxState, "answered">, note);
      }
      return;
    }
    // The last block is the question the card answered; an earlier one in the same reply passed unanswered.
    boxes.forEach((b, i) => settleBox(b, i === boxes.length - 1 ? said : null));
  };
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(run);
  };
  run();
  // Watched only while the reply holds a box: his answer arrives as a new bubble below, later.
  let watch: MutationObserver | null = null;
  const arm = () => {
    const has = !!node.querySelector(".nl-ask");
    if (has && !watch) {
      watch = new MutationObserver(soon);
      watch.observe(node.closest(".transcript") ?? node.ownerDocument.body, { childList: true, subtree: true });
    } else if (!has && watch) {
      watch.disconnect();
      watch = null;
    }
  };
  arm();
  const own = new MutationObserver(() => {
    arm();
    soon();
  });
  own.observe(node, { childList: true });
  const picks = askPicks(node);
  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      watch?.disconnect();
      own.disconnect();
      picks.destroy();
    },
  };
}

/** An open or closed box's options as buttons on `node` (item 859); see `askSettled`. */
function askPicks(node: HTMLElement): { destroy(): void } {
  // Item 859: an open or closed box's option is a button — a click (or Enter / Space) sends it as his next
  // message through the transcript (ASK_ANSWER_EVENT); greyed until his message lands, or 5 s if refused.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pick = (e: Event) => {
    let li = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".nl-ask-o > li");
    const box = li?.closest<HTMLElement>(".nl-ask");
    if (!li || !box || !node.contains(box)) return;
    if (box.dataset.state !== "open" && box.dataset.state !== "closed") return;
    // Item 884: each answer shows its number key, so 1–9 on a focused answer sends that numbered answer.
    const digit = e instanceof KeyboardEvent ? numberKey(e) : 0;
    if (digit) {
      const nth = box.querySelectorAll<HTMLElement>(".nl-ask-o > li")[digit - 1];
      if (!nth) return;
      li = nth;
    } else if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (box.dataset.sending) return;
    const options = Array.from(box.querySelectorAll<HTMLElement>(".nl-ask-o > li")).map((x) => (x.textContent ?? "").trim());
    const answer = (li.textContent ?? "").trim();
    const question = (box.querySelector(".nl-ask-q")?.textContent ?? "").trim();
    if (!answer || !sendAskAnswer(box, { answer, ask: { question, options } })) return;
    box.dataset.sending = "1";
    const t = setTimeout(() => {
      timers.delete(t);
      if (box.dataset.state !== "answered") delete box.dataset.sending;
    }, 5000);
    timers.add(t);
  };
  node.addEventListener("click", pick);
  node.addEventListener("keydown", pick);
  return {
    destroy() {
      node.removeEventListener("click", pick);
      node.removeEventListener("keydown", pick);
      for (const t of timers) clearTimeout(t);
    },
  };
}

/**
 * Item 994 (the 991 follow-up; 991's shot 02 showed it): Home's reply strip draws Home's last reply with
 * `renderReply`, so an `<ask>` block came out as the "Question for you" box — and the chat's own question
 * card (TurnAskHost) sat right under it: the question twice. The strip is no transcript (`askSettled` reads
 * a transcript's bubbles and cards), so this action gives its boxes 859's states from what the strip knows:
 * the strip holds only replies after his last message (`lastExchange`), so none is answered. The last box,
 * while the card is drawn for it, is `live` (hidden: the question shows once, as the answerable card); with
 * no card (a turn still runs) it is `open`, and an earlier box, or one Claude carried on past, is `closed` —
 * both with their options as buttons that send (ASK_ANSWER_EVENT, which the strip takes).
 */
export function askInStrip(node: HTMLElement, cardDrawn: boolean) {
  let card = cardDrawn;
  const run = () => {
    const boxes = Array.from(node.querySelectorAll<HTMLElement>(".nl-ask"));
    boxes.forEach((b, i) => {
      let later = false;
      for (let n = b.nextElementSibling; n && !later; n = n.nextElementSibling) later = !!n.textContent?.trim();
      const { state, note } = askBoxState({ said: null, last: i === boxes.length - 1, cardDrawn: card, laterWords: later });
      markUnanswered(b, state as Exclude<AskBoxState, "answered">, note);
    });
  };
  run();
  // The reply is redrawn as it streams ({@html} replaces the children).
  const own = new MutationObserver(run);
  own.observe(node, { childList: true });
  const picks = askPicks(node);
  return {
    update(next: boolean) {
      card = next;
      run();
    },
    destroy() {
      own.disconnect();
      picks.destroy();
    },
  };
}

/**
 * Item 859's class (every card that asks him something): the CLI's AskUserQuestion call that closed without
 * his answer — turned down or timed out (`denied`), returned with no answer in it, or left without a result
 * when its turn ended. Null while it is still waiting or once he answered. AskAnswered draws the closed card
 * from this, its options buttons that send the pick as his next message.
 */
export function closedAskReason(
  call: { denied?: boolean; result?: { content?: string | null } | null },
  hasAnswers: boolean,
  waiting: boolean,
  ended: boolean,
): string | null {
  if (waiting || hasAnswers) return null;
  if (call.denied) return "Closed without your answer — the question was turned down or timed out before you answered.";
  if (call.result) return "Closed without your answer — the question returned with no answer in it.";
  if (ended) return "Closed without your answer — the turn ended before you answered.";
  return null;
}

/** What a pick on a closed card sends: the label alone for one question, `Header: label` for several. */
export function closedPickText(header: string, label: string, several: boolean): string {
  return several ? `${header}: ${label}` : label;
}
