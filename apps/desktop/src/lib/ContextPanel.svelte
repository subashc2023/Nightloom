<script lang="ts">
  import * as api from "./api";
  import { app, addToast } from "./state.svelte";
  import type { BlockKind, Size, WireBlock, WireView } from "./types";

  let view = $state<WireView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let working = $state(false);

  async function refresh() {
    if (!app.connection) {
      view = null;
      return;
    }
    loading = true;
    error = null;
    try {
      view = await api.contextView();
    } catch (e) {
      error = String(e);
      view = null;
    } finally {
      loading = false;
    }
  }

  // Re-read whenever the log or the connection moves. The view is a
  // projection of both — the preamble and sidecar come off the Chat, the
  // conversation off the Session — so anything that changes either can
  // change what is on the wire. Keyed on length rather than identity
  // because `app.events` is replaced wholesale by each re-sync.
  $effect(() => {
    void app.events.length;
    void app.connection;
    void app.busy;
    refresh();
  });

  async function edit(targets: number[], remove: boolean) {
    working = true;
    try {
      const result = await api.editContext(targets, remove);
      view = result.view;
      // The transcript is re-synced from the same call rather than patched
      // here: an elision changes every projection off the log.
      app.events = result.events;
      if (result.changed > 0 && remove) {
        addToast(
          `Removed ${result.changed} item${result.changed === 1 ? "" : "s"} — the content stays in the session log, and the prompt cache is invalidated from here on.`,
        );
      }
    } catch (e) {
      addToast(String(e));
    } finally {
      working = false;
    }
  }

  /** Every live block, flattened — the panel is a size ranking, not a chat. */
  const items = $derived(
    (view?.messages ?? []).flatMap((m) =>
      m.blocks.map((b) => ({ role: m.role, block: b })),
    ),
  );

  const elided = $derived(
    [
      ...new Set(
        items
          .filter((i) => i.block.elided && i.block.source.from === "event")
          .map((i) => (i.block.source as { index: number }).index),
      ),
    ],
  );

  /**
   * Tokens where an estimate is honest, bytes where it is not. Never a
   * guessed token count for an image — the whole reason `tokens` is nullable.
   */
  function sizeLabel(size: Size): string {
    if (size.tokens !== null) return `${size.tokens.toLocaleString()} tok`;
    const kb = size.bytes / 1024;
    return kb >= 1024
      ? `${(kb / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(kb)).toLocaleString()} KB`;
  }

  const KIND_LABEL: Record<BlockKind, string> = {
    text: "text",
    image: "image",
    document: "document",
    thinking: "thinking",
    redacted_thinking: "thinking (encrypted)",
    tool_use: "tool call",
    reasoning_ref: "reasoning",
    tool_result: "tool result",
    sidecar: "status block",
  };

  const kindOf = (b: WireBlock) => KIND_LABEL[b.kind] ?? b.kind;
  const indexOf = (b: WireBlock) =>
    b.source.from === "event" ? b.source.index : null;

  /** Share of the itemized total, for the size bar. */
  function share(size: Size): number {
    const total = view?.totals.tokens ?? 0;
    if (!total || size.tokens === null) return 0;
    return Math.min(1, size.tokens / total);
  }

  // The caveats are real but they are footnotes, not the panel: estimation
  // and the cost of removing both live on the controls they qualify.
  const TOTAL_NOTE =
    "Estimated, not measured — there is no tokenizer here, so these rank items by size rather than predict a bill.";
  const EDIT_NOTE =
    "Removing an item takes its content off the next request. Nothing is deleted — the session log keeps it, the transcript still shows it, and no cost is refunded.";
</script>

