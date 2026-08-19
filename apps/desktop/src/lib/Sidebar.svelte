<script lang="ts">
  import {
    app,
    addProject,
    deleteSession,
    newSession,
    openSession,
  } from "./state.svelte";
  import { relativeTime } from "./time";
  import NotesPanel from "./NotesPanel.svelte";
  import ProjectMenu from "./ProjectMenu.svelte";

  // Two-click delete: the first click arms the button, the second deletes.
  let confirming = $state<string | null>(null);
  let menu = $state(false);

  function onDelete(id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    void deleteSession(id);
  }

  /**
   * The path, shortened from the left. A project root is usually deep and the
   * distinguishing part is the tail — `…/dev/Nightloom` identifies it where
   * `C:\Users\someone\code\…` does not.
   */
  function shortPath(path: string): string {
    return path.length <= 34 ? path : `…${path.slice(-33)}`;
  }
</script>

<aside class="sidebar">
  <div class="wordmark">nightloom</div>

  <div class="project">
    <button
      class="chip"
      class:unfiled={!app.project}
      aria-expanded={menu}
      onclick={() => (menu = !menu)}
      title={app.project?.root ?? "No project — chats are not tied to a folder"}
    >
      <span class="chip-main">
        <span class="chip-name">{app.project?.name ?? "No project"}</span>
        <span class="caret">⌄</span>
      </span>
      <span class="chip-path">
        {app.project ? shortPath(app.project.root) : "unfiled chats"}
      </span>
    </button>
    {#if menu}
      <!-- Click-away, not a modal: switching projects is a navigation, and a
           full-screen scrim for it would read as a decision. -->
      <button
        class="scrim"
        aria-label="Close project menu"
        onclick={() => (menu = false)}
      ></button>
      <ProjectMenu close={() => (menu = false)} />
    {/if}
  </div>

  <div class="tabs" role="tablist">
    <button
      role="tab"
      aria-selected={app.leftTab === "chats"}
      class:active={app.leftTab === "chats"}
      onclick={() => (app.leftTab = "chats")}
    >
      Chats
      {#if app.sessions.length > 0}<span class="count">{app.sessions.length}</span
        >{/if}
    </button>
    <button
      role="tab"
      aria-selected={app.leftTab === "notes"}
      class:active={app.leftTab === "notes"}
      onclick={() => (app.leftTab = "notes")}
    >
      Notes
      {#if app.notes.length > 0}<span class="count">{app.notes.length}</span>{/if}
    </button>
  </div>

  {#if app.leftTab === "chats"}
    <button class="new-chat" onclick={() => void newSession()} disabled={app.busy}>
      New chat
    </button>
    {#if app.sessions.length === 0}
      <p class="hint">
        No chats {app.project ? "in this project" : "yet"}.
        {#if !app.project}
          <br />Chats started without a project stay in the app's own folder —
          <button class="link" onclick={() => void addProject()}>
            open a folder
          </button>
          to share notes between them.
        {/if}
      </p>
    {:else}
      <div class="session-list">
        {#each app.sessions as s (s.id)}
          <div class="session-item" class:active={s.id === app.activeSessionId}>
            <button
              class="session-row"
              onclick={() => void openSession(s.id)}
              disabled={app.busy}
            >
              <span class="snippet">{s.first_user ?? "empty session"}</span>
              <span class="meta"
                >{s.id.slice(0, 8)} · {relativeTime(s.modified)}</span
              >
            </button>
            <button
              class="delete"
              class:confirming={confirming === s.id}
              title={confirming === s.id
                ? "Click again to delete"
                : "Delete session"}
              aria-label="Delete session"
              onclick={() => onDelete(s.id)}
              onmouseleave={() => confirming === s.id && (confirming = null)}
              disabled={app.busy}
            >
              {confirming === s.id ? "sure?" : "×"}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <NotesPanel />
  {/if}
</aside>

<style>
  .sidebar {
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .wordmark {
    color: var(--accent);
    font-size: 1.05rem;
    letter-spacing: 0.22em;
    padding: 1rem 1rem 0.6rem;
    user-select: none;
  }
  .project {
    position: relative;
    padding: 0 0.5rem 0.6rem;
  }
  .chip {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    background: #1b1830;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.55rem;
    cursor: pointer;
    color: var(--text);
    text-align: left;
    font-family: inherit;
  }
  .chip:hover {
    border-color: var(--accent);
  }
  .chip.unfiled {
    background: transparent;
  }
  .chip-main {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .chip-name {
    font-size: 0.88rem;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .caret {
    color: var(--dim);
    font-size: 0.8rem;
    flex-shrink: 0;
  }
  .chip-path {
    font-size: 0.68rem;
    color: var(--dim);
    font-family: var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: ltr;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    cursor: default;
  }
  .tabs {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.6rem;
  }
  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.75rem;
    padding: 0.4rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .count {
    font-size: 0.64rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .new-chat {
    margin: 0 0.75rem 0.6rem;
    padding: 0.45rem 0.75rem;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
    text-align: left;
  }
  .new-chat:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .new-chat:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    margin: 0;
    padding: 0 0.75rem;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .session-item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .session-item:hover {
    background: #1b1830;
  }
  .session-item.active {
    background: #211d38;
  }
  .session-row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .session-row:disabled {
    opacity: 0.6;
    cursor: default;
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
  .session-item:hover .delete {
    visibility: visible;
  }
  .delete:hover,
  .delete.confirming {
    color: var(--error);
  }
  .delete.confirming {
    font-size: 0.72rem;
  }
  .delete:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .snippet {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 0.72rem;
    color: var(--dim);
    font-family: var(--mono);
  }
</style>
