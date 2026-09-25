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
   */
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { noteExtensions, noteState } from "./noteEditor";
  import { clampCaret, minimalChange } from "./noteMode";

  let {
    value = $bindable(""),
    caret = 0,
    placeholder = "",
    oncaret,
    onfollow,
  }: {
    value?: string;
    caret?: number;
    placeholder?: string;
    oncaret?: (offset: number) => void;
    onfollow?: (target: string) => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  onMount(() => {
    const at = clampCaret(caret, value);
    view = new EditorView({
      parent: host,
      state: noteState(
        value,
        at,
        noteExtensions({
          onChange: (t) => {
            value = t;
          },
          onCaret: (o) => oncaret?.(o),
          onFollow: (t) => onfollow?.(t),
          placeholder,
        }),
      ),
    });
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
    return () => {
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

  /** Where the cursor is now, for the switch back to plain. */
  export function head(): number {
    return view ? view.state.selection.main.head : caret;
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
</style>