<div class="panel">
  {#if !app.connection}
    <p class="empty">Not connected.</p>
  {:else if error}
    <p class="empty err">{error}</p>
  {:else if !view}
    <p class="empty">{loading ? "Reading…" : "Nothing yet."}</p>
  {:else}
    {@const t = view.totals}
    {@const floor = t.unestimated > 0 ? "≥" : ""}
    <header
      title={t.unestimated > 0
        ? `${TOTAL_NOTE}\n\n${t.unestimated} item${t.unestimated === 1 ? "" : "s"} (images) cannot be estimated at all, so the total is a floor.`
        : TOTAL_NOTE}
    >
      <div class="total">
        <span class="num">{floor}{t.tokens.toLocaleString()}</span>
        {#if view.context_limit}
          <span class="dim"
            >/ {(view.context_limit / 1000).toFixed(0)}k · {Math.round(
              (t.tokens / view.context_limit) * 100,
            )}%</span
          >
        {:else}
          <span class="dim">tokens</span>
        {/if}
        <span class="est">est.</span>
      </div>
      {#if view.context_limit}
        <div class="bar">
          <div
            class="fill"
            style="width: {Math.min(
              100,
              (t.tokens / view.context_limit) * 100,
            )}%"
          ></div>
        </div>
      {/if}
      {#if elided.length > 0}
        <button
          class="restore"
          disabled={working}
          title={EDIT_NOTE}
          onclick={() => edit(elided, false)}
        >
          Restore {elided.length} removed
        </button>
      {/if}
    </header>

    {#if view.system.length > 0}
      <section>
        <h3>System</h3>
        <ul class="list">
          {#each view.system as seg (seg.name)}
            <li class="row static" title={seg.preview}>
              <div class="line">
                <span class="size">{sizeLabel(seg.size)}</span>
                <span class="kind">{seg.name}</span>
                {#if seg.cache_anchor}
                  <span class="anchor" title="Cached prefix ends here">⚑</span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section>
      <h3>Conversation</h3>
      {#if items.length === 0}
        <p class="empty">Nothing yet.</p>
      {:else}
        <ul class="list">
          {#each items as item, i (i)}
            {@const b = item.block}
            <li
              class="row"
              class:elided={b.elided}
              title={b.preview + (b.truncated ? "…" : "")}
            >
              <div class="line">
                <span class="size">{sizeLabel(b.size)}</span>
                <span class="kind">{kindOf(b)}</span>
                <span class="role">{item.role}</span>
                {#if b.elidable}
                  <button
                    class="act"
                    disabled={working || app.busy}
                    title={EDIT_NOTE}
                    onclick={() => edit([indexOf(b)!], !b.elided)}
                  >
                    {b.elided ? "↺" : "✕"}
                  </button>
                {/if}
              </div>
              <div
                class="sizebar"
                style="width: {(share(b.size) * 100).toFixed(1)}%"
              ></div>
              <div class="preview">{b.preview}</div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 0.7rem;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .empty {
    margin: 0;
    font-size: 0.74rem;
    color: var(--dim);
  }
  .err {
    color: var(--error);
    line-height: 1.4;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .total {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .num {
    font-size: 0.95rem;
  }
  .dim {
    color: var(--dim);
  }
  .est {
    margin-left: auto;
    color: var(--dim);
    opacity: 0.6;
    font-size: 0.62rem;
  }
  .bar {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  h3 {
    margin: 0 0 0.35rem;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--dim);
    opacity: 0.8;
    font-weight: 600;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.32rem;
  }
  /* One line per block plus a hairline bar: the panel is a size ranking, and
     a ranking is read by scanning down a column, not by reading previews. */
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.7rem;
  }
  .size {
    font-variant-numeric: tabular-nums;
    min-width: 4.2rem;
    text-align: right;
    flex-shrink: 0;
  }
  .kind {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .role {
    color: var(--dim);
    opacity: 0.5;
    font-size: 0.62rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  .anchor {
    color: var(--accent);
    font-size: 0.68rem;
  }
  .act {
    background: transparent;
    border: none;
    color: var(--dim);
    opacity: 0.5;
    font-family: inherit;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0 0.1rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .act:hover:not(:disabled) {
    color: var(--accent);
    opacity: 1;
  }
  .act:disabled {
    opacity: 0.25;
    cursor: default;
  }
  .restore {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
  }
  .restore:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .sizebar {
    height: 2px;
    background: var(--accent);
    opacity: 0.45;
    border-radius: 1px;
    min-width: 1px;
  }
  /* One line, never two: the full text is on the row's tooltip, and this is
     only here to tell one tool result from another. */
  .preview {
    font-size: 0.66rem;
    color: var(--dim);
    opacity: 0.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.elided .preview,
  .row.elided .kind {
    font-style: italic;
    opacity: 0.55;
  }
  .row.elided .sizebar {
    opacity: 0.15;
  }
  .row.static .size {
    opacity: 0.8;
  }
</style>
