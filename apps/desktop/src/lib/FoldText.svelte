<script lang="ts">
  /**
   * A waiting message's words, folded when long (nightshift item 548,
   * 2026-11-10): past `lines` lines it is cut with a fade and a "more" under
   * it opens the rest in place — "less" folds it again. It replaces the
   * hover tip that drew the whole text across the window ("a little pop-up
   * the entire thing just across the entire screen. That looks pretty
   * ugly", his words). Kept open per `foldKey` for this launch, so a
   * message he opened stays open as the transcript redraws.
   */
  import type { Snippet } from "svelte";
  import { foldOpen } from "./pendingBubble.svelte";

  let { lines = 6, foldKey = "", children }: { lines?: number; foldKey?: string; children: Snippet } = $props();

  let box = $state<HTMLElement | null>(null);
  let local = $state(false);
  const open = $derived(foldKey ? foldOpen[foldKey] === true : local);
  let over = $state(false);

  function toggle(): void {
    if (foldKey) {
      if (open) delete foldOpen[foldKey];
      else foldOpen[foldKey] = true;
    } else local = !local;
  }

  $effect(() => {
    const el = box;
    if (!el) return;
    const measure = () => {
      // Folded, the box is clipped at its max-height: taller content overflows.
      over = open ? el.scrollHeight > el.clientHeight + 1 || over : el.scrollHeight > el.clientHeight + 1;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  });
</script>

<div class="fold" class:open class:over data-fold={open ? "open" : over ? "folded" : "whole"}>
  <div class="fold-box" bind:this={box} style:--fold-lines={lines}>
    {@render children()}
  </div>
  {#if over || open}
    <button class="ns-link fold-more" type="button" aria-expanded={open} onclick={toggle}>{open ? "less" : "more"}</button>
  {/if}
</div>

<style>
  .fold {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    min-width: 0;
    max-width: 100%;
  }
  .fold-box {
    max-height: calc(var(--fold-lines) * 1.55em + 1.4em);
    overflow: hidden;
    max-width: 100%;
  }
  .fold.over:not(.open) .fold-box {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent);
  }
  .fold.open .fold-box {
    max-height: none;
  }
  .fold-more {
    font-size: 12px;
    color: var(--dim);
    margin-top: 2px;
  }
  .fold-more:hover,
  .fold-more:focus-visible {
    color: var(--ink);
  }
</style>
