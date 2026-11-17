<script lang="ts">
  /**
   * The morning scan as a card (nightshift item 763, H3): the message code sends Home each morning starts
   * with the scan line and carries ~10k characters of collected facts. Drawn as "Morning scan · 8:00 AM"
   * with the facts folded (the fold kept), not as a bubble the length of the page.
   */
  import { tip } from "./tip";
  import { keptOpen } from "./keptFolds.svelte";
  import { clock, factsWords, scanFacts } from "./home";
  import { exactTime } from "./time";

  let { text, at, foldKey, classic = false }: { text: string; at: string; foldKey: string | null; classic?: boolean } = $props();

  const facts = $derived(scanFacts(text));
  const when = $derived(clock(at));
</script>

<details class="scan-card" class:classic use:keptOpen={{ key: foldKey }}>
  <summary>
    <span class="sc-title">Morning scan{when ? ` · ${when}` : ""}</span>
    <span class="sc-meta" use:tip={exactTime(at)}>{factsWords(facts)}</span>
    <span class="sc-chev" aria-hidden="true">▾</span>
  </summary>
  <pre class="sc-facts">{facts}</pre>
</details>

<style>
  .scan-card {
    margin: 8px 0 14px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent-ink) 4%, var(--paper, transparent));
    overflow: hidden;
  }
  .scan-card.classic {
    border-radius: 8px;
  }
  summary {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px;
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .sc-title {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    color: var(--ink);
    white-space: nowrap;
  }
  .sc-meta {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sc-chev {
    color: var(--dim);
    font-size: 10px;
    transform: rotate(-90deg);
    transition: transform 0.12s;
  }
  .scan-card[open] .sc-chev {
    transform: none;
  }
  summary:hover .sc-title {
    color: var(--accent-ink);
  }
  .sc-facts {
    margin: 0;
    padding: 10px 14px 12px;
    border-top: 1px solid var(--line2);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 28rem;
    overflow-y: auto;
  }
</style>
