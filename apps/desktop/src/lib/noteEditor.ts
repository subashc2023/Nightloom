/**
 * The formatted note editor (nightshift backlog 150): CodeMirror 6 — a
 * code-editor library whose document is plain text — with Markdown drawn in
 * place. The note stays the Markdown file it is on disk; what changes is
 * only how its text is drawn. Headings are sized, emphasis applied, code
 * set in mono, links underlined, and every `$…$` / `$$…$$` formula typeset
 * by KaTeX, while the syntax marks (`#`, `**`, `` ` ``, `[`…`](url)`) are
 * hidden. Wherever the cursor is, the source comes back: a heading's `#`s
 * on its line, a formula's TeX when the cursor enters it — the shape
 * Obsidian calls Live Preview.
 *
 * Nothing here writes to the text. Every decoration is drawn over the
 * document, never into it, and the editor's line separator is fixed to
 * "\n" with nothing else recognised, so a `\r` stays a character in its
 * line and the text read back out is byte-for-byte the text put in
 * (`noteState` and its test). The only way the text changes is his typing,
 * which the plain textarea would have typed the same: no Markdown keymap
 * (it continues list markup on Enter), no paste-URL-as-link, no
 * autocompletion.
 *
 * The decorations are computed from the whole document in one state field,
 * not per viewport by a view plugin, because a display formula spanning
 * lines has to be a block decoration, and CodeMirror takes those only from
 * state. Notes are short enough that a full pass per change costs nothing
 * measurable; the parse is bounded by `ensureSyntaxTree`'s time budget.
 */
import {
  EditorSelection,
  EditorState,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { LanguageSupport, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { findMath, type MathSpan } from "./math";
import { renderMathHtml } from "./markdown";

/** The same one-line `[[target|alias]]` shape `links.ts` parses. */
const WIKILINK = /\[\[([^\[\]\n]{1,200})\]\]/g;

/** Node types whose content is code: nothing inside is math or a link. */
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"]);

/** Inline spans whose marks the editor hides. */
const INLINE_NODES = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode", "Link"]);

/** Does any selection range touch `[from, to]`, ends included? */
function touches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

/** Is the cursor (any range) on one of the lines `[from, to]` covers? */
function onLines(state: EditorState, from: number, to: number): boolean {
  const a = state.doc.lineAt(from).from;
  const b = state.doc.lineAt(to).to;
  return touches(state, a, b);
}

/** A typeset formula standing where its source is. */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block: boolean,
    readonly openLen: number,
  ) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.block === this.block;
  }
  toDOM(view: EditorView): HTMLElement {
    const el: HTMLElement = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? "cm-nmath cm-nmath-block" : "cm-nmath";
    el.innerHTML = renderMathHtml(this.tex, this.display);
    el.title = "Click to edit the formula";
    // A click opens the formula for editing: the cursor goes just inside
    // its opening delimiter, which is inside the span, so the source is
    // drawn in its place. Read from the DOM, not kept on the widget: an
    // equal widget is reused after an edit that moved it.
    el.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const at = view.posAtDOM(el);
      const inside = this.block ? view.state.doc.lineAt(at).from : at;
      const text = view.state.doc.sliceString(inside, Math.min(view.state.doc.length, inside + 8));
      const lead = text.length - text.trimStart().length;
      view.dispatch({ selection: EditorSelection.cursor(inside + lead + this.openLen) });
      view.focus();
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** The bullet a `-`, `*` or `+` list mark is drawn as off the cursor's line. */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-nbullet";
    el.textContent = "•";
    return el;
  }
}

/** A horizontal rule drawn as one, off the cursor's line. */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-nrule";
    return el;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

/** One formula's decoration, `null` while the cursor is in it. */
function mathDecoration(state: EditorState, m: MathSpan): Range<Decoration> | null {
  if (touches(state, m.from, m.to)) return null;
  const doc = state.doc;
  const first = doc.lineAt(m.from);
  const last = doc.lineAt(m.to);
  // A formula alone on its lines — a `$$` block, or a one-line `$$…$$`
  // with nothing else on it — is drawn as a block over those whole lines.
  const alone =
    m.display &&
    doc.sliceString(first.from, m.from).trim() === "" &&
    doc.sliceString(m.to, last.to).trim() === "";
  if (alone && (m.block || first.number !== last.number)) {
    if (onLines(state, first.from, last.to)) return null;
    return Decoration.replace({
      widget: new MathWidget(m.tex, true, true, m.openLen),
      block: true,
    }).range(first.from, last.to);
  }
  return Decoration.replace({
    widget: new MathWidget(m.tex, m.display, false, m.openLen),
  }).range(m.from, m.to);
}

/**
 * The note's decorations, all of them, for the state as it stands. Pure
 * over the state, so the suite reads them without a DOM.
 */
