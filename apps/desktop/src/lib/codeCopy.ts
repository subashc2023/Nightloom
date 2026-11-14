/**
 * A Copy button on every code block in a reply (backlog 384). The reply's
 * HTML is sanitized and replaced while it streams, so the buttons are put
 * in after each render (a MutationObserver) rather than in the HTML.
 * Copies the block's `<code>` text, never the button's.
 */

import { flashCopied, setCopyState } from "./copyIcon";
import { endsInOpenFence, hasHiddenChars, isShellClass, RUN_FENCE_ATTR, RUN_MARK } from "./shellRun";

/** The code-block Copy button's name, for a reader and the tooltip. */
export const COPY_BLOCK = "Copy this block";
/** The Run button's name (item 503). */
export const RUN_BLOCK = "Run this in a terminal tab and send the output to the chat";

/** The text Copy puts on the clipboard: the block's code, as shown. */
export function codeText(pre: Element): string {
  const code = pre.querySelector("code");
  return (code ?? pre).textContent ?? "";
}

/**
 * What Run needs from a reply (item 503): `onRun` runs a block, and is absent
 * on a surface with no terminal; `text` is the reply's source, read for a
 * fence still open; `streaming` says it may yet grow.
 */
export interface RunBlocks {
  onRun: ((command: string) => void) | null;
  text: string;
  streaming: boolean;
}

/** How long a Run stays pressed: a double click runs once. */
const RUN_PRESSED_MS = 1200;

/** What a fence may sit in: marked's own containers, bare. Anything else is a
 *  reply's raw HTML, which can clip or hide the block round the words it shows. */
const BARE_PARENTS = new Set(["OL", "UL", "LI", "BLOCKQUOTE"]);

/**
 * The command a block runs, or null if it may not: only what marked drew as a
 * shell fence (`RUN_MARK`, which raw HTML cannot carry), with text alone in
 * its `code`, nothing hidden in that text, and nothing in the reply placed to
 * hide part of it. Read when the button is drawn and again at the click.
 */
function runCommand(pre: Element, root: Element): string | null {
  if (pre.getAttribute(RUN_FENCE_ATTR) !== RUN_MARK) return null;
  const code = pre.querySelector(":scope > code");
  if (!code || code.children.length > 0 || !isShellClass(code.className)) return null;
  for (let el = pre.parentElement; el && el !== root; el = el.parentElement) {
    if (!BARE_PARENTS.has(el.tagName) || el.hasAttribute("style") || el.hasAttribute("hidden") || el.hasAttribute("class")) return null;
  }
  if (root.querySelector("style")) return null;
  const text = code.textContent ?? "";
  if (hasHiddenChars(text)) return null;
  return text.trim() || null;
}

/**
 * Item 636: whether marked drew any text after `pre` — in its parents, up to
 * `root`. A fence marked has closed and gone past is whole: later text cannot
 * reopen it. Read from the DOM (marked's own verdict), never from a scan of
 * the source, which 503 review 10 found has gaps. Text, not elements, so the
 * motion's shuttle (empty, aria-hidden) never counts.
 */
function drawnAfter(pre: Element, root: Element): boolean {
  for (let el: Element | null = pre; el && el !== root; el = el.parentElement) {
    const kids = Array.from(el.parentElement?.childNodes ?? []);
    for (const n of kids.slice(kids.indexOf(el) + 1)) if ((n.textContent ?? "").trim()) return true;
  }
  return false;
}

/**
 * Run beside Copy on a shell block, once it is whole: only the last `pre` can
 * be the fence the reply is still in, so that one waits while the reply
 * streams until marked draws text after it (item 636: before, it waited for
 * the turn's end), or if the reply was cut off inside it. A block that no longer qualifies
 * loses its button: `liveHtml` re-uses a `pre` for whatever comes next at its
 * place. `read` is the reply as it stands, so a click goes by what is drawn
 * then, never by what was when the button was made.
 */
export function addRunButtons(root: HTMLElement, read: () => RunBlocks | null | undefined): void {
  const run = read();
  const all = Array.from(root.querySelectorAll("pre"));
  const last = all[all.length - 1];
  const open = !!run && ((run.streaming && !(last && drawnAfter(last, root))) || endsInOpenFence(run.text));
  all.forEach((pre, i) => {
    const have = pre.querySelector(":scope > .code-run");
    if (!run?.onRun || (open && i === all.length - 1) || runCommand(pre, root) === null) {
      have?.remove();
      return;
    }
    if (have) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-run";
    b.textContent = "Run";
    b.setAttribute("aria-label", RUN_BLOCK);
    b.title = RUN_BLOCK;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const onRun = read()?.onRun;
      const command = runCommand(pre, root);
      if (b.disabled || !onRun || command === null) return;
      b.disabled = true;
      setTimeout(() => (b.disabled = false), RUN_PRESSED_MS);
      onRun(command);
    });
    pre.appendChild(b);
  });
}

/** Adds a Copy button to each `pre` under `root` that has none. */
export function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    // Inside the `pre`, never moving it: Svelte's {@html} owns these nodes.
    if (pre.querySelector(":scope > .code-copy")) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-copy";
    // The copy icon, not the word (item 402); its name rides on aria-label
    // and the tooltip.
    setCopyState(b, false, COPY_BLOCK);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard?.writeText(codeText(pre)).then(() => flashCopied(b, COPY_BLOCK));
    });
    pre.appendChild(b);
  }
}

/** Svelte action for a reply's `.markdown` element. `run` gives shell blocks
 *  Run beside Copy (item 503). */
export function codeCopy(node: HTMLElement, run?: RunBlocks | null) {
  let params = run;
  const add = () => {
    addCopyButtons(node);
    addRunButtons(node, () => params);
  };
  add();
  const obs = new MutationObserver(add);
  obs.observe(node, { childList: true, subtree: true });
  return {
    update(next?: RunBlocks | null) {
      params = next;
      add();
    },
    destroy: () => obs.disconnect(),
  };
}
