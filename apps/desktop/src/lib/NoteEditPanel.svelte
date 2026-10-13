<script lang="ts">
  import { tip } from "./tip";
  import { isImeKey } from "./imeKey";
  /**
   * The small chat on the right of a note (nightshift backlog 151): he says
   * what changed, a model edits the note's file to fit (the Edit tool, on
   * that one path — pass 2), and each edit shows in the note as it lands
   * (`NoteView` draws it). Everything lives in `noteEdit.svelte.ts`, so a
   * turn lands however this panel is left and
   * the half-typed request is there when it opens again.
   *
   * The look is his pick D2 (backlog 345, harness/pick345.html): his
   * messages are bubbles on the right; a reply that changed the note is a
   * card under his bubble with the changed lines (a click shows the line in
   * the note; the card expands to the full lines), a status chip and Undo;
   * a reply with no edit is plain text with a quiet line. The motion is
   * the chat's: a sent message travels into place (sendMotion, backlog 194),
   * the reply's words arrive as the chat's do (replyMotion, backlog 342 —
   * ink rise under the shuttle), thinking draws the needle, a running edit
   * the weft. Reduced motion leaves all of it still.
   */
  import { onMount, tick } from "svelte";
  import { app, noteDraftKey } from "./state.svelte";
  import type { NoteScope } from "./types";
  import {
    blockWords,
    editRows,
    editTotals,
    expandWords,
    lineNow,
    PANEL_WIDTH,
    PROPOSAL_OPEN_WORDS,
    replyKind,
    shownRows,
    undoable,
    withSuggestion,
    type EditBlock,
    type EditRow,
    type NoteEditTurn,
  } from "./noteEdit";
  import {
    initNoteEditEvents,
    noteEditUi,
    noteEdits,
    restoreAsDraft,
    runNoteEdit,
    runningTurn,
    setRequestDraft,
    setStrike,
    stopNoteEdit,
    undoNoteEdit,
  } from "./noteEdit.svelte";
  import { arrive, launch } from "./sendMotion";
  import { replyMotion } from "./replyMotion";

  let {
    scope,
    name,
    text,
    blocked = null,
    proposalOpen = false,
    onShowBlock,
    onJump,
  }: {
    scope: NoteScope;
    name: string;
    text: string;
    /** Why nothing can be sent or undone now (backlog 325); null when
     *  nothing blocks. */
    blocked?: EditBlock | null;
    /** A dream's proposed change is open on the note: said, nothing
     *  turned off (backlog 345). */
    proposalOpen?: boolean;
    /** Bring the proposal card into view. */
    onShowBlock?: () => void;
    /** Show this line (0-based, in the note as it reads now) in the note. */
    onJump?: (line: number) => void;
  } = $props();

  const disabled = $derived(blocked !== null);

  const key = $derived(noteDraftKey(scope, name));
  /** The send motion's channel: one per note, so a launch lands on this thread only. */
  const channel = $derived(`note-edit:${key}`);
  const t = $derived(noteEdits[key]);
  const turns = $derived(t?.turns ?? []);
  const running = $derived(runningTurn(key));
  const canUndo = $derived(undoable(turns));
  const draft = $derived(t?.draft ?? "");
  const strike = $derived(t?.strike ?? true);
  const model = $derived(app.draft.agentModel.trim() || "Claude Code's default model");

  let box = $state<HTMLTextAreaElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  /** Cards showing every changed line, whole (by turn id). */
  let expanded = $state<Record<number, boolean>>({});

  onMount(() => {
    void initNoteEditEvents();
    box?.focus();
  });

  // The newest exchange in view as it grows.
  $effect(() => {
    void turns.length;
    void running?.partial;
    void running?.edits;
    void tick().then(() => {
      if (list) list.scrollTop = list.scrollHeight;
    });
  });

  function send() {
    if (disabled || running || !draft.trim()) return;
    // The message travels from the box into its bubble (sendMotion, as the chat's).
    launch(channel, box);
    void runNoteEdit(scope, name, text);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !isImeKey(e)) {
      e.preventDefault();
      send();
    }
  }

  function suggest(s: string) {
    // Never over what he typed (wave 7 review round 2, practices §7).
    setRequestDraft(key, withSuggestion(draft, s));
    box?.focus();
  }

  function totals(turn: NoteEditTurn): string {
    const after = turn.after ?? turn.current;
    if (after === undefined) return "";
    const { added, removed } = editTotals(turn.before, after);
    return `+${added} −${removed}`;
  }

  function rowsOf(turn: NoteEditTurn): EditRow[] {
    const after = turn.after ?? turn.current;
    if (after === undefined || after === turn.before) return [];
    return editRows(turn.before, after);
  }

  function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  /** "2:41 PM" — 12-hour. */
  function clock(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /** The reply so far, for `{@html}`: escaped, in a paragraph, so the chat's
   *  reply motion can wrap the words that arrive (it reads `.markdown`
   *  blocks re-rendered whole, as the chat's are). */
  function partialHtml(s: string): string {
    const e = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<p>${e}</p>`;
  }

  const SUGGESTIONS = [
    "We dropped the neutral folder — update everything that assumes it",
    "Summarize what changed",
    "Tighten the wording, keep the meaning",
  ];
</script>

<aside class="panel" aria-label="Edit with a prompt" style:width={PANEL_WIDTH}>
  <header>
    <div class="head">
      <span class="title">Edit with a prompt</span>
      <span class="file">{name}</span>
    </div>
    <span class="spacer"></span>
    <button class="x" use:tip={"Close the panel — what you typed stays"} onclick={() => (noteEditUi.open = false)}>×</button>
  </header>

  <div class="list" bind:this={list}>
    {#if turns.length === 0}
      <div class="empty">
        <p class="lead">Say what changed, or ask about the note.</p>
        <div class="sugs">
          {#each SUGGESTIONS as s, i (s)}
            <button class="sug" onclick={() => suggest(s)}><span class="n">{i + 1}</span>{s}</button>
          {/each}
        </div>
        <p class="fine">
          It reads and edits this note's file and nothing else; each edit shows in the note as it lands,
          and each request undoes in one step. It remembers this thread, so you can follow up or ask about
          the note and get an answer without an edit.
        </p>
      </div>
    {/if}
    {#each turns as turn (turn.id)}
      {@const kind = replyKind(turn)}
      {@const live = turn.status === "running"}
      <div class="ex">
        {#if turn.status !== "kept"}
          <div class="me">
            <div class="bubble" use:arrive={{ channel }}>{turn.request}</div>
            <span class="at">{clock(turn.at)}</span>
          </div>
        {/if}

        {#if kind === "card"}
          {@const rows = rowsOf(turn)}
          {@const open = !!expanded[turn.id]}
          {@const shown = shownRows(rows, open)}
          <div class="card {turn.status}" class:live>
            {#if live}
              {#if turn.partial}<div class="said markdown" use:replyMotion={true}>{@html partialHtml(turn.partial)}</div>{/if}
            {:else}
              {#if turn.summary}<p class="said">{turn.summary}</p>{/if}
              {#if turn.error}<p class="warn">{turn.error}</p>{/if}
            {/if}
            {#if rows.length > 0}
              <div class="diff" class:open>
                {#each shown as row, i (i)}
                  <button
                    class="dl {row.kind}"
                    use:tip={"Show this line in the note"}
                    onclick={() => onJump?.(lineNow(row, text))}
                    ><span class="sg">{row.kind === "add" ? "+" : "−"}</span>{row.text || " "}</button
                  >
                {/each}
                <button class="more" aria-expanded={open} onclick={() => (expanded[turn.id] = !open)}
                  >{expandWords(rows.length, open)}</button
                >
              </div>
            {/if}
            <div class="row">
              {#if live}
                <span class="chip live">
                  <span class="dot"></span>
                  {#key turn.edits}<span class="count">Editing · {plural(turn.edits ?? 0, "edit")} so far</span>{/key}
                </span>
              {:else if turn.status === "applied"}
                <span class="chip done">Saved · {totals(turn)}</span>
              {:else if turn.status === "undone"}
                <span class="chip quiet">Undone · {totals(turn)}</span>
              {:else}
                <span class="chip warn">Stopped · {totals(turn)}</span>
              {/if}
              <span class="spacer"></span>
              {#if !live}
                {#if canUndo && canUndo.id === turn.id}
                  <button
                    class="undo"
                    use:tip={"Put the note back as it was before this edit, and save"}
                    disabled={disabled}
                    onclick={() => void undoNoteEdit(scope, name, text)}>Undo</button
                  >
                {/if}
                <button
                  class="link"
                  use:tip={"Put the note as it read before this edit back in the editor, unsaved — Save keeps it, Revert drops it"}
                  disabled={disabled}
                  onclick={() => restoreAsDraft(key, turn.before)}>Earlier text as a draft</button
                >
              {/if}
            </div>
            {#if turn.status === "stopped"}
              <span class="quiet">cut off — the edits that landed stay; Undo puts the note back</span>
            {/if}
            {#if live}<span class="weft" aria-hidden="true"></span>{/if}
          </div>
        {:else if kind === "thinking"}
          <div class="plain thinking">
            {#if turn.partial}<div class="said markdown" use:replyMotion={true}>{@html partialHtml(turn.partial)}</div>{/if}
            <span class="quiet live">{turn.partial ? "working on it…" : "reading the note…"}</span>
          </div>
        {:else}
          <div class="plain" class:bad={turn.status === "failed"}>
            {#if turn.status === "unchanged"}
              <p class="said">{turn.summary || "Nothing needed to change."}</p>
              <span class="quiet">answered · no edit</span>
            {:else if turn.status === "draft"}
              {#if turn.summary}<p class="said">{turn.summary}</p>{/if}
              <span class="quiet warn">{turn.error}</span>
            {:else if turn.status === "stopped"}
              <span class="quiet">stopped — the note is as it was</span>
            {:else if turn.status === "kept"}
              <span class="quiet">{turn.summary}</span>
            {:else if turn.status === "failed"}
              <span class="quiet warn">{turn.error ?? "failed"} — the note is as it was</span>
            {:else}
              {#if turn.summary}<p class="said">{turn.summary}</p>{/if}
              {#if turn.error}<span class="quiet warn">{turn.error}</span>{/if}
              <span class="quiet">no change</span>
            {/if}
            {#if turn.status === "draft" || turn.status === "kept"}
              <button
                class="link"
                use:tip={turn.status === "kept"
                  ? "Put this text back in the editor as an unsaved draft"
                  : "Put the note as it read before this edit back in the editor, unsaved — Save keeps it, Revert drops it"}
                disabled={disabled}
                onclick={() => restoreAsDraft(key, turn.before)}
                >{turn.status === "kept" ? "Put back as a draft" : "Earlier text as a draft"}</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <footer>
    {#if blocked && !running}
      <p class="blocked" role="status">{blockWords(blocked)}</p>
    {:else if proposalOpen && !running}
      <p class="notice" role="status">
        <span class="dot"></span>
        <span>{PROPOSAL_OPEN_WORDS}</span>
        {#if onShowBlock}
          <button class="link" onclick={onShowBlock}>Show the proposal</button>
        {/if}
      </p>
    {/if}
    <div class="compose">
      <textarea
        bind:this={box}
        aria-label="What changed"
        rows="2"
        placeholder="What changed? Or ask about the note"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        value={draft}
        oninput={(e) => setRequestDraft(key, (e.currentTarget as HTMLTextAreaElement).value)}
        {onkeydown}
      ></textarea>
      <div class="bar">
        <div
          class="seg"
          role="group"
          aria-label="Lines no longer true"
          use:tip={"Strike: a line that is no longer true is struck through with today's date and the new line put beside it. Rewrite: it is rewritten."}
        >
          <button class:on={strike} aria-pressed={strike} onclick={() => setStrike(key, true)}>Strike</button>
          <button class:on={!strike} aria-pressed={!strike} onclick={() => setStrike(key, false)}>Rewrite</button>
        </div>
        <span class="spacer"></span>
        {#if running}
          <button class="stop" aria-label="Stop" use:tip={"Stop — the edits that landed stay"} onclick={() => void stopNoteEdit(key)}
            ><i></i></button
          >
        {:else}
          <button
            class="send"
            aria-label="Send"
            use:tip={blocked ? blockWords(blocked) : draft.trim() ? "Send (Enter)" : "Type a request or a question first"}
            disabled={disabled || !draft.trim()}
            onclick={send}>↑</button
          >
        {/if}
      </div>
    </div>
    <span class="model">on {model} · reads and edits this file only</span>
  </footer>
</aside>

<style>
  .panel {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
  }
  /* A phone-narrow window: the panel takes the width (the note is a click
     on × away); beside a 320-px panel the note would be a sliver. */
  @media (max-width: 640px) {
    .panel {
      width: 100% !important;
      border-left: none;
    }
  }
  header {
    display: flex;
    align-items: center;
    padding: 0.7rem 0.85rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .head {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .file {
    font-family: var(--mono);
    font-size: 0.69rem;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .x {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 1.1rem;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 6px;
  }
  .x:hover {
    color: var(--text);
    background: var(--well);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.85rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  /* ---- empty ---- */
  .empty {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .lead {
    margin: 0;
    font-family: var(--serif);
    font-size: 1.06rem;
  }
  .sugs {
    display: flex;
    flex-direction: column;
    gap: 0.38rem;
  }
  .sug {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    text-align: left;
    background: var(--paper);
    border: 1px solid var(--line2);
    color: var(--ink2);
    border-radius: 10px;
    padding: 0.5rem 0.62rem;
    font-family: inherit;
    font-size: 0.78rem;
    line-height: 1.35;
    cursor: pointer;
  }
  .sug:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .n {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.66rem;
    font-weight: 700;
  }
  .fine {
    margin: 0.1rem 0 0;
    font-size: 0.72rem;
    color: var(--dim);
    line-height: 1.45;
  }

  /* ---- an exchange: his bubble, then the reply ---- */
  .ex {
    display: flex;
    flex-direction: column;
  }
  .me {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    margin-bottom: 0.38rem;
  }
  .bubble {
    max-width: 84%;
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 15px 15px 4px 15px;
    padding: 0.44rem 0.75rem;
    font-size: 0.81rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .at {
    font-size: 0.66rem;
    color: var(--dim);
    padding-right: 4px;
  }
  .said {
    margin: 0;
    font-size: 0.81rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .said.markdown {
    position: relative;
  }
  .said.markdown :global(p) {
    margin: 0;
  }
  .quiet {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .quiet.live {
    color: var(--live);
  }
  .warn,
  .quiet.warn,
  .plain.bad .quiet {
    color: var(--failed);
  }
  p.warn {
    margin: 0;
    font-size: 0.74rem;
  }

  /* ---- a reply with no edit: text (his "like the original version A") ---- */
  .plain {
    padding: 0 0.4rem 0 0.15rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }
  /* Thinking: the needle (backlog 342) — an accent thread down the margin
     with a glowing point at its foot. */
  .plain.thinking {
    position: relative;
    padding-left: 0.7rem;
    background: linear-gradient(var(--accent), var(--accent)) left top / 2px 100% no-repeat;
    min-height: 1.4rem;
  }
  .plain.thinking::after {
    content: "";
    position: absolute;
    left: -2px;
    bottom: 0.3em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-ink, var(--accent));
    box-shadow: 0 0 8px var(--accent);
  }

  /* ---- a reply that edited: the card ---- */
  .card {
    position: relative;
    align-self: flex-start;
    width: 92%;
    box-sizing: border-box;
    background: var(--paper);
    border: 1px solid var(--line2);
    border-left: 3px solid var(--done);
    border-radius: 4px 12px 12px 12px;
    padding: 0.56rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.44rem;
  }
  .card.undone {
    border-left-color: var(--dim);
  }
  .card.stopped {
    border-left-color: var(--partial);
  }
  .card.live {
    border-color: var(--live);
    border-left-color: var(--live);
    background: color-mix(in srgb, var(--live-soft) 45%, var(--paper));
    overflow: hidden;
  }
  .diff {
    display: flex;
    flex-direction: column;
    border-radius: 6px;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 0.66rem;
    line-height: 1.6;
  }
  .dl {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    padding: 0 0.45rem;
    font: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .sg {
    display: inline-block;
    width: 1.1em;
    opacity: 0.6;
    user-select: none;
  }
  .diff.open .dl {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .dl.add {
    background: var(--add-bg);
    color: var(--add-fg);
  }
  .dl.del {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .dl:hover {
    box-shadow: inset 2px 0 0 var(--accent);
    filter: brightness(1.15);
  }
  .more {
    text-align: left;
    background: var(--well);
    border: none;
    color: var(--dim);
    font: inherit;
    padding: 0.1rem 0.45rem;
    cursor: pointer;
  }
  .more:hover {
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    font-size: 0.69rem;
    border-radius: 999px;
    padding: 1px 0.56rem;
    white-space: nowrap;
  }
  .chip.done {
    background: var(--done-soft);
    color: var(--done);
  }
  .chip.live {
    background: var(--live-soft);
    color: var(--live);
  }
  .chip.quiet {
    background: var(--well);
    color: var(--dim);
  }
  .chip.warn {
    background: var(--partial-soft);
    color: var(--partial);
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }
  /* The weft (backlog 342's, on the card): a thin accent thread across the
     card's foot with a bright shuttle running along it while the edit runs. */
  .weft {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1.5px;
    transform-origin: left center;
    pointer-events: none;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    overflow: hidden;
  }
  .weft::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 28%;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--accent-ink, var(--accent)), transparent);
  }
  .undo {
    background: var(--well);
    border: 1px solid var(--line2);
    color: var(--text);
    border-radius: 7px;
    font-family: inherit;
    font-size: 0.72rem;
    padding: 0.16rem 0.62rem;
    cursor: pointer;
  }
  .undo:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.7rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover:not(:disabled) {
    color: var(--text);
  }
  .undo:disabled,
  .link:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ---- the composer ---- */
  footer {
    border-top: 1px solid var(--border);
    padding: 0.5rem 0.75rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.38rem;
  }
  .blocked {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--dim);
  }
  .notice {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--ink2);
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 9px;
    padding: 0.44rem 0.62rem;
  }
  .notice .dot {
    background: var(--accent);
  }
  .notice .link {
    color: var(--accent-ink);
    white-space: nowrap;
  }
  .compose {
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 12px;
    padding: 0.56rem 0.5rem 0.44rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.38rem;
  }
  .compose:focus-within {
    border-color: var(--accent);
  }
  textarea {
    resize: none;
    background: transparent;
    color: var(--text);
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 0.84rem;
    line-height: 1.5;
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--dim);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .seg {
    display: inline-flex;
    background: var(--panel);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px;
  }
  .seg button {
    background: none;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 0.18rem 0.62rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--well);
    color: var(--text);
  }
  .send {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--paper);
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
  }
  .send:disabled {
    background: var(--line2);
    color: var(--dim);
    cursor: default;
  }
  .stop {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--panel);
    cursor: pointer;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .stop i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--text);
  }
  .model {
    font-size: 0.64rem;
    color: var(--dim);
    padding-left: 0.25rem;
  }

  /* ---- motion: the chat's (backlog 342; its keyframes are global, in
     AssistantMessage). The shuttle's look is AssistantMessage's, scoped
     there to `.assistant`, so it is restated here for the panel's reply. ---- */
  .said.markdown :global(.rm-shuttle) {
    position: absolute;
    left: 0;
    top: 0;
    width: 18px;
    height: 5px;
    margin: -2.5px 0 0 0;
    border-radius: 50% / 100%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 10%, transparent), var(--accent-ink, var(--accent)));
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 70%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 260ms ease-out;
    z-index: 5;
  }
  @media (prefers-reduced-motion: reduce) {
    .weft,
    .said.markdown :global(.rm-shuttle) {
      display: none;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .said.markdown :global(.rm-w) {
      display: inline-block;
      animation:
        rm-rise 520ms cubic-bezier(0.2, 0.7, 0.2, 1) both,
        rm-weft-under 900ms ease-out both;
    }
    .plain.thinking::after {
      animation: rm-needle 1.1s ease-in-out infinite;
    }
    .weft {
      animation: rm-draw 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .weft::after {
      animation: rm-shuttle-run 0.9s ease-in-out infinite alternate;
    }
    .card.live .count {
      animation: rm-flash 600ms ease-out;
    }
  }
</style>
