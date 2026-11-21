/**
 * Item 875: pictures and video drawn where the reply places them. A local
 * markdown image, `![caption](path)`, leaves a placeholder in the reply's
 * HTML (`markdown.ts`'s `localImageAsText`); `use:replyMediaInline` on the
 * element the HTML is drawn into mounts 820's `ReplyMedia` there, with that
 * one picture — same reads, same rules, same size cap and full-size view.
 * The placeholder lands the moment marked parses the image (its `)` has
 * arrived), so a picture shows while the reply is still streaming; the
 * patcher (`liveHtml`) keeps the placeholder and skips the mount, as it does
 * a page's (`replyPages.ts`).
 *
 * A picture only named by its path stays in 820's strip under the reply;
 * `stripMedia` is that strip's list with the pictures drawn in place left
 * out, so one image named both ways draws once, where the reply put it.
 */
import { mount, unmount } from "svelte";
import ReplyMedia from "./ReplyMedia.svelte";
import { inlineMediaTargets, localMediaTarget, MEDIA_CLASS } from "./markdown";
import { mediaCandidates, mediaKindOf, resolveMedia, type MediaCandidate } from "./replyMedia";
import "./replyMediaInline.css";

export const MEDIA_MOUNT_CLASS = "md-media-mount";

export interface ReplyMediaInlineOptions {
  /** The chat whose rules read the file (the Mac's or the phone's loader). */
  chat: string | null;
  /** The chat's folders, the first resolving a relative path; `[]` on the phone (the Mac resolves it). */
  roots?: string[];
  label?: (c: MediaCandidate) => string;
  /** Open the file as a tab (the Mac); absent on the phone. */
  onopen?: (path: string, e?: MouseEvent) => void;
  /** Mount nothing: the alt text stays (a phone host without the media route). */
  off?: boolean;
}

/** The candidate a placeholder stands for, or null if it is not a picture or a video. */
export function inlineCandidate(el: Element, roots: string[]): MediaCandidate | null {
  const raw = el.getAttribute("data-media-src");
  if (raw === null) return null;
  let href: string;
  try {
    href = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const written = localMediaTarget(href);
  const kind = mediaKindOf(written);
  if (!kind) return null;
  return { written, path: resolveMedia(written, roots), kind, explicit: true };
}

/** 820's strip for a reply's text, without what the reply draws in place. */
export function stripMedia(text: string, roots: string[]): MediaCandidate[] {
  const inline = inlineMediaTargets(text);
  if (inline.length === 0) return mediaCandidates(text, roots);
  const drawn = new Set(inline.map((w) => resolveMedia(w, roots)));
  return mediaCandidates(text, roots).filter((c) => !drawn.has(c.path));
}

export function replyMediaInline(node: HTMLElement, options: ReplyMediaInlineOptions) {
  let opts = options;
  const made = new Map<Element, { app: Record<string, unknown>; key: string }>();
  const keyOf = (c: MediaCandidate) => `${opts.chat ?? ""}\0${c.path}\0${c.written}`;
  const drop = (el: Element) => {
    const m = made.get(el);
    if (!m) return;
    made.delete(el);
    void unmount(m.app);
    el.querySelector(`:scope > .${MEDIA_MOUNT_CLASS}`)?.remove();
  };
  const dress = () => {
    for (const el of Array.from(made.keys())) if (!node.contains(el) || opts.off) drop(el);
    if (opts.off) return;
    for (const el of Array.from(node.querySelectorAll(`.${MEDIA_CLASS}`))) {
      const c = inlineCandidate(el, opts.roots ?? []);
      const had = made.get(el);
      if (!c) {
        if (had) drop(el);
        continue;
      }
      const key = keyOf(c);
      if (had && had.key === key && el.querySelector(`:scope > .${MEDIA_MOUNT_CLASS}`)) continue;
      if (had) drop(el);
      // The redrawn HTML (the phone's `{@html}`) may have brought a fresh
      // placeholder whose old mount was thrown away with it.
      el.querySelector(`:scope > .${MEDIA_MOUNT_CLASS}`)?.remove();
      const target = document.createElement("span");
      target.className = MEDIA_MOUNT_CLASS;
      el.insertBefore(target, el.firstChild);
      const app = mount(ReplyMedia, {
        target,
        props: { items: [c], chat: opts.chat, label: opts.label, onopen: opts.onopen, inline: true },
      });
      made.set(el, { app, key });
    }
  };
  dress();
  const obs = new MutationObserver(dress);
  obs.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-media-src"] });
  return {
    update(next: ReplyMediaInlineOptions) {
      const changed = next.chat !== opts.chat || next.off !== opts.off || (next.roots ?? []).join("\0") !== (opts.roots ?? []).join("\0");
      opts = next;
      if (changed) {
        for (const el of Array.from(made.keys())) drop(el);
        dress();
      }
    },
    destroy() {
      obs.disconnect();
      for (const el of Array.from(made.keys())) drop(el);
    },
  };
}
