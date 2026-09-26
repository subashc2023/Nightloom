<script lang="ts">
  import { tip } from "./tip";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import LayerVersionMark from "./LayerVersionMark.svelte";
  import { pendingFor } from "./promptVersions";
  import { fmtTokens } from "./tokens";
  import {
    app,
    addToast,
    chatKind,
    chatMode,
    declaredKind,
    promoteLayerText,
    promptLayerEdits,
    promptLayersOff,
    editContextItems,
    setPromptLayer,
    setPromptLayerText,
    subagentsOfTurn,
  } from "./state.svelte";
  import { EDITABLE_LAYERS } from "./types";
  import { reconsider, setThreshold, threshold } from "./handoff.svelte";
  import { setPromptSuggestions, suggestions } from "./suggestions.svelte";
  import { applyDraft, refreshLayerVersions } from "./state.svelte";
  import { onMount } from "svelte";
  import type {
    BlockKind,
    CliMemoryFile,
    CliPromptSnapshot,
    EditableLayer,
    PromptLayer,
    Size,
    WireBlock,
    WireSegment,
    WireView,
  } from "./types";

  // A memory or instructions file edited outside the app since the last
  // connect has no *newer version exists* mark until something reconnects
  // (backlog 174; night batch F, 2026-09-26): opening the page does, once.
  // `onMount`, not an effect — the reconnect moves `app.connection`, which
  // an effect would read and re-run on, forever.
  onMount(() => {
    void refreshLayerVersions();
  });

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
  let waitingOnTurn = $state(false);
  let error = $state<string | null>(null);
  let working = $state(false);

  // Which layers are open to their full text, by kind. Per-kind rather than
  // a single open card: comparing two layers side by side is the reason to
  // open one at all. The library prompt has no kind of its own in the
  // catalogue and is keyed by its name.
  let open = $state<Set<string>>(new Set());
  let mode = $state<"layers" | "sent" | "session">("layers");
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
      await copyText(text);
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
      kind: "chat_instructions",
      label: "Chat instructions",
      gloss: "How a Chat talks — ~/.nightloom/CHAT.md, read by chats of the Chat kind only; edited in Settings → Model instructions.",
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
  // The chat's mode, said where the layers are (nightshift backlog 059):
  // what it reads is the cards above; what it may not do is this line.
  const kind = $derived(chatMode(app.events));
  const MODE_CAVEAT: Record<string, string> = {
    incognito: "incognito: writes nothing, unread by other chats",
    ephemeral:
      "ephemeral: nothing is kept — no log, no name, no CLI session; on Claude Code the earlier turns are replayed into each prompt rather than resumed",
  };

  /*
   * Claude Code's own auto memory for the chat's folder (nightshift backlog
   * 088, 2026-09-16): `~/.claude/projects/<cwd>/memory/MEMORY.md`, which
   * the CLI reads itself at session start. A card on this engine only,
   * with the same per-chat switch as the layers above — off is recorded
   * in the log by kind and reaches the CLI as `autoMemoryEnabled: false`
   * on the next connect — and a Read that shows the file. Nightloom never
   * writes it; the vault and `remember` are its own memory. Measured: safe
   * mode does not drop it (the CLI reads it whether or not settings files
   * load), so the switch is the one way off from here.
   */
  const CLI_MEMORY: PromptLayer = "cli_memory";
  let cliMemory = $state<CliMemoryFile | null>(null);
  async function refreshCliMemory(): Promise<void> {
    if (!agentEngine) {
      cliMemory = null;
      return;
    }
    try {
      cliMemory = await api.cliMemoryFile();
    } catch {
      cliMemory = null;
    }
  }
  const cliMemoryOff = $derived(off.includes(CLI_MEMORY));
  const cliMemoryFolder = $derived(app.connection?.workspace ?? "");

  /*
   * Claude Code's own prompt (nightshift backlog 077, his ask of 00:55):
   * read-only, no switch — it cannot be dropped without breaking the tools
   * whose behaviour is written into it — read from the `prompt_snapshot`
   * the CLI writes into its own session file after the first turn. Null
   * before that, for an ephemeral chat (no file), and on the other engine;
   * the card says which.
   */
  const CLI_PROMPT = "cli_prompt";
  let cliPrompt = $state<CliPromptSnapshot | null>(null);
  async function refreshCliPrompt(): Promise<void> {
    if (!agentEngine) {
      cliPrompt = null;
      return;
    }
    try {
      cliPrompt = await api.cliPromptSnapshot();
    } catch {
      cliPrompt = null;
    }
  }
  const cliPromptChars = $derived(
    cliPrompt ? cliPrompt.sections.reduce((n, s) => n + s.length, 0) : 0,
  );
  /** ~4 chars a token: the same rough estimate the backend's sizes use,
   *  said as an estimate. */
  const cliPromptTokens = $derived(Math.round(cliPromptChars / 4));
  /** A CLI-side layer's share of the window, for the board's size bar
   *  (`11.2k ▮ 5.6%`): null while the window is unknown. */
  function windowShare(tokens: number): number | null {
    const limit = view?.context_limit;
    return limit ? Math.min(1, tokens / limit) : null;
  }
  const cliMemoryTokens = $derived(Math.round((cliMemory?.text ?? "").length / 4));

  /*
   * This session (nightshift backlog 077): what the CLI reported it has at
   * the start of the chat's latest turn — `app.agentInit`, the init line
   * kept whole. Nothing here is fetched; it arrives with the turn. Skills
   * are typed as `/name` in the composer, which is how the CLI runs one
   * named in the prompt. The MCP tools are grouped under their server by
   * the `mcp__<server>__` prefix, since the init line lists them flat.
   */
  const init = $derived(app.agentInit);
  const builtinTools = $derived((init?.tools ?? []).filter((t) => !t.startsWith("mcp__")));
  /** A Chat over a Claude Code declaration (nightshift backlog 144): the
   *  CLI still lists every tool — the list is what keeps the cached prefix
   *  — and a `PreToolUse` hook refuses all but the five read-only ones and
   *  Nightloom's own. The card strikes the refused ones through. */
  const chatPolicy = $derived(chatKind(app.events) === "chat" && declaredKind(app.events) === "build");
  const KEPT_ON_A_CHAT = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
  const refused = (t: string) => chatPolicy && !KEPT_ON_A_CHAT.includes(t);
  const mcpTools = $derived.by(() => {
    const by = new Map<string, string[]>();
    for (const t of init?.tools ?? []) {
      if (!t.startsWith("mcp__")) continue;
      const rest = t.slice(5);
      const cut = rest.indexOf("__");
      const server = cut < 0 ? rest : rest.slice(0, cut);
      const name = cut < 0 ? "" : rest.slice(cut + 2);
      by.set(server, [...(by.get(server) ?? []), name]);
    }
    return by;
  });
  /** The built-in slash commands: the init line lists the skills first,
   *  then the rest; the skills have their own card. */
  const builtinSlash = $derived(
    (init?.slash_commands ?? []).filter((c) => !(init?.skills ?? []).includes(c)),
  );
  function serverBad(status: string): boolean {
    return status === "failed" || status === "needs-auth" || status === "error";
  }
  /** The slash-command chips past this count fold behind `+ n more`
   *  (the design's board 4); a click shows them all. */
  const SLASH_SHOWN = 12;
  let allSlash = $state(false);
  const shownSlash = $derived(allSlash ? builtinSlash : builtinSlash.slice(0, SLASH_SHOWN));
  /** An MCP tool's short name, `search_works` → `search works`, for the
   *  server's row. */
  function shortMcp(n: string): string {
    return n.replace(/_+/g, " ");
  }
  /*
   * The hand-off threshold (nightshift backlog 086): the share of the CLI's
   * window past which the composer's notice asks for the wrap-up. Per
   * chat, in localStorage; the default is Settings → Claude Code (70% to
   * begin with; pass 2). Said here beside the conversation's total because
   * that is the number it is compared to. ~~`tick` re-reads after a change,
   * since storage is not reactive~~ — the store is reactive since pass 2;
   * the tick is kept, harmless.
   */
  let thresholdTick = $state(0);
  const handoffPct = $derived.by(() => {
    void thresholdTick;
    return Math.round(threshold(app.activeSessionId) * 100);
  });
  const handoffDefaultPct = $derived(Math.round(threshold(null) * 100));
  function setHandoffPct(v: string): void {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    setThreshold(app.activeSessionId, Math.min(100, Math.max(1, Math.round(n))) / 100);
    reconsider(app.activeSessionId);
    thresholdTick++;
  }
  /** Prompt suggestions (backlog 083): app-wide, read at connect, so a
   *  flip reconnects the open chat the way a rail knob does. */
  async function flipSuggestions(on: boolean): Promise<void> {
    setPromptSuggestions(on);
    if (agentEngine) await applyDraft();
  }
  const SAFE_MODE_DROPS =
    "Safe mode (the rail) starts the CLI with no settings files: measured on 2.1.263, that is every MCP server and its tools, every skill and slash command, and the Skill tool itself; the agents and the built-in tools stay.";

  async function refresh() {
    if (!app.connection) {
      view = null;
      cliMemory = null;
      return;
    }
    // A running turn holds the chat and session for its whole length
    // (`send` in main.rs), and `context_view` needs both — so the request
    // would only sit on the lock until the reply ends. Say so instead; the
    // effect below re-reads the moment `busy` clears. Keep the last view if
    // there is one: it is what the running request carried.
    if (app.busy && !view) {
      waitingOnTurn = true;
      return;
    }
    waitingOnTurn = false;
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
    void refreshCliMemory();
    void refreshCliPrompt();
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
      // Through the state so the inverse lands on the undo stack
      // (nightshift backlog 064); it re-syncs the transcript from the same
      // call rather than patching it here, since an elision changes every
      // projection off the log. Null is a refusal it has already toasted.
      const result = await editContextItems(targets, remove);
      if (!result) return;
      view = result.view;
      if (result.changed > 0 && remove) {
        addToast(
          `Removed ${result.changed} item${result.changed === 1 ? "" : "s"} — the content stays in the session log, and the prompt cache is invalidated from here on.`,
        );
      }
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
          use:tip={"The whole system prompt as one string, exactly as the backend renders it for the request"}
          onclick={() => (mode = "sent")}
        >
          As sent
        </button>
        {#if agentEngine}
          <button
            role="tab"
            class:on={mode === "session"}
            aria-selected={mode === "session"}
            use:tip={"What the Claude Code session has, as the CLI reported it at the start of the latest turn: MCP servers, tools, skills, slash commands, agents"}
            onclick={() => (mode = "session")}
          >
            This session
          </button>
        {/if}
      </div>
    {/if}
    <button class="close" use:tip={"Close"} aria-label="Close context" onclick={close}><Icon name="x" size={14} /></button>
  </div>

  <div class="pane">
    {#if !app.connection}
      <p class="note">Not connected.</p>
    {:else if error}
      <p class="note err">{error}</p>
    {:else if !view}
      <p class="note">
        {waitingOnTurn
          ? "A turn is running — the context shows when the reply ends."
          : loading
            ? "Reading…"
            : "Nothing yet."}
      </p>
    {:else if mode === "session"}
      {#if !init}
        <p class="note">
          No turn yet in this chat. The CLI reports what the session has at
          the start of each turn — send one and this fills in.
        </p>
        {#if app.connection?.agent?.safe_mode}
          <p class="note small">{SAFE_MODE_DROPS}</p>
        {/if}
      {:else}
        <div class="cards">
          <section class="card">
            <div class="ch">
              <div class="name">
                <span class="t">MCP servers</span>
                <span class="gloss">Each server the CLI loaded, with the status it reported. A failed or unauthenticated one is marked.</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{init.mcp_servers.length}</span>
            </div>
            {#if init.mcp_servers.length === 0}
              <p class="note small">None{app.connection?.agent?.safe_mode ? " — safe mode drops every MCP server" : ""}.</p>
            {:else}
              <!-- The board's row (Session.dc.html): dot · name · what it
                   offers, or why it failed · the tool count. A connected
                   server lists its tools by short name; a failed one its
                   error in the failed red; anything else its status. -->
              <ul class="plain">
                {#each init.mcp_servers as s (s.name)}
                  {@const tools = mcpTools.get(s.name.replace(/[^A-Za-z0-9_]/g, "_")) ?? mcpTools.get(s.name) ?? []}
                  {@const bad = serverBad(s.status)}
                  <li class="srow grid" class:bad>
                    <span class="dot" class:ok={s.status === "connected"} class:bad></span>
                    <span class="sname mono">{s.name}</span>
                    <span class="sstatus" use:tip={bad ? s.error ?? s.status : tools.map(shortMcp).join(" · ")}>
                      {#if bad}
                        {s.status}{s.error ? ` — ${s.error}` : ""}
                      {:else if tools.length > 0}
                        {tools.map(shortMcp).join(" · ")}
                      {:else}
                        {s.status}
                      {/if}
                    </span>
                    <span class="meta">{tools.length > 0 ? `${tools.length} tools` : ""}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <div class="pair">
          <section class="card">
            <div class="ch">
              <div class="name">
                <span class="t">Tools</span>
                <span class="gloss">The CLI's built-in tools this session offers, then each server's tools by short name.{#if chatPolicy} Struck through: still listed — the list is what keeps the cache warm — and refused when called, since this chat is a Chat now (Kind, in the rail).{/if}</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{init.tools.length}{#if chatPolicy} · {builtinTools.filter(refused).length} refused{/if}</span>
            </div>
            <div class="chips">
              {#each builtinTools as t (t)}<span class="chip" class:refused={refused(t)} use:tip={refused(t) ? "Refused on a Chat: a call to it gets an error result" : ""}>{t}</span>{/each}
            </div>
            {#each [...mcpTools.entries()] as [server, names] (server)}
              <div class="sub">
                <span class="meta">{server}</span>
                <div class="chips">
                  {#each names as n (n)}<span class="chip mcp">{n}</span>{/each}
                </div>
              </div>
            {/each}
          </section>

          <section class="card">
            <div class="ch">
              <div class="name">
                <span class="t">Skills</span>
                <span class="gloss">Type <code>/</code> in the composer to pick one; the CLI runs a skill named in the prompt.</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{init.skills.length}</span>
            </div>
            {#if init.skills.length === 0}
              <p class="note small">None{app.connection?.agent?.safe_mode ? " — safe mode drops every skill" : ""}.</p>
            {:else}
              <ul class="plain">
                {#each init.skills as sk (sk)}
                  <li class="srow krow"><span class="sname mono">/{sk}</span><span class="sstatus">type / in the composer</span></li>
                {/each}
              </ul>
            {/if}
          </section>
          </div>

          <div class="pair">
          <section class="card">
            <div class="ch">
              <div class="name">
                <span class="t">Slash commands</span>
                <span class="gloss">The CLI's built-in commands beyond the skills. Most are terminal UI; a name typed in the prompt runs the ones that are not.</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{allSlash || builtinSlash.length <= SLASH_SHOWN ? builtinSlash.length : `${SLASH_SHOWN} of ${builtinSlash.length}`}</span>
            </div>
            {#if builtinSlash.length === 0}
              <p class="note small">None{app.connection?.agent?.safe_mode ? " — safe mode drops them" : ""}.</p>
            {:else}
              <div class="chips">
                {#each shownSlash as c (c)}<span class="chip">/{c}</span>{/each}
                {#if builtinSlash.length > SLASH_SHOWN}
                  <button class="more" onclick={() => (allSlash = !allSlash)}>
                    {allSlash ? "fewer" : `+ ${builtinSlash.length - SLASH_SHOWN} more`}
                  </button>
                {/if}
              </div>
            {/if}
          </section>

          <section class="card">
            <div class="ch">
              <div class="name">
                <span class="t">Agents</span>
                <span class="gloss">The subagent types the CLI's Task tool can spawn.</span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{init.agents.length}</span>
            </div>
            <div class="chips">
              {#each init.agents as a (a)}<span class="chip">{a}</span>{/each}
            </div>
            <p class="note small">a subagent's turns fold under its Agent call in the transcript</p>
          </section>
          </div>
        </div>
        <!-- The board's foot: one span per fact, the safe-mode clause on
             hover of its span. -->
        <p class="foot mono cfoot">
          <span>claude {init.version ?? "?"}</span>
          <span>session {init.session_id ? init.session_id.slice(0, 8) : "?"}</span>
          <span>model {init.model ?? "?"}</span>
          <span>permission {init.permission_mode ?? "?"}</span>
          <span>effort {app.connection?.agent?.effort ?? "default"}</span>
          <span>{app.connection?.agent?.fallback_model ? `fallback ${app.connection.agent.fallback_model}` : "no fallback"}</span>
          <span use:tip={SAFE_MODE_DROPS}>safe mode {app.connection?.agent?.safe_mode ? "on — MCP, skills, commands and hooks dropped" : "off — on, this panel loses MCP, skills, commands and hooks"}</span>
        </p>
      {/if}
      <!-- Prompt suggestions (backlog 083): the switch lives here because
           the prediction is the CLI's, per session; off by default. -->
      <section class="card">
        <div class="ch">
          <input
            type="checkbox"
            class="sw"
            checked={suggestions.enabled}
            disabled={app.busy || app.connecting}
            aria-label="Prompt suggestions"
            onchange={(e) => void flipSuggestions((e.currentTarget as HTMLInputElement).checked)}
          />
          <div class="name">
            <span class="t">Prompt suggestions <span class="state">{suggestions.enabled ? "on" : "off"}</span></span>
            <span class="gloss">
              After each turn the CLI predicts your next prompt and the composer shows it as a dimmed line — Tab
              accepts. Costs about six seconds on every turn (the CLI waits for the prediction before it exits)
              and one more request against the plan. App-wide; a change reconnects the chat.
            </span>
          </div>
        </div>
      </section>
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
        <!-- The folders this chat can see (nightshift backlog 143): the
             home folder and every extra one, with its source and alias.
             Read-only here — the rail's Folders row is where they change. -->
        {#if app.connection && (app.connection.folders?.length ?? 0) > 0}
          <section class="card">
            <div class="ch">
              <span class="sw-space"></span>
              <div class="name">
                <span class="t">Folders this chat can see</span>
                <span class="gloss">
                  The working directory, then the extra folders granted to the project or to this chat —
                  {agentEngine ? "each an extra working directory of the CLI (--add-dir), readable without a prompt and editable under the approval setting" : "each a named tree the file tools reach by its @alias, like @kb for the vault"}.
                  Change them in the rail's Folders row.
                </span>
              </div>
              <span class="spacer"></span>
              <span class="meta">{1 + (app.connection.folders?.length ?? 0)}</span>
            </div>
            <div class="chips fold-chips">
              <span class="chip" use:tip={"The working directory"}>{app.connection.workspace}</span>
              {#each app.connection.folders ?? [] as f (f.path)}
                <span class="chip" use:tip={f.path}>{#if f.alias}<strong>{f.alias}</strong> → {/if}{f.path} <em>· {f.source === "project" ? "project" : "this chat"}</em></span>
              {/each}
            </div>
          </section>
        {/if}
        <!-- Claude Code's own prompt (nightshift backlog 077): first,
             since it is what everything below is appended to; read-only,
             no switch. From the CLI's own session file, after the first
             turn. -->
        {#if agentEngine}
          {@const isOpen = open.has(CLI_PROMPT)}
          <section class="card layer">
            <div class="ch">
              <span class="sw-space"></span>
              <div class="name">
                <span class="t">Claude Code's own prompt <span class="state ro">read-only</span></span>
                <span class="gloss">
                  The CLI's built-in system prompt, which the layers below are appended to. It cannot be switched off:
                  replacing it (<code>--system-prompt</code>) breaks the tools whose behaviour is written into it.
                  {#if !cliPrompt}Read from the CLI's session file after the chat's first turn; none yet, or an ephemeral chat with no file.{/if}
                </span>
              </div>
              <span class="spacer"></span>
              {#if cliPrompt}
                {@const share = windowShare(cliPromptTokens)}
                <!-- The board's size against the window (Layers.dc.html):
                     the gauge's 56px bar scaled to the layer's share. -->
                <span class="meta lbar" use:tip={`Estimated at four characters a token; ${cliPromptChars.toLocaleString()} characters in ${cliPrompt.sections.length} sections${share !== null ? ` — ${(share * 100).toFixed(1)}% of the window` : ""}`}>
                  <span>{fmtTokens(cliPromptTokens)}</span>
                  {#if share !== null}
                    <span class="sb" aria-hidden="true"><i style:width="{share * 100}%"></i></span>
                    <span>{(share * 100).toFixed(1)}%</span>
                  {/if}
                </span>
                <button
                  class="ns-btn small read"
                  class:on={isOpen}
                  aria-expanded={isOpen}
                  onclick={() => toggle(CLI_PROMPT)}
                >
                  {isOpen ? "Close" : "Read"}
                  <span class="chev" class:up={isOpen}><Icon name="chev" size={12} /></span>
                </button>
              {/if}
            </div>
            {#if isOpen && cliPrompt}
              <div class="body">
                <div class="body-bar">
                  <span class="file" use:tip={cliPrompt.path}>{cliPrompt.path}</span>
                  <span class="spacer"></span>
                  <button class="ns-btn ghost small" onclick={() => copy(CLI_PROMPT, cliPrompt?.sections.join("\n\n"))}>
                    {copied === CLI_PROMPT ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre class="reader">{cliPrompt.sections.join("\n\n")}</pre>
              </div>
            {/if}
          </section>
        {/if}
        {#each LAYERS.filter((l) => shown(l.engines)) as layer (layer.kind)}
          {@const isOff = off.includes(layer.kind)}
          {@const segs = segmentsOf(layer.kind)}
          {@const isOpen = open.has(layer.kind)}
          {@const canEdit = editable(layer.kind)}
          {@const isEdited = canEdit && edits[layer.kind as EditableLayer] !== undefined}
          {@const isEditing = canEdit && editing === layer.kind}
          {@const canRead = !isOff && (segs.length > 0 || isEditing)}
          {@const locked = saving || seeding || app.busy || app.connecting}
          {@const mark = agentEngine ? pendingFor(app.promptPending, layer.kind, app.activeSessionId) : null}
          <section class="card layer" class:off={isOff} class:edited={isEdited && !isOff}>
            <div class="ch">
              <input
                type="checkbox"
                class="sw"
                checked={!isOff}
                disabled={switching || railOff || app.busy || app.connecting}
                aria-label={`${layer.label} for this chat`}
                use:tip={isOff
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
                  use:tip={isEdited
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
                  <span class="anchor" use:tip={"Cached prefix ends here"}>⚑</span>
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
            <!-- Backlog 174: the file changed while this chat ran on the old text. -->
            {#if mark}<LayerVersionMark pending={mark} />{/if}
            {#if isEdited && !isOff && !isEditing}
              <!-- The override's two ways out, said in words: back to the
                   file, or into the file as a draft the editor shows. -->
              <div class="actions">
                <button
                  class="ns-btn ghost small"
                  disabled={locked}
                  use:tip={"Drop this chat's text; the layer reads the file again"}
                  onclick={() => void revert(layer.kind as EditableLayer)}
                >
                  <Icon name="revert" size={12} />
                  Revert to the file
                </button>
                <button
                  class="ns-btn ghost small"
                  disabled={locked}
                  use:tip={"Open the file's editor with this text as a draft — nothing is written until you save there"}
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
                      <span class="file" use:tip={seg.name}>{seg.name}</span>
                      <span class="meta">{sizeLabel(seg.size)}</span>
                    {:else}
                      <span class="file" use:tip={seg.name}>{seg.name}</span>
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
                <span class="anchor" use:tip={"Cached prefix ends here"}>⚑</span>
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

        <!-- Claude Code's own memory for this folder (nightshift backlog
             088): a card on this engine only. Not a segment of the prompt
             above — the CLI reads the file itself — so no size, no anchor;
             the switch is the same per-chat switch, and off reaches the
             CLI as a setting on reconnect. -->
        {#if agentEngine}
          {@const isOpen = open.has(CLI_MEMORY)}
          {@const hasFile = cliMemory?.text != null}
          <section class="card layer" class:off={cliMemoryOff}>
            <div class="ch">
              <input
                type="checkbox"
                class="sw"
                checked={!cliMemoryOff}
                disabled={switching || app.busy || app.connecting}
                aria-label="Claude Code memory for this chat"
                use:tip={cliMemoryOff
                  ? "Off for this chat — the CLI is started with autoMemoryEnabled false; switch on to let it read its memory again"
                  : "On — the CLI reads its own memory for this folder; switch off to keep it from this chat"}
                onchange={(e) => void flip(CLI_MEMORY, (e.currentTarget as HTMLInputElement).checked)}
              />
              <div class="name">
                <span class="t">Claude Code memory</span>
                {#if cliMemoryOff}
                  <span class="state off-state">off for this chat</span>
                {:else if cliMemory && !hasFile}
                  <span class="state">nothing on disk yet</span>
                {/if}
                <span class="gloss">
                  The CLI's own auto memory for {cliMemoryFolder || "this folder"} — read by Claude Code
                  itself, not sent by Nightloom, and never written from here. Safe mode leaves it on;
                  this switch is the one way off.
                </span>
              </div>
              <span class="spacer"></span>
              {#if !cliMemoryOff && hasFile}
                {@const share = windowShare(cliMemoryTokens)}
                <span class="meta lbar" use:tip={`Estimated at four characters a token; ${(cliMemory?.text ?? "").length.toLocaleString()} characters${share !== null ? ` — ${(share * 100).toFixed(1)}% of the window` : ""}`}>
                  <span>{fmtTokens(cliMemoryTokens)}</span>
                  {#if share !== null}
                    <span class="sb" aria-hidden="true"><i style:width="{share * 100}%"></i></span>
                    <span>{(share * 100).toFixed(1)}%</span>
                  {/if}
                </span>
                <button
                  class="ns-btn small read"
                  class:on={isOpen}
                  aria-expanded={isOpen}
                  onclick={() => toggle(CLI_MEMORY)}
                >
                  {isOpen ? "Close" : "Read"}
                  <span class="chev" class:up={isOpen}><Icon name="chev" size={12} /></span>
                </button>
              {/if}
            </div>
            {#if !cliMemoryOff && isOpen && cliMemory}
              <div class="body">
                <div class="body-bar">
                  <span class="file" use:tip={cliMemory.path}>{cliMemory.path}</span>
                  <span class="spacer"></span>
                  <button class="ns-btn ghost small" onclick={() => copy(CLI_MEMORY, cliMemory?.text)}>
                    {copied === CLI_MEMORY ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre class="reader">{cliMemory.text}</pre>
                {#if cliMemory.others.length > 0}
                  <span class="gloss">
                    Topic files beside it, read by the CLI on demand: {cliMemory.others.join(", ")}
                  </span>
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </div>
      {#if kind !== "normal"}
        <p class="note small caveat">{MODE_CAVEAT[kind]}</p>
      {/if}
      {#if agentEngine}
        <p class="note small caveat">
          On Claude Code the history is the CLI's; only what Nightloom appends is switchable. The
          CLI's prompt is shown, never replaced — the tools' behaviour is written into it.
        </p>
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
              use:tip={EDIT_NOTE}
              onclick={() => edit(elided, false)}
            >
              Restore {elided.length} removed
            </button>
          {/if}
          <span
            class="total"
            use:tip={t.unestimated > 0
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
          <!-- The subagents' share (backlog 152): said beside the window
               figure, never added to it — a child's context is its own. -->
          {@const agents = subagentsOfTurn()}
          {#if agents.rows.length > 0}
            <p class="note small">
              + subagents: {agents.tokens.toLocaleString()} tokens ({agents.rows.length}
              agent{agents.rows.length === 1 ? "" : "s"} this turn{agents.running > 0 ? `, ${agents.running} running` : ""}) —
              each agent's latest request and reply as the CLI counts it, not in
              the window figure above; the Running-tasks chip in the bar lists
              them.
            </p>
          {/if}
          <!-- The hand-off (backlog 086): where the wrap-up is asked. -->
          <label class="threshold">
            <span class="gloss">
              Hand off at
            </span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={handoffPct}
              aria-label="Hand-off threshold, percent of the context window"
              onchange={(e) => setHandoffPct((e.currentTarget as HTMLInputElement).value)}
            />
            <span class="gloss">
              % of the window{app.activeSessionId ? ", for this chat" : " (the default)"} — the CLI's own
              auto-compact is off; past this mark the composer's notice asks for the wrap-up (the model
              writes HANDOFF.md, stops, and gives a start prompt for a linked new chat). The default,
              {handoffDefaultPct}%, and the wrap-up's text are in Settings → Subscription.
            </span>
          </label>
        {:else if items.length === 0}
          <p class="note small">Nothing yet.</p>
        {:else}
          <ul class="list">
            {#each items as item, i (i)}
              {@const b = item.block}
              <li
                class="row"
                class:elided={b.elided}
                use:tip={b.preview + (b.truncated ? "…" : "")}
              >
                <div class="line">
                  <span class="size">{sizeLabel(b.size)}</span>
                  <span class="kind">{kindOf(b)}</span>
                  <span class="role">{item.role}</span>
                  {#if b.elidable}
                    <button
                      class="act"
                      disabled={working || app.busy}
                      use:tip={EDIT_NOTE}
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

  .threshold {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .threshold input {
    width: 4rem;
    font-family: var(--mono);
    font-size: 12px;
    background: var(--well);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 2px 6px;
  }

  /* This session (backlog 077): plain rows and chips, nothing new in
     colour beyond the status dot. */
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .srow {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
    flex-wrap: wrap;
  }
  /* The board's grids (Session.dc.html): a server row is dot · name ·
     what it offers · count, a skill row name · gloss; a hairline between
     rows. */
  .srow.grid {
    display: grid;
    grid-template-columns: 16px 150px minmax(0, 1fr) 70px;
    gap: 10px;
    align-items: center;
    flex-wrap: nowrap;
    padding: 3px 0;
  }
  .srow.grid .sstatus {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .srow.grid .meta {
    text-align: right;
    font-size: 11px;
  }
  .srow.grid .dot {
    justify-self: center;
  }
  .srow.krow {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px;
    padding: 2px 0;
  }
  .srow.krow .sstatus {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .plain .srow.grid + .srow.grid,
  .plain .srow.krow + .srow.krow {
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }
  /* Two cards side by side — Tools · Skills, Slash commands · Agents. */
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .pair .card {
    min-width: 0;
  }
  .more {
    font: inherit;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--dim);
    background: none;
    border: 1px dashed var(--line2);
    border-radius: 6px;
    padding: 1px 6px;
    cursor: pointer;
  }
  .more:hover {
    color: var(--ink);
  }
  .foot.cfoot {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 11px;
  }
  .sname {
    color: var(--ink);
  }
  .sname.mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .sstatus {
    color: var(--dim);
    font-size: 12px;
  }
  .srow.bad .sstatus {
    color: var(--error);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    align-self: center;
    flex-shrink: 0;
  }
  .dot.ok {
    background: var(--done);
  }
  .dot.bad {
    background: var(--error);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip.refused {
    text-decoration: line-through;
    opacity: 0.55;
  }
  /* The folders card (backlog 143): one chip per folder, the path whole. */
  .fold-chips .chip {
    white-space: normal;
    word-break: break-all;
  }
  .fold-chips .chip em {
    font-style: normal;
    color: var(--dim);
  }
  .chip {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 1px 6px;
  }
  .chip.mcp {
    color: var(--dim);
  }
  .sub {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .foot {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
  }
  code {
    font-family: var(--mono);
    font-size: 12px;
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
  /* `read-only` as the board's pill: ruled, in the accent ink. */
  .state.ro {
    font-size: 11px;
    color: var(--accent-ink);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 999px;
    padding: 0 7px;
    white-space: nowrap;
  }
  /* A layer's size against the window: the gauge's bar scaled to it. */
  .lbar {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .lbar .sb {
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .lbar .sb i {
    display: block;
    height: 100%;
    background: var(--accent);
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
