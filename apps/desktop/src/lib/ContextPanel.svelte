<script lang="ts">
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import {
    app,
    addToast,
    promoteLayerText,
    promptLayerEdits,
    promptLayersOff,
    setPromptLayer,
    setPromptLayerText,
  } from "./state.svelte";
  import { EDITABLE_LAYERS } from "./types";
  import type {
    BlockKind,
    EditableLayer,
    PromptLayer,
    Size,
    WireBlock,
    WireSegment,
    WireView,
  } from "./types";

  /*
   * The Context page: what the next request carries, as a centre modal the
   * way Settings is (nightshift backlog 056, 2026-09-15). It was a 340 px
   * popover under the gauge chip; a 32 KB AGENTS.md at reading size in a
   * column that narrow is a wall of eleven-word lines, and the fold arrows
   * and the "Show as sent" toggle read as labels. So: one card per layer
   * with a switch, a name, a gloss, a size and a Read button; the text opens
   * in place at the transcript's face and size; Layers · As sent is a
   * segmented control in the head. The conversation and the gauge come
   * second, in one hierarchy of sizes.
   */

  let view = $state<WireView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let working = $state(false);

  // Which layers are open to their full text, by kind. Per-kind rather than
  // a single open card: comparing two layers side by side is the reason to
  // open one at all. The library prompt has no kind of its own in the
  // catalogue and is keyed by its name.
  let open = $state<Set<string>>(new Set());
  let mode = $state<"layers" | "sent">("layers");
  let copied = $state<string | null>(null);

  function toggle(key: string): void {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    open = next;
  }

  async function copy(key: string, text: string | null | undefined): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = null;
      }, 1200);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }

  function close(): void {
    app.showContext = false;
  }

  // The CLI holds the conversation on this engine, so the view is the
  // preamble alone and the conversation section says so instead of listing
  // nothing.
  const agentEngine = $derived(app.connection?.engine === "claude-code");

  /**
   * The layers a chat can switch off, in ladder order, with the card each
   * one gets. A fixed catalogue rather than the segments that happen to be
   * present, because an absent layer needs a card too: the one switched off
   * (struck through, so the blind test is visible while it runs) and the
   * one with nothing to send (no AGENTS.md on the walk), which are
   * different states and must not look alike. `engines` says where a layer
   * exists at all — identity and environment are Claude Code's own on that
   * engine, and the engine note exists nowhere else. The gloss is the one
   * line under the name: what the layer is, in his words where he gave
   * them ("how you want the model to behave, everywhere").
   */
  const LAYERS: {
    kind: PromptLayer;
    label: string;
    gloss: string;
    engines: "both" | "provider" | "agent";
  }[] = [
    {
      kind: "identity",
      label: "Identity",
      gloss: "Who the model is told it is and how to behave — Nightloom's built-in text.",
      engines: "provider",
    },
    {
      kind: "environment",
      label: "Environment",
      gloss: "Where it is running: folder, OS, shell, git repo and branch. Never the clock.",
      engines: "provider",
    },
    {
      kind: "user_memory",
      label: "Memory",
      gloss: "How you want the model to behave, everywhere — your ~/.nightloom/AGENTS.md.",
      engines: "both",
    },
    {
      kind: "model_instructions",
      label: "Model instructions",
      gloss: "How you want this one model to behave — its own file under ~/.nightloom/models.",
      engines: "both",
    },
    {
      kind: "project_instructions",
      label: "Project instructions",
      gloss: "The project's AGENTS.md — every one between the drive's root and the workspace, outermost first.",
      engines: "both",
    },
    {
      kind: "project_notes",
      label: "Notes index",
      gloss: "The project's shared notes, by name. The contents are read on demand.",
      engines: "both",
    },
    {
      kind: "knowledge",
      label: "Vault index",
      gloss: "Your knowledge vault, by folder. The contents are read on demand.",
      engines: "both",
    },
    {
      kind: "engine_note",
      label: "Engine note",
      gloss: "How the names above read on Claude Code: its Read, Write and Edit, and where @kb points.",
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

  /** Whether the layer has a card on this engine, and whether it can be switched. */
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

  /*
   * A chat's own text for a layer (nightshift backlog 057). The three
   * editable cards carry *Edit for this chat*: the body opens as a textarea
   * at reading size, seeded from the chat's text if it has one and from the
   * file otherwise (`promptLayerFile` — what the prompt reads, not a
   * re-parse of the segment); Save records it in the log and reconnects,
   * the way a switch does. An edited card says so in words, *as sent*
   * carries the wrapped text, *Revert to the file* drops it, and *Make
   * this the file* opens the store editor with it as a draft — never a
   * silent write.
   */
  const edits = $derived(promptLayerEdits(app.events));
  let editing = $state<EditableLayer | null>(null);
  let draft = $state("");
  let seeding = $state(false);
  let saving = $state(false);

  function editable(kind: PromptLayer): kind is EditableLayer {
    return (EDITABLE_LAYERS as readonly string[]).includes(kind);
  }

  async function beginEdit(layer: EditableLayer): Promise<void> {
    seeding = true;
    try {
      const own = edits[layer];
      draft = own ?? ((await api.promptLayerFile(layer)) ?? "");
    } catch (e) {
      addToast(String(e));
      draft = edits[layer] ?? "";
    } finally {
      seeding = false;
    }
    editing = layer;
    if (!open.has(layer)) toggle(layer);
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    saving = true;
    try {
      if (await setPromptLayerText(editing, draft)) editing = null;
    } finally {
      saving = false;
    }
  }

  function cancelEdit(): void {
    editing = null;
  }

  async function revert(layer: EditableLayer): Promise<void> {
    saving = true;
    try {
      if (await setPromptLayerText(layer, null)) {
        if (editing === layer) editing = null;
      }
    } finally {
      saving = false;
    }
  }

  function promote(layer: EditableLayer): void {
    const text = edits[layer];
    if (text) promoteLayerText(layer, text);
  }

  // Off at the rail is off for every chat, and the per-chat switches have
  // nothing left to remove; said once above the cards rather than as eight
  // greyed cards.
  const railOff = $derived(!app.draft.preamble);
  const AGENT_CAVEAT =
    "On Claude Code a change here reaches a new chat at once; a resumed chat keeps the prompt the CLI recorded until its next compaction (CLI 2.1.265 or later).";

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

  /** Every live block, flattened — the section is a size ranking, not a chat. */
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

  /** A layer's size is its segments' together — the walk is one layer. */
  function layerSize(segs: WireSegment[]): string {
    if (segs.length === 1) return sizeLabel(segs[0].size);
    const tokens = segs.every((s) => s.size.tokens !== null)
      ? segs.reduce((n, s) => n + (s.size.tokens ?? 0), 0)
      : null;
    const bytes = segs.reduce((n, s) => n + s.size.bytes, 0);
    return sizeLabel({ tokens, bytes });
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

  // The caveats are real but they are footnotes, not the page: estimation
  // and the cost of removing both live on the controls they qualify.
  const TOTAL_NOTE =
    "Estimated, not measured — there is no tokenizer here, so these rank items by size rather than predict a bill.";
  const EDIT_NOTE =
    "Removing an item takes its content off the next request. Nothing is deleted — the session log keeps it, the transcript still shows it, and no cost is refunded.";
</script>

<div class="modal" role="dialog" aria-label="Context">
  <div class="pane-head">
    <h2 class="pane-title">Context</h2>
    <span class="slug">what the next request carries</span>
    <span class="spacer"></span>
    {#if view}
      <div class="seg" role="tablist" aria-label="Show the system prompt as">
        <button
          role="tab"
          class:on={mode === "layers"}
          aria-selected={mode === "layers"}
          onclick={() => (mode = "layers")}
        >
          Layers
        </button>
        <button
          role="tab"
          class:on={mode === "sent"}
          aria-selected={mode === "sent"}
          disabled={!view.system_text}
          title="The whole system prompt as one string, exactly as the backend renders it for the request"
          onclick={() => (mode = "sent")}
        >
          As sent
        </button>
      </div>
    {/if}
    <button class="close" title="Close" aria-label="Close context" onclick={close}><Icon name="x" size={14} /></button>
  </div>

  <div class="pane">
    {#if !app.connection}
      <p class="note">Not connected.</p>
    {:else if error}
      <p class="note err">{error}</p>
    {:else if !view}
      <p class="note">{loading ? "Reading…" : "Nothing yet."}</p>
    {:else if mode === "sent"}
      {@const text = view.system_text ?? ""}
      <section class="card">
        <div class="ch">
          <span class="t">As sent</span>
          <span class="gloss">One string, joined the way the adapters join it — not a re-join done here.</span>
          <span class="spacer"></span>
          <span class="meta">{text.length.toLocaleString()} characters</span>
          <button class="ns-btn small" onclick={() => copy("sent", text)}>
            {copied === "sent" ? "Copied" : "Copy"}
          </button>
        </div>
        <pre class="reader tall">{text}</pre>
      </section>
    {:else}
      {#if railOff}
        <p class="note">
          The model popover's Preamble switch is off, so none of the layers
          below is sent to any chat; only the library prompt goes.
        </p>
      {/if}
      <div class="cards">
        {#each LAYERS.filter((l) => shown(l.engines)) as layer (layer.kind)}
          {@const isOff = off.includes(layer.kind)}
          {@const segs = segmentsOf(layer.kind)}
          {@const isOpen = open.has(layer.kind)}
          {@const canEdit = editable(layer.kind)}
          {@const isEdited = canEdit && edits[layer.kind as EditableLayer] !== undefined}
          {@const isEditing = canEdit && editing === layer.kind}
          {@const canRead = !isOff && (segs.length > 0 || isEditing)}
          {@const locked = saving || seeding || app.busy || app.connecting}
          <section class="card layer" class:off={isOff} class:edited={isEdited && !isOff}>
            <div class="ch">
              <input
                type="checkbox"
                class="sw"
                checked={!isOff}
                disabled={switching || railOff || app.busy || app.connecting}
                aria-label={`${layer.label} for this chat`}
                title={isOff
                  ? "Off for this chat — switch on to send it again"
                  : "On — switch off to keep it from this chat"}
                onchange={(e) => void flip(layer.kind, (e.currentTarget as HTMLInputElement).checked)}
              />
              <div class="name">
                <span class="t">{layer.label}</span>
                {#if isOff}
                  <span class="state off-state">off for this chat</span>
                {:else if isEdited}
                  <span class="state edited-state">edited for this chat</span>
                {:else if segs.length === 0}
                  <span class="state">nothing to send</span>
                {/if}
                <span class="gloss">{layer.gloss}</span>
              </div>
              <span class="spacer"></span>
              {#if canEdit && !isOff && !isEditing}
                <button
                  class="ns-btn ghost small"
                  disabled={locked || railOff}
                  title={isEdited
                    ? "Change this chat's own text for the layer"
                    : "Give this chat its own text for this layer — the file is untouched"}
                  onclick={() => void beginEdit(layer.kind as EditableLayer)}
                >
                  <Icon name="pencil" size={12} />
                  {isEdited ? "Edit" : "Edit for this chat"}
                </button>
              {/if}
              {#if canRead && segs.length > 0}
                <span class="meta">{layerSize(segs)}</span>
                {#if segs.some((s) => s.cache_anchor)}
                  <span class="anchor" title="Cached prefix ends here">⚑</span>
                {/if}
              {/if}
              {#if canRead && !isEditing}
                <button
                  class="ns-btn small read"
                  class:on={isOpen}
                  aria-expanded={isOpen}
                  onclick={() => toggle(layer.kind)}
                >
                  {isOpen ? "Close" : "Read"}
                  <span class="chev" class:up={isOpen}><Icon name="chev" size={12} /></span>
                </button>
              {/if}
            </div>
            {#if isEdited && !isOff && !isEditing}
              <!-- The override's two ways out, said in words: back to the
                   file, or into the file as a draft the editor shows. -->
              <div class="actions">
                <button
                  class="ns-btn ghost small"
                  disabled={locked}
                  title="Drop this chat's text; the layer reads the file again"
                  onclick={() => void revert(layer.kind as EditableLayer)}
                >
                  <Icon name="revert" size={12} />
                  Revert to the file
                </button>
                <button
                  class="ns-btn ghost small"
                  disabled={locked}
                  title="Open the file's editor with this text as a draft — nothing is written until you save there"
                  onclick={() => promote(layer.kind as EditableLayer)}
                >
                  <Icon name="ext" size={12} />
                  Make this the file
                </button>
              </div>
            {/if}
            {#if isEditing}
              <div class="body">
                <textarea
                  class="reader editor"
                  aria-label={`${layer.label}, this chat's own text`}
                  placeholder="Empty means no text of this chat's own — the layer reads the file."
                  bind:value={draft}
                  disabled={locked}
                ></textarea>
                <div class="body-bar">
                  <span class="gloss">
                    This chat only. The file is untouched, and every other chat still reads it.
                  </span>
                  <span class="spacer"></span>
                  <button class="ns-btn small" disabled={locked} onclick={cancelEdit}>Cancel</button>
                  <button class="ns-btn accent small" disabled={locked} onclick={() => void saveEdit()}>
                    Save for this chat
                  </button>
                </div>
              </div>
            {:else if canRead && isOpen}
              {#each segs as seg (seg.name)}
                <div class="body">
                  <div class="body-bar">
                    {#if segs.length > 1}
                      <span class="file" title={seg.name}>{seg.name}</span>
                      <span class="meta">{sizeLabel(seg.size)}</span>
                    {:else}
                      <span class="file" title={seg.name}>{seg.name}</span>
                    {/if}
                    <span class="spacer"></span>
                    <button class="ns-btn ghost small" onclick={() => copy(seg.name, seg.text)}>
                      {copied === seg.name ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre class="reader">{seg.text}</pre>
                </div>
              {/each}
            {/if}
          </section>
        {/each}

        <!-- The library prompt is not a layer: it is chosen in the model
             popover's dropdown, and a second control here would leave two
             disagreeing. Shown so the list is the whole prompt. -->
        {#each custom as seg (seg.name)}
          {@const isOpen = open.has(seg.name)}
          <section class="card layer">
            <div class="ch">
              <span class="sw-space"></span>
              <div class="name">
                <span class="t">Library prompt</span>
                <span class="gloss">The system prompt picked in the model popover — chosen there, so no switch here.</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{sizeLabel(seg.size)}</span>
              {#if seg.cache_anchor}
                <span class="anchor" title="Cached prefix ends here">⚑</span>
              {/if}
              <button
                class="ns-btn small read"
                class:on={isOpen}
                aria-expanded={isOpen}
                onclick={() => toggle(seg.name)}
              >
                {isOpen ? "Close" : "Read"}
                <span class="chev" class:up={isOpen}><Icon name="chev" size={12} /></span>
              </button>
            </div>
            {#if isOpen}
              <div class="body">
                <div class="body-bar">
                  <span class="spacer"></span>
                  <button class="ns-btn ghost small" onclick={() => copy(seg.name, seg.text)}>
                    {copied === seg.name ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre class="reader">{seg.text}</pre>
              </div>
            {/if}
          </section>
        {/each}
      </div>
      {#if agentEngine}
        <p class="note small caveat">{AGENT_CAVEAT}</p>
      {/if}

      {@const t = view.totals}
      {@const floor = t.unestimated > 0 ? "≥" : ""}
      <section class="conv">
        <div class="conv-head">
          <h3>Conversation</h3>
          <span class="spacer"></span>
          {#if elided.length > 0}
            <button
              class="ns-btn ghost small"
              disabled={working}
              title={EDIT_NOTE}
              onclick={() => edit(elided, false)}
            >
              Restore {elided.length} removed
            </button>
          {/if}
          <span
            class="total"
            title={t.unestimated > 0
              ? `${TOTAL_NOTE}\n\n${t.unestimated} item${t.unestimated === 1 ? "" : "s"} (images) cannot be estimated at all, so the total is a floor.`
              : TOTAL_NOTE}
          >
            <span class="num">{floor}{t.tokens.toLocaleString()}</span>
            {#if view.context_limit}
              <span class="dim"
                >/ {(view.context_limit / 1000).toFixed(0)}k · {Math.round(
                  (t.tokens / view.context_limit) * 100,
                )}%</span
              >
            {:else}
              <!-- On Claude Code the total is the preamble alone — the part
                   of the request that is ours — never the CLI's whole
                   context. -->
              <span class="dim">{agentEngine ? "tokens appended" : "tokens"}</span>
            {/if}
            <span class="est">est.</span>
          </span>
        </div>
        {#if view.context_limit}
          <div class="bar">
            <div
              class="fill"
              style="width: {Math.min(100, (t.tokens / view.context_limit) * 100)}%"
            ></div>
          </div>
        {/if}
        {#if agentEngine}
          <!-- Said rather than left blank: on this engine the cards above
               are what Nightloom appends, and the conversation is not ours
               to itemise — the CLI keeps it and assembles its own request. -->
          <p class="note small">
            Held by Claude Code. The CLI keeps this chat's history and builds
            its own request; the layers above are what Nightloom appends to
            its system prompt. The gauge in the bar is the usage the CLI
            reports after each turn.
          </p>
        {:else if items.length === 0}
          <p class="note small">Nothing yet.</p>
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
</div>

<style>
  /* The frame is Settings' frame, one pane wide: same tokens, same radius,
     same clamp off the window, so the two read as the same app. */
  .modal {
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    width: clamp(34rem, 62vw, 56rem);
    max-width: calc(100vw - 3rem);
    height: clamp(24rem, 84vh, 56rem);
    max-height: calc(100vh - 3rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
    padding: 20px 24px 12px;
  }
  .pane-title {
    margin: 0;
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .slug {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
  }
  .spacer {
    flex: 1;
  }
  .close {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .close:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px;
    background: var(--well);
    flex: none;
  }
  .seg button {
    padding: 5px 14px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 13.5px;
    font-weight: 500;
    font-family: var(--sans);
    cursor: pointer;
  }
  .seg button:hover:not(:disabled) {
    color: var(--ink);
  }
  .seg button.on {
    background: var(--accent);
    color: var(--paper);
  }
  .seg button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pane {
    padding: 4px 24px 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    flex: 1;
  }
  .note {
    color: var(--dim);
    font-size: 13px;
    margin: 0;
    line-height: 1.45;
  }
  .note.small {
    font-size: 12px;
  }
  .err {
    color: var(--error);
  }
  .caveat {
    margin-top: -4px;
  }

  /* Cards, the Settings idiom. */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: none;
  }
  .ch {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .name {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .t {
    font-size: 13.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--ink);
  }
  .gloss {
    font-size: 12.5px;
    color: var(--dim);
    line-height: 1.35;
  }
  .meta {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .state {
    font-size: 12px;
    color: var(--dim);
    margin-left: 8px;
  }
  /* The name of a layer switched off is struck through and the state is
     said in words beside it: the blind test should be visible while it
     runs, and a strike-through alone reads as a typo. */
  .layer.off .t {
    text-decoration: line-through;
    opacity: 0.55;
  }
  .layer.off .gloss {
    opacity: 0.55;
  }
  .off-state,
  .edited-state {
    color: var(--accent-ink);
  }
  .layer.edited {
    border-color: var(--accent-soft);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .anchor {
    color: var(--accent);
    font-size: 12px;
  }
  .read {
    gap: 4px;
  }
  .read.on {
    border-color: var(--dim);
  }
  .chev {
    display: inline-flex;
    transition: transform 0.15s ease;
  }
  .chev.up {
    transform: rotate(180deg);
  }

  /* The rail's switch, so it is unmistakably a switch. */
  .sw,
  .sw-space {
    width: 26px;
    height: 15px;
    flex-shrink: 0;
  }
  .sw {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    border-radius: 999px;
    background: var(--line2);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--dim);
    transition:
      transform 0.15s ease,
      background 0.15s ease;
  }
  .sw:checked {
    background: var(--accent);
  }
  .sw:checked::after {
    transform: translateX(11px);
    background: var(--paper);
  }
  .sw:disabled {
    cursor: default;
    opacity: 0.4;
  }

  /* The open text: a box that scrolls rather than a card that grows — an
     AGENTS.md can be 32 KB and the page has other cards to show. Set in
     the transcript's face and size, since this is text to be read, not
     chrome. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .body-bar {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .file {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .reader {
    margin: 0;
    padding: 12px 14px;
    max-height: 22rem;
    overflow: auto;
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .reader.tall {
    max-height: none;
  }
  /* The same box, writable: reading size, since the text is read back in
     that size, and a comfortable minimum so a file that fits in five lines
     does not open as a slot. */
  .editor {
    min-height: 12rem;
    max-height: 26rem;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
    outline: none;
  }
  .editor:focus {
    border-color: var(--accent);
  }

  /* The conversation: second, under the cards, with the gauge in its
     heading. */
  .conv {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--line);
  }
  .conv-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .total {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  .num {
    font-size: 14px;
    color: var(--ink);
  }
  .dim {
    color: var(--dim);
  }
  .est {
    color: var(--dim);
    opacity: 0.7;
    font-size: 11px;
  }
  .bar {
    height: 3px;
    background: var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* One line per block plus a hairline bar: the section is a size ranking,
     and a ranking is read by scanning down a column, not by reading
     previews. */
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
  }
  .size {
    font-family: var(--mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    min-width: 5rem;
    text-align: right;
    flex-shrink: 0;
    color: var(--ink2);
  }
  .kind {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .role {
    color: var(--dim);
    opacity: 0.6;
    font-size: 11.5px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .act {
    background: transparent;
    border: none;
    color: var(--dim);
    opacity: 0.6;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1;
    padding: 0 2px;
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
    font-size: 12px;
    color: var(--dim);
    opacity: 0.7;
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
</style>
