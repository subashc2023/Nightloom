<script lang="ts">
  /**
   * Start → Backlog (3.6): the ordered backlog on the left (drag to
   * reorder, locked while a shift is live), the selected item's full text
   * on the right — frontmatter facts, preface, each `## ` section, and the
   * Progress lines the runner appended.
   */
  import {
    app,
    cancelInterview,
    deleteItem,
    loadInterview,
    newItem,
    paneWidth,
    reorderItems,
    saveItem,
    selectItem,
    sendInterview,
    setPaneWidth,
    startInterview,
    writeInterviewItem,
  } from "./state.svelte";
  import { untrack } from "svelte";
  import * as api from "./api";
  import { renderMarkdown } from "./markdown";
  import { itemStatusPill } from "./nightshift";
  import BacklogList from "./BacklogList.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
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

  // New item is the intake interview (item 005): the idea in his words, the
  // interviewer's idea-level questions, his answers, then "Write the item".
  // The title-and-kind form below stays as "skip the interview".
  // The drawer's draft is app state (`interviewDraft`) so it survives a
  // trip to another screen; the conversation itself is the backend's.
  const draft = $derived(app.nightshift.interviewDraft);
  const interview = $derived(app.nightshift.interview);
  const hasDraft = $derived(!!interview || draft.idea.trim().length > 0);
  // The dock's height; the item view above it scrolls on its own.
  let dockHeight = $state(paneWidth("start.interview", 380));
  // The backend holds the interview; a screen that comes back mid-way
  // re-reads it and reopens the drawer.
  $effect(() => {
    void app.nightshift.selected;
    untrack(() => {
      void loadInterview().then(() => {
        if (app.nightshift.interview) app.nightshift.interviewDraft.open = true;
      });
    });
  });
  async function beginInterview(): Promise<void> {
    const idea = draft.idea.trim();
    if (!idea) return;
    const ok = await startInterview(idea);
    if (ok) draft.idea = "";
  }
  async function answer(): Promise<void> {
    const t = draft.reply.trim();
    if (!t || !interview || interview.busy) return;
    draft.reply = "";
    await sendInterview(t);
  }
  async function finishInterview(): Promise<void> {
    const id = await writeInterviewItem();
    if (id) {
      draft.open = false;
      editing = true;
      void startEdit();
    }
  }
  async function dropInterview(): Promise<void> {
    await cancelInterview();
    app.nightshift.interviewDraft = { open: false, idea: "", reply: "" };
  }
  /** Drop the selected item's path into whatever box is being typed in —
   *  the way to reference another item without leaving the drawer. */
  function mention(): void {
    if (!selected) return;
    const ref = `backlog/${selected.file}`;
    if (interview) draft.reply = draft.reply.trim() ? `${draft.reply.trimEnd()} ${ref} ` : `${ref} `;
    else draft.idea = draft.idea.trim() ? `${draft.idea.trimEnd()} ${ref} ` : `${ref} `;
  }
  // The transcript follows the reply as it streams.
  let transcriptEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    void interview?.streaming;
    void interview?.messages.length;
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });

  // Skip the interview: a title and a kind, inline above the list; the
  // body is left for the editor.
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
  /** The file as read, to tell a real edit from an untouched one. */
  let editOriginal = $state("");
  const editDirty = $derived(editing && editText !== editOriginal);
  // Unsaved edits are kept per item in app state (`editDrafts`): every
  // keystroke lands there, switching items leaves the draft where it is,
  // and coming back offers it ("Continue editing"). Save, Discard and
  // Delete are the only things that drop one.
  const draftFor = $derived(selected ? (app.nightshift.editDrafts[selected.id] ?? null) : null);
  $effect(() => {
    if (!editing || !selected) return;
    if (editText !== editOriginal) app.nightshift.editDrafts[selected.id] = editText;
    else delete app.nightshift.editDrafts[selected.id];
  });
  async function startEdit(resume = false): Promise<void> {
    const proj = app.nightshift.selected;
    if (!proj || !selected) return;
    // The draft is read before any state moves: the tracking effect above
    // writes `editText` back into the drafts, so blanking the box first
    // would overwrite the very draft being resumed.
    const draft = resume ? app.nightshift.editDrafts[selected.id] : undefined;
    let original: string;
    try {
      original = await api.nightshiftReadFile(proj, `backlog/${selected.file}`);
    } catch (e) {
      original = `(could not read ${selected.file}: ${String(e)})`;
    }
    editOriginal = original;
    editText = draft ?? original;
    editing = true;
  }
  async function save(): Promise<void> {
    if (!selected || editBusy) return;
    editBusy = true;
    const ok = await saveItem(selected.id, editText);
    editBusy = false;
    if (ok) editing = false;
  }
  // Cancel keeps a changed draft unless Discard is chosen explicitly.
  let confirmDiscard = $state(false);
  function cancelEdit(): void {
    if (editDirty) {
      confirmDiscard = true;
      return;
    }
    editing = false;
  }
  function discardEdit(): void {
    if (selected) delete app.nightshift.editDrafts[selected.id];
    confirmDiscard = false;
    editing = false;
  }
  // Switching items leaves the editor; the draft stays in app state.
  $effect(() => {
    void app.nightshift.selectedItem;
    editing = false;
  });

  // Delete: to backlog/trash/, behind a dialog; never unlinked.
  let confirmDelete = $state(false);
  let deleteBusy = $state(false);
  async function doDelete(): Promise<void> {
    if (!selected || deleteBusy) return;
    deleteBusy = true;
    const went = await deleteItem(selected.id);
    deleteBusy = false;
    if (went) confirmDelete = false;
  }
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
      <button class="ns-btn small" class:on={draft.open} disabled={locked} title="Describe an idea; the interviewer asks what only you can answer, then writes the item" onclick={() => { draft.open = !draft.open; creating = false; }}>
        <Icon name="plus" />New{#if hasDraft}<span class="ns-pill open draftpill">draft</span>{/if}
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

  <div class="main" class:docked={draft.open}>
   <div class="item-view">
    {#if !selected}
      <p class="hint">{draft.open ? "Select an item to read it beside the interview." : "Select an item."}</p>
    {:else}
      <div class="head">
        <span class="ns-mono">{selected.id}</span>
        <span class="ns-pill {itemStatusPill(selected.status)}">{selected.status || "todo"}</span>
        <span class="ns-chip">{selected.kind}</span>
        <span class="spacer"></span>
        {#if editing}
          {#if editDirty}<span class="ns-pill open"><span class="dot"></span>unsaved</span>{/if}
          <button class="ns-btn small ghost" disabled={editBusy} onclick={cancelEdit}>Cancel</button>
          <button class="ns-btn small accent" disabled={editBusy || !editDirty} onclick={() => void save()}>{editBusy ? "Saving…" : "Save"}</button>
        {:else}
          {#if draft.open}
            <button class="ns-btn small ghost" title="Put this item's path into the interview box" onclick={mention}>Mention</button>
          {/if}
          <button class="ns-btn small ghost" disabled={locked} title="Move the item's file to backlog/trash/ (nothing is unlinked)" onclick={() => (confirmDelete = true)}>
            Delete
          </button>
          <button class="ns-btn small" disabled={locked} title="Edit the item's file as text" onclick={() => void startEdit()}>
            Edit
          </button>
        {/if}
      </div>
      {#if !editing && draftFor != null}
        <div class="draft-banner">
          <span class="ns-pill open"><span class="dot"></span>unsaved edits from earlier</span>
          <span class="spacer"></span>
          <button class="ns-btn small accent" disabled={locked} onclick={() => void startEdit(true)}>Continue editing</button>
          <button class="ns-btn small ghost" onclick={() => (confirmDiscard = true)}>Discard</button>
        </div>
      {/if}
      {#if editing}
        <div class="edit-hint">
          <span class="ns-mono">{selected.file}</span> — the whole file. Frontmatter and the sections are yours; leave <span class="ns-mono">## Progress</span> to the runner.
        </div>
        <textarea class="ns-fld editor" bind:value={editText} aria-label="Item file" spellcheck="false"></textarea>
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
  {#if draft.open}
    <Grip width={dockHeight} min={220} max={900} edge="right" axis="y" onchange={(h) => { dockHeight = h; setPaneWidth("start.interview", h); }} />
    <aside class="dock" style:height="{dockHeight}px">
      <div class="head">
        <span class="ns-k">New item — the interview</span>
        {#if interview?.model}<span class="ns-chip">{interview.model}</span>{/if}
        <span class="spacer"></span>
        {#if !interview}
          <button class="ns-btn small ghost" title="Close the drawer; the idea text is kept as a draft" onclick={() => (draft.open = false)}>Close</button>
          <button class="ns-btn small ghost" title="A title and a kind, no interview" onclick={() => { draft.open = false; creating = true; }}>skip the interview</button>
        {:else}
          <button class="ns-btn small ghost" title="Close the drawer; the conversation is kept" onclick={() => (draft.open = false)}>Close</button>
          <button class="ns-btn small ghost" disabled={interview.busy} title="Forget the conversation" onclick={() => void dropInterview()}>Cancel</button>
          <button class="ns-btn small accent" disabled={interview.busy || locked || interview.messages.length < 2} title="The interviewer writes backlog/NNN-slug.md; the transcript is saved beside it" onclick={() => void finishInterview()}>
            {interview.busy ? "Working…" : "Write the item"}
          </button>
        {/if}
      </div>
      {#if !interview}
        <div class="edit-hint">
          Describe the idea in your own words — what it is, why, what done looks like. The interviewer asks only what it cannot guess: the idea, not the implementation. What you say and what it infers stay separate in the file.
        </div>
        <textarea class="ns-fld editor idea" bind:value={draft.idea} placeholder="The idea…" aria-label="The idea" spellcheck="true"
          onkeydown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void beginInterview(); }}></textarea>
        <div class="new-row">
          <span class="hint">⌘↵ to start</span>
          <span class="spacer"></span>
          <button class="ns-btn small accent" disabled={!draft.idea.trim() || locked} onclick={() => void beginInterview()}>Start the interview</button>
        </div>
      {:else}
        <div class="transcript" bind:this={transcriptEl}>
          {#each interview.messages as m, i (i)}
            <div class="turn {m.role}">
              <div class="ns-k who">{m.role === "user" ? "you" : "interviewer"}</div>
              <div class="ns-prose">{@html renderMarkdown(m.text)}</div>
            </div>
          {/each}
          {#if interview.streaming}
            <div class="turn assistant">
              <div class="ns-k who">interviewer</div>
              <div class="ns-prose">{@html renderMarkdown(interview.streaming)}</div>
            </div>
          {:else if interview.busy}
            <div class="turn assistant"><div class="ns-k who">interviewer</div><div class="hint">thinking…</div></div>
          {/if}
        </div>
        {#if interview.lastRefused}
          <div class="hint">The API refused that message (its safeguards classifier does this to ordinary text). <button class="linkish" onclick={() => { draft.reply = interview?.lastRefused ?? ""; if (interview) interview.lastRefused = undefined; }}>Put it back to rephrase</button></div>
        {/if}
        <div class="composer">
          <textarea class="ns-fld reply" bind:value={draft.reply} placeholder="Answer… (↵ to send, ⇧↵ newline)" aria-label="Your answer" disabled={interview.busy}
            onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void answer(); } }}></textarea>
          <button class="ns-btn small" disabled={!draft.reply.trim() || interview.busy} onclick={() => void answer()}>Send</button>
        </div>
      {/if}
    </aside>
  {/if}
</div>
</div>

{#if confirmDelete && selected}
  <ConfirmDialog
    title="Delete item {selected.id}?"
    lead={selected.title}
    facts={[
      ["goes to", `backlog/trash/${selected.file} — moved, not unlinked; a mistaken delete is a mv back`],
      ["also", "its interview transcript, if it has one; and its place in the order"],
      ["stays", "every note, blocker and shift that mentions it"],
    ]}
    confirmLabel="Delete to trash"
    busyLabel="Deleting…"
    busy={deleteBusy}
    onconfirm={() => void doDelete()}
    onclose={() => (confirmDelete = false)}
  />
{/if}
{#if confirmDiscard && selected}
  <ConfirmDialog
    title="Discard the unsaved edits to {selected.id}?"
    lead="The file on disk stays as it was; only the text typed since is dropped."
    confirmLabel="Discard edits"
    onconfirm={discardEdit}
    onclose={() => (confirmDiscard = false)}
  />
{/if}

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
  .draft-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--sheet);
  }
  .main.docked {
    padding: 0;
    overflow: hidden;
  }
  .main.docked .item-view {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 26px 36px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .main:not(.docked) .item-view {
    display: contents;
  }
  .dock {
    flex: none;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 24px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid var(--line);
    background: var(--sheet);
  }
  /* The idea is prose, not a file: it wraps and takes the UI font. */
  .idea {
    min-height: 120px;
    flex: 1;
    font-family: inherit;
    font-size: 13.5px;
    white-space: pre-wrap;
  }
  .draftpill {
    margin-left: 6px;
  }
  .ns-btn.on {
    border-color: var(--accent);
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 4px 2px;
  }
  .turn {
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--sheet);
  }
  .turn.user {
    background: var(--paper);
  }
  .turn .who {
    margin-bottom: 6px;
  }
  .linkish {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-ink);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .composer .reply {
    flex: 1;
    min-height: 44px;
    max-height: 160px;
    resize: vertical;
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
