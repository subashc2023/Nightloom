/**
 * The message box with its formatting drawn in place (nightshift item 276,
 * his pick "option 1, Notion-style", 2026-10-01): a finished `$$\hat{p}$$`
 * shows as the typeset equation inside the composer, `**bold**`, `*italic*`
 * and `# headings` show styled with their marks hidden, and wherever the
 * cursor or the selection is, the source comes back — the shape the note
 * editor (`noteEditor.ts`, backlog 150) already has, cut down to what a
 * message needs and sized for a message box rather than a page.
 *
 * The text is the message. Nothing here writes to it: every decoration is
 * drawn over the document, and the keymap is the plain one a textarea has
 * (no list continuation, no indentation, no comment toggles), so what he
 * types, what the draft store keeps and what Send sends are the same string
 * the plain box would have produced. `composerState` and its test pin it.
 *
 * Off (the default), the composer is the textarea it always was; this file
 * is not loaded into the box at all.
 */
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { LanguageSupport, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { findMath, type MathSpan } from "./math";
import { MathWidget } from "./noteEditor";
import { quoteLine } from "./replyQuote.svelte";

/** Node types whose content is code: nothing inside is math or emphasis. */
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"]);

/**
 * Whether the box has the keyboard focus. Unfocused, nothing is open: the
 * whole draft is drawn, so a formula he finished and clicked away from — or
 * a box he came back to — reads typeset. Set by `focusChange` below; a state
 * made without it (the suite) counts as focused.
 */
export const setFocused = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});
const focusChange = EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing));

function focused(state: EditorState): boolean {
  return state.field(focusField, false) ?? true;
}

/**
 * Is a span `[from, to)` open — the cursor in it, or the selection over
 * it? The end is excluded: the caret just past a closing `$$` or `**`, which
 * is where it is the moment he finishes typing one, leaves it drawn. Arrow
 * keys still step in — ← from past the end crosses the drawn span and lands
 * inside the source, or just before it, which opens it.
 */
function touches(state: EditorState, from: number, to: number): boolean {
  if (!focused(state)) return false;
  for (const r of state.selection.ranges) {
    if (r.empty ? r.head >= from && r.head < to : r.from < to && r.to > from) return true;
  }
  return false;
}

/** Is the cursor (any range) on one of the lines `[from, to]` covers, ends included? */
function onLines(state: EditorState, from: number, to: number): boolean {
  if (!focused(state)) return false;
  const a = state.doc.lineAt(from).from;
  const b = state.doc.lineAt(to).to;
  for (const r of state.selection.ranges) if (r.from <= b && r.to >= a) return true;
  return false;
}

const WORD = /[A-Za-z0-9_]/;

/**
 * The composer's extra rule over the replies' `$…$` guards (`math.ts`): a
 * one-dollar span whose closing `$` runs straight into a word, or whose
 * opening one follows a word, is shell, not math — `$HOME/bin:$PATH`,
 * `echo $USER$HOST`, `a$b$c`. The replies' renderer keeps its own rules;
 * a message being typed meets far more shell than a reply does.
 */
export function composerMathOk(text: string, m: MathSpan): boolean {
  if (m.display || m.openLen !== 1) return true;
  const before = m.from > 0 ? text[m.from - 1] : "";
  const after = m.to < text.length ? text[m.to] : "";
  return !WORD.test(before) && !WORD.test(after);
}

/** What a stretch of the box is drawn as — the testable shape of the decorations. */
export type LiveKind = "math" | "math-block" | "heading" | "strong" | "em" | "strike" | "code" | "codeblock" | "quote";
export interface LiveSpan {
  kind: LiveKind;
  from: number;
  to: number;
  /** The heading's level, 1–6. */
  level?: number;
  /** The source is showing because the cursor or selection is in it. */
  open: boolean;
}

/**
 * Where an emphasis run made of `*` sits inside a word on either side —
 * `2*3*4`, `a*b*c`. CommonMark makes those emphasis; in a chat message they
 * are arithmetic and globs far more often, so they stay text. `_` already
 * stays text inside a word (`snake_case_names`) by CommonMark's own rule.
 */
