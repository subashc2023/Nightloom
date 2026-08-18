<script lang="ts">
  import type { Segment } from "./state.svelte";
  import type { Usage } from "./types";
  import { renderMarkdown } from "./markdown";

  interface Footer {
    model: string;
    usage: Usage;
    stop_reason: string | null;
  }

  let {
    segs,
    footer = null,
    streaming = false,
  }: { segs: Segment[]; footer?: Footer | null; streaming?: boolean } =
    $props();

  // Per-segment expansion overrides for thinking pills, keyed by index.
  // With no override, a thinking block is open only while actively streaming.
  let expanded = $state<Record<number, boolean>>({});

  function isOpen(i: number, seg: Segment): boolean {
    const override = expanded[i];
    if (override !== undefined) return override;
    return streaming && seg.kind === "thinking" && !seg.done;
  }

  function toggle(i: number, seg: Segment) {
    expanded[i] = !isOpen(i, seg);
  }

  function compactJson(input: unknown): string {
    try {
      return JSON.stringify(input) ?? "null";
    } catch {
      return String(input);
    }
  }
</script>

<div class="assistant">
  {#each segs as seg, i}
    {#if seg.kind === "thinking"}
      <div>
        <button class="pill" onclick={() => toggle(i, seg)}>✦ thinking</button>
        {#if isOpen(i, seg)}
          <div class="thinking-text">{seg.text}</div>
        {/if}
      </div>
    {:else if seg.kind === "redacted"}
      <div><span class="pill static">✦ redacted thinking</span></div>
    {:else if seg.kind === "text"}
      <div class="markdown">{@html renderMarkdown(seg.text)}</div>
    {:else if seg.kind === "tool"}
      <div class="tool">
        <div class="tool-chip">
          <span class="tool-name">⚒ {seg.call.name}</span>
          <span class="tool-input">{compactJson(seg.call.input)}</span>
        </div>
        {#if seg.call.result}
          <pre
            class="tool-result"
            class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
        {/if}
      </div>
    {:else if seg.kind === "notice"}
      <div class="notice">{seg.text}</div>
    {/if}
  {/each}
  {#if footer && !streaming}
    <div class="footer">
      {footer.model} · {footer.usage.input_tokens} in / {footer.usage
        .output_tokens} out tokens{footer.stop_reason
        ? ` · ${footer.stop_reason}`
        : ""}
    </div>
  {/if}
</div>

<style>
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }
  .pill {
    display: inline-block;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--dim);
    border-radius: 999px;
    font-size: 0.75rem;
    padding: 0.15rem 0.65rem;
    cursor: pointer;
    user-select: none;
  }
  button.pill:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .pill.static {
    cursor: default;
  }
  .thinking-text {
    color: var(--dim);
    font-style: italic;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin-top: 0.4rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--border);
  }
  .tool {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .tool-chip {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }
  .tool-name {
    color: var(--accent);
    white-space: nowrap;
  }
  .tool-input {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-result {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dim);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .tool-result.error {
    color: var(--error);
    background: rgba(246, 109, 124, 0.06);
    border-color: rgba(246, 109, 124, 0.3);
  }
  .notice {
    color: var(--dim);
    font-size: 0.78rem;
  }
  .footer {
    color: var(--dim);
    font-size: 0.72rem;
    margin-top: 0.1rem;
  }
</style>
