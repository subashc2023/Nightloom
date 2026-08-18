<script lang="ts">
  import {
    app,
    applyDraft,
    fetchModels,
    refreshProviders,
    setPrefs,
  } from "./state.svelte";
  import * as api from "./api";
  import { CURATED, PROVIDER_NOTES, providerLabel } from "./catalog";

  let selected = $state(app.draft.provider || app.providers[0]?.kind || "");
  let keyDraft = $state("");
  let keyBusy = $state(false);
  let keyError = $state<string | null>(null);
  let filter = $state("");
  let addDraft = $state("");

  const provider = $derived(app.providers.find((p) => p.kind === selected));
  const fetchState = $derived(app.modelFetch[selected]);

  /** Everything checkable for the selected provider: curated ∪ custom ∪ fetched. */
  const candidates = $derived.by(() => {
    const seen = new Set<string>();
    const all: string[] = [];
    for (const m of [
      ...(CURATED[selected] ?? []),
      ...(app.prefs.customModels[selected] ?? []),
      ...(app.modelLists[selected] ?? []),
    ]) {
      if (!seen.has(m)) {
        seen.add(m);
        all.push(m);
      }
    }
    const q = filter.trim().toLowerCase();
    return q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  });

  // Opening a provider's pane fetches its live model list once (if it has a key).
  $effect(() => {
    if (provider?.available) void fetchModels(selected);
  });

  function select(kind: string) {
    selected = kind;
    keyDraft = "";
    keyError = null;
    filter = "";
    addDraft = "";
  }

  function railVisible(kind: string): boolean {
    return !app.prefs.hiddenProviders.includes(kind);
  }
  function toggleRail(kind: string) {
    setPrefs((p) => {
      const i = p.hiddenProviders.indexOf(kind);
      if (i >= 0) p.hiddenProviders.splice(i, 1);
      else p.hiddenProviders.push(kind);
    });
  }

  /** A model is "on" when the rail dropdown would offer it. */
  function modelOn(kind: string, model: string): boolean {
    if ((CURATED[kind] ?? []).includes(model)) {
      return !(app.prefs.hiddenModels[kind] ?? []).includes(model);
    }
    return (app.prefs.customModels[kind] ?? []).includes(model);
  }
  function toggleModel(kind: string, model: string) {
    setPrefs((p) => {
      if ((CURATED[kind] ?? []).includes(model)) {
        const hidden = (p.hiddenModels[kind] ??= []);
        const i = hidden.indexOf(model);
        if (i >= 0) hidden.splice(i, 1);
        else hidden.push(model);
      } else {
        const custom = (p.customModels[kind] ??= []);
        const i = custom.indexOf(model);
        if (i >= 0) custom.splice(i, 1);
        else custom.push(model);
      }
    });
  }

  function addCustom() {
    const model = addDraft.trim();
    if (!model) return;
    setPrefs((p) => {
      const custom = (p.customModels[selected] ??= []);
      if (!custom.includes(model)) custom.push(model);
    });
    addDraft = "";
  }

  async function saveKey() {
    const key = keyDraft.trim();
    if (!key || keyBusy) return;
    keyBusy = true;
    keyError = null;
    try {
      await api.setApiKey(selected, key);
      keyDraft = "";
      await refreshProviders();
      void fetchModels(selected, true);
      // First key for the provider the rail points at: connect right away.
      if (selected === app.draft.provider && !app.connection) {
        void applyDraft();
      }
    } catch (e) {
      keyError = String(e);
    } finally {
      keyBusy = false;
    }
  }

  async function clearKey() {
    if (keyBusy) return;
    keyBusy = true;
    keyError = null;
    try {
      await api.clearApiKey(selected);
      await refreshProviders();
    } catch (e) {
      keyError = String(e);
    } finally {
      keyBusy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") app.showSettings = false;
  }
</script>

<svelte:window {onkeydown} />

<div class="modal">
  <nav class="nav">
    <div class="nav-title">Providers</div>
    {#each app.providers as p (p.kind)}
      <button
        class="nav-item"
        class:active={p.kind === selected}
        class:muted={!railVisible(p.kind)}
        onclick={() => select(p.kind)}
      >
        <span class="dot" class:ok={p.available}></span>
        <span class="nav-label">{providerLabel(p.kind)}</span>
      </button>
    {/each}
    <div class="nav-spacer"></div>
    <button class="close" onclick={() => (app.showSettings = false)}>
      Close
    </button>
  </nav>

  {#if provider}
    <div class="pane">
      <div class="pane-head">
        <span class="pane-title">{providerLabel(provider.kind)}</span>
        <span class="slug">{provider.kind}</span>
      </div>
      {#if PROVIDER_NOTES[provider.kind]}
        <p class="note">{PROVIDER_NOTES[provider.kind]}</p>
      {/if}

      <label class="row visible-row">
        <input
          type="checkbox"
          checked={railVisible(provider.kind)}
          onchange={() => toggleRail(provider.kind)}
        />
        <span>Show in the connection rail</span>
      </label>

      <section class="section">
        <div class="section-title">API key</div>
        <div class="key-status">
          {#if provider.key_source === "stored"}
            Using a key stored in the OS credential store.
          {:else if provider.key_source === "env"}
            Using a key from an environment variable.
          {:else if provider.kind === "openai-chat"}
            No key set — local servers don't need one.
          {:else}
            No key set.
          {/if}
        </div>
        <form
          class="key-form"
          onsubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <input
            type="password"
            bind:value={keyDraft}
            placeholder="paste API key…"
            autocomplete="off"
            disabled={keyBusy}
          />
          <button type="submit" disabled={keyBusy || !keyDraft.trim()}>
            save
          </button>
          {#if provider.key_source === "stored"}
            <button type="button" onclick={() => void clearKey()} disabled={keyBusy}>
              clear
            </button>
          {/if}
        </form>
        {#if keyError}
          <div class="error">{keyError}</div>
        {/if}
      </section>

      <section class="section models-section">
        <div class="section-title">
          <span>Models</span>
          <button
            class="refresh"
            onclick={() => void fetchModels(selected, true)}
            disabled={fetchState?.loading || !provider.available}
            title={provider.available
              ? "Query the provider's API for its model list"
              : "Needs an API key"}
          >
            {fetchState?.loading ? "fetching…" : "refresh from API"}
          </button>
        </div>
        {#if provider.kind === "openai-chat"}
          <div class="hint">
            Fetches from the base URL set in the rail
            {app.draft.baseUrl.trim() ? `(${app.draft.baseUrl.trim()})` : "(not set)"}.
          </div>
        {/if}
        {#if fetchState?.error}
          <div class="error">{fetchState.error}</div>
        {/if}
        {#if candidates.length > 8 || filter}
          <input
            class="filter"
            type="text"
            bind:value={filter}
            placeholder="filter models…"
          />
        {/if}
        <div class="model-list">
          {#each candidates as m (m)}
            <label class="row">
              <input
                type="checkbox"
                checked={modelOn(provider.kind, m)}
                onchange={() => toggleModel(provider.kind, m)}
              />
              <span class="model">{m}</span>
            </label>
          {:else}
            <div class="hint">
              No models listed yet — fetch from the API or add one below.
            </div>
          {/each}
        </div>
        <form
          class="add"
          onsubmit={(e) => {
            e.preventDefault();
            addCustom();
          }}
        >
          <input type="text" bind:value={addDraft} placeholder="add model id…" />
          <button type="submit" disabled={!addDraft.trim()}>add</button>
        </form>
        <div class="hint">
          Checked models appear in the rail's dropdown. Unchecking hides —
          nothing is deleted.
        </div>
      </section>
    </div>
  {/if}
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
    gap: 0.5rem;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 0.82rem;
    text-align: left;
    padding: 0.4rem 0.45rem;
    border-radius: 8px;
    cursor: pointer;
  }
  .nav-item:hover {
    background: #1b1830;
  }
  .nav-item.active {
    background: #221e3a;
  }
  .nav-item.muted .nav-label {
    color: var(--dim);
  }
  .nav-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    flex-shrink: 0;
    opacity: 0.5;
  }
  .dot.ok {
    background: #6fdc8c;
    opacity: 1;
  }
  .nav-spacer {
    flex: 1;
  }
  .close {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--dim);
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .close:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .pane {
    padding: 0.9rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    min-height: 0;
  }
  .pane-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .pane-title {
    font-size: 1rem;
    font-weight: 600;
  }
  .slug {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--dim);
  }
  .note {
    color: var(--dim);
    font-size: 0.78rem;
    margin: 0;
    line-height: 1.45;
  }
  .section {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .section-title {
    font-size: 0.75rem;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .key-status {
    font-size: 0.78rem;
  }
  .key-form,
  .add {
    display: flex;
    gap: 0.4rem;
  }
  input[type="password"],
  input[type="text"] {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    font-size: 0.78rem;
    font-family: var(--mono);
    min-width: 0;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .key-form button,
  .add button,
  .refresh {
    background: transparent;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    font-size: 0.74rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .key-form button:hover:not(:disabled),
  .add button:hover:not(:disabled),
  .refresh:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .key-form button:disabled,
  .add button:disabled,
  .refresh:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .refresh {
    text-transform: none;
    letter-spacing: normal;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    padding: 0.1rem 0;
    cursor: pointer;
  }
  .row input[type="checkbox"] {
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .visible-row {
    font-size: 0.82rem;
  }
  .models-section {
    min-height: 0;
  }
  .filter {
    flex: none;
  }
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    max-height: 14rem;
  }
  .model {
    font-family: var(--mono);
    font-size: 0.76rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--dim);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .error {
    color: var(--error);
    background: rgba(246, 109, 124, 0.08);
    border: 1px solid rgba(246, 109, 124, 0.3);
    border-radius: 8px;
    padding: 0.4rem 0.55rem;
    font-size: 0.74rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
