<script lang="ts">
  import {
    app,
    addProject,
    addToast,
    deleteSession,
    newSession,
    openSession,
    refreshSessions,
  } from "./state.svelte";
  import * as api from "./api";
  import type { SessionHit } from "./types";
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

  // Inline rename. A name is generated once, from the first exchange, so a
  // long chat that has moved on keeps describing where it started; renaming
  // it automatically would mean guessing when a conversation has drifted,
  // which the user can see and the app cannot.
  let renaming = $state<string | null>(null);
  let draft = $state("");

  function startRename(id: string, current: string) {
    renaming = id;
    draft = current;
  }

  async function commitRename(id: string) {
    const name = draft.trim();
    renaming = null;
    // Unchanged or emptied is a cancel, not a rename: an empty name would
    // leave the row labelled by its opening message with no way back.
    if (!name) return;
    try {
      await api.renameSession(id, name);
      await refreshSessions();
    } catch (e) {
      addToast(String(e));
    }
  }

  // The search box. `query` is what is typed and `hits` is what came back;
  // an empty query means "not searching" rather than "everything matched",
  // so the list falls back to `app.sessions` on its own.
  let query = $state("");
  let hits = $state<SessionHit[] | null>(null);
  let searching = $state(false);

  // Debounced, because every keystroke would otherwise re-read every log in
  // the directory. `seq` is what makes a slow early request unable to
  // overwrite a fast later one — the results would be for a query nobody is
  // looking at any more.
  let seq = 0;
  $effect(() => {
    // Read so switching projects re-runs the search: `search_sessions` looks
    // in whichever log directory is open, and results from the folder you
    // just left would be rows that no longer list.
    void app.project?.id;
    const q = query.trim();
    if (!q) {
      hits = null;
      searching = false;
      return;
    }
    searching = true;
    const mine = ++seq;
    const timer = setTimeout(() => {
      void api
        .searchSessions(q)
        .then((found) => {
          if (mine !== seq) return;
          hits = found;
        })
        .catch(() => {
          if (mine === seq) hits = [];
        })
        .finally(() => {
          if (mine === seq) searching = false;
        });
    }, 180);
    return () => clearTimeout(timer);
  });

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
    {#if app.sessions.length > 0 || query}
      <input
        class="search"
        type="search"
        placeholder="Search chats"
        aria-label="Search chats"
        bind:value={query}
      />
    {/if}
    {#if hits !== null}
      <!-- Searching replaces the list rather than filtering it in place: the
           rows carry an excerpt and a hit count that the ordinary listing has
           nothing to put in. -->
      {#if hits.length === 0}
        <p class="hint">
          {searching ? "Searching…" : `Nothing mentions “${query.trim()}”.`}
        </p>
      {:else}
        <div class="session-list">
          {#each hits as s (s.id)}
            <div
              class="session-item"
              class:active={s.id === app.activeSessionId}
            >
              <button
                class="session-row"
                onclick={() => void openSession(s.id)}
                disabled={app.busy}
              >
                <span class="snippet"
                  >{s.title ?? s.first_user ?? "empty session"}</span
                >
                <span class="excerpt">{s.excerpt}</span>
                <span class="meta"
                  >{s.hits}
                  {s.hits === 1 ? "mention" : "mentions"} · {relativeTime(
                    s.modified,
                  )}</span
                >
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {:else if app.sessions.length === 0}
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
            {#if renaming === s.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="rename"
                aria-label="Session name"
                bind:value={draft}
                autofocus
                onblur={() => void commitRename(s.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") renaming = null;
                }}
              />
            {:else}
              <button
                class="session-row"
                onclick={() => void openSession(s.id)}
                ondblclick={() =>
                  startRename(s.id, s.title ?? s.first_user ?? "")}
                disabled={app.busy}
              >
                <span class="snippet"
                  >{s.title ?? s.first_user ?? "empty session"}</span
                >
                <span class="meta"
                  >{s.id.slice(0, 8)} · {relativeTime(s.modified)}</span
                >
              </button>
              <button
                class="rename-btn"
                title="Rename session"
                aria-label="Rename session"
                onclick={() => startRename(s.id, s.title ?? s.first_user ?? "")}
              >
                ✎
              </button>
            {/if}
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

  .search {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.4rem;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .search:focus {
    outline: none;
    border-color: var(--accent);
  }

  .search::placeholder {
    color: var(--dim);
  }

  /* Why the session matched. Wraps to two lines and stops: it is evidence,
     not the message. */
  .excerpt {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--dim);
  }

  .rename {
    flex: 1;
    min-width: 0;
    padding: 0.35rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 4px;
  }

  .rename:focus {
    outline: none;
  }

  .rename-btn {
    padding: 0 0.3rem;
    font-size: 0.75rem;
    color: var(--dim);
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0;
  }

  .session-item:hover .rename-btn,
  .rename-btn:focus-visible {
    opacity: 1;
  }

  .rename-btn:hover {
    color: var(--text);
  }
</style>
