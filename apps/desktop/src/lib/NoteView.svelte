<script lang="ts">
  import * as api from "./api";
  import {
    app,
    addToast,
    closeNote,
    dismissProposal,
    mirrorDraft,
    noteDraftKey,
    revealFolder,
    saveNote,
    showNote,
    stageProposal,
    unstageProposal,
  } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { unifiedDiff } from "./diff";
  import DiffView from "./DiffView.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import {
    hrefTarget,
    linkTitle,
    parseLinks,
    renderNote,
    resolveLink,
  } from "./links";
  import type { NoteResolution } from "./links";
  import { modelOfInstructionFile } from "./catalog";
  import type { NoteScope } from "./types";

  /**
   * Which note the editor has loaded, as `scope:name`. A plain variable, not
   * `$state`: it exists to stop the load effect re-running, and making it
   * reactive would put the effect's own write in its dependency set.
   *
   * Keyed by scope as well as name because the two stores can each hold a
   * `plan.md`, and switching between them must reload rather than look like
   * the same note.
   */
  /**
   * The note this view shows, when it is a pane's tab rather than the
   * centre's one open note (nightshift backlog 099): a note beside a chat
   * reads and saves as the open one does, keyed by its own scope and
   * name. Absent — every caller before tabs — the view follows
   * `app.openNote` as it always has.
   */
  let { note = null }: { note?: { scope: NoteScope; name: string } | null } = $props();

  let loaded: string | null = null;
  let text = $state("");
  let saved = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let preview = $state(false);

  const dirty = $derived(text !== saved);
  const open = $derived(note ?? app.openNote);
  const isVault = $derived(open?.scope === "knowledge");
  /**
   * Proposal mode: the dream suggested a replacement for this fixed file,
   * and the pane shows it as a diff against the saved text instead of the
   * editor. Only while the review is for the open scope — `showNote` clears
   * it on the way to any other note. The buffer is untouched until *Load
   * into editor*, which makes the proposed text a draft and nothing more.
   */
  const reviewing = $derived(
    app.proposalReview && open && app.proposalReview.scope === open.scope
      ? app.proposalReview
      : null,
  );
  const proposalDiff = $derived(
    reviewing
      ? unifiedDiff(saved === "" ? null : saved, reviewing.entry.proposal.text, open?.name ?? "AGENTS.md")
      : "",
  );
  /** Dismiss asks first: the badge goes with it, and a click must not lose
   *  something the user has not read (the never-lose-work rule). */
  let confirmDismiss = $state(false);
  /** A model's own instruction file: named after the id, read whole. */
  const isModel = $derived(open?.scope === "models");
  const modelId = $derived(isModel && open ? modelOfInstructionFile(open.name) : "");
  /**
   * The note whose text is in the buffer — set by `load` only once that
   * note's content is in `text` and `saved`, and cleared while a load is in
   * flight. Deliberately *not* derived from `open`: the selection changes a
   * tick before the buffer does, and an effect keyed on it wrote the
   * previous note's unsaved text as a draft under the next note's name.
   */
  let bufferKey = $state<string | null>(null);

  /**
   * Mirror the buffer into `app.noteDrafts` while it differs from the saved
   * text, and drop the entry once it matches again — so an edit typed and
   * then undone leaves no draft behind.
   */
  $effect(() => {
    const key = bufferKey;
    if (!key) return;
    mirrorDraft(key, text, saved);
  });

  /**
   * Links out of the note as it currently reads — from the buffer rather than
   * from the backend's graph, so a link typed a moment ago is already listed.
   * Only for the vault: the docspace has no link convention.
   *
   * Carries the whole resolution rather than a note-or-null, because the chip
   * has three states to draw and collapsing ambiguity into "missing" is what
   * offered to create a third copy of a note that already existed twice.
   */
  const outbound = $derived.by(() => {
    if (!isVault) return [];
    return parseLinks(text).map((l) => ({
      target: l.target,
      found: resolveLink(l.target, app.vault),
    }));
  });

  /**
   * Notes that link *to* this one — the half a file listing cannot show, and
   * most of why a vault is worth more than a folder.
   *
   * Read from the backend's graph rather than computed here, because it needs
   * the contents of every note in the vault and the frontend holds none of
   * them. It is therefore a snapshot: a backlink created by an unsaved edit
   * elsewhere is not in it, which cannot happen — there is one editor.
   */
  let backlinks = $state<string[]>([]);

  $effect(() => {
    const wanted = open ? `${open.scope}:${open.name}` : null;
    if (wanted === loaded) return;
    loaded = wanted;
    void load(open);
  });

  async function load(target: { scope: NoteScope; name: string } | null) {
    bufferKey = null;
    text = "";
    saved = "";
    error = null;
    backlinks = [];
    if (!target) return;
    loading = true;
    try {
      const content = await api.readNote(target.scope, target.name);
      const key = noteDraftKey(target.scope, target.name);
      saved = content;
      // A draft left on this note takes the buffer; the file stays the
      // saved baseline, so the ● and the Revert button say what differs.
      const draft = app.noteDrafts[key];
      text = draft !== undefined && draft !== content ? draft : content;
      bufferKey = key;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
    if (target.scope === "knowledge") void loadBacklinks(target.name);
  }

  async function loadBacklinks(name: string) {
    try {
      const graph = await api.knowledgeGraph();
      const index = graph.notes.findIndex((n) => n.name === name);
      if (index < 0) return;
      // Guarded on the note still being the open one: the graph is a round
      // trip, and clicking through two links quickly would otherwise leave
      // the first note's backlinks under the second.
      if (open?.name !== name) return;
      backlinks = graph.edges
        .filter((e) => e.to === index)
        .map((e) => graph.notes[e.from]?.name)
        .filter((n): n is string => !!n);
    } catch {
      backlinks = [];
    }
  }

  async function commit() {
    const target = open;
    if (!target || !dirty) return;
    const pending = text;
    if (await saveNote(target.scope, target.name, pending)) {
      saved = pending;
      addToast(`Saved ${target.name}`);
      if (target.scope === "knowledge") void loadBacklinks(target.name);
      // Opened from the popover or Settings: Save is the way back, as it is
      // for the prompt library (nightshift blocker 042), so the surface that
      // opened the file is what shows the result.
      if (app.noteFrom) closeNote();
    }
  }

  /** The folder this note is in. The models folder is not in app state —
   *  nothing else needs it — so it is asked for when the button is pressed. */
  async function showFolder() {
    if (!isModel) return revealFolder(folder);
    try {
      await revealFolder((await api.modelInstructionsDir()) ?? undefined);
    } catch (e) {
      addToast(String(e));
    }
  }

  /** Drop the draft: the buffer goes back to the last saved text. A
   *  proposal that was loaded is no longer what a Save would apply. */
  function revert() {
    if (!dirty) return;
    text = saved;
    if (bufferKey) unstageProposal(bufferKey);
  }

  /**
   * Load the proposal into the buffer as a draft. `stageProposal` writes
   * the draft entry and remembers which proposal it was; the buffer takes
   * the same text so ● draft, Revert and Save behave exactly as for typed
   * text. The file is not written here or anywhere but Save.
   */
  function loadProposal() {
    const r = reviewing;
    if (!r || !open) return;
    if (r.entry.proposal.text === saved) {
      addToast("The proposal matches the file as saved — nothing to load");
      app.proposalReview = null;
      return;
    }
    stageProposal(r.scope, r.entry, saved);
    text = r.entry.proposal.text;
  }

  async function confirmDismissal() {
    const r = reviewing;
    confirmDismiss = false;
    if (!r) return;
    if (await dismissProposal(r.scope, r.entry.id)) addToast("Proposal dismissed — kept under proposals/dismissed");
  }

  /**
   * Follow a `[[link]]` from the preview.
   *
   * Delegated from the pane rather than bound per anchor, because the HTML is
   * produced by the markdown renderer and there is nothing to bind to. A
   * target that resolves to nothing *creates* the note — writing `[[thing]]`
   * before it exists is how a note gets planned, so the click is the natural
   * moment to start it. An *ambiguous* one does not: the note it names already
   * exists more than once, and a third copy is the one outcome that makes the
   * vault worse.
   */
  async function onPreviewClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    const target = hrefTarget(anchor?.getAttribute("href") ?? null);
    if (target === null) return;
    e.preventDefault();
    await follow(target);
  }

  async function follow(target: string) {
    const found = resolveLink(target, app.vault);
    if (found.kind === "note") {
      showNote("knowledge", found.note.name);
      return;
    }
    // Nowhere to go and nothing to create: name the candidates and leave the
    // choice to the writer, who is the only one who knows which was meant.
    if (found.kind === "ambiguous") {
      addToast(linkTitle(target, found));
      return;
    }
    const name = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    if (await saveNote("knowledge", name, "")) showNote("knowledge", name);
  }

  /**
   * What an outbound chip's hover says. Only the missing case differs from the
   * preview's wording, because only this chip acts on it: clicking it writes
   * the note. The other two, ambiguity included, read the same everywhere.
   */
  function chipTitle(target: string, found: NoteResolution): string {
    return found.kind === "missing"
      ? `${target} — click to create`
      : linkTitle(target, found);
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void commit();
    }
  }

  const folder = $derived(
    isVault ? app.knowledge?.dir : app.project?.notes_dir,
  );
