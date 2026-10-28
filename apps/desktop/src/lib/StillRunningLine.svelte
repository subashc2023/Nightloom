<script lang="ts">
  import { tip } from "./tip";
  import * as api from "./api";
  import { app } from "./state.svelte";
  import { lineView, type StillRunningSegment } from "./stillRunning";
  import { openTasksOn } from "./tasksFocus.svelte";

  /**
   * The still-running line (nightshift backlog 357, his "if you can click
   * on that one sub-agent thing and that opens up that like agent menu that
   * we've built, that would be ideal"): a status line in the reply, not a
   * question. Each name opens the Running-tasks panel on its row; Stop asks
   * the turn's subagents to stop (329's `stop_subagents`); the line reads
   * the subagent rows live, so it turns to done or stopped as they end.
   */
  let { seg }: { seg: StillRunningSegment } = $props();

  let stopping = $state(false);
  const view = $derived(lineView({ ...seg, stopped: seg.stopped || stopping }, app.subagents));

  async function stop(): Promise<void> {
    if (!seg.turn || stopping) return;
    // Kept here, not on the segment (a prop): the rows' own status turns
    // the line once the CLI reports the stop.
    stopping = true;
    try {
      await api.stopSubagents(seg.turn);
    } catch {
      // The turn had already ended: its subagents with it.
    }
  }
</script>

<div class="still {view.state}" role="status">
  <span class="dot" aria-hidden="true"></span>
  <span class="words">
    <span class="head">{view.head}</span>
    {view.count} ({#each view.names as n, i (i)}{#if i > 0}{", "}{/if}<button
        class="name {n.state}"
        use:tip={`${n.label} — ${n.state === "running" ? "running" : n.state}; open it in the Running-tasks panel`}
        onclick={() => openTasksOn(n.id)}>{n.label}</button
      >{/each}){#if view.tail}&nbsp;{view.tail}{/if}
  </span>
  {#if view.state === "running" && seg.turn}
    <button
      class="ns-btn ghost small stop"
      use:tip={view.names.length === 1 ? "Stop this subagent; the reply ends without its report" : "Stop these subagents; the reply ends without their reports"}
      onclick={() => void stop()}>Stop</button
    >
  {/if}
</div>

<style>
  .still {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--dim);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    transform: translateY(-1px);
  }
  .still.running .dot {
    background: var(--accent);
    animation: still-pulse 1.4s ease-in-out infinite;
  }
  .still.done .dot {
    background: var(--ok, #6c6);
  }
  @keyframes still-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .still.running .dot {
      animation: none;
    }
  }
  .words {
    flex: 1;
    min-width: 0;
  }
  .head {
    color: var(--ink2, var(--ink));
    font-weight: 600;
  }
  .name {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--ink) 35%, transparent);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .name:hover {
    text-decoration-color: var(--accent);
  }
  .name.stopped,
  .name.failed {
    color: var(--dim);
  }
  .stop {
    flex: none;
    align-self: center;
  }
</style>
