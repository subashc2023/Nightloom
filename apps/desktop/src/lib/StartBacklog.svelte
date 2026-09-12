<script lang="ts">
  /**
   * Start → Backlog (3.6): the ordered backlog on the left (drag to
   * reorder, locked while a shift is live), the selected item's full text
   * on the right — frontmatter facts, preface, each `## ` section, and the
   * Progress lines the runner appended.
   */
  import { app, newItem, paneWidth, reorderItems, saveItem, selectItem, setPaneWidth } from "./state.svelte";
  import * as api from "./api";
  import { renderMarkdown } from "./markdown";
  import { itemStatusPill } from "./nightshift";
  import BacklogList from "./BacklogList.svelte";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";

  let listWidth = $state(paneWidth("start.list", 340));
  let filterText = $state("");

  const itemList = $derived(app.nightshift.items);
  const items = $derived(itemList?.items ?? []);
  const order = $derived(itemList?.order ?? []);
  const errors = $derived(itemList?.errors ?? []);
  const row = $derived(app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null);
  const locked = $derived(row?.nightshift?.live ?? false);
  const selected = $derived(items.find((i) => i.id === app.nightshift.selectedItem) ?? null);

  // New item: a title and a kind, inline above the list. The body is left
  // for the editor — the interview that would fill it is item 005, not yet
  // built.
  let creating = $state(false);
  let newTitle = $state("");
  let newKind = $state<"research" | "build">("research");
  let creatingBusy = $state(false);
  async function create(): Promise<void> {
    if (!newTitle.trim() || creatingBusy) return;
    creatingBusy = true;
    const id = await newItem(newTitle.trim(), newKind);
    creatingBusy = false;
    if (id) {
      creating = false;
      newTitle = "";
      editing = true;
      void startEdit();
    }
  }

  // Edit: the whole file as text. An item is prose with a frontmatter, not
  // a form; the runner owns `## Progress`, so the hint says to leave it.
  let editing = $state(false);
  let editText = $state("");
  let editBusy = $state(false);
  async function startEdit(): Promise<void> {
    const proj = app.nightshift.selected;
    if (!proj || !selected) return;
    editText = "";
    editing = true;
    try {
      editText = await api.nightshiftReadFile(proj, `backlog/${selected.file}`);
    } catch (e) {
      editText = `(could not read ${selected.file}: ${String(e)})`;
    }
  }
  async function save(): Promise<void> {
    if (!selected || editBusy) return;
    editBusy = true;
    const ok = await saveItem(selected.id, editText);
    editBusy = false;
    if (ok) editing = false;
  }
  // Switching items leaves any edit.
  $effect(() => {
    void app.nightshift.selectedItem;
    editing = false;
  });
</script>