</script>

<svelte:window {onkeydown} />

<div class="note">
  <header>
    <button class="back" onclick={closeNote}>
      {app.noteFrom === "rail" ? "← Model" : app.noteFrom === "settings" ? "← Settings" : "← Chat"}
    </button>
    <span class="scope" class:vault={isVault}>
      {open?.scope ?? "project"}
    </span>
    <span class="title">{open?.name ?? "no note"}</span>
    {#if reviewing}<span class="proposed" title="The dream proposed a replacement; nothing is applied until you load it and save">proposed change</span>{/if}
    {#if dirty}<span class="dirty" title="Unsaved changes — kept as a draft until you save or revert">● draft</span>{/if}
    <span class="spacer"></span>
    {#if dirty}
      <button
        class="ghost revert"
        title="Discard the draft and go back to the last saved version"
        onclick={revert}>Revert</button
      >
    {/if}
    <button
      class="ghost"
      class:on={preview}
      onclick={() => (preview = !preview)}
      disabled={!open || !!reviewing}
    >
      {preview ? "Edit" : "Preview"}
    </button>
    <button
      class="ghost"
      title="Show the folder"
      onclick={() => void showFolder()}>Folder</button
    >
    <button class="save" onclick={() => void commit()} disabled={!dirty}>
      Save
    </button>
  </header>

  {#if error}
    <p class="err">{error}</p>
  {:else if loading}
    <p class="err quiet">Reading…</p>
  {:else if reviewing}
    <!-- The proposal: why, the diff, three ways out. The editor and its
         buffer are behind this, untouched, until Load into editor. -->
    <div class="review">
      <div class="why">
        <span class="label">why</span>
        <p>{reviewing.entry.proposal.why}</p>
        <span class="when">
          proposed by the dream · {new Date(reviewing.entry.proposal.at).toLocaleString()}
          {#if app.proposals[reviewing.scope].length > 1}
            · {app.proposals[reviewing.scope].length - 1} older pending
          {/if}
        </span>
      </div>
      <DiffView text={proposalDiff} leftLabel="as saved" rightLabel="proposed" />
      <div class="actions">
        <button
          class="load"
          title="Put the proposed text in the editor as a draft — Revert drops it, Save applies it"
          onclick={loadProposal}>Load into editor</button
        >
        <button
          class="ghost revert"
          title="Turn the proposal down — it is moved aside, not deleted"
          onclick={() => (confirmDismiss = true)}>Dismiss</button
        >
        <button class="ghost" title="Close for now; the badge stays" onclick={closeNote}
          >Keep for later</button
        >
      </div>
    </div>
  {:else if preview}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane preview markdown" onclick={onPreviewClick}>
      {#if isVault}
        {@html renderNote(text, app.vault)}
      {:else}
        {@html renderMarkdown(text)}
      {/if}
    </div>
  {:else}
    <!-- Named, so the field has an accessible name when it is empty (an
         unnamed empty textarea is invisible to assistive tech and to the
         driving tools alike — the prompt library's fields had the same fix). -->
    <textarea
      class="pane"
      aria-label="Note text"
      bind:value={text}
      spellcheck="false"
      placeholder={isVault
        ? "Yours, and readable from every project. Link another note with [[name]]."
        : isModel
          ? `How you want ${modelId} in particular to behave. Empty means no file.`
          : "Anything here is read by every chat in this project."}
    ></textarea>
  {/if}

  <!-- Links, both directions. Only for the vault: the docspace has no link
       convention, and an empty strip on every project note would be chrome
       that never says anything. -->
  {#if isVault && (outbound.length > 0 || backlinks.length > 0)}
    <div class="links">
      {#if outbound.length > 0}
        <div class="strip">
          <span class="label">links to</span>
          {#each outbound as l (l.target)}
            <button
              class="chip"
              class:broken={l.found.kind !== "note"}
              title={chipTitle(l.target, l.found)}
              onclick={() => void follow(l.target)}
              >{l.target}{l.found.kind === "ambiguous" ? " ⚠" : ""}</button
            >
          {/each}
        </div>
      {/if}
      {#if backlinks.length > 0}
        <div class="strip">
          <span class="label">linked from</span>
          {#each backlinks as name (name)}
            <button class="chip" onclick={() => showNote("knowledge", name)}
              >{name}</button
            >
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <footer>
    {#if open?.scope === "instructions"}
      Standing instructions for <strong>{app.project?.name ?? "this project"}</strong
      >. Read <em>whole</em> into every chat's system prompt — keep it short and
      specific; anything that is only sometimes relevant belongs in a note
      below, which the model reads on demand. Saving re-connects the open chat.
    {:else if open?.scope === "memory"}
      How you want the model to behave, in every project and in chats with no
      project. Read <em>whole</em> into every chat's system prompt — keep it
      short; facts and decisions worth keeping belong in the knowledge base,
      which the model reads on demand. Saving re-connects the open chat.
    {:else if isModel}
      Instructions for <strong>{modelId}</strong> and no other model, in every
      project. Read <em>whole</em> into the system prompt of a chat on that
      model, after your memory and before the project's instructions — for
      what you want of this model in particular; what applies to every model
      belongs in Memory. An empty file is the same as none. Saving re-connects
      the open chat.
    {:else if isVault}
      Yours, across every project — the model sees this file's name and first
      line in its system prompt and reads the rest with the file tools, at
      <code>@kb/{open?.name ?? ""}</code>.
    {:else}
      Shared with every chat in <strong>{app.project?.name ?? "this project"}</strong
      >. The model sees this file's name and first line in its system prompt, and
      reads the rest with the file tools when it needs to.
    {/if}
  </footer>
</div>

{#if confirmDismiss && reviewing}
  <ConfirmDialog
    title="Dismiss this proposal?"
    lead="The proposed text is moved to proposals/dismissed and the badge goes; the file is not touched either way."
    facts={[["for", reviewing.scope === "memory" ? "your memory" : `${app.project?.name ?? "this project"}'s instructions`]]}
    confirmLabel="Dismiss"
    onconfirm={() => void confirmDismissal()}
    onclose={() => (confirmDismiss = false)}
  />
{/if}

<style>
  .note {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex-shrink: 0;
  }
  .back {
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 5px;
  }
  .back:hover {
    color: var(--text);
  }
  /* Which store this note is in. Two of them can hold the same name, and the
     header is the only place that says which one is open. */
  .scope {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }
  .scope.vault {
    color: var(--accent);
    border-color: var(--accent);
  }
  .title {
    font-family: var(--mono);
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }
  /* The review's marker, in the scope chip's shape so the header reads
     "instructions · AGENTS.md · proposed change". */
  .proposed {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }
  .review {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .why {
    flex-shrink: 0;
    padding: 0.7rem 1.2rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .why p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--text);
  }
  .why .when {
    font-size: 0.68rem;
    color: var(--dim);
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    gap: 0.5rem;
    padding: 0.55rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
  }
  .load {
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 7px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  .load:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .spacer {
    flex: 1;
  }
  .ghost,
  .save {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .ghost:hover:not(:disabled),
  .save:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--dim);
  }
  .ghost.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* Revert discards typing: a red outline says so without a dialog (his
     call, 2026-09-14 — the draft is the safety net, not a confirmation). */
  .ghost.revert {
    color: var(--failed);
    border-color: #7a3d3f;
  }
  .ghost.revert:hover:not(:disabled) {
    color: var(--failed);
    border-color: var(--failed);
  }
  .ghost:disabled,
  .save:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .save:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--text);
  }
  textarea.pane {
    border: none;
    resize: none;
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.6;
  }
  textarea.pane:focus {
    outline: none;
  }
  .err {
    margin: 1rem 1.2rem;
    color: var(--error);
    font-size: 0.82rem;
  }
  .err.quiet {
    color: var(--dim);
  }
  .links {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 0.4rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .label {
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    opacity: 0.8;
    margin-right: 0.15rem;
  }
  .chip {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* A link to a note that does not exist yet. Dashed rather than red: it is
     how a note gets planned, not a mistake. */
  .chip.broken {
    border-style: dashed;
    color: var(--dim);
  }
  footer {
    flex-shrink: 0;
    padding: 0.5rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--dim);
    font-size: 0.7rem;
    line-height: 1.45;
  }
  footer strong {
    color: var(--text);
    font-weight: 500;
  }
  footer code {
    font-family: var(--mono);
  }

  /* Emitted by the markdown renderer, so scoped styles cannot reach it. */
  :global(.note .preview a.wikilink) {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    cursor: pointer;
  }
  :global(.note .preview a.wikilink.broken) {
    color: var(--dim);
    border-bottom-style: dashed;
  }
</style>
