<script lang="ts">
  import { tick } from "svelte";
  import { app } from "./state.svelte";
  import type { Segment } from "./state.svelte";
  import type { Usage } from "./types";
  import AssistantMessage from "./AssistantMessage.svelte";

  interface AssistantFooter {
    model: string;
    usage: Usage;
    stop_reason: string | null;
  }

  type Item =
    | { kind: "user"; text: string }
    | { kind: "assistant"; segs: Segment[]; footer: AssistantFooter }
    | { kind: "compaction"; summary: string };

  // Project SessionEvents into renderable items. tool_result events are
  // consumed by lookup against tool_use blocks and never rendered standalone.
  const items: Item[] = $derived.by(() => {
    const results = new Map<string, { content: string; is_error: boolean }>();
    for (const e of app.events) {
      if (e.event === "tool_result") {
        results.set(e.tool_use_id, {
          content: e.content,
          is_error: e.is_error ?? false,
        });
      }
    }
    const out: Item[] = [];
    for (const e of app.events) {
      if (e.event === "user_message") {
        out.push({ kind: "user", text: e.text });
      } else if (e.event === "assistant_message") {
        const segs: Segment[] = [];
        for (const b of e.blocks) {
          switch (b.type) {
            case "thinking":
              segs.push({ kind: "thinking", text: b.text, done: true });
              break;
            case "redacted_thinking":
              segs.push({ kind: "redacted" });
              break;
            case "text":
              segs.push({ kind: "text", text: b.text });
              break;
            case "tool_use":
              segs.push({
                kind: "tool",
                call: {
                  id: b.id,
                  name: b.name,
                  input: b.input,
                  result: results.get(b.id) ?? null,
                },
              });
              break;
            default:
              // Unknown content block types are ignored by contract.
              break;
          }
        }
        out.push({
          kind: "assistant",
          segs,
          footer: {
            model: e.model,
            usage: e.usage,
            stop_reason: e.stop_reason,
          },
        });
      } else if (e.event === "compaction") {
        out.push({ kind: "compaction", summary: e.summary });
      }
      // session_created / tool_result / unknown events: not rendered.
    }
    return out;
  });

  let viewport = $state<HTMLDivElement | null>(null);
  // Pin to bottom unless the user has scrolled up more than ~80px.
  // Deliberately not $state: changes to it should not re-trigger the effect.
  let pinned = true;

  function onscroll() {
    if (!viewport) return;
    pinned =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }

  $effect(() => {
    void app.events.length;
    void app.liveVersion;
    void tick().then(() => {
      if (pinned && viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  });
</script>

<div class="transcript" bind:this={viewport} {onscroll}>
  <div class="inner">
    {#each items as item, i (i)}
      {#if item.kind === "user"}
        <div class="user-row">
          <div class="user-bubble">{item.text}</div>
        </div>
      {:else if item.kind === "compaction"}
        <details class="compaction">
          <summary>conversation compacted — earlier turns replaced by a summary</summary>
          <div class="compaction-body">{item.summary}</div>
        </details>
      {:else}
        <AssistantMessage segs={item.segs} footer={item.footer} />
      {/if}
    {/each}
    {#if app.live}
      <AssistantMessage segs={app.live.segments} streaming />
    {/if}
    {#if app.error}
      <div class="error-banner">{app.error}</div>
    {/if}
  </div>
</div>

<style>
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.25rem 1rem;
  }
  .inner {
    max-width: 46rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .user-row {
    display: flex;
    justify-content: flex-end;
  }
  .user-bubble {
    background: #8b7cf61a;
    border: 1px solid rgba(139, 124, 246, 0.25);
    border-radius: 12px;
    padding: 0.55rem 0.85rem;
    max-width: 85%;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.92rem;
  }
  .compaction {
    font-size: 0.78rem;
    color: var(--dim);
  }
  .compaction summary {
    cursor: pointer;
    text-align: center;
    list-style: none;
  }
  .compaction summary::before,
  .compaction summary::after {
    content: "—— ";
  }
  .compaction summary::after {
    content: " ——";
  }
  .compaction[open] summary {
    margin-bottom: 0.5rem;
  }
  .compaction-body {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .error-banner {
    color: var(--error);
    background: rgba(246, 109, 124, 0.08);
    border: 1px solid rgba(246, 109, 124, 0.3);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
