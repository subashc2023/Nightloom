/**
 * Diagram blocks drawn (nightshift item 821) — the DOM half of `diagramBlock.ts`.
 *
 * `installDiagrams()` runs once per window (the Mac's `main.ts`, the phone's `remote/main.ts`) and draws every
 * diagram placeholder that appears anywhere in the document, whichever surface put it there — a reply in either
 * look, an aside, a note, a markdown file tab, a blocker, the phone's sheets — so no call site has to remember
 * it. A drawing is put *first inside* the placeholder, beside the block's own code (which stays, hidden while the
 * drawing shows): `liveHtml` skips it (`DIAGRAM_MOUNT_CLASS`), so a drawn diagram stays drawn while the rest of
 * a reply streams, and a surface that redraws its HTML whole (the phone's live reply) gets it back at once from
 * the cache.
 *
 * Mermaid runs in one hidden, sandboxed frame per window (`allow-scripts` only, 770's kit policy: no network,
 * opaque origin), made on the first Mermaid block and never before — the library itself is 770's lazily loaded
 * kit chunk, not a second copy. The frame hands back SVG text, which is sanitised and shown as an `<img>`
 * (`svgPicture`), as a fenced SVG is. Theme: the app's colours where the block is shown; a change of palette,
 * look or light/dark draws them again.
 */
import { DIAGRAM_CLASS, DIAGRAM_MOUNT_CLASS, diagramOf, mermaidError, sourceKey, svgPicture, svgPictureOn, type Picture, type SvgBacking } from "./diagramBlock";
import { viewGet, viewSet, textKey } from "./viewState";
import { HTML_CSP_KIT, HTML_SANDBOX, type Scheme } from "./htmlPage";
import { inlineScript, loadKit, mermaidConfig, type KitTheme } from "./pageKit";
import { readKitTheme } from "./pageTheme";
import "./diagramBlock.css";

/** The tag on every message between the app and the Mermaid frame. */
export const DIAGRAM_TAG = "nightloom-diagram-821";
/** How long a drawing may take before the block shows its source and says so. */
export const DRAW_TIMEOUT_MS = 15_000;

/** `transient`: the renderer failed or was slow, not the block — not kept, so the next look draws it again. */
type Drawn = { picture: Picture; backing?: SvgBacking } | { error: string; transient?: true };

/** What the Mermaid frame runs: one drawing at a time, on request, answered by id. */
const RENDERER = `(function(){var TAG=${JSON.stringify(DIAGRAM_TAG)};
function drop(id){["d"+id,"dd"+id,"i"+id].forEach(function(x){var el=document.getElementById(x);if(el&&el.parentNode)el.parentNode.removeChild(el);});}
addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.tag!==TAG||typeof d.id!=="number")return;
var id="d"+d.id;Promise.resolve().then(function(){mermaid.initialize(d.config);return mermaid.render(id,String(d.src));}).then(function(r){
drop(d.id);parent.postMessage({tag:TAG,id:d.id,svg:String(r.svg)},"*");},function(err){drop(d.id);
parent.postMessage({tag:TAG,id:d.id,error:String((err&&(err.message||err.str))||err||"error")},"*");});});
parent.postMessage({tag:TAG,ready:true},"*");})();`;

/** The frame's document: the policy first, then Mermaid, then the renderer. */
export function rendererDocument(mermaidJs: string): string {
  return (
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${HTML_CSP_KIT}"><meta charset="utf-8"></head>` +
    `<body><script>${inlineScript(mermaidJs)}</script><script>${inlineScript(RENDERER)}</script></body></html>`
  );
}

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: { svg?: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
let chain: Promise<unknown> = Promise.resolve();

function onMessage(e: MessageEvent): void {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data as { tag?: unknown; id?: unknown; svg?: unknown; error?: unknown };
  if (!d || d.tag !== DIAGRAM_TAG || typeof d.id !== "number") return;
  const w = waiting.get(d.id);
  if (!w) return;
  waiting.delete(d.id);
  clearTimeout(w.timer);
  w.resolve(typeof d.svg === "string" ? { svg: d.svg } : { error: String(d.error ?? "error").slice(0, 2000) });
}

/** The frame, made and loaded once (and made again if a load failed). */
function rendererReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const { js } = await loadKit("mermaid");
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", HTML_SANDBOX);
    f.setAttribute("aria-hidden", "true");
    f.setAttribute("tabindex", "-1");
    f.title = "Diagram renderer";
    f.className = "md-diagram-renderer";
    // Laid out (Mermaid measures its text) but off screen and out of reach.
    f.style.cssText = "position:fixed;left:-12000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none;";
    const loaded = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The diagram renderer did not start")), DRAW_TIMEOUT_MS);
      const hello = (e: MessageEvent) => {
        if (e.source !== f.contentWindow || (e.data as { tag?: unknown; ready?: unknown })?.tag !== DIAGRAM_TAG) return;
        if (!(e.data as { ready?: unknown }).ready) return;
        clearTimeout(t);
        window.removeEventListener("message", hello);
        resolve();
      };
      window.addEventListener("message", hello);
    });
    f.srcdoc = rendererDocument(js);
    document.body.appendChild(f);
    frame = f;
    window.addEventListener("message", onMessage);
    await loaded;
  })();
  ready.catch(() => {
    frame?.remove();
    frame = null;
    ready = null;
  });
  return ready;
}

