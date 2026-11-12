/**
 * Item 648 (his ask, 2026-11-11): inside a ``` block in a message box the
 * keys act as a code editor's — "entering a new line respects spacing and
 * indentation", Enter inside a block makes a new line rather than sending
 * ("to send the message you either have to command enter or exit the code
 * block and click enter"), Tab indents, Enter between `{}` makes the two
 * lines, and "brackets can be autoclosed". No autocorrect (the boxes have
 * had it off everywhere since 2026-09-16). Quotes " ' ` close too —
 * "unless you're in a comment they should close tho" (his words, blocker
 * 1928) — and ' not right after a letter or digit (don't, it's).
 *
 * Pure over the text and the selection, so every box — the composer's
 * textarea and its formatted editor, the sent-message edit box, the
 * phone's boxes — applies the same answer its own way. `codeBlockEdit`
 * answers null for every key it does not take: outside a block nothing
 * changes.
 *
 * "Inside a block" (`blockAt`): the caret on a line after an opening fence
 * and before its closing one (to the end of the box while it is unclosed).
 * For Enter, also the end of the opening fence line itself, so typing
 * ```py and Enter starts the block instead of sending three backticks.
 * After the closing fence, Enter sends as before.
 *
 * Item 676 (his bug, 2026-11-12: "i cant fucking get out of the cpp code
 * block … ohh its cuz i never did the closing ```"): a block never traps
 * the caret. ```py and Enter with nothing below adds the closing fence;
 * Right at the end of an unclosed block, or Down on its last line, adds
 * the closing fence and puts the caret on a new line below; at a closed
 * block's foot Right and Down step onto the line after it (added if the
 * fence ends the text).
 */
import { isImeKey } from "./imeKey";

/** A fenced block: its opening and closing lines (null: open to the end),
 *  the opening line's start, the body's span — `codeDetect.ts`'s `Fence`
 *  without the language, whose highlighter the phone's page does not load. */
export interface Fence {
  open: number;
  close: number | null;
  start: number;
  bodyFrom: number;
  bodyTo: number;
}

const OPEN = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;

/** The fenced blocks in `text` by `codeDetect.ts`'s `findFences` rule
 *  (CommonMark's: an opening ``` or ~~~ up to three spaces in, closed by
 *  the same mark at least as long; unclosed runs to the end). The suite
 *  holds the two to the same answers. */
export function fencesOf(text: string): Fence[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    const mark = m[2];
    const closeRe = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    const close = j < lines.length ? j : null;
    const bodyFrom = i + 1 < lines.length ? starts[i + 1] : text.length;
    const bodyTo = close === null ? text.length : Math.max(bodyFrom, starts[close] - 1);
    out.push({ open: i, close, start: starts[i], bodyFrom, bodyTo });
    i = close ?? lines.length;
  }
  return out;
}

/** The parts of a key event read here (a `KeyboardEvent` is one). */
export interface BlockKey {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** One replacement of `[from, to)` by `insert`, and the selection after it
 *  (`anchor`, `head`: offsets into the text after the edit). */
export interface BlockEdit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(OPENERS));
/** An opener auto-closes only before these (or a line end), as VS Code's
 *  default does: `(` typed in front of a word stays one character. */
const CLOSE_BEFORE = /^[\s)\]};,.:]/;

interface Lines {
  starts: number[];
  ends: number[];
}

function linesOf(text: string): Lines {
  const starts = [0];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      ends.push(i);
      starts.push(i + 1);
    }
  }
  ends.push(text.length);
  return { starts, ends };
}

