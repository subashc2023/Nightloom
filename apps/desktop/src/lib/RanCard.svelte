<script lang="ts">
  /**
   * A block he ran, as his message (nightshift item 503, 2026-11-04): the
   * command and how it ended on one card, the output folded under it. The
   * message's text is what the model read (`ranMessage`); this is only how
   * his side of the chat draws it. The fold is kept, as every view's is.
   */
  import Icon from "./Icon.svelte";
  import { keptOpen } from "./keptFolds.svelte";
  import type { RanMessage } from "./shellRun";

  let { ran, keep = null }: {
    ran: RanMessage;
    /** The bubble's fold key: equal runs in two chats keep their own fold. */
    keep?: string | null;
  } = $props();

  const failed = $derived(/^exit [1-9]/.test(ran.status) || ran.status.startsWith("ended by"));
  const lines = $derived(ran.output ? ran.output.split("\n").length : 0);
  const key = $derived(`${keep ?? "ran"}|${ran.command.length}|${ran.output.length}|${ran.command.slice(0, 60)}`);
</script>

<div class="ran-card" data-find-text={`${ran.command}\n${ran.output}`}>
  <div class="ran-head">
    <Icon name="term" size={13} />
    <span class="ran-title">Ran in terminal</span>
    <span class="ran-status mono" class:failed>{ran.status}</span>
  </div>
  <pre class="ran-command mono">{ran.command}</pre>
  {#if ran.output}
    <details class="ran-fold" use:keptOpen={{ key }}>
      <summary>Output · {lines} {lines === 1 ? "line" : "lines"}</summary>
      <pre class="ran-output mono">{ran.output}</pre>
    </details>
  {:else}
    <div class="ran-none">No output.</div>
  {/if}
</div>

<style>
  .ran-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: min(420px, 100%);
    max-width: 100%;
  }
  .ran-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--dim);
  }
  .ran-title {
    color: var(--ink2);
  }
  .ran-status {
    margin-left: auto;
    font-size: 11px;
    color: var(--done);
  }
  .ran-status.failed {
    color: var(--failed);
  }
  .ran-command,
  .ran-output {
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ran-output {
    margin-top: 6px;
    max-height: 320px;
    overflow: auto;
    color: var(--ink2);
  }
  .ran-fold summary {
    font-size: 12px;
    color: var(--dim);
    cursor: pointer;
  }
  .ran-none {
    font-size: 12px;
    color: var(--dim);
  }
</style>
