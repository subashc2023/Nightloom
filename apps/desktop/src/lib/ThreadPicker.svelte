<script module lang="ts">
  /*
   * The *New thread…* form's half-typed name, per project, kept outside
   * the component (practices §7: no UI mechanic may lose his work): the
   * hand-off card closing, a chat switch or the Context page closing keeps
   * it; only Create (it becomes the thread) or Cancel (asked when typed)
   * drops it.
   */
  const pendingNames = $state<Record<string, { name: string; slug: string; open: boolean }>>({});
</script>

<script lang="ts">
  /*
   * The research-thread picker (nightshift backlog 271, step 1): on the
   * hand-off notice and card, and on the Context page. *No thread*, the
   * project's threads (most recently touched first, each with its status
   * line), or *New thread…* from the project's template. Picking one binds
   * the open chat — a `thread` event on its log, then a reconnect that
   * builds the thread layer — and the wrap-up and read order follow.
   */
  import * as api from "./api";
  import { app, chatThread, createThread, setChatThread } from "./state.svelte";
  import { tick } from "svelte";
  import { NEW_THREAD, pickerOptions, slugFrom, threadFolder, validSlug } from "./thread";
  import type { ThreadInfo } from "./types";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tip } from "./tip";

  /*
   * `list` (nightshift backlog 281): the rows drawn as buttons, each with
   * its status line, for the top bar's thread chip and the aside's fold
   * panel — one click binds. `onpicked` runs after a thread (or No
   * thread) is bound, so a popover can close; never for *New thread…*,
   * whose form stays open.
   */
  let {
    compact = false,
    list = false,
    onpicked,
  }: { compact?: boolean; list?: boolean; onpicked?: () => void } = $props();

  let threads = $state<ThreadInfo[]>([]);
  let loadError = $state<string | null>(null);
  let working = $state(false);
  let confirmCancel = $state(false);
  /** The slug field is shown (backlog 418): *edit* pressed, or the slug
   *  already differs from the one the name makes. */
  let slugOpen = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let slugEl = $state<HTMLInputElement | null>(null);

  const bound = $derived(chatThread(app.events));
  const options = $derived(pickerOptions(threads, bound));
  const current = $derived(options.find((o) => o.value === (bound ?? "")) ?? options[0]);
  const projectKey = $derived(app.project?.id ?? "");
  const form = $derived(pendingNames[projectKey]);

  async function load(): Promise<void> {
    try {
      threads = await api.listThreads();
      loadError = null;
    } catch (e) {
      loadError = String(e);
    }
  }

  // Reload when the project changes or the binding moves (a new thread).
  $effect(() => {
    void projectKey;
    void bound;
    void load();
  });

  async function pick(value: string): Promise<void> {
    if (value === NEW_THREAD) {
      pendingNames[projectKey] = { name: form?.name ?? "", slug: form?.slug ?? "", open: true };
      await tick();
      nameEl?.focus();
      return;
    }
    working = true;
    let ok = false;
    try {
      ok = await setChatThread(value || null);
    } finally {
      working = false;
    }
    if (ok) onpicked?.();
  }

  function setName(name: string): void {
    const prev = pendingNames[projectKey];
    // The slug follows the name until he edits the slug himself.
    const follows = !prev || prev.slug === "" || prev.slug === slugFrom(prev.name);
    pendingNames[projectKey] = { name, slug: follows ? slugFrom(name) : prev.slug, open: true };
  }

  function setSlug(slug: string): void {
    const prev = pendingNames[projectKey];
    pendingNames[projectKey] = { name: prev?.name ?? "", slug, open: true };
  }

  const slugOk = $derived(!!form && validSlug(form.slug) && !threads.some((t) => t.slug === form.slug));
  const slugShown = $derived(!!form && (slugOpen || (form.slug !== "" && form.slug !== slugFrom(form.name))));
  const slugError = $derived(
    !form || !form.slug || slugOk
      ? ""
      : threads.some((t) => t.slug === form.slug)
        ? "a thread with that name exists — pick it above"
        : "lowercase letters, digits, - and _ only",
  );

  async function editSlug(): Promise<void> {
    slugOpen = true;
    await tick();
    slugEl?.focus();
  }

  /**
   * Enter creates, Escape cancels (backlog 418). A native listener on the
   * field, stopped there: the thread chip's card closes on an Escape that
   * reaches the document, and the Discard dialog listens on the window —
   * neither may see this one. The cancel runs after the key is done, so
   * the dialog it may open never catches the same press.
   */
  function formKeys(node: HTMLInputElement) {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void create();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(cancel, 0);
      }
    };
    node.addEventListener("keydown", onKey);
    return { destroy: () => node.removeEventListener("keydown", onKey) };
  }

  async function create(): Promise<void> {
    if (!form || !slugOk) return;
    working = true;
    try {
      if (await createThread(form.name.trim() || form.slug, form.slug)) {
        delete pendingNames[projectKey];
        slugOpen = false;
        await load();
      }
    } finally {
      working = false;
    }
  }

  function cancel(): void {
    if (form && (form.name.trim() || form.slug.trim())) {
      confirmCancel = true;
      return;
    }
    delete pendingNames[projectKey];
    slugOpen = false;
  }
