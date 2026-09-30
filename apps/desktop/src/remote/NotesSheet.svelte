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
    type NoteRow,
    type NoteScope,
  } from "./client";

  interface Props {
    client: Client;
    /** The host serves `/api/notes` (`features`). */
    available: boolean;
    /** Open straight on this note (a search hit), else the list. */
    start?: { scope: NoteScope; name: string } | null;
    onnote: (text: string) => void;
    /** The sheet is taller while a note is open or edited. */
    ontall?: (tall: boolean) => void;
  }
  let { client, available, start = null, onnote, ontall }: Props = $props();

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

  const FIXED: { scope: NoteScope; label: string; sub: string }[] = [
    { scope: "instructions", label: "Project instructions", sub: "AGENTS.md — every chat in this project reads it" },
    { scope: "memory", label: "Memory", sub: "Yours, in every project" },
    { scope: "chat", label: "Chat instructions", sub: "How a plain chat talks" },
  ];
  const fixedLabel = (s: NoteScope) => FIXED.find((f) => f.scope === s)?.label;
  const titleOf = (s: NoteScope, n: string) => fixedLabel(s) ?? noteTitle(n);
  const isFixed = (s: NoteScope) => FIXED_NOTES[s] !== undefined;

  function say(e: unknown): string {
    if (e instanceof Unreachable) return "The Mac is unreachable.";
    if (e instanceof ApiError && e.status === 404) return "This Mac's Nightloom has no notes route — update it.";
    return String(e instanceof Error ? e.message : e);
  }

  $effect(() => {
    ontall?.(view.v !== "list");
  });

  async function load(s: NoteScope = scope) {
    scope = s;
    problem = null;
    list = null;
    drafts = noteDraftKeys();
    if (!available) {
      problem = "This Mac's Nightloom is older than the phone page: update it to read notes here.";
      return;
    }
    try {
      const got = await client.notes(s);
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
      text = await client.readNote(s, n);
    } catch (e) {
      problem = say(e);
    }
  }

  function openFixed(s: NoteScope) {
    void openNote(s, FIXED_NOTES[s]!);
  }

  async function beginEdit(s: NoteScope, n: string) {
    confirmDiscard = false;
    const kept = loadNoteDraft(noteDraftKey(s, n));
    if (text === null) {
      try {
        text = await client.readNote(s, n);
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
    const kept = loadNoteDraft(noteDraftKey(scope, null));
    edit = kept?.text ?? "";
    name = kept?.name ?? "";
    base = "";
    drifted = false;
    view = { v: "new", scope };
  }

  function typed() {
    if (view.v === "edit") saveNoteDraft(noteDraftKey(view.scope, view.name), { text: edit, base });
    else if (view.v === "new") saveNoteDraft(noteDraftKey(view.scope, null), { text: edit, base: "", name });
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
      await client.writeNote(s, n, edit);
      // Saved on the Mac: only now does the draft go.
      saveNoteDraft(noteDraftKey(s, view.v === "new" ? null : n), null);
      text = edit;
      onnote(view.v === "new" ? "Note created on the Mac" : "Saved on the Mac");
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
    saveNoteDraft(noteDraftKey(s, view.v === "new" ? null : view.name), null);
    drafts = noteDraftKeys();
    confirmDiscard = false;
    problem = null;
    view = view.v === "new" ? { v: "list" } : { v: "read", scope: s, name: view.name };
  }

  async function remove() {
    if (view.v !== "delete") return;
    const { scope: s, name: n } = view;
    busy = true;
    try {
      await client.deleteNote(s, n);
      onnote(`“${noteTitle(n)}” moved to the trash on the Mac`);
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
    <button role="tab" aria-selected={scope === "project"} class:on={scope === "project"} onclick={() => load("project")}>This project</button>
    <button role="tab" aria-selected={scope === "knowledge"} class:on={scope === "knowledge"} onclick={() => load("knowledge")}>Vault</button>
  </div>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  {#if available}
    <div class="ns-list">
      {#each FIXED as f (f.scope)}
        <button onclick={() => openFixed(f.scope)}>
          <span class="ns-grow">
            <span class="ns-name">{f.label}</span>
            <small>{drafts.includes(noteDraftKey(f.scope, FIXED_NOTES[f.scope]!)) ? "draft kept · " : ""}{f.sub}</small>
          </span>
        </button>
      {/each}
    </div>
    {#if list === null && !problem}
      <p class="ns-note">Asking the Mac…</p>
    {:else if list}
      <div class="ns-list">
        {#each list as n (n.name)}
          <button onclick={() => openNote(scope, n.name)}>
            <span class="ns-grow">
              <span class="ns-name">{noteTitle(n.name)}</span>
              <small>
                {drafts.includes(noteDraftKey(scope, n.name)) ? "draft kept · " : ""}{shortWhen(n.modified)}{n.summary && n.summary !== noteTitle(n.name) ? ` · ${n.summary}` : ""}
              </small>
            </span>
          </button>
        {:else}
          <p class="ns-empty">{scope === "project" ? "No notes in this project yet." : "The vault is empty."}</p>
        {/each}
      </div>
      {#if drafts.includes(noteDraftKey(scope, null))}
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
      <button class="ns-link" onclick={() => beginEdit(v.scope, v.name)}>{drafts.includes(noteDraftKey(v.scope, v.name)) ? "Edit · draft kept" : "Edit"}</button>
    {/if}
  </div>
  <div class="ns-title">{titleOf(v.scope, v.name)}</div>
  <div class="ns-sub">{isFixed(v.scope) ? v.name : `${v.scope === "knowledge" ? "Vault" : "Project"} · ${v.name}`}</div>
  {#if problem}<p class="ns-problem">{problem}</p>{/if}
  {#if text === null && !problem}
    <p class="ns-note">Asking the Mac…</p>
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
    <input class="ns-input" type="text" placeholder="Name" bind:value={name} oninput={typed} autocapitalize="sentences" />
  {/if}
  {#if drifted}<p class="ns-problem">The note changed on the Mac after this draft was begun — Save replaces the Mac's version.</p>{/if}
  <textarea class="ns-box" bind:this={box} bind:value={edit} oninput={typed} placeholder="Write in Markdown…"></textarea>
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
  <p class="ns-note">It moves to the trash on the Mac.</p>
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
    min-height: 45dvh;
    resize: none;
    font-family: var(--mono);
    font-size: 16px;
    line-height: 1.45;
  }
  .ns-actions {
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
