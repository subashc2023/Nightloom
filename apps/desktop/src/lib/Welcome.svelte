<script lang="ts">
  import {
    app,
    addProject,
    importFromClaude,
    revealFolder,
    showNote,
    useProject,
  } from "./state.svelte";
  import Composer from "./Composer.svelte";
  import { relativeTime } from "./time";

  /** Recent projects other than the open one, for one-click switching. */
  const others = $derived(
    app.projects.filter((p) => p.id !== app.project?.id).slice(0, 4),
  );

  /** The notes worth surfacing here: what a new chat in this project inherits. */
  const inherited = $derived(app.notes.slice(0, 4));
</script>

<div class="welcome">
  <div class="card">
    {#if app.project}
      <h1>{app.project.name}</h1>
      <button
        class="path"
        title={app.project.root ? "Show this folder" : "Show the notes folder"}
        onclick={() => void revealFolder(app.project?.root ?? app.project?.notes_dir)}
      >
        {app.project.root ?? "No folder — notes and chats only"} ↗
      </button>
      {#if !app.project.exists}
        <p class="warn">
          That folder is not there right now. Tools rooted at it will fail until
          it comes back.
        </p>
      {/if}
    {:else}
      <h1>New chat</h1>
    {/if}

    {#if app.error}
      <p class="warn">{app.error}</p>
    {/if}

    <div class="composer-slot">
      <Composer floating />
    </div>

    <!-- What the next chat inherits, shown as the notes themselves rather
         than as a sentence about them. Nothing renders when there are none:
         an empty docspace is explained by the Notes tab, not here. -->
    {#if app.project && inherited.length > 0}
      <div class="notes">
        <button
          class="notes-head"
          title="Show the notes folder"
          onclick={() => void revealFolder(app.project?.notes_dir)}
        >
          Notes ↗
        </button>
        {#each inherited as n (n.name)}
          <button class="note" onclick={() => showNote(n.name)} title={n.summary ?? n.name}>
            {n.name}
          </button>
        {/each}
        {#if app.notes.length > inherited.length}
          <button class="note more" onclick={() => (app.leftTab = "notes")}>
            +{app.notes.length - inherited.length}
          </button>
        {/if}
      </div>
    {/if}

    {#if !app.project}
      <button class="primary" onclick={() => void addProject()}>
        Choose a folder…
      </button>
    {/if}

    <button class="import" onclick={() => void importFromClaude()}>
      Import from Claude…
    </button>
    <span class="import-note">
      Turns a claude.ai export into projects: instructions, knowledge and chats.
    </span>

    {#if others.length > 0}
      <div class="recent">
        <span class="recent-head">
          {app.project ? "Switch to" : "Recent"}
        </span>
        {#each others as p (p.id)}
          <button
            class="recent-row"
            disabled={app.busy}
            onclick={() => void useProject(p.id)}
            title={p.root ?? "No folder — notes and chats only"}
          >
            <span class="recent-name">{p.name}</span>
            <span class="recent-meta">
              {p.chats} chat{p.chats === 1 ? "" : "s"} · {relativeTime(p.last_opened)}
            </span>
          </button>
        {/each}
        {#if app.project}
          <button class="recent-row quiet" onclick={() => void addProject()}>
            <span class="recent-name">Choose another folder…</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .import {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.8rem;
    color: var(--dim);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .import:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .import-note {
    font-size: 0.75rem;
    color: var(--dim);
    max-width: 30rem;
    text-align: center;
  }
  .welcome {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  .card {
    width: 100%;
    max-width: 34rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .path {
    align-self: flex-start;
    background: transparent;
    border: none;
    padding: 0;
    margin: -0.6rem 0 0;
    color: var(--dim);
    font-family: var(--mono);
    font-size: 0.74rem;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .path:hover {
    color: var(--accent);
  }
  .warn {
    margin: 0;
    color: var(--error);
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .composer-slot {
    margin-top: 0.2rem;
  }
  .primary {
    align-self: flex-start;
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 9px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.86rem;
    padding: 0.45rem 0.8rem;
    cursor: pointer;
  }
  .primary:hover {
    background: #8b7cf614;
  }

  /* One row: a label that is also the folder link, then the notes. */
  .notes {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
  }
  .notes-head {
    background: transparent;
    border: none;
    padding: 0 0.25rem 0 0;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    cursor: pointer;
  }
  .notes-head:hover {
    color: var(--accent);
  }
  .note {
    max-width: 100%;
    background: #1b1830;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.22rem 0.5rem;
    cursor: pointer;
    color: var(--text);
    font-family: var(--mono);
    font-size: 0.72rem;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note:hover {
    border-color: var(--accent);
  }
  .note.more {
    background: transparent;
    color: var(--dim);
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-top: 1px solid var(--border);
    padding-top: 0.7rem;
  }
  .recent-head {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--dim);
    padding: 0 0.1rem 0.25rem;
  }
  .recent-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    background: transparent;
    border: none;
    border-radius: 7px;
    padding: 0.3rem 0.4rem;
    cursor: pointer;
    color: var(--text);
    text-align: left;
    font-family: inherit;
    min-width: 0;
    max-width: 100%;
  }
  .recent-row:hover {
    background: #1b1830;
  }
  .recent-row:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .recent-row.quiet .recent-name {
    color: var(--dim);
  }
  .recent-name {
    font-size: 0.83rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .recent-meta {
    font-size: 0.68rem;
    color: var(--dim);
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
  }
</style>