export function noteDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const out: Range<Decoration>[] = [];
  const code: [number, number][] = [];
  const lineClass = (pos: number, cls: string) =>
    out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const eachLine = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number, end = doc.lineAt(to).number; n <= end; n++)
      out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
  };

  tree.iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) code.push([node.from, node.to]);
    },
  });
  const inCode = (from: number, to: number) => code.some(([a, b]) => from < b && to > a);

  // Math first: syntax inside a formula (`$a*b*c$` parses as emphasis) is
  // the formula's, so nothing else is drawn over one.
  const maths = findMath(text).filter((m) => !inCode(m.from, m.to));
  const inMath = (from: number, to: number) => maths.some((m) => from < m.to && to > m.from);
  for (const m of maths) {
    const d = mathDecoration(state, m);
    if (d) out.push(d);
  }

  tree.iterate({
    enter(node) {
      const { from, to, name } = node;
      // A formula's own text is left to it: a node inside one is skipped,
      // and so is an inline span that runs into one (`*a $b* c$`), whose
      // hidden marks would cut across the formula's widget.
      if (maths.some((m) => from >= m.from && to <= m.to)) return false;
      if (INLINE_NODES.has(name) && inMath(from, to)) return false;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        lineClass(from, `cm-nh cm-nh${heading[1]}`);
        if (!onLines(state, from, to)) {
          // The leading `#`s and the space after them, and a closing run
          // (`## Title ##`) when there is one.
          const marks = node.node.getChildren("HeaderMark");
          const mark = marks[0];
          if (mark) {
            const after = doc.sliceString(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to;
            out.push(hide.range(mark.from, after));
          }
          if (marks.length > 1) {
            const tail = marks[marks.length - 1];
            out.push(hide.range(tail.from, tail.to));
          }
        }
        return;
      }
      const setext = /^SetextHeading(\d)$/.exec(name);
      if (setext) {
        const mark = node.node.getChild("HeaderMark");
        eachLine(from, mark ? mark.from - 1 : to, `cm-nh cm-nh${setext[1]}`);
        if (mark) lineClass(mark.from, "cm-nfaint");
        return;
      }
      switch (name) {
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough": {
          const cls = name === "Emphasis" ? "cm-nem" : name === "StrongEmphasis" ? "cm-nstrong" : "cm-nstrike";
          out.push(Decoration.mark({ class: cls }).range(from, to));
          if (!touches(state, from, to)) {
            const markName = name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
            for (const m of node.node.getChildren(markName)) out.push(hide.range(m.from, m.to));
          }
          return;
        }
        case "InlineCode": {
          out.push(Decoration.mark({ class: "cm-ncode" }).range(from, to));
          if (!touches(state, from, to))
            for (const m of node.node.getChildren("CodeMark")) out.push(hide.range(m.from, m.to));
          return false;
        }
        case "Link": {
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          // `[text](url)`: the text is the link, the rest hides off the
          // cursor. A reference link (`[text][ref]`) keeps its brackets.
          if (marks.length >= 2 && url) {
            out.push(Decoration.mark({ class: "cm-nlink" }).range(marks[0].to, marks[1].from));
            if (!touches(state, from, to)) {
              out.push(hide.range(marks[0].from, marks[0].to));
              out.push(hide.range(marks[1].from, to));
            }
          } else {
            out.push(Decoration.mark({ class: "cm-nlink" }).range(from, to));
          }
          return false;
        }
        case "ListMark": {
          const parent = node.node.parent?.parent;
          if (parent?.name === "BulletList" && !onLines(state, from, to)) out.push(bullet.range(from, to));
          else out.push(Decoration.mark({ class: "cm-nlistmark" }).range(from, to));
          return;
        }
        case "Blockquote": {
          eachLine(from, to, "cm-nquote");
          return;
        }
        case "QuoteMark": {
          if (!onLines(state, from, to)) {
            const after = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, after));
          }
          return;
        }
        case "FencedCode": {
          const info = node.node.getChild("CodeInfo");
          const lang = info ? doc.sliceString(info.from, info.to).trim() : "";
          const body = node.node.getChild("CodeText");
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          // ```math is typeset, as the preview does; off the cursor only.
          if (lang === "math" && body && !onLines(state, from, to) && last.number > first.number) {
            out.push(
              Decoration.replace({
                widget: new MathWidget(doc.sliceString(body.from, body.to), true, true, 0),
                block: true,
              }).range(first.from, last.to),
            );
            return false;
          }
          eachLine(from, to, "cm-ncodeblock");
          lineClass(from, "cm-nfence");
          const marks = node.node.getChildren("CodeMark");
          if (marks.length > 1) lineClass(marks[marks.length - 1].from, "cm-nfence");
          return false;
        }
        case "CodeBlock": {
          eachLine(from, to, "cm-ncodeblock");
          return false;
        }
        case "HorizontalRule": {
          if (!onLines(state, from, to)) out.push(rule.range(from, to));
          return;
        }
      }
    },
  });

  // `[[links]]` are a vault convention, not Markdown: found by the same
  // pattern `links.ts` uses, drawn as a link, ⌘-click follows them.
  for (const m of text.matchAll(WIKILINK)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (inCode(from, to) || inMath(from, to)) continue;
    const inner = m[1];
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (!target) continue;
    out.push(
      Decoration.mark({
        class: "cm-nwikilink",
        attributes: { "data-wikilink": target, title: `${target} — ⌘-click to open` },
      }).range(from + 2, to - 2),
    );
    if (!touches(state, from, to)) {
      // The alias, when there is one, is what shows.
      out.push(hide.range(from, from + 2 + (bar < 0 ? 0 : bar + 1)));
      out.push(hide.range(to - 2, to));
    }
  }

  return Decoration.set(out, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: (state) => noteDecorations(state),
  update(value, tr) {
    return tr.docChanged || tr.selection ? noteDecorations(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The theme: the app's own tokens, so it follows the palette he picked. */
const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    fontSize: "0.95rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--sans)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "1rem 1.2rem",
    caretColor: "var(--accent)",
    maxWidth: "48rem",
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-placeholder": { color: "var(--dim)" },
  ".cm-nh": { fontWeight: "600", lineHeight: "1.35" },
  ".cm-nh1": { fontSize: "1.6em", paddingTop: "0.4em" },
  ".cm-nh2": { fontSize: "1.35em", paddingTop: "0.35em" },
  ".cm-nh3": { fontSize: "1.15em", paddingTop: "0.3em" },
  ".cm-nh4, .cm-nh5, .cm-nh6": { fontSize: "1em" },
  ".cm-nem": { fontStyle: "italic" },
  ".cm-nstrong": { fontWeight: "650" },
  ".cm-nstrike": { textDecoration: "line-through" },
  ".cm-ncode": {
    fontFamily: "var(--mono)",
    fontSize: "0.88em",
    background: "var(--well)",
    borderRadius: "4px",
    padding: "0.05em 0.25em",
  },
  ".cm-ncodeblock": {
    fontFamily: "var(--mono)",
    fontSize: "0.86em",
    background: "var(--well)",
  },
  ".cm-nfence, .cm-nfaint, .cm-nlistmark": { color: "var(--dim)" },
  ".cm-nlink, .cm-nwikilink": {
    color: "var(--accent)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
    textUnderlineOffset: "2px",
  },
  ".cm-nquote": {
    borderLeft: "3px solid var(--border)",
    paddingLeft: "0.8em !important",
    color: "var(--dim)",
  },
  ".cm-nbullet": { color: "var(--dim)" },
  ".cm-nrule": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--border)",
  },
  ".cm-nmath": { cursor: "pointer" },
  ".cm-nmath-block": { textAlign: "center", padding: "0.3em 0" },
  ".cm-nmath:hover": {
    outline: "1px dashed color-mix(in srgb, var(--accent) 50%, transparent)",
    borderRadius: "4px",
  },
});

