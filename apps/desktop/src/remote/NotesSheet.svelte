<script lang="ts">
  /**
   * Notes from the phone (item 246, wave 2C): the project's notes and the
   * vault's, the three always-loaded files (the project's instructions, his
   * memory, the Chat instructions) — list, read, edit, new, delete.
   *
   * Never loses his text (practices §7): every keystroke in the editor is
   * kept in localStorage under the note (`noteDraftKey`), so closing the
   * sheet, a reload, or a refused Save leaves it; the list marks it "draft
   * kept" and opening the note offers it back. Only Save, or Discard (which
   * asks when the text changed), drops it. Delete asks, and the note moves
   * to the Mac's trash.
   */
  import { onMount, tick } from "svelte";
  import { renderMarkdown } from "../lib/markdown";
  import {
    ApiError,
    FIXED_NOTES,
    Unreachable,
    loadNoteDraft,
    noteDraftKey,
    noteDraftKeys,
    noteFileName,
    noteNameProblem,
    noteTitle,
    saveNoteDraft,
    shortWhen,
    type Client,
    type NoteDraft,
    type NoteRow,
    type NoteScope,
  } from "./client";
  import { missingSentence } from "./hosts";
  import type { NotesPlace } from "./schemeReload";

  interface Props {
    client: Client;
    /** The host serves `/api/notes` (`features`). */
    available: boolean;
    /** `/api/state`'s `host`, for the sentence when a feature is missing. */
    host?: string | null;
    /** Open straight on this note (a search hit), else the list. */
    start?: { scope: NoteScope; name: string } | null;
    onnote: (text: string) => void;
    /** The sheet is taller while a note is open or edited. */
    ontall?: (tall: boolean) => void;
    /** The id of the project these notes are in (the host's open one;
     *  "unfiled" for No project), so a draft is kept for this project's
     *  note only (item 300, A20). `null` while the projects are unknown. */
    project?: string | null;
    /** The name of `project` as the page shows it (item 300 B1), so the
     *  sheet says whose notes these are; "This project" when unknown. */
    projectLabel?: string | null;
    /** The host's name in a sentence — "the Mac" or "Away" (300 A3/B5). */
    where?: string;
    /** Item 302: the tab and note to open on, after the page reloaded for
     *  a scheme change (the draft itself is in storage). */
    resume?: NotesPlace | null;
    /** Item 302: the tab and note open now, so a reload can put them back. */
    onview?: (place: NotesPlace) => void;
  }
  let { client, available, host = undefined, start = null, onnote, ontall, project = null, projectLabel = null, where = "the Mac", resume = null, onview }: Props = $props();
  const Where = $derived(where.charAt(0).toUpperCase() + where.slice(1));

  type View =
    | { v: "list" }
    | { v: "read"; scope: NoteScope; name: string }
    | { v: "edit"; scope: NoteScope; name: string }
    | { v: "new"; scope: NoteScope }
    | { v: "delete"; scope: NoteScope; name: string };

  let view = $state<View>({ v: "list" });
  let scope = $state<NoteScope>("project");
  let list = $state<NoteRow[] | null>(null);
  let problem = $state<string | null>(null);
  let busy = $state(false);
  /** The note as the Mac last gave it. */
  let text = $state<string | null>(null);
  /** The editor's text and, for a new note, its name. */
  let edit = $state("");
  let base = $state("");
  let name = $state("");
  /** The Mac's copy changed after the kept draft was begun. */
  let drifted = $state(false);
  let confirmDiscard = $state(false);
  let drafts = $state<string[]>(noteDraftKeys());
  let box = $state<HTMLTextAreaElement | null>(null);
  /** A draft kept before drafts named their project (A20), for the note
   *  being edited: it may have been typed for another project, so it is
   *  offered, not applied; it stays kept until he takes it or discards it. */
  let older = $state<NoteDraft | null>(null);

  /** This project's draft key for a note, and the old unkeyed one. */
  const key = (s: NoteScope, n: string | null) => noteDraftKey(s, n, project);
  const oldKey = (s: NoteScope, n: string | null) => noteDraftKey(s, n);
  const hasOld = (s: NoteScope, n: string | null) => key(s, n) !== oldKey(s, n) && drafts.includes(oldKey(s, n));
  /** The list's mark for a note with a kept draft. */
  const mark = (s: NoteScope, n: string | null) =>
    drafts.includes(key(s, n)) ? "draft kept · " : hasOld(s, n) ? "older draft kept · " : "";

  const FIXED: { scope: NoteScope; label: string; sub: string }[] = [
    { scope: "instructions", label: "Project instructions", sub: "AGENTS.md — every chat in this project reads it" },
    { scope: "memory", label: "Memory", sub: "Yours, in every project" },
    { scope: "chat", label: "Chat instructions", sub: "How a plain chat talks" },
  ];
  const fixedLabel = (s: NoteScope) => FIXED.find((f) => f.scope === s)?.label;
  const titleOf = (s: NoteScope, n: string) => fixedLabel(s) ?? noteTitle(n);
  const isFixed = (s: NoteScope) => FIXED_NOTES[s] !== undefined;

  function say(e: unknown): string {
    if (e instanceof Unreachable) return `${Where} is unreachable.`;
    if (e instanceof ApiError && e.status === 404) return `${Where}'s Nightloom has no notes route — update it.`;
    return String(e instanceof Error ? e.message : e);
  }

  $effect(() => {
    ontall?.(view.v !== "list");
  });

  // Item 302: where the sheet is, for a reload to put back (a delete's
  // confirmation comes back as the note it was asked on).
  $effect(() => {
    const tab = scope === "knowledge" ? "knowledge" : "project";
    const v = view;
    onview?.({
      tab,
      view: v.v === "list" ? { v: "list" } : v.v === "new" ? { v: "new", scope: v.scope } : { v: v.v === "edit" ? "edit" : "read", scope: v.scope, name: v.name },
    });
  });

  async function load(s: NoteScope = scope) {
    scope = s;
    problem = null;
    list = null;
    drafts = noteDraftKeys();
    if (!available) {
      problem = missingSentence(host, "This Mac's Nightloom is older than the phone page: update it to read notes here.");
      return;
    }
    try {
      const got = await client.notes(s, project);
      if (scope === s) list = got.slice().sort((a, b) => b.modified.localeCompare(a.modified));
    } catch (e) {
      problem = say(e);
    }
  }

  async function openNote(s: NoteScope, n: string) {
    view = { v: "read", scope: s, name: n };
    text = null;
    problem = null;
    try {
      text = await client.readNote(s, n, project);
    } catch (e) {
      problem = say(e);
    }
  }

  function openFixed(s: NoteScope) {
    void openNote(s, FIXED_NOTES[s]!);
  }

  async function beginEdit(s: NoteScope, n: string) {
    confirmDiscard = false;
    const kept = loadNoteDraft(key(s, n));
    older = !kept && hasOld(s, n) ? loadNoteDraft(oldKey(s, n)) : null;
    if (text === null) {
      try {
        text = await client.readNote(s, n, project);
      } catch (e) {
        problem = say(e);
        if (!kept) return;
      }
    }
    base = kept?.base ?? text ?? "";
    edit = kept?.text ?? text ?? "";
    drifted = !!kept && text !== null && kept.base !== text;
    view = { v: "edit", scope: s, name: n };
    await tick();
    box?.focus();
  }

  function beginNew() {
    confirmDiscard = false;
    problem = null;
    const kept = loadNoteDraft(key(scope, null));
    older = !kept && hasOld(scope, null) ? loadNoteDraft(oldKey(scope, null)) : null;
    edit = kept?.text ?? "";
    name = kept?.name ?? "";
    base = "";
    drifted = false;
    view = { v: "new", scope };
  }

  function typed() {
    if (view.v === "edit") saveNoteDraft(key(view.scope, view.name), { text: edit, base });
    else if (view.v === "new") saveNoteDraft(key(view.scope, null), { text: edit, base: "", name });
  }

  async function save() {
    if (view.v !== "edit" && view.v !== "new") return;
    const s = view.scope;
    let n: string;
    if (view.v === "new") {
      const bad = noteNameProblem(name);
      if (bad) {
        problem = bad;
        return;
      }
      n = noteFileName(name);
      if (list?.some((r) => r.name === n)) {
        problem = `“${noteTitle(n)}” already exists — choose another name.`;
        return;
      }
    } else n = view.name;
    busy = true;
    problem = null;
    try {
      await client.writeNote(s, n, edit, project);
      // Saved on the Mac: only now does the draft go.
      saveNoteDraft(key(s, view.v === "new" ? null : n), null);
      text = edit;
      onnote(view.v === "new" ? `Note created on ${where}` : `Saved on ${where}`);
      view = { v: "read", scope: s, name: n };
      drafts = noteDraftKeys();
      if (!isFixed(s)) void load(s);
    } catch (e) {
      // The draft stays; the sheet says why.
      problem = say(e);
    } finally {
      busy = false;
    }
  }

  function discard(force = false) {
    if (view.v !== "edit" && view.v !== "new") return;
    const changed = view.v === "new" ? edit.trim() !== "" || name.trim() !== "" : edit !== base;
    if (changed && !force) {
      confirmDiscard = true;
      return;
    }
    const s = view.scope;
    saveNoteDraft(key(s, view.v === "new" ? null : view.name), null);
    drafts = noteDraftKeys();
    confirmDiscard = false;
    problem = null;
    view = view.v === "new" ? { v: "list" } : { v: "read", scope: s, name: view.name };
  }

  /** He takes the older draft: it moves under this project's key (moved,
   *  not dropped), and the editor shows it. */
  function takeOlder() {
    if (!older || (view.v !== "edit" && view.v !== "new")) return;
    const n = view.v === "new" ? null : view.name;
    edit = older.text;
    if (view.v === "new") name = older.name ?? name;
    else {
      base = older.base;
      drifted = text !== null && older.base !== text;
    }
    saveNoteDraft(key(view.scope, n), { ...older, text: edit, ...(view.v === "new" ? { name } : {}) });
    saveNoteDraft(oldKey(view.scope, n), null);
    older = null;
    drafts = noteDraftKeys();
  }

  async function remove() {
    if (view.v !== "delete") return;
    const { scope: s, name: n } = view;
    busy = true;
    try {
      await client.deleteNote(s, n, project);
      onnote(`“${noteTitle(n)}” moved to the trash on ${where}`);
      view = { v: "list" };
      await load(s);
    } catch (e) {
      problem = say(e);
    } finally {
      busy = false;
    }
  }

  function back() {
    problem = null;
    confirmDiscard = false;
    view = { v: "list" };
    void load(scope);
  }

  onMount(() => {
    if (resume) {
      // Item 302: back where he was before the reload.
      const r = resume.view;
      void load(resume.tab);
      if (r.v === "read") void openNote(r.scope, r.name);
      else if (r.v === "edit") void openNote(r.scope, r.name).then(() => beginEdit(r.scope, r.name));
      else if (r.v === "new") {
        scope = r.scope;
        beginNew();
      }
      return;
    }
    if (start) {
      if (start.scope === "project" || start.scope === "knowledge") scope = start.scope;
      void load(scope);
      void openNote(start.scope, start.name);
    } else void load("project");
  });
