<script lang="ts">
  import {
    app,
    openProjectFolder,
    deleteNote,
    revealFolder,
    reviewProposal,
    runCapture,
    runDream,
    saveNote,
    showGraph,
    showNote,
    stopCapture,
    stopDream,
  } from "./state.svelte";
  import type { Note, NoteScope } from "./types";
  import { relativeTime } from "./time";
  import * as api from "./api";

  /**
   * Two stores, one panel.
   *
   * **Project** is `<workspace>/.agents` — about the code, committable, and
   * only there while a project is open. **Knowledge** is the user's own vault
   * — about them, the same one in every project, and present with no project
   * at all. That last part is the headline rather than a detail: the quickest
   * thing this app does is a chat with no folder, and until now that chat had
   * no notes of any kind.
   *
   * They are sections of one panel rather than a third sidebar tab because
   * the question "where did I write that down" has two answers and a user
   * should be able to see both without choosing first.
   */

  /** Which section is being created in, or null when nothing is. */
  let creating = $state<NoteScope | null>(null);
  let draftName = $state("");
  let confirming = $state<string | null>(null);
  /** Sections start open; collapsing is per-session and deliberately not
   *  persisted — it is a glance, not a preference. */
  let collapsed = $state<Record<"project" | "knowledge", boolean>>({
    project: false,
    knowledge: false,
  });

  /**
   * The always-loaded file at the head of each section — `AGENTS.md` in the
   * workspace (instructions) and in `~/.nightloom` (memory). Read whole into
   * every chat's preamble, so unlike the notes below it there is no index to
   * show; the row carries its size, or "empty" when the file does not exist
   * yet. Re-read whenever the lists refresh, which `saveNote` does after a
   * save and the turn loop does after every turn.
   */
  const AGENTS_MD = "AGENTS.md";
  let fixed = $state<Record<"instructions" | "memory", number | null>>({
    instructions: null,
    memory: null,
  });
  $effect(() => {
    // Dependencies the effect should re-run on, read up front.
    const projectId = app.project?.id ?? null;
    void app.notes;
    void app.vault;
    void (async () => {
      fixed.instructions = projectId
        ? await api.readNote("instructions", AGENTS_MD).then(
            (t) => t.length,
            () => null,
          )
        : null;
      fixed.memory = app.knowledge
        ? await api.readNote("memory", AGENTS_MD).then(
            (t) => t.length,
            () => null,
          )
        : null;
    })();
  });

  function begin(scope: "project" | "knowledge") {
    creating = scope;
    draftName = "";
    collapsed[scope] = false;
  }

  /**
   * Create the note and open it. `.md` is appended when the name has no
   * extension — both stores are markdown by convention and a note called
   * `decisions` should not become an extensionless file nobody's editor knows
   * what to do with.
   */
  async function create(scope: NoteScope) {
    const name = draftName.trim();
    creating = null;
    if (!name) return;
    const full = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
    if (await saveNote(scope, full, "")) showNote(scope, full);
  }

  /** Keyed by scope as well as name: the two stores can hold `plan.md` each,
   *  and a bare name would arm both delete buttons at once. */
  function onDelete(scope: NoteScope, name: string) {
    const key = `${scope}:${name}`;
    if (confirming !== key) {
      confirming = key;
      return;
    }
    confirming = null;
    void deleteNote(scope, name);
  }

  function isOpen(scope: NoteScope, name: string): boolean {
    return (
      app.view === "note" &&
      app.openNote?.scope === scope &&
      app.openNote.name === name
    );
  }

  function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }
</script>

