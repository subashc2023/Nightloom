/**
 * A Copy button on every code block in a reply (backlog 384). The reply's
 * HTML is sanitized and replaced while it streams, so the buttons are put
 * in after each render (a MutationObserver) rather than in the HTML.
 * Copies the block's `<code>` text, never the button's.
 */

/** The text Copy puts on the clipboard: the block's code, as shown. */
export function codeText(pre: Element): string {
  const code = pre.querySelector("code");
  return (code ?? pre).textContent ?? "";
}

/** Adds a Copy button to each `pre` under `root` that has none. */
export function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    // Inside the `pre`, never moving it: Svelte's {@html} owns these nodes.
    if (pre.querySelector(":scope > .code-copy")) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-copy";
    b.textContent = "Copy";
    b.setAttribute("data-tip", "Copy this block");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard?.writeText(codeText(pre)).then(() => {
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = "Copy"), 1500);
      });
    });
    pre.appendChild(b);
  }
}

/** Svelte action for a reply's `.markdown` element. */
export function codeCopy(node: HTMLElement) {
  addCopyButtons(node);
  const obs = new MutationObserver(() => addCopyButtons(node));
  obs.observe(node, { childList: true, subtree: true });
  return { destroy: () => obs.disconnect() };
}
