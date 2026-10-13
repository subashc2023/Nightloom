/*
 * Pasted code becomes a fenced block (nightshift item 315). Whether a paste
 * is code and in which language (`detectCode`), the fence put round it
 * (`fenced`), and the fences already in the draft (`findFences`) — the
 * box and the sent bubble draw a block from the same reading of them.
 *
 * Detection is a guess, so it leans to prose: a paste is code only when
 * most of its lines look like code by their shape (a scoring heuristic)
 * and highlight.js's own guess is confident. The block's label lets him
 * change the language it chose.
 */
import { guessLanguage, languageOf, segmentLines, segments, type Seg } from "./codeHighlight";
import { LONG_PASTE_WORDS, wordCount } from "./pasteAttach";

/** Shapes that say "code" about a line. */
const CODE_LINE: RegExp[] = [
  /[;{}]\s*(\/\/.*)?$/, // ends with ; { } (a C-family statement or block)
  /^\s*[}\])]/, // opens with a closing bracket
  /^\s*(def|class|import|from|return|elif|else:|try:|except|finally:|with|async def|lambda|yield|raise|pass|print\()\b/,
  /^\s*#\s*(include|define|ifn?def|endif|pragma|import)\b/,
  /^\s*(public|private|protected|static|final|abstract|package|interface|enum|struct|namespace|template|typedef|using|extern|virtual|override)\b/,
  /^\s*(function|const|let|var|export|async|await|fn|func|impl|mod|use|pub|val|fun|guard|switch|case|default:|break;|continue;)\b/,
  /^\s*(if|for|while|do|else)\b.*[({:]\s*$/,
  /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|GROUP BY|ORDER BY)\b/i,
  /^\s*(\/\/|\/\*|\*\s|\*\/|--\s|#!)/, // comment lines (not a lone markdown `#`)
  /^\s*<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/, // markup
  /^\s*[\w.$[\]"']+\s*(=|\+=|-=|:=|=>|->)\s*\S/, // assignment / arrow
  /\w+\([^()]*\)\s*(:|\{|;|->.*)?\s*$/, // a call or signature at line end
  /^\s*@\w+/, // decorator / annotation
  /^\s*[\w-]+\s*:\s*[^:]+;\s*$/, // css property
  /^\s*"[^"]+"\s*:\s*/, // json key
];

/** Shapes that say "prose": a sentence of words ending in . ! ? */
function proseLine(l: string): boolean {
  const t = l.trim();
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z'’,.;:!?()-]+$/.test(w)).length;
  const all = t.split(/\s+/).length;
  return all >= 6 && words / all >= 0.8 && /[.!?:"”)]$/.test(t) && !/[;{}]$/.test(t);
}

/**
 * Unmistakable marks of a language, checked before highlight.js's guess,
 * which is weak between the C-family languages (a Java class reads to it as
 * TypeScript). First match wins, so the more specific come first.
 */
const SIGNATURES: [string, RegExp][] = [
  ["java", /\bpublic\s+(static\s+)?(final\s+)?(class|interface|enum|void)\b|System\.(out|err)\.print|\bString\[\]\s+args\b|^\s*import\s+java\./m],
  ["cpp", /#include\s*<(iostream|vector|string|map|unordered_map|memory|algorithm|cstdio|cstdlib)>|\bstd::|\bcout\s*<<|\btemplate\s*<|\bnullptr\b/],
  ["c", /#include\s*<\w+\.h>|\bprintf\s*\(|\bmalloc\s*\(/],
  // A Python traceback (review fix: highlight.js called one Java).
  ["python", /^Traceback \(most recent call last\):$|^\s*def\s+\w+\s*\(.*\)\s*(->\s*[^:]+)?:\s*$|^\s*(from\s+[\w.]+\s+)?import\s+[\w.]+(\s+as\s+\w+)?\s*$|__name__\s*==|^\s*elif\b|\bself\.\w+\s*=/m],
  ["rust", /\bfn\s+\w+\s*(<[^>]*>)?\s*\(.*\)\s*(->\s*[^{]+)?\{|\blet\s+mut\b|\b(println|vec|format)!\s*[([]|\bimpl\b.*\{/],
  ["go", /^package\s+\w+\s*$|\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\s*\(.*\)\s*[\w*([\]]*\s*\{|\bfmt\.\w+\(/m],
  ["kotlin", /\bfun\s+\w+\s*\(|\bval\s+\w+\s*(:\s*\w+)?\s*=/],
  ["swift", /\bguard\s+let\b|\bfunc\s+\w+\s*\(.*\)\s*(->\s*\w+\s*)?\{|\bimport\s+(Foundation|SwiftUI|UIKit)\b/],
  ["typescript", /\binterface\s+\w+\s*\{|:\s*(string|number|boolean|void)\b[^;]*[;,)=]|\btype\s+\w+\s*=|\bas\s+const\b/],
  ["javascript", /\bconsole\.log\(|\b(const|let)\s+\w+\s*=|=>\s*[{(\w]|\bfunction\s+\w+\s*\(|\bmodule\.exports\b|\brequire\(/],
];

/** The first language whose marks `text` carries, or null. */
export function signatureOf(text: string): string | null {
  return SIGNATURES.find(([, re]) => re.test(text))?.[0] ?? null;
}

export type CodeVerdict = { code: boolean; score: number; lang: string | null; relevance: number };

/** Below this highlight.js relevance its guess is noise (prose scores 0–4). */
export const MIN_RELEVANCE = 6;

/** Is `text` code (≥ 2 lines, mostly code-shaped, a confident guess)? */
export function detectCode(text: string): CodeVerdict {
  const none: CodeVerdict = { code: false, score: 0, lang: null, relevance: 0 };
  if (text.includes("```") || text.includes("~~~")) return none;
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return none;
  let code = 0;
  let prose = 0;
  let indented = 0;
  for (const l of lines) {
    if (CODE_LINE.some((re) => re.test(l))) code++;
    else if (proseLine(l)) prose++;
    if (/^( {2,}|\t)\S/.test(l)) indented++;
  }
  // Indentation counts for code only beside other code shapes.
  const score = (code + (code > 0 ? indented * 0.5 : 0) - prose * 1.5) / lines.length;
  if (score < 0.5 || prose / lines.length > 0.34) return { ...none, score };
  const g = guessLanguage(text);
  const sig = signatureOf(text);
  if (sig) return { code: true, score, lang: sig, relevance: g?.relevance ?? 0 };
  if (!g || g.relevance < MIN_RELEVANCE) return { code: false, score, lang: g?.id ?? null, relevance: g?.relevance ?? 0 };
  return { code: true, score, lang: g.id, relevance: g.relevance };
}

/** The paste as the draft gets it: fenced with its language, on lines of
 *  its own. `before`/`after` are the draft's characters either side of the
 *  paste, so the fence opens and closes at a line start. The pasted text
 *  itself is not touched (CRLF made LF, as the box itself does). */
export function fenced(paste: string, lang: string, before: string, after: string): string {
  const body = paste.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const tail = after.startsWith("\n") ? "" : "\n";
  return `${lead}\`\`\`${lang}\n${body}\n\`\`\`${after === "" ? "" : tail}`;
}

export type Fence = {
  /** Line indexes (0-based) of the opening fence and the closing one (null: open to the end). */
  open: number;
  close: number | null;
  /** The info string as typed, and where it sits in the opening line. */
  info: string;
  infoFrom: number;
  infoTo: number;
  /** Character offsets in the text: the opening line's start, the body's span. */
  start: number;
  bodyFrom: number;
  bodyTo: number;
  /** The known language, or null. */
  lang: string | null;
};

const OPEN = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;

/** The fenced blocks in `text`, CommonMark's way: an opening ``` or ~~~
 *  (up to three spaces in), closed by the same mark at least as long;
 *  unclosed runs to the end. */
export function findFences(text: string): Fence[] {
  const lines = text.split("\n");
  const out: Fence[] = [];
  let off = 0;
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    const mark = m[2];
    const closeRe = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    const close = j < lines.length ? j : null;
    const infoFrom = starts[i] + m[1].length + mark.length;
    const raw = m[3];
    const lead = raw.length - raw.trimStart().length;
    const info = raw.trim();
    const bodyFrom = i + 1 < lines.length ? starts[i + 1] : text.length;
    const bodyTo = close === null ? text.length : Math.max(bodyFrom, starts[close] - 1);
    out.push({
      open: i,
      close,
      info,
      infoFrom: infoFrom + lead,
      infoTo: infoFrom + lead + info.length,
      start: starts[i],
      bodyFrom,
      bodyTo,
      lang: languageOf(info)?.id ?? null,
    });
    i = close ?? lines.length;
  }
  return out;
}

/** `text` with fence `f`'s info string set to `lang` — nothing else moves. */
export function withFenceLanguage(text: string, f: Fence, lang: string): string {
  return text.slice(0, f.infoFrom) + lang + text.slice(f.infoTo);
}

export type BubblePart = { kind: "text"; text: string } | { kind: "code"; code: string; info: string; lang: string | null };

/** His sent message cut into plain text and fenced blocks, for the bubble.
 *  A block's fence lines become its label; the newline that ended the
 *  closing fence goes with it (the block is a block). */
export function splitFences(text: string): BubblePart[] {
  const fences = findFences(text);
  if (fences.length === 0) return [{ kind: "text", text }];
  const out: BubblePart[] = [];
  let at = 0;
  for (const f of fences) {
    // The newline before the block belongs to the block's margin.
    let pre = text.slice(at, f.start);
    if (pre.endsWith("\n")) pre = pre.slice(0, -1);
    if (pre) out.push({ kind: "text", text: pre });
    out.push({ kind: "code", code: text.slice(f.bodyFrom, f.bodyTo), info: f.info, lang: f.lang });
    if (f.close === null) {
      at = text.length;
      break;
    }
    const closeEnd = text.indexOf("\n", f.bodyTo + 1);
    at = closeEnd === -1 ? text.length : closeEnd + 1;
  }
  const rest = text.slice(at);
  if (rest) out.push({ kind: "text", text: rest });
  return out;
}

/**
 * The language to fence a ⌘V paste with, or null to paste it as it is.
 * Not when it is long enough for item 284's "Make this an attachment"
 * offer (that paste is better as an attachment, and the offer keeps it as
 * it came), and not inside a fence already there (it is code already).
 */
export function codePasteLanguage(pasted: string, text: string, caret: number): string | null {
  if (wordCount(pasted) > LONG_PASTE_WORDS) return null;
  if (findFences(text).some((f) => caret > f.start && (f.close === null || caret <= f.bodyTo + 1))) return null;
  const v = detectCode(pasted);
  return v.code && v.lang ? v.lang : null;
}

/** How the box's layer draws a line inside a fence: the fence lines
 *  themselves (dimmed, the opening one carrying the label) or a body line's
 *  coloured runs. */
export type LayerLine =
  | { kind: "open"; fence: number }
  | { kind: "close" }
  | { kind: "body"; segs: Seg[] };

/*
 * A block's body lines, kept while the block is unchanged (review fix,
 * 2026-10-05): the box redraws its layer on every keystroke, and handing
 * it the very same line objects for a block he is not typing in lets the
 * redraw skip the block. Without it a keystroke above a 2,000-line block
 * took ~340 ms in WebKit.
 */
const bodyMemo = new Map<string, LayerLine[]>();
function bodyLines(body: string, info: string, count: number): LayerLine[] {
  const k = `${count}\u0000${info}\u0000${body}`;
  const hit = bodyMemo.get(k);
  if (hit) return hit;
  const lines = segmentLines(segments(body, info));
  const out: LayerLine[] = [];
  for (let i = 0; i < count; i++) out.push({ kind: "body", segs: lines[i] ?? [] });
  if (bodyMemo.size > 16) bodyMemo.delete(bodyMemo.keys().next().value!);
  bodyMemo.set(k, out);
  return out;
}

/** One entry per line of `text`: null outside every fence. */
export function layerLines(text: string): (LayerLine | null)[] {
  const n = text.split("\n").length;
  const out: (LayerLine | null)[] = new Array(n).fill(null);
  findFences(text).forEach((f, k) => {
    out[f.open] = { kind: "open", fence: k };
    const body = text.slice(f.bodyFrom, f.bodyTo);
    const end = f.close ?? n;
    if (end > f.open + 1) {
      const lines = bodyLines(body, f.info, end - f.open - 1);
      for (let i = f.open + 1; i < end; i++) out[i] = lines[i - f.open - 1];
    }
    if (f.close !== null) out[f.close] = { kind: "close" };
  });
  return out;
}
