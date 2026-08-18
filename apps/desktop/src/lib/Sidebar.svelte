<script lang="ts">
  import { app, deleteSession, newSession, openSession } from "./state.svelte";
  import { relativeTime } from "./time";

  // Two-click delete: the first click arms the button, the second deletes.
  let confirming = $state<string | null>(null);

  function onDelete(id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    void deleteSession(id);
  }
</script>

<aside class="sidebar">
  <div class="wordmark">nightloom</div>
  <button
    class="new-chat"
    onclick={() => void newSession()}
    disabled={app.busy}
  >
    New chat
  </button>
  <div class="session-list">
    {#each app.sessions as s (s.id)}
      <div class="session-item" class:active={s.id === app.activeSessionId}>
        <button
          class="session-row"
          onclick={() => void openSession(s.id)}
          disabled={app.busy}
        >
          <span class="snippet">{s.first_user ?? "empty session"}</span>
          <span class="meta">{s.id.slice(0, 8)} · {relativeTime(s.modified)}</span>
        </button>
        <button
          class="delete"
          class:confirming={confirming === s.id}
          title={confirming === s.id ? "Click again to delete" : "Delete session"}
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
    padding: 1rem 1rem 0.75rem;
    user-select: none;
  }
  .new-chat {
    margin: 0 0.75rem 0.75rem;
    padding: 0.45rem 0.75rem;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
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
