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
  import { NEW_THREAD, pickerOptions, slugFrom, validSlug } from "./thread";
  import type { ThreadInfo } from "./types";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tip } from "./tip";

  let { compact = false }: { compact?: boolean } = $props();

  let threads = $state<ThreadInfo[]>([]);
  let loadError = $state<string | null>(null);
  let working = $state(false);
  let confirmCancel = $state(false);

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
      return;
    }
    working = true;
    try {
      await setChatThread(value || null);
    } finally {
      working = false;
    }
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

  async function create(): Promise<void> {
    if (!form || !slugOk) return;
    working = true;
    try {
      if (await createThread(form.name.trim() || form.slug, form.slug)) {
        delete pendingNames[projectKey];
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
  }
</script>

<div class="thread-picker" class:compact>
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
  {#if !compact && current && current.value !== NEW_THREAD && !form?.open}
    <p class="tp-detail">{current.detail}</p>
  {/if}
  {#if loadError}
    <p class="tp-detail tp-error">{loadError}</p>
  {/if}
  {#if form?.open}
    <div class="tp-new">
      <input
        type="text"
        placeholder="Name, e.g. Stuart brainstorm"
        aria-label="The new thread's name"
        value={form.name}
        oninput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
      />
      <input
        type="text"
        class="mono"
        placeholder="slug"
        aria-label="The new thread's folder name"
        value={form.slug}
        oninput={(e) => setSlug((e.currentTarget as HTMLInputElement).value)}
      />
      <button class="ns-btn accent small" disabled={!slugOk || working} onclick={() => void create()}>Create and bind</button>
      <button class="ns-btn ghost small" onclick={cancel}>Cancel</button>
      {#if form.slug && !slugOk}
        <span class="tp-detail tp-error">
          {threads.some((t) => t.slug === form.slug)
            ? "a thread with that name exists — pick it above"
            : "lowercase letters, digits, - and _ only"}
        </span>
      {:else if form.slug}
        <span class="tp-detail mono">.agents/threads/{form.slug}/</span>
      {/if}
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
  .tp-new {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
  }
  .tp-new input {
    width: 14rem;
  }
  .tp-new input.mono {
    font-family: var(--mono);
    width: 10rem;
  }
  .tp-detail {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
  }
  .tp-error {
    color: var(--failed);
  }
</style>
