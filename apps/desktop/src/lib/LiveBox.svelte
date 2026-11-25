<script lang="ts">
  /*
   * The message box with formatting drawn in place (nightshift item 276):
   * a CodeMirror editor standing where the composer's textarea stands, with
   * the same text, the same keys the composer handles first, and a
   * `LiveBoxHandle` the composer drives as it drives the textarea. The
   * decorations and the plain-textarea keymap are `composerEditor.ts`'s.
   *
   * The draft store stays the one source of the text: every change goes out
   * through `onchange` (the composer's `setDraftText`), and a text set from
   * outside — a chat switch, a send clearing the box, a picked slash
   * command, a quote, a rewind — comes back in through `value` as a fresh
   * state, caret at the end, as a textarea's value set does.
   */
  import { onMount, untrack } from "svelte";
  import { Compartment, EditorSelection, Prec, type Extension } from "@codemirror/state";
  import { EditorView, placeholder as placeholderExt } from "@codemirror/view";
  import { isMac } from "./platform";
  import { routeLink } from "./webtabs.svelte";
  import { boxDrawing, boxLinkClicks, composerKeymap, composerState, composerStateFor, composerTheme, LiveBoxHandle, type BoxDrawing, type ComposerBox } from "./composerEditor";
  import { keepEditorHistory } from "./editorHistory";

  interface Props {
    value: string;
    placeholder?: string;
    /** The box's accessible name (item 399: the edit box is "Edit this message"). */
    label?: string;
    disabled?: boolean;
    floating?: boolean;
    /** Where the caret goes when the box first appears (the plain box's, on a toggle). */
    initialCaret?: number | null;
    onchange: (text: string) => void;
    oninput?: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onpaste?: (e: ClipboardEvent) => void;
    onblur?: () => void;
    /** The text's height may have changed without his typing (a chat switch): re-measure the box. */
    onresize?: () => void;
    handle?: ComposerBox | null;
    /** Item 689: "plain" — the plain box while it holds a table: the grid
     *  (and quote / code lines) drawn, the text round them plain. */
    drawing?: BoxDrawing;
    /**
     * Item 934: the draft this box shows — a chat's or an aside's draft key,
     * an edit box's. The undo history is that draft's (`editorHistory.ts`):
     * kept when the key changes or the box unmounts, back when a box shows
     * the draft again, so ⌘Z after a chat or tab switch and back still
     * undoes. Null keeps none (a fresh history per text set, as before).
     */
    historyKey?: string | null;
  }
  let {
    value,
    placeholder = "",
    label = "Message",
    disabled = false,
    floating = false,
    initialCaret = null,
    onchange,
    oninput,
    onkeydown,
    onpaste,
    onblur,
    onresize,
    handle = $bindable(null),
    drawing = "all",
    historyKey = null,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  /** The draft whose text and history `view` holds now (item 934). */
  let boxKey: string | null = untrack(() => historyKey);
  const editable = new Compartment();
  const hint = new Compartment();
  const draws = new Compartment();

  function extensions(): Extension[] {
    return [
      composerKeymap(),
      EditorView.lineWrapping,
      // No autocorrect, capitalisation or spell-marking, as on the textarea
      // (macOS was rewriting his words, 2026-09-16).
      EditorView.contentAttributes.of({
        "aria-label": untrack(() => label),
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
      }),
      composerTheme,
      // Item 696: ⌘-click on a drawn link opens it as a reply's link opens.
      boxLinkClicks((href) => routeLink(href, false), isMac),
      draws.of(boxDrawing.of(untrack(() => drawing))),
      editable.of(EditorView.editable.of(!disabled)),
      hint.of(placeholder ? placeholderExt(placeholder) : []),
      // Before CodeMirror's own handling: the composer's keys (Enter sends,
      // ↑ takes back, the menus' arrows) and its paste (images become
      // chips). A key the composer took is not CodeMirror's.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(e) {
            // Mid-composition keys are the input method's (IME).
            if (e.isComposing || e.keyCode === 229) return false;
            onkeydown?.(e);
            return e.defaultPrevented;
          },
          paste(e) {
            onpaste?.(e);
            return e.defaultPrevented;
          },
          // A dropped file is an attachment (the composer's drop handler,
          // further up) — never its text read into the box, which is what
          // CodeMirror would do with it.
          drop(e) {
            return (e.dataTransfer?.files?.length ?? 0) > 0;
          },
          blur() {
            onblur?.();
            return false;
          },
        }),
      ),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        onchange(u.state.doc.toString());
        oninput?.();
      }),
    ];
  }

  /**
   * A click in the box but below or beside the text (the box is taller than
   * its text after a drag, or for a frame after a chat switch) lands on
   * CodeMirror's scroller, not its text: the browser focused the scroller
   * and every key typed after it went nowhere (fix pass, 2026-10-01). As a
   * textarea does, such a click puts the caret at the nearest place in the
   * text, and keeps the focus in the text.
   */
  function clickOutsideText(v: EditorView, e: MouseEvent): void {
    if (e.button !== 0 || v.contentDOM.contains(e.target as Node)) return;
    e.preventDefault();
    const at = v.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const sel = v.state.selection.main;
    v.dispatch({
      selection: e.shiftKey ? EditorSelection.range(sel.anchor, at) : EditorSelection.cursor(at),
      scrollIntoView: true,
    });
    v.focus();
  }

  /**
   * After a text set from outside, the box's height is measured once
   * CodeMirror has laid the new text out — its next measure, not this
   * frame, in which the old chat's height still stands (a box left at the
   * last chat's five lines for one line of text, fix pass).
   */
  function resizeAfterLayout(v: EditorView): void {
    v.requestMeasure({
      key: "composer-resize",
      read: () => null,
      write: () => requestAnimationFrame(() => onresize?.()),
    });
  }

  onMount(() => {
    if (!host) return;
    const v = new EditorView({
      state: composerStateFor(boxKey, value, extensions(), initialCaret, false),
      parent: host,
    });
    view = v;
    const onDown = (e: MouseEvent) => clickOutsideText(v, e);
    v.dom.addEventListener("mousedown", onDown);
    const mine = new LiveBoxHandle(v);
    handle = mine;
    return () => {
      v.dom.removeEventListener("mousedown", onDown);
      // Item 934: the history goes with the draft, not with this box.
      if (boxKey !== null) keepEditorHistory(boxKey, v.state);
      v.destroy();
      view = null;
      // Only if the composer still points here: on a toggle the textarea
      // may already have taken the binding.
      if (handle === mine) handle = null;
    };
  });

  // A text set from outside. Our own changes come back equal and stop here.
  // Item 934: another draft arriving (a chat switch) is not a text set: the
  // draft left keeps its history and the one arriving gets its own back.
  $effect(() => {
    const next = value;
    const k = historyKey;
    untrack(() => {
      if (!view) return;
      const from = boxKey;
      boxKey = k;
      if (k !== from) {
        if (from !== null) keepEditorHistory(from, view.state);
        view.setState(composerStateFor(k, next, extensions(), null, view.hasFocus));
        resizeAfterLayout(view);
        return;
      }
      if (next.replace(/\r\n?/g, "\n") === view.state.doc.toString()) return;
      view.setState(composerState(next, extensions(), next.length, view.hasFocus));
      resizeAfterLayout(view);
    });
  });

  $effect(() => {
    const d = drawing;
    untrack(() => view?.dispatch({ effects: draws.reconfigure(boxDrawing.of(d)) }));
  });

  $effect(() => {
    const off = disabled;
    const p = placeholder;
    untrack(() =>
      view?.dispatch({
        effects: [
          editable.reconfigure(EditorView.editable.of(!off)),
          hint.reconfigure(p ? placeholderExt(p) : []),
        ],
      }),
    );
  });
</script>

<div class="live-box" class:floating class:disabled bind:this={host}></div>

<style>
  .live-box {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
  }
  .live-box.floating :global(.cm-editor) {
    font-size: 15.5px;
  }
  .live-box.disabled {
    opacity: 0.5;
  }
</style>
