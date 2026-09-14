<script lang="ts">
  import {
    app,
    applyDraft,
    currentModelId,
    fetchModels,
    openModelInstructions,
    refreshProviders,
    refreshSearchBackends,
    saveDreamPrefs,
    setPalette,
    setPrefs,
    useKnowledgeDir,
    loadContextLimits,
    PALETTES,
  } from "./state.svelte";
  import * as api from "./api";
  import {
    CURATED,
    PROVIDER_NOTES,
    formatWindow,
    groupModels,
    modelInstructionFile,
    modelOfInstructionFile,
    modelsFor,
    providerLabel,
    type ModelEntry,
    type ModelSection,
  } from "./catalog";
  import type { Note, ProviderInfo, SearchBackendInfo } from "./types";
  import Icon from "./Icon.svelte";

  /**
   * Redesigned 2026-09-13 (nightshift surface-redesign-2026-09-13, canvas
   * rows 4 and 6; blockers 032–034): the nav carries each row's key state,
   * the pane header carries the picker switch and the ×, the API key card
   * leads only until a key exists and then folds to one line at the foot,
   * and the model picker is rows — checkbox · id · default · dated releases
   * · context window — under a strip of everything that is on, in the
   * picker's order. `candidates`, `modelOn`, `toggleModel`, `setSection` and
   * `showFolded` are untouched: the order rule and the pin rule live there.
   */

  // Opens on the pane a round trip asked for — back from a model's
  // instruction file — else on the rail's provider.
  let selected = $state(
    app.settingsOpenOn ?? (app.draft.provider || app.providers[0]?.kind || ""),
  );
  app.settingsOpenOn = null;
  let keyDraft = $state("");
  let keyBusy = $state(false);
  let keyError = $state<string | null>(null);
  let filter = $state("");
  let addDraft = $state("");
  /** Fold groups the user has opened, keyed by the canonical id they fold into. */
  let expanded = $state<Record<string, boolean>>({});
  /** The demoted key row's Replace… — shows the card again at the foot. */
  let replacing = $state(false);

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

  /**
   * The per-model instruction files (nightshift backlog 044): every
   * `~/.nightloom/models/*.md`, read when the modal opens for the nav's
   * count and again whenever the pane is shown, since the editor may have
   * added or emptied one in between. Listed by id rather than file name —
   * the `__` in the name is the `/` of a router id.
   */
  let modelFiles = $state<Note[]>([]);
  async function refreshModelFiles() {
    try {
      modelFiles = await api.listNotes("models");
    } catch {
      modelFiles = [];
    }
  }
  void refreshModelFiles();
  $effect(() => {
    if (selected === "models") void refreshModelFiles();
  });
  /** The model the "+ add" control names: the rail's, by the same rule the
   *  popover's pencil uses. */
  const addModel = $derived(currentModelId());
  /** Whether the current model already has a file — then "+ add" is "edit". */
  const addExists = $derived(
    !!addModel && modelFiles.some((f) => f.name === modelInstructionFile(addModel)),
  );
  function size(bytes: number): string {
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function select(kind: string) {
    selected = kind;
    keyDraft = "";
    keyError = null;
    filter = "";
    addDraft = "";
    replacing = false;
  }

  /** Which of the key card's states a provider is in. */
  function keyState(p: ProviderInfo): "stored" | "env" | "local" | "none" {
    if (p.key_source === "stored") return "stored";
    if (p.key_source === "env") return "env";
    return p.kind === "openai-chat" ? "local" : "none";
  }
  /** The nav's mono state for a provider row. */
  function navState(p: ProviderInfo): { cls: string; text: string } {
    switch (keyState(p)) {
      case "stored":
        return { cls: "ok", text: "key" };
      case "env":
        return { cls: "env", text: "env" };
      case "local":
        return { cls: "", text: "local" };
      default:
        return { cls: "", text: "no key" };
    }
  }

  /**
   * The strip at the top of the Models card: every id that is on, in the
   * order the popover lists them — `modelsFor` is the popover's own list, so
   * the two can never disagree.
   */
  const pickerOrder = $derived(
    provider ? modelsFor(provider.kind, app.prefs, provider.default_model) : [],
  );
  const total = $derived(sections.reduce((n, s) => n + s.entries.length, 0));

  // Context windows for the rows and their snapshots; blank when unknown.
  $effect(() => {
    if (!provider) return;
    const ids = sections.flatMap((s) => s.entries.flatMap((e) => [e.id, ...e.folded]));
    void loadContextLimits(provider.kind, ids);
  });
  const windows = $derived(provider ? (app.contextLimits[provider.kind] ?? {}) : {});

  function close() {
    app.showSettings = false;
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

<!-- The API key card, in its six states (board 3c): no key, typing, stored,
     from the environment, local (no key needed), save failed. One snippet
     for providers and search backends alike; `env` names the variable when
     the backend told us it (search backends do, providers do not). -->
{#snippet keyCard(
  state: "stored" | "env" | "local" | "none",
  label: string,
  env: string | null,
  save: () => void,
  clear: (() => void) | null,
  extra: string,
  cancel: (() => void) | null,
)}
  <section class="card keycard">
    <div class="ch">
      <span class="t"><Icon name="key" size={13} /> API key</span>
    </div>
    <div class="kstate">
      {#if state === "stored"}
        <span class="ns-pill done"><span class="dot"></span>stored in the keychain</span>
        <span class="dim small">
          Kept in the OS credential store. Nightloom never shows it again — paste a
          new one to replace it.{extra}
        </span>
      {:else if state === "env"}
        <span class="ns-pill live"><span class="dot"></span>from {env ?? "the environment"}</span>
        <span class="dim small">Read from the environment at launch. A key saved here wins over it.{extra}</span>
      {:else if state === "local"}
        <span class="ns-pill grey">no key needed</span>
        <span class="dim small">
          Local servers don't need one. Set the base URL in the model popover; a
          key pasted here is sent as a bearer token.
        </span>
      {:else}
        <span class="ns-pill grey">no key</span>
        <span class="dim small">
          Paste a {label} API key to use it. Stored in the OS credential store,
          never in a file.
        </span>
      {/if}
    </div>
    <form
      class="kf"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        bind:value={keyDraft}
        placeholder={state === "stored"
          ? "paste a new key to replace it…"
          : state === "env"
            ? "paste a key to store one instead…"
            : state === "local"
              ? "paste an API key (optional)…"
              : "paste API key…"}
        autocomplete="off"
        autofocus={state === "none"}
        disabled={keyBusy}
        aria-label="API key"
      />
      <button type="submit" class="ns-btn accent" disabled={keyBusy || !keyDraft.trim()}>
        Save key
      </button>
      {#if state === "stored" && clear}
        <button type="button" class="ns-btn ghost" onclick={clear} disabled={keyBusy}>
          <Icon name="trash" size={13} />
          Remove
        </button>
      {/if}
      {#if cancel}
        <button type="button" class="ns-btn ghost" onclick={cancel} disabled={keyBusy}>
          Cancel
        </button>
      {/if}
    </form>
    {#if keyError}
      <div class="error">{keyError}</div>
    {/if}
  </section>
{/snippet}

<div class="modal">
  <nav class="nav">
    <div class="nav-h">Settings</div>
    <div class="nav-title">Providers</div>
    {#each app.providers as p (p.kind)}
      {@const st = navState(p)}
      <button
        class="nav-item"
        class:active={p.kind === selected}
        class:muted={!railVisible(p.kind)}
        onclick={() => select(p.kind)}
      >
        <span class="nav-label">{providerLabel(p.kind)}</span>
        <span class="st">
          {#if !railVisible(p.kind)}<span class="eye" title="Hidden from the model picker"><Icon name="eye-off" size={12} /></span>{/if}
          <span class="dot {st.cls}"></span>{st.text}
        </span>
      </button>
    {/each}
    <div class="nav-title">Web search</div>
    {#each app.searchBackends as b (b.name)}
      <button
        class="nav-item"
        class:active={"search:" + b.name === selected}
        onclick={() => select("search:" + b.name)}
      >
        <span class="nav-label">{b.label}</span>
        <span class="st">
          <span class="dot" class:ok={b.key_source === "stored"} class:env={b.key_source === "env"}></span>
          {b.key_source === "stored" ? "key" : b.key_source === "env" ? "env" : "no key"}
        </span>
      </button>
    {/each}
    <div class="nav-title">Knowledge</div>
    <button
      class="nav-item"
      class:active={selected === "knowledge"}
      onclick={() => select("knowledge")}
    >
      <span class="nav-label">Knowledge base</span>
      <span class="st">
        <span class="dot" class:ok={!!app.knowledge}></span>
        {app.knowledge ? `${app.knowledge.notes} note${app.knowledge.notes === 1 ? "" : "s"}` : "none"}
      </span>
    </button>
    <button
      class="nav-item"
      class:active={selected === "models"}
      onclick={() => select("models")}
    >
      <span class="nav-label">Model instructions</span>
      <span class="st">
        <span class="dot" class:ok={modelFiles.length > 0}></span>
        {modelFiles.length === 0 ? "none" : `${modelFiles.length} model${modelFiles.length === 1 ? "" : "s"}`}
      </span>
    </button>
    <div class="nav-title">Appearance</div>
    <button
      class="nav-item"
      class:active={selected === "appearance"}
      onclick={() => select("appearance")}
    >
      <span class="nav-label">Palette</span>
      <span class="st">{app.palette}</span>
    </button>
    <div class="nav-spacer"></div>
    <div class="nav-foot">Esc or click outside to close</div>
  </nav>

  {#if selected === "appearance"}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Palette</h2>
        <span class="slug">{app.palette}</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        Four dark palettes. Surfaces and the accent change; the colours that
        mean something — done, partial, failed, live, added, removed — are the
        same in all four. Applies at once, everywhere, and is remembered.
      </p>
      <div class="swatches" role="radiogroup" aria-label="Palette">
        {#each PALETTES as p (p.id)}
          <button
            class="swatch"
            class:on={app.palette === p.id}
            role="radio"
            aria-checked={app.palette === p.id}
            data-palette={p.id}
            onclick={() => setPalette(p.id)}
          >
            <span class="swatch-paper">
              <span class="swatch-sheet">
                <span class="swatch-title">Aa</span>
                <span class="swatch-accent"></span>
              </span>
            </span>
            <span class="swatch-name"><b>{p.id}</b> {p.name}</span>
          </button>
        {/each}
      </div>
    </div>
  {:else if selected === "knowledge"}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Knowledge base</h2>
        <span class="slug">{app.knowledge?.alias ?? "@kb"}</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        Your own notes, kept across every project and available in every
        conversation — including one with no project open, which the project's
        own notes can never be. The model reads, writes and searches them with
        the file tools at <code>{app.knowledge?.alias ?? "@kb"}</code>, and an
        index of the folder is in its system prompt. Notes link to each other
        with <code>[[name]]</code>.
      </p>

      <section class="card">
        <div class="ch"><span class="t">Folder</span></div>
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
        <div class="kf">
          <button class="ns-btn" disabled={!app.knowledge} onclick={() => void pickKnowledge()}
            >Choose folder…</button
          >
          <button
            class="ns-btn ghost"
            disabled={!app.knowledge || app.knowledge.is_default}
            onclick={() => void useKnowledgeDir(null)}
          >
            Reset to default
          </button>
        </div>
      </section>

      <section class="card">
        <div class="ch"><span class="t">Dreaming</span></div>
        <p class="note small">
          A dream pass consolidates the memory inbox into the vault — the
          Dream button in the Notes panel runs one by hand. Switched on here,
          one also runs after a compaction: the moment a conversation's detail
          is already being traded for a summary, and the trigger the
          consolidation evidence points at. It runs unattended and spends real
          money, so it is off until you say otherwise.
        </p>
        <label class="dream-auto">
          <input
            type="checkbox"
            bind:checked={app.dreamPrefs.auto}
            onchange={saveDreamPrefs}
          />
          <span>Dream automatically after a compaction</span>
        </label>
        <!-- The pass reads no chat context, so it does not need the chat's
             model — a cheap one does this job well, and an automatic pass is
             exactly where cost compounds. -->
        <p class="note small">
          Which model dreams. Leave on the rail's connection to dream with
          whatever the chat runs on; picking a provider here also lets the
          Claude Code engine dream, which has no provider of its own to lend.
        </p>
        <div class="kf">
          <select bind:value={app.dreamPrefs.provider} onchange={saveDreamPrefs}>
            <option value="">the rail's connection</option>
            {#each app.providers as p (p.kind)}
              <option value={p.kind}>{providerLabel(p.kind)}</option>
            {/each}
          </select>
          <input
            type="text"
            placeholder="model — blank for the provider's default"
            disabled={!app.dreamPrefs.provider}
            bind:value={app.dreamPrefs.model}
            onchange={saveDreamPrefs}
          />
        </div>
      </section>
    </div>
  {:else if selected === "models"}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Model instructions</h2>
        <span class="slug">~/.nightloom/models</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        A file per model, read whole into the system prompt of a chat on that
        model and no other — after your memory, before the project's
        instructions. For how you want one model in particular to talk; what
        you want of every model belongs in Memory. Named after the model id,
        so a chat on <code>claude-opus-5</code> reads
        <code>claude-opus-5.md</code>. On the Claude Code engine the name is
        the alias the picker sends (<code>opus</code>, <code>sonnet</code>).
        An empty file is the same as none.
      </p>

      <section class="card">
        <div class="ch"><span class="t">Files</span></div>
        {#if modelFiles.length === 0}
          <div class="key-status">No model has its own instructions yet.</div>
        {:else}
          <div class="mfiles">
            {#each modelFiles as f (f.name)}
              <button
                class="mfile"
                title={`Edit ${f.name}`}
                onclick={() => openModelInstructions(modelOfInstructionFile(f.name), "settings")}
              >
                <span class="mid">{modelOfInstructionFile(f.name)}</span>
                <span class="msz">{size(f.bytes)}</span>
                <Icon name="pencil" size={12} />
              </button>
            {/each}
          </div>
        {/if}
        <div class="kf">
          <button
            class="ns-btn"
            disabled={!addModel}
            title={addModel
              ? `Opens the editor on ${modelInstructionFile(addModel)}`
              : "Pick a model in the popover first"}
            onclick={() => addModel && openModelInstructions(addModel, "settings")}
          >
            {addExists ? "Edit for" : "+ Add for"} {addModel ?? "the current model"}
          </button>
        </div>
      </section>
    </div>
  {:else if searchSel}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">{searchSel.label}</h2>
        <span class="slug">{searchSel.env_key}</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        A key here turns on <code>web_search</code>. Every backend with a key is
        asked in turn — Tavily, then Brave, then Exa — until one answers, and
        one whose key is rejected or whose credit has run out drops out for the
        rest of the session. A second key is a spare, not a second search: one
        query is never sent to more than one of them.
        <code>web_fetch</code> needs no key and is always available.
      </p>
      {@render keyCard(
        searchSel.key_source === "stored" ? "stored" : searchSel.key_source === "env" ? "env" : "none",
        searchSel.label,
        searchSel.env_key,
        () => void saveSearchKey(),
        () => void saveSearchKey(true),
        chainNote(searchSel),
        null,
      )}
    </div>
  {:else if provider}
    {@const state = keyState(provider)}
    {@const keyFirst = provider.key_source === null}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">{providerLabel(provider.kind)}</h2>
        <span class="slug">{provider.kind}</span>
        <span class="spacer"></span>
        <label class="sw2" title="Off hides this provider from the popover's pills. The one in use stays listed.">
          <input
            type="checkbox"
            class="sw"
            checked={railVisible(provider.kind)}
            onchange={() => toggleRail(provider.kind)}
          />
          Show in the model picker
        </label>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      {#if PROVIDER_NOTES[provider.kind]}
        <p class="note">{PROVIDER_NOTES[provider.kind]}</p>
      {/if}

      <!-- The key card leads while there is no key — it is the first thing
           to do with a provider — and once one exists it folds to a line at
           the foot (blocker 032). -->
      {#if keyFirst}
        {@render keyCard(state, providerLabel(provider.kind), null, () => void saveKey(), null, "", null)}
      {/if}

      <section class="card models">
        <div class="ch">
          <span class="t">Models</span>
          <span class="ns-pill open">{onCount} of {total} in the picker</span>
          <span class="spacer"></span>
          <span class="filter-wrap">
            <Icon name="search" size={13} />
            <input
              class="filter"
              type="text"
              bind:value={filter}
              placeholder="filter…"
              aria-label="Filter models"
            />
          </span>
          <button
            class="ns-btn"
            onclick={() => void fetchModels(selected, true)}
            disabled={fetchState?.loading || !provider.available}
            title={provider.available
              ? "Query the provider's API for its model list"
              : "Needs an API key"}
          >
            <Icon name="refresh" size={13} />
            {fetchState?.loading ? "fetching…" : "Refresh from API"}
          </button>
        </div>
        {#if provider.kind === "openai-chat"}
          <div class="hint">
            Fetches from the base URL set in the model popover
            {app.draft.baseUrl.trim() ? `(${app.draft.baseUrl.trim()})` : "(not set)"}.
          </div>
        {/if}
        {#if fetchState?.error}
          <div class="error">{fetchState.error}</div>
        {/if}

        <!-- Every id that is on, in the popover's order, so the selection is
             readable without scrolling the list (his 16:50 addendum). -->
        <div class="strip">
          <span class="ns-k">In the picker</span>
          {#each pickerOrder as m (m)}
            <button
              class="cart on"
              title="Click to drop {m} from the picker"
              onclick={() => toggleModel(provider.kind, m)}
            >
              <Icon name="check" size={11} />{m}
            </button>
          {:else}
            <span class="dim small">nothing yet — tick a row below</span>
          {/each}
          {#if pickerOrder.length > 0}
            <span class="dim small strip-note">in this order · click to drop</span>
          {/if}
        </div>
        {#if !provider.available}
          <div class="hint">
            Add a key and the live list is fetched. Until then, the curated
            {(CURATED[provider.kind] ?? []).length}.
          </div>
        {/if}

        <div class="mrows">
          {#each sections as s, i (s.name + "#" + i)}
            <div class="famh" class:bare={!s.name}>
              {#if s.name}<span class="ns-k">{s.name}</span>{/if}
              <span class="rule"></span>
              <span class="bulk">
                <button
                  class:on={sectionAllOn(provider.kind, s)}
                  onclick={() => setSection(provider.kind, s, true)}>all</button
                >
                ·
                <button onclick={() => setSection(provider.kind, s, false)}>none</button>
              </span>
            </div>
            {#each s.entries as e (e.id)}
              {@const on = modelOn(provider.kind, e.id)}
              <div class="mr" class:on>
                <button
                  class="cb"
                  class:on
                  role="checkbox"
                  aria-checked={on}
                  aria-label="{e.id} in the picker"
                  onclick={() => toggleModel(provider.kind, e.id)}
                >
                  {#if on}<Icon name="check" size={11} />{/if}
                </button>
                <span class="id" title={e.id}>{e.id}</span>
                {#if e.id === provider.default_model}
                  <span class="ns-pill open dflt">default</span>
                {/if}
                {#if e.folded.length}
                  <button
                    class="rel"
                    class:open={showFolded(provider.kind, e)}
                    aria-expanded={showFolded(provider.kind, e)}
                    onclick={() => (expanded[e.id] = !expanded[e.id])}
                    title={`${e.folded.length} dated release${e.folded.length > 1 ? "s" : ""} folded into this one`}
                  >
                    <Icon name={showFolded(provider.kind, e) ? "chev" : "chevr"} size={12} />
                    {e.folded.length} dated release{e.folded.length > 1 ? "s" : ""}
                  </button>
                {/if}
                <span class="cx">{formatWindow(windows[e.id])}</span>
              </div>
              {#if showFolded(provider.kind, e)}
                {#each e.folded as f (f)}
                  {@const fon = modelOn(provider.kind, f)}
                  <div class="mr snap" class:on={fon}>
                    <button
                      class="cb"
                      class:on={fon}
                      role="checkbox"
                      aria-checked={fon}
                      aria-label="{f} in the picker"
                      onclick={() => toggleModel(provider.kind, f)}
                    >
                      {#if fon}<Icon name="check" size={11} />{/if}
                    </button>
                    <span class="id" title={f}>{f}</span>
                    <span class="cx">{formatWindow(windows[f])}</span>
                  </div>
                {/each}
              {/if}
            {/each}
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
          <input type="text" bind:value={addDraft} placeholder="add a model id…" aria-label="Model id to add" />
          <button type="submit" class="ns-btn" disabled={!addDraft.trim()}>
            <Icon name="plus" size={13} />
            Add
          </button>
          <span class="dim small">Checked = in the popover's list. A dated release you pin stays visible.</span>
        </form>
      </section>

      {#if !keyFirst}
        {#if replacing}
          {@render keyCard(
            state,
            providerLabel(provider.kind),
            null,
            () => void saveKey(),
            () => void clearKey(),
            "",
            () => (replacing = false),
          )}
        {:else}
          <div class="keyrow">
            <Icon name="key" size={13} />
            {#if state === "stored"}
              <span class="ns-pill done"><span class="dot"></span>API key stored in the keychain</span>
            {:else}
              <span class="ns-pill live"><span class="dot"></span>API key from the environment</span>
            {/if}
            <span class="lk">
              <button class="ns-link" onclick={() => (replacing = true)}>
                {state === "stored" ? "Replace…" : "Store one instead…"}
              </button>
              {#if state === "stored"}
                <button class="ns-link danger" onclick={() => void clearKey()} disabled={keyBusy}>Remove</button>
              {/if}
            </span>
            {#if keyError}<span class="error inline">{keyError}</span>{/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .modal {
    background: var(--sheet);
    border: 1px solid var(--line2);
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
    grid-template-columns: 13.5rem 1fr;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .nav {
    border-right: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    padding: 16px 10px;
    gap: 2px;
    overflow-y: auto;
  }
  .nav-h {
    font-family: var(--serif);
    font-size: 20px;
    font-weight: 500;
    padding: 0 10px 6px;
    color: var(--ink);
  }
  .nav-title {
    padding: 12px 10px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 7px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .nav-item:hover {
    background: var(--well);
  }
  .nav-item.active {
    background: var(--well);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .nav-item.muted .nav-label {
    color: var(--dim);
  }
  .nav-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .st {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    flex: none;
  }
  .eye {
    display: inline-flex;
    color: var(--dim);
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
    background: var(--done);
    opacity: 1;
  }
  .dot.env {
    background: var(--live);
    opacity: 1;
  }
  .nav-spacer {
    flex: 1;
  }
  .nav-foot {
    font-size: 11px;
    color: var(--dim);
    padding: 0 10px;
  }

  .pane {
    padding: 20px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
  }
  .pane-title {
    margin: 0;
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .slug {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
  }
  .spacer {
    flex: 1;
  }
  .close {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .close:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .sw2 {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--ink2);
    cursor: pointer;
    white-space: nowrap;
  }
  .sw {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    width: 26px;
    height: 15px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--line2);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--dim);
    transition:
      transform 0.15s ease,
      background 0.15s ease;
  }
  .sw:checked {
    background: var(--accent);
  }
  .sw:checked::after {
    transform: translateX(11px);
    background: var(--accent);
    box-shadow: inset 0 0 0 2px var(--paper);
  }

  .note {
    color: var(--dim);
    font-size: 13px;
    margin: 0;
    line-height: 1.45;
  }
  .note.small {
    font-size: 12px;
  }
  .note code {
    font-family: var(--mono);
    font-size: 0.92em;
  }
  .dim {
    color: var(--dim);
  }
  .small {
    font-size: 12px;
  }

  /* Cards: the key card, the models card, the knowledge cards. */
  .card {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: none;
  }
  .card .ch {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .card .ch .t {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .kstate {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .kf,
  .add {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .kf input[type="password"] {
    flex: 1;
    min-width: 12rem;
  }
  .key-status {
    font-size: 13px;
  }
  /* Wraps rather than ellipsizes: a folder you cannot read the end of is one
     you cannot check you picked correctly. */
  .path {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  /* The model-instruction files, one row each: id, size, pencil. */
  .mfiles {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .mfile {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: none;
    border-top: 1px solid var(--line);
    background: transparent;
    color: var(--ink2);
    font: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
  }
  .mfile:first-child {
    border-top: none;
  }
  .mfile:hover {
    color: var(--accent);
  }
  .mfile .mid {
    flex: 1;
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mfile .msz {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
  }
  .dream-auto {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 13px;
    color: var(--ink);
    cursor: pointer;
  }
  select,
  input[type="password"],
  input[type="text"] {
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: var(--mono);
    min-width: 0;
  }
  select {
    font-family: var(--sans);
  }
  .kf input[type="text"] {
    flex: 1;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  input:disabled {
    opacity: 0.55;
  }

  /* The models card takes what the pane has left, and its rows scroll under
     the header, the strip and above the add-row. */
  .card.models {
    flex: 1 1 auto;
    min-height: 14rem;
    gap: 10px;
    overflow: hidden;
  }
  .filter-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: 0 1 200px;
    min-width: 110px;
  }
  .filter-wrap :global(.ns-ico) {
    position: absolute;
    left: 9px;
    color: var(--dim);
    pointer-events: none;
  }
  .filter {
    width: 100%;
    padding: 5px 9px 5px 28px !important;
    font-size: 12.5px !important;
    font-family: var(--sans) !important;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    flex: none;
  }
  .strip .ns-k {
    margin-right: 4px;
  }
  .strip-note {
    margin-left: auto;
  }
  .cart {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--dim);
    background: var(--sheet);
    cursor: pointer;
  }
  .cart.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .cart.on:hover {
    color: var(--failed);
    border-color: var(--failed);
  }

  .mrows {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 6rem;
    scrollbar-width: thin;
  }
  .famh {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 10px 4px;
  }
  .famh:first-child {
    padding-top: 2px;
  }
  .famh .rule {
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .famh.bare .rule {
    background: transparent;
  }
  .bulk {
    font-size: 11px;
    color: var(--dim);
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .bulk button {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--dim);
    cursor: pointer;
  }
  .bulk button:hover,
  .bulk button.on {
    color: var(--accent);
  }
  .mr {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    flex: none;
  }
  .mr:nth-child(even) {
    background: color-mix(in srgb, var(--sheet) 55%, transparent);
  }
  .cb {
    width: 15px;
    height: 15px;
    padding: 0;
    border: 1.5px solid var(--line2);
    border-radius: 4px;
    background: var(--paper);
    color: var(--paper);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    cursor: pointer;
  }
  .cb.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .cb :global(.ns-ico) {
    stroke-width: 2.2;
  }
  .cb:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .mr .id {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink2);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr.on .id {
    color: var(--ink);
  }
  .dflt {
    font-size: 10px;
    padding: 0 6px;
  }
  .rel {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 11px;
    color: var(--dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .rel:hover,
  .rel.open {
    color: var(--accent);
  }
  .cx {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    width: 44px;
    text-align: right;
    flex: none;
  }
  .mr.snap {
    margin-left: 16px;
    padding-left: 34px;
    border-left: 2px solid var(--line);
    border-radius: 0;
  }
  .mr.snap .id {
    font-size: 11.5px;
  }
  .add {
    padding-top: 10px;
    border-top: 1px solid var(--line);
    flex: none;
  }
  .add input {
    flex: 0 1 320px;
  }

  /* The demoted key row, once a key exists (blocker 032). */
  .keyrow {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    font-size: 12.5px;
    color: var(--ink2);
    flex: none;
    flex-wrap: wrap;
  }
  .keyrow .lk {
    display: flex;
    gap: 14px;
    margin-left: auto;
  }
  .ns-link.danger {
    color: var(--failed);
  }
  .ns-link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hint {
    color: var(--dim);
    font-size: 12px;
    line-height: 1.4;
  }
  .error {
    color: var(--error);
    background: var(--failed-soft);
    border: 1px solid rgba(246, 109, 124, 0.3);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .error.inline {
    flex-basis: 100%;
  }

  /* The palette swatches. Each button carries its own `data-palette`, so
     the token blocks in app.css colour the preview the way they would colour
     the app — the swatch is the palette, not a picture of it. */
  .swatches {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
  }
  .swatch {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.5rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font: inherit;
  }
  .swatch:hover {
    border-color: var(--dim);
  }
  .swatch.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .swatch-paper {
    display: block;
    height: 84px;
    border-radius: 6px;
    background: var(--paper);
    border: 1px solid var(--line);
    padding: 12px;
  }
  .swatch-sheet {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 100%;
    border-radius: 5px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    padding: 0 14px;
  }
  .swatch-title {
    font-family: var(--serif);
    font-size: 26px;
    color: var(--ink);
  }
  .swatch-accent {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent);
  }
  .swatch-name {
    font-size: 0.8rem;
    color: var(--dim);
  }
  .swatch-name b {
    color: var(--text);
    font-weight: 600;
    margin-right: 0.3rem;
  }
</style>