export interface NoteEditorHooks {
  /** Every change to the text, as the whole new text. */
  onChange: (text: string) => void;
  /** The cursor moved: where it is now, as an offset into the text. */
  onCaret?: (offset: number) => void;
  /** ⌘-click (Ctrl elsewhere) on a `[[link]]`. */
  onFollow?: (target: string) => void;
  placeholder?: string;
}

/**
 * The editor's state for `text`, cursor at `cursor` (clamped). Exported so
 * the suite can prove the round trip without a view: `doc.toString()` of
 * this state is `text`, byte for byte.
 */
export function noteState(text: string, cursor: number, extensions: Extension[] = []): EditorState {
  const at = Math.max(0, Math.min(cursor, text.length));
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(at),
    extensions: [
      // Split on "\n" only and join with "\n": a `\r` is a character, so
      // CRLF and lone-CR text survives untouched.
      EditorState.lineSeparator.of("\n"),
      new LanguageSupport(markdownLanguage),
      livePreview,
      ...extensions,
    ],
  });
}

/** The view's extensions beyond `noteState`'s: editing, the theme, hooks. */
export function noteExtensions(hooks: NoteEditorHooks): Extension[] {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": "Note text",
      spellcheck: "false",
    }),
    ...(hooks.placeholder ? [placeholder(hooks.placeholder)] : []),
    theme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange(u.state.doc.toString());
      if (u.docChanged || u.selectionSet) hooks.onCaret?.(u.state.selection.main.head);
    }),
    EditorView.domEventHandlers({
      mousedown(e) {
        if (!(e.metaKey || e.ctrlKey) || !hooks.onFollow) return false;
        const link = (e.target as HTMLElement | null)?.closest?.("[data-wikilink]");
        const target = link?.getAttribute("data-wikilink");
        if (!target) return false;
        e.preventDefault();
        hooks.onFollow(target);
        return true;
      },
    }),
  ];
}
