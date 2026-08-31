<script lang="ts">
  import {
    app,
    applyDraft,
    fetchModels,
    refreshProviders,
    refreshSearchBackends,
    setPrefs,
    useKnowledgeDir,
  } from "./state.svelte";
  import * as api from "./api";
  import {
    CURATED,
    PROVIDER_NOTES,
    groupModels,
    providerLabel,
    type ModelEntry,
    type ModelSection,
  } from "./catalog";
  import type { SearchBackendInfo } from "./types";

  let selected = $state(app.draft.provider || app.providers[0]?.kind || "");
  let keyDraft = $state("");
  let keyBusy = $state(false);
  let keyError = $state<string | null>(null);
  let filter = $state("");
  let addDraft = $state("");
  /** Fold groups the user has opened, keyed by the canonical id they fold into. */
  let expanded = $state<Record<string, boolean>>({});

  // One selection across both nav groups, with search backends namespaced so
  // a backend and a provider can never collide on a bare name.
  const searchSel = $derived(
    selected.startsWith("search:")
      ? (app.searchBackends.find((b) => b.name === selected.slice(7)) ?? null)
      : null,
  );
  const provider = $derived(
    searchSel ? undefined : app.providers.find((p) => p.kind === selected),
  );

  /**
   * Where this key sits in the chain. Worth a sentence rather than a badge:
   * a spare that is never reached looks identical to a key that does nothing,
   * and the difference is the reason to have set it.
   */
  function chainNote(b: SearchBackendInfo): string {
    if (b.order === null) return "";
    if (b.order === 1) return " Searches are sent here first.";
    const ahead = app.searchBackends
      .filter((o) => o.order !== null && o.order < b.order!)
      .map((o) => o.label)
      .join(" and ");
    return ` Held in reserve: searches go here if ${ahead} cannot answer.`;
  }
  const fetchState = $derived(app.modelFetch[selected]);

  void refreshSearchBackends();

  /** Everything checkable for the selected provider: curated ∪ custom ∪ fetched. */
  const candidates = $derived.by(() => {
    const seen = new Set<string>();
    const all: string[] = [];
    // Fetched before custom, deliberately. `customModels` is also the *storage*
    // for "this id is on", so an id that came from the API lands in it the
    // moment it is switched on — and with custom read first, turning a chip on
    // moved it (and its whole family, which sorts by its first member's index)
    // to the top of the list under the user's cursor. Read in the order the
    // lists were *sourced* and a toggle changes nothing but the chip.
    for (const m of [
      ...(CURATED[selected] ?? []),
      ...(app.modelLists[selected] ?? []),
      ...(app.prefs.customModels[selected] ?? []),
    ]) {
      if (!seen.has(m)) {
        seen.add(m);
        all.push(m);
      }
    }
    const q = filter.trim().toLowerCase();
    return q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  });

  /** The same list folded by release tag and split into families. */
  const sections = $derived(groupModels(candidates));
  const onCount = $derived(
    sections.reduce(
      (n, s) => n + s.entries.filter((e) => modelOn(selected, e.id)).length,
      0,
    ),
  );

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

  /**
   * The native folder dialog, opened at the current vault so "choose folder"
   * starts where the user last was rather than at a project they are not
   * thinking about.
   */
  async function pickKnowledge() {
    const picked = await api.pickFolder(
      "Choose a knowledge base folder",
      app.knowledge?.dir,
    );
    if (picked) await useKnowledgeDir(picked);
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

  /** Turn a whole family on or off in one write rather than one per chip. */
  function setSection(kind: string, s: ModelSection, on: boolean) {
    setPrefs((p) => {
      for (const e of s.entries) {
        const curated = (CURATED[kind] ?? []).includes(e.id);
        const list = curated ? (p.hiddenModels[kind] ??= []) : (p.customModels[kind] ??= []);
        // For a curated id the list holds what is *off*, for a custom id what
        // is *on* — so the same membership edit inverts between them.
        const want = curated ? !on : on;
        const i = list.indexOf(e.id);
        if (want && i < 0) list.push(e.id);
        if (!want && i >= 0) list.splice(i, 1);
      }
    });
  }
  function sectionAllOn(kind: string, s: ModelSection): boolean {
    return s.entries.every((e) => modelOn(kind, e.id));
  }

  /**
   * Folded snapshots stay hidden until asked for — except one the user already
   * turned on, which must stay visible or there would be a model in the rail's
   * dropdown with no switch anywhere in here to turn it back off.
   */
  function showFolded(kind: string, e: ModelEntry): boolean {
    return expanded[e.id] || e.folded.some((f) => modelOn(kind, f));
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

  async function saveSearchKey(clear = false) {
    if (!searchSel || keyBusy) return;
    const key = clear ? "" : keyDraft.trim();
    if (!key && !clear) return;
    keyBusy = true;
    keyError = null;
    try {
      await api.setSearchKey(searchSel.name, key);
      keyDraft = "";
      await refreshSearchBackends();
      // The tool set changes with the key, and the rail's chip is read off
      // the connection — so re-connect rather than leave it stale.
      if (app.draft.tools && app.draft.web) void applyDraft();
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
    <div class="nav-title search-title">Web search</div>
    {#each app.searchBackends as b (b.name)}
      <button
        class="nav-item"
        class:active={"search:" + b.name === selected}
        onclick={() => select("search:" + b.name)}
      >
        <span class="dot" class:ok={b.key_source !== null}></span>
        <span class="nav-label">{b.label}</span>
      </button>
    {/each}
    <div class="nav-title search-title">Knowledge</div>
    <button
      class="nav-item"
      class:active={selected === "knowledge"}
      onclick={() => select("knowledge")}
    >
      <span class="dot" class:ok={!!app.knowledge}></span>
      <span class="nav-label">Knowledge base</span>
    </button>
    <div class="nav-spacer"></div>
    <button class="close" onclick={() => (app.showSettings = false)}>
      Close
    </button>
  </nav>

  {#if selected === "knowledge"}
    <div class="pane">
      <div class="pane-head">
        <span class="pane-title">Knowledge base</span>
        <span class="slug">{app.knowledge?.alias ?? "@kb"}</span>
      </div>
      <p class="note">
        Your own notes, kept across every project and available in every
        conversation — including one with no project open, which the project's
        own notes can never be. The model reads, writes and searches them with
        the file tools at <code>{app.knowledge?.alias ?? "@kb"}</code>, and an
        index of the folder is in its system prompt. Notes link to each other
        with <code>[[name]]</code>.
      </p>

      <section class="section">
        <div class="section-title">Folder</div>
        <div class="key-status">
          {#if !app.knowledge}
            No user config directory on this machine, so there is nowhere to
            keep one.
          {:else}
            <code class="path">{app.knowledge.dir}</code>
            <br />
            {app.knowledge.notes} note{app.knowledge.notes === 1 ? "" : "s"}{app
              .knowledge.is_default
              ? ", the default location"
              : ", set here rather than the default"}{app.knowledge.exists
              ? ""
              : " — not created yet; it appears with the first note"}.
          {/if}
        </div>
        <!-- Repointing moves nothing, and saying so is the point: someone
             aiming this at an existing Obsidian vault needs to know their
             files stay where they are. -->
        <p class="note small">
          Point this at any folder — an existing Obsidian vault works as-is.
          Nothing is moved or copied: the old folder and the new one are both
          left exactly as they are.
        </p>
        <div class="key-form">
          <button disabled={!app.knowledge} onclick={() => void pickKnowledge()}
            >Choose folder…</button
          >
          <button
            disabled={!app.knowledge || app.knowledge.is_default}
            onclick={() => void useKnowledgeDir(null)}
          >
            Reset to default
          </button>
        </div>
      </section>
    </div>
  {:else if searchSel}
    <div class="pane">
      <div class="pane-head">
        <span class="pane-title">{searchSel.label}</span>
        <span class="slug">{searchSel.env_key}</span>
      </div>
      <p class="note">
        A key here turns on <code>web_search</code>. Every backend with a key is
        asked in turn — Tavily, then Brave, then Exa — until one answers, and
        one whose key is rejected or whose credit has run out drops out for the
        rest of the session. A second key is a spare, not a second search: one
        query is never sent to more than one of them.
        <code>web_fetch</code> needs no key and is always available.
      </p>

      <section class="section">
        <div class="section-title">API key</div>
        <div class="key-status">
          {#if searchSel.key_source === "stored"}
            Using a key stored in the OS credential store.{chainNote(searchSel)}
          {:else if searchSel.key_source === "env"}
            Using a key from {searchSel.env_key}.{chainNote(searchSel)}
          {:else}
            No key set.
          {/if}
        </div>
        <form
          class="key-form"
          onsubmit={(e) => {
            e.preventDefault();
            void saveSearchKey();
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
          {#if searchSel.key_source === "stored"}
            <button
              type="button"
              onclick={() => void saveSearchKey(true)}
              disabled={keyBusy}
            >
              clear
            </button>
          {/if}
        </form>
        {#if keyError}
          <div class="error">{keyError}</div>
        {/if}
      </section>
    </div>
  {:else if provider}
    <div class="pane">
      <div class="pane-head">
        <span class="pane-title">{providerLabel(provider.kind)}</span>
        <span class="slug">{provider.kind}</span>
      </div>
      {#if PROVIDER_NOTES[provider.kind]}
        <p class="note">{PROVIDER_NOTES[provider.kind]}</p>
      {/if}

      <div class="carts">
        <button
          class="cart"
          class:on={railVisible(provider.kind)}
          aria-pressed={railVisible(provider.kind)}
          onclick={() => toggleRail(provider.kind)}
        >
          show in the connection rail
        </button>
      </div>

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
          {#each sections as s, i (s.name + "#" + i)}
            <div class="family">
              <div class="family-head" class:bare={!s.name}>
                <span class="family-name">{s.name}</span>
                <span class="family-rule"></span>
                <button
                  class="bulk"
                  onclick={() => setSection(provider.kind, s, !sectionAllOn(provider.kind, s))}
                >
                  {sectionAllOn(provider.kind, s) ? "none" : "all"}
                </button>
              </div>
              <div class="carts">
                {#each s.entries as e (e.id)}
                  <span class="cart-group">
                    <button
                      class="cart"
                      class:on={modelOn(provider.kind, e.id)}
                      class:joined={e.folded.length > 0}
                      aria-pressed={modelOn(provider.kind, e.id)}
                      onclick={() => toggleModel(provider.kind, e.id)}
                    >
                      {e.id}
                    </button>
                    {#if e.folded.length}
                      <button
                        class="fold"
                        class:open={showFolded(provider.kind, e)}
                        aria-expanded={showFolded(provider.kind, e)}
                        onclick={() => (expanded[e.id] = !expanded[e.id])}
                        title={`${e.folded.length} dated release${e.folded.length > 1 ? "s" : ""} folded into this one`}
                      >
                        +{e.folded.length}
                      </button>
                    {/if}
                  </span>
                  {#if showFolded(provider.kind, e)}
                    {#each e.folded as f (f)}
                      <button
                        class="cart snap"
                        class:on={modelOn(provider.kind, f)}
                        aria-pressed={modelOn(provider.kind, f)}
                        onclick={() => toggleModel(provider.kind, f)}
                      >
                        {f}
                      </button>
                    {/each}
                  {/if}
                {/each}
              </div>
            </div>
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
          {onCount} of {sections.reduce((n, s) => n + s.entries.length, 0)} in the
          rail's dropdown.
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
    /* Sized off the window rather than pinned to it: the model list is the
       one pane that is always longer than the space given to it, so a fixed
       34rem left a maximised window showing the same eight rows a small one
       did. Clamped at both ends — a proportional box alone would be unusable
       on a short window and absurd on a 4K one. */
    width: clamp(34rem, 74vw, 68rem);
    max-width: calc(100vw - 3rem);
    height: clamp(24rem, 82vh, 54rem);
    max-height: calc(100vh - 3rem);
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
  .search-title {
    margin-top: 14px;
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
  .note.small {
    font-size: 0.74rem;
  }
  /* Wraps rather than ellipsizes: a folder you cannot read the end of is one
     you cannot check you picked correctly. */
  .path {
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--text);
    overflow-wrap: anywhere;
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
  .models-section {
    /* Takes whatever the pane has left, so the extra height a larger window
       gives the modal lands on the list rather than on empty space below it. */
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .filter {
    flex: none;
  }
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
    /* The scroller, so the filter above it and the add-model form below it
       stay put while the list moves. `min-height` rather than a fixed height:
       on a very short window it gives way and the pane scrolls instead. */
    flex: 1 1 auto;
    min-height: 6rem;
  }
  .family {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .family-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .family-name {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--dim);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .family-name:empty {
    display: none;
  }
  .family-rule {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .family-head.bare .family-rule {
    background: transparent;
  }
  .bulk {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 0.68rem;
    padding: 0 0.15rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .family:hover .bulk,
  .bulk:focus-visible {
    opacity: 1;
  }
  .bulk:hover {
    color: var(--accent);
  }

  /* Cartouches: the chip *is* the switch, so its state has to read off the
     chip itself — border, fill and text weight together, since colour alone
     would leave the two states a shade apart on a dim list. */
  .carts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .cart-group {
    display: inline-flex;
    align-items: stretch;
  }
  .cart {
    font-family: var(--mono);
    font-size: 0.72rem;
    line-height: 1.1;
    padding: 0.28rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    white-space: nowrap;
    transition:
      color 0.1s,
      border-color 0.1s,
      background 0.1s;
  }
  .cart:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .cart.on {
    color: var(--text);
    border-color: var(--accent);
    background: rgba(139, 124, 246, 0.18);
  }
  .cart.on:hover {
    border-color: var(--accent);
    background: rgba(139, 124, 246, 0.28);
  }
  .cart:focus-visible,
  .fold:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .cart.joined {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
    padding-right: 0.45rem;
  }
  .fold {
    font-family: var(--mono);
    font-size: 0.66rem;
    padding: 0 0.45rem;
    border: 1px solid var(--border);
    border-left: 1px solid var(--border);
    border-radius: 0 999px 999px 0;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
  }
  .fold:hover,
  .fold.open {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* A pinned snapshot is a chip like any other, one step quieter so the id it
     was folded into still reads as the family's default. */
  .cart.snap {
    font-size: 0.68rem;
    padding: 0.24rem 0.5rem;
    border-style: dashed;
    opacity: 0.85;
  }
  .cart.snap.on {
    border-style: solid;
    opacity: 1;
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
