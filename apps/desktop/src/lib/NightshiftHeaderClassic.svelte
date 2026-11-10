<script lang="ts">
  /**
   * The Nightshift top bar: the project as the title with a one-line
   * eyebrow, the Start / Review switch alone at the right edge, and under
   * Review a second row of Morning · Runs · Blockers tabs with their counts
   * and the state chip. Three shapes, three levels — the mock-up's answer
   * to "a bunch of buttons in a row" (item 036, revision 2).
   */
  import { app } from "./state.svelte";
  import { sameMorning } from "./nightshift";
  import NightshiftStateChip from "./NightshiftStateChip.svelte";
  import NotificationCentre from "./NotificationCentre.svelte";

  const row = $derived(
    app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null,
  );
  const info = $derived(row?.nightshift ?? null);
  const review = $derived(app.nightshift.tab === "review");

  const openBlockers = $derived(
    app.nightshift.blockers
      ? app.nightshift.blockers.blockers.filter((b) => b.status === "open").length
      : (info?.open_blockers ?? 0),
  );
  const unread = $derived.by(() => {
    if (!row || !info?.newest_morning) return false;
    const read = app.nightshift.read[row.id] ?? [];
    return !read.some((n) => sameMorning(n, info.newest_morning));
  });
  const noteFileCount = $derived(app.nightshift.notes.filter((n) => !n.is_dir).length);

</script>

<header class="top" class:collapsed={app.layout.sidebarCollapsed}>
  <div class="title-block">
    <span class="title">{row?.name ?? "Nightshift"}</span>
    {#if info}
      <span class="eyebrow">
        {info.config.kind} project
        <span class="sep">·</span>
        {info.items} item{info.items === 1 ? "" : "s"}
        <span class="sep">·</span>
        {openBlockers} open blocker{openBlockers === 1 ? "" : "s"}
      </span>
    {:else if row}
      <span class="eyebrow">not a Nightshift project</span>
    {/if}
  </div>
  <span class="spacer"></span>
  <!-- The bell (nightshift backlog 069): the top bar is not drawn on this
       page, so the same component sits here. -->
  <NotificationCentre />
  <div class="seg" role="tablist" aria-label="Start or Review">
    <button
      role="tab"
      aria-selected={!review}
      class:on={!review}
      onclick={() => (app.nightshift.tab = "start")}>Start</button
    >
    <button
      role="tab"
      aria-selected={review}
      class:on={review}
      onclick={() => (app.nightshift.tab = "review")}>Review</button
    >
  </div>
</header>

{#if review && info}
  <div class="subbar">
    <button
      class="tab"
      class:on={app.nightshift.reviewTab === "morning"}
      onclick={() => (app.nightshift.reviewTab = "morning")}
    >
      Morning
      {#if unread}<span class="ns-pill open new">new</span>{/if}
    </button>
    <button
      class="tab"
      class:on={app.nightshift.reviewTab === "runs"}
      onclick={() => (app.nightshift.reviewTab = "runs")}
    >
      Runs
      {#if app.nightshift.shifts.length > 0}
        <span class="n">{app.nightshift.shifts.length}</span>
      {/if}
    </button>
    <button
      class="tab"
      class:on={app.nightshift.reviewTab === "blockers"}
      onclick={() => (app.nightshift.reviewTab = "blockers")}
    >
      Blockers
      {#if openBlockers > 0}<span class="n">{openBlockers} open</span>{/if}
    </button>
    <button
      class="tab"
      class:on={app.nightshift.reviewTab === "notes"}
      onclick={() => (app.nightshift.reviewTab = "notes")}
    >
      Notes
      {#if noteFileCount > 0}<span class="n">{noteFileCount}</span>{/if}
    </button>
    <span class="spacer"></span>
    <span class="state">
      <NightshiftStateChip />
    </span>
  </div>
{/if}

<style>
  .top {
    height: 82px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 0 32px 0 28px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
  }
  .top.collapsed {
    padding-left: 48px;
  }
  .title-block {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    min-width: 0;
  }
  .title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .eyebrow {
    font-family: var(--sans);
    font-size: 11px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--dim);
    margin-top: 6px;
    white-space: nowrap;
  }
  .sep {
    margin: 0 6px;
  }
  .spacer {
    flex: 1;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px;
    background: var(--well);
    flex: none;
  }
  .seg button {
    padding: 5px 16px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 13.5px;
    font-weight: 500;
    font-family: var(--sans);
    cursor: pointer;
  }
  .seg button:hover {
    color: var(--ink);
  }
  .seg button.on {
    background: var(--accent);
    color: var(--paper);
  }

  .subbar {
    height: 46px;
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 10px;
    padding: 0 32px 0 28px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
  }
  .tab {
    white-space: nowrap;
    padding: 9px 12px 8px;
    color: var(--dim);
    font-size: 13.5px;
    font-family: var(--sans);
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: transparent;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--ink);
  }
  .tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .n {
    font-family: var(--mono);
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--dim);
    background: var(--well);
    border-radius: 999px;
    padding: 0 6px;
  }
  .new {
    padding: 0 6px;
    font-size: 10px;
  }
  .state {
    padding-bottom: 8px;
    min-width: 0;
    display: flex;
  }
</style>
