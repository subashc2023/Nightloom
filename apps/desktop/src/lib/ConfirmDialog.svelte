<script lang="ts">
  /**
   * A small confirmation in the Disable dialog's shape: a title, a lead, a
   * few `k · v` facts, Cancel and one consequential button. Used by the
   * Backlog screen's Delete (to trash) and Discard edits — the two places
   * a click could lose work, which Swaraag's rule says must never happen
   * silently (2026-09-13).
   */
  import Icon from "./Icon.svelte";

  let {
    title,
    lead = "",
    facts = [],
    confirmLabel,
    busyLabel = "",
    busy = false,
    danger = true,
    onconfirm,
    onclose,
  }: {
    title: string;
    lead?: string;
    facts?: [string, string][];
    confirmLabel: string;
    busyLabel?: string;
    busy?: boolean;
    danger?: boolean;
    onconfirm: () => void;
    onclose: () => void;
  } = $props();

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
  <div class="ns-card dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1">
    <div class="head">
      <span class="warn" class:danger><Icon name="moon" size={20} /></span>
      <h2 id="confirm-title">{title}</h2>
    </div>
    {#if lead}<p class="lead">{lead}</p>{/if}
    {#if facts.length > 0}
      <div class="facts">
        {#each facts as [k, v] (k)}
          <span class="ns-k">{k}</span>
          <span>{v}</span>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button class="ns-btn" onclick={onclose} disabled={busy}>Cancel</button>
      <button class="ns-btn" class:danger class:accent={!danger} disabled={busy} onclick={onconfirm}>
        {busy && busyLabel ? busyLabel : confirmLabel}
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
    width: 520px;
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
    color: var(--accent-ink);
    display: inline-flex;
  }
  .warn.danger {
    color: var(--failed);
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
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
