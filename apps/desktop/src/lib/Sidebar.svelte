<script lang="ts">
  import { app, newSession, openSession } from "./state.svelte";
  import { relativeTime } from "./time";
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
      <button
        class="session-row"
        class:active={s.id === app.activeSessionId}
        onclick={() => void openSession(s.id)}
        disabled={app.busy}
      >
        <span class="snippet">{s.first_user ?? "empty session"}</span>
        <span class="meta">{s.id.slice(0, 8)} · {relativeTime(s.modified)}</span>
      </button>
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
  .session-row {
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
  .session-row:hover:not(:disabled) {
    background: #1b1830;
  }
  .session-row.active {
    background: #211d38;
  }
  .session-row:disabled {
    opacity: 0.6;
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
