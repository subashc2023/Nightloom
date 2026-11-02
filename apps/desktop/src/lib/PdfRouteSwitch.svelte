<script lang="ts">
  /**
   * A long PDF's route on its chip, before Send (item 491): "98 pages ·
   * read by path" or "· sent whole", and the switch between them. Drawn
   * only on the Claude Code engine for a PDF over 10 pages (`routeLabel`);
   * his choice is the chip's `whole`, kept in the drafts store with it.
   */
  import { routeLabel, type Engine } from "./attachKinds";
  import { updateAttachment } from "./drafts.svelte";
  import { tip } from "./tip";
  import type { Attachment } from "./types";

  let { chip, draftKey, engine }: { chip: Attachment; draftKey: string; engine: Engine } = $props();
  const r = $derived(chip.pending ? null : routeLabel(chip, engine));
</script>

{#if r}
  <span class="route" data-pdf-route={chip.whole ? "whole" : "path"} use:tip={r.title}>{r.text}</span>
  <button
    class="route-toggle"
    type="button"
    data-pdf-route-toggle
    use:tip={r.title}
    onclick={(e) => {
      e.stopPropagation();
      updateAttachment(draftKey, chip.id, { whole: !chip.whole });
    }}
    onkeydown={(e) => e.stopPropagation()}>{r.toggle}</button
  >
{/if}

<style>
  .route {
    font-size: 0.62rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .route-toggle {
    align-self: flex-start;
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.62rem;
    line-height: 1.3;
    cursor: pointer;
  }
  .route-toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
