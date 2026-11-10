<script lang="ts">
  // One control of a grouped Settings pane (nightshift backlog 546): its
  // label and control on one line, a "?" that unfolds the long
  // explanation under it (folded by default, remembered), and hidden while
  // the pane's filter does not match it.
  import type { Snippet } from "svelte";
  import { tip } from "../tip";
  import { isOpen, setOpen } from "./paneState.svelte";

  let {
    fold,
    shown = true,
    label,
    stack = false,
    control,
    help,
    children,
  }: {
    /** The key the "?" fold is remembered by. */
    fold: string;
    shown?: boolean;
    label?: Snippet;
    /** The control goes under the label (a text box), not beside it. */
    stack?: boolean;
    control?: Snippet;
    help?: Snippet;
    children?: Snippet;
  } = $props();

  const helpKey = $derived(`${fold}?`);
  const helpOpen = $derived(isOpen(helpKey));
</script>

{#if shown}
  <div class="row" class:stack>
    <div class="head">
      {#if label}<div class="lab">{@render label()}</div>{/if}
      {#if help}
        <button
          class="q"
          class:on={helpOpen}
          aria-expanded={helpOpen}
          aria-label={helpOpen ? "Hide the explanation" : "Explain this setting"}
          use:tip={helpOpen ? "Hide the explanation" : "Explain this setting"}
          onclick={() => setOpen(helpKey, !helpOpen)}>?</button
        >
      {/if}
      {#if control && !stack}<div class="ctl">{@render control()}</div>{/if}
    </div>
    {#if control && stack}<div class="ctl-stack">{@render control()}</div>{/if}
    {#if children}{@render children()}{/if}
    {#if help && helpOpen}<div class="help">{@render help()}</div>{/if}
  </div>
{/if}

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }
  .row:last-child {
    border-bottom: none;
    padding-bottom: 2px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    flex-wrap: wrap;
  }
  .lab {
    font-size: 13px;
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .q {
    all: unset;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    color: var(--dim);
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
    flex: none;
  }
  .q:hover,
  .q.on {
    color: var(--ink);
    border-color: var(--dim);
  }
  .q.on {
    background: var(--well);
  }
  .q:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .ctl {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .ctl-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .help {
    color: var(--dim);
    font-size: 12px;
    line-height: 1.5;
    padding: 8px 10px;
    border-left: 2px solid var(--line2);
    background: color-mix(in srgb, var(--well) 30%, transparent);
    border-radius: 0 var(--r1, 5px) var(--r1, 5px) 0;
  }
  .help :global(code) {
    font-family: var(--mono);
    font-size: 0.92em;
  }
</style>
