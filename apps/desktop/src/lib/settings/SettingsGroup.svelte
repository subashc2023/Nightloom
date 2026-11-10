<script lang="ts">
  // One folded group of a Settings pane (nightshift backlog 546): a header
  // that says what the group is set to, folded until he opens it. While
  // the pane's filter has words, a group with a match is shown open and a
  // group with none is hidden; clearing the filter restores his folds.
  import type { Snippet } from "svelte";
  import Icon from "../Icon.svelte";
  import { isOpen, setOpen } from "./paneState.svelte";

  let {
    fold,
    title,
    summary,
    filtering = false,
    matches = 1,
    children,
  }: {
    /** The key his fold is remembered by, e.g. "subscription/handoff". */
    fold: string;
    title: string;
    summary: string;
    filtering?: boolean;
    matches?: number;
    children: Snippet;
  } = $props();

  const open = $derived(filtering ? matches > 0 : isOpen(fold));
  const id = $derived(`grp-${fold.replace(/[^a-z0-9]+/gi, "-")}`);
</script>

{#if !filtering || matches > 0}
  <section class="grp" class:open>
    <button
      class="gh"
      aria-expanded={open}
      aria-controls={id}
      disabled={filtering}
      onclick={() => setOpen(fold, !open)}
    >
      <span class="chev" aria-hidden="true"><Icon name="chevr" size={12} /></span>
      <span class="gt">{title}</span>
      <span class="gs">{filtering ? `${matches} match${matches === 1 ? "" : "es"}` : summary}</span>
    </button>
    {#if open}
      <div class="gb" {id}>
        {@render children()}
      </div>
    {/if}
  </section>
{/if}

<style>
  .grp {
    border: 1px solid var(--line);
    border-radius: var(--r2, 8px);
    background: var(--raised);
    flex: none;
  }
  .grp.open {
    border-color: var(--line2);
  }
  .gh {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 10px;
    row-gap: 4px;
    padding: 12px 14px;
    cursor: pointer;
    border-radius: var(--r2, 8px);
  }
  .gh:disabled {
    cursor: default;
  }
  .gh:hover:not(:disabled) {
    background: color-mix(in srgb, var(--well) 45%, transparent);
  }
  .gh:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .chev {
    display: inline-flex;
    flex: none;
    width: 14px;
    color: var(--dim);
    transition: transform 0.12s ease;
    align-self: center;
  }
  .open .chev {
    transform: rotate(90deg);
  }
  .gt {
    font-size: 14px;
    font-weight: 500;
    color: var(--ink);
  }
  .gs {
    font-family: var(--mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
    text-align: right;
    margin-left: auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .gb {
    border-top: 1px solid var(--line);
    padding: 4px 14px 12px;
    display: flex;
    flex-direction: column;
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>
