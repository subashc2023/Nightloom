/**
 * Code blocks in a reply on the phone (nightshift 300 A24): a header with
 * the language and a Copy button, and a fade at the right edge while the
 * block has more to scroll to (the Claude app's code block, `inferred`).
 * An action on the element a reply's `{@html}` renders into; it re-runs when
 * the markdown re-renders (a streaming reply), and leaves a block it has
 * already dressed alone.
 */

/** The language a fenced block names (`language-ts` → "ts"), or "". */
export function codeLanguage(className: string): string {
  const m = /(?:^|\s)language-([\w#+.-]+)/.exec(className);
  return m ? m[1] : "";
}

/** Whether a block still has text to the right of what shows. */
export function moreRight(scrollLeft: number, scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth - scrollLeft > 2;
}

export function codeBlocks(node: HTMLElement, copy: (text: string) => void) {
  let onCopy = copy;
  // The fade follows the block's width too (a rotation, a font arriving).
  const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((all) => all.forEach((e) => (e.target as HTMLElement).dispatchEvent(new Event("scroll"))));
  const dress = () => {
    for (const pre of Array.from(node.querySelectorAll("pre"))) {
      if (pre.parentElement?.classList.contains("code-body")) continue;
      const code = pre.querySelector("code");
      const box = document.createElement("div");
      box.className = "code-box";
      const head = document.createElement("div");
      head.className = "code-head";
      const lang = document.createElement("span");
      lang.textContent = codeLanguage(code?.className ?? "") || "code";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onCopy((code ?? pre).textContent ?? "");
      });
      // A long-press on the button is not a long-press on the reply.
      btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
      head.append(lang, btn);
      pre.replaceWith(box);
      const body = document.createElement("div");
      body.className = "code-body";
      body.append(pre);
      box.append(head, body);
      const fade = () => body.classList.toggle("more", moreRight(pre.scrollLeft, pre.scrollWidth, pre.clientWidth));
      pre.addEventListener("scroll", fade, { passive: true });
      sized?.observe(pre);
      setTimeout(fade, 0);
    }
  };
  dress();
  const watch = new MutationObserver(() => dress());
  watch.observe(node, { childList: true, subtree: true });
  return {
    update(next: (text: string) => void) {
      onCopy = next;
    },
    destroy() {
      watch.disconnect();
      sized?.disconnect();
    },
  };
}
