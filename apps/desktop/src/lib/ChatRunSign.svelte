<script lang="ts">
  /**
   * The open chat's own running sign (item 556, 2026-11-10). His words:
   * "there's the … X running thing in the corner of the screen, but that
   * doesn't say anything about whether the current chat is running." At the
   * top bar's left, shown only while this chat's turn runs: `Running · 1:23`
   * (and `· 2 agents` while its subagents run), or `Waiting on you` when a
   * prompt of its own waits. Nothing when it is idle — the same rule as its
   * tab's dot and its sidebar row, so a missing sign means "not running".
   * A click opens the Running-tasks panel, his project at its top.
   *
   * One component in both layouts (the Classic-twin rule, item 542): both
   * top bars mount it; Classic draws it flat, in its own tokens.
   */
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { allRunning } from "./running.svelte";
  import { chatRun } from "./runGroups";
  import { liveClock } from "./chatList";

  let now = $state(Date.now());
  const run = $derived(chatRun(allRunning(now), app.activeSessionId));
  $effect(() => {
    if (run.state === "idle") return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const clock = $derived(run.startedAt !== null ? liveClock(Math.max(0, now - run.startedAt)) : "");
  const title = $derived(
    run.state === "waiting"
      ? "This chat's turn waits on you: a prompt below needs your answer — click for every running task"
      : `This chat's turn is running${run.doing ? ` (${run.doing})` : ""}${run.agents > 0 ? `, with ${run.agents} subagent${run.agents === 1 ? "" : "s"}` : ""} — click for every running task`,
  );
  function open() {
    app.showRail = false;
    app.showContext = false;
    app.showTasks = !app.showTasks;
  }
</script>

{#if run.state !== "idle"}
  <button
    class="run-sign"
    class:waiting={run.state === "waiting"}
    data-run-sign={run.state}
    aria-label={run.state === "waiting" ? "This chat waits on you" : "This chat is running"}
    use:tip={title}
    onclick={open}
  >
    <span class="pulse" aria-hidden="true"></span>
    <span class="word">{run.state === "waiting" ? "Waiting on you" : "Running"}</span>
    {#if clock && run.state === "running"}<span class="num">{clock}</span>{/if}
    {#if run.agents > 0}<span class="num agents">· {run.agents} agent{run.agents === 1 ? "" : "s"}</span>{/if}
  </button>
{/if}

<style>
  /* Filament IV: a lit pill in the signal blue, its dot glowing like the
     tab's running dot (`--glow-live`); waiting in the accent. */
  .run-sign {
    flex-shrink: 0;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 9px 0 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--live) 45%, transparent);
    background: var(--live-soft);
    color: var(--live);
    font: 500 11.5px/1 var(--sans);
    white-space: nowrap;
    cursor: pointer;
  }
  .run-sign:hover {
    border-color: var(--live);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: var(--glow-live);
    animation: run-sign-pulse 1.6s ease-in-out infinite;
  }
  .num {
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .agents {
    opacity: 0.85;
  }
  .run-sign.waiting {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .run-sign.waiting .pulse {
    background: var(--accent);
    box-shadow: none;
  }
  @keyframes run-sign-pulse {
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
  /* Classic (item 542): flat, no glow, the squarer chip of 1d4ca17. */
  :global([data-layout="classic"]) .run-sign {
    border-radius: 5px;
    height: 20px;
  }
  :global([data-layout="classic"]) .pulse {
    box-shadow: none;
  }
</style>
