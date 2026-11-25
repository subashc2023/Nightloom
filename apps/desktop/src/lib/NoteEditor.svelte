<script lang="ts">
  /**
   * The formatted side of a note (nightshift backlog 150): the CodeMirror
   * editor from `noteEditor.ts`, bound to the same `text` the plain
   * textarea binds, so the draft mirror, the ● draft mark, Revert and Save
   * see one buffer whichever side is showing.
   *
   * The text flows both ways. His typing reaches `value` through the
   * editor's update listener; a text set from outside (Revert, a proposal
   * opened in the editor) reaches the editor as the smallest edit that
   * makes the two agree, so a cursor in the untouched part stays put.
   * `caret` is where to put the cursor on mount — the textarea's, when he
   * switches over mid-edit — and `oncaret` reports every move back.
   *
   * Item 498: this is the only editor a note has. `markdown` turns the
   * drawing off and on in place (a Compartment, `setMarkdown`), so the
   * caret, the undo history and the scroll survive the switch; `run` applies
   * a toolbar action as one transaction.
   */
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { isMarkdown, noteExtensions, noteStateFor, runCommand, setMarkdown } from "./noteEditor";
  import { keepEditorHistory } from "./editorHistory";
  import type { Command } from "./noteFormat";
  import type { EditorState } from "@codemirror/state";
  import { clampCaret, minimalChange } from "./noteMode";

  let {
    value = $bindable(""),
    caret = 0,
    placeholder = "",
    oncaret,
    onfollow,
    markdown = false,
    imageSource,
    onpaste,
    historyKey = null,
  }: {
    value?: string;
    caret?: number;
    placeholder?: string;
    oncaret?: (offset: number) => void;
    onfollow?: (target: string) => void;
    /** Item 498: the raw Markdown, nothing drawn. */
    markdown?: boolean;
    /** A relative image link's loadable URL (item 498). */
    imageSource?: (src: string) => Promise<string | null>;
    /** Item 860: a paste, before the editor's own; true when it took it. */
    onpaste?: (e: ClipboardEvent) => boolean;
    /** Item 934: the note buffer this editor shows; its undo history is the
     *  buffer's (`editorHistory.ts`), kept when this editor goes and back
     *  when one shows the buffer again with the same text. */
    historyKey?: string | null;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  onMount(() => {
    const at = clampCaret(caret, value);
    const mountedKey = historyKey;
    view = new EditorView({
      parent: host,
      state: noteStateFor(
        mountedKey,
        value,
        at,
        noteExtensions({
          onChange: (t) => {
            value = t;
          },
          onCaret: (o) => oncaret?.(o),
          onFollow: (t) => onfollow?.(t),
          placeholder,
          imageSource,
          onPaste: (e) => onpaste?.(e) ?? false,
        }),
        { markdown },
      ),
    });
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
    return () => {
      // Item 934: the history goes with the buffer, not with this editor.
      if (view && mountedKey !== null) keepEditorHistory(mountedKey, view.state);
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    const next = value;
    if (!view) return;
    const change = minimalChange(view.state.doc.toString(), next);
    if (change) view.dispatch({ changes: change });
  });

  /** The Markdown switch: the same editor, the drawing off or on. */
  $effect(() => {
    const md = markdown;
    if (!view || isMarkdown(view.state) === md) return;
    // The line at the top of the view stays at the top: the two views set
    // the text at different heights, and without the snapshot the scroller
    // jumped to 0 (measured in 498-harness: 839 px → 0).
    view.dispatch({ effects: [setMarkdown(md), view.scrollSnapshot()] });
  });

  /** Where the cursor is now. */
  export function head(): number {
    return view ? view.state.selection.main.head : caret;
  }

  /** A toolbar action, as one transaction; the editor keeps the focus. */
  export function run(cmd: Command): boolean {
    if (!view) return false;
    const done = runCommand(view, cmd);
    view.focus();
    return done;
  }

  /** The editor's state now (the Text style menu's tick reads it). */
  export function editorState(): EditorState | null {
    return view?.state ?? null;
  }

  /** Item 860: `text` in at the caret (over any selection), as one paste;
   *  `blocks`: a paste of paragraphs is set apart by a blank line. */
  export function insertAtCaret(text: string, blocks = false): void {
    if (!view) return;
    const r = view.state.selection.main;
    if (blocks && text.includes("\n")) {
      // Several paragraphs stand apart from the text around them.
      const doc = view.state.doc;
      const before = doc.sliceString(Math.max(0, r.from - 2), r.from);
      const after = doc.sliceString(r.to, Math.min(doc.length, r.to + 2));
      if (before && !before.endsWith("\n")) text = `\n\n${text}`;
      else if (before && before !== "\n\n" && r.from > 1) text = `\n${text}`;
      if (after && !after.startsWith("\n")) text = `${text}\n\n`;
      else if (after && after !== "\n\n" && after.length > 1) text = `${text}\n`;
    }
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: text },
      selection: { anchor: r.from + text.length },
      userEvent: "input.paste",
      scrollIntoView: true,
    });
  }

  /** Item 860: the first `from` in the text read as `to` (an image's link
   *  moved or failed); false when it is not there (he deleted it). */
  export function replaceFirst(from: string, to: string): boolean {
    if (!view) return false;
    const at = view.state.doc.toString().indexOf(from);
    if (at < 0) return false;
    view.dispatch({ changes: { from: at, to: at + from.length, insert: to } });
    return true;
  }

  /** Give the editor the keyboard back (after a menu or the file picker). */
  export function focus(): void {
    view?.focus();
  }
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .editor :global(.cm-editor) {
    flex: 1;
    min-height: 0;
  }

  /* ---- Filament IV (item 565, stage 8; f4-notes.png) ----
     Behind the layout gate. A to-do line shows its box alone (no bullet
     before it); the reading face at the transcript's size; headings in
     the ink colour, the text column held to the transcript's measure. */
  :global(:where(:root:not([data-layout="classic"]))) .editor {
    background: var(--paper);
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-line:has(.cm-ntask) .cm-nbullet) {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-editor) {
    font-size: 15.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-editor:not(.cm-nsource) .cm-content) {
    max-width: calc(760px + 2 * var(--pad, 1.2rem));
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-nh) {
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-nh2) {
    font-size: 1.2em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .editor :global(.cm-nh3) {
    font-size: 1.08em;
  }
</style>
