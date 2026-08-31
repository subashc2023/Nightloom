<script lang="ts">
  import * as api from "./api";
  import {
    app,
    addToast,
    closeNote,
    revealFolder,
    saveNote,
    showNote,
  } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { hrefTarget, parseLinks, renderNote, resolveNote } from "./links";
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
  let loaded: string | null = null;
  let text = $state("");
  let saved = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let preview = $state(false);

  const dirty = $derived(text !== saved);
  const open = $derived(app.openNote);
  const isVault = $derived(open?.scope === "knowledge");

  /**
   * Links out of the note as it currently reads — from the buffer rather than
   * from the backend's graph, so a link typed a moment ago is already listed.
   * Only for the vault: the docspace has no link convention.
   */
  const outbound = $derived.by(() => {
    if (!isVault) return [];
    return parseLinks(text).map((l) => ({
      target: l.target,
      note: resolveNote(l.target, app.vault),
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
    text = "";
    saved = "";
    error = null;
    backlinks = [];
    if (!target) return;
    loading = true;
    try {
      const content = await api.readNote(target.scope, target.name);
      text = content;
      saved = content;
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
      if (app.openNote?.name !== name) return;
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
    }
  }

  /**
   * Follow a `[[link]]` from the preview.
   *
   * Delegated from the pane rather than bound per anchor, because the HTML is
   * produced by the markdown renderer and there is nothing to bind to. A
   * target that resolves to nothing *creates* the note — writing `[[thing]]`
   * before it exists is how a note gets planned, so the click is the natural
   * moment to start it.
   */
  async function onPreviewClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    const target = hrefTarget(anchor?.getAttribute("href") ?? null);
    if (target === null) return;
    e.preventDefault();
    await follow(target);
  }

  async function follow(target: string) {
    const found = resolveNote(target, app.vault);
    if (found) {
      showNote("knowledge", found.name);
      return;
    }
    const name = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    if (await saveNote("knowledge", name, "")) showNote("knowledge", name);
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
    <button class="back" onclick={closeNote}>← Chat</button>
    <span class="scope" class:vault={isVault}>
      {isVault ? "knowledge" : "project"}
    </span>
    <span class="title">{open?.name ?? "no note"}</span>
    {#if dirty}<span class="dirty" title="Unsaved changes">●</span>{/if}
    <span class="spacer"></span>
    <button
      class="ghost"
      class:on={preview}
      onclick={() => (preview = !preview)}
      disabled={!open}
    >
      {preview ? "Edit" : "Preview"}
    </button>
    <button
      class="ghost"
      title="Show the folder"
      onclick={() => void revealFolder(folder)}>Folder</button
    >
    <button class="save" onclick={() => void commit()} disabled={!dirty}>
      Save
    </button>
  </header>

  {#if error}
    <p class="err">{error}</p>
  {:else if loading}
    <p class="err quiet">Reading…</p>
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
    <textarea
      class="pane"
      bind:value={text}
      spellcheck="false"
      placeholder={isVault
        ? "Yours, and readable from every project. Link another note with [[name]]."
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
              class:broken={!l.note}
              title={l.note ? l.note.name : `${l.target} — click to create`}
              onclick={() => void follow(l.target)}>{l.target}</button
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
    {#if isVault}
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
    font-size: 0.6rem;
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
