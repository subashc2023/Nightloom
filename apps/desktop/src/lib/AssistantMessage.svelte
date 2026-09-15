<script lang="ts">
  import type { Segment } from "./state.svelte";
  import type { ApprovalRequest, Usage } from "./types";
  import { renderMarkdown } from "./markdown";
  import { compactJson } from "./toolinput";
  import {
    flipOverride,
    resolveOpen,
    segmentIds,
    toolSummary,
    transcript,
    type BlockKind,
    type Override,
  } from "./transcriptPrefs.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";

  interface Footer {
    model: string;
    usage: Usage;
    stop_reason: string | null;
    cost?: number;
  }

  /** The turn's text segments, for Copy — thinking and tool traffic are not
   *  what anyone means by "copy the reply". */
  function textOf(): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("\n\n");
  }
  let copied = $state(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(textOf());
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }
  function fmtTokens(u: Usage): string {
    return `${(u.input_tokens + u.output_tokens).toLocaleString()} tokens`;
  }
  function fmtCost(c: number | undefined): string {
    if (c == null) return "";
    return c > 0 && c < 0.01 ? ` · $${c.toFixed(4)}` : ` · $${c.toFixed(2)}`;
  }

  let {
    segs,
    footer = null,
    streaming = false,
    approvals = [],
  }: {
    segs: Segment[];
    footer?: Footer | null;
    streaming?: boolean;
    /** Calls in these segments still waiting on the user's decision. */
    approvals?: ApprovalRequest[];
  } = $props();

  // Per-block clicks, keyed by the block's stable id (`segmentIds`) rather
  // than its index, and consulted before the streaming rule and the two
  // transcript-wide toggles (`resolveOpen`, nightshift backlog 052): a click
  // on a block always wins over its default. The map is this component's,
  // so it lives as long as the message on screen does.
  let overrides = $state<Record<string, Override>>({});
  const ids = $derived(segmentIds(segs));

  function kindOf(seg: Segment): BlockKind {
    return seg.kind === "thinking" ? "thinking" : "tool";
  }
  function doneOf(seg: Segment): boolean {
    if (seg.kind === "thinking") return seg.done;
    if (seg.kind === "tool") return seg.call.result !== null;
    return true;
  }
  function isOpen(i: number, seg: Segment): boolean {
    return resolveOpen(kindOf(seg), ids[i], streaming, doneOf(seg), overrides, transcript);
  }
  function toggle(i: number, seg: Segment): void {
    overrides[ids[i]] = flipOverride(
      kindOf(seg),
      ids[i],
      streaming,
      doneOf(seg),
      overrides,
      transcript,
    );
  }

  // Toggled on pointerdown, not click. While a reply streams the transcript
  // stays pinned to its foot and every delta pushes the pill up the page,
  // so between the press and the release the pointer is over something
  // else and no `click` reaches the button — which is what "clicking a
  // thinking tag mid-reply does nothing" looks like (backlog 052). The
  // press is a single instant and cannot be split. `click` is kept for the
  // keyboard, where `detail` is 0; a pointer's click has already been
  // handled at its press.
  function press(e: PointerEvent, i: number, seg: Segment): void {
    if (e.button !== 0) return;
    toggle(i, seg);
  }
  function keyClick(e: MouseEvent, i: number, seg: Segment): void {
    if (e.detail === 0) toggle(i, seg);
  }
</script>

<div class="assistant">
  {#if footer}
    <span class="ns-k">{footer.model}</span>
  {/if}
  {#each segs as seg, i}
    {#if seg.kind === "thinking"}
      <div>
        <button
          class="pill"
          aria-expanded={isOpen(i, seg)}
          onpointerdown={(e) => press(e, i, seg)}
          onclick={(e) => keyClick(e, i, seg)}>✦ thinking</button>
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
        {#if isOpen(i, seg)}
          <button
            class="tool-chip"
            aria-expanded="true"
            title="Collapse to one line"
            onpointerdown={(e) => press(e, i, seg)}
            onclick={(e) => keyClick(e, i, seg)}
          >
            <span class="caret">▾</span>
            <span class="tool-name">⚒ {seg.call.name}</span>
            <span class="tool-input">{compactJson(seg.call.input)}</span>
            {#if seg.call.denied}<span class="denied-tag">denied</span>{/if}
          </button>
          {#if seg.call.denied}
            <!-- The reason can come from the gate itself (a cancelled turn
                 refuses what it left parked), so it stands in for "you said no"
                 rather than being appended to it. -->
            <div class="denied-note">
              Not run — permission denied{seg.call.result?.content
                ? `: ${seg.call.result.content}`
                : "."}
            </div>
          {:else if seg.call.result}
            <pre
              class="tool-result"
              class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
          {/if}
        {:else}
          <!-- The one-line form (tool calls off): the name, the argument
               that best says what it did, and how much came back. -->
          <button
            class="tool-chip line"
            class:error={!!seg.call.result?.is_error || !!seg.call.denied}
            aria-expanded="false"
            title="Expand this call"
            onpointerdown={(e) => press(e, i, seg)}
            onclick={(e) => keyClick(e, i, seg)}
          >
            <span class="caret">▸</span>
            <span class="tool-line">{toolSummary(seg.call, streaming)}</span>
          </button>
        {/if}
        <!-- Outside the collapse: a call parked at the gate needs its prompt
             on screen whatever the toggle says, or the turn waits on a
             decision nobody can see. -->
        {#each approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
          <ApprovalPrompt {req} />
        {/each}
      </div>
    {:else if seg.kind === "notice"}
      <div class="notice">{seg.text}</div>
    {/if}
  {/each}
  {#if footer && !streaming}
    <div class="footer">
      <button class="ns-btn ghost small" onclick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      <span
        class="meta"
        title="{footer.usage.input_tokens.toLocaleString()} in / {footer.usage.output_tokens.toLocaleString()} out{footer.stop_reason ? ` · ${footer.stop_reason}` : ''}"
      >{fmtTokens(footer.usage)}{fmtCost(footer.cost)}</span>
    </div>
  {/if}
</div>

<style>
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 640px;
  }
  .assistant :global(.markdown) {
    /* Plex Sans, the interface face, since 2026-09-14: the editorial serif
       read as academic to him ("looks like Times New Roman almost"), and of
       the seven faces compared side by side he chose the one the chrome
       already uses. A per-user choice is nightshift backlog 051. */
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.55;
    color: var(--ink);
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
    /* A button since the toggles (backlog 052), drawn as the line it was. */
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    width: 100%;
    cursor: pointer;
    user-select: none;
  }
  .tool-chip:hover .tool-name,
  .tool-chip:hover .caret {
    color: var(--text);
  }
  .caret {
    color: var(--dim);
    flex: none;
    width: 0.8em;
  }
  .tool-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-chip.line.error .tool-line {
    color: var(--failed);
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
  .denied-tag {
    color: var(--failed);
    border: 1px solid var(--failed);
    border-radius: 999px;
    padding: 0 0.45rem;
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .denied-note {
    color: var(--dim);
    font-size: 0.78rem;
    word-break: break-word;
  }
  .tool-result.error {
    color: var(--failed);
    background: var(--failed-soft);
    border-color: var(--failed);
  }
  .notice {
    color: var(--dim);
    font-size: 0.78rem;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
</style>