/** One Mermaid drawing, in the frame, after the ones before it. */
function drawMermaid(src: string, theme: KitTheme): Promise<Drawn> {
  const run = async (): Promise<Drawn> => {
    try {
      await rendererReady();
    } catch (e) {
      return { error: `Mermaid could not be loaded (${e instanceof Error ? e.message : String(e)})`, transient: true };
    }
    const id = nextId++;
    const win = frame?.isConnected ? frame.contentWindow : null;
    if (!win) {
      // The frame was taken out of the document: make it again on the next drawing.
      frame?.remove();
      frame = null;
      ready = null;
      return { error: "The diagram renderer stopped", transient: true };
    }
    let slow = false;
    const got = await new Promise<{ svg?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        slow = true;
        resolve({ error: "The diagram took too long to draw" });
      }, DRAW_TIMEOUT_MS);
      waiting.set(id, { resolve, timer });
      win.postMessage({ tag: DIAGRAM_TAG, id, src, config: mermaidConfig(theme, false, true) }, "*");
    });
    if (got.error !== undefined) return slow ? { error: got.error, transient: true } : { error: mermaidError(got.error) };
    const picture = svgPicture(got.svg ?? "");
    return picture ? { picture } : { error: "Mermaid drew nothing for this block" };
  };
  const p = chain.then(run, run);
  chain = p;
  return p;
}

/** Drawings by block and theme: a remount, a redraw or a tab switch shows them at once. */
const drawn = new Map<string, Drawn | Promise<Drawn>>();
const MAX_DRAWN = 200;
function remember(k: string, v: Drawn | Promise<Drawn>): void {
  drawn.delete(k);
  drawn.set(k, v);
  while (drawn.size > MAX_DRAWN) drawn.delete(drawn.keys().next().value as string);
}

function schemeNow(): Scheme {
  return document.documentElement.dataset.scheme === "light" ? "light" : "dark";
}

export interface DiagramOptions {
  /** Put text on the clipboard, the surface's own way (the Copy button). */
  copy?: (text: string) => void;
}

/** Copy with the Clipboard API where the page has it, else by hand (the phone's page over plain HTTP has not). */
function copyPlain(text: string): void {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => copyByHand(text));
      return;
    }
  } catch {
    // fall through
  }
  copyByHand(text);
}
function copyByHand(text: string): void {
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;opacity:0;left:0;top:0;";
  document.body.appendChild(t);
  t.select();
  t.setSelectionRange(0, text.length);
  try {
    document.execCommand("copy");
  } catch {
    // nothing more to try
  }
  t.remove();
}

/** Where a placeholder is left as its code block: a box being typed in (the composer's quote render, its mirror). */
const SKIP = "[data-quote-render], .ta-mirror";

function button(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "md-diagram-btn";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  // A click here is the button's, never the editor's or the transcript's (a note's drawn block, a reply's menu).
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  return b;
}

