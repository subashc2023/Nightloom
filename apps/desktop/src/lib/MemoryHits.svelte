<script lang="ts">
  /**
   * "Where it lives in memory" under a reply (nightshift backlog 296): every
   * hit the turn's `memory_where` calls found, grouped by layer and marked
   * loaded into every chat or read on demand. A row's place opens the note
   * editor at that line; *Strike* supersedes the line with today's date —
   * the text stays, struck — and the row shows the struck line after.
   */
  import { tip } from "./tip";
  import { shortPath, type MemoryGroup, type MemoryHit } from "./memoryHits";
  import { openMemoryHit, strikeMemoryHit } from "./memoryOpen";

  let { groups }: { groups: MemoryGroup[] } = $props();

  /** Lines struck from here this session: `path:line` → the new line. */
  let struck = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);

  const key = (h: MemoryHit) => `${h.path}:${h.line}`;
  const count = $derived(groups.reduce((n, g) => n + g.hits.length, 0));

  async function strike(h: MemoryHit) {
    busy = key(h);
    const line = await strikeMemoryHit(h);
    busy = null;
    if (line != null) struck = { ...struck, [key(h)]: line };
  }
</script>

<section class="mem" aria-label="Where it lives in memory">
  <div class="mem-head">
    Where it lives in memory · {count} place{count === 1 ? "" : "s"}
  </div>
  {#each groups as g (`${g.layer}|${g.loading}|${g.note}`)}
    <div class="mem-group">
      <div class="mem-layer">
        <span class="layer">{g.layer}</span>
        <span class="loading" class:every={g.loading === "every"}
          >{g.loading === "every" ? "loaded into every chat" : "read on demand"}{g.note ? ` · ${g.note}` : ""}</span
        >
      </div>
      {#each g.hits as h (key(h))}
        {@const done = struck[key(h)]}
        <div class="mem-row" class:done={!!done}>
          <button
            class="place"
            use:tip={`${h.path}:${h.line} — open at this line`}
            onclick={() => void openMemoryHit(h)}>{shortPath(h.path)}:{h.line}</button
          >
          <span class="text" use:tip={done ? `Now reads: ${done}` : h.text}>{h.text}</span>
          <button
            class="ns-btn ghost small strike"
            disabled={!!done || busy === key(h)}
            use:tip={done
              ? "Struck — open the file to edit or undo it"
              : "Strike this line: it stays in the file, crossed out with today's date, and stops reading as a current belief"}
            onclick={() => void strike(h)}>{done ? "Struck" : "Strike"}</button
          >
        </div>
      {/each}
    </div>
  {/each}
</section>

<style>
  .mem {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(100%, 680px);
    padding: 10px 12px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--sheet);
    color: var(--ink);
    font-size: 13px;
  }
  .mem-head {
    font-size: 12px;
    color: var(--dim);
  }
  .mem-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mem-layer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .layer {
    font-weight: 600;
  }
  .loading {
    font-size: 11.5px;
    color: var(--dim);
  }
  .loading.every {
    color: var(--accent-ink);
  }
  .mem-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    min-width: 0;
  }
  .place {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
    justify-self: start;
    text-align: left;
  }
  .place:hover {
    color: var(--accent-ink);
  }
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }
  .mem-row.done .text {
    text-decoration: line-through;
    color: var(--dim);
  }
  .strike {
    flex: none;
  }
  @media (max-width: 520px) {
    .mem-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .text {
      grid-column: 1 / -1;
      grid-row: 2;
      white-space: normal;
    }
  }
</style>
