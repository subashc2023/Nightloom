<script lang="ts">
  import { tip } from "./tip";
  /**
   * The Claude Code update's buttons (nightshift backlog 182), the same in
   * the bell's notice and in Settings → Subscription: **Update when cold**
   * (the default — `claude update` once no turn runs and every open chat's
   * cache has expired), **Now…** (shows what the warm chats would rewrite
   * first, then runs), the waiting line with its Cancel, and the last
   * result. The rules are `cliUpdate.ts`'s; the state `cliUpdate.svelte.ts`'s.
   */
  import { cancelWait, cli, readCold, updateNow, updateWhenCold } from "./cliUpdate.svelte";
  import { costLine, offersUpdate, resultLine, waitLine } from "./cliUpdate";

  /** "Now…" was pressed: the cost is on screen, awaiting the second press. */
  let confirming = $state(false);
  let reading = $state(false);

  async function askNow() {
    reading = true;
    try {
      await readCold();
      confirming = true;
    } finally {
      reading = false;
    }
  }

  function goNow() {
    confirming = false;
    void updateNow();
  }
</script>

<div class="cli-upd">
  {#if cli.updating}
    <div class="cli-line">Updating Claude Code… <span class="dim">claude update is downloading and installing the release.</span></div>
  {:else if offersUpdate(cli.status)}
    {#if confirming && cli.reading}
      <div class="cli-cost">{costLine(cli.reading)}</div>
      {#if cli.reading.running.length}
        <div class="cli-line dim">{waitLine(cli.reading)} Nothing is updated while it runs, now or later.</div>
      {/if}
      <div class="cli-actions">
        <button class="ns-btn small" disabled={cli.reading.running.length > 0} onclick={goNow}>Update now</button>
        <button class="ns-btn ghost small" onclick={() => (confirming = false)}>Back</button>
      </div>
    {:else}
      {#if cli.waiting && cli.reading}
        <div class="cli-line">{waitLine(cli.reading)}</div>
      {/if}
      <div class="cli-actions">
        {#if cli.waiting}
          <button class="ns-btn ghost small" onclick={cancelWait}>Cancel the wait</button>
        {:else}
          <button
            class="ns-btn small"
            use:tip={"Runs claude update once no turn is running and every open chat's cache has expired — then no chat pays anything extra"}
            onclick={() => void updateWhenCold()}>Update when cold</button
          >
        {/if}
        <button
          class="ns-btn ghost small"
          disabled={reading}
          use:tip={"Shows first what updating now costs the chats whose cache is still warm"}
          onclick={() => void askNow()}>{reading ? "…" : "Now…"}</button
        >
      </div>
    {/if}
  {/if}
  {#if cli.result && !cli.updating}
    <div class="cli-line" class:bad={!cli.result.ok}>{resultLine(cli.result)}</div>
  {/if}
</div>

<style>
  .cli-upd {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .cli-line,
  .cli-cost {
    font-size: 12px;
    color: var(--ink2);
    overflow-wrap: anywhere;
  }
  .cli-cost {
    color: var(--ink);
    background: var(--well);
    border-radius: 6px;
    padding: 6px 8px;
  }
  .cli-line.bad {
    color: var(--failed, #c66);
  }
  .dim {
    color: var(--dim);
  }
  .cli-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
