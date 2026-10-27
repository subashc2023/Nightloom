<script lang="ts">
  import { tip } from "./tip";
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
    startContentDrag,
    endContentDrag,
    showNote,
    stopCapture,
    stopDream,
  } from "./state.svelte";
  import type { Note, NoteScope } from "./types";
  import { relativeTime } from "./time";
  import * as api from "./api";
  import { onMount, tick, untrack } from "svelte";
  import { addToast } from "./state.svelte";
  import { carriesFiles } from "./dropLook";
  import { acceptFiles, conversionJobs } from "./attachFiles.svelte";
  import { discardDraft, readDraft } from "./drafts.svelte";
  import {
    holdKeptNotices,
    keepNow,
    keepStateOf,
    keeps,
    keptNotices,
    releaseKeptNotices,
    takeKeptNotices,
  } from "./keep.svelte";
  import {
    FLASH_MS,
    HOLD_LINE,
    Hold,
    centredScrollTop,
    flashPlan,
    holdTitle,
    keepDropped,
  } from "./notesDrop";
  import { foldQuery, hitsByScope, narrowNotes } from "./notesSearch";
  import { prefersReducedMotion } from "./chipFade";

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

  /**
   * Item 415: the search box. Names are matched here as he types; text by
   * the backend's note search, a moment after the typing pauses, its
   * answer used only while the box still holds the query it was asked.
   * The lists it narrows are re-searched when they change.
   */
  let query = $state("");
  let textHits = $state<{
    q: string;
    project: Set<string>;
    knowledge: Set<string>;
  } | null>(null);
  let searchSeq = 0;
  const searching = $derived(foldQuery(query) !== "");
  $effect(() => {
    const q = query.trim();
    void app.notes;
    void app.vault;
    const mine = ++searchSeq;
    if (!foldQuery(q)) {
      textHits = null;
      return;
    }
    const t = setTimeout(() => {
      api.searchEverywhere(q, "notes").then(
        (r) => {
          if (mine === searchSeq) textHits = { q, ...hitsByScope(r.notes) };
        },
        () => {},
      );
    }, 120);
    return () => clearTimeout(t);
  });
  function hitsFor(scope: "project" | "knowledge"): Set<string> | null {
    return textHits && textHits.q === query.trim() ? textHits[scope] : null;
  }
  const shownProject = $derived(narrowNotes(app.notes, query, hitsFor("project")));
  const shownVault = $derived(narrowNotes(app.vault, query, hitsFor("knowledge")));
  /** A section collapsed by hand opens while a search runs: the matches
   *  are what the box is for. */
  const shut = (scope: "project" | "knowledge") => collapsed[scope] && !searching;
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      query = "";
    }
  }

  /**
   * Item 416: after a keep (a drop here, or a chat chip's Keep), scroll
   * the kept file's row to the middle of the list and flash it — the
   * existing row when the file was already there. A search hiding it is
   * cleared first. Reduced motion: a jump and a still highlight.
   */
  let panelEl = $state<HTMLDivElement | null>(null);
  let flashing = $state<Set<string>>(new Set());
  let flashSeq = 0;
  $effect(() => {
    void keptNotices.seq;
    untrack(() => void reveal());
  });
  async function reveal() {
    const notices = takeKeptNotices();
    if (notices.length === 0) return;
    const plan = flashPlan(
      notices,
      app.notes.map((n) => n.name),
      performance.now(),
    );
    if (!plan.scrollTo) return;
    query = "";
    textHits = null;
    collapsed.project = false;
    await tick();
    const box = panelEl;
    const row = box?.querySelector<HTMLElement>(
      `[data-note="${CSS.escape(`project:${plan.scrollTo}`)}"]`,
    );
    if (!box || !row) return;
    const reduced = prefersReducedMotion();
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTo({
      top: centredScrollTop(box.scrollTop, r.top - b.top, r.height, box.clientHeight, box.scrollHeight),
      behavior: reduced ? "auto" : "smooth",
    });
    // Off, then on a frame later: a row still flashing from a keep a
    // moment ago starts its flash again. A timeout, not a frame callback,
    // which a window in the background never runs.
    const mine = ++flashSeq;
    flashing = new Set();
    await tick();
    setTimeout(() => {
      if (mine !== flashSeq) return;
      flashing = new Set(plan.flash.map((n) => `project:${n}`));
      setTimeout(() => mine === flashSeq && (flashing = new Set()), FLASH_MS + 150);
    }, 20);
  }

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

  /**
   * Item 391: files dropped on the Project section are kept in the
   * project, as attaching them and pressing Keep would (`notesDrop.ts`).
   * The section carries `data-drop-none`, so the window's drop watcher
   * (`dropLook.svelte.ts`) never takes this drop for a chat's box.
   */
  const hold = new Hold();
  let held = $state(false);
  let keeping = $state(0);
  const sync = () => (held = hold.held(performance.now()));
  onMount(() => {
    const t = setInterval(() => held && sync(), 500);
    const end = () => {
      hold.end();
      sync();
    };
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
    };
  });
  function onDragEnter(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    hold.enter(performance.now());
    sync();
  }
  function onDragOver(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    hold.over(performance.now());
    sync();
  }
  function onDragLeave(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    hold.leave();
    sync();
  }
  async function onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    hold.end();
    sync();
    if (files.length === 0) return;
    e.preventDefault();
    keeping += files.length;
    holdKeptNotices();
    try {
      await keepDropped(files, {
        project: () => app.project,
        toast: addToast,
        attach: acceptFiles,
        jobs: conversionJobs,
        chips: (k) => readDraft(k).attachments,
        state: keepStateOf,
        forget: (k) => delete keeps[k],
        keep: keepNow,
        discard: (k) => discardDraft(k),
      });
    } finally {
      keeping -= files.length;
      releaseKeptNotices();
    }
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
    <button class="row" onclick={() => showNote(scope, AGENTS_MD)} use:tip={hint}>
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
        use:tip={"The dream proposed a change to this file — review it as a diff"}
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
      <div
        class="item"
        class:active={isOpen(scope, n.name)}
        class:flash={flashing.has(`${scope}:${n.name}`)}
        data-note="{scope}:{n.name}"
      >
        <!-- Draggable (backlog 140 pass 2): onto a strip for a tab of
             this note at that slot, onto a pane's half to open it beside. -->
        <button
          class="row"
          onclick={(e) => {
            // ⌘-click opens the note in a new tab (nightshift backlog
            // 099, blocker 140); a plain click replaces the active one.
            if (e.metaKey || e.ctrlKey) app.openNext = "new";
            showNote(scope, n.name);
          }}
          draggable="true"
          ondragstart={(e) => startContentDrag(e, { kind: "note", scope, name: n.name })}
          ondragend={endContentDrag}
        >
          <span class="name">{n.name}</span>
          {#if n.summary}<span class="summary">{n.summary}</span>{/if}
          <span class="meta">{size(n.bytes)} · {relativeTime(n.modified)}</span>
        </button>
        <button
          class="delete"
          class:confirming={confirming === `${scope}:${n.name}`}
          use:tip={confirming === `${scope}:${n.name}`
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
      <input autocorrect="off" autocapitalize="off" spellcheck="false"
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
            use:tip={"reading the chats…"}
            onclick={() => void stopCapture()}>capturing… ✕</button
          >
        {:else}
          <button
            class="dream"
            use:tip={"Read the chats since the last capture into the memory inbox"}
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
            use:tip={app.dreamActivity
              ? `dreaming — ${app.dreamActivity}`
              : "dreaming…"}
            onclick={() => void stopDream()}>dreaming… ✕</button
          >
        {:else if app.dreamPending > 0}
          <button
            class="dream"
            use:tip={"Consolidate remembered observations into the vault"}
            onclick={() => void runDream()}>Dream · {app.dreamPending}</button
          >
        {/if}
        <button
          class="folder"
          use:tip={"Show the link graph — drag it onto a strip for a tab"}
          aria-label="Show the link graph"
          class:on={app.view === "graph"}
          onclick={showGraph}
          draggable="true"
          ondragstart={(e) => startContentDrag(e, { kind: "graph" })}
          ondragend={endContentDrag}>◈</button
        >
      {/if}
      <button
        class="folder"
        use:tip={"Show the folder"}
        aria-label="Show the folder"
        onclick={() =>
          void revealFolder(
            scope === "project" ? app.project?.notes_dir : app.knowledge?.dir,
          )}>↗</button
      >
    {/if}
  </div>
{/snippet}

<div class="panel" bind:this={panelEl}>
  <!-- Item 415: narrows both sections as he types; the pinned rows stay. -->
  <div class="find-bar">
    <input autocorrect="off" autocapitalize="off" spellcheck="false"
      class="find"
      type="search"
      placeholder="Search notes"
      aria-label="Search notes by name or text"
      bind:value={query}
      onkeydown={onSearchKey}
    />
  </div>
  <!-- The project's own notes. Absent rather than empty when nothing is
       open: there is no folder for them to be about. -->
  <section
    class="keep-drop"
    class:held
    role="group"
    aria-label="Project notes — drop files here to keep them in the project"
    data-drop-none
    data-notes-drop
    aria-busy={keeping > 0}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if held}
      <div class="hold" aria-hidden="true">
        <div class="words">
          <b>{holdTitle(app.project)}</b>
          {#if app.project && !app.project.unfiled}<span>{HOLD_LINE}</span>{/if}
        </div>
      </div>
    {/if}
    {#if keeping > 0}
      <p class="keeping" role="status">Keeping {keeping} {keeping === 1 ? "file" : "files"}…</p>
    {/if}
    <button
      class="head"
      onclick={() => (collapsed.project = !collapsed.project)}
      aria-expanded={!collapsed.project}
    >
      <span class="chev" class:shut={shut("project")}>▾</span>
      <span class="title">Project</span>
      {#if app.project}<span class="count"
          >{searching ? `${shownProject.length} of ${app.notes.length}` : app.notes.length}</span
        >{/if}
    </button>

    {#if !shut("project")}
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
        {:else if shownProject.length === 0}
          <p class="hint no-match">No notes match</p>
        {:else}
          {@render list("project", shownProject)}
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
      <span class="chev" class:shut={shut("knowledge")}>▾</span>
      <span class="title">Knowledge</span>
      <span class="count"
        >{searching ? `${shownVault.length} of ${app.vault.length}` : app.vault.length}</span
      >
      {#if app.knowledge}<span class="alias">{app.knowledge.alias}</span>{/if}
    </button>

    {#if !shut("knowledge")}
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
        {:else if shownVault.length === 0}
          <p class="hint no-match">No notes match</p>
        {:else}
          {@render list("knowledge", shownVault)}
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
  /* Item 415: held at the top while the list scrolls under it. */
  .find-bar {
    position: sticky;
    top: 0;
    z-index: 3;
    padding: 0.5rem 0.75rem 0.15rem;
    background: var(--paper);
  }
  .find {
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .find:focus {
    outline: none;
    border-color: var(--accent);
  }
  .find::placeholder {
    color: var(--dim);
  }
  .no-match {
    opacity: 0.8;
  }
  section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  /* Item 391: files held over the Project section — the composer's drop
     zone tokens (DropOverlay's `.zone.on`), drawn over the section so its
     rows do not move. Reduced motion: it comes and goes without fading. */
  .keep-drop {
    position: relative;
    border-radius: 12px;
  }
  .keep-drop.held {
    background: color-mix(in srgb, var(--accent-soft) 85%, transparent);
    box-shadow:
      inset 0 0 0 2px var(--accent),
      0 0 0 6px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .hold {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    padding: 0 0.75rem;
    text-align: center;
    border: 2px dashed var(--accent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent-soft) 85%, var(--paper));
    color: var(--accent-ink);
    font-size: 0.72rem;
    animation: hold-fade 140ms ease-out;
  }
  /* Near the head and held in view while the panel scrolls: a project
     with many kept files makes the section taller than the panel. */
  .hold .words {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 3.2rem 0 1rem;
  }
  .hold b {
    font-size: 0.9rem;
    font-weight: 500;
  }
  @media (prefers-reduced-motion: reduce) {
    .hold {
      animation: none;
    }
  }
  @keyframes hold-fade {
    from {
      opacity: 0;
    }
  }
  .keeping {
    margin: 0;
    padding: 0.3rem 0.75rem 0;
    font-size: 0.72rem;
    color: var(--dim);
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
  /* Item 416: a kept file's row, flashed with the accent for a second and
     faded back. Reduced motion: the highlight holds still, then goes. */
  .item.flash {
    animation: note-flash 1000ms ease-out;
  }
  @keyframes note-flash {
    0%,
    30% {
      background: color-mix(in srgb, var(--accent) 26%, transparent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    100% {
      background: transparent;
      box-shadow: inset 0 0 0 1px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .item.flash {
      animation: none;
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
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
