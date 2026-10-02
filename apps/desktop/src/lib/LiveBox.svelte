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
  import { Compartment, Prec, type Extension } from "@codemirror/state";
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

  onMount(() => {
    if (!host) return;
    const v = new EditorView({
      state: composerState(value, extensions(), initialCaret ?? value.length, false),
      parent: host,
    });
    view = v;
    const mine = new LiveBoxHandle(v);
    handle = mine;
    return () => {
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
