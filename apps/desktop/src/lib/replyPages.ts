/**
 * Item 770: `use:replyPages` on the element a reply's HTML is drawn into — mounts a `ReplyPage` card in every
 * page placeholder `replyPage.ts` left there, and unmounts it when the placeholder goes. The HTML is replaced
 * or patched by other code (`liveHtml` while a reply streams, `{@html}` on the phone), so the cards are put in
 * after each change (a MutationObserver), as the code blocks' Copy buttons are (`codeCopy.ts`). `liveHtml`
 * leaves a placeholder it already drew alone and skips what is mounted inside it (`PAGE_MOUNT_CLASS`), so a
 * page that has drawn stays drawn while the rest of the reply streams.
 */
import { mount, unmount } from "svelte";
import ReplyPage from "./ReplyPage.svelte";
import { PAGE_CLASS, PAGE_MOUNT_CLASS, pageOf } from "./replyPage";

export interface ReplyPagesOptions {
  /** Put text on the clipboard, the surface's own way (the card's Copy). */
  copy?: (text: string) => void;
  /** Mount nothing for now: the surface redraws its HTML whole as the reply arrives (the phone's live answer). */
  off?: boolean;
}

export function replyPages(node: HTMLElement, options: ReplyPagesOptions = {}) {
  let opts = options;
  const made = new Map<Element, { app: Record<string, unknown>; src: string }>();
  const drop = (el: Element) => {
    const m = made.get(el);
    if (!m) return;
    made.delete(el);
    void unmount(m.app);
    el.querySelector(`:scope > .${PAGE_MOUNT_CLASS}`)?.remove();
  };
  const dress = () => {
    for (const el of Array.from(made.keys())) if (!node.contains(el) || opts.off) drop(el);
    if (opts.off) return;
    for (const el of Array.from(node.querySelectorAll(`.${PAGE_CLASS}`))) {
      const page = pageOf(el);
      const had = made.get(el);
      if (!page) {
        if (had) drop(el);
        continue;
      }
      // The same element, a different page (the patcher re-used it): draw the new one.
      if (had && had.src === page.html && el.querySelector(`:scope > .${PAGE_MOUNT_CLASS}`)) continue;
      if (had) drop(el);
      const target = document.createElement("div");
      target.className = PAGE_MOUNT_CLASS;
      el.replaceChildren(target);
      const app = mount(ReplyPage, {
        target,
        props: { html: page.html, title: page.title, pageKey: page.key, copy: (t: string) => (opts.copy ? opts.copy(t) : void navigator.clipboard?.writeText(t)) },
      });
      made.set(el, { app, src: page.html });
    }
  };
  dress();
  const obs = new MutationObserver(dress);
  obs.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-page-src"] });
  return {
    update(next: ReplyPagesOptions = {}) {
      const woke = !!opts.off && !next.off;
      opts = next;
      if (woke || next.off) dress();
    },
    destroy() {
      obs.disconnect();
      for (const el of Array.from(made.keys())) drop(el);
    },
  };
}
