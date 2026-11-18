/**
 * Point at it (nightshift item 797, 793 §4 #4): what a picked element is,
 * read off the page, and the words the model is sent about it. Pure — the
 * DOM is read through the element given, nothing global but the root's
 * data attributes — so the suite can pin it with happy-dom.
 *
 * **The component.** Svelte scopes a component's styles with one class on
 * every element it draws; `svelte.config.js` (item 797) makes that class
 * `svelte-<hash>-<Name>`, so the nearest one up the tree names the
 * `.svelte` file. A component with no <style> has no class, so the chain
 * names the nearest components that have one — said so in the words.
 *
 * **The selector** is a path of up to five steps from the element up,
 * each `tag.class.class` with the scoping classes left out (they are in
 * the component line), an id or a `data-*` / `aria-label` where there is
 * one: what a grep of the source finds.
 */

/** What a pick holds — on the chip, in the drafts store, in the words. */
export interface PickInfo {
  /** Where it was picked: Nightloom's own window, or Claude's browser tab. */
  where: "nightloom" | "browser";
  /** The nearest components first (`Composer`, `ChatView`, …). */
  components: string[];
  selector: string;
  tag: string;
  /** Its visible text, trimmed and cut to `TEXT_MAX`. */
  text: string;
  /** `aria-label`, `title`, `role`, a tooltip — what names it. */
  label: string;
  /** Its box in CSS pixels, from the window's top left, at `zoom`. */
  rect: { x: number; y: number; w: number; h: number };
  /** The window's size in CSS pixels then. */
  viewport: { w: number; h: number };
  /** The app's zoom label ("100%"), or the browser's page scale. */
  zoom: string;
  /** Jarvis or Classic, the colour scheme and palette — the root's marks. */
  theme: string;
  /** The page's address, for a pick in Claude's browser. */
  url?: string;
}

export const TEXT_MAX = 240;
const STEPS = 5;
const SCOPE = /^svelte-[a-z0-9]+-([A-Za-z_$][\w$]*)$/;
const BARE_SCOPE = /^svelte-[a-z0-9]+$/;

/** The component a scoping class names, or null. */
export function componentOfClass(c: string): string | null {
  return SCOPE.exec(c)?.[1] ?? null;
}

