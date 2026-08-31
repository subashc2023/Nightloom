<script lang="ts">
  import {
    app,
    addProject,
    forgetProject,
    renameProject,
    revealFolder,
    useProject,
  } from "./state.svelte";

  let { close }: { close: () => void } = $props();

  // Two-click removal, like the session delete: the first click arms.
  let confirming = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let draftName = $state("");

  function startRename(id: string, name: string) {
    renaming = id;
    draftName = name;
    confirming = null;
  }

  async function commitRename() {
    const id = renaming;
    if (!id) return;
    renaming = null;
    const name = draftName.trim();
    if (name) await renameProject(id, name);
  }

  function onRemove(id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    void forgetProject(id);
  }

  async function choose(id: string | null) {
    close();
    await useProject(id);
  }

  async function pick() {
    close();
    await addProject();
  }
</script>

<div class="menu" role="menu">
  <div class="head">Projects</div>
  <div class="list">
    {#each app.projects as p (p.id)}
      <div class="row" class:active={app.project?.id === p.id}>
        {#if renaming === p.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            autofocus
            bind:value={draftName}
            onkeydown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") renaming = null;
            }}
            onblur={() => void commitRename()}
          />
        {:else}
          <button
            class="open"
            disabled={app.busy}
            onclick={() => void choose(p.id)}
            ondblclick={() => startRename(p.id, p.name)}
            title={p.root ?? "No folder — notes and chats only"}
          >
            <span class="name">
              {p.name}
              {#if !p.exists}<span class="missing">folder missing</span>{/if}
            </span>
            <span class="meta">
              {p.chats} chat{p.chats === 1 ? "" : "s"} · {p.notes} note{p.notes ===
              1
                ? ""
                : "s"}
            </span>
          </button>
          <div class="actions">
            <button
              class="icon"
              title="Rename"
              aria-label="Rename {p.name}"
              onclick={() => startRename(p.id, p.name)}>✎</button
            >
            <button
              class="icon"
              title={p.root ? "Show folder" : "Show notes folder"}
              aria-label="Show {p.name} folder"
              onclick={() => void revealFolder(p.root ?? p.notes_dir)}>↗</button
            >
            <button
              class="icon remove"
              class:confirming={confirming === p.id}
              title={confirming === p.id
                ? "Click again — removes it from this list only"
                : "Remove from list (deletes nothing)"}
              aria-label="Remove {p.name} from the list"
              onclick={() => onRemove(p.id)}
              onmouseleave={() => confirming === p.id && (confirming = null)}
            >
              {confirming === p.id ? "sure?" : "×"}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <button class="wide" onclick={() => void pick()} disabled={app.busy}>
    Choose a folder…
  </button>
  {#if app.project}
    <button class="wide quiet" onclick={() => void choose(null)} disabled={app.busy}>
      Leave project
    </button>
  {/if}
  <p class="note">
    A project is a folder. Its shared notes live in <code>.agents</code> inside
    it and its standing instructions in <code>AGENTS.md</code> at the top — both
    yours to commit. The chats are kept outside, in
    <code>~/.nightloom/projects</code>.
  </p>
</div>

<style>
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0.5rem;
    right: 0.5rem;
    z-index: 40;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .head {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--dim);
    padding: 0.25rem 0.4rem;
  }
  .list {
    display: flex;
    flex-direction: column;
    max-height: 15rem;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .row:hover {
    background: #1b1830;
  }
  .row.active {
    background: #211d38;
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 0.35rem 0.4rem;
    cursor: pointer;
  }
  .open:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .name {
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .missing {
    color: var(--error);
    font-size: 0.66rem;
    margin-left: 0.35rem;
  }
  .meta {
    font-size: 0.68rem;
    color: var(--dim);
  }
  .actions {
    display: flex;
    gap: 1px;
    flex-shrink: 0;
    visibility: hidden;
  }
  .row:hover .actions {
    visibility: visible;
  }
  .icon {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 0.78rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 4px;
  }
  .icon:hover {
    color: var(--text);
  }
  .icon.remove:hover,
  .icon.remove.confirming {
    color: var(--error);
  }
  .icon.remove.confirming {
    font-size: 0.66rem;
  }
  .rename {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.3rem 0.4rem;
    margin: 0.15rem;
    min-width: 0;
  }
  .rename:focus {
    outline: none;
  }
  .wide {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
    text-align: left;
  }
  .wide:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .wide:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .wide.quiet {
    border-color: transparent;
    color: var(--dim);
  }
  .note {
    margin: 0.2rem 0.4rem 0.3rem;
    font-size: 0.66rem;
    line-height: 1.45;
    color: var(--dim);
  }
  .note code {
    font-family: var(--mono);
    font-size: 0.94em;
  }
</style>
