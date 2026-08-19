<script lang="ts">
  import {
    app,
    addProject,
    deleteNote,
    revealFolder,
    saveNote,
    showNote,
  } from "./state.svelte";
  import { relativeTime } from "./time";

  let creating = $state(false);
  let draftName = $state("");
  let confirming = $state<string | null>(null);

  function begin() {
    creating = true;
    draftName = "";
  }

  /**
   * Create the note and open it. `.md` is appended when the name has no
   * extension — the docspace is markdown by convention and a note called
   * `decisions` should not become an extensionless file nobody's editor
   * knows what to do with.
   */
  async function create() {
    const name = draftName.trim();
    creating = false;
    if (!name) return;
    const full = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
    if (await saveNote(full, "")) showNote(full);
  }

  function onDelete(name: string) {
    if (confirming !== name) {
      confirming = name;
      return;
    }
    confirming = null;
    void deleteNote(name);
  }

  function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }
</script>

{#if !app.project}
  <div class="empty">
    <p>
      Notes are shared inside a project: every chat in the same folder reads
      the same set, and anything written there reaches later conversations.
    </p>
    <button onclick={() => void addProject()}>Choose a folder…</button>
  </div>
{:else}
  <div class="bar">
    {#if creating}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="new-name"
        autofocus
        placeholder="note name"
        bind:value={draftName}
        onkeydown={(e) => {
          if (e.key === "Enter") void create();
          if (e.key === "Escape") creating = false;
        }}
        onblur={() => void create()}
      />
    {:else}
      <button class="add" onclick={begin}>New note</button>
      <button
        class="folder"
        title="Show the notes folder"
        aria-label="Show the notes folder"
        onclick={() => void revealFolder(app.project?.notes_dir)}>↗</button
      >
    {/if}
  </div>

  {#if app.notes.length === 0}
    <p class="hint">
      Nothing here yet. The model can write notes with the file tools, and the
      index of this folder is in its system prompt — so a task list left here
      is still there in the next chat.
    </p>
  {:else}
    <div class="list">
      {#each app.notes as n (n.name)}
        <div class="item" class:active={app.view === "note" && app.openNote === n.name}>
          <button class="row" onclick={() => showNote(n.name)}>
            <span class="name">{n.name}</span>
            {#if n.summary}<span class="summary">{n.summary}</span>{/if}
            <span class="meta">{size(n.bytes)} · {relativeTime(n.modified)}</span>
          </button>
          <button
            class="delete"
            class:confirming={confirming === n.name}
            title={confirming === n.name
              ? "Click again to delete this file"
              : "Delete note"}
            aria-label="Delete {n.name}"
            onclick={() => onDelete(n.name)}
            onmouseleave={() => confirming === n.name && (confirming = null)}
          >
            {confirming === n.name ? "sure?" : "×"}
          </button>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .empty {
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .empty p,
  .hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .hint {
    padding: 0.25rem 0.75rem 0.75rem;
  }
  .empty button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    text-align: left;
  }
  .empty button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .bar {
    display: flex;
    gap: 0.35rem;
    padding: 0 0.75rem 0.6rem;
  }
  .add {
    flex: 1;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    text-align: left;
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .folder {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
  }
  .folder:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .new-name {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
  }
  .new-name:focus {
    outline: none;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .item:hover {
    background: #1b1830;
  }
  .item.active {
    background: #211d38;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .name {
    font-size: 0.82rem;
    font-family: var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary {
    font-size: 0.72rem;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 0.68rem;
    color: var(--dim);
    opacity: 0.75;
  }
  .delete {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 0.85rem;
    padding: 0 0.5rem;
    cursor: pointer;
    border-radius: 8px;
    flex-shrink: 0;
    visibility: hidden;
  }
  .item:hover .delete {
    visibility: visible;
  }
  .delete:hover,
  .delete.confirming {
    color: var(--error);
  }
  .delete.confirming {
    font-size: 0.72rem;
  }
</style>