/** The components up the tree from `el`, nearest first, each once. */
export function componentsOf(el: Element | null, max = 4): string[] {
  const out: string[] = [];
  for (let e: Element | null = el; e && out.length < max; e = e.parentElement) {
    for (const c of Array.from(e.classList)) {
      const n = componentOfClass(c);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

function cssIdent(s: string): string {
  return s.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

/** One step of the path: tag, id, own classes, a naming attribute. */
function step(e: Element): string {
  let s = e.tagName.toLowerCase();
  if (e.id && !/\d{4,}/.test(e.id)) return `${s}#${cssIdent(e.id)}`;
  const own = Array.from(e.classList).filter((c) => !SCOPE.test(c) && !BARE_SCOPE.test(c));
  for (const c of own.slice(0, 3)) s += `.${cssIdent(c)}`;
  const aria = e.getAttribute("aria-label");
  if (aria && aria.length <= 40) s += `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
  else {
    const data = Array.from(e.attributes).find((a) => a.name.startsWith("data-") && a.name !== "data-tip" && a.value.length <= 30);
    if (data) s += data.value ? `[${data.name}="${data.value.replace(/"/g, '\\"')}"]` : `[${data.name}]`;
  }
  return s;
}

/** A path of up to five steps from `el` up, outermost first. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && parts.length < STEPS; e = e.parentElement) {
    if (e.tagName === "BODY" || e.tagName === "HTML") break;
    parts.unshift(step(e));
    if (e.id) break;
  }
  return parts.join(" > ");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Its text, cut to `TEXT_MAX` with an ellipsis. */
export function textOf(el: Element): string {
  const raw =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value || el.placeholder
      : ((el as HTMLElement).innerText ?? el.textContent ?? "");
  const t = squash(raw ?? "");
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

/** What names it: aria-label, title, tooltip, role — the first that is there. */
export function labelOf(el: Element): string {
  const parts: string[] = [];
  const role = el.getAttribute("role");
  for (const a of ["aria-label", "title", "data-tip", "alt", "placeholder"]) {
    const v = el.getAttribute(a);
    if (v) {
      parts.push(`${a}="${squash(v).slice(0, 80)}"`);
      break;
    }
  }
  if (role) parts.push(`role=${role}`);
  return parts.join(" ");
}

/** The theme as the root marks it: layout, scheme, palette. */
export function themeOf(root: HTMLElement): string {
  const d = root.dataset;
  const layout = d.layout === "classic" ? "Classic" : "Jarvis";
  const bits = [layout];
  if (d.scheme) bits.push(d.scheme);
  if (d.palette) bits.push(`palette ${d.palette}`);
  return bits.join(", ");
}

/** Everything a pick in Nightloom's own window holds but the crop. */
export function describe(
  el: Element,
  at: { zoom: string; viewport: { w: number; h: number }; root: HTMLElement },
): PickInfo {
  const r = el.getBoundingClientRect();
  return {
    where: "nightloom",
    components: componentsOf(el),
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    text: textOf(el),
    label: labelOf(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: at.viewport,
    zoom: at.zoom,
    theme: themeOf(at.root),
  };
}

/** The chip's short line: "Composer · button · 32×28". */
export function pickLine(p: PickInfo): string {
  const who = p.components[0] ?? (p.where === "browser" ? "page" : p.tag);
  return `${who} · ${p.tag} · ${p.rect.w}×${p.rect.h}`;
}

/** The chip's file name for the crop. */
export function pickName(p: PickInfo, n: number): string {
  const who = (p.components[0] ?? p.tag).replace(/[^\w-]/g, "");
  return `pick-${n}-${who}.png`;
}

/**
 * The words the model is sent with the crop: one short block, so it can
 * name the file from it alone. `image` is the crop's place among the
 * turn's images (1-based), or null when it was dropped.
 */
export function pickText(p: PickInfo, image: number | null): string {
  const lines: string[] = [];
  const place = p.where === "browser" ? "in Claude's browser tab" : "in Nightloom's own window";
  lines.push(`Picked element ${place}${image ? ` — the crop is image ${image}` : ""}:`);
  if (p.where === "nightloom") {
    lines.push(
      p.components.length > 0
        ? `- component: ${p.components.map((c) => `${c}.svelte`).join(" inside ")} (nearest first; components without styles are not named)`
        : "- component: not known (no scoped component around it)",
    );
  }
  if (p.url) lines.push(`- page: ${p.url}`);
  lines.push(`- selector: ${p.selector || p.tag}`);
  if (p.label) lines.push(`- names: ${p.label}`);
  lines.push(`- text: ${p.text ? JSON.stringify(p.text) : "(none)"}`);
  lines.push(
    `- box: ${p.rect.w}×${p.rect.h} at (${p.rect.x}, ${p.rect.y}) CSS px in a ${p.viewport.w}×${p.viewport.h} window, zoom ${p.zoom}`,
  );
  if (p.where === "nightloom") lines.push(`- theme: ${p.theme}`);
  return lines.join("\n");
}

/** The crop's box in the shot's pixels: the element and `pad` CSS px
 *  around it, clamped to the shot. `scale` is shot pixels per CSS px. */
export function cropBox(
  rect: PickInfo["rect"],
  scale: number,
  shot: { w: number; h: number },
  pad = 8,
): { sx: number; sy: number; sw: number; sh: number } {
  const x0 = Math.max(0, Math.floor((rect.x - pad) * scale));
  const y0 = Math.max(0, Math.floor((rect.y - pad) * scale));
  const x1 = Math.min(shot.w, Math.ceil((rect.x + rect.w + pad) * scale));
  const y1 = Math.min(shot.h, Math.ceil((rect.y + rect.h + pad) * scale));
  return { sx: x0, sy: y0, sw: Math.max(1, x1 - x0), sh: Math.max(1, y1 - y0) };
}

/** Whether a stored value is a pick (the drafts store reads it back). */
export function isPickInfo(v: unknown): v is PickInfo {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  const r = p.rect as Record<string, unknown> | undefined;
  return (
    (p.where === "nightloom" || p.where === "browser") &&
    Array.isArray(p.components) &&
    typeof p.selector === "string" &&
    typeof p.text === "string" &&
    !!r &&
    typeof r.w === "number" &&
    typeof r.h === "number"
  );
}

/** The documents a turn carries for its picks' crops: one text block each,
 *  after his own documents. `chips` in send order; images are counted as the
 *  wire counts them, so "image N" points at the right crop. */
export function pickDocuments(
  chips: readonly { kind: string; data?: string; pending?: boolean; pick?: PickInfo }[],
): { media_type: string; name: string; data: string }[] {
  const out: { media_type: string; name: string; data: string }[] = [];
  let image = 0;
  for (const c of chips) {
    if (c.kind === "image") image += 1;
    // A pick with no crop is a text chip already holding these words.
    if (!c.pick || c.kind !== "image") continue;
    const body = pickText(c.pick, image);
    out.push({ media_type: "text/plain", name: `picked-element-${out.length + 1}.txt`, data: utf8Base64(body) });
  }
  return out;
}

/** UTF-8 text as base64 (the wire's documents are base64). */
export function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
