<script lang="ts">
  /**
   * Home, pinned first in the sidebar above the projects (nightshift item 763, H1), in Jarvis and Classic:
   * one row, the Needs-you count beside it when anything waits on him. A click opens today's Home chat
   * (none yet → the project). Shown only once the backend has made Home.
   */
  import { untrack } from "svelte";
  import { tip } from "./tip";
  import { app, canLeaveProject } from "./state.svelte";
  import { needsNow } from "./needsBoard.svelte";
  import { waitingCount } from "./needsYou";
  import { homeCount, isHome } from "./home";
  import { home, homeProject, openHome, refreshHome } from "./home.svelte";
  import Icon from "./Icon.svelte";

  let { classic = false }: { classic?: boolean } = $props();

  const project = $derived(homeProject());
  const here = $derived(isHome(app.project));
  const n = $derived(waitingCount(needsNow()));
  const count = $derived(homeCount(n));
  $effect(() => {
    if (project) untrack(() => void refreshHome());
  });
</script>

{#if project}
  <button
    class="home-row"
    class:classic
    class:here
    aria-current={here ? "true" : undefined}
    disabled={!canLeaveProject()}
    onclick={() => void openHome()}
    use:tip={home.info?.scan_words ? `Morning scan ${home.info.scan_words}` : "Today's Home chat"}
  >
    <span class="glyph"><Icon name="home" size={classic ? 14 : 15} /></span>
    <span class="name">{project.name}</span>
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
