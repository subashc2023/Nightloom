<script lang="ts">
  /**
   * Home, pinned first in the sidebar above the projects (nightshift item 763, H1), in Jarvis and Classic:
   * one row, the Needs-you count beside it when anything waits on him. A click opens today's Home chat
   * (none yet → the project). Shown only once the backend has made Home.
   */
  import { untrack } from "svelte";
  import { tip } from "./tip";
  import { app, canLeaveProject } from "./state.svelte";
  import { homeNeedsNow } from "./needsBoard.svelte";
  import { homeCount, homeTip, isHome, todayFigure } from "./home";
  import * as api from "./api";
  import { home, homeProject, openHome, refreshHome } from "./home.svelte";
  import Icon from "./Icon.svelte";

  let { classic = false }: { classic?: boolean } = $props();

  const project = $derived(homeProject());
  const here = $derived(isHome(app.project));
  // 763 H5's review: Start cards wait on him too.
  // Item 995: the one Needs-you number, as the top pill says it (held blockers and proposals included).
  const n = $derived(homeNeedsNow().waiting);
  const count = $derived(homeCount(n));
  $effect(() => {
    if (project) untrack(() => void refreshHome());
  });
  // Item 763 H6: today's spend of Home's unattended runs, read with Home's info and each minute.
  let today = $state<api.HomeToday | null>(null);
  $effect(() => {
    if (!project) return;
    const read = () => void api.homeToday().then((t) => (today = t), () => (today = null));
    read();
    const t = setInterval(read, 60_000);
    return () => clearInterval(t);
  });
  const fig = $derived(todayFigure(today));
</script>

{#if project}
  <button
    class="home-row"
    class:classic
    class:here
    aria-current={here ? "true" : undefined}
    disabled={!canLeaveProject()}
    onclick={() => void openHome()}
    use:tip={homeTip(home.info?.scan_words, today)}
  >
    <span class="glyph"><Icon name="home" size={classic ? 14 : 15} /></span>
    <span class="name">{project.name}</span>
    {#if fig.paused}<span class="today paused" data-home-today>paused</span>{:else if fig.text}<span class="today" data-home-today>{fig.text}</span>{/if}
    {#if count}<span class="need" aria-label={count}>{count}</span>{/if}
  </button>
{/if}

<style>
  .home-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    flex: none;
    padding: 9px 16px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .home-row.classic {
    padding: 8px 18px;
    font-size: 13.5px;
  }
  .home-row:hover:not(:disabled) .name {
    color: var(--accent-ink);
  }
  .home-row.here {
    box-shadow: inset 2px 0 0 var(--accent-ink);
    background: color-mix(in srgb, var(--accent-ink) 6%, transparent);
  }
  .home-row:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .today {
    flex: none;
    font-size: 11px;
    color: var(--ink2);
    font-variant-numeric: tabular-nums;
  }
  .today.paused {
    color: var(--warn, var(--accent-ink));
  }
  .glyph {
    display: inline-flex;
    color: var(--ink2);
    flex: none;
  }
  .here .glyph {
    color: var(--accent-ink);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .need {
    flex: none;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
  }
</style>