</script>

{#if view.v === "list"}
  <div class="ns-head">
    <span class="ns-title">Notes</span>
    {#if available}<button class="ns-link" onclick={beginNew}>New note</button>{/if}
  </div>
  <div class="ns-seg" role="tablist" aria-label="Which notes">
    <button role="tab" aria-selected={scope === "project"} class:on={scope === "project"} onclick={() => load("project")}>{projectLabel ?? "This project"}</button>
    <button role="tab" aria-selected={scope === "knowledge"} class:on={scope === "knowledge"} onclick={() => load("knowledge")}>Vault</button>
  </div>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  {#if available}
    <div class="ns-list">
      {#each FIXED as f (f.scope)}
        <button onclick={() => openFixed(f.scope)}>
          <span class="ns-grow">
            <span class="ns-name">{f.label}</span>
            <small>{mark(f.scope, FIXED_NOTES[f.scope]!)}{f.sub}</small>
          </span>
        </button>
      {/each}
    </div>
    {#if list === null && !problem}
      <p class="ns-note">Asking {where}…</p>
    {:else if list}
      <div class="ns-list">
        {#each list as n (n.name)}
          <button onclick={() => openNote(scope, n.name)}>
            <span class="ns-grow">
              <span class="ns-name">{noteTitle(n.name)}</span>
              <small>
                {mark(scope, n.name)}{shortWhen(n.modified)}{n.summary && n.summary !== noteTitle(n.name) ? ` · ${n.summary}` : ""}
              </small>
            </span>
          </button>
        {:else}
          <p class="ns-empty">{scope === "project" ? "No notes in this project yet." : "The vault is empty."}</p>
        {/each}
      </div>
      {#if drafts.includes(key(scope, null)) || hasOld(scope, null)}
        <button class="ns-link" onclick={beginNew}>A new note's draft is kept — continue it</button>
      {/if}
    {/if}
  {/if}
{:else if view.v === "read"}
  {@const v = view}
  <div class="ns-head">
    <button class="ns-link" onclick={back}>‹ Notes</button>
    <span class="ns-grow"></span>
    {#if text !== null}
      <button class="ns-link" onclick={() => beginEdit(v.scope, v.name)}>{drafts.includes(key(v.scope, v.name)) || hasOld(v.scope, v.name) ? "Edit · draft kept" : "Edit"}</button>
    {/if}
  </div>
  <div class="ns-title">{titleOf(v.scope, v.name)}</div>
  <div class="ns-sub">{isFixed(v.scope) ? v.name : `${v.scope === "knowledge" ? "Vault" : "Project"} · ${v.name}`}</div>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  {#if text === null && !problem}
    <p class="ns-note">Asking {where}…</p>
  {:else if text !== null}
    {#if text.trim()}
      <div class="ns-md">{@html renderMarkdown(text)}</div>
    {:else}
      <p class="ns-note">Empty. Edit to write the first line.</p>
    {/if}
    {#if !isFixed(v.scope)}
      <button class="ns-btn danger" onclick={() => (view = { v: "delete", scope: v.scope, name: v.name })}>Delete…</button>
    {/if}
  {/if}
{:else if view.v === "edit" || view.v === "new"}
  {@const v = view}
  <div class="ns-title">{v.v === "new" ? `New note in ${v.scope === "knowledge" ? "the vault" : "this project"}` : titleOf(v.scope, v.name)}</div>
  {#if v.v === "new"}
    <input class="ns-input" type="text" placeholder="Name" data-kept bind:value={name} oninput={typed} autocapitalize="sentences" />
  {/if}
  {#if older}
    <div class="ns-older" role="status">
      <p class="ns-note">A draft of this note was kept before drafts named their project — it may have been typed in another project.</p>
      <p class="ns-quote">{older.text.trim().slice(0, 160) || "(empty)"}{older.text.trim().length > 160 ? "…" : ""}</p>
      <div class="ns-actions">
        <button class="ns-btn" onclick={() => (older = null)}>Not now</button>
        <span class="ns-grow"></span>
        <button class="ns-btn accent" onclick={takeOlder}>Use this draft</button>
      </div>
    </div>
  {/if}
  {#if drifted}<p class="ns-problem">The note changed on {where} after this draft was begun — Save replaces {where}’s version.</p>{/if}
  <textarea class="ns-box" data-kept bind:this={box} bind:value={edit} oninput={typed} placeholder="Write in Markdown…"></textarea>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  {#if confirmDiscard}
    <p class="ns-note">Discard your changes? The draft is gone after this.</p>
    <div class="ns-actions">
      <span class="ns-grow"></span>
      <button class="ns-btn" onclick={() => (confirmDiscard = false)}>Keep editing</button>
      <button class="ns-btn danger" onclick={() => discard(true)}>Discard</button>
    </div>
  {:else}
    <div class="ns-actions">
      <button class="ns-btn" onclick={() => discard()}>Discard</button>
      <span class="ns-grow"></span>
      <button class="ns-btn accent" disabled={busy || (v.v === "new" && !name.trim())} onclick={save}>{v.v === "new" ? "Create" : "Save"}</button>
    </div>
  {/if}
{:else if view.v === "delete"}
  {@const v = view}
  <div class="ns-title">Delete “{noteTitle(v.name)}”?</div>
  <p class="ns-note">It moves to the trash on {where}.</p>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  <div class="ns-actions">
    <span class="ns-grow"></span>
    <button class="ns-btn" onclick={() => (view = { v: "read", scope: v.scope, name: v.name })}>Cancel</button>
    <button class="ns-btn danger" disabled={busy} onclick={remove}>Move to trash</button>
  </div>
{/if}

<style>
  .ns-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .ns-title {
    flex: 1;
    font-weight: 600;
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .ns-sub,
  .ns-note {
    font-size: 13px;
    color: var(--dim);
    margin: -4px 0 0;
    overflow-wrap: anywhere;
  }
  .ns-note {
    margin: 0;
  }
  .ns-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .ns-link {
    all: unset;
    cursor: pointer;
    color: var(--accent-ink);
    font-size: 15px;
    padding: 8px 4px;
  }
  .ns-seg {
    display: flex;
    background: var(--paper);
    border-radius: 12px;
    padding: 3px;
    gap: 3px;
  }
  .ns-seg button {
    all: unset;
    flex: 1;
    text-align: center;
    min-height: 36px;
    line-height: 36px;
    border-radius: 9px;
    font-size: 14px;
    cursor: pointer;
    color: var(--dim);
    /* A project's name may be long (300 B1). */
    min-width: 0;
    padding: 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ns-seg button.on {
    background: var(--well);
    color: var(--ink);
    font-weight: 600;
  }
  .ns-list {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
    flex: none;
  }
  .ns-list > button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 6px 16px;
    box-sizing: border-box;
    cursor: pointer;
  }
  .ns-list > button:active {
    background: var(--well);
  }
  .ns-list > * + * {
    border-top: 1px solid var(--line);
  }
  .ns-grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ns-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    font-size: 12px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ns-empty {
    font-size: 14px;
    color: var(--dim);
    padding: 14px 16px;
    margin: 0;
  }
  .ns-md {
    font-size: 15px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .ns-md :global(pre) {
    overflow-x: auto;
    background: var(--well);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .ns-md :global(code) {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .ns-md :global(p),
  .ns-md :global(ul),
  .ns-md :global(ol) {
    margin: 0.5em 0;
  }
  .ns-md :global(h1),
  .ns-md :global(h2),
  .ns-md :global(h3) {
    font-size: 1.05em;
    margin: 0.9em 0 0.3em;
  }
  .ns-md :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .ns-md :global(td),
  .ns-md :global(th) {
    border: 1px solid var(--line);
    padding: 4px 8px;
  }
  .ns-input,
  .ns-box {
    width: 100%;
    box-sizing: border-box;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    outline: none;
  }
  .ns-box {
    /* 300 F4 (A22): tall when there is room, but it gives way to the
       sheet's cap (the screen above the keyboard) so the title and the
       Discard/Save row stay on screen. */
    height: 45dvh;
    min-height: 7.5em;
    flex: 0 1 auto;
    resize: none;
    font-family: var(--mono);
    font-size: 16px;
    line-height: 1.45;
  }
  .ns-older {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--paper);
    border: 1px solid var(--line2);
    flex: none;
  }
  .ns-quote {
    margin: 0;
    font-family: var(--mono);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink2);
  }
  .ns-actions {
    flex: none;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .ns-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
    align-self: flex-start;
  }
  .ns-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ns-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .ns-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
