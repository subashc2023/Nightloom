<script lang="ts">
  /**
   * The plan's usage in the drawer (item 246, wave 1C): the 5-hour
   * window, when it resets, and the week — with two thin bars, the week's
   * being the one he protects (practices §3). Nothing when the host has
   * no `/api/usage`.
   */
  import { usageLine, type Usage } from "./client";

  let { usage }: { usage: Usage | null } = $props();
  const line = $derived(usageLine(usage));
  const bar = (pct: number | null | undefined) => `${Math.max(0, Math.min(100, pct ?? 0))}%`;
</script>

{#if line && usage}
  {@const p = usage.plan}
  <div class="ul" class:stale={p.stale} aria-label="Plan usage">
    <div class="ul-bars">
      {#if p.five_hour != null}<span class="ul-bar" title="5-hour window"><i style:width={bar(p.five_hour)} class:hot={p.five_hour >= 85}></i></span>{/if}
      {#if p.seven_day != null}<span class="ul-bar" title="Week"><i style:width={bar(p.seven_day)} class:hot={p.seven_day >= 85}></i></span>{/if}
    </div>
    <div class="ul-text">{line}</div>
  </div>
{/if}

<style>
  .ul {
    padding: 10px 18px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--dim);
  }
  .ul.stale {
    opacity: 0.55;
  }
  .ul-bars {
    display: flex;
    gap: 6px;
  }
  .ul-bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--well);
    overflow: hidden;
  }
  .ul-bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }
  .ul-bar i.hot {
    background: var(--failed);
  }
  .ul-text {
    font-variant-numeric: tabular-nums;
  }
</style>
