<script lang="ts">
  /**
   * This chat's preview (nightshift item 430): a dev server the app runs
   * for the chat, up between its messages. Above the composer like the
   * scheduled message's chip: its address and status, the command, the
   * log's last 200 lines on demand, Open (a Nightloom web tab) and Stop.
   * The model starts it with its `preview` tool; this chip is his view of
   * it and his way to end it.
   */
  import { onDestroy, onMount } from "svelte";
  import { tip } from "./tip";
  import { previews, refreshPreview, startPreviews, stopPreview } from "./preview.svelte";
  import { previewCommandLine, previewHost, previewStatusText } from "./preview";
  import { openWebTab } from "./webtabs.svelte";

  let { chat }: { chat: string } = $props();

  const p = $derived(previews.byChat[chat] ?? null);
  let showLog = $state(false);
  let stopping = $state(false);
  let logEl: HTMLPreElement | undefined = $state();
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void startPreviews();
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  // Whether there is one: a boolean, so a refresh (a new snapshot object)
  // does not re-run the poll's effect — it would refresh again at once, a
  // loop (caught by the 430 harness).
  const has = $derived(p !== null);

  // While the log is open, its newest lines every second.
  $effect(() => {
    if (timer) clearInterval(timer);
    timer = null;
    if (showLog && has) {
      const c = chat;
      void refreshPreview(c);
      timer = setInterval(() => void refreshPreview(c), 1000);
    }
  });

  // Keep the newest line in view.
  $effect(() => {
    void p?.log.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  async function stop(): Promise<void> {
    stopping = true;
    try {
      await stopPreview(chat);
      showLog = false;
    } finally {
      stopping = false;
    }
  }
</script>

{#if p}
  <div class="preview-chip" data-status={p.status} role="status" aria-label="preview">
    <div class="preview-row">
      <span class="dot" aria-hidden="true"></span>
      <span class="ns-chip mono preview-label">preview · {previewStatusText(p)}</span>
      <button
        class="preview-url mono"
        use:tip={`Open ${p.url} in a Nightloom tab`}
        onclick={() => void openWebTab(p.url)}>{previewHost(p)}</button
      >
      <span class="preview-cmd mono" use:tip={`${p.command}\nin ${p.cwd}`}>{previewCommandLine(p.command)}</span>
      <span class="preview-acts">
        <button class="ns-btn ghost small" aria-expanded={showLog} onclick={() => (showLog = !showLog)}
          >{showLog ? "Hide log" : "Log"}</button
        >
        <button class="ns-btn ghost small" onclick={() => void openWebTab(p.url)}>Open</button>
        <button
          class="ns-btn ghost small"
          disabled={stopping}
          use:tip={"End the server and everything it started"}
          onclick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</button
        >
      </span>
    </div>
    {#if showLog}
      <pre class="preview-log mono" bind:this={logEl} aria-label="preview log">{p.log.length
          ? p.log.join("\n")
          : "(no output yet)"}</pre>
    {/if}
  </div>
{/if}

<style>
  .preview-chip {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink);
    min-width: 0;
  }
  .preview-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
  }
  [data-status="listening"] .dot {
    background: var(--done);
  }
  [data-status="starting"] .dot {
    background: var(--partial);
    animation: preview-pulse 1.4s ease-in-out infinite;
  }
  [data-status="exited"] .dot {
    background: var(--failed);
  }
  [data-status="exited"] .preview-label {
    color: var(--failed);
  }
  @keyframes preview-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-status="starting"] .dot {
      animation: none;
    }
  }
  .preview-label {
    flex: none;
  }
  .preview-url {
    flex: none;
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-ink);
    font-size: 12.5px;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .preview-cmd {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dim);
    font-size: 12px;
  }
  .preview-acts {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .preview-log {
    margin: 0.45rem 0 0.1rem;
    max-height: 220px;
    overflow: auto;
    padding: 0.45rem 0.55rem;
    background: var(--term, var(--well));
    border: 1px solid var(--line);
    border-radius: 6px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