</script>

<div class="thread-picker" class:compact class:list>
  {#if list}
    <div class="tp-list" role="listbox" aria-label="The research thread this chat works from">
      {#each options.filter((o) => o.value !== NEW_THREAD) as o (o.value)}
        {@const on = o.value === (bound ?? "")}
        <button
          class="tp-opt"
          class:on
          role="option"
          aria-selected={on}
          disabled={working || app.busy || app.connecting || !app.project}
          use:tip={o.hint}
          onclick={() => void pick(o.value)}
        >
          <span class="tp-opt-text">
            <span class="tp-opt-label">{o.label}</span>
            {#if o.detail}<span class="tp-opt-detail">{o.detail}</span>{/if}
          </span>
          {#if on}<span class="tp-check" aria-hidden="true">✓</span>{/if}
        </button>
      {/each}
      <!-- Never marked selected: it is an action, not a binding (backlog 418). -->
      <button
        class="tp-opt tp-add"
        role="option"
        aria-selected="false"
        disabled={working || app.busy || app.connecting || !app.project}
        use:tip={"A new thread from the project's template; this chat is bound to it."}
        onclick={() => void pick(NEW_THREAD)}
      >
        <span class="tp-opt-label"><span class="tp-plus" aria-hidden="true">+</span>New thread</span>
      </button>
    </div>
    {#if app.busy || app.connecting}
      <p class="tp-detail">The binding changes once the chat's turn ends.</p>
    {/if}
  {:else}
  <label class="tp-row">
    <span class="tp-label">Thread</span>
    <select
      class="tp-select"
      aria-label="The research thread this chat works from"
      disabled={working || app.busy || app.connecting || !app.project}
      value={form?.open ? NEW_THREAD : (bound ?? "")}
      use:tip={app.project
        ? "A research thread: its Start here is loaded into the chat, the wrap-up updates its files instead of HANDOFF.md, and Continue opens the next chat on the same thread."
        : "Threads live in a project; open one first."}
      onchange={(e) => void pick((e.currentTarget as HTMLSelectElement).value)}
    >
      {#each options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  </label>
  {/if}
  {#if !list && !compact && current && current.value !== NEW_THREAD && !form?.open}
    <p class="tp-detail">{current.detail}</p>
  {/if}
  {#if loadError}
    <p class="tp-detail tp-error">{loadError}</p>
  {/if}
  {#if form?.open}
    <div class="tp-new" role="group" aria-label="New thread">
      <input
        type="text"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Name, e.g. Stuart brainstorm"
        aria-label="The new thread's name"
        bind:this={nameEl}
        use:formKeys
        value={form.name}
        oninput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
      />
      {#if slugShown}
        <input
          type="text"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
          class="mono"
          placeholder="folder-name"
          aria-label="The new thread's folder name"
          bind:this={slugEl}
          use:formKeys
          value={form.slug}
          oninput={(e) => setSlug((e.currentTarget as HTMLInputElement).value)}
        />
        {#if slugError}
          <span class="tp-hint tp-error">{slugError}</span>
        {:else}
          <span class="tp-hint tp-folder mono">{threadFolder(form.slug || "…")}</span>
        {/if}
      {:else}
        <span class="tp-hint">
          {#if slugError}
            <span class="tp-error">{slugError}</span>
          {:else}
            <span class="tp-folder mono">{threadFolder(form.slug || "…")}</span>
          {/if}
          <button class="tp-edit" type="button" onclick={() => void editSlug()}>edit</button>
        </span>
      {/if}
      <div class="tp-actions">
        <button class="ns-btn ghost small" onclick={cancel}>Cancel</button>
        <button class="ns-btn accent small" disabled={!slugOk || working} onclick={() => void create()}>Create and bind</button>
      </div>
    </div>
  {/if}
</div>

{#if confirmCancel}
  <ConfirmDialog
    title="Discard the new thread's name?"
    lead="The name you typed for the new thread is dropped; no thread is created."
    confirmLabel="Discard"
    onconfirm={() => {
      confirmCancel = false;
      delete pendingNames[projectKey];
    }}
    onclose={() => (confirmCancel = false)}
  />
{/if}

<style>
  .thread-picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .tp-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .tp-label {
    color: var(--ink2);
  }
  .tp-select,
  .tp-new input {
    font-size: 12px;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 3px 6px;
    min-width: 0;
  }
  .tp-select {
    max-width: 22rem;
  }
  .tp-select:focus,
  .tp-new input:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* The New thread form (backlog 418): one column whose left edge is the
     rows' text (the rows' 8px inset), every control 28px tall. */
  .tp-new {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 8px 0;
  }
  .thread-picker:not(.list) .tp-new {
    padding: 2px 0 0;
    max-width: 24rem;
  }
  .tp-new input {
    box-sizing: border-box;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    font-size: 12.5px;
  }
  .tp-new input.mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .tp-hint {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    color: var(--dim);
    font-size: 11px;
    line-height: 1.4;
  }
  /* The folder wraps rather than cut: its end is the slug. */
  .tp-hint > :first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .tp-folder.mono {
    font-family: var(--mono);
    font-size: 10.5px;
  }
  .tp-edit {
    flex: none;
    margin-left: auto;
    padding: 0;
    border: none;
    background: none;
    color: var(--dim);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .tp-edit:hover {
    color: var(--accent);
  }
  .tp-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }
  .tp-actions .ns-btn {
    box-sizing: border-box;
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
  }
  .tp-detail {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
  }
  .tp-error {
    color: var(--failed);
  }
  /* The list form (backlog 281): one row per option, the bound one lit. */
  .tp-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 18rem;
    overflow-y: auto;
  }
  .tp-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 6px 8px;
    color: var(--ink2);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
    min-width: 0;
  }
  .tp-opt-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .tp-opt:hover:not(:disabled) {
    background: var(--well);
    color: var(--ink);
  }
  /* The bound thread, and only it: the accent bar and a check (backlog 418). */
  .tp-opt.on {
    background: var(--well);
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .tp-check {
    flex: none;
    color: var(--accent);
    font-size: 12px;
  }
  .tp-opt:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .tp-opt-label {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* The status line wraps to two lines before it is cut. */
  .tp-opt-detail {
    color: var(--dim);
    font-size: 11.5px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .tp-add {
    margin-top: 2px;
    color: var(--ink2);
  }
  .tp-plus {
    display: inline-block;
    margin-right: 6px;
    color: var(--accent);
  }
</style>
