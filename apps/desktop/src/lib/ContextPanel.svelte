<script lang="ts">
  import * as api from "./api";
  import { app, addToast, promptLayersOff, setPromptLayer } from "./state.svelte";
  import type {
    BlockKind,
    PromptLayer,
    Size,
    WireBlock,
    WireSegment,
    WireView,
  } from "./types";

  let view = $state<WireView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let working = $state(false);

  // Which system rows are unfolded to their full text, by segment name, and
  // whether the whole prompt is shown as the one string the backend sends.
  // Per-name rather than a single open row: comparing two layers side by
  // side is the reason to unfold at all.
  let open = $state<Set<string>>(new Set());
  let asSent = $state(false);
  let copied = $state(false);

  function toggle(name: string): void {
    const next = new Set(open);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    open = next;
  }

  async function copySent(): Promise<void> {
    if (!view?.system_text) return;
    try {
      await navigator.clipboard.writeText(view.system_text);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }

  // The CLI holds the conversation on this engine, so the view is the
  // preamble alone and the conversation section says so instead of listing
  // nothing.
  const agentEngine = $derived(app.connection?.engine === "claude-code");

  /**
   * The layers a chat can switch off, in ladder order, with the row each
   * one gets. A fixed catalogue rather than the segments that happen to be
   * present, because an absent layer needs a row too: the one switched off
   * (struck through, so the blind test is visible while it runs) and the
   * one with nothing to send (no AGENTS.md on the walk), which are
   * different states and must not look alike. `engines` says where a layer
   * exists at all — identity and environment are Claude Code's own on that
   * engine, and the engine note exists nowhere else.
   */
  const LAYERS: {
    kind: PromptLayer;
    label: string;
    hint: string;
    engines: "both" | "provider" | "agent";
  }[] = [
    {
      kind: "identity",
      label: "identity",
      hint: "Who the assistant is and how it should behave — Nightloom's built-in text.",
      engines: "provider",
    },
    {
      kind: "environment",
      label: "environment",
      hint: "Stable facts about the host: cwd, OS, shell, git repo and branch. Never the clock.",
      engines: "provider",
    },
    {
      kind: "user_memory",
      label: "user memory",
      hint: "Your own ~/.nightloom/AGENTS.md — standing preferences read by every model.",
      engines: "both",
    },
    {
      kind: "model_instructions",
      label: "model instructions",
      hint: "This model's own file under ~/.nightloom/models/, if it has one.",
      engines: "both",
    },
    {
      kind: "project_instructions",
      label: "project instructions",
      hint: "Every AGENTS.md between the filesystem root and the workspace, outermost first.",
      engines: "both",
    },
    {
      kind: "project_notes",
      label: "notes index",
      hint: "The project's shared notes, listed by name — the contents are read on demand.",
      engines: "both",
    },
    {
      kind: "knowledge",
      label: "vault index",
      hint: "The knowledge vault, listed by folder — the contents are read on demand.",
      engines: "both",
    },
    {
      kind: "engine_note",
      label: "engine note",
      hint: "How the names above read on Claude Code: its Read/Write/Edit for read_file and friends, and where @kb points.",
      engines: "agent",
    },
  ];

  /** The chat's switched-off layers, projected from the log like the todos. */
  const off = $derived(promptLayersOff(app.events));

  /** Segments of one kind, in the view; several for the AGENTS.md walk. */
  function segmentsOf(kind: PromptLayer): WireSegment[] {
    return (view?.system ?? []).filter((s) => s.kind === kind);
  }
  const custom = $derived((view?.system ?? []).filter((s) => s.kind === "custom"));

  /** Whether the layer has a row on this engine, and whether it can be switched. */
  function shown(engines: "both" | "provider" | "agent"): boolean {
    return engines === "both" || (engines === "agent") === agentEngine;
  }

  let switching = $state(false);
  async function flip(kind: PromptLayer, on: boolean): Promise<void> {
    switching = true;
    try {
      await setPromptLayer(kind, on);
    } finally {
      switching = false;
    }
  }

  // Off at the rail is off for every chat, and the per-chat switches have
  // nothing left to remove; said once above the list rather than as eight
  // greyed rows.
  const railOff = $derived(!app.draft.preamble);
  const AGENT_CAVEAT =
    "On Claude Code a change here reaches a new chat at once. A resumed one keeps the prompt the CLI recorded on its first request — on CLI 2.1.265 or later, until its next compaction.";

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
          <!-- On Claude Code the total is the preamble alone — the part of
               the request that is ours — never the CLI's whole context. -->
          <span class="dim">{agentEngine ? "tokens appended" : "tokens"}</span>
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

    <section>
      <div class="head">
        <h3>System</h3>
        <button
          class="link"
          class:on={asSent}
          disabled={!view.system_text}
          title="The whole system prompt as one string, exactly as the backend renders it for the request"
          onclick={() => (asSent = !asSent)}
        >
          {asSent ? "Show as layers" : "Show as sent"}
        </button>
      </div>
      {#if asSent}
        <div class="sent">
          <div class="sent-bar">
            <span class="dim">{view.system_text?.length.toLocaleString() ?? 0} characters</span>
            <button class="link" onclick={copySent}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <pre class="text sent-text">{view.system_text ?? ""}</pre>
        </div>
      {:else}
        {#if railOff}
          <p class="empty">
            The rail's Preamble switch is off, so none of the discovered
            layers is sent to any chat; only the library prompt below goes.
          </p>
        {/if}
        <ul class="list">
          {#each LAYERS.filter((l) => shown(l.engines)) as layer (layer.kind)}
            {@const isOff = off.includes(layer.kind)}
            {@const segs = segmentsOf(layer.kind)}
            <li class="row static layer" class:off={isOff}>
              <div class="line">
                <input
                  type="checkbox"
                  class="switch"
                  checked={!isOff}
                  disabled={switching || railOff || app.busy || app.connecting}
                  title={isOff
                    ? "Off for this chat — switch on to send it again"
                    : "On — switch off to keep it from this chat"}
                  onchange={(e) => void flip(layer.kind, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="kind label" title={layer.hint}>{layer.label}</span>
                {#if isOff}
                  <span class="state">off for this chat</span>
                {:else if segs.length === 0}
                  <span class="state">nothing to send</span>
                {:else if segs.length === 1}
                  <span class="size">{sizeLabel(segs[0].size)}</span>
                {/if}
              </div>
              {#if !isOff}
                {#each segs as seg (seg.name)}
                  <div class="seg" class:open={open.has(seg.name)}>
                    <button
                      class="line unfold"
                      title={open.has(seg.name) ? "Fold" : "Unfold to the full text"}
                      onclick={() => toggle(seg.name)}
                    >
                      <span class="caret">{open.has(seg.name) ? "▾" : "▸"}</span>
                      {#if segs.length > 1}
                        <span class="size">{sizeLabel(seg.size)}</span>
                      {/if}
                      <span class="kind">{seg.name}</span>
                      {#if seg.cache_anchor}
                        <span class="anchor" title="Cached prefix ends here">⚑</span>
                      {/if}
                    </button>
                    {#if open.has(seg.name)}
                      <pre class="text">{seg.text}</pre>
                    {:else}
                      <div class="preview">{seg.preview}</div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </li>
          {/each}
          <!-- The library prompt is not a layer: it is chosen in the rail's
               dropdown, and a second control here would leave two
               disagreeing. Shown so the list is the whole prompt. -->
          {#each custom as seg (seg.name)}
            <li class="row static layer" class:open={open.has(seg.name)}>
              <button
                class="line unfold"
                title={open.has(seg.name) ? "Fold" : "Unfold to the full text"}
                onclick={() => toggle(seg.name)}
              >
                <span class="caret">{open.has(seg.name) ? "▾" : "▸"}</span>
                <span class="kind label">library prompt</span>
                <span class="size">{sizeLabel(seg.size)}</span>
                {#if seg.cache_anchor}
                  <span class="anchor" title="Cached prefix ends here">⚑</span>
                {/if}
              </button>
              {#if open.has(seg.name)}
                <pre class="text">{seg.text}</pre>
              {:else}
                <div class="preview">{seg.preview}</div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if agentEngine}
          <p class="empty caveat">{AGENT_CAVEAT}</p>
        {/if}
      {/if}
    </section>

    <section>
      <h3>Conversation</h3>
      {#if agentEngine}
        <!-- Said rather than left blank: on this engine the list above is
             what Nightloom appends, and the conversation is not ours to
             itemise — the CLI keeps it and assembles its own request. -->
        <p class="empty">
          Held by Claude Code. The CLI keeps this chat's history and builds
          its own request; the layers above are what Nightloom appends to
          its system prompt. The gauge in the bar is the usage the CLI
          reports after each turn.
        </p>
      {:else if items.length === 0}
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
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.64rem;
    cursor: pointer;
  }
  .link:hover,
  .link.on {
    color: var(--accent);
  }
  /* A row's head is a button so the whole line unfolds, not just a caret. */
  .unfold {
    background: transparent;
    border: none;
    padding: 0;
    width: 100%;
    color: inherit;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .caret {
    color: var(--dim);
    opacity: 0.6;
    font-size: 0.6rem;
    width: 0.6rem;
    flex-shrink: 0;
  }
  /* The full text, in a box that scrolls rather than a panel that grows:
     an AGENTS.md can be 32 KB and the panel has other rows to show. */
  .text {
    margin: 0.2rem 0 0.1rem;
    padding: 0.4rem 0.5rem;
    max-height: 18rem;
    overflow: auto;
    font-size: 0.66rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink2);
    background: var(--panel, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .sent {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .sent-bar {
    display: flex;
    justify-content: space-between;
    font-size: 0.64rem;
  }
  .sent-text {
    max-height: 26rem;
  }
  .switch {
    margin: 0;
    width: 0.8rem;
    height: 0.8rem;
    accent-color: var(--accent);
    flex-shrink: 0;
    cursor: pointer;
  }
  .switch:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .label {
    color: var(--ink2, inherit);
  }
  .state {
    color: var(--dim);
    opacity: 0.6;
    font-size: 0.62rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* The row of a layer switched off is struck through, not hidden: the
     blind test should be visible while it runs. */
  .layer.off .label {
    text-decoration: line-through;
    opacity: 0.55;
  }
  /* Each file of a multi-file layer (the AGENTS.md walk) is a sub-row. */
  .seg {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    padding-left: 1.15rem;
  }
  .caveat {
    margin-top: 0.4rem;
    line-height: 1.4;
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
