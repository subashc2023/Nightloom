<script lang="ts">
  import {
    app,
    forgetProject,
    openProjectFolder,
    renameProject,
    revealFolder,
    showNewProject,
    useProject,
  } from "./state.svelte";
  import Icon from "./Icon.svelte";

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

  function make() {
    close();
    showNewProject();
  }

  async function pick() {
    close();
    await openProjectFolder();
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
            <span class="glyph"><Icon name="folder" size={14} /></span>
            <span class="txt">
              <span class="name">
                <span class="name-text">{p.name}</span>
                {#if !p.exists}<span class="ns-pill failed missing">folder missing</span>{/if}
              </span>
              <span class="meta">
                {p.chats} chat{p.chats === 1 ? "" : "s"} · {p.notes} note{p.notes ===
                1
                  ? ""
                  : "s"}
              </span>
            </span>
          </button>
          {#if app.project?.id === p.id}
            <span class="chk" aria-hidden="true"><Icon name="check" size={14} /></span>
          {/if}
          <div class="actions">
            <button
              class="icon"
              title="Rename"
              aria-label="Rename {p.name}"
              onclick={() => startRename(p.id, p.name)}><Icon name="pencil" size={13} /></button
            >
            <button
              class="icon"
              title={p.root ? "Show folder" : "Show notes folder"}
              aria-label="Show {p.name} folder"
              onclick={() => void revealFolder(p.root ?? p.notes_dir)}><Icon name="ext" size={13} /></button
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
              {#if confirming === p.id}<span class="ns-pill failed sure">remove?</span>{:else}<Icon name="x" size={13} />{/if}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="rule"></div>
  <button class="wide new" onclick={make} disabled={app.busy}>
    <Icon name="plus" size={14} />
    New project…
  </button>
  <button class="wide quiet" onclick={() => void pick()} disabled={app.busy}>
    <Icon name="folder" size={14} />
    Open project…
    <span class="wide-meta">a folder you already have</span>
  </button>
  {#if app.project}
    <button class="wide quiet" onclick={() => void choose(null)} disabled={app.busy}>
      <Icon name="chevl" size={14} />
      Leave project
      <span class="wide-meta">unfiled chats</span>
    </button>
  {/if}
  <div class="rule"></div>
  <p class="note">
    A project is a folder. Its shared notes live in <code>.agents</code> inside
    it and its standing instructions in <code>AGENTS.md</code> at the top — both
    yours to commit. The chats are kept outside, in
    <code>~/.nightloom/projects</code>.
  </p>
</div>

<style>
  /* Sidebar-wide, not the board's 330px: the sidebar clips its own overflow
     (App.svelte draws its grip and toggle outside it for that reason), so an
     overhanging menu would be cut at the pane's edge. */
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0.5rem;
    right: 0.5rem;
    z-index: 40;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .head {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 6px 8px 4px;
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
    gap: 4px;
    border-radius: 6px;
    padding-right: 4px;
  }
  .row:hover {
    background: var(--well);
  }
  /* The active row in the palette's accent (was a hard-coded violet,
     #211d38, from before the palettes — the one stale colour on these
     surfaces). */
  .row.active {
    background: var(--accent-soft);
  }
  .row.active .name-text {
    color: var(--accent-ink);
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 7px 8px;
    cursor: pointer;
  }
  .open:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .glyph {
    display: inline-flex;
    color: var(--dim);
    flex: none;
  }
  .txt {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .name-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .missing,
  .sure {
    font-size: 10px;
    padding: 0 6px;
    line-height: 1.6;
  }
  .meta {
    font-size: 11px;
    color: var(--dim);
    font-family: var(--mono);
    white-space: nowrap;
  }
  .chk {
    display: inline-flex;
    color: var(--accent);
    flex: none;
    padding: 0 4px;
  }
  .row.active:hover .chk {
    display: none;
  }
  /* Not laid out until hovered: in a 220px sidebar three reserved icon
     slots left the name eleven characters. */
  .actions {
    display: none;
    gap: 2px;
    flex-shrink: 0;
  }
  .row:hover .actions {
    display: flex;
  }
  .icon {
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--dim);
    cursor: pointer;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .icon:hover {
    color: var(--text);
    background: var(--paper);
  }
  .icon.remove:hover {
    color: var(--error);
  }
  .icon.remove.confirming {
    width: auto;
    background: transparent;
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
  .rule {
    height: 1px;
    background: var(--line);
    margin: 4px 2px;
  }
  .wide {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--ink2);
    font-family: inherit;
    font-size: 13px;
    padding: 7px 8px;
    cursor: pointer;
    text-align: left;
  }
  .wide:hover:not(:disabled) {
    background: var(--well);
  }
  .wide:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .wide.new {
    color: var(--accent);
  }
  .wide.quiet {
    color: var(--dim);
  }
  .wide-meta {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
  }
  .note {
    margin: 4px 8px 4px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--dim);
  }
  .note code {
    font-family: var(--mono);
    font-size: 0.94em;
    color: var(--ink2);
  }
</style>
