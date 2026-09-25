<script lang="ts">
  import { tip } from "./tip";
  import { app, closePrompts, deletePrompt, storePrompt, usePrompt } from "./state.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  /**
   * The edit lives in `app.promptDraft`, not here (review round 1,
   * 2026-09-13; memory never-lose-work): the modal closes by Esc, by a
   * click on the scrim and by the popover's handoff, and a draft held in
   * this component would go with it. Reopening finds the draft where it
   * was — the entry it was for, its name, its text.
   */
  function isDirty(x: { selected: string | null; name: string; text: string }): boolean {
    const e = app.prompts.find((p) => p.id === x.selected);
    return e ? e.name !== x.name.trim() || e.text !== x.text : x.text.length > 0;
  }
  // A clean leftover is re-seeded from the chat's current prompt; a dirty
  // one is the work being offered back, and opens as it was left.
  if (!app.promptDraft || !isDirty(app.promptDraft)) {
    const p = app.prompts.find((x) => x.id === app.draft.promptId);
    app.promptDraft = {
      selected: p?.id ?? null,
      name: p?.name ?? "",
      text: p?.text ?? "",
    };
  }
  const d = $derived(app.promptDraft!);
  const selected = $derived(d.selected);

  const entry = $derived(app.prompts.find((p) => p.id === selected) ?? null);
  const dirty = $derived(
    entry ? entry.name !== d.name.trim() || entry.text !== d.text : d.text.length > 0,
  );

  /** One parked dirty draft, the one left by the last switch away. */
  let parked = $state<null | { selected: string | null; name: string; text: string }>(null);

  /** Switch the pane to `id`, or to a blank new entry. A dirty draft is
   *  parked rather than overwritten and comes back the moment its entry is
   *  picked again. */
  function pick(id: string | null) {
    if (id === selected) return;
    if (dirty) parked = { ...d };
    if (parked && parked.selected === id) {
      app.promptDraft = parked;
      parked = null;
      return;
    }
    const p = app.prompts.find((x) => x.id === id);
    app.promptDraft = { selected: id, name: p?.name ?? "", text: p?.text ?? "" };
  }

  /** Start a new entry, optionally seeded with the chat's one-off prompt. */
  function blank(seed = "") {
    pick(null);
    if (seed) app.promptDraft = { selected: null, name: "", text: seed };
  }

  function save(): string {
    const id = storePrompt(d.name, d.text, selected);
    app.promptDraft = { selected: id, name: d.name.trim() || "Untitled", text: d.text };
    // Editing the prompt the chat is connected with takes effect now —
    // otherwise the library would disagree with what is on the wire.
    if (app.draft.promptId === id) void usePrompt(id);
    return id;
  }

  /** Save, put it on the chat, and hand back to whoever opened the library. */
  function useIt() {
    void usePrompt(save());
    close();
  }

  let confirmDelete = $state(false);
  function remove() {
    if (!selected) return;
    deletePrompt(selected);
    confirmDelete = false;
    app.promptDraft = { selected: null, name: "", text: "" };
  }

  /**
   * Close, and reopen the popover if that is where the pencil was clicked:
   * the point of the round trip is to see the chosen prompt in its dropdown.
   * The draft stays in app state whichever way this is reached.
   */
  const close = closePrompts;

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !confirmDelete) close();
  }

  /** The chat is running a prompt that is not in the library. */
  const unsaved = $derived(!app.draft.promptId && app.draft.system.trim() !== "");
</script>

<svelte:window {onkeydown} />

