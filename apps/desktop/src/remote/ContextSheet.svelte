<script lang="ts" module>
  /*
   * The Context page on the phone (item 246, wave 2B; design §4 `context`,
   * `layers`; the Mac's page is `lib/ContextPanel.svelte`). One chat's
   * request as the Mac would send it now: the prompt layers, each with its
   * size, a switch and (for the four a person writes) this chat's own text;
   * any layer whose file changed under the chat (backlog 174's mark); and
   * the conversation's items with their sizes, each removable and
   * restorable. Everything is read from and changed on the Mac — the page
   * holds no copy but the last reply, and every change answers with the
   * view after it.
   *
   * The page talks to the Mac through `api`, three calls the page's client
   * carries (`client.ts`, 2C's; patch note `246w2-patch-p2b-to-p2c.md`).
   */
  import type { ChatKind, ChatMode, Size, WireBlock, WireSegment, WireView } from "../lib/types";

  /** The Mac's `PromptLayersInfo`, as passed through (`remote/api.rs`
   *  `ContextReply.layers`). `sources` is the files' own text per editable
   *  layer when the host sends it (patch note to 2A) — the seed for a
   *  chat's first own text. */
  export interface LayersInfo {
    off: string[];
    built?: string[];
    edits?: Record<string, string>;
    built_edits?: Record<string, string>;
    mode?: ChatMode;
    built_mode?: ChatMode;
    kind?: ChatKind;
    built_kind?: ChatKind;
    sources?: Record<string, string | null>;
  }

  export type LayerChoice = "auto" | "cold" | "keep";

  export interface PendingLayer {
    kind: string;
    held: string;
    newer: string;
    choice: LayerChoice;
  }

  export interface PendingView {
    session: string | null;
    layers: PendingLayer[];
  }

  export interface ContextReply {
    view: WireView;
    layers: LayersInfo | null;
    pending: PendingView | null;
  }

  /** `POST /api/chats/{id}/layers`'s three bodies (design §4). */
  export type LayerChange = { off: string[] } | { kind: string; text: string | null } | { kind: string; choice: LayerChoice };

  /** What the page needs of its client. `Client` carries these once 2C
   *  applies the patch note; the harness and tests pass their own. */
  export interface ContextApi {
    context(chat: string, project?: string | null): Promise<ContextReply>;
    editContext(chat: string, targets: number[], remove: boolean, project?: string | null): Promise<WireView>;
    layers(chat: string, change: LayerChange, project?: string | null): Promise<ContextReply>;
  }

  export type Engines = "both" | "provider" | "agent";

  export interface LayerCard {
    kind: string;
    label: string;
    gloss: string;
    engines: Engines;
    /** A person writes this layer's text, so a chat may have its own. */
    editable: boolean;
  }

  /** The Mac's catalogue, in ladder order (`ContextPanel.svelte` `LAYERS`),
   *  plus Claude Code's own memory, a switch only. */
  export const LAYERS: LayerCard[] = [
    { kind: "identity", label: "Identity", gloss: "Who the model is told it is and how to behave — Nightloom's built-in text.", engines: "provider", editable: false },
    { kind: "environment", label: "Environment", gloss: "Where it is running: folder, OS, shell, git repo and branch. Never the clock.", engines: "provider", editable: false },
    { kind: "user_memory", label: "Memory", gloss: "How you want the model to behave, everywhere — your ~/.nightloom/AGENTS.md.", engines: "both", editable: true },
    { kind: "model_instructions", label: "Model instructions", gloss: "How you want this one model to behave — its own file under ~/.nightloom/models.", engines: "both", editable: true },
    { kind: "chat_instructions", label: "Chat instructions", gloss: "How a Chat talks — ~/.nightloom/CHAT.md, read by chats of the Chat kind only.", engines: "both", editable: true },
    { kind: "project_instructions", label: "Project instructions", gloss: "The project's AGENTS.md — every one between the drive's root and the workspace, outermost first.", engines: "both", editable: true },
    { kind: "project_notes", label: "Notes index", gloss: "The project's shared notes, by name. The contents are read on demand.", engines: "both", editable: false },
    { kind: "knowledge", label: "Vault index", gloss: "Your knowledge vault, by folder. The contents are read on demand.", engines: "both", editable: false },
    { kind: "engine_note", label: "Engine note", gloss: "How the names above read on Claude Code: its Read, Write and Edit, and where @kb points.", engines: "agent", editable: false },
    { kind: "pacing", label: "Pacing", gloss: "This message's usage budget and the stop line. The figures come in the usage line beside tool calls.", engines: "agent", editable: false },
    { kind: "subagents", label: "Subagents", gloss: "When a subagent is worth launching, reusing and retiring one, the caches, briefing by a short spec.", engines: "agent", editable: false },
    { kind: "cli_memory", label: "Claude Code memory", gloss: "Claude Code's own MEMORY.md for this folder. The CLI reads it itself — a switch only here; read it on the Mac.", engines: "agent", editable: false },
  ];

  /**
   * The cards this engine gets. Engine unknown (an older host): the layers
   * both engines have, and any other the view or the switched-off set
   * names, so nothing present is hidden and nothing absent is guessed.
   */
  export function shownLayers(engine: string | null, view: WireView | null, off: string[]): LayerCard[] {
    if (engine) {
      const agent = engine === "claude-code";
      return LAYERS.filter((l) => l.engines === "both" || (l.engines === "agent") === agent);
    }
    const named = new Set([...(view?.system ?? []).map((s) => s.kind), ...off]);
    return LAYERS.filter((l) => l.engines === "both" || named.has(l.kind));
  }

  /** The switched-off set after flipping one layer. */
  export function offAfter(off: string[], kind: string, on: boolean): string[] {
    const rest = off.filter((k) => k !== kind);
    return on ? rest : [...rest, kind];
  }

  /** Tokens where an estimate is honest, bytes where it is not (an image),
   *  as the Mac's page says it. */
  export function sizeLabel(size: Size): string {
    if (size.tokens !== null) return `${size.tokens.toLocaleString("en-US")} tok`;
    const kb = size.bytes / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb)).toLocaleString("en-US")} KB`;
  }

  /** A layer's size is its segments' together — the AGENTS.md walk is one layer. */
  export function layerSize(segs: WireSegment[]): Size {
    const tokens = segs.every((s) => s.size.tokens !== null) ? segs.reduce((n, s) => n + (s.size.tokens ?? 0), 0) : null;
    return { tokens, bytes: segs.reduce((n, s) => n + s.size.bytes, 0) };
  }

  /** A segment's body without the one tag the prompt wraps it in
   *  (`<user-instructions>…</user-instructions>`). Only the fallback seed,
   *  when the host sends no `sources`. */
  export function unwrapSegment(text: string): string {
    const m = /^<([a-z-]+)(?:\s[^>]*)?>\n([\s\S]*)\n<\/\1>\s*$/.exec(text);
    return m ? m[2] : text;
  }

  /**
   * What the editor opens with when no draft is held, and where it came
   * from: the chat's own text; else the file's text as the Mac read it;
   * else — an older host — the text as sent, unwrapped.
   */
  export function layerSeed(kind: string, layers: LayersInfo | null, segs: WireSegment[]): { text: string; note: string } {
    const own = layers?.edits?.[kind];
    if (typeof own === "string") return { text: own, note: "This chat's own text. Save replaces it; the file is not touched." };
    const src = layers?.sources;
    if (src && kind in src) {
      return {
        text: src[kind] ?? "",
        note: src[kind] == null ? "There is no file for this layer yet. What you save is this chat's own text." : "From the file. What you save is this chat's own text; the file is not touched.",
      };
    }
    return {
      text: segs.map((s) => unwrapSegment(s.text)).join("\n\n"),
      note: "From the prompt as sent (this Mac does not send the file's text). What you save is this chat's own text.",
    };
  }

  /** The log indexes of every removed item, for "Restore all". */
  export function elidedTargets(view: WireView | null): number[] {
    const out = new Set<number>();
    for (const m of view?.messages ?? []) for (const b of m.blocks) if (b.elided && b.source.from === "event") out.add(b.source.index);
    return [...out];
  }

  export const KIND_LABEL: Record<string, string> = {
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

  /** Who an item is from, in words: a tool's result rides in a user
   *  message on the wire but is not his; the status block is Nightloom's. */
  export function whose(role: "user" | "assistant", b: WireBlock): string {
    if (b.kind === "tool_result") return "tool";
    if (b.kind === "sidecar" || b.source.from !== "event") return "Nightloom";
    return role === "user" ? "you" : "reply";
  }

  export const blockIndex =(b: WireBlock): number | null => (b.source.from === "event" ? b.source.index : null);

  /**
   * The mark on a layer whose file changed (backlog 174), in the Mac's
   * words (`promptVersions.ts` `markLine`), without the cache reading the
   * phone does not have: "auto" is taken to follow the Mac's default (on).
   */
  export function pendingLine(p: PendingLayer): string {
    if (p.choice === "keep") return "Keeping this chat's version — the file has a newer one.";
    const gone = p.newer === "" ? "The file is gone" : "Newer version exists";
    return `${gone}: taken at this chat's next cold moment (when its cache has expired).`;
  }

  /** The choices the mark offers (`choicesFor` with auto on). "Update
   *  now" is the Mac's alone: the API has no call for it. */
  export function pendingChoices(p: PendingLayer): { choice: LayerChoice; label: string }[] {
    return p.choice === "keep" ? [{ choice: "auto", label: "Update at the next cold moment" }] : [{ choice: "keep", label: "Keep this version" }];
  }

  /** A change is recorded but the Mac's engine still runs the old prompt. */
  export function reconnectDue(l: LayersInfo | null): boolean {
    if (!l || !l.built) return false;
    const a = new Set(l.off);
    const b = new Set(l.built);
    if (a.size !== b.size || [...a].some((k) => !b.has(k))) return true;
    return JSON.stringify(sortKeys(l.edits ?? {})) !== JSON.stringify(sortKeys(l.built_edits ?? {}));
  }

  function sortKeys(o: Record<string, string>): [string, string][] {
    return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  }
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { lineDiff } from "../lib/diff";
  import { Unreachable } from "./client";
  import { missingSentence } from "./hosts";
  import LayerEditor, { heldLayerDraft, heldLayerKinds } from "./LayerEditor.svelte";

  interface Props {
    api: ContextApi;
    chat: string;
    /** The chat's project when it is not the one open on the Mac. */
    project: string | null;
    title: string;
    /** `claude-code` or `provider`; null when the host does not say. */
    engine: string | null;
    /** A turn runs in this chat: the Mac refuses changes until it ends. */
    busy: boolean;
    /** The host serves `layers` (switches, own text, the mark's choices). */
    canLayers: boolean;
    /** `/api/state`'s `host`, for the sentence when a feature is missing. */
    host?: string | null;
    onclose: () => void;
  }
  let { api, chat, project, title, engine, busy, canLayers, host = undefined, onclose }: Props = $props();

  let reply = $state<ContextReply | null>(null);
  let loading = $state(true);
  let problem = $state<string | null>(null);
  let working = $state(false);
  /** Cards and items read open, by key. */
  let open = $state(new Set<string>());
  let diffs = $state(new Set<string>());
  let editing = $state<LayerCard | null>(null);
  let confirmRevert = $state<string | null>(null);
  /** Layers with a draft held on this phone, re-read when the editor closes. */
  let held = $state<string[]>([]);

  const view = $derived(reply?.view ?? null);
  const layers = $derived(reply?.layers ?? null);
  const off = $derived(layers?.off ?? []);
  const agent = $derived(engine === "claude-code");
  const cards = $derived(shownLayers(engine, view, off));
  const custom = $derived((view?.system ?? []).filter((s) => s.kind === "custom"));
  const pending = $derived(reply?.pending && reply.pending.session === chat ? reply.pending.layers : []);
  const items = $derived((view?.messages ?? []).flatMap((m) => m.blocks.map((b) => ({ role: m.role, block: b }))));
  const removed = $derived(elidedTargets(view));
  const due = $derived(reconnectDue(layers));
  const locked = $derived(working || busy);

  function say(e: unknown): string {
    if (e instanceof Unreachable) return "The Mac is unreachable — nothing was changed.";
    return e instanceof Error ? e.message : String(e);
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      reply = await api.context(chat, project);
      problem = null;
    } catch (e) {
      problem = say(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    held = heldLayerKinds(chat);
    void load().then(() => {
      // A draft left by a closed page or a reload reopens where it was
      // (as the Mac's page does), so the text is in front of him again.
      const first = held.map((k) => cards.find((c) => c.kind === k && c.editable)).find(Boolean);
      if (first && canLayers) editing = first;
    });
  });

  // A turn in this chat ended: the context changed under the page.
  let wasBusy = untrack(() => busy);
  $effect(() => {
    const now = busy;
    if (wasBusy && !now) void load();
    wasBusy = now;
  });

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  async function change(c: LayerChange): Promise<string | null> {
    working = true;
    try {
      reply = await api.layers(chat, c, project);
      problem = null;
      return null;
    } catch (e) {
      return say(e);
    } finally {
      working = false;
    }
  }

  async function flip(kind: string, on: boolean) {
    const err = await change({ off: offAfter(off, kind, on) });
    if (err) problem = err;
  }

  async function revert(kind: string) {
    confirmRevert = null;
    const err = await change({ kind, text: null });
    if (err) problem = err;
  }

  async function choose(kind: string, choice: LayerChoice) {
    const err = await change({ kind, choice });
    if (err) problem = err;
  }

  async function edit(targets: number[], remove: boolean) {
    working = true;
    try {
      const v = await api.editContext(chat, targets, remove, project);
      reply = reply ? { ...reply, view: v } : { view: v, layers: null, pending: null };
      problem = null;
    } catch (e) {
      problem = say(e);
    } finally {
      working = false;
    }
  }

  function closeEditor() {
    editing = null;
    held = heldLayerKinds(chat);
  }

  const segsOf = (kind: string) => (view?.system ?? []).filter((s) => s.kind === kind);
  const seedOf = (card: LayerCard) => {
    const s = layerSeed(card.kind, layers, segsOf(card.kind));
    // Offline with a draft held: the draft's own base stands in.
    if (!reply) {
      const d = heldLayerDraft(chat, card.kind);
      if (d) return { text: d.base, note: s.note };
    }
    return s;
  };

  const MODE_NOTE: Record<string, string> = {
    incognito: "Incognito: this chat writes nothing and other chats do not read it.",
    ephemeral: "Ephemeral: nothing is kept — no log, no name, no CLI session.",
  };
