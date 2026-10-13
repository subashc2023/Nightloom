<script lang="ts">
  /**
   * The Nightshift surface: the header, then Start or one of the three
   * Review screens, for the open project (round 2, point 12: one project
   * open at a time). The Enable card lives in the sidebar's Nightshift mode
   * (`Sidebar.svelte`); this is the centre only.
   */
  import { app } from "./state.svelte";
  import NightshiftHeader from "./NightshiftHeader.svelte";
  import ReviewMorning from "./ReviewMorning.svelte";
  import ReviewRuns from "./ReviewRuns.svelte";
  import ReviewBlockers from "./ReviewBlockers.svelte";
  import ReviewNotes from "./ReviewNotes.svelte";
  import StartBacklog from "./StartBacklog.svelte";
  import StartPlan from "./StartPlan.svelte";
  import NightshiftStateChip from "./NightshiftStateChip.svelte";

  const selectedRow = $derived(
    app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null,
  );

</script>

<div class="nightshift">
  <NightshiftHeader />
  {#if app.nightshift.loading && app.nightshift.rows.length === 0}
    <p class="hint">Reading projects…</p>
  {:else if app.nightshift.error}
    <p class="hint err">{app.nightshift.error}</p>
  {:else if !selectedRow}
    <p class="hint">
      {app.project
        ? `${app.project.name} is not in the project list yet.`
        : "Open a project to use Nightshift — the page shows the project in the top-left chip. New project… and Open project… are in that menu."}
    </p>
  {:else if !selectedRow.nightshift}
    <p class="hint">{selectedRow.name} does not have Nightshift enabled — the sidebar's Nightshift mode has the Enable card.</p>
  {:else if app.nightshift.tab === "review"}
    {#if app.nightshift.reviewTab === "morning"}
      <ReviewMorning />
    {:else if app.nightshift.reviewTab === "runs"}
      <ReviewRuns />
    {:else if app.nightshift.reviewTab === "notes"}
      <ReviewNotes />
    {:else}
      <ReviewBlockers />
    {/if}
  {:else}
    <div class="start">
      <div class="subbar">
        <button
          class="tab"
          class:on={app.nightshift.startTab === "backlog"}
          onclick={() => (app.nightshift.startTab = "backlog")}
        >
          Backlog
        </button>
        <button
          class="tab"
          class:on={app.nightshift.startTab === "plan"}
          onclick={() => (app.nightshift.startTab = "plan")}
        >
          Plan a shift
        </button>
        <span class="spacer"></span>
        <span class="state">
          <NightshiftStateChip />
        </span>
      </div>
      {#if app.nightshift.startTab === "backlog"}
        <StartBacklog />
      {:else}
        <StartPlan />
      {/if}
    </div>
  {/if}
</div>

<style>
  .nightshift {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
    position: relative;
  }
  .hint {
    margin: 0;
    padding: 26px 32px;
    font-size: 13.5px;
    color: var(--dim);
    line-height: 1.5;
  }
  .hint.err {
    color: var(--failed);
  }
  .start {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
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
    cursor: pointer;
  }
  .tab:hover {
    color: var(--ink);
  }
  .tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .state {
    padding-bottom: 8px;
    min-width: 0;
    display: flex;
  }
</style>
