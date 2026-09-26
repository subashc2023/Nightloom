<script lang="ts">
  import { tip } from "./tip";
  /**
   * The small chat on the right of a note (nightshift backlog 151): he says
   * what changed, a model edits the note's file to fit (the Edit tool, on
   * that one path — pass 2), and each edit shows in the note as it lands
   * (`NoteView` draws it). Everything lives in `noteEdit.svelte.ts`, so a
   * turn lands however this panel is left and
   * the half-typed request is there when it opens again.
   */
  import { onMount, tick } from "svelte";
  import { app, noteDraftKey } from "./state.svelte";
  import type { NoteScope } from "./types";
  import { editTotals, undoable, type NoteEditTurn } from "./noteEdit";
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

  let {
    scope,
    name,
    text,
    disabled = false,
  }: { scope: NoteScope; name: string; text: string; disabled?: boolean } = $props();

  const key = $derived(noteDraftKey(scope, name));
  const t = $derived(noteEdits[key]);
  const turns = $derived(t?.turns ?? []);
  const running = $derived(runningTurn(key));
  const canUndo = $derived(undoable(turns));
  const draft = $derived(t?.draft ?? "");
  const strike = $derived(t?.strike ?? true);
  const model = $derived(app.draft.agentModel.trim() || "Claude Code's default model");

  let box = $state<HTMLTextAreaElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);

  onMount(() => {
    void initNoteEditEvents();
    box?.focus();
  });

  // The newest exchange in view as it grows.
  $effect(() => {
    void turns.length;
    void running?.partial;
    void tick().then(() => {
      if (list) list.scrollTop = list.scrollHeight;
    });
  });

  function send() {
    if (disabled || running || !draft.trim()) return;
    void runNoteEdit(scope, name, text);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function lines(turn: NoteEditTurn): string {
    if (turn.after === undefined) return "";
    const { added, removed } = editTotals(turn.before, turn.after);
    return `+${added} −${removed} line${added + removed === 1 ? "" : "s"}`;
  }

  function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }
</script>

<aside class="panel" aria-label="Edit with a prompt">
  <header>
    <span class="title">Edit with a prompt</span>
    <span class="spacer"></span>
    <button class="x" use:tip={"Close the panel — what you typed stays"} onclick={() => (noteEditUi.open = false)}>×</button>
  </header>

  <div class="list" bind:this={list}>
    {#if turns.length === 0}
      <p class="hint">
        Say what changed — "we dropped the neutral folder; update everything that assumes it" —
        and the model edits the note to fit; each edit shows as it lands. It can read and edit
        this note's file and nothing else. Each request can be undone in one step.
      </p>
    {/if}
    {#each turns as turn (turn.id)}
      <div class="turn">
        {#if turn.status !== "kept"}<div class="ask">{turn.request}</div>{/if}
        <div class="said" class:bad={turn.status === "failed"}>
          {#if turn.status === "running"}
            {#if turn.partial}<p>{turn.partial}</p>{/if}
            <span class="working">Editing the note… {plural(turn.edits ?? 0, "edit")} so far</span>
          {:else if turn.status === "applied" || turn.status === "undone"}
            {#if turn.summary}<p>{turn.summary}</p>{/if}
            {#if turn.error}<span class="meta warn">{turn.error}</span><br />{/if}
            <span class="meta"
              >{turn.edits !== undefined ? `${plural(turn.edits, "edit")} · ` : ""}{lines(turn)} · saved{turn.status === "undone"
                ? " · undone"
                : ""}</span
            >
          {:else if turn.status === "unchanged"}
            <p>{turn.summary || "Nothing needed to change."}</p>
            <span class="meta">no change</span>
          {:else if turn.status === "draft"}
            {#if turn.summary}<p>{turn.summary}</p>{/if}
            <span class="meta warn">{turn.error}</span>
          {:else if turn.status === "stopped"}
            <span class="meta"
              >{turn.after !== undefined && turn.after !== turn.before
                ? "cut off when the window closed — the edits that landed stay; Undo puts the note back"
                : "stopped — the note is as it was"}</span
            >
          {:else if turn.status === "kept"}
            <span class="meta">{turn.summary}</span>
          {:else}
            <span class="meta">{turn.error ?? "failed"} — the note is as it was</span>
          {/if}
        </div>
        {#if turn.status !== "running"}
          <div class="acts">
            {#if canUndo && canUndo.id === turn.id}
              <button
                class="undo"
                use:tip={"Put the note back as it was before this edit, and save"}
                disabled={disabled}
                onclick={() => void undoNoteEdit(scope, name, text)}>Undo</button
              >
            {/if}
            {#if turn.status !== "failed" && turn.status !== "unchanged" && (turn.status !== "stopped" || turn.after !== undefined)}
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
    <textarea
      bind:this={box}
      aria-label="What changed"
      rows="3"
      placeholder="What changed?"
      value={draft}
      oninput={(e) => setRequestDraft(key, (e.currentTarget as HTMLTextAreaElement).value)}
      {onkeydown}
    ></textarea>
    <div class="row">
      <label use:tip={"On: a line that is no longer true is struck through with today's date and the new line put beside it. Off: it is rewritten."}>
        <input type="checkbox" checked={strike} onchange={(e) => setStrike(key, (e.currentTarget as HTMLInputElement).checked)} />
        strike, don't delete
      </label>
      <span class="spacer"></span>
      {#if running}
        <button class="stop" onclick={() => void stopNoteEdit(key)}>Stop</button>
      {:else}
        <button class="send" disabled={disabled || !draft.trim()} onclick={send}>Send</button>
      {/if}
    </div>
    <span class="model">on {model} · reads and edits this file only</span>
  </footer>
</aside>

<style>
  .panel {
    width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--panel);
  }
  header {
    display: flex;
    align-items: center;
    padding: 0.45rem 0.7rem;
    border-bottom: 1px solid var(--border);
  }
  .title {
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .spacer {
    flex: 1;
  }
  .x {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 1rem;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .x:hover {
    color: var(--text);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.6rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .hint {
    margin: 0;
    color: var(--dim);
    font-size: 0.76rem;
    line-height: 1.5;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .ask {
    align-self: flex-end;
    max-width: 90%;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-radius: 12px;
    padding: 0.35rem 0.6rem;
    font-size: 0.8rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .said {
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text);
  }
  .said p {
    margin: 0 0 0.2rem;
  }
  .meta {
    color: var(--dim);
    font-size: 0.7rem;
  }
  .meta.warn,
  .said.bad .meta {
    color: var(--failed);
  }
  .working {
    color: var(--accent);
    font-size: 0.74rem;
  }
  .acts {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .undo,
  .send,
  .stop {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 0.18rem 0.5rem;
    cursor: pointer;
  }
  .undo:hover:not(:disabled),
  .stop:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .send:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .undo:disabled,
  .send:disabled,
  .link:disabled {
    opacity: 0.4;
    cursor: default;
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
  footer {
    border-top: 1px solid var(--border);
    padding: 0.5rem 0.7rem 0.45rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  textarea {
    resize: none;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.5rem;
    font-family: inherit;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: var(--dim);
    cursor: pointer;
  }
  .model {
    font-size: 0.64rem;
    color: var(--dim);
    opacity: 0.8;
  }
</style>