function intrawordStar(doc: string, from: number, to: number): boolean {
  if (doc[from] !== "*") return false;
  const before = from > 0 ? doc[from - 1] : "";
  const after = to < doc.length ? doc[to] : "";
  return /[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after);
}

/**
 * Every formatted stretch of the box, in document order, from the state as
 * it stands. Pure over the state, so the suite reads it without a DOM; the
 * decorations below are drawn from exactly this list.
 */
export function liveSpans(state: EditorState): LiveSpan[] {
  const doc = state.doc;
  const text = doc.toString();
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  const out: LiveSpan[] = [];
  const code: [number, number][] = [];

  tree.iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) code.push([node.from, node.to]);
    },
  });
  const inCode = (from: number, to: number) => code.some(([a, b]) => from < b && to > a);

  // Math first: what a formula holds (`$a*b*c$` parses as emphasis) is the
  // formula's, so nothing else is drawn over one.
  const maths = findMath(text).filter((m) => !inCode(m.from, m.to) && composerMathOk(text, m));
  const inMath = (from: number, to: number) => maths.some((m) => from < m.to && to > m.from);
  for (const m of maths) {
    const first = doc.lineAt(m.from);
    const last = doc.lineAt(m.to);
    const alone =
      m.display &&
      doc.sliceString(first.from, m.from).trim() === "" &&
      doc.sliceString(m.to, last.to).trim() === "";
    if (alone && (m.block || first.number !== last.number)) {
      out.push({ kind: "math-block", from: m.from, to: m.to, open: touches(state, first.from, last.to) });
    } else {
      out.push({ kind: "math", from: m.from, to: m.to, open: touches(state, m.from, m.to) });
    }
  }

  tree.iterate({
    enter(node) {
      const { from, to, name } = node;
      if (maths.some((m) => from >= m.from && to <= m.to)) return false;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        // A bare `#` (typing toward `#hashtag`) is an empty heading to
        // CommonMark; drawn as one it would jump in size for a keystroke.
        const mark = node.node.getChild("HeaderMark");
        const body = doc.sliceString(mark ? mark.to : from, to).replace(/#+\s*$/, "").trim();
        if (!body) return false;
        out.push({ kind: "heading", from, to, level: Number(heading[1]), open: onLines(state, from, to) });
        return;
      }
      switch (name) {
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough": {
          if (inMath(from, to)) return false;
          if (name !== "Strikethrough" && intrawordStar(text, from, to)) return;
          const kind = name === "Emphasis" ? "em" : name === "StrongEmphasis" ? "strong" : "strike";
          out.push({ kind, from, to, open: touches(state, from, to) });
          return;
        }
        case "InlineCode":
          if (inMath(from, to)) return false;
          out.push({ kind: "code", from, to, open: touches(state, from, to) });
          return false;
        case "FencedCode":
          out.push({ kind: "codeblock", from, to, open: onLines(state, from, to) });
          return false;
      }
    },
  });

  // Quote lines as the plain box's layer draws them (item 223): the same
  // per-line rule, so a quote looks the same with the toggle on or off.
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (quoteLine(line.text) && !inMath(line.from, line.to) && !inCode(line.from, line.to)) {
      out.push({ kind: "quote", from: line.from, to: line.to, open: false });
    }
  }

  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

const hide = Decoration.replace({});
/** A mark shown because the cursor is in its span: there, dimmed. */
const shown = Decoration.mark({ class: "cm-cmark" });
/** A formula's source while it is open: set as code, so it reads as TeX. */
const source = Decoration.mark({ class: "cm-cmathsrc" });

