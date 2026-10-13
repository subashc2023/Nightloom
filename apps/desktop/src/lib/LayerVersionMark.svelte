<script lang="ts">
  import { tip } from "./tip";
  /*
   * A layer card's *newer version exists* mark (nightshift backlog 174):
   * the file changed while this chat ran on the old text. Says what the
   * chat reads and when that changes; the diff folds open; *Update now*
   * names what it rewrites; *Keep this version* pins the old text for this
   * chat and shrinks the mark to a dot. The rules are `promptVersions.ts`.
   */
  import { lineDiff } from "./diff";
  import { prefixTokens } from "./cliUpdate.svelte";
  import { app, chooseLayerVersion, updateLayerNow } from "./state.svelte";
  import { chatIsCold, choicesFor, markLine, updateNowCost } from "./promptVersions";
  import type { PendingLayer } from "./types";

  let { pending }: { pending: PendingLayer } = $props();

  let showDiff = $state(false);
  const auto = $derived(app.layerPrefs.autoAtCold);
  const cold = $derived(chatIsCold(app.events, Date.now()));
  const cost = $derived(updateNowCost(prefixTokens(app.events), cold));
  const diff = $derived(showDiff ? lineDiff(pending.held, pending.newer) : []);
  const kept = $derived(pending.choice === "keep");
  const locked = $derived(app.busy || app.connecting);
</script>

<div class="mark" class:kept>
  <div class="line">
    <span class="dot" aria-hidden="true"></span>
    <span class="say">{markLine(pending, auto, cold)}</span>
  </div>
  <div class="actions">
    <button class="ns-btn ghost small" aria-expanded={showDiff} onclick={() => (showDiff = !showDiff)}>
      {showDiff ? "Hide changes" : "Show changes"}
    </button>
    {#each choicesFor(pending, auto) as c (c.choice)}
      <button class="ns-btn ghost small" disabled={locked} onclick={() => void chooseLayerVersion(pending.kind, c.choice)}>
        {c.label}
      </button>
    {/each}
    <button class="ns-btn small" disabled={locked} use:tip={cost} onclick={() => void updateLayerNow(pending.kind)}>
      Update now
    </button>
    <span class="cost">{cost}</span>
  </div>
  {#if showDiff}
    <pre class="diff" aria-label="What changed in the file">{#each diff as l, i (i)}<span class={l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}{l.text}
</span>{/each}</pre>
  {/if}
</div>

<style>
  .mark {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .mark.kept {
    border-color: var(--line);
    background: transparent;
  }
  .line {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    transform: translateY(-1px);
  }
  .kept .dot {
    background: var(--dim);
  }
  .say {
    font-size: 13px;
    color: var(--ink);
  }
  .kept .say {
    color: var(--dim);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .cost {
    font-size: 12px;
    color: var(--dim);
  }
  .diff {
    margin: 0;
    padding: 8px 10px;
    max-height: 18rem;
    overflow: auto;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12.5px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .diff .add {
    background: var(--add-bg);
    color: var(--add-fg);
  }
  .diff .del {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .diff .ctx {
    color: var(--dim);
  }
</style>
