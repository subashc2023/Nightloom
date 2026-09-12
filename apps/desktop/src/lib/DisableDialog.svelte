<script lang="ts">
  /**
   * Disable Nightshift, behind a warning (item 037). Names the folder and
   * says what stops and what stays; the button is locked until the box is
   * ticked. Nothing is deleted: `nightshift.json` is renamed to
   * `nightshift.json.disabled`, and Enable on the same project renames it
   * back.
   */
  import type { NightshiftRow } from "./types";
  import Icon from "./Icon.svelte";

  let {
    row,
    busy = false,
    onconfirm,
    onclose,
  }: {
    row: NightshiftRow;
    busy?: boolean;
    onconfirm: () => void;
    onclose: () => void;
  } = $props();

  let agreed = $state(false);
  const root = $derived(row.nightshift?.contract_root ?? row.workspace ?? "");
  const live = $derived(!!row.nightshift?.live);

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={key} />

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="ns-card dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="disable-title"
    tabindex="-1"
  >
    <div class="head">
      <span class="warn"><Icon name="moon" size={20} /></span>
      <h2 id="disable-title">Disable Nightshift on {row.name}?</h2>
    </div>
    <p class="lead">
      The contract root <span class="ns-mono">{root}</span> stops being a
      Nightshift project. Nothing is deleted.
    </p>
    <div class="facts">
      <span class="ns-k">stops</span>
      <span>
        The project leaves this list; no shift can be planned or launched on
        it; its schedules do not fire; live updates and the morning page
        stop showing here.
      </span>
      <span class="ns-k">stays</span>
      <span>
        Every file — backlog, blockers, notes, shifts, morning pages, the git
        history — exactly where it is.
      </span>
      <span class="ns-k">how</span>
      <span>
        <span class="ns-mono">nightshift.json</span> is renamed to
        <span class="ns-mono">nightshift.json.disabled</span>. Enable on this
        project later renames it back, keeping its settings.
      </span>
      <span class="ns-k">shift</span>
      {#if live}
        <span class="ns-pill live self"><span class="dot"></span>a shift is running — disabling is refused until it ends</span>
      {:else}
        <span class="ns-pill grey self"><span class="dot"></span>none running</span>
      {/if}
    </div>
    <label class="agree">
      <input type="checkbox" bind:checked={agreed} disabled={live || busy} />
      I understand what stops, and that the files stay.
    </label>
    <div class="actions">
      <button class="ns-btn" onclick={onclose} disabled={busy}>Cancel</button>
      <button class="ns-btn danger" disabled={!agreed || live || busy} onclick={onconfirm}>
        {busy ? "Disabling…" : "Disable Nightshift"}
      </button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 40;
  }
  .dialog {
    width: 540px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border-color: var(--line2);
    font-family: var(--sans);
    font-size: 14px;
    color: var(--ink);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .warn {
    color: var(--failed);
    display: inline-flex;
  }
  h2 {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    margin: 0;
  }
  .lead {
    margin: 0;
    color: var(--ink2);
    overflow-wrap: anywhere;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 16px;
    font-size: 13px;
    align-items: start;
    line-height: 1.45;
  }
  .facts .ns-k {
    padding-top: 2px;
  }
  .self {
    justify-self: start;
  }
  .agree {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .agree input {
    accent-color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
