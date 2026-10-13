<script lang="ts">
  /**
   * The zone a moving card's pointer is over (nightshift backlog 156): the
   * strip or the edge band in the accent's dashed box — his "yellow box" —
   * with what a release does, and a strip's slot marker. Fixed to the
   * window, drawn over the moving card (`z`) so its label reads, never
   * taking the pointer.
   */
  import { app } from "./state.svelte";
  import { zoneLabel } from "./floatingMove";
  import type { Zone } from "./floatingMove";

  let { zone, z = 16 }: { zone: Zone; z?: number } = $props();
</script>

<div
  class="move-zone"
  class:edge={zone.kind === "edge"}
  aria-hidden="true"
  style:z-index={z}
  style:left={`${zone.rect.left}px`}
  style:top={`${zone.rect.top}px`}
  style:width={`${zone.rect.width}px`}
  style:height={`${zone.rect.height}px`}
>
  <span>{zoneLabel(zone, app.tabs.panes.length)}</span>
</div>
{#if zone.kind === "strip"}
  <div
    class="move-slot"
    aria-hidden="true"
    style:z-index={z}
    style:left={`${zone.marker - 1}px`}
    style:top={`${zone.rect.top + 4}px`}
    style:height={`${Math.max(8, zone.rect.height - 8)}px`}
  ></div>
{/if}

<style>
  .move-zone {
    position: fixed;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 12px;
    background: rgba(224, 164, 88, 0.16);
    border: 1px dashed var(--accent);
    border-radius: 6px;
    color: var(--accent);
    font-size: 12px;
    pointer-events: none;
  }
  .move-zone.edge {
    justify-content: center;
    padding: 0;
    writing-mode: vertical-rl;
    border-radius: 0;
  }
  .move-slot {
    position: fixed;
    width: 2px;
    background: var(--accent);
    border-radius: 1px;
    pointer-events: none;
  }
</style>
