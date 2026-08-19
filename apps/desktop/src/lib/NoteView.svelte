<script lang="ts">
  import * as api from "./api";
  import { app, addToast, closeNote, revealFolder, saveNote } from "./state.svelte";
  import { renderMarkdown } from "./markdown";

  /**
   * Which note the editor has loaded. A plain variable, not `$state`: it
   * exists to stop the load effect re-running, and making it reactive would
   * put the effect's own write in its dependency set.
   */
  let loaded: string | null = null;
  let text = $state("");
  let saved = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let preview = $state(false);

  const dirty = $derived(text !== saved);

  /**
   * Load whenever the sidebar points at a different note.
   *
   * Guarded on the name rather than run on every change, because `text` is
   * bound to the textarea: an effect that re-read on any state change would
   * discard what the user was typing on their own keystroke.
   */
  $effect(() => {
    const wanted = app.openNote;
    if (wanted === loaded) return;
    loaded = wanted;
    void load(wanted);
  });

  async function load(target: string | null) {
    text = "";
    saved = "";
    error = null;
    if (!target) return;
    loading = true;
    try {
      const content = await api.readNote(target);
      text = content;
      saved = content;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function commit() {
    const target = app.openNote;
    if (!target || !dirty) return;
    const pending = text;
    if (await saveNote(target, pending)) {
      saved = pending;
      addToast(`Saved ${target}`);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void commit();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="note">
  <header>
    <button class="back" onclick={closeNote}>← Chat</button>
    <span class="title">{app.openNote ?? "no note"}</span>
    {#if dirty}<span class="dirty" title="Unsaved changes">●</span>{/if}
    <span class="spacer"></span>
    <button
      class="ghost"
      class:on={preview}
      onclick={() => (preview = !preview)}
      disabled={!app.openNote}
    >
      {preview ? "Edit" : "Preview"}
    </button>
    <button
      class="ghost"
      title="Show the notes folder"
      onclick={() => void revealFolder(app.project?.notes_dir)}>Folder</button
    >
    <button class="save" onclick={() => void commit()} disabled={!dirty}>
      Save
    </button>
  </header>

  {#if error}
    <p class="err">{error}</p>
  {:else if loading}
    <p class="err quiet">Reading…</p>
  {:else if preview}
    <div class="pane preview markdown">{@html renderMarkdown(text)}</div>
  {:else}
    <textarea
      class="pane"
      bind:value={text}
      spellcheck="false"
      placeholder="Anything here is read by every chat in this project."
    ></textarea>
  {/if}

  <footer>
    Shared with every chat in <strong>{app.project?.name ?? "this project"}</strong
    >. The model sees this file's name and first line in its system prompt, and
    reads the rest with the file tools when it needs to.
  </footer>
</div>

<style>
  .note {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex-shrink: 0;
  }
  .back {
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 5px;
  }
  .back:hover {
    color: var(--text);
  }
  .title {
    font-family: var(--mono);
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.6rem;
  }
  .spacer {
    flex: 1;
  }
  .ghost,
  .save {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .ghost:hover:not(:disabled),
  .save:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--dim);
  }
  .ghost.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .ghost:disabled,
  .save:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .save:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--text);
  }
  textarea.pane {
    border: none;
    resize: none;
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.6;
  }
  textarea.pane:focus {
    outline: none;
  }
  .err {
    margin: 1rem 1.2rem;
    color: var(--error);
    font-size: 0.82rem;
  }
  .err.quiet {
    color: var(--dim);
  }
  footer {
    flex-shrink: 0;
    padding: 0.5rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--dim);
    font-size: 0.7rem;
    line-height: 1.45;
  }
  footer strong {
    color: var(--text);
    font-weight: 500;
  }
</style>
