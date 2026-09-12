<script lang="ts">
  /**
   * The Nightshift surface: the header, then Start or one of the three
   * Review screens. The project list with Enable lives in the sidebar's
   * Nightshift mode (`Sidebar.svelte`), where a list belongs; this is the
   * centre only.
   */
  import { app } from "./state.svelte";
  import NightshiftHeader from "./NightshiftHeader.svelte";
  import ReviewMorning from "./ReviewMorning.svelte";
  import ReviewRuns from "./ReviewRuns.svelte";
  import ReviewBlockers from "./ReviewBlockers.svelte";
  import ReviewNotes from "./ReviewNotes.svelte";

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
      {app.nightshift.rows.length === 0
        ? "No projects yet — open a folder as a project first."
        : "Select a project in the sidebar, or enable Nightshift on one."}
    </p>
  {:else if !selectedRow.nightshift}
    <p class="hint">{selectedRow.name} does not have Nightshift enabled.</p>
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
      <p class="hint">Backlog, plan and launch come in the next phase.</p>
      <p class="hint dim">
        {selectedRow.nightshift.items} items in the backlog · latest shift
        {selectedRow.nightshift.latest_shift ?? "none"}
      </p>
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
  .hint.dim {
    padding-top: 0;
    font-size: 12.5px;
  }
  .start {
    display: flex;
    flex-direction: column;
  }
</style>
