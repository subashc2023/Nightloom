<script lang="ts">
  import { tip } from "./tip";
  import {
    app,
    closeNewProject,
    createNewProject,
    discardNewProject,
    pickNewProjectFolder,
    resolveNewProjectPath,
  } from "./state.svelte";
  import type { NewProjectPath } from "./types";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import { isMac } from "./platform";

  /**
   * New project… (backlog 047, 2026-09-14). A screen in Welcome's place
   * rather than a folder picker: "when you're making a new project, you
   * pretty much have nothing to go off of" — so it asks for a name, shows
   * where the folder will go, and takes the first lines of instructions.
   * Create makes the folder, writes `AGENTS.md` when there is text, registers
   * and opens. No dialog appears. A folder that already exists is *Open
   * project…*, the picker this used to be.
   *
   * The draft is `app.newProjectDraft`, not component state: Escape, a
   * click on a chat, a project switch all leave the form with everything
   * typed still in it. Only Create and Discard clear it.
   */

  const d = $derived(app.newProjectDraft);
  const dirty = $derived(d.name !== "" || d.instructions !== "" || d.pickedPath !== null);

  // The folder row, resolved by the backend for the name as typed — the
  // slug rule lives in Rust, once, so the preview and the folder Create
  // makes cannot disagree. A stale answer from an earlier keystroke is
  // dropped by the sequence number.
  let resolved = $state<NewProjectPath | null>(null);
  let seq = 0;
  $effect(() => {
    const name = d.name;
    const mine = ++seq;
    void resolveNewProjectPath(name).then(
      (r) => {
        if (mine === seq) resolved = r;
      },
      () => {
        if (mine === seq) resolved = null;
      },
    );
  });

  const nameGiven = $derived(d.name.trim() !== "");
  const noSlug = $derived(nameGiven && resolved !== null && resolved.slug === "");
  /** What the folder row shows: the picked folder, else the resolved path,
   *  else — before a name is typed, or with one that makes no slug — the
   *  projects folder itself with a trailing slash, where the slug will go
   *  (backlog 103: it read "…" until the first keystroke). */
  const shownPath = $derived(
    d.pickedPath ?? (resolved?.path || (resolved?.folder ? `${resolved.folder}/` : "")),
  );
  const canCreate = $derived(nameGiven && (d.pickedPath !== null || (resolved !== null && resolved.slug !== "")));
  const reason = $derived.by(() => {
    if (!nameGiven) return "Made under the projects folder when you click Create.";
    if (d.pickedPath) return "Your folder, as it is — files already there stay. Instructions are written only if it has no AGENTS.md.";
    if (noSlug) return "The name needs at least one letter or digit to make a folder from.";
    if (resolved) return `Made under ${resolved.folder} when you click Create — the projects folder, set in Settings.`;
    return "";
  });

  let creating = $state(false);
  let confirmDiscard = $state(false);
  const mod = isMac ? "⌘" : "Ctrl+";

  async function create() {
    if (!canCreate || creating) return;
    creating = true;
    try {
      await createNewProject();
    } finally {
      creating = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    // The overlays and the confirmation own their own Escape.
    if (app.overlay || confirmDiscard) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeNewProject();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void create();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="np">
  <header>
    <button class="back" onclick={closeNewProject}>← Chat</button>
    <span class="scope">project</span>
    <span class="title">New project</span>
    {#if dirty}<span class="dirty" use:tip={"Kept if you leave — only Create or Discard drops it"}>● draft</span>{/if}
    <span class="spacer"></span>
    {#if dirty}
      <button class="ghost revert" use:tip={"Drop what is typed here"} onclick={() => (confirmDiscard = true)}>Discard</button>
    {/if}
    <button class="ghost" use:tip={"Back to the chat; what is typed stays (Esc)"} onclick={closeNewProject}>Cancel</button>
    <button class="save" disabled={!canCreate || creating || app.busy} use:tip={`Make the folder and open the project (${mod}↵)`} onclick={() => void create()}>
      {creating ? "Creating…" : "Create"}
    </button>
  </header>

  <div class="body">
    <div class="col">
      <!-- The name centred, label and text (backlog 103): the one thing the
           form is really asking for, in the middle of the column. -->
      <label class="field centred">
        <span class="lab">Name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name"
          type="text"
          autofocus
          value={d.name}
          oninput={(e) => (app.newProjectDraft.name = e.currentTarget.value)}
          placeholder="What this project is"
          aria-label="Project name"
          spellcheck="false"
        />
      </label>

      <div class="field">
        <span class="lab">Folder</span>
        <div class="folder" class:picked={d.pickedPath !== null} class:bad={noSlug}>
          <Icon name="folder" size={13} />
          <code class="path">{shownPath || "—"}</code>
          <button class="ghost small" use:tip={"Use a folder you already have instead"} onclick={() => void pickNewProjectFolder()}>Change…</button>
          {#if d.pickedPath !== null}
            <button class="ghost small" use:tip={"Back to a folder made under the projects folder"} onclick={() => (app.newProjectDraft.pickedPath = null)}>Use the projects folder</button>
          {/if}
        </div>
        <p class="hint" class:bad={noSlug}>{reason}</p>
      </div>

      <!-- A third of its old height (backlog 103), resizable downward by
           its own corner; the box no longer grows to fill the column. -->
      <label class="field">
        <span class="lab">Instructions <span class="opt">optional</span></span>
        <textarea
          value={d.instructions}
          oninput={(e) => (app.newProjectDraft.instructions = e.currentTarget.value)}
          placeholder="How you want the model to work in this project. Read whole into every chat here."
          aria-label="Project instructions"
          spellcheck="false"
        ></textarea>
        <p class="hint">
          Becomes the project's <code>AGENTS.md</code> — the one file every chat
          in it starts with. Empty means no file; you can write one later from
          the Notes tab.
        </p>
      </label>

      <!-- The same two buttons as the header's, under Instructions (backlog
           103, his "have it in both spots"; blocker 233's board A): Create
           filled in the accent. Both pairs do exactly the same thing. -->
      <div class="foot-actions">
        <button class="ns-btn" use:tip={"Back to the chat; what is typed stays (Esc)"} onclick={closeNewProject}>Cancel</button>
        <button
          class="ns-btn accent"
          disabled={!canCreate || creating || app.busy}
          use:tip={`Make the folder and open the project (${mod}↵)`}
          onclick={() => void create()}
        >
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  </div>

  <footer>
    Already have a folder — cloned, imported, or just not on the list?
    <strong>Open project…</strong> (<kbd>{mod}O</kbd>, or O in <kbd>{mod}P</kbd>)
    makes it a project as it is.
  </footer>
</div>

{#if confirmDiscard}
  <ConfirmDialog
    title="Discard this draft?"
    lead="The name, the folder and the instructions typed here go. Nothing on disk is touched — no folder has been made yet."
    facts={d.name.trim() ? [["name", d.name.trim()]] : []}
    confirmLabel="Discard"
    onconfirm={() => {
      confirmDiscard = false;
      discardNewProject();
    }}
    onclose={() => (confirmDiscard = false)}
  />
{/if}

<style>
  /* The note editor's frame — header, body, footer — so the two screens
     that replace Welcome read as one kind of thing. */
  .np {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
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
  .title {
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
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
  .ghost.small {
    font-size: 0.7rem;
    padding: 0.15rem 0.45rem;
  }
  /* Discard drops typing: the editor's red outline, behind a confirmation
     here because the form has no saved version to fall back on. */
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

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 1.6rem 1.2rem 1rem;
  }
  .col {
    width: 100%;
    max-width: 640px;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .field.centred {
    align-items: center;
    text-align: center;
  }
  .field.centred .name {
    width: 100%;
    max-width: 28rem;
    text-align: center;
  }
  .foot-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.2rem;
  }
  .lab {
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .opt {
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
  }
  .name {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 1.15rem;
    padding: 0.2rem 0.1rem 0.4rem;
  }
  .name:focus,
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* The path row: greyed, since it is a preview of a folder that does not
     exist yet; the accent once it is a folder the user picked. */
  .folder {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    color: var(--dim);
  }
  .folder .path {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .folder.picked .path {
    color: var(--text);
  }
  .folder.bad .path {
    color: var(--failed);
  }
  .hint {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .hint.bad {
    color: var(--failed);
  }
  .hint code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  textarea {
    height: 6.2rem;
    min-height: 3.4rem;
    resize: vertical;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    font-family: var(--mono);
    font-size: 0.8rem;
    line-height: 1.5;
  }
  footer {
    flex-shrink: 0;
    padding: 0.6rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--dim);
  }
  footer strong {
    color: var(--text);
    font-weight: 500;
  }
  footer kbd {
    font-family: var(--mono);
    font-size: 0.68rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 0.3rem;
  }
</style>
