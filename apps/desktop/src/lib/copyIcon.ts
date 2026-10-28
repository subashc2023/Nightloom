/**
 * The copy icon for Copy buttons built as DOM rather than Svelte (item 402):
 * reply code blocks (`codeCopy.ts`) and the phone page's code blocks
 * (`remote/codeBlocks.ts`). The same glyphs `Icon.svelte` draws for
 * `copy` and `check`, so every Copy in the app is the one his own messages
 * already carry. Self-styled (stroke attributes and an inline size on the
 * SVG), because the phone page does not load `app.css`'s `.ns-ico`, and on
 * the desktop `.ns-ico`'s 14px would otherwise override another size.
 */
import { ICONS } from "./icons";

/** How long a Copy button shows the check after a copy (item 402: 1.5 s). */
export const COPIED_MS = 1500;

/** The copy icon's SVG, or the check's once copied. */
export function copyIconSvg(copied: boolean, size = 14): string {
  return (
    `<svg class="ns-ico" viewBox="0 0 20 20" width="${size}" height="${size}" style="width:${size}px;height:${size}px" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
    `${ICONS[copied ? "check" : "copy"]}</svg>`
  );
}

/**
 * Puts a DOM Copy button in its plain or copied state: the icon, and the
 * name a reader and the tooltip give it, since it has no word.
 */
export function setCopyState(b: HTMLElement, copied: boolean, label: string, size = 14): void {
  b.innerHTML = copyIconSvg(copied, size);
  const name = copied ? "Copied" : label;
  b.setAttribute("aria-label", name);
  b.setAttribute("data-tip", name);
  b.classList.toggle("copied", copied);
}

/** Shows the check on `b` for `COPIED_MS`, then the copy icon again. */
export function flashCopied(b: HTMLElement, label: string, size = 14): void {
  setCopyState(b, true, label, size);
  const prev = Number(b.dataset.copyTimer ?? 0);
  if (prev) clearTimeout(prev);
  b.dataset.copyTimer = String(
    setTimeout(() => {
      delete b.dataset.copyTimer;
      setCopyState(b, false, label, size);
    }, COPIED_MS),
  );
}