{#snippet pinned(scope: "instructions" | "memory", label: string, hint: string)}
  <!-- No delete button: the never-lose-work rule, and the backend refuses
       it anyway — emptying the text is the reversible form. The badge is
       the dream's pending proposal for the file (a sibling of the row, not
       inside it — a button in a button is not HTML); it opens the same
       editor in proposal mode, and nothing is applied until Load and Save. -->
  <div class="item pinned" class:active={isOpen(scope, AGENTS_MD)}>
    <button class="row" onclick={() => showNote(scope, AGENTS_MD)} title={hint}>
      <span class="name">{label}</span>
      <span class="summary">{hint}</span>
      <span class="meta">
        {AGENTS_MD} ·
        {fixed[scope] === null
          ? "empty"
          : fixed[scope] === 0
            ? "empty"
            : size(fixed[scope] ?? 0)}
      </span>
    </button>
    {#if app.proposals[scope].length > 0}
      <button
        class="proposed"
        title="The dream proposed a change to this file — review it as a diff"
        aria-label="Review the proposed change to {label}"
        onclick={() => reviewProposal(scope)}
        >{app.proposals[scope].length} proposed</button
      >
    {/if}
  </div>
{/snippet}

{#snippet list(scope: NoteScope, notes: Note[])}
  <div class="list">
    {#each notes as n (n.name)}
      <div class="item" class:active={isOpen(scope, n.name)}>
        <button class="row" onclick={() => showNote(scope, n.name)}>
          <span class="name">{n.name}</span>
          {#if n.summary}<span class="summary">{n.summary}</span>{/if}
          <span class="meta">{size(n.bytes)} · {relativeTime(n.modified)}</span>
        </button>
        <button
          class="delete"
          class:confirming={confirming === `${scope}:${n.name}`}
          title={confirming === `${scope}:${n.name}`
            ? "Click again to delete this file"
            : "Delete note"}
          aria-label="Delete {n.name}"
          onclick={() => onDelete(scope, n.name)}
          onmouseleave={() =>
            confirming === `${scope}:${n.name}` && (confirming = null)}
        >
          {confirming === `${scope}:${n.name}` ? "sure?" : "×"}
        </button>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet newRow(scope: "project" | "knowledge")}
  <div class="bar">
    {#if creating === scope}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="new-name"
        autofocus
        placeholder="note name"
        bind:value={draftName}
        onkeydown={(e) => {
          if (e.key === "Enter") void create(scope);
          if (e.key === "Escape") creating = null;
        }}
        onblur={() => void create(scope)}
      />
    {:else}
      <button class="add" onclick={() => begin(scope)}>New note</button>
      {#if scope === "knowledge"}
        <!-- The Capture button is always there, unlike Dream's: the inbox
             count says nothing about what the chats hold, and the count on
             it — logs with something new since the last read — is never
             zero for long, since the chat open right now is one. -->
        {#if app.capturing}
          <button
            class="dream running"
            title="reading the chats…"
            onclick={() => void stopCapture()}>capturing… ✕</button
          >
        {:else}
          <button
            class="dream"
            title="Read the chats since the last capture into the memory inbox"
            disabled={app.dreaming}
            onclick={() => void runCapture()}>Capture · {app.capturePending}</button
          >
        {/if}
        <!-- The Dream button renders only with a backlog, the same rule as
             the CLI's startup line: an inbox with nothing in it needs no
             chrome, and a backlog the user cannot see is one that never
             gets consolidated. -->
        {#if app.dreaming}
          <button
            class="dream running"
            title={app.dreamActivity
              ? `dreaming — ${app.dreamActivity}`
              : "dreaming…"}
            onclick={() => void stopDream()}>dreaming… ✕</button
          >
        {:else if app.dreamPending > 0}
          <button
            class="dream"
            title="Consolidate remembered observations into the vault"
            onclick={() => void runDream()}>Dream · {app.dreamPending}</button
          >
        {/if}
        <button
          class="folder"
          title="Show the link graph"
          aria-label="Show the link graph"
          class:on={app.view === "graph"}
          onclick={showGraph}>◈</button
        >
      {/if}
      <button
        class="folder"
        title="Show the folder"
        aria-label="Show the folder"
        onclick={() =>
          void revealFolder(
            scope === "project" ? app.project?.notes_dir : app.knowledge?.dir,
          )}>↗</button
      >
    {/if}
  </div>
{/snippet}

<div class="panel">
  <!-- The project's own notes. Absent rather than empty when nothing is
       open: there is no folder for them to be about. -->
  <section>
    <button
      class="head"
      onclick={() => (collapsed.project = !collapsed.project)}
      aria-expanded={!collapsed.project}
    >
      <span class="chev" class:shut={collapsed.project}>▾</span>
      <span class="title">Project</span>
      {#if app.project}<span class="count">{app.notes.length}</span>{/if}
    </button>

    {#if !collapsed.project}
      {#if !app.project}
        <div class="empty">
          <p>
            Notes about the code live in the folder, so a teammate can read
            them and a diff can review them. Open a project to get a set.
          </p>
          <button class="pick" onclick={() => void openProjectFolder()}
            >Open a folder…</button
          >
        </div>
      {:else}
        {@render pinned(
          "instructions",
          "Instructions",
          "Standing instructions for this project — read whole into every chat",
        )}
        {@render newRow("project")}
        {#if app.notes.length === 0}
          <p class="hint">
            Nothing here yet. The model writes these with the file tools, and
            the index of the folder is in its system prompt — so a task list
            left here is still there in the next chat.
          </p>
        {:else}
          {@render list("project", app.notes)}
        {/if}
      {/if}
    {/if}
  </section>

  <!-- The vault. Shown whether or not a project is open, which is the whole
       point of it being separate. -->
  <section>
    <button
      class="head"
      onclick={() => (collapsed.knowledge = !collapsed.knowledge)}
      aria-expanded={!collapsed.knowledge}
    >
      <span class="chev" class:shut={collapsed.knowledge}>▾</span>
      <span class="title">Knowledge</span>
      <span class="count">{app.vault.length}</span>
      {#if app.knowledge}<span class="alias">{app.knowledge.alias}</span>{/if}
    </button>

    {#if !collapsed.knowledge}
      {#if !app.knowledge}
        <p class="hint">
          No user config directory on this machine, so there is nowhere to keep
          a knowledge base.
        </p>
      {:else}
        {@render pinned(
          "memory",
          "Memory",
          "How you want the model to behave, everywhere — read whole into every chat",
        )}
        {@render newRow("knowledge")}
        {#if app.vault.length === 0}
          <p class="hint">
            Yours, not this folder's — the same set in every project and in a
            chat with no project at all. Worth keeping here: a decision and why
            it was made, a person, something that took real work to figure out.
            Notes link to each other with <code>[[name]]</code>.
          </p>
        {:else}
          {@render list("knowledge", app.vault)}
        {/if}
      {/if}
    {/if}
  </section>
</div>

<style>
  .panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  /* A header the whole width so the hit target is the row, not the caret. */
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: none;
    padding: 0.5rem 0.75rem 0.4rem;
    cursor: pointer;
    color: var(--dim);
    font-family: inherit;
    text-align: left;
  }
  .head:hover {
    color: var(--text);
  }
  .chev {
    font-size: 0.6rem;
    transition: transform 0.12s ease;
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .title {
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .count {
    font-size: 0.68rem;
    opacity: 0.7;
  }
  /* The string the system prompt uses, so the panel and the model call the
     vault the same thing. */
  .alias {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.66rem;
    opacity: 0.5;
  }
  .empty {
    padding: 0.15rem 0.75rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .empty p,
  .hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .hint {
    padding: 0.1rem 0.75rem 0.75rem;
  }
  .hint code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .pick {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    text-align: left;
  }
  .pick:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .bar {
    display: flex;
    gap: 0.35rem;
    padding: 0 0.75rem 0.6rem;
  }
  .add {
    flex: 1;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    text-align: left;
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dream {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .dream:hover {
    border-color: var(--accent);
  }
  .dream.running {
    color: var(--dim);
    font-style: italic;
  }
  .dream:disabled {
    color: var(--dim);
    cursor: default;
  }
  .folder {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
  }
  .folder:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .folder.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .new-name {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
  }
  .new-name:focus {
    outline: none;
  }
  .list {
    padding: 0 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .item:hover {
    background: var(--well);
  }
  .item.active {
    background: #211d38;
  }
  /* The always-loaded file sits above the list, in the list's own gutter,
     with a hairline under it so it reads as the head of the section rather
     than the first note. */
  .item.pinned {
    margin: 0 0.5rem 0.35rem;
    border-bottom: 1px solid var(--line);
    border-radius: 8px 8px 0 0;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .name {
    font-size: 0.82rem;
    font-family: var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary {
    font-size: 0.72rem;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 0.68rem;
    color: var(--dim);
    opacity: 0.75;
  }
  /* "1 proposed" beside the pinned row: the accent, since it is the one
     thing in the panel waiting on the user. */
  .proposed {
    align-self: center;
    flex-shrink: 0;
    margin-right: 0.4rem;
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.66rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .proposed:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
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
  .item:hover .delete {
    visibility: visible;
  }
  .delete:hover,
  .delete.confirming {
    color: var(--error);
  }
  .delete.confirming {
    font-size: 0.72rem;
  }
</style>
