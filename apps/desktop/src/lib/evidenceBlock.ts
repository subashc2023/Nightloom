/**
 * Evidence tables in a reply (nightshift item 798, from 793 #5) — the pure half.
 *
 * The `evidence_table` tool (`nightloom-service/src/evidence.rs`) checks every quote against its source's
 * stored text and saves `table.json`; it hands the model a fence to put in the reply:
 *
 *     ```evidence
 *     /abs/path/.agents/evidence/<slug>/table.json
 *     ```
 *
 * The fence carries the path, never the table: the model cannot retype a cell's check. marked draws a
 * closed fence as a placeholder holding the path in an attribute and the ordinary code block inside it, so a
 * surface that never draws it (the phone) shows the path, never a blank. `evidenceTables.ts` reads the file
 * and draws the table first inside the placeholder.
 */
import type { Tokens } from "marked";
import { fenceClosed } from "./replyPage";

export const EVIDENCE_CLASS = "md-evidence";
export const EVIDENCE_MOUNT_CLASS = "md-evidence-mount";

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Whether a fence's info string is an evidence block (first word only). */
export function isEvidenceFence(lang: string | undefined): boolean {
  return (lang ?? "").trim().split(/\s+/)[0].toLowerCase() === "evidence";
}

/** The table's path from the block: its first non-empty line, when it names a `.json` file by an absolute path. */
export function evidencePath(src: string): string | null {
  const line = src
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line || !line.startsWith("/") || !line.toLowerCase().endsWith(".json")) return null;
  return line;
}

/** marked's extension: a closed evidence fence as its placeholder (with its code block inside). */
export const evidenceBlock = {
  renderer: {
    code(token: Tokens.Code) {
      if (!isEvidenceFence(token.lang) || !fenceClosed(token.raw)) return false;
      const path = evidencePath(token.text);
      if (!path) return false;
      return (
        `<div class="${EVIDENCE_CLASS}" data-evidence-path="${encodeURIComponent(path)}">` +
        `<pre><code class="language-evidence">${escapeHtml(token.text)}</code></pre></div>\n`
      );
    },
  },
};