function lineIndex(lines: Lines, pos: number): number {
  let lo = 0;
  let hi = lines.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The fenced block the caret at `pos` is inside, or null. `body` only: a
 * line strictly between the fences (Tab and the brackets — the opening
 * line holds the info string, ```{r} among them); otherwise the end of the
 * opening fence line counts too (Enter).
 */
export function blockAt(text: string, pos: number, body = false): Fence | null {
  const lines = linesOf(text);
  const L = lineIndex(lines, pos);
  for (const f of fencesOf(text)) {
    if (L > f.open && (f.close === null || L < f.close)) return f;
    if (!body && L === f.open && pos === lines.ends[L]) return f;
    if (f.open > L) break;
  }
  return null;
}

/** The block's indent step: a tab if a body line starts with one, else
 *  the smallest step in from one non-blank line to the next (two spaces in
 *  a block written with two), else four spaces. */
export function indentUnit(text: string, f: Fence): string {
  const body = text.slice(f.bodyFrom, f.bodyTo).split("\n");
  let least = Infinity;
  let prev: number | null = null;
  for (const l of body) {
    if (l.startsWith("\t")) return "\t";
    if (l.trim() === "") continue;
    const n = /^ */.exec(l)![0].length;
    if (prev !== null && n - prev >= 2 && n - prev < least) least = n - prev;
    prev = n;
  }
  return Number.isFinite(least) ? " ".repeat(Math.min(least, 8)) : "    ";
}

/** The block both `from` and `to` are inside, or null. */
function sameBlock(text: string, from: number, to: number, body: boolean): Fence | null {
  const f = blockAt(text, from, body);
  if (!f || from === to) return f;
  const g = blockAt(text, to, body);
  return g && g.start === f.start ? f : null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * What `e` does in a box holding `text` with the selection `[start, end)`:
 * the edit to apply (the caller prevents the key's default), or null — the
 * key is not taken here, and the box does what it always did.
 */
export function codeBlockEdit(text: string, start: number, end: number, e: BlockKey): BlockEdit | null {
  if (isImeKey(e)) return null;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const chord = !!(e.metaKey || e.ctrlKey);
  if (e.key === "Enter") return chord || e.altKey ? null : enter(text, from, to);
  if (e.key === "ArrowRight") return chord || e.altKey || e.shiftKey || start !== end ? null : pastFence(text, from);
  if (e.key === "ArrowDown") return chord || e.altKey || e.shiftKey || start !== end ? null : belowBlock(text, from);
  if (chord) return isCommentKey(e) ? toggleComment(text, from, to) : null;
  if (e.key === "Tab") return e.altKey ? null : tab(text, from, to, !!e.shiftKey);
  if (e.key === "Backspace") return e.altKey || e.shiftKey ? null : backspace(text, from, to);
  if (e.key in OPENERS) return opener(text, from, to, e.key);
  if (QUOTES.has(e.key)) return quote(text, from, to, e.key);
  if (CLOSERS.has(e.key)) return closer(text, from, to, e.key);
  return null;
}

/** Enter (and Shift+Enter) inside a block: a new line at this line's
 *  indentation, one step more after `{` `(` `[` `:`, and `{|}` split into
 *  the caret's line and the closer's. */
function enter(text: string, from: number, to: number): BlockEdit | null {
  const f = sameBlock(text, from, to, false);
  if (!f) return null;
  const lines = linesOf(text);
  const L = lineIndex(lines, from);
  const before = text.slice(lines.starts[L], from);
  const indent = leadingWs(before);
  if (L === f.open) {
    // Item 676: ```py and Enter with nothing after it adds the closing
    // fence below, so the block is closed from the start and never traps
    // the caret. Not when text follows (a fence typed above lines to wrap
    // them is closed by hand where they end).
    if (f.close === null && from === to && text.slice(from).trim() === "") {
      const first = "\n" + indent;
      const ins = first + "\n" + closingFence(text, f);
      return { from, to, insert: ins, anchor: from + first.length, head: from + first.length };
    }
    const ins = "\n" + indent;
    return { from, to, insert: ins, anchor: from + ins.length, head: from + ins.length };
  }
  const unit = indentUnit(text, f);
  const prev = before.slice(-1);
  const next = text.charAt(to);
  if (prev in OPENERS && OPENERS[prev] === next) {
    const first = "\n" + indent + unit;
    const ins = first + "\n" + indent;
    return { from, to, insert: ins, anchor: from + first.length, head: from + first.length };
  }
  const last = before.trimEnd().slice(-1);
  const ins = "\n" + indent + (last in OPENERS || last === ":" ? unit : "");
  return { from, to, insert: ins, anchor: from + ins.length, head: from + ins.length };
}

/** Tab / Shift+Tab inside a block's body: a caret gets one step (Tab); a
 *  selection, or Shift+Tab, indents or outdents every line it touches
 *  (blank lines of a multi-line selection are left blank). */
function tab(text: string, from: number, to: number, out: boolean): BlockEdit | null {
  const f = sameBlock(text, from, to, true);
  if (!f) return null;
  const unit = indentUnit(text, f);
  if (!out && from === to) {
    return { from, to, insert: unit, anchor: from + unit.length, head: from + unit.length };
  }
  const lines = linesOf(text);
  const L1 = lineIndex(lines, from);
  let L2 = lineIndex(lines, to);
  // A selection ending at a line's very start does not take that line.
  if (L2 > L1 && to === lines.starts[L2]) L2--;
  const width = unit === "\t" ? 4 : unit.length;
  const parts: string[] = [];
  /** Per line: characters added (+) or removed (-) at its start. */
  const deltas: number[] = [];
  for (let L = L1; L <= L2; L++) {
    const line = text.slice(lines.starts[L], lines.ends[L]);
    if (out) {
      const cut = line.startsWith("\t") ? 1 : Math.min(/^ */.exec(line)![0].length, width);
      parts.push(line.slice(cut));
      deltas.push(-cut);
    } else if (line.trim() === "" && L1 !== L2) {
      parts.push(line);
      deltas.push(0);
    } else {
      parts.push(unit + line);
      deltas.push(unit.length);
    }
  }
  const rFrom = lines.starts[L1];
  const rTo = lines.ends[L2];
  const insert = parts.join("\n");
  if (insert === text.slice(rFrom, rTo)) return { from: rFrom, to: rFrom, insert: "", anchor: from, head: to };
  /** Where `p` lands: moved by every changed line before its own, and on
   *  its own line by the indent added past it (a selection start at the
   *  line's start stays there, taking the new indent in) or the cut. */
  const map = (p: number, isStart: boolean): number => {
    const L = lineIndex(lines, p);
    let shift = 0;
    for (let i = L1; i < Math.min(L, L2 + 1); i++) shift += deltas[i - L1];
    if (L >= L1 && L <= L2) {
      const d = deltas[L - L1];
      const col = p - lines.starts[L];
      if (d > 0) shift += col > 0 || !isStart || from === to ? d : 0;
      else shift += Math.max(d, -col);
    }
    return p + shift;
  };
  return { from: rFrom, to: rTo, insert, anchor: map(from, true), head: map(to, false) };
}

/** Backspace between an empty pair inside a block deletes both; with only
 *  spaces or tabs before the caret on its line, it deletes back to the
 *  previous indent stop (item 653). */
function backspace(text: string, from: number, to: number): BlockEdit | null {
  if (from !== to || from === 0) return null;
  const prev = text.charAt(from - 1);
  const isQuote = QUOTES.has(prev) && text.charAt(from) === prev;
  if (!isQuote && (!(prev in OPENERS) || OPENERS[prev] !== text.charAt(from))) return outdentBack(text, from);
  const f = blockAt(text, from, true);
  if (!f) return null;
  // An empty quote pair, not one in a comment (there quotes are prose).
  if (isQuote && scanTo(text, f.bodyFrom, from - 1) === "comment") return null;
  return { from: from - 1, to: from + 1, insert: "", anchor: from - 1, head: from - 1 };
}

/** Tab stops count four columns, as `tab()`'s Shift+Tab does. */
const TAB_WIDTH = 4;

/**
 * Backspace (no selection) in a block's body with only spaces/tabs before
 * the caret on its line, and at least one (item 653): a tab right before
 * the caret goes as one; a run of spaces goes back to the previous stop of
 * the block's indent step (8 → 4, 6 → 4, 3 → 0 with four), never past a
 * tab. Null elsewhere: the box's own Backspace.
 */
function outdentBack(text: string, from: number): BlockEdit | null {
  const lines = linesOf(text);
  const start = lines.starts[lineIndex(lines, from)];
  const ws = text.slice(start, from);
  if (ws === "" || !/^[ \t]+$/.test(ws)) return null;
  const f = blockAt(text, from, true);
  if (!f) return null;
  let cut = 1;
  if (!ws.endsWith("\t")) {
    const col = (s: string): number => {
      let c = 0;
      for (const ch of s) c = ch === "\t" ? (Math.floor(c / TAB_WIDTH) + 1) * TAB_WIDTH : c + 1;
      return c;
    };
    const unit = indentUnit(text, f);
    const w = unit === "\t" ? TAB_WIDTH : unit.length;
    const runStart = ws.lastIndexOf("\t") + 1;
    const floor = col(ws.slice(0, runStart));
    const here = col(ws);
    cut = here - Math.max(floor, Math.floor((here - 1) / w) * w);
  }
  return { from: from - cut, to: from, insert: "", anchor: from - cut, head: from - cut };
}

/** An opener inside a block: wraps a selection, else auto-closes before
 *  a line end, a space or a closer. */
function opener(text: string, from: number, to: number, key: string): BlockEdit | null {
  if (!sameBlock(text, from, to, true)) return null;
  const close = OPENERS[key];
  if (from !== to) {
    const sel = text.slice(from, to);
    return { from, to, insert: key + sel + close, anchor: from + 1, head: from + 1 + sel.length };
  }
  const next = text.slice(to, to + 1);
  if (next !== "" && !CLOSE_BEFORE.test(next)) return null;
  return { from, to, insert: key + close, anchor: from + 1, head: from + 1 };
}

/** A closer typed in front of the same closer inside a block steps over it. */
function closer(text: string, from: number, to: number, key: string): BlockEdit | null {
  if (from !== to || text.charAt(from) !== key) return null;
  if (!blockAt(text, from, true)) return null;
  return { from, to, insert: "", anchor: from + 1, head: from + 1 };
}

/** The fence that closes `f`: its opening line's indent and mark (``` or
 *  ~~~, as long as the opener's), so the pair reads as one block. */
function closingFence(text: string, f: Fence): string {
  const eol = text.indexOf("\n", f.start);
  const m = OPEN.exec(text.slice(f.start, eol < 0 ? text.length : eol));
  return m ? m[1] + m[2] : "```";
}

/**
 * Item 676 (his words, 2026-11-12: "if i try to do right arrow even
 * without the closing ``` then you should auto put the three `` and then
 * send me to new line"): the unclosed block `f`, which runs to the end of
 * the text, gets its closing fence on a line of its own, then a new line
 * below it with the caret there — one edit, one undo. An empty last line
 * takes the fence; any other last line (text, or indentation, kept as
 * typed) gets the fence on the line after it. Nothing typed is removed.
 */
function closeAndExit(text: string, f: Fence): BlockEdit {
  const lastStart = text.lastIndexOf("\n") + 1;
  const emptyLast = lastStart > f.start && lastStart === text.length;
  const ins = (emptyLast ? "" : "\n") + closingFence(text, f) + "\n";
  const at = text.length;
  return { from: at, to: at, insert: ins, anchor: at + ins.length, head: at + ins.length };
}

/**
 * Down arrow on the box's last line, at the foot of a block (item 676):
 * on a closing fence that ends the text, a new line is added below and the
 * caret goes onto it; inside an unclosed block, the block is closed and
 * the caret goes below it (`closeAndExit`). Down anywhere else — a line
 * with a line below it, or after a block — is the box's own.
 */
function belowBlock(text: string, pos: number): BlockEdit | null {
  const lines = linesOf(text);
  const L = lineIndex(lines, pos);
  if (L !== lines.starts.length - 1) return null;
  const fences = fencesOf(text);
  if (fences.some((f) => f.close === L)) {
    return { from: text.length, to: text.length, insert: "\n", anchor: text.length + 1, head: text.length + 1 };
  }
  const open = fences.find((f) => f.close === null && f.open <= L);
  return open ? closeAndExit(text, open) : null;
}

/**
 * Right arrow at the very end of a closing fence (his ask, 2026-11-11:
 * "there should be a new line placed at the end of a code block always so
 * that i can just jump to it with right arrow"): the caret goes to the
 * start of the line after the block, and when the fence ends the text a
 * newline is added first — one undoable step. Anywhere else Right is the
 * box's own — except the end of an unclosed block (the end of the text,
 * the caret inside it), where the closing fence is added first (item 676,
 * `closeAndExit`).
 */
function pastFence(text: string, pos: number): BlockEdit | null {
  const lines = linesOf(text);
  const L = lineIndex(lines, pos);
  if (pos !== lines.ends[L]) return null;
  if (!fencesOf(text).some((f) => f.close === L)) {
    const f = pos === text.length ? blockAt(text, pos) : null;
    return f && f.close === null ? closeAndExit(text, f) : null;
  }
  if (pos === text.length) return { from: pos, to: pos, insert: "\n", anchor: pos + 1, head: pos + 1 };
  return { from: pos, to: pos, insert: "", anchor: pos + 1, head: pos + 1 };
}

/** ⌘/ (Ctrl+/ elsewhere) with no other modifier — the code editors'
 *  comment key (item 678). `/` by the key typed, or the physical key, so a
 *  layout whose / needs Shift still has it. */
export function isCommentKey(e: BlockKey & { code?: string }): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  return e.key === "/" || (!e.shiftKey && e.code === "Slash");
}

/** A language's line comment: a prefix (`//`), or a pair each commented
 *  line is wrapped in (`<!--` … `-->`). */
export interface CommentTokens {
  open: string;
  close?: string;
}

const COMMENT_GROUPS: [string, CommentTokens][] = [
  [
    "c cpp c++ cc cxx h hpp hh objc objective-c objectivec java js javascript jsx mjs cjs ts typescript tsx rust rs go golang swift kotlin kt kts scala cs csharp c# fs fsharp dart php groovy gradle zig scss sass less json5 jsonc proto protobuf solidity sol glsl hlsl wgsl cuda verilog v sv d",
    { open: "//" },
  ],
  [
    "python py py3 python3 ipython sh bash zsh shell console fish ksh ruby rb yaml yml toml perl pl r rscript powershell ps1 pwsh make makefile mk dockerfile docker cmake elixir ex exs nim julia jl tcl coffee coffeescript graphql gql nix crystal cr awk gdscript conf properties starlark bzl",
    { open: "#" },
  ],
  ["sql mysql postgres postgresql psql pgsql plsql sqlite tsql lua haskell hs elm ada vhdl applescript purescript idris agda", { open: "--" }],
  ["matlab octave tex latex erlang erl prolog postscript ps", { open: "%" }],
  ["html htm xml xhtml svg vue svelte markdown md xsl xslt plist", { open: "<!--", close: "-->" }],
  ["css", { open: "/*", close: "*/" }],
  ["lisp commonlisp common-lisp cl elisp emacs-lisp el scheme scm racket rkt clojure clj cljs edn fennel asm nasm masm gas x86 x86asm armasm s ini dosini", { open: ";" }],
  ["vb vbnet vba vbscript", { open: "'" }],
  ["bat batch cmd", { open: "REM" }],
];
const COMMENTS = new Map<string, CommentTokens>();
for (const [names, tok] of COMMENT_GROUPS) for (const n of names.split(" ")) COMMENTS.set(n, tok);

/** The fence's language as written after the mark (```py, ```{r},
 *  ```.cpp, ```python title="x"), lower-cased; "" when none. */
export function fenceLanguage(text: string, f: Fence): string {
  const eol = text.indexOf("\n", f.start);
  const m = OPEN.exec(text.slice(f.start, eol < 0 ? text.length : eol));
  const info = (m?.[3] ?? "").trim().replace(/^[{.]+/, "");
  return (/^[^\s{},]+/.exec(info)?.[0] ?? "").toLowerCase();
}

/** The comment tokens for a language name; `//` for one not listed. */
export function commentTokens(lang: string): CommentTokens {
  return COMMENTS.get(lang.toLowerCase()) ?? { open: "//" };
}

/**
 * Item 678 (his bug, 2026-11-12: "highlighting text and doing like command
 * slash to comment it doesnt work in the code editor"): ⌘/ inside a
 * block's body comments the lines the selection touches (the caret's line
 * with none) in the block's language, or uncomments them when every
 * non-blank one already is. As VS Code does: the token goes at the
 * smallest indent of the lines, followed by a space; blank lines stay
 * blank (unless every line is blank); uncommenting takes the token and
 * one space after it. One edit, so one undo; the selection stays over the
 * same text. Null outside a block's body (the box's own ⌘/).
 */
export function toggleComment(text: string, from: number, to: number): BlockEdit | null {
  const lines = linesOf(text);
  const L1 = lineIndex(lines, from);
  let L2 = lineIndex(lines, to);
  if (L2 > L1 && to === lines.starts[L2]) L2--;
  const f = blockAt(text, lines.starts[L1], true);
  if (!f || L1 <= f.open || (f.close !== null && L2 >= f.close)) return null;
  const tok = commentTokens(fenceLanguage(text, f));
  const rows: string[] = [];
  for (let L = L1; L <= L2; L++) rows.push(text.slice(lines.starts[L], lines.ends[L]));
  const filled = rows.filter((r) => r.trim() !== "");
  const isCommented = (r: string): boolean => {
    const t = r.trim();
    return t.startsWith(tok.open) && (!tok.close || (t.length >= tok.open.length + tok.close.length && t.endsWith(tok.close)));
  };
  const un = filled.length > 0 && filled.every(isCommented);
  const col = filled.length ? Math.min(...filled.map((r) => leadingWs(r).length)) : Math.min(...rows.map((r) => r.length));
  /** Per line: [column, chars removed, text inserted] at its start, and the
   *  same at its end (the wrap's close). */
  const edits = rows.map((r) => {
    if (filled.length && r.trim() === "") return { at: 0, cut: 0, ins: "", endCut: 0, endIns: "" };
    if (!un) return { at: col, cut: 0, ins: tok.open + " ", endCut: 0, endIns: tok.close ? " " + tok.close : "" };
    const at = leadingWs(r).length;
    const body = r.slice(at);
    const cut = tok.open.length + (body.charAt(tok.open.length) === " " ? 1 : 0);
    let endCut = 0;
    if (tok.close) {
      const trimmed = r.trimEnd();
      const tail = r.length - trimmed.length;
      const before = trimmed.charAt(trimmed.length - tok.close.length - 1);
      endCut = tok.close.length + tail + (before === " " && trimmed.length - tok.close.length - 1 >= at + cut ? 1 : 0);
    }
    return { at, cut, ins: "", endCut, endIns: "" };
  });
  const out = rows.map((r, i) => {
    const e = edits[i];
    const head = r.slice(0, e.at) + e.ins + r.slice(e.at + e.cut, r.length - e.endCut);
    return head + e.endIns;
  });
  /** Where `p` lands. Past the token's place it moves with the text; inside
   *  a removed token it goes to where the token was; at the token's place a
   *  caret moves past the inserted token, a selection's start stays before
   *  it (the whole line stays selected) and a selection's end at a line end
   *  takes in the added close. */
  const sel = from !== to;
  const map = (p: number, isStart: boolean): number => {
    const L = lineIndex(lines, p);
    let shift = 0;
    for (let i = L1; i < L; i++) {
      const e = edits[i - L1];
      shift += e.ins.length - e.cut + e.endIns.length - e.endCut;
    }
    const e = edits[L - L1];
    const len = rows[L - L1].length;
    let c = Math.min(p - lines.starts[L], len - e.endCut);
    if (c > e.at + e.cut || (c === e.at && e.cut === 0 && e.ins && !(sel && isStart))) c += e.ins.length - e.cut;
    else if (c > e.at) c = e.at;
    if (sel && !isStart && p - lines.starts[L] === len) c += e.endIns.length;
    return lines.starts[L] + shift + c;
  };
  const rFrom = lines.starts[L1];
  const rTo = lines.ends[L2];
  const a = map(Math.max(from, rFrom), true);
  const insert = out.join("\n");
  // A selection running on to the next line's start (whole lines picked)
  // keeps ending there.
  const b = !sel ? a : to > rTo ? to + insert.length - (rTo - rFrom) : map(to, false);
  return { from: rFrom, to: rTo, insert, anchor: a, head: b };
}

const QUOTES = new Set(['"', "'", "`"]);

/**
 * What the caret at `to` sits in, reading the block's body from `from`:
 * code, a string ("…" '…' `…`, backslash escapes; " and ' end at a line
 * end) or a comment (// or # to the line end — # only at a line start or
 * after a space, so `a#b` and `"#fff"` are not one — or /* … *\/). A # or
 * // inside a string is not a comment. Not a parser: Python's triple
 * quotes read as an empty string then a quote, and a Rust lifetime 'a
 * opens a '-string to its line end.
 */
export function scanTo(text: string, from: number, to: number): "code" | "string" | "comment" {
  let i = from;
  let q = "";
  while (i < to) {
    const c = text.charAt(i);
    if (q) {
      if (c === "\\") i += 2;
      else {
        if (c === q || (c === "\n" && q !== "`")) q = "";
        i++;
      }
      continue;
    }
    const lineStart = i === 0 || text.charAt(i - 1) === "\n";
    if ((c === "/" && text.charAt(i + 1) === "/") || (c === "#" && (lineStart || /\s/.test(text.charAt(i - 1))))) {
      const eol = text.indexOf("\n", i);
      if (eol < 0 || eol >= to) return "comment";
      i = eol + 1;
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > to) return "comment";
      i = end + 2;
      continue;
    }
    if (QUOTES.has(c)) q = c;
    i++;
  }
  return q ? "string" : "code";
}

/** A quote inside a block's body, outside a comment: wraps a selection,
 *  steps over the quote ending the string it is in, else closes itself before a line end,
 *  a space or a closer — not ' after a letter or digit (don't), not
 *  inside a string, and not a ` on a line of only backticks (a fence being
 *  typed). In a comment it is just itself. */
function quote(text: string, from: number, to: number, key: string): BlockEdit | null {
  const f = sameBlock(text, from, to, true);
  if (!f) return null;
  const at = scanTo(text, f.bodyFrom, from);
  if (at === "comment") return null;
  if (from !== to) {
    const sel = text.slice(from, to);
    return { from, to, insert: key + sel + key, anchor: from + 1, head: from + 1 + sel.length };
  }
  const next = text.charAt(to);
  // The quote that ends the string the caret is in (the one auto-inserted,
  // or one typed by hand); a quote opening the next string is typed.
  if (at === "string") return next === key ? { from, to, insert: "", anchor: from + 1, head: from + 1 } : null;
  if (next !== "" && !CLOSE_BEFORE.test(next)) return null;
  const prev = text.charAt(from - 1);
  if (key === "'" && /[\p{L}\p{N}]/u.test(prev)) return null;
  if (key === "`" && /^[ \t]*`*$/.test(text.slice(text.lastIndexOf("\n", from - 1) + 1, from))) return null;
  return { from, to, insert: key + key, anchor: from + 1, head: from + 1 };
}

/** `text` with `ed` applied. */
export function applyBlockEdit(text: string, ed: BlockEdit): string {
  return text.slice(0, ed.from) + ed.insert + text.slice(ed.to);
}

/** The parts of a plain `<textarea>` the edit is applied through. */
export interface FieldLike {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number, direction?: "forward" | "backward" | "none"): void;
}

/**
 * `ed` applied to a plain `<textarea>`: its value set, the selection put
 * where `ed` says (a backward one kept backward). The caller records the
 * step in the box's history, if it keeps one, and tells its state.
 */
export function applyToField(el: FieldLike, ed: BlockEdit): string {
  const next = applyBlockEdit(el.value, ed);
  if (next !== el.value) el.value = next;
  const a = Math.min(ed.anchor, ed.head);
  const b = Math.max(ed.anchor, ed.head);
  el.setSelectionRange(a, b, ed.head < ed.anchor ? "backward" : "forward");
  return next;
}

/** A box the edit can be handed to whole (the formatted editor's handle). */
export interface EditableBox {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  applyEdit(ed: BlockEdit): void;
}

/** A textarea as `takeBlockKey` uses it. */
export interface InputField extends FieldLike {
  disabled?: boolean;
  readOnly?: boolean;
  dispatchEvent(e: Event): boolean;
}

/** The key event as `takeBlockKey` uses it (a `KeyboardEvent` is one). */
export interface TakenKey extends BlockKey {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

function inputEvent(type: string): Event {
  const init = { bubbles: true, inputType: "insertReplacementText" };
  return typeof InputEvent !== "undefined" ? new InputEvent(type, init) : new Event(type, init);
}

/**
 * The code-block keys for a box that hears its own edits from `input`
 * events (the edit box, the phone's boxes): the key's edit applied between
 * a `beforeinput` and an `input` event, so the box's own handlers record
 * the step and its state takes the text — the path a keystroke takes. A
 * formatted editor's handle takes the edit itself. True when the key was
 * taken (its default prevented).
 */
export function takeBlockKey(e: TakenKey, box: InputField | EditableBox | null): boolean {
  if (!box || e.defaultPrevented) return false;
  const ed = codeBlockEdit(box.value, box.selectionStart, box.selectionEnd, e);
  if (!ed) return false;
  e.preventDefault();
  if ("applyEdit" in box) {
    box.applyEdit(ed);
    return true;
  }
  if (box.disabled || box.readOnly) return true;
  const before = box.value;
  box.dispatchEvent(inputEvent("beforeinput"));
  applyToField(box, ed);
  if (box.value !== before) box.dispatchEvent(inputEvent("input"));
  return true;
}