<div class="modal">
  <nav class="nav">
    <div class="nav-title">Prompts</div>
    {#each app.prompts as p (p.id)}
      <button
        class="nav-item"
        class:active={p.id === selected}
        onclick={() => pick(p.id)}
      >
        <span class="nav-label">{p.name}</span>
        {#if app.draft.promptId === p.id}<span class="in-use" use:tip={"In use in this chat"}>●</span>{/if}
      </button>
    {/each}
    {#if app.prompts.length === 0}
      <p class="nav-empty">Nothing saved yet.</p>
    {/if}

    <div class="nav-spacer"></div>
    <button class="nav-add" onclick={() => blank()}>+ New</button>
    {#if unsaved}
      <button
        class="nav-add"
        use:tip={"Put this chat's system prompt in the library"}
        onclick={() => blank(app.draft.system)}
      >
        + From this chat
      </button>
    {/if}
    <button class="close" onclick={close}>{app.promptsFrom === "rail" ? "Back to model" : "Close"}</button>
  </nav>

  <div class="pane">
    <input
      class="name"
      type="text"
      value={d.name}
      oninput={(e) => (d.name = e.currentTarget.value)}
      placeholder="Name"
      aria-label="Prompt name"
      spellcheck="false"
    />
    <textarea
      value={d.text}
      oninput={(e) => (d.text = e.currentTarget.value)}
      placeholder="System prompt — layered after the built-in preamble, before the conversation."
      aria-label="Prompt text"
      spellcheck="false"
    ></textarea>
    <div class="foot">
      <button
        class="primary"
        disabled={!d.text.trim()}
        use:tip={"Save this entry and make it the chat's system prompt"}
        onclick={useIt}
      >
        Save &amp; use in this chat
      </button>
      <button disabled={!d.text.trim() || !dirty} onclick={() => save()}>
        Save{dirty && (entry || d.text.trim()) ? " •" : ""}
      </button>
      {#if dirty}<span class="draft" use:tip={"Unsaved — kept if you close"}>draft</span>{/if}
      <div class="spacer"></div>
      {#if entry}
        <button class="danger" onclick={() => (confirmDelete = true)}>Delete</button>
      {/if}
    </div>
  </div>
</div>

{#if confirmDelete && entry}
  <ConfirmDialog
    title="Delete this prompt?"
    lead="It leaves the library. A chat already running it keeps its text."
    facts={[["name", entry.name], ["length", `${entry.text.length} characters`]]}
    confirmLabel="Delete"
    onconfirm={remove}
    onclose={() => (confirmDelete = false)}
  />
{/if}

<style>
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 44rem;
    max-width: calc(100vw - 4rem);
    height: min(34rem, calc(100vh - 6rem));
    display: grid;
    grid-template-columns: 11rem 1fr;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .nav {
    border-right: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    padding: 0.75rem 0.55rem;
    gap: 2px;
    overflow-y: auto;
  }
  .nav-title {
    font-size: 0.72rem;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 0.45rem 0.5rem;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 0.8rem;
    text-align: left;
    padding: 0.35rem 0.45rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .nav-item:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .nav-item.active {
    background: var(--accent-soft);
  }
  .nav-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .in-use {
    margin-left: auto;
    color: var(--accent);
    font-size: 0.6rem;
  }
  .nav-empty {
    margin: 0.2rem 0.45rem;
    font-size: 0.72rem;
    color: var(--dim);
  }
  .nav-spacer {
    flex: 1;
    min-height: 0.5rem;
  }
  .nav-add,
  .close {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.75rem;
    padding: 0.3rem 0.45rem;
    margin-top: 2px;
    cursor: pointer;
    text-align: left;
  }
  .nav-add:hover,
  .close:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .pane {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem;
    min-height: 0;
  }
  .name {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 1rem;
    padding: 0.2rem 0.1rem 0.4rem;
  }
  textarea {
    flex: 1;
    min-height: 0;
    resize: none;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    font-family: var(--mono);
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .name:focus,
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .foot button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.78rem;
    padding: 0.35rem 0.7rem;
    cursor: pointer;
  }
  .foot button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .foot button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .primary {
    border-color: var(--accent) !important;
    color: var(--accent) !important;
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .danger:hover:not(:disabled) {
    border-color: var(--error) !important;
    color: var(--error) !important;
  }
  .spacer {
    flex: 1;
  }
  .draft {
    font-size: 0.7rem;
    color: var(--dim);
    border: 1px dashed var(--border);
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
  }
</style>
