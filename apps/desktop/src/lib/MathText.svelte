<script lang="ts" module>
  import { renderMathHtml } from "./markdown";
  // A bubble is redrawn on every transcript mount; its formulas seldom change.
  const htmlMemo = new Map<string, string>();
  function mathHtml(tex: string, display: boolean): string {
    const k = `${display ? 1 : 0}${tex}`;
    let h = htmlMemo.get(k);
    if (h === undefined) {
      h = renderMathHtml(tex, display);
      if (htmlMemo.size >= 300) htmlMemo.delete(htmlMemo.keys().next().value!);
      htmlMemo.set(k, h);
    }
    return h;
  }
</script>

<script lang="ts">
  import { drawnParts, mathParts } from "./userMath";

  /**
   * Item 837: words a person typed, with their maths typeset (`userMath.ts`)
   * — his sent message on the Mac (both looks) and on the phone. Everything
   * that is not a formula is the text as typed, in the parent's own
   * `white-space`; a formula's source is on `data-tex`.
   */
  let { text }: { text: string } = $props();
  const parts = $derived(drawnParts(mathParts(text)));
</script>

{#each parts as p, i (i)}{#if p.kind === "math"}<span class="user-math" class:display={p.display} data-tex={p.src}>{@html mathHtml(p.tex, p.display)}</span>{:else}{p.text}{/if}{/each}

<style>
  /* KaTeX sizes itself for a document; beside a message's words it reads as a heading (app.css `.markdown .katex`). */
  .user-math :global(.katex) {
    font-size: 1.05em;
    white-space: nowrap;
  }
  .user-math.display {
    display: block;
    white-space: normal;
  }
  .user-math.display :global(.katex-display) {
    margin: 0.35em 0;
    padding: 0.2em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .user-math :global(.katex-error),
  .user-math :global(.math-error) {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--error);
  }
</style>
