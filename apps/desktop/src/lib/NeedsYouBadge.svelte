<script lang="ts">
  /**
   * The needs-you badge (nightshift item 753): beside the running badge on the tab strip (over every view),
   * shown while something waits on him or is ready for review; a click opens the Needs-you view.
   */
  import { untrack } from "svelte";
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { needsNow, refreshBoard } from "./needsBoard.svelte";
  import { badgeWords } from "./needsYou";
  import { home } from "./home.svelte";

  const rows = $derived(needsNow());
  // 763 H5's review: Home's Start cards wait on him too, so the badge counts them.
  // Item 995: the one number (`needCount`), as Home's line and the sidebar say it.
  const badge = $derived(badgeWords(rows, home.cards.length));
  const title = $derived(
    [
      "Needs you — what waits on you, what is ready for review, what is working, in every project",
      ...rows.filter((r) => r.state === "waiting" || r.state === "review").slice(0, 8).map((r) => `· ${r.tag} · ${r.title}`),
    ].join("\n"),
  );
  // The blockers and shipped items are files: read now, then every five minutes.
  $effect(() => {
    untrack(() => void refreshBoard());
    const t = setInterval(() => void refreshBoard(), 300_000);
    return () => clearInterval(t);
  });
  function toggle() {
    app.showRail = false;
    app.showContext = false;
    app.showTasks = false;
    app.showNeeds = !app.showNeeds;
  }
</script>

{#if badge || app.showNeeds}
  <button
    class="need-badge"
    class:waiting={badge?.waiting}
    class:open={app.showNeeds}
    aria-label={badge ? `${badge.n > 0 ? `${badge.n} ` : ""}${badge.word} — open the needs-you list` : "Needs you"}
    aria-expanded={app.showNeeds}
    use:tip={title}
    onclick={toggle}
  >
    <!-- Item 968: the number counts only what needs him; "to review" alone wears none. -->
    {#if badge}{#if badge.n > 0}<span class="n">{badge.n}</span>{/if}<span class="word">{badge.word}</span>{:else}<span class="word">needs you</span>{/if}
  </button>
{/if}

<style>
  .need-badge {
    position: sticky;
    right: 0;
    margin: 4px 6px 4px auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--paper);
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  /* Beside the running badge, which takes the strip's free space itself. */
  .need-badge + :global(.run-badge) {
    margin-left: 0 !important;
  }
  .need-badge.waiting {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .need-badge:hover,
  .need-badge.open {
    border-color: var(--accent-ink);
  }
  .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
</style>
