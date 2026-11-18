/**
 * Pick mode (nightshift item 797): the Pick button by a message box (the
 * chat's or an aside's) or the palette's "Pick an element" turns the
 * pointer into a picker over the whole window (`PickLayer.svelte`). Each
 * click adds a chip to the box it was started from — a crop of the element
 * with what it is (`pick.ts`); pick mode stays on so several picks collect;
 * Escape, the bar's Done or the Pick button again leaves it.
 *
 * The crop is the app's own render of its window — WebKit's
 * `takeSnapshotWithConfiguration:` behind `feedback_page_shot` (item 815),
 * never a screen capture, so no Screen Recording permission and no system
 * dialog. The picker's own marks hide for two frames first.
 */
import * as api from "./api";
import { addAttachment, nextAttachmentId, readDraft } from "./drafts.svelte";
import { describe, cropBox, pickLine, pickName, pickText, utf8Base64, type PickInfo } from "./pick";
import { addToast } from "./state.svelte";
import { zoomNow } from "./zoomLevel.svelte";
import { zoomLabel } from "./zoom";
import type { Attachment } from "./types";

export const pick = $state<{
  active: boolean;
  /** The drafts key of the box the chips go to. */
  key: string;
  /** Picks made since pick mode began, for the bar. */
  made: number;
  /** The marks are hidden while the shot is taken. */
  shooting: boolean;
  /** The last box he typed in: the palette's command picks into it. */
  lastKey: string;
}>({ active: false, key: "", made: 0, shooting: false, lastKey: "" });

/** A box took the focus: the palette's Pick goes to it. */
export function noteBox(key: string): void {
  pick.lastKey = key;
}

/** Into pick mode for the box under `key` (the last box when omitted). */
export function startPick(key: string = pick.lastKey): void {
  if (!key) {
    addToast("Click into a message box first — the pick goes to it");
    return;
  }
  pick.key = key;
  pick.made = 0;
  pick.active = true;
}

/** Out of pick mode; the chips made stay in the box. */
export function stopPick(): void {
  pick.active = false;
  pick.shooting = false;
}

/** The Pick button: on, or off again if it is on for this box. */
export function togglePick(key: string): void {
  if (pick.active && pick.key === key) stopPick();
  else startPick(key);
}

const frame = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 60);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("the window's picture would not load"));
    img.src = src;
  });
}

/** The element's crop out of a shot of the window, as PNG base64. */
export async function cropFromShot(png: string, info: PickInfo): Promise<string> {
  const img = await loadImage(`data:image/png;base64,${png}`);
  const scale = img.naturalWidth / Math.max(1, info.viewport.w);
  const b = cropBox(info.rect, scale, { w: img.naturalWidth, h: img.naturalHeight });
  // Never more than 1600 px on the long side: a crop of a whole pane at
  // 2× is a big image for the model to read and says no more.
  const fit = Math.min(1, 1600 / Math.max(b.sw, b.sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(b.sw * fit));
  c.height = Math.max(1, Math.round(b.sh * fit));
  c.getContext("2d")?.drawImage(img, b.sx, b.sy, b.sw, b.sh, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

/** What `el` is, now, at the app's zoom and theme. */
export function infoOf(el: Element): PickInfo {
  return describe(el, {
    zoom: zoomLabel(zoomNow.level),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    root: document.documentElement,
  });
}

/** Add a chip for `info` with its crop `png` to the box under `key`. */
export function addPickChip(key: string, info: PickInfo, png: string | null): Attachment {
  const n = readDraft(key).attachments.filter((a) => a.pick).length + 1;
  const chip: Attachment = {
    id: nextAttachmentId(),
    kind: png ? "image" : "document",
    media_type: png ? "image/png" : "text/plain",
    name: png ? pickName(info, n) : `pick-${n}.txt`,
    // A pick with no crop still says what it was: its words are the chip.
    data: png ?? utf8Base64(pickText(info, null)),
    label: pickLine(info),
    pick: info,
  };
  addAttachment(key, chip);
  return chip;
}

/** He clicked `el` in pick mode: shoot, crop, add the chip. */
export async function takePick(el: Element): Promise<void> {
  if (pick.shooting) return;
  const key = pick.key;
  const info = infoOf(el);
  pick.shooting = true;
  let png: string | null = null;
  try {
    await frame();
    await frame();
    const shot = await api.feedbackPageShot();
    png = await cropFromShot(shot, info);
  } catch (e) {
    addToast(`Picked without a crop — ${String(e)}`);
  } finally {
    pick.shooting = false;
  }
  addPickChip(key, info, png);
  pick.made += 1;
}
