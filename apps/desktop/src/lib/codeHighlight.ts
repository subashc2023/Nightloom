/*
 * Code in his messages (nightshift item 315): which language a stretch of
 * code is in, its colours, and the ``` fences that hold it.
 *
 * The highlighter is highlight.js's core with a fixed set of languages
 * (`LANGUAGES`), registered here once. Every function below draws over the
 * characters he typed or pasted and never changes them: `segments` returns
 * the code cut into coloured runs whose text, joined, is the input exactly
 * (the suite pins it).
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "./codeHighlight.css";

/** The languages the box knows, in the label menu's order: the fence's
 *  info string, the name on the label, highlight.js's own name. */
export const LANGUAGES: { id: string; label: string; hl: string }[] = [
  { id: "python", label: "Python", hl: "python" },
  { id: "cpp", label: "C++", hl: "cpp" },
  { id: "c", label: "C", hl: "c" },
  { id: "java", label: "Java", hl: "java" },
  { id: "javascript", label: "JavaScript", hl: "javascript" },
  { id: "typescript", label: "TypeScript", hl: "typescript" },
  { id: "rust", label: "Rust", hl: "rust" },
  { id: "go", label: "Go", hl: "go" },
  { id: "swift", label: "Swift", hl: "swift" },
  { id: "kotlin", label: "Kotlin", hl: "kotlin" },
  { id: "bash", label: "Shell", hl: "bash" },
  { id: "sql", label: "SQL", hl: "sql" },
  { id: "json", label: "JSON", hl: "json" },
  { id: "html", label: "HTML", hl: "xml" },
  { id: "css", label: "CSS", hl: "css" },
];

/** Languages a file tab colours that the chat's code boxes do not offer
 *  (item 380): registered with highlight.js but kept out of `LANGUAGES`, so
 *  the label menu, `languageOf` and `guessLanguage` are what they were.
 *  `ini` also reads TOML. */
const FILE_ONLY = { ini, latex, markdown, yaml };

const DEFS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, css, go, java, javascript, json, kotlin, python, rust, sql, swift, typescript, xml,
  ...FILE_ONLY,
};
for (const [name, def] of Object.entries(DEFS)) hljs.registerLanguage(name, def);

/** A fence's info string (`py`, `c++`, `Python`, `ts`) as one of
 *  `LANGUAGES`, or null when the box does not know it. */
export function languageOf(info: string): (typeof LANGUAGES)[number] | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!word) return null;
  const direct = LANGUAGES.find((l) => l.id === word || l.label.toLowerCase() === word);
  if (direct) return direct;
  const hl = hljs.getLanguage(word);
  if (!hl) return null;
  return LANGUAGES.find((l) => hljs.getLanguage(l.hl) === hl) ?? null;
}

/** A coloured run: its text and highlight.js's classes for it, innermost last. */
export type Seg = { text: string; cls: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

/** highlight.js's HTML read back into runs. It escapes the five entities
 *  above and emits only `<span class="…">` and `</span>`. */
export function htmlToSegments(html: string): Seg[] {
  const out: Seg[] = [];
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, cls: stack.join(" ") });
    buf = "";
  };
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i + 1, end);
      flush();
      if (tag.startsWith("/")) stack.pop();
      else {
        const m = /class="([^"]*)"/.exec(tag);
        stack.push(m ? m[1] : "");
      }
      i = end + 1;
    } else if (ch === "&") {
      const end = html.indexOf(";", i);
      const name = html.slice(i + 1, end);
      buf += ENTITIES[name] ?? html.slice(i, end + 1);
      i = end + 1;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return out;
}

/** `code` in coloured runs for `info` (a fence's info string); one plain
 *  run when the language is unknown. Joined, the runs are `code`. */
const memo = new Map<string, Seg[]>();
export function segments(code: string, info: string): Seg[] {
  // The box redraws on every keystroke; the blocks it redraws seldom change.
  const k = `${info}\u0000${code}`;
  const hit = memo.get(k);
  if (hit) return hit;
  const segs = segmentsUncached(code, info);
  if (memo.size > 64) memo.delete(memo.keys().next().value!);
  memo.set(k, segs);
  return segs;
}
/** Past this many characters a block is drawn plain (review fix,
 *  2026-10-05): highlighting a 2,000-line block on every keystroke in it
 *  cost ~70 ms in WebKit. ~500 lines of typical code are still coloured. */
export const HIGHLIGHT_MAX_CHARS = 20_000;
function segmentsUncached(code: string, info: string): Seg[] {
  return highlightAs(code, languageOf(info)?.hl ?? null);
}
/** `code` in runs for highlight.js's language `hl`; one plain run when
 *  `hl` is null or the code is past the cap. Joined, the runs are `code`. */
function highlightAs(code: string, hl: string | null): Seg[] {
  if (!hl || !code || code.length > HIGHLIGHT_MAX_CHARS) return code ? [{ text: code, cls: "" }] : [];
  try {
    const segs = htmlToSegments(hljs.highlight(code, { language: hl, ignoreIllegals: true }).value);
    // A guard, not an expectation: never draw characters that are not his.
    if (segs.map((s) => s.text).join("") !== code) return [{ text: code, cls: "" }];
    return segs;
  } catch {
    return [{ text: code, cls: "" }];
  }
}

/** Runs cut at line ends: one array per line of `code` (no newlines kept). */
export function segmentLines(segs: Seg[]): Seg[][] {
  const lines: Seg[][] = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ text: p, cls: s.cls });
    });
  }
  return lines;
}

/** highlight.js's guess over the box's languages, with its confidence. */
export function guessLanguage(code: string): { id: string; relevance: number } | null {
  const r = hljs.highlightAuto(code, LANGUAGES.map((l) => l.hl));
  if (!r.language) return null;
  const lang = LANGUAGES.find((l) => hljs.getLanguage(l.hl) === hljs.getLanguage(r.language!));
  return lang ? { id: lang.id, relevance: r.relevance } : null;
}

/** A file's extension (lower case) to highlight.js's language, for a file
 *  tab (item 380). Every language the chat colours, plus LaTeX, YAML,
 *  TOML/INI and Markdown. */
const BY_EXTENSION: Record<string, string> = {
  py: "python", pyw: "python", pyi: "python",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  c: "c", h: "c",
  java: "java",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  rs: "rust",
  go: "go",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql",
  json: "json", jsonc: "json", jsonl: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml",
  css: "css",
  tex: "latex", sty: "latex", cls: "latex", ltx: "latex",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini",
  md: "markdown", markdown: "markdown",
};

/** highlight.js's language for the file at `path`, by its extension; null
 *  when it has none the tab colours. */
export function languageForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** A file's text in coloured runs for a file tab (item 380): by its
 *  extension, one plain run past `HIGHLIGHT_MAX_CHARS`. Joined, the runs
 *  are `text` exactly. */
export function fileSegments(text: string, path: string): Seg[] {
  return highlightAs(text, languageForPath(path));
}