/** The path a placeholder holds. */
export function placeholderPath(el: Element): string | null {
  const raw = el.getAttribute("data-evidence-path");
  if (raw === null) return null;
  try {
    return evidencePath(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

// ---- the saved table (evidence.rs's `Table`) ----------------------------------

export type Check = "found" | "not_found" | "too_short" | "no_quote" | "no_source";

export interface EvSource {
  id: string;
  title: string;
  path?: string;
  url?: string;
  text?: string;
  pages?: number;
  chars?: number;
  error?: string;
}

export interface EvCell {
  source: string;
  question: number;
  answer: string;
  quote: string;
  locator?: string;
  check: Check;
  start?: number;
  end?: number;
  page?: number;
  section?: string;
  page_differs?: boolean;
  elsewhere?: string;
}

export interface EvTable {
  version: number;
  title: string;
  slug: string;
  checked_at: string;
  questions: string[];
  sources: EvSource[];
  cells: EvCell[];
  counts: { cells: number; found: number; not_found: number; unchecked: number; failed: number };
}

const CHECKS: Check[] = ["found", "not_found", "too_short", "no_quote", "no_source"];

/** `table.json` read back, or null when it is not one. */
export function parseTable(text: string): EvTable | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const t = v as Partial<EvTable>;
  if (!t || typeof t !== "object" || !Array.isArray(t.questions) || !Array.isArray(t.sources) || !Array.isArray(t.cells)) return null;
  if (!t.cells.every((c) => c && typeof c.source === "string" && typeof c.question === "number" && CHECKS.includes(c.check))) return null;
  return t as EvTable;
}

/** The words a check is shown in (evidence.rs's `Check::words`). */
export function checkWords(c: EvCell): string {
  const w: Record<Check, string> = {
    found: "found in source",
    not_found: "not found in source",
    too_short: "quote too short to check",
    no_quote: "no quote given",
    no_source: "source text missing",
  };
  let s = w[c.check];
  if (c.elsewhere) s += ` (it is in ${c.elsewhere})`;
  if (c.check === "found" && c.page_differs && c.page != null) s += `, on PDF page ${c.page}`;
  return s;
}

/** The locator shown: the model's, then the PDF page or the section the quote was found in. */
export function locatorWords(c: EvCell): string {
  const parts: string[] = [];
  if (c.locator) parts.push(c.locator);
  if (c.page != null && (c.page_differs || !c.locator)) parts.push(`PDF p. ${c.page}`);
  else if (c.page == null && c.section && !c.locator) parts.push(`§ ${c.section}`);
  return parts.join(" · ");
}

/** A path beside the table (`sources/S1.txt`) made absolute against the table's own path. */
export function besideTable(tablePath: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const dir = tablePath.slice(0, tablePath.lastIndexOf("/"));
  return `${dir}/${rel}`;
}

/** The note and the CSV beside a table: `<out>/<slug>.md`, `<out>/<slug>/table.csv`. */
export function tableFiles(tablePath: string): { note: string; csv: string } {
  const dir = tablePath.slice(0, tablePath.lastIndexOf("/"));
  return { note: `${dir}.md`, csv: `${dir}/table.csv` };
}

/** Rust's character offsets (Unicode scalar values) as JavaScript's (UTF-16 units) in `text`. */
export function utf16Range(text: string, start: number, end: number): [number, number] {
  let chars = 0;
  let units = 0;
  let a = -1;
  for (const ch of text) {
    if (chars === start) a = units;
    if (chars === end) return [a < 0 ? units : a, units];
    chars++;
    units += ch.length;
  }
  return [a < 0 ? units : a, units];
}

/** The table's HTML: a head line (title, totals, Note and CSV), then sources as rows and questions as
 *  columns. Every cell with a stored text carries what a click opens. Every string is escaped. */
export function tableHtml(t: EvTable, tablePath: string): string {
  const c = t.counts;
  const files = tableFiles(tablePath);
  const totals =
    `${c.found} of ${c.cells} quotes found in their source` +
    (c.not_found ? ` · <span class="ev-bad">${c.not_found} not found in source</span>` : "") +
    (c.unchecked ? ` · ${c.unchecked} not checkable` : "");
  let h =
    `<div class="ev-head"><span class="ev-title">${escapeHtml(t.title)}</span>` +
    `<span class="ev-totals">${totals}</span>` +
    `<span class="ev-files"><a class="ev-file" href="#" data-ev-open="${escapeHtml(files.note)}">Note</a>` +
    `<a class="ev-file" href="#" data-ev-open="${escapeHtml(files.csv)}">CSV</a></span></div>`;
  h += `<div class="ev-scroll"><table class="ev-table"><thead><tr><th class="ev-corner">Source</th>`;
  t.questions.forEach((q, i) => {
    h += `<th><span class="ev-qn">Q${i + 1}</span> ${escapeHtml(q)}</th>`;
  });
  h += `</tr></thead><tbody>`;
  const byId = new Map(t.sources.map((s) => [s.id, s]));
  for (const s of t.sources) {
    h += `<tr><th class="ev-src"><span class="ev-id">${escapeHtml(s.id)}</span> ${escapeHtml(s.title)}`;
    if (s.error) h += `<span class="ev-src-err">${escapeHtml(s.error)}</span>`;
    h += `</th>`;
    for (let qi = 0; qi < t.questions.length; qi++) {
      const cells = t.cells.filter((x) => x.source === s.id && x.question === qi);
      if (!cells.length) {
        h += `<td class="ev-empty">—</td>`;
        continue;
      }
      h += `<td>`;
      cells.forEach((x) => {
        const src = byId.get(x.source);
        const ok = x.check === "found";
        const open = ok && src?.text && x.start != null && x.end != null;
        const attrs = open
          ? ` data-ev-text="${escapeHtml(besideTable(tablePath, src!.text!))}" data-ev-start="${x.start}" data-ev-end="${x.end}" tabindex="0" role="button"`
          : "";
        const loc = locatorWords(x);
        h +=
          `<div class="ev-cell ${ok ? "ev-ok" : "ev-fail"}"${attrs}${open ? ` data-tip="Open ${escapeHtml(x.source)} at this quote"` : ""}>` +
          `<div class="ev-answer">${escapeHtml(x.answer)}</div>` +
          (x.quote ? `<div class="ev-quote">“${escapeHtml(x.quote)}”</div>` : "") +
          `<div class="ev-meta">${loc ? `<span class="ev-loc">${escapeHtml(loc)}</span>` : ""}` +
          `<span class="ev-mark">${ok ? "✓" : "✗ " + escapeHtml(checkWords(x))}</span></div></div>`;
      });
      h += `</td>`;
    }
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;
  return h;
}
