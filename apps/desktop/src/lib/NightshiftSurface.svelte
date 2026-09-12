<script lang="ts">
  /**
   * The Nightshift surface: the header, then Start or one of the three
   * Review screens. The project list with Enable lives in the sidebar's
   * Nightshift mode (`Sidebar.svelte`), where a list belongs; this is the
   * centre only.
   */
  import { app, latestShift } from "./state.svelte";
  import NightshiftHeader from "./NightshiftHeader.svelte";
  import ReviewMorning from "./ReviewMorning.svelte";
  import ReviewRuns from "./ReviewRuns.svelte";
  import ReviewBlockers from "./ReviewBlockers.svelte";
  import ReviewNotes from "./ReviewNotes.svelte";
  import StartBacklog from "./StartBacklog.svelte";
  import StartPlan from "./StartPlan.svelte";
  import Icon from "./Icon.svelte";

  const selectedRow = $derived(
    app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null,
  );

  // Duplicated from NightshiftHeader's `state` derivation rather than
  // imported — the header stays as it is (screen 3.2-3.5's contract); this
  // is the same idle/live chip for the Start tab bar's own second row.
  // Keep it identical if you flip one; a `NightshiftStateChip` component is
  // the alternative if they diverge.
  const info = $derived(selectedRow?.nightshift ?? null);
  const latest = $derived(latestShift());
  const startState = $derived.by(() => {
    if (info?.live) {
      const id = latest?.live ? latest.id : (info.latest_shift ?? "");
      return { dot: "live", text: id ? `live · shift ${id}` : "live" };
    }
    if (!latest) {
      return {
        dot: "unknown",
        text: info?.latest_shift ? `idle · last shift ${info.latest_shift}` : "idle · no shifts yet",
      };
    }
    const exit = latest.status?.exit;
    const dot = latest.interrupted ? "failed" : exit != null && exit !== 0 ? "failed" : exit === 0 ? "" : "unknown";
    const tail = latest.interrupted
      ? " · interrupted"
      : exit != null
        ? ` · exit ${exit}`
        : "";
    return { dot, text: `idle · last shift ${latest.id}${tail}` };
  });
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
          <span class="ns-chip">
            <Icon name="moon" />
            <span class="dot {startState.dot}"></span>
            {startState.text}
          </span>
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
  .hint.dim {
    padding-top: 0;
    font-size: 12.5px;
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
  .state .ns-chip {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
