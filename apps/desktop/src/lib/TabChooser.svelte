<script lang="ts">
  import { app, browseFree, defaultKind, KIND_LINES, kindLabel, newSession, openContent, saveNote } from "./state.svelte";
  import * as tabs from "./tabs";
  import type { ChatKind, Note, NoteScope } from "./types";
  import Icon from "./Icon.svelte";
  import { isMac } from "./platform";
  import { untrack } from "svelte";

  /**
   * The + chooser (nightshift backlog 140, 2026-09-17; blocker 195 for
   * its shape): a popover under the strip's `+`, listing what the new
   * tab can be — a new chat of either kind, a new note in either store,
   * the notes there are, the Nightshift page, the graph, and the projects
   * (a project opens as a card — blocker 193). Picking one opens it in a
   * new tab beside the active one (`openContent`, `"new"`), the way a
   * ⌘-click on the sidebar's row would; the singletons focus the tab
   * there is. ⌘T is unchanged: the one-key new chat.
   *
   * Drawn in the sidebar's kinds-popover idiom (`Sidebar.svelte`'s
   * `.kinds`), click-away to close, Escape too.
   */
  let { paneId, close }: { paneId: string; close: () => void } = $props();
  // The pane is fixed for the chooser's life: it closes on any click.
  const paneKey = untrack(() => paneId);

  const engine = $derived(app.connection?.engine ?? app.draft.engine);
  const KINDS: ChatKind[] = ["build", "chat"];

  /** The notes, newest first, capped — the sidebar has the whole list. */
  const NOTE_CAP = 6;
  function recent(list: Note[]): Note[] {
    return [...list].sort((a, b) => (a.modified < b.modified ? 1 : -1)).slice(0, NOTE_CAP);
  }
  const projectNotes = $derived(app.project ? recent(app.notes) : []);
  const vaultNotes = $derived(app.knowledge ? recent(app.vault) : []);

  async function pick(content: tabs.TabContent) {
    close();
    await openContent(content, "new");
  }

  async function newChat(kind: ChatKind) {
    close();
    // A new chat of a kind: through the same opener the sidebar's kind
    // rows use, landed as a new tab (one new-chat tab per pane).
    app.openNext = "new";
    await newSession(undefined, kind);
    app.openNext = "replace";
  }

  // New note: the row becomes a name field (the Notes panel's flow).
  let naming = $state<NoteScope | null>(null);
  let draftName = $state("");
  async function createNote() {
    const scope = naming;
    const name = draftName.trim();
    naming = null;
    if (!scope || !name) return;
    const full = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
    if (await saveNote(scope, full, "")) await pick({ kind: "note", scope, name: full });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (naming) naming = null;
      else close();
    }
  }

  /** Where the popover sits: under this pane's strip, at its left. Read
   *  once, when the chooser opens — it closes on any click. */
  const anchor = document.querySelector<HTMLElement>(`.pane[data-pane="${paneKey}"] .tab-strip`);
  const at = anchor?.getBoundingClientRect() ?? null;
</script>

<svelte:window onkeydown={onKey} />

<button class="tab-chooser-scrim" aria-label="Close" onclick={close}></button>
<div
  class="tab-chooser"
  role="menu"
  aria-label="New tab"
  style:left="{(at?.left ?? 0) + 8}px"
  style:top="{(at?.bottom ?? 36) + 4}px"
