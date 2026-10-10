<script lang="ts">
  /**
   * The running badge (nightshift backlog 309, 2026-10-04): how many things
   * run now in every project — turns, councils, subagents, asides, note
   * edits, the dream and capture, Nightshift — at the right end of the tab
   * strip, shown only while something runs. A click opens the Running-tasks
   * panel, whose first group lists each one and opens its chat.
   *
   * On the strip, not the chat's top bar: the strip is drawn over every
   * view (the Nightshift page, a note, the graph), the top bar over a chat
   * only — "one click from anywhere" (blocker 1140 holds the choice).
   */
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { allRunning } from "./running.svelte";
  import { quitBlockers } from "./running";

  const runs = $derived(allRunning());
  const waiting = $derived(runs.some((r) => r.waiting));
  const title = $derived(
    [
      `${runs.length} running in every project${quitBlockers(runs).length < runs.length ? " (a Nightshift run keeps going if the app quits)" : ""} — click for the list`,
      ...runs.slice(0, 8).map((r) => `· ${[r.where, r.chat, r.kind].filter(Boolean).join(" · ")}`),
      ...(runs.length > 8 ? [`· and ${runs.length - 8} more`] : []),
    ].join("\n"),
  );
  function toggle() {
    app.showRail = false;
    app.showContext = false;
    app.showTasks = !app.showTasks;
  }
</script>

{#if runs.length > 0}
  <button
    class="run-badge"
    class:waiting
    class:open={app.showTasks}
    aria-label={`${runs.length} running — open the running list`}
    aria-expanded={app.showTasks}
    use:tip={title}
    onclick={toggle}
  >
    <span class="pulse" aria-hidden="true"></span>
    <span class="n">{runs.length}</span>
    <span class="word">running</span>
  </button>
{/if}

<style>
  .run-badge {
    position: sticky;
    right: 0;
    margin: 4px 0 4px auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px 0 8px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--live-soft);
    color: var(--live);
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
    /* Sticky over the tabs it overlaps when the strip scrolls. */
    box-shadow: -8px 0 8px -4px var(--paper);
  }
  .run-badge:hover,
  .run-badge.open {
    border-color: var(--live);
  }
  .run-badge.waiting {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.6s ease-in-out infinite;
  }
  .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>
