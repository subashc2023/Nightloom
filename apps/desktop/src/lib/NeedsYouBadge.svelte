<script lang="ts">
  /**
   * The tab strip's one button (item 1026, his pick B; before it, item 753's needs-you pill): beside the
   * running badge on the last pane's strip, over every view and every aside. The button and its two-mode card
   * are NotificationCentre.svelte — the bell and the pill made one; this slot holds its place on the strip and
   * keeps the board fresh.
   */
  import { untrack } from "svelte";
  import { refreshBoard } from "./needsBoard.svelte";
  import NotificationCentre from "./NotificationCentre.svelte";

  // The blockers and shipped items are files: read now, then every five minutes.
  $effect(() => {
    untrack(() => void refreshBoard());
    const t = setInterval(() => void refreshBoard(), 300_000);
    return () => clearInterval(t);
  });
</script>

<span class="one-slot"><NotificationCentre /></span>

<style>
  .one-slot {
    position: sticky;
    right: 0;
    margin: 4px 6px 4px auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: var(--sheet);
  }
  /* Beside the running badge, which takes the strip's free space itself. */
  .one-slot + :global(.run-badge) {
    margin-left: 0 !important;
  }
</style>
