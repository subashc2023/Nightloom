<script lang="ts">
  // Item 839 (his bug, 2026-11-18: the app "keeps getting more zoomed out"):
  // a zoom that is not his default is never silent — the top bar says the
  // level and the way back, and a click puts it back. Absent at the default.
  // Item 876 (2026-11-19, 90 % "is kind of my default zoom"): the way back
  // is to his default (100 % until he sets one), and beside it "Make N%
  // default" makes the level he is at the one ⌘0 returns to.
  import { tip } from "./tip";
  import { runZoom, setZoomDefault, zoomLabel, zoomOffDefault } from "./zoom";
  import { zoomNow } from "./zoomLevel.svelte";
  import { isMac } from "./platform";
  const mod = isMac ? "⌘" : "Ctrl+";
</script>

{#if zoomOffDefault(zoomNow.level, zoomNow.def)}
  <!-- Two siblings, no wrapper: the top bars' `.right > .ns-chip` rules reach both. -->
  <button
    class="ns-chip zoom-chip"
    data-zoom-chip
    use:tip={`The whole app is zoomed to ${zoomLabel(zoomNow.level)} — click or ${mod}0 for your default, ${zoomLabel(zoomNow.def)}`}
    onclick={() => void runZoom("zoom_reset", "chip")}
  >
    {zoomLabel(zoomNow.level)} · {mod}0
  </button>
  <button
    class="ns-chip zoom-make"
    data-zoom-make
    use:tip={`Make ${zoomLabel(zoomNow.level)} your default — ${mod}0 returns here, and this chip hides at it. Settings → Appearance → Palette → Zoom changes it.`}
    onclick={() => void setZoomDefault(zoomNow.level, "chip")}
  >
    Make {zoomLabel(zoomNow.level)} default
  </button>
{/if}

<style>
  .zoom-chip {
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    color: var(--accent, var(--ink2));
  }
  .zoom-make {
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
    white-space: nowrap;
  }
</style>