/** Draw one placeholder (its drawing first inside it). Exported for the tests. */
export function dress(el: Element, opts: DiagramOptions = {}): void {
  const d = diagramOf(el);
  if (!d) return;
  // Cheap when nothing changed (this runs on every scan): the colours are read only to draw.
  // Item 879: an SVG drawn on the theme reads the theme's text colour, so it is due again on a theme change too.
  const sig = `${d.key}|${themeEpoch}`;
  const had = el.querySelector(`:scope > .${DIAGRAM_MOUNT_CLASS}`);
  if (had && had.getAttribute("data-sig") === sig) return;
  had?.remove();
  const theme = readKitTheme(el, schemeNow());
  const drawKey = `${d.key}|${textKey(JSON.stringify(theme))}`;

  const mount = document.createElement("div");
  mount.className = DIAGRAM_MOUNT_CLASS;
  mount.setAttribute("data-sig", sig);
  const head = document.createElement("div");
  head.className = "md-diagram-head";
  const label = document.createElement("span");
  label.className = "md-diagram-label";
  label.textContent = d.kind === "mermaid" ? "Diagram" : "SVG";
  const status = document.createElement("span");
  status.className = "md-diagram-status";
  const toggle = button("Source", "Show the block's source");
  const copyBtn = button("Copy", "Copy the block's source");
  head.append(label, status, toggle, copyBtn);
  const body = document.createElement("div");
  body.className = "md-diagram-body";
  mount.append(head, body);
  el.insertBefore(mount, el.firstChild);

  let source = viewGet(sourceKey(d.key), false);
  const show = () => {
    mount.classList.toggle("is-source", source);
    toggle.textContent = source ? "Diagram" : "Source";
    const t = source ? "Show the drawing" : "Show the block's source";
    toggle.title = t;
    toggle.setAttribute("aria-label", t);
    toggle.setAttribute("aria-pressed", String(source));
  };
  show();
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    source = !source;
    viewSet(sourceKey(d.key), source, false);
    show();
  });
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = d.src;
    if (opts.copy) opts.copy(text);
    else copyPlain(text);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
  });

  const fill = (r: Drawn) => {
    if (!mount.isConnected && el.isConnected) return;
    if ("error" in r) {
      mount.classList.remove("is-drawing", "is-drawn");
      mount.classList.add("is-error");
      status.textContent = `Could not draw: ${r.error}`;
      toggle.hidden = true;
      body.replaceChildren();
      return;
    }
    mount.classList.remove("is-drawing", "is-error");
    mount.classList.add("is-drawn");
    status.textContent = "";
    const img = document.createElement("img");
    img.className = "md-diagram-img";
    // Item 879: an SVG with no background of its own and default (black) lines is drawn on white paper.
    const backing = r.backing ?? "own";
    if (backing !== "own") img.dataset.backing = backing;
    img.alt = d.kind === "mermaid" ? "Diagram (Source shows its text)" : "SVG picture (Source shows its text)";
    img.decoding = "async";
    img.draggable = false;
    if (r.picture.width !== null) {
      img.style.width = `${Math.round(r.picture.width)}px`;
      if (r.picture.height !== null) img.style.aspectRatio = `${r.picture.width} / ${r.picture.height}`;
    } else img.style.width = "100%";
    img.src = r.picture.url;
    if (backing === "paper") {
      const paper = document.createElement("span");
      paper.className = "md-diagram-paper";
      paper.append(img);
      body.replaceChildren(paper);
    } else body.replaceChildren(img);
  };

  if (d.kind === "svg") {
    const on = svgPictureOn(d.src, theme.ink);
    fill(on ? { picture: on, backing: on.backing } : { error: "The block holds no <svg> drawing" });
    return;
  }
  const hit = drawn.get(drawKey);
  if (hit && !(hit instanceof Promise)) {
    fill(hit);
    return;
  }
  mount.classList.add("is-drawing");
  status.textContent = "Drawing…";
  const p = hit ?? drawMermaid(d.src, theme);
  if (!hit) {
    remember(drawKey, p);
    void p.then((r) => ("transient" in r && r.transient ? drawn.delete(drawKey) : remember(drawKey, r)));
  }
  void p.then(fill);
}

/**
 * The placeholders among (or inside) nodes just added to the page. Text nodes — a streaming chunk, a keystroke —
 * and elements holding no placeholder (the drawing's own head and picture among them) give none, so the watcher
 * does no work for them: no document-wide query per chunk or per keystroke.
 */
export function placeholdersIn(nodes: Iterable<Node>): Element[] {
  const out: Element[] = [];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    if (el.classList.contains(DIAGRAM_CLASS)) out.push(el);
    else if (el.firstElementChild) out.push(...Array.from(el.getElementsByClassName(DIAGRAM_CLASS)));
  }
  return out;
}

/** Draw every placeholder under `root` that is not drawn for the current theme. */
export function dressAll(root: ParentNode, opts: DiagramOptions = {}): void {
  for (const el of Array.from(root.querySelectorAll(`.${DIAGRAM_CLASS}`))) {
    if (el.closest(SKIP)) continue;
    dress(el, opts);
  }
}

let installed = false;
/** Bumped when the palette, look or light/dark changes: every Mermaid drawing is due again. */
let themeEpoch = 0;

/** Watch the whole document for diagram placeholders (once per window). */
export function installDiagrams(opts: DiagramOptions = {}): void {
  if (installed || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  installed = true;
  // Only placeholders that just arrived are drawn; the whole document is scanned once at start and on a theme change.
  let all = false;
  const due = new Set<Element>();
  let queued = false;
  const scan = () => {
    queued = false;
    if (all) {
      all = false;
      due.clear();
      dressAll(document, opts);
      return;
    }
    const els = Array.from(due);
    due.clear();
    for (const el of els) if (el.isConnected && !el.closest(SKIP)) dress(el, opts);
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  };
  const start = () => {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") due.add(r.target as Element);
        else for (const el of placeholdersIn(r.addedNodes)) due.add(el);
      }
      if (due.size) soon();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-diagram-src"] });
    // A palette, look or light/dark change: the Mermaid drawings are drawn again in the new colours. Only the
    // theme attributes are watched, and drawing never writes them, so a redraw cannot set off another.
    new MutationObserver(() => {
      themeEpoch++;
      all = true;
      soon();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-palette", "data-layout", "class"] });
    all = true;
    scan();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
