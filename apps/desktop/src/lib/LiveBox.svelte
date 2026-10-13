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
  import { composerKeymap, composerState, composerTheme, LiveBoxHandle, type ComposerBox } from "./composerEditor";

  interface Props {
    value: string;
    placeholder?: string;
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
  }
  let {
    value,
    placeholder = "",
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
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  const editable = new Compartment();
  const hint = new Compartment();

  function extensions(): Extension[] {
    return [
      composerKeymap(),
      EditorView.lineWrapping,
      // No autocorrect, capitalisation or spell-marking, as on the textarea
      // (macOS was rewriting his words, 2026-09-16).
      EditorView.contentAttributes.of({
        "aria-label": "Message",
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
      }),
      composerTheme,
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
      state: composerState(value, extensions(), initialCaret ?? value.length, false),
      parent: host,
    });
    view = v;
    const onDown = (e: MouseEvent) => clickOutsideText(v, e);
    v.dom.addEventListener("mousedown", onDown);
    const mine = new LiveBoxHandle(v);
    handle = mine;
    return () => {
      v.dom.removeEventListener("mousedown", onDown);
      v.destroy();
      view = null;
      // Only if the composer still points here: on a toggle the textarea
      // may already have taken the binding.
      if (handle === mine) handle = null;
    };
  });

  // A text set from outside. Our own changes come back equal and stop here.
  $effect(() => {
    const next = value;
    untrack(() => {
      if (!view) return;
      if (next.replace(/\r\n?/g, "\n") === view.state.doc.toString()) return;
      view.setState(composerState(next, extensions(), next.length, view.hasFocus));
      resizeAfterLayout(view);
    });
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
