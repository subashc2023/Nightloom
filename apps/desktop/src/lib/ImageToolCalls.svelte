<script lang="ts">
  // Settings → Usage: the image tool that is not built yet (nightshift item
  // 823, stage 1). Every chat has `generate_image`; each call is logged and
  // fails. This card counts them and lets him read what was asked; the fold
  // keeps its state (his rule of 2026-11-02) through `paneState`.
  import { onMount } from "svelte";
  import * as api from "./api";
  import { tip } from "./tip";
  import { exactTime } from "./time";
  import { isOpen, setOpen } from "./settings/paneState.svelte";
  import { askedLine, countLine, countTip, whereLine } from "./imageCalls";

  const FOLD = "usage/image-calls";
  let summary = $state<api.ImageCallSummary | null>(null);
  let failed = $state<string | null>(null);

  onMount(() => {
    api
      .imageToolCalls()
      .then((s) => (summary = s))
      .catch((e) => (failed = String(e)));
  });
</script>

<section class="img-card" aria-label="Image tool calls">
  <div class="img-head">
    <span class="img-t">Image tool calls</span>
    {#if summary}
      <b class="img-count" use:tip={countTip(summary)}>{countLine(summary)}</b>
    {/if}
  </div>
  <p class="img-note">
    Every chat has a <code>generate_image</code> tool that is not built yet: a call
    fails, tells the model to draw it with code, and is counted here. Nothing is sent
    to any company.
  </p>
  {#if failed}
    <p class="img-note">Could not read the log: {failed}</p>
  {:else if summary && summary.total > 0}
    <button
      class="ns-btn small"
      use:tip={"Show the prompts, newest first"}
      aria-expanded={isOpen(FOLD)}
      onclick={() => setOpen(FOLD, !isOpen(FOLD))}
    >{isOpen(FOLD) ? "Hide the prompts" : `Show the prompts (${summary.calls.length})`}</button>
    {#if isOpen(FOLD)}
      <ol class="img-calls">
        {#each summary.calls as c, i (i)}
          <li>
            <span class="img-asked">{askedLine(c)}</span>
            <small>{exactTime(c.at)} · {whereLine(c)}</small>
          </li>
        {/each}
      </ol>
      <p class="img-note">Log: <code>{summary.path}</code></p>
    {/if}
  {:else if summary}
    <p class="img-note">No calls yet.</p>
  {/if}
</section>

<style>
  .img-card {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .img-head {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .img-t {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .img-count {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .img-note {
    margin: 0;
    font-size: 12px;
    color: var(--dim);
  }
  .img-calls {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 280px;
    overflow: auto;
    align-self: stretch;
  }
  .img-calls li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .img-asked {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .img-calls small {
    font-size: 11px;
    color: var(--dim);
  }
</style>
