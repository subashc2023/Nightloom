<script lang="ts">
  /**
   * "No output for 15 min" and Restart on a silent helper (nightshift item
   * 752, blocker 2345; the rules in `silentHelper.ts`). Drawn on the
   * Running-tasks row and on the Agent call's row in the transcript (both
   * layouts); nothing at all while the helper talks, has ended, or comes
   * from the log.
   *
   * Restart asks first, in place: "Stop it and launch it again?". If it
   * finishes or speaks while he reads that, the question goes with the
   * notice — nothing is stopped. The confirm checks again at the click.
   * Never pressed on its own.
   */
  import { tip } from "./tip";
  import * as api from "./api";
  import { addToast, agentCallPrompt, turnKeyOf, type SubagentRow } from "./state.svelte";
  import { restartNote, silentFor, silentLabel } from "./silentHelper";

  let { row }: { row: SubagentRow } = $props();

  let now = $state(Date.now());
  $effect(() => {
    if (row.status !== "running") return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
  });

  const quiet = $derived(silentFor(row, now));
  let asking = $state(false);
  let busy = $state(false);
  // It spoke or ended while the question was up: the question goes too.
  $effect(() => {
    if (quiet === null && asking) asking = false;
  });

  async function restart(): Promise<void> {
    if (busy) return;
    const q = silentFor(row, Date.now());
    asking = false;
    if (q === null) return; // finished or spoke during the confirm: nothing to restart
    const turn = turnKeyOf(row.session);
    if (!turn || !row.task_id) {
      addToast(`Couldn't restart “${row.description || "the helper"}”: its turn has ended`);
      return;
    }
    busy = true;
    try {
      const note = restartNote(row, agentCallPrompt(row.tool_use_id), q);
      const ok = await api.restartSubagent(turn, row.task_id, row.session, note);
      if (ok) row.restarting = true;
      else addToast(`“${row.description || "The helper"}” had already ended — nothing restarted`);
    } catch (e) {
      addToast(`Couldn't restart: ${String(e)}`);
    } finally {
      busy = false;
    }
  }
</script>

{#if row.restarting && row.status === "running"}
  <span class="silent restarting" role="status" data-testid="silent-helper">Restarting…</span>
{:else if quiet !== null}
  <span class="silent" role="status" data-testid="silent-helper">
    <span class="words" use:tip={"Nothing from this helper — no tool call, no message — for this long. It may be stuck, or in one long step"}
      >{silentLabel(quiet)}</span
    >
    {#if asking}
      <span class="ask">
        <span class="q">Stop it and launch it again?</span>
        <button
          class="ns-btn outline small go"
          disabled={busy}
          use:tip={"Stop this helper and have the main agent launch it again with the same prompt"}
          onclick={() => void restart()}>Restart</button
        >
        <button class="ns-btn ghost small" onclick={() => (asking = false)}>Cancel</button>
      </span>
    {:else}
      <button
        class="ns-btn ghost small go"
        use:tip={"Restart: stop it and launch it again from the same prompt — asks first"}
        onclick={() => (asking = true)}>Restart</button
      >
    {/if}
  </span>
{/if}

<style>
  .silent {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--partial, var(--ink2));
    white-space: nowrap;
  }
  .restarting {
    color: var(--dim);
  }
  .ask {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    animation: silent-in 160ms ease-out;
  }
  .q {
    color: var(--ink);
  }
  /* Press highlight in both layouts (the theme gives Jarvis its own). */
  :global([data-layout="classic"]) .silent .ns-btn:active:not(:disabled) {
    filter: brightness(0.9);
    transform: translateY(0.5px);
  }
  @keyframes silent-in {
    from {
      opacity: 0;
      transform: translateX(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ask {
      animation: none;
    }
  }
</style>
