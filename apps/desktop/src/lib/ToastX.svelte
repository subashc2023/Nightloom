<script lang="ts">
  /**
   * A toast's X (backlog 410: dismiss any toast at once), as `App.svelte` draws it on every toast — its own
   * component so a test can click the real one (993e re-review, T1). On a mail's hold (`xUndoes`, blocker 2355)
   * the X is the Undo: closing the toast must not leave a mail going with no Undo on screen.
   */
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import { dismissToast, runToastAction } from "./state/toasts.svelte";

  let { t }: { t: { id: number; action?: { label: string; run: () => void }; xUndoes?: boolean } } = $props();
  const undoWords = $derived(`${t.action?.label ?? "Undo"}: nothing is sent`);
</script>

<button class="toast-x" aria-label={t.xUndoes ? undoWords : "Dismiss"} use:tip={t.xUndoes ? undoWords : undefined} onclick={() => (t.xUndoes ? runToastAction(t.id) : dismissToast(t.id))}>
  <Icon name="x" size={12} />
</button>

<style>
  /* The X (backlog 410): the dim text's colour, the ink on hover. */
  .toast-x {
    flex: none;
    background: none;
    border: none;
    padding: 2px;
    margin: -1px -4px 0 0;
    color: var(--dim);
    cursor: pointer;
    display: flex;
    border-radius: 4px;
  }
  .toast-x:hover,
  .toast-x:focus-visible {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    outline: none;
  }
</style>
