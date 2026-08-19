<script lang="ts">
  import { app, deletePrompt, storePrompt, usePrompt } from "./state.svelte";

  /** The entry being edited; null is an unsaved new one. */
  let selected = $state<string | null>(app.draft.promptId);
  let name = $state("");
  let text = $state("");

  const entry = $derived(app.prompts.find((p) => p.id === selected) ?? null);
  const dirty = $derived(
    entry ? entry.name !== name.trim() || entry.text !== text : text.length > 0,
  );

  // Guarded on the selection, not on state generally: the fields are bound
  // to `name`/`text`, so an unguarded effect would overwrite what is being
  // typed on the user's own keystroke.
  let loadedFor = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (loadedFor === selected) return;
    loadedFor = selected;
    const p = app.prompts.find((x) => x.id === selected);
    name = p?.name ?? "";
    text = p?.text ?? "";
  });

  function pick(id: string | null) {
    selected = id;
  }

  /** Start a new entry, optionally seeded with the chat's one-off prompt. */
  function blank(seed = "") {
    selected = null;
    loadedFor = null;
    name = "";
    text = seed;
  }

  function save(): string {
    const id = storePrompt(name, text, selected);
    selected = id;
    loadedFor = id;
    // Editing the prompt the chat is connected with takes effect now —
    // otherwise the library would disagree with what is on the wire.
    if (app.draft.promptId === id) void usePrompt(id);
    return id;
  }

  function useIt() {
    void usePrompt(save());
    app.showPrompts = false;
  }

  function remove() {
    if (!selected) return;
    deletePrompt(selected);
    blank();
  }

  const close = () => (app.showPrompts = false);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
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
        {#if app.draft.promptId === p.id}<span class="in-use" title="In use in this chat">●</span>{/if}
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
        title="Put this chat's system prompt in the library"
        onclick={() => blank(app.draft.system)}
      >
        + From this chat
      </button>
    {/if}
    <button class="close" onclick={close}>Close</button>
  </nav>

  <div class="pane">
    <input
      class="name"
      type="text"
      bind:value={name}
      placeholder="Name"
      spellcheck="false"
    />
    <textarea
      bind:value={text}
      placeholder="System prompt — layered after the built-in preamble, before the conversation."
      spellcheck="false"
    ></textarea>
    <div class="foot">
      <button class="primary" disabled={!text.trim()} onclick={useIt}>
        Use in this chat
      </button>
      <button disabled={!text.trim() || !dirty} onclick={() => save()}>
        Save{dirty && (entry || text.trim()) ? " •" : ""}
      </button>
      <div class="spacer"></div>
      {#if entry}
        <button class="danger" onclick={remove}>Delete</button>
      {/if}
    </div>
  </div>
</div>

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
    background: rgba(139, 124, 246, 0.14);
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
    background: #8b7cf614;
  }
  .danger:hover:not(:disabled) {
    border-color: var(--error) !important;
    color: var(--error) !important;
  }
  .spacer {
    flex: 1;
  }
</style>
