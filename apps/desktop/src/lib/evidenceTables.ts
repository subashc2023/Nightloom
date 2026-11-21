/**
 * Evidence tables drawn (nightshift item 798) — the DOM half of `evidenceBlock.ts`.
 *
 * `installEvidence()` runs once per window (the Mac's `main.ts`) and draws every evidence placeholder that
 * appears anywhere in the document — a reply in either look, an aside, a note, a markdown file tab — so no
 * call site has to remember it (the same shape as 821's `installDiagrams`). The table is read from its
 * `table.json` through `read_file_tab` (inside the chat's folders, where the tool saved it) and put first
 * inside the placeholder, beside the block's own code, which stays hidden while the table shows; `liveHtml`
 * skips it (`EVIDENCE_MOUNT_CLASS`), so a drawn table stays drawn while the rest of a reply streams.
 *
 * A click on a cell whose quote was found opens the source's stored text in a file tab, scrolled to the quote
 * and marked (`fileFind.svelte.ts`, read by `FileView`); Note and CSV open those files. A table that cannot
 * be read leaves the block as it is, with the reason under it.
 */
import { EVIDENCE_CLASS, EVIDENCE_MOUNT_CLASS, parseTable, placeholderPath, tableHtml } from "./evidenceBlock";
import * as api from "./api";
import { addToast, app, openContent } from "./state.svelte";
import { noteForPath } from "./cards";
import { findInFile } from "./fileFind.svelte";
import "./evidence.css";

const SKIP = "[data-quote-render], .ta-mirror";

/** The last drawing of each table path, so a remount (a tab switch) draws at once; it is then read again and
 *  redrawn if the file changed (a re-check under the same name rewrites it). */
const cache = new Map<string, string>();

function placeholdersIn(nodes: Iterable<Node>): Element[] {
  const out: Element[] = [];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    if (el.classList.contains(EVIDENCE_CLASS)) out.push(el);
    else if (el.firstElementChild) out.push(...Array.from(el.getElementsByClassName(EVIDENCE_CLASS)));
  }
  return out;
}

async function read(path: string): Promise<{ html: string } | { error: string }> {
  try {
    const f = await api.readFileTab(path, app.activeSessionId);
    const t = f.text != null ? parseTable(f.text) : null;
    if (!t) return { error: "this file is not an evidence table" };
    const html = tableHtml(t, path);
    cache.set(path, html);
    return { html };
  } catch (e) {
    return { error: String(e) };
  }
}

/** The HTML each mounted table was drawn from. */
const drawnFrom = new WeakMap<Element, string>();

function draw(el: Element, path: string, got: { html: string } | { error: string }): void {
  const mounted = el.querySelector<HTMLElement>(`:scope > .${EVIDENCE_MOUNT_CLASS}`);
  if (mounted && "html" in got && mounted.getAttribute("data-for") === path && drawnFrom.get(mounted) === got.html) return;
  mounted?.remove();
  el.querySelector(":scope > .ev-error")?.remove();
  el.classList.remove("ev-drawn");
  if ("error" in got) {
    const p = document.createElement("p");
    p.className = "ev-error";
    p.textContent = `The evidence table could not be drawn: ${got.error}`;
    el.appendChild(p);
    return;
  }
  const mount = document.createElement("div");
  mount.className = EVIDENCE_MOUNT_CLASS;
  mount.setAttribute("data-for", path);
  mount.innerHTML = got.html;
  drawnFrom.set(mount, got.html);
  el.insertBefore(mount, el.firstChild);
  el.classList.add("ev-drawn");
}

async function dress(el: Element): Promise<void> {
  const path = placeholderPath(el);
  if (!path) return;
  const kept = cache.get(path);
  if (kept !== undefined) draw(el, path, { html: kept });
  const got = await read(path);
  if (!el.isConnected) return;
  // A table drawn before keeps its drawing when a later read fails.
  if ("error" in got && kept !== undefined) return;
  draw(el, path, got);
}

async function openPath(path: string): Promise<void> {
  const note = noteForPath(path, { project: app.project?.notes_dir, knowledge: app.knowledge?.dir });
  if (note) {
    await openContent({ kind: "note", ...note });
    return;
  }
  const chat = app.activeSessionId;
  await openContent(chat ? { kind: "file", path, session: chat } : { kind: "file", path });
}

/** A cell's click: the stored text at the quote. */
async function openCell(cell: HTMLElement): Promise<void> {
  const path = cell.getAttribute("data-ev-text");
  const start = Number(cell.getAttribute("data-ev-start"));
  const end = Number(cell.getAttribute("data-ev-end"));
  if (!path || !Number.isFinite(start) || !Number.isFinite(end)) return;
  findInFile(path, start, end);
  try {
    await openPath(path);
  } catch (e) {
    addToast(String(e));
  }
}

function onClick(e: MouseEvent): void {
  const t = e.target as Element | null;
  if (!t || !t.closest(`.${EVIDENCE_MOUNT_CLASS}`)) return;
  const file = t.closest("[data-ev-open]");
  if (file) {
    e.preventDefault();
    e.stopPropagation();
    void openPath(file.getAttribute("data-ev-open") ?? "").catch((err) => addToast(String(err)));
    return;
  }
  // A selection being made in a cell (to copy a quote) is not a click on it.
  if (String(window.getSelection?.() ?? "").length > 0) return;
  const cell = t.closest<HTMLElement>("[data-ev-text]");
  if (cell) {
    e.preventDefault();
    void openCell(cell);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cell = (e.target as Element | null)?.closest?.<HTMLElement>(`.${EVIDENCE_MOUNT_CLASS} [data-ev-text]`);
  if (!cell) return;
  e.preventDefault();
  void openCell(cell);
}

let installed = false;

export function installEvidence(): void {
  if (installed || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  installed = true;
  const due = new Set<Element>();
  let queued = false;
  const scan = () => {
    queued = false;
    const els = Array.from(due);
    due.clear();
    for (const el of els) if (el.isConnected && !el.closest(SKIP)) void dress(el);
  };
  const start = () => {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") due.add(r.target as Element);
        else for (const el of placeholdersIn(r.addedNodes)) due.add(el);
      }
      if (due.size && !queued) {
        queued = true;
        queueMicrotask(scan);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-evidence-path"] });
    for (const el of Array.from(document.getElementsByClassName(EVIDENCE_CLASS))) due.add(el);
    scan();
    // Capture, so the reply's own link handler never sees the Note/CSV links' `#`.
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
