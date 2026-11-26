<script lang="ts">
  /**
   * Item 991: one line of model-written words with its inline markdown drawn (`renderInline`) — Home's rows, titles
   * and detail values, on the Mac and the phone. His own typed words stay `MathText` (as typed, formulas set).
   */
  import { renderInline } from "./markdown";
  let { text }: { text: string } = $props();
</script>

<span class="md-inline">{@html renderInline(text)}</span>

<style>
  .md-inline :global(code) { font-family: var(--mono, ui-monospace, monospace); font-size: 0.92em; }
  .md-inline :global(a) { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
</style>
