<script lang="ts">
  /**
   * The council's recorded blocks under the chair's reply (nightshift
   * backlog 149): a seat's answer folded under its map line — the letter
   * the chair saw it as, the model it was, forked or cold, searches,
   * tokens, the angle or area it took — and the record as the sources
   * table with the overlap figures and the areas for next time. The
   * markers are `council.rs`'s; `council.ts` reads them.
   */
  import { renderMarkdown } from "./markdown";
  import { pct, type CouncilRecord, type CouncilSeatBlock } from "./council";
  import { fmtTokens } from "./tokens";

  let {
    seat = null,
    record = null,
  }: {
    seat?: CouncilSeatBlock | null;
    record?: CouncilRecord | null;
  } = $props();

  /** Every source any seat cited, with the letters that cited it. */
  const sources = $derived.by(() => {
    if (!record) return [] as { source: string; by: string[] }[];
    const by = new Map<string, string[]>();
    for (const s of record.seats) for (const c of s.cited) by.set(c, [...(by.get(c) ?? []), s.label]);
    return [...by.entries()]
      .map(([source, labels]) => ({ source, by: labels }))
      .sort((a, b) => b.by.length - a.by.length || a.source.localeCompare(b.source));
  });
  const labelOf = $derived((i: number) => record?.seats[i]?.label ?? String(i));
</script>

{#if seat}
  <details class="council-seat" class:failed={!!seat.error}>
    <summary class="council-seat-line">
      <span class="ico">▸</span>
      <span class="name">Member {seat.label}</span>
      <span class="arg">
        · {seat.model || "default"}{seat.forked ? "" : " · cold"}{seat.angle ? ` · angle ${seat.angle}` : ""}{seat.area
          ? ` · area: ${seat.area}`
          : ""}
        · {seat.searches} search{seat.searches === 1 ? "" : "es"} · {fmtTokens(seat.tokens)} tokens{seat.error ? ` · did not answer: ${seat.error}` : ""}
      </span>
    </summary>
    <div class="council-seat-body markdown">{@html renderMarkdown(seat.body)}</div>
  </details>
{:else if record}
  <details class="council-record">
    <summary class="council-seat-line">
      <span class="ico">▾</span>
      <span class="name">Sources ({sources.length})</span>
      <span class="arg">
        · shared by all {pct(record.overlap.shared_by_all)}
        {#each record.overlap.pairwise as [i, j, x] (`${i}-${j}`)}
          · {labelOf(i)}∩{labelOf(j)} {pct(x)}
        {/each}
        · {record.mode} pass{record.fired ? " · next council turn assigns areas" : ""}
      </span>
    </summary>
    <div class="council-seat-body">
      <table class="council-table">
        <thead><tr><th>seat</th><th>model</th><th>searches</th><th>words</th><th>tokens</th><th>est. $</th><th>secs</th></tr></thead>
        <tbody>
          {#each record.seats as s (s.label)}
            <tr class:failed={!!s.error}>
              <td>{s.label}</td>
              <td>{s.model}{s.forked ? "" : " (cold)"}{s.angle ? ` · angle ${s.angle[0]}/${s.angle[1]}` : ""}{s.area ? ` · ${s.area}` : ""}</td>
              <td>{s.searches}</td>
              <td>{s.words}</td>
              <td>{fmtTokens(s.usage.input_tokens + s.usage.output_tokens)}</td>
              <td>{s.cost_usd != null ? s.cost_usd.toFixed(2) : "–"}</td>
              <td>{Math.round(s.duration_ms / 1000)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if sources.length > 0}
        <table class="council-table">
          <thead><tr><th>source</th><th>found by</th></tr></thead>
          <tbody>
            {#each sources as row (row.source)}
              <tr>
                <td class="src"><a href={"https://" + row.source} target="_blank" rel="noreferrer">{row.source}</a></td>
                <td>{row.by.join(" ")}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="council-note">No seat cited a source it read.</p>
      {/if}
      {#if record.areas_used.length > 0}
        <p class="council-note">Areas assigned this turn: {record.areas_used.join(" · ")}</p>
      {/if}
      {#if record.areas_next.length > 0}
        <p class="council-note">
          Gaps the chair named{record.fired ? " — assigned as areas on the next council turn" : ""}: {record.areas_next.join(" · ")}
        </p>
      {/if}
      <p class="council-note">
        The chair read the answers as Member A, B, C… in a shuffled order; the map above is what it did not see. Tokens and
        dollars are the CLI's API-equivalent estimate — nothing is billed on the subscription.
      </p>
    </div>
  </details>
{/if}

<style>
  .council-seat,
  .council-record {
    margin: 0;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: color-mix(in srgb, var(--paper) 50%, transparent);
  }
  .council-seat.failed .council-seat-line {
    color: var(--error);
  }
  .council-seat-line {
    display: grid;
    grid-template-columns: 18px minmax(0, auto) minmax(0, 1fr);
    column-gap: 8px;
    align-items: center;
    min-height: 28px;
    cursor: pointer;
    list-style: none;
    color: var(--dim);
    font-size: 0.78rem;
    padding: 5px 12px 5px 16px;
  }
  .council-seat-line::-webkit-details-marker {
    display: none;
  }
  .council-seat-line .name {
    color: var(--ink2);
    font-weight: 600;
  }
  .council-seat-line .arg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .council-seat-body {
    border-left: 2px solid var(--line);
    padding-left: 0.8rem;
    margin: 0 12px 8px 16px;
    font-size: 0.86em;
  }
  .council-table {
    border-collapse: collapse;
    font-size: 0.78rem;
    margin: 4px 0 8px;
  }
  .council-table th,
  .council-table td {
    text-align: left;
    padding: 2px 10px 2px 0;
    color: var(--ink2);
    vertical-align: top;
  }
  .council-table th {
    color: var(--dim);
    font-weight: 500;
  }
  .council-table tr.failed td {
    color: var(--error);
  }
  .council-table .src {
    max-width: 480px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .council-note {
    font-size: 0.78rem;
    color: var(--dim);
    margin: 4px 0;
  }
</style>
