<script lang="ts">
  // Item 795: Quick Entry's shortcut in Settings — press Record, then the
  // keys; Turn off clears it. Off until he picks one (no default could be
  // known free of his other apps' shortcuts).
  import { recordShortcut, shortcutLabel } from "./quickEntry";
  import { quickEntry, setQuickShortcut } from "./quickEntry.svelte";

  let recording = $state(false);
  let hint = $state<string | null>(null);

  function onKey(e: KeyboardEvent): void {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      recording = false;
      hint = null;
      return;
    }
    const s = recordShortcut(e);
    if (!s) {
      hint = "hold ⌘, ⌃ or ⌥ with a letter, a digit, Space or F1–F12";
      return;
    }
    recording = false;
    hint = null;
    void setQuickShortcut(s);
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="qe-row">
  <span class="qe-key" class:off={!quickEntry.shortcut}>{recording ? "Press the keys…" : shortcutLabel(quickEntry.shortcut)}</span>
  <button class="ns-btn" onclick={() => ((recording = !recording), (hint = null))}>
    {recording ? "Cancel" : quickEntry.shortcut ? "Change" : "Record"}
  </button>
  {#if quickEntry.shortcut && !recording}
    <button class="ns-btn" onclick={() => void setQuickShortcut(null)}>Turn off</button>
  {/if}
</div>
{#if hint}<p class="qe-note">{hint}</p>{/if}
{#if quickEntry.error}<p class="qe-note qe-err">{quickEntry.error}</p>{/if}

<style>
  .qe-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .qe-key {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    min-width: 7em;
    padding: 3px 8px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 6px;
  }
  .qe-key.off {
    opacity: 0.6;
  }
  .qe-note {
    margin: 6px 0 0;
    font-size: 12px;
    opacity: 0.8;
  }
  .qe-err {
    color: var(--danger, #e0755f);
  }
</style>
