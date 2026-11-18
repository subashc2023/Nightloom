<script lang="ts">
  // Item 839 (his bug, 2026-11-18: the app "keeps getting more zoomed out"):
  // a zoom that is not 100 % is never silent — the top bar says the level
  // and the way back, and a click puts it back to 100 %. Absent at 100 %.
  import { tip } from "./tip";
  import { runZoom, zoomLabel } from "./zoom";
  import { zoomNow } from "./zoomLevel.svelte";
  import { isMac } from "./platform";
  const mod = isMac ? "⌘" : "Ctrl+";
</script>

{#if zoomNow.level !== 1}
  <button
    class="ns-chip zoom-chip"
    use:tip={`The whole app is zoomed to ${zoomLabel(zoomNow.level)} — click or ${mod}0 for 100%`}
    onclick={() => void runZoom("zoom_reset", "chip")}
  >
    {zoomLabel(zoomNow.level)} · {mod}0
  </button>
{/if}

<style>
  .zoom-chip {
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    color: var(--accent, var(--ink2));
  }
</style>
