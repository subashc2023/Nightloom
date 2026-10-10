<script lang="ts">
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { canKeep, keepLabel, keepTip, type KeepState } from "./keep";
  import { keepNow, keepStateOf } from "./keep.svelte";

  /**
   * "Keep in project" on one attachment chip (nightshift item 306): the
   * composer's and a sent message's. Absent in a chat with no project.
   * `state` overrides the store (a test, a snap); otherwise the window's
   * keep state for `keyStr`.
   */
  let {
    keyStr,
    name,
    mediaType,
    from,
    pending = false,
    state = null,
  }: {
    keyStr: string;
    name: string;
    mediaType: string;
    from: { data: string } | { path: string };
    /** An office file still converting: its PDF is not there yet. */
    pending?: boolean;
    state?: KeepState | null;
  } = $props();

  const s = $derived(state ?? keepStateOf(keyStr));
</script>

{#if canKeep(app.project)}
  <button
    class="keep"
    class:kept={s.phase === "kept"}
    class:keeping={s.phase === "keeping"}
    disabled={pending || s.phase !== "idle"}
    aria-label={s.phase === "kept" ? `${name} kept in this project` : `Keep ${name} in this project`}
    use:tip={keepTip(s, name, pending)}
    onclick={() => keepNow(keyStr, name, mediaType, from)}
    >{#if s.phase === "kept"}<span class="tick" aria-hidden="true">✓</span>{/if}{keepLabel(s)}</button
  >
{/if}

<style>
  .keep {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.1rem 0.4rem;
    border: 1px dashed var(--border);
    border-radius: 6px;
    background: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.68rem;
    line-height: 1.3;
    white-space: nowrap;
    cursor: pointer;
  }
  .keep:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--line2);
  }
  .keep:disabled {
    cursor: default;
  }
  /* Waiting on a conversion, or copying: not pressable yet. */
  .keep:disabled:not(.kept) {
    opacity: 0.55;
  }
  .keep.kept {
    border-style: solid;
    color: var(--accent, var(--ink));
  }
  .tick {
    font-size: 0.7rem;
  }
</style>