/** The decorations for the state as it stands, drawn from `liveSpans`. */
export function composerDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const out: Range<Decoration>[] = [];
  const marks = (from: number, to: number, names: string[]): { from: number; to: number }[] => {
    const found: { from: number; to: number }[] = [];
    tree.iterate({
      from,
      to,
      enter(n) {
        if (n.from < from || n.to > to) return;
        if (names.includes(n.name)) found.push({ from: n.from, to: n.to });
      },
    });
    return found;
  };

  for (const s of liveSpans(state)) {
    switch (s.kind) {
      case "math": {
        if (s.open) {
          out.push(source.range(s.from, s.to));
          break;
        }
        const m = findMath(doc.sliceString(s.from, s.to))[0];
        if (!m) break;
        out.push(
          // A `$$…$$` among words is set in text style: a display block
          // would split the line it stands in.
          Decoration.replace({ widget: new MathWidget(m.tex, false, false, m.openLen) }).range(s.from, s.to),
        );
        break;
      }
      case "math-block": {
        if (s.open) {
          out.push(source.range(s.from, s.to));
          break;
        }
        const m = findMath(doc.sliceString(s.from, s.to))[0];
        if (!m) break;
        const first = doc.lineAt(s.from);
        const last = doc.lineAt(s.to);
        out.push(
          Decoration.replace({ widget: new MathWidget(m.tex, true, true, m.openLen), block: true }).range(
            first.from,
            last.to,
          ),
        );
        break;
      }
      case "heading": {
        out.push(Decoration.line({ class: `cm-ch cm-ch${s.level}` }).range(doc.lineAt(s.from).from));
        const hm = marks(s.from, s.to, ["HeaderMark"]);
        if (s.open) {
          for (const m of hm) out.push(shown.range(m.from, m.to));
          break;
        }
        // The leading `#`s and the space after them; a closing run
        // (`## Title ##`) when there is one.
        const lead = hm[0];
        if (lead) {
          const after = doc.sliceString(lead.to, lead.to + 1) === " " ? lead.to + 1 : lead.to;
          out.push(hide.range(lead.from, after));
        }
        if (hm.length > 1) {
          const tail = hm[hm.length - 1];
          out.push(hide.range(tail.from, tail.to));
        }
        break;
      }
      case "strong":
      case "em":
      case "strike": {
        const cls = s.kind === "em" ? "cm-cem" : s.kind === "strong" ? "cm-cstrong" : "cm-cstrike";
        out.push(Decoration.mark({ class: cls }).range(s.from, s.to));
        const name = s.kind === "strike" ? "StrikethroughMark" : "EmphasisMark";
        // Only this span's own marks: a nested `***a***` is two spans, each
        // hiding its own.
        const own = marks(s.from, s.to, [name]).filter((m) => m.from === s.from || m.to === s.to);
        for (const m of own) out.push((s.open ? shown : hide).range(m.from, m.to));
        break;
      }
      case "code": {
        out.push(Decoration.mark({ class: "cm-ccode" }).range(s.from, s.to));
        if (s.open) break;
        for (const m of marks(s.from, s.to, ["CodeMark"])) out.push(hide.range(m.from, m.to));
        break;
      }
      case "codeblock": {
        for (let n = doc.lineAt(s.from).number, end = doc.lineAt(s.to).number; n <= end; n++) {
          const line = doc.line(n);
          const fence = n === doc.lineAt(s.from).number || (n === end && /^\s*(```|~~~)/.test(line.text));
          out.push(Decoration.line({ class: fence ? "cm-ccodeblock cm-cfence" : "cm-ccodeblock" }).range(line.from));
        }
        break;
      }
      case "quote": {
        out.push(Decoration.line({ class: "cm-cquote" }).range(s.from));
        const q = quoteLine(doc.sliceString(s.from, s.to));
        if (q) out.push(Decoration.mark({ class: "cm-cqm" }).range(s.from, s.from + q.marker.length));
        break;
      }
    }
  }
  return Decoration.set(out, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: (state) => composerDecorations(state),
  update(value, tr) {
    const refocus = tr.effects.some((e) => e.is(setFocused));
    return tr.docChanged || tr.selection || refocus ? composerDecorations(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * The box's state for `text`, cursor at the end. The line separator is
 * CodeMirror's default — `\r\n`, `\r` and `\n` all read as a line break and
 * the text comes back joined with `\n` — which is what a textarea does to
 * a pasted or programmatically set value, so the two boxes agree.
 */
export function composerState(
  text: string,
  extensions: Extension[] = [],
  cursor = text.length,
  hasFocus: boolean | null = null,
): EditorState {
  const state0 = EditorState.create({ doc: text });
  const at = Math.max(0, Math.min(cursor, state0.doc.length));
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(at),
    extensions: [
      new LanguageSupport(markdownLanguage),
      ...(hasFocus === null ? [] : [focusField.init(() => hasFocus), focusChange]),
      livePreview,
      ...extensions,
    ],
  });
}

/**
 * The keys a textarea has and nothing more: cursor motion, selection,
 * deletion, select-all, undo and redo, and Enter / Shift-Enter as a bare
 * newline (no list continuation, no indentation). Everything the composer
 * itself does with a key — Enter to send, ↑ to take back, the menus — runs
 * first, from the composer's own handler.
 */
export function composerKeymap(): Extension {
  return [
    Prec.high(
      keymap.of([
        { key: "Enter", run: insertNewline, shift: insertNewline },
      ]),
    ),
    keymap.of([...standardKeymap.filter((b) => b.key !== "Enter"), ...historyKeymap]),
    history(),
  ];
}

/** The theme: the plain box's face, size and padding, and modest headings. */
export const composerTheme = EditorView.theme({
  "&": {
    color: "var(--ink)",
    backgroundColor: "transparent",
    fontSize: "15px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.5",
    overflowX: "hidden",
    overflowY: "auto",
  },
  ".cm-content": {
    // 2px more at the foot than the textarea: KaTeX's invisible struts
    // (\sum's limits, \left( … \right)) reach a pixel under the last line
    // and would otherwise draw a scroll bar in a one-line box (gallery).
    padding: "2px 0 4px 10px",
    caretColor: "var(--ink)",
    minHeight: "auto",
    // Never wider than the box: a formula that does not fit scrolls inside
    // its own block instead of stretching the text column.
    flex: "1 1 0",
    minWidth: "0",
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-placeholder": { color: "var(--dim)" },
  // Headings sized for a message, not a page (his ask: nothing that "looks
  // weird within the box"): 1.25× body at most, no margins, so a heading
  // line costs about one line and a half and never a gap.
  ".cm-ch": { fontWeight: "620", lineHeight: "1.4" },
  ".cm-ch1": { fontSize: "1.25em" },
  ".cm-ch2": { fontSize: "1.15em" },
  ".cm-ch3": { fontSize: "1.07em" },
  ".cm-ch4, .cm-ch5": { fontSize: "1em" },
  ".cm-ch6": { fontSize: "1em", color: "var(--dim)" },
  ".cm-cem": { fontStyle: "italic" },
  ".cm-cstrong": { fontWeight: "650" },
  ".cm-cstrike": { textDecoration: "line-through" },
  ".cm-ccode": {
    fontFamily: "var(--mono)",
    fontSize: "0.88em",
    background: "var(--well)",
    borderRadius: "4px",
    padding: "0.05em 0.25em",
  },
  ".cm-ccodeblock": {
    fontFamily: "var(--mono)",
    fontSize: "0.86em",
    background: "var(--well)",
  },
  ".cm-cfence": { color: "var(--dim)" },
  // The quote line as the plain box's layer draws it (item 223).
  ".cm-cquote": {
    marginLeft: "-10px",
    paddingLeft: "10px !important",
    boxShadow: "inset 3px 0 0 var(--accent)",
    color: "var(--dim)",
  },
  ".cm-cqm": { opacity: "0.45" },
  ".cm-cmark": { color: "var(--dim)" },
  ".cm-cmathsrc": { fontFamily: "var(--mono)", fontSize: "0.9em", color: "var(--ink2)" },
  ".cm-nmath": { cursor: "pointer" },
  // KaTeX's 1.21em is a document's; beside 15px message text it reads big.
  ".cm-nmath .katex": { fontSize: "1.05em" },
  // A display formula alone on its lines: left-aligned like the text it
  // sits in, scrolling sideways inside the box when wider than it — never
  // widening the box.
  ".cm-nmath-block": {
    display: "block",
    maxWidth: "100%",
    padding: "0.15em 0",
    overflowX: "auto",
    overflowY: "hidden",
  },
  ".cm-nmath-block .katex-display": { margin: "0", textAlign: "left" },
  ".cm-nmath-block .katex-display > .katex": { textAlign: "left" },
  ".cm-nmath-block::-webkit-scrollbar": { height: "6px" },
  ".cm-nmath-block::-webkit-scrollbar-thumb": { background: "transparent", borderRadius: "3px" },
  ".cm-nmath-block:hover::-webkit-scrollbar-thumb": { background: "var(--border)" },
  ".cm-nmath .katex-error, .cm-nmath .math-error": {
    fontFamily: "var(--mono)",
    fontSize: "0.85em",
    color: "var(--error)",
  },
  ".cm-nmath:hover": {
    outline: "1px dashed color-mix(in srgb, var(--accent) 50%, transparent)",
    borderRadius: "4px",
  },
});

/**
 * The composer's view of either box. The plain `<textarea>` already is
 * one; `LiveBoxHandle` makes the formatted editor one, so the composer's
 * caret moves, focus calls, auto-grow and height drag run unchanged
 * against whichever box is showing.
 */
export interface ComposerBox {
  focus(): void;
  selectionStart: number;
  selectionEnd: number;
  readonly value: string;
  readonly style: CSSStyleDeclaration;
  readonly scrollHeight: number;
  readonly offsetHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  scrollTop: number;
  closest(selector: string): Element | null;
  getBoundingClientRect(): DOMRect;
}

/** The formatted editor seen as a textarea, for the composer. */
export class LiveBoxHandle implements ComposerBox {
  constructor(readonly view: EditorView) {}
  /** The element sized, measured and animated: the editor's outer box. */
  get element(): HTMLElement {
    return this.view.dom;
  }
  focus(): void {
    this.view.focus();
  }
  get value(): string {
    return this.view.state.doc.toString();
  }
  get selectionStart(): number {
    return this.view.state.selection.main.from;
  }
  set selectionStart(v: number) {
    const end = Math.max(v, this.selectionEnd);
    this.select(v, end);
  }
  get selectionEnd(): number {
    return this.view.state.selection.main.to;
  }
  set selectionEnd(v: number) {
    const start = Math.min(v, this.selectionStart);
    this.select(start, v);
  }
  private select(a: number, b: number): void {
    const len = this.view.state.doc.length;
    const from = Math.max(0, Math.min(a, len));
    const to = Math.max(from, Math.min(b, len));
    this.view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
  }
  get style(): CSSStyleDeclaration {
    return this.view.dom.style;
  }
  get scrollHeight(): number {
    return this.view.dom.scrollHeight;
  }
  get offsetHeight(): number {
    return this.view.dom.offsetHeight;
  }
  get clientWidth(): number {
    return this.view.dom.clientWidth;
  }
  get clientHeight(): number {
    return this.view.dom.clientHeight;
  }
  get scrollTop(): number {
    return this.view.scrollDOM.scrollTop;
  }
  set scrollTop(v: number) {
    this.view.scrollDOM.scrollTop = v;
  }
  closest(selector: string): Element | null {
    return this.view.dom.closest(selector);
  }
  getBoundingClientRect(): DOMRect {
    return this.view.dom.getBoundingClientRect();
  }
}

/** The element behind either box, for `getComputedStyle` and the send motion. */
export function boxElement(b: ComposerBox | null): HTMLElement | null {
  if (!b) return null;
  return b instanceof LiveBoxHandle ? b.element : (b as unknown as HTMLElement);
}
