/**
 * A Copy button on every code block in a reply (backlog 384). The reply's
 * HTML is sanitized and replaced while it streams, so the buttons are put
 * in after each render (a MutationObserver) rather than in the HTML.
 * Copies the block's `<code>` text, never the button's.
 */

import { flashCopied, setCopyState } from "./copyIcon";
import { endsInOpenFence, isShellClass } from "./shellRun";

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

/**
 * Run beside Copy on a shell block, once it is whole: only the last `pre` can
 * be the fence the reply is still in, so that one waits.
 */
export function addRunButtons(root: HTMLElement, run: RunBlocks | null | undefined): void {
  const onRun = run?.onRun;
  if (!onRun) return;
  const all = Array.from(root.querySelectorAll("pre"));
  const open = endsInOpenFence(run.text, run.streaming);
  all.forEach((pre, i) => {
    if (pre.querySelector(":scope > .code-run")) return;
    if (open && i === all.length - 1) return;
    const code = pre.querySelector(":scope > code");
    if (!code || !isShellClass(code.className)) return;
    const command = codeText(pre).trim();
    if (!command) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-run";
    b.textContent = "Run";
    b.setAttribute("aria-label", RUN_BLOCK);
    b.title = RUN_BLOCK;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      setTimeout(() => (b.disabled = false), RUN_PRESSED_MS);
      onRun(codeText(pre).trim());
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
    addRunButtons(node, params);
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
