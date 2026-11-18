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

/** Mark one box as answered with his words (null: answered, words unknown). Idempotent. */
export function settleBox(box: HTMLElement, said: string | null): void {
  if (box.dataset.answered !== "1") box.dataset.answered = "1";
  const items = Array.from(box.querySelectorAll<HTMLElement>(".nl-ask-o > li"));
  const pick = said === null ? -1 : pickedOption(
    items.map((li) => li.textContent ?? ""),
    said,
  );
  items.forEach((li, i) => {
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
    if (node.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return (b.querySelector(".user-text")?.textContent ?? b.textContent ?? "").trim();
    }
  }
  return null;
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
      for (const b of boxes) if (b.dataset.answered) delete b.dataset.answered;
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
  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      watch?.disconnect();
      own.disconnect();
    },
  };
}