<div class="backlog" style:grid-template-columns="{listWidth}px 7px minmax(0,1fr)">
  <div class="list-col">
    {#if locked}
      <div class="lock">
        <span class="ns-pill live"><span class="dot"></span>locked while a shift runs</span>
      </div>
    {/if}
    <div class="filter-row">
      <input class="ns-fld" placeholder="filter…" bind:value={filterText} aria-label="Filter the backlog" />
      <button class="ns-btn small" disabled={locked} title="Scaffold a new backlog item" onclick={() => (creating = !creating)}>
        <Icon name="plus" />New
      </button>
    </div>
    {#if creating}
      <div class="new-item">
        <input
          class="ns-fld"
          placeholder="Title"
          aria-label="New item title"
          bind:value={newTitle}
          onkeydown={(e) => { if (e.key === "Enter") void create(); if (e.key === "Escape") creating = false; }}
        />
        <div class="new-row">
          <div class="kinds" role="radiogroup" aria-label="Kind">
            <button role="radio" aria-checked={newKind === "research"} class:on={newKind === "research"} onclick={() => (newKind = "research")}>research</button>
            <button role="radio" aria-checked={newKind === "build"} class:on={newKind === "build"} onclick={() => (newKind = "build")}>build</button>
          </div>
          <span class="spacer"></span>
          <button class="ns-btn small ghost" onclick={() => (creating = false)}>Cancel</button>
          <button class="ns-btn small accent" disabled={!newTitle.trim() || creatingBusy} onclick={() => void create()}>{creatingBusy ? "Creating…" : "Create"}</button>
        </div>
      </div>
    {/if}
    <div class="scroll">
      <BacklogList
        {items}
        {order}
        selectedId={app.nightshift.selectedItem}
        onSelect={selectItem}
        {locked}
        onReorder={(o) => void reorderItems(o)}
        {filterText}
      />
      {#each errors as e (e)}
        <p class="hint err">{e}</p>
      {/each}
    </div>
  </div>
  <Grip width={listWidth} min={240} max={520} edge="left" onchange={(w) => { listWidth = w; setPaneWidth("start.list", w); }} />

  <div class="main">
    {#if !selected}
      <p class="hint">Select an item.</p>
    {:else}
      <div class="head">
        <span class="ns-mono">{selected.id}</span>
        <span class="ns-pill {itemStatusPill(selected.status)}">{selected.status || "todo"}</span>
        <span class="ns-chip">{selected.kind}</span>
        <span class="spacer"></span>
        {#if editing}
          <button class="ns-btn small ghost" disabled={editBusy} onclick={() => (editing = false)}>Cancel</button>
          <button class="ns-btn small accent" disabled={editBusy} onclick={() => void save()}>{editBusy ? "Saving…" : "Save"}</button>
        {:else}
          <button class="ns-btn small" disabled={locked} title="Edit the item's file as text" onclick={() => void startEdit()}>
            Edit
          </button>
        {/if}
      </div>
      {#if editing}
        <div class="edit-hint">
          <span class="ns-mono">{selected.file}</span> — the whole file. Frontmatter and the sections are yours; leave <span class="ns-mono">## Progress</span> to the runner.
        </div>
        <textarea class="ns-fld editor" bind:value={editText} spellcheck="false"></textarea>
      {:else}
      <div class="ns-prose title"><h1>{selected.title}</h1></div>
      <div class="facts">
        <div class="fact"><span class="ns-k">Kind</span><span>{selected.kind}</span></div>
        <div class="fact"><span class="ns-k">Status</span><span>{selected.status || "—"}</span></div>
        <div class="fact"><span class="ns-k">Created</span><span class="ns-mono">{selected.created || "—"}</span></div>
        <div class="fact"><span class="ns-k">Source</span><span class="ns-mono">{selected.source || "—"}</span></div>
        <div class="fact"><span class="ns-k">Max passes</span><span class="ns-mono">{selected.max_passes}</span></div>
        <div class="fact"><span class="ns-k">Model</span><span class="ns-mono">{selected.model ?? "project default"}</span></div>
      </div>
      {#if selected.preface}
        <div class="ns-prose">{@html renderMarkdown(selected.preface)}</div>
      {/if}
      {#each selected.sections as sec (sec.title)}
        <div class="section">
          <div class="ns-k mb">{sec.title}</div>
          <div class="ns-prose">{@html renderMarkdown(sec.text)}</div>
        </div>
      {/each}
      {#if selected.progress.length > 0}
        <div class="section">
          <div class="ns-k mb">Progress</div>
          <ul class="progress ns-mono">
            {#each selected.progress as p, i (i)}<li>{p}</li>{/each}
          </ul>
        </div>
      {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .new-item {
    margin: 0 20px 8px;
    padding: 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--sheet);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .new-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .kinds {
    display: inline-flex;
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px;
    background: var(--well);
  }
  .kinds button {
    padding: 3px 9px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 12px;
    font-family: var(--sans);
    cursor: pointer;
  }
  .kinds button.on {
    background: var(--accent);
    color: var(--paper);
  }
  .spacer {
    flex: 1;
  }
  .edit-hint {
    font-size: 12px;
    color: var(--dim);
  }
  .editor {
    flex: 1;
    min-height: 60vh;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.5;
    resize: vertical;
    white-space: pre;
    overflow: auto;
  }
  .backlog {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }
  .list-col {
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .lock {
    padding: 10px 14px 0;
  }
  .filter-row {
    padding: 12px 14px 8px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .filter-row .ns-fld {
    flex: 1;
    min-width: 0;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  .hint {
    margin: 0;
    padding: 12px 20px;
    font-size: 13px;
    color: var(--dim);
  }
  .hint.err {
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
  }

  .main {
    overflow-y: auto;
    padding: 26px 36px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title {
    margin: 0;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 20px;
    padding: 14px 16px;
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mb {
    margin-bottom: 6px;
  }
  .section {
    display: flex;
    flex-direction: column;
  }
  .progress {
    margin: 0;
    padding-left: 1.2em;
    font-size: 12.5px;
    color: var(--ink2);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
</style>
