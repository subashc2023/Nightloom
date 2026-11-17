<script lang="ts">
  /**
   * Item 775: the small Nightloom chip on his message that carried asides'
   * changes to the main chat — "carries N aside changes", a click opens the
   * list (each aside's question and the files it changed). The note itself
   * is in the message the model read (`asideNotes.ts`); here it is drawn
   * as this chip, never as his words. Its open state is kept under `keep`
   * when the bubble has one (every view keeps its state).
   */
  import { chipWords, type NoteRow } from "./asideNotes";
  import { keptGet, keptSet } from "./keptFolds.svelte";
  import { tip } from "./tip";

  let { rows, keep = null }: { rows: NoteRow[]; keep?: string | null } = $props();
  const files = $derived(rows.reduce((n, r) => n + r.changes.length, 0));
  let localOpen = $state(false);
  const open = $derived(keep === null ? localOpen : keptGet(`${keep}|asidenote`, false));
  function flip(): void {
    if (keep === null) localOpen = !localOpen;
    else keptSet(`${keep}|asidenote`, !open, false);
  }
</script>

<div class="aside-note" data-aside-note>
  <button
    class="aside-note-chip"
    aria-expanded={open}
    onclick={flip}
    use:tip={open ? "Fold the list away" : "Nightloom told the main chat what your asides changed — show the files"}
  >
    <span class="aside-note-mark mono">NL</span>{chipWords(files)}<span class="aside-note-caret">{open ? "▴" : "▾"}</span>
  </button>
  {#if open}
    <ul class="aside-note-list">
      {#each rows as r, i (i)}
        <li>
          <span class="aside-note-q">“{r.question}”</span>
          {#each r.changes as c, j (j)}<span class="aside-note-file mono">{c}</span>{/each}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .aside-note {
    margin-top: 0.45rem;
  }
  .aside-note-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.12rem 0.5rem 0.12rem 0.25rem;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--well);
    color: var(--dim);
    font: inherit;
    font-size: 0.72rem;
    line-height: 1.4;
    cursor: pointer;
  }
  .aside-note-chip:hover {
    color: var(--ink);
    border-color: var(--accent-soft);
  }
  .aside-note-mark {
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.62rem;
    letter-spacing: 0.04em;
  }
  .aside-note-caret {
    font-size: 0.6rem;
  }
  .aside-note-list {
    margin: 0.35rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--ink2);
  }
  .aside-note-list li + li {
    margin-top: 0.25rem;
  }
  .aside-note-q {
    display: block;
    color: var(--dim);
  }
  .aside-note-file {
    display: block;
    padding-left: 0.6rem;
    font-size: 0.7rem;
    overflow-wrap: anywhere;
  }
</style>