>
  <div class="tab-chooser-head">New tab · what it becomes</div>

  <div class="tab-chooser-sect">New chat <span class="tab-chooser-key">{isMac ? "⌘T" : "Ctrl+T"} is the default kind</span></div>
  {#each KINDS as k (k)}
    <button class="tab-chooser-row" role="menuitem" onclick={() => void newChat(k)} disabled={app.busy && !browseFree()}>
      <span class="tab-chooser-glyph" aria-hidden="true">{defaultKind() === k ? "●" : "○"}</span>
      <span class="tab-chooser-text">
        <span class="tab-chooser-name">{kindLabel(k, engine)}{#if defaultKind() === k} <span class="tab-chooser-tag">default here</span>{/if}</span>
        <span class="tab-chooser-line">{KIND_LINES[k]}</span>
      </span>
    </button>
  {/each}

  <div class="tab-chooser-sect">New note</div>
  {#each [["project", "in this project", !!app.project], ["knowledge", "in the knowledge base", !!app.knowledge]] as [scope, where, have] (scope)}
    {#if have}
      {#if naming === scope}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="tab-chooser-name-field"
          autofocus
          placeholder="note name"
          aria-label="Name of the new note {where}"
          bind:value={draftName}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void createNote();
            }
          }}
        />
      {:else}
        <button
          class="tab-chooser-row"
          role="menuitem"
          onclick={() => {
            naming = scope as NoteScope;
            draftName = "";
          }}
        >
          <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="note" size={13} /></span>
          <span class="tab-chooser-text"><span class="tab-chooser-name">New note {where}</span></span>
        </button>
      {/if}
    {/if}
  {/each}

  {#if projectNotes.length > 0 || vaultNotes.length > 0}
    <div class="tab-chooser-sect">Notes <span class="tab-chooser-key">newest first · the sidebar has them all</span></div>
    {#each projectNotes as n (`project:${n.name}`)}
      <button class="tab-chooser-row" role="menuitem" onclick={() => void pick({ kind: "note", scope: "project", name: n.name })}>
        <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="note" size={13} /></span>
        <span class="tab-chooser-text"><span class="tab-chooser-name">{n.name}</span>{#if n.summary}<span class="tab-chooser-line">{n.summary}</span>{/if}</span>
      </button>
    {/each}
    {#each vaultNotes as n (`knowledge:${n.name}`)}
      <button class="tab-chooser-row" role="menuitem" onclick={() => void pick({ kind: "note", scope: "knowledge", name: n.name })}>
        <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="note" size={13} /></span>
        <span class="tab-chooser-text"><span class="tab-chooser-name">{n.name} <span class="tab-chooser-tag">knowledge</span></span>{#if n.summary}<span class="tab-chooser-line">{n.summary}</span>{/if}</span>
      </button>
    {/each}
  {/if}

  <div class="tab-chooser-sect">Pages</div>
  <button class="tab-chooser-row" role="menuitem" onclick={() => void pick({ kind: "nightshift" })}>
    <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="moon" size={13} /></span>
    <span class="tab-chooser-text"><span class="tab-chooser-name">Nightshift</span><span class="tab-chooser-line">the open project's night runs, blockers, morning pages</span></span>
  </button>
  <button class="tab-chooser-row" role="menuitem" onclick={() => void pick({ kind: "graph" })}>
    <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="link" size={13} /></span>
    <span class="tab-chooser-text"><span class="tab-chooser-name">Graph</span><span class="tab-chooser-line">the notes and their links</span></span>
  </button>

  {#if app.projects.length > 0}
    <div class="tab-chooser-sect">Projects <span class="tab-chooser-key">a card; opening one resets the tabs</span></div>
    {#each app.projects as p (p.id)}
      <button class="tab-chooser-row" role="menuitem" onclick={() => void pick({ kind: "project", id: p.id })}>
        <span class="tab-chooser-glyph" aria-hidden="true"><Icon name="folder" size={13} /></span>
        <span class="tab-chooser-text"
          ><span class="tab-chooser-name">{p.name}{#if app.project?.id === p.id} <span class="tab-chooser-tag">open</span>{/if}</span><span class="tab-chooser-line"
            >{p.chats} chat{p.chats === 1 ? "" : "s"} · {p.notes} note{p.notes === 1 ? "" : "s"}</span
          ></span
        >
      </button>
    {/each}
  {/if}
</div>

<style>
  .tab-chooser-scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    cursor: default;
    padding: 0;
  }
  .tab-chooser {
    position: fixed;
    z-index: 36;
    width: 320px;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tab-chooser-head {
    padding: 6px 10px 4px;
    font-size: 11px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tab-chooser-sect {
    padding: 8px 10px 2px;
    font-size: 12px;
    color: var(--ink2);
    border-top: 1px solid var(--line);
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
  }
  .tab-chooser-sect:first-of-type {
    border-top: none;
    margin-top: 0;
  }
  .tab-chooser-key {
    font-size: 11px;
    color: var(--dim);
    text-align: right;
  }
  .tab-chooser-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    padding: 5px 8px;
    cursor: pointer;
  }
  .tab-chooser-row:hover:not(:disabled) {
    background: var(--well);
  }
  .tab-chooser-row:disabled {
    color: var(--dim);
    cursor: default;
  }
  .tab-chooser-glyph {
    display: inline-flex;
    width: 14px;
    justify-content: center;
    color: var(--dim);
    flex-shrink: 0;
    margin-top: 2px;
  }
  .tab-chooser-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .tab-chooser-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-chooser-line {
    font-size: 11px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-chooser-tag {
    font-size: 10px;
    color: var(--accent);
    margin-left: 4px;
  }
  .tab-chooser-name-field {
    margin: 2px 8px;
    padding: 5px 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
  }
</style>
