<script lang="ts">
  /**
   * The dividers of one continuous chat (nightshift item 763, H3), in both transcripts: a date line
   * between two messages whose local days differ ("Tuesday, November 17"), and a hand-off line where the
   * chat handed off in place ("Handed off in place · 212k → fresh · 4:12 AM"), its brief folded under it —
   * the fold kept under the chat and the event, so it survives leaving and coming back.
   */
  import { tip } from "./tip";
  import { keptOpen } from "./keptFolds.svelte";
  import { carriedLabel, handOffLine, handOffTip, lastCarried, type Divider } from "./home";

  let {
    dividers,
    foldKey,
    classic = false,
  }: {
    dividers: readonly Divider[];
    /** Where a hand-off's fold is kept, by its log index; null keeps nothing. */
    foldKey: (index: number) => string | null;
    classic?: boolean;
  } = $props();
</script>

{#each dividers as d (d.kind === "date" ? `d:${d.day}` : `h:${d.index}`)}
  {#if d.kind === "date"}
    <div class="day-rule" class:classic role="separator" aria-label={d.label}>
      <span class="day-line"></span>
      <span class="day-label">{d.label}</span>
      <span class="day-line"></span>
    </div>
  {:else}
    {@const entry = lastCarried(d.brief)}
    <details class="hand-off" class:classic data-hand-off={d.index} use:keptOpen={{ key: foldKey(d.index) }}>
      <summary use:tip={handOffTip(d)}>
        <span class="ho-row">
          <span class="ho-line"></span>
          <span class="ho-label">{handOffLine(d)}</span>
          <span class="ho-chev" aria-hidden="true">▾</span>
          <span class="ho-line"></span>
        </span>
        {#if entry}
          <!-- Items 789 + 791: the run log's newest entry — the slice above, in its own words — folded or not. -->
          <span class="ho-entry" data-run-entry><span class="ho-entry-head">{carriedLabel(entry)}</span>{entry.body}</span>
        {/if}
      </summary>
      <div class="ho-brief">
        <div class="ho-head">What the fresh start was given</div>{d.brief || "No brief was recorded."}
      </div>
    </details>
  {/if}
{/each}

<style>
  .day-rule,
  .ho-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .day-rule {
    margin: 18px 0 10px;
  }
  .day-line,
  .ho-line {
    flex: 1;
    min-width: 16px;
    height: 1px;
    background: var(--line2);
  }
  .day-label {
    text-align: center;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .classic .day-label {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink2);
  }
  .hand-off {
    margin: 16px 0 12px;
  }
  .hand-off summary {
    list-style: none;
    cursor: pointer;
    display: block;
  }
  .hand-off summary::-webkit-details-marker {
    display: none;
  }
  .ho-line {
    background: color-mix(in srgb, var(--accent-ink) 45%, transparent);
  }
  .ho-label {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--accent-ink);
    text-align: center;
    min-width: 0;
    max-width: calc(100% - 64px);
  }
  .classic .ho-label {
    font-family: var(--sans);
    font-size: 12.5px;
  }
  .ho-chev {
    color: var(--accent-ink);
    font-size: 10px;
    margin-left: -6px;
    transition: transform 0.12s;
    transform: rotate(-90deg);
  }
  .hand-off[open] .ho-chev {
    transform: none;
  }
  .hand-off summary:hover .ho-label {
    text-decoration: underline;
  }
  .ho-brief {
    margin: 10px 0 0;
    padding: 10px 14px;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 22rem;
    overflow-y: auto;
  }
  .ho-entry {
    margin: 8px 0 0;
    padding: 0 12px;
    border-left: 2px solid color-mix(in srgb, var(--accent-ink) 45%, transparent);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-word;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .hand-off[open] .ho-entry {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .ho-entry-head {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
    margin-right: 8px;
  }
  .classic .ho-entry-head {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
  }
  .ho-head {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 6px;
  }
</style>