</script>

<div class="cx" role="dialog" aria-modal="true" aria-label="Context">
  <header class="cx-top">
    <button class="cx-btn" onclick={onclose}>Done</button>
    <div class="cx-title">
      <span class="cx-name">Context</span>
      <small>{title}</small>
    </div>
    <button class="cx-btn" onclick={load} disabled={loading} aria-label="Read again">{loading ? "…" : "Refresh"}</button>
  </header>

  <div class="cx-body">
    {#if problem}<p class="cx-bad" role="alert">{problem}</p>{/if}
    {#if busy}<p class="cx-note">A turn is running in this chat — the Mac takes changes once it ends.</p>{/if}

    {#if !view}
      <p class="cx-note">{loading ? "Reading the chat's context from the Mac…" : "Nothing to show."}</p>
    {:else}
      {@const t = view.totals}
      <div class="cx-total">
        <span class="cx-num">{t.unestimated > 0 ? "≥" : ""}{t.tokens.toLocaleString("en-US")}</span>
        {#if view.context_limit}
          <span class="cx-dim">/ {(view.context_limit / 1000).toFixed(0)}k · {Math.round((t.tokens / view.context_limit) * 100)}%</span>
        {:else}
          <span class="cx-dim">{agent ? "tokens Nightloom appends" : "tokens"}</span>
        {/if}
        <span class="cx-est">estimated</span>
      </div>
      {#if view.context_limit}
        <div class="cx-bar"><div class="cx-fill" style="width: {Math.min(100, (t.tokens / view.context_limit) * 100)}%"></div></div>
      {/if}
      {#if layers?.mode && MODE_NOTE[layers.mode]}<p class="cx-note">{MODE_NOTE[layers.mode]}</p>{/if}
      {#if due}<p class="cx-note accent">Changed — the Mac applies it with this chat's next message.</p>{/if}
      {#if !canLayers}<p class="cx-note">{missingSentence(host, "This Mac's Nightloom is older than the phone page: the layers can be read here, not changed.")}</p>{/if}

      <h3 class="cx-h">Prompt layers</h3>
      <div class="cx-cards">
        {#each cards as card (card.kind)}
          {@const segs = segsOf(card.kind)}
          {@const isOff = off.includes(card.kind)}
          {@const own = typeof layers?.edits?.[card.kind] === "string"}
          {@const mark = pending.find((p) => p.kind === card.kind)}
          {@const isOpen = open.has(card.kind)}
          <div class="cx-card" class:off={isOff}>
            <div class="cx-row">
              <div class="cx-grow">
                <div class="cx-label">
                  <span class="cx-lname">{card.label}</span>
                  {#if own}<span class="cx-tag">this chat's text</span>{/if}
                  {#if held.includes(card.kind)}<span class="cx-tag accent">draft kept</span>{/if}
                </div>
                <small class="cx-gloss">{card.gloss}</small>
                <small class="cx-meta">
                  {#if isOff}off for this chat{:else if card.kind === "cli_memory"}read by Claude Code{:else if segs.length === 0}nothing to send{:else}{sizeLabel(layerSize(segs))}{/if}
                </small>
              </div>
              <button
                class="cx-switch"
                role="switch"
                aria-checked={!isOff}
                aria-label={`${card.label} for this chat`}
                disabled={locked || !canLayers}
                onclick={() => flip(card.kind, isOff)}
              ><span class="cx-knob" class:on={!isOff}></span></button>
            </div>
            {#if !isOff && (segs.length > 0 || (card.editable && canLayers))}
              <div class="cx-acts">
                {#if segs.length > 0}
                  <button class="cx-chip" data-read={card.kind} aria-expanded={isOpen} onclick={() => (open = toggle(open, card.kind))}>{isOpen ? "Hide" : "Read"}</button>
                {/if}
                {#if card.editable && canLayers}
                  <button class="cx-chip" data-edit={card.kind} onclick={() => (editing = card)}>{held.includes(card.kind) ? "Resume editing" : "Edit for this chat"}</button>
                  {#if own}
                    <button class="cx-chip" data-revert={card.kind} disabled={locked} onclick={() => (confirmRevert = card.kind)}>Revert to the file</button>
                  {/if}
                {/if}
              </div>
            {/if}
            {#if confirmRevert === card.kind}
              <div class="cx-confirm">
                <span class="cx-grow">Drop this chat's own text and read the file again?</span>
                <button class="cx-chip" onclick={() => (confirmRevert = null)}>Keep</button>
                <button class="cx-chip danger" disabled={locked} onclick={() => revert(card.kind)}>Revert</button>
              </div>
            {/if}
            {#if mark}
              <div class="cx-mark" class:kept={mark.choice === "keep"}>
                <span>{pendingLine(mark)}</span>
                <div class="cx-acts">
                  <button class="cx-chip" data-diff={card.kind} aria-expanded={diffs.has(card.kind)} onclick={() => (diffs = toggle(diffs, card.kind))}>{diffs.has(card.kind) ? "Hide changes" : "Show changes"}</button>
                  {#each pendingChoices(mark) as c (c.choice)}
                    <button class="cx-chip" disabled={locked || !canLayers} onclick={() => choose(card.kind, c.choice)}>{c.label}</button>
                  {/each}
                </div>
                {#if diffs.has(card.kind)}
                  <pre class="cx-diff" aria-label="What changed in the file">{#each lineDiff(mark.held, mark.newer) as l, i (i)}<span class={l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}{l.text}
</span>{/each}</pre>
                {/if}
              </div>
            {/if}
            {#if isOpen && !isOff}
              <pre class="cx-text">{segs.map((s) => s.text).join("\n\n")}</pre>
            {/if}
          </div>
        {/each}
        {#each custom as seg (seg.name)}
          <div class="cx-card">
            <div class="cx-row">
              <div class="cx-grow">
                <div class="cx-label"><span class="cx-lname">Library prompt</span></div>
                <small class="cx-gloss">{seg.name} — chosen on the Mac.</small>
                <small class="cx-meta">{sizeLabel(seg.size)}</small>
              </div>
            </div>
            <div class="cx-acts">
              <button class="cx-chip" aria-expanded={open.has(seg.name)} onclick={() => (open = toggle(open, seg.name))}>{open.has(seg.name) ? "Hide" : "Read"}</button>
            </div>
            {#if open.has(seg.name)}<pre class="cx-text">{seg.text}</pre>{/if}
          </div>
        {/each}
      </div>
      {#if agent}
        <p class="cx-note small">On Claude Code a change here reaches a new chat at once; a resumed chat keeps the prompt the CLI recorded until its next compaction.</p>
      {/if}

      <div class="cx-hrow">
        <h3 class="cx-h">Conversation</h3>
        {#if removed.length > 0 && !agent}
          <button class="cx-chip" disabled={locked} onclick={() => edit(removed, false)}>Restore {removed.length} removed</button>
        {/if}
      </div>
      {#if agent}
        <p class="cx-note">Held by Claude Code. The CLI keeps this chat's history and builds its own request; the layers above are what Nightloom appends to its system prompt.</p>
      {:else if items.length === 0}
        <p class="cx-note">Nothing yet.</p>
      {:else}
        <p class="cx-note small">Removing an item takes it off the next request. Nothing is deleted — the log keeps it and the transcript still shows it.</p>
        <ul class="cx-items">
          {#each items as item, i (i)}
            {@const b = item.block}
            {@const idx = blockIndex(b)}
            {@const key = `item-${i}`}
            <li class="cx-item" class:elided={b.elided}>
              <button class="cx-itext" aria-expanded={open.has(key)} onclick={() => (open = toggle(open, key))}>
                <span class="cx-iline">
                  <span class="cx-size">{sizeLabel(b.size)}</span>
                  <span class="cx-kind">{KIND_LABEL[b.kind] ?? b.kind}</span>
                  <span class="cx-role">{whose(item.role, b)}{b.elided ? " · removed" : ""}</span>
                </span>
                <span class="cx-prev" class:full={open.has(key)}>{b.preview}{b.truncated ? "…" : ""}</span>
              </button>
              {#if b.elidable && idx !== null}
                <button
                  class="cx-rm"
                  disabled={locked}
                  aria-label={b.elided ? "Restore to the context" : "Remove from the context"}
                  onclick={() => edit([idx], !b.elided)}
                >{b.elided ? "↺" : "✕"}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</div>

{#if editing}
  {@const seed = seedOf(editing)}
  {@const card = editing}
  <LayerEditor
    {chat}
    kind={card.kind}
    label={card.label}
    seed={seed.text}
    seedNote={seed.note}
    {busy}
    onsave={(text) => change({ kind: card.kind, text })}
    onclose={closeEditor}
  />
{/if}

<style>
  .cx {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top, 0px) 0 0;
  }
  .cx-top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    flex: none;
  }
  .cx-title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: center;
    line-height: 1.25;
  }
  .cx-name {
    font-weight: 600;
    font-size: 16px;
  }
  .cx-title small {
    font-size: 12px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cx-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 12px 16px calc(24px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cx-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    min-width: 56px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    color: var(--accent-ink);
    box-sizing: border-box;
    flex: none;
  }
  .cx-btn:disabled {
    opacity: 0.5;
  }
  .cx-note,
  .cx-bad {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
  }
  .cx-note.small {
    font-size: 12px;
  }
  .cx-note.accent {
    color: var(--accent-ink);
  }
  .cx-bad {
    color: var(--failed);
  }
  .cx-total {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .cx-num {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .cx-dim,
  .cx-est {
    font-size: 13px;
    color: var(--dim);
  }
  .cx-est {
    margin-left: auto;
    font-style: italic;
  }
  .cx-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--well);
    overflow: hidden;
  }
  .cx-fill {
    height: 100%;
    background: var(--accent);
  }
  .cx-h {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dim);
    margin: 10px 0 0;
  }
  .cx-hrow {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
  }
  .cx-cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cx-card {
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .cx-card.off .cx-lname {
    text-decoration: line-through;
    color: var(--dim);
  }
  .cx-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cx-grow {
    flex: 1;
    min-width: 0;
  }
  .cx-label {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cx-lname {
    font-weight: 600;
    font-size: 15px;
  }
  .cx-tag {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 8px;
    border: 1px solid var(--line2);
    color: var(--ink2);
  }
  .cx-tag.accent {
    border-color: var(--accent);
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
  .cx-gloss,
  .cx-meta {
    display: block;
    font-size: 12px;
    color: var(--dim);
    line-height: 1.4;
  }
  .cx-meta {
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
  }
  .cx-switch {
    all: unset;
    cursor: pointer;
    padding: 8px 0 8px 4px;
    flex: none;
  }
  .cx-switch:disabled {
    opacity: 0.45;
  }
  .cx-knob {
    display: block;
    width: 46px;
    height: 28px;
    border-radius: 14px;
    background: var(--line2);
    position: relative;
    transition: background 0.2s;
  }
  .cx-knob::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--sheet);
    transition: transform 0.2s;
  }
  .cx-knob.on {
    background: var(--accent);
  }
  .cx-knob.on::after {
    transform: translateX(18px);
  }
  .cx-acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cx-chip {
    all: unset;
    cursor: pointer;
    min-height: 36px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    border-radius: 18px;
    border: 1px solid var(--line2);
    font-size: 14px;
    box-sizing: border-box;
  }
  .cx-chip:disabled {
    opacity: 0.4;
  }
  .cx-chip.danger {
    color: var(--failed);
    border-color: var(--failed);
  }
  .cx-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .cx-mark {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    font-size: 13px;
  }
  .cx-mark.kept {
    border-color: var(--line);
    background: transparent;
    color: var(--dim);
  }
  .cx-text,
  .cx-diff {
    margin: 0;
    padding: 10px;
    background: var(--paper);
    border-radius: 10px;
    font: 12.5px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 60dvh;
    overflow-y: auto;
  }
  .cx-diff .add {
    color: var(--done);
  }
  .cx-diff .del {
    color: var(--failed);
  }
  .cx-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
  }
  .cx-item {
    display: flex;
    align-items: stretch;
    min-width: 0;
  }
  .cx-item + .cx-item {
    border-top: 1px solid var(--line);
  }
  .cx-item.elided .cx-itext {
    opacity: 0.5;
  }
  .cx-item.elided .cx-prev {
    text-decoration: line-through;
  }
  .cx-itext {
    all: unset;
    cursor: pointer;
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cx-iline {
    display: flex;
    gap: 8px;
    font-size: 12px;
    color: var(--dim);
  }
  .cx-size {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
    font-weight: 600;
    min-width: 62px;
  }
  .cx-prev {
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
  .cx-prev.full {
    display: block;
    white-space: pre-wrap;
  }
  .cx-rm {
    all: unset;
    cursor: pointer;
    width: 48px;
    flex: none;
    display: grid;
    place-items: center;
    font-size: 17px;
    color: var(--ink2);
    border-left: 1px solid var(--line);
  }
  .cx-rm:disabled {
    opacity: 0.35;
  }
</style>
