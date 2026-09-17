<script module lang="ts">
  /**
   * The pane he left, and when (nightshift backlog 109): reopening within
   * two minutes lands on it, later on the default. Module state rather
   * than `app`, since nothing outside this modal reads it; the modal is
   * unmounted on close, so the instance's own state cannot carry it.
   */
  let lastPane: { pane: string; closedAt: number } | null = null;
  export const REMEMBER_PANE_MS = 2 * 60 * 1000;
  /** The remembered pane if it was left within the window, else null. */
  export function recentPane(now = Date.now()): string | null {
    return lastPane && now - lastPane.closedAt <= REMEMBER_PANE_MS ? lastPane.pane : null;
  }
</script>

<script lang="ts">
  import {
    app,
    applyDraft,
    currentModelId,
    fetchModels,
    openChatInstructions,
    openModelInstructions,
    refreshProviders,
    refreshSearchBackends,
    saveDreamPrefs,
    runDailyPass,
    setDailyPrefs,
    setPalette,
    setPrefs,
    useKnowledgeDir,
    useProjectsFolder,
    loadContextLimits,
    PALETTES,
  } from "./state.svelte";
  import * as api from "./api";
  import {
    TRANSCRIPT_FONTS,
    TRANSCRIPT_SIZES,
    setTranscriptFont,
    setTranscriptSize,
    transcript,
  } from "./transcriptPrefs.svelte";
  import {
    AGENT_MODELS,
    CURATED,
    PROVIDER_NOTES,
    formatWindow,
    groupModels,
    instructionFileFor,
    modelInstructionFile,
    modelOfInstructionFile,
    modelsFor,
    providerLabel,
    type ModelEntry,
    type ModelSection,
  } from "./catalog";
  import type { Note, ProviderInfo, SearchBackendInfo, UsageSummary } from "./types";
  import { relativeTime } from "./time";
  import { dreamEngineRows, dreamModelPills, dreamSentence } from "./dreamRows";
  import { loadNotifyPrefs, saveNotifyPrefs, type NotifyPrefs } from "./notify";
  import { loadSleepPrefs, saveSleepPrefs, type SleepPrefs } from "./sleep";
  import {
    WRAP_UP,
    defaultMessage as handoffDefaultMessage,
    hasOwnDefaultMessage,
    setDefaultMessage as setHandoffDefaultMessage,
    setThreshold as setHandoffThreshold,
    threshold as handoffThreshold,
  } from "./handoff.svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import { isMac } from "./platform";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";

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
  // instruction file — else on the pane he left within the last two
  // minutes (backlog 109), else on the rail's provider.
  let selected = $state(
    app.settingsOpenOn ??
      recentPane() ??
      (app.draft.provider || app.providers[0]?.kind || ""),
  );
  app.settingsOpenOn = null;
  onDestroy(() => {
    lastPane = { pane: selected, closedAt: Date.now() };
  });
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
  /**
   * The Chat instructions (nightshift backlog 102): one file beside the
   * models' folder, `~/.nightloom/CHAT.md`, read by chats of the Chat kind.
   * Its path for the card, and whether it has anything in it — read the
   * way the editor reads it, so a missing file is empty text, not an error.
   */
  let chatPath = $state<string | null>(null);
  let chatBytes = $state<number | null>(null);
  async function refreshChatFile() {
    try {
      chatPath = await api.chatInstructionsPath();
      const text = await api.readNote("chat", "CHAT.md");
      chatBytes = new TextEncoder().encode(text).length;
    } catch {
      chatBytes = null;
    }
  }
  void refreshChatFile();
  $effect(() => {
    if (selected === "models") void refreshChatFile();
  });
  /** The model the "+ add" control names: the rail's, by the same rule the
   *  popover's pencil uses. */
  const addModel = $derived(currentModelId());
  /** Whether the current model already has a file — then "+ add" is "edit". */
  const addExists = $derived(
    !!addModel && modelFiles.some((f) => f.name === modelInstructionFile(addModel)),
  );

  /**
   * The any-model picker (nightshift backlog 053): a provider and a model
   * chosen here rather than in the popover, so Fable's file can be read or
   * started while the chat is on Opus. The provider list is every one the
   * app knows plus the Claude Code engine, which is not a provider but has
   * files of its own (named after the alias the picker sends). The model
   * list is what the provider's Settings pane would show — curated, fetched
   * where a key exists, custom — plus its default, since a chat may be on
   * that without it appearing anywhere; and an id in none of those can be
   * typed, because some providers only list with a key. The file is
   * `modelInstructionFile(id)`: the one rule, the same the preamble reads.
   */
  const AGENT_KIND = "claude-code";
  /** The model select's "type one instead" row; not a model id. */
  const OTHER = "<other>";
  let pickProvider = $state(
    app.draft.engine === "claude-code"
      ? AGENT_KIND
      : app.draft.provider || app.providers[0]?.kind || "",
  );
  let pickModel = $state("");
  let pickOther = $state(false);
  let pickText = $state("");
  let pickBusy = $state(false);
  let pickError = $state<string | null>(null);
  const pickProviders = $derived([
    ...app.providers.map((p) => ({ kind: p.kind, label: providerLabel(p.kind) })),
    { kind: AGENT_KIND, label: "Subscription engine" },
  ]);
  const pickModels = $derived.by(() => {
    if (pickProvider === AGENT_KIND) return AGENT_MODELS.filter((m) => m !== "");
    const p = app.providers.find((p) => p.kind === pickProvider);
    const seen = new Set<string>();
    const all: string[] = [];
    // The same sources in the same order as `candidates` above, and the
    // provider's default last if it is in none of them.
    for (const m of [
      ...(CURATED[pickProvider] ?? []),
      ...(app.modelLists[pickProvider] ?? []),
      ...(app.prefs.customModels[pickProvider] ?? []),
      ...(p?.default_model ? [p.default_model] : []),
    ]) {
      if (!seen.has(m)) {
        seen.add(m);
        all.push(m);
      }
    }
    return all;
  });
  // A provider with a key has its live list fetched once, as opening its
  // pane does — the same `fetchModels`, so the two never disagree.
  $effect(() => {
    const p = app.providers.find((p) => p.kind === pickProvider);
    if (p?.available) void fetchModels(pickProvider);
  });
  // The model follows the provider: the first of the new list, or the text
  // field when the list is empty (OpenAI-compatible with nothing added).
  // `untrack` so a pick of our own does not re-run this.
  $effect(() => {
    const list = pickModels;
    untrack(() => {
      if (!list.includes(pickModel)) {
        pickModel = list[0] ?? "";
        pickOther = list.length === 0;
      }
    });
  });
  function pickModelChanged(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === OTHER) {
      pickOther = true;
    } else {
      pickOther = false;
      pickModel = v;
    }
    pickError = null;
  }
  /** The id the picker names, whichever way it was chosen. */
  const pickId = $derived((pickOther ? pickText : pickModel).trim());
  /** Its file, when one exists — the dot, the size, and Open over Create. */
  const pickFile = $derived(
    pickId ? (modelFiles.find((f) => f.name === modelInstructionFile(pickId)) ?? null) : null,
  );
  /**
   * Open the picked pair's file, creating it first when there is none: one
   * header line naming the pair, written by the note call the editor's own
   * Save uses, then the editor on the same path the current-model row
   * opens. `api.saveNote` directly rather than the store's: the store's
   * re-connects the chat, and a header for a model the chat is not on is a
   * no-op there while the editor's Save re-connects anyway.
   */
  async function openPicked() {
    if (!pickId || pickBusy) return;
    if (!pickFile) {
      pickBusy = true;
      pickError = null;
      try {
        const { name, header } = instructionFileFor(pickProvider, pickId);
        await api.saveNote("models", name, header);
        await refreshModelFiles();
      } catch (e) {
        pickError = String(e);
        return;
      } finally {
        pickBusy = false;
      }
    }
    openModelInstructions(pickId, "settings");
  }

  /**
   * The usage ledger (nightshift backlog 045): what Claude Code has cost,
   * read from `~/.claude/usage-ledger.csv` and priced by the rates table
   * beside it — the user-global collector's files, never written here.
   * Read once when the modal opens, for the nav's 7-day figure, and again
   * whenever the pane is shown, since the collector runs on its own clock.
   * A missing ledger is `available: false` with the reason, not a failure;
   * a failed call reads as the same thing so Settings still opens.
   */
  let usage = $state<UsageSummary | null>(null);
  async function refreshUsage() {
    try {
      usage = await api.usageLedger();
    } catch (e) {
      usage = {
        available: false,
        reason: String(e),
        dir: "~/.claude",
        collector: "~/.claude/usage-ledger.py",
        first_date: null,
        last_date: null,
        updated_at: null,
        today: null,
        week: null,
        month: null,
        surfaces: null,
        unpriced_models: [],
      };
    }
  }
  void refreshUsage();
  $effect(() => {
    if (selected === "usage") void refreshUsage();
  });
  // The button: run the collector now rather than wait for its six-hourly
  // turn. A few seconds; the pane says so while it runs.
  let usageRefreshing = $state(false);
  let usageRefreshNote = $state<string | null>(null);
  async function refreshUsageNow() {
    if (usageRefreshing) return;
    usageRefreshing = true;
    usageRefreshNote = null;
    try {
      usage = await api.refreshUsageLedger();
      usageRefreshNote = "Collector run; the ledger is current.";
    } catch (e) {
      usageRefreshNote = String(e);
    } finally {
      usageRefreshing = false;
    }
  }
  /** Dollars as the ledger's own report prints them: two places, grouped. */
  function usd(n: number): string {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /** One model's dollars in one window, or a dash when it had no traffic there. */
  function usdOf(w: { by_model: { model: string; usd: number; unpriced: boolean }[] } | null, model: string): string {
    const m = w?.by_model.find((x) => x.model === model);
    if (!m) return "–";
    return m.unpriced ? "unpriced" : usd(m.usd);
  }
  /** Every model with traffic in the 30-day window, in that window's order (largest first). */
  const usageModels = $derived(usage?.month?.by_model.map((m) => m.model) ?? []);
  /** A surfaces percent, or a dash for a blank cell. */
  function pct(n: number | null): string {
    return n === null ? "–" : `${n}%`;
  }

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
    // The nav column scrolls, and a pane picked by key (backlog 109) can
    // sit past its edge — ⌘7 at the bottom while the column shows the
    // providers, ⌘1 at the top while it shows Palette. Bring the row in
    // (his ask, 2026-09-16); `nearest` leaves a visible row where it is.
    void tick().then(() =>
      navEl?.querySelector<HTMLElement>(".nav-item.active")?.scrollIntoView({ block: "nearest" }),
    );
  }
  let navEl = $state<HTMLElement | null>(null);

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

  /** The picker for where new projects go, opened at the current folder. */
  async function pickProjectsFolder() {
    const picked = await api.pickFolder(
      "Choose where new projects go",
      app.projectsFolder?.dir,
    );
    if (picked) await useProjectsFolder(picked);
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

  // ---- the dream row (nightshift backlog 071) ----
  //
  // Which engine and model a dream (and the capture pass, the same knob —
  // blocker 054) runs on, as rows and pills rather than a dropdown and a
  // typed id. Presentation only: the preference is still `provider` (a
  // provider kind, the Claude Code engine's `DREAM_ENGINE`, or "" for the
  // rail's connection) and `model` ("" for the engine's default), and
  // `passTargetFor` reads it as before. The rows and pills are built by
  // `dreamRows.ts`, which the suite pins.

  const dreamEngines = $derived(dreamEngineRows(app.providers, app.draft));
  const dreamModels = $derived(
    dreamModelPills(app.dreamPrefs.provider, app.dreamPrefs.model, app.providers, app.prefs),
  );
  const dreamSummary = $derived(
    dreamSentence(dreamEngines, app.dreamPrefs.provider, app.dreamPrefs.model, app.draft),
  );

  function pickDreamEngine(value: string) {
    if (value === app.dreamPrefs.provider) return;
    app.dreamPrefs.provider = value;
    // The model lists differ per engine (an alias is not a provider id), so
    // a change of engine starts from that engine's default.
    app.dreamPrefs.model = "";
    saveDreamPrefs();
  }
  function pickDreamModel(value: string) {
    app.dreamPrefs.model = value;
    saveDreamPrefs();
  }

  // The turn-end banner's switches (nightshift backlog 079): read from
  // localStorage when the modal opens, written on each change; `notify.ts`
  // reads the store again at each turn, so nothing here needs to be live.
  let notifyPrefs = $state<NotifyPrefs>(loadNotifyPrefs());
  function setNotify(key: keyof NotifyPrefs, on: boolean) {
    notifyPrefs = { ...notifyPrefs, [key]: on };
    saveNotifyPrefs(notifyPrefs);
  }

  // Sleep-safe turns (nightshift backlog 101): the same idiom as the
  // banner switches — read when the modal opens, written on each change;
  // `saveSleepPrefs` also hands the keep-awake pair to Rust.
  let sleepPrefs = $state<SleepPrefs>(loadSleepPrefs());
  function setSleep(key: keyof SleepPrefs, on: boolean) {
    sleepPrefs = { ...sleepPrefs, [key]: on };
    saveSleepPrefs(sleepPrefs);
  }

  // The hand-off's defaults (nightshift backlog 086 pass 2, blocker 120):
  // the threshold every chat starts from and the wrap-up message Wrap up
  // now sends unless the chat has edited its own. Both live in
  // `handoff.svelte.ts`'s reactive store, so the composer's notice and the
  // Context page follow a change here at once.
  const handoffDefaultPct = $derived(Math.round(handoffThreshold(null) * 100));
  function setHandoffDefaultPct(v: string): void {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    setHandoffThreshold(null, Math.min(100, Math.max(1, Math.round(n))) / 100);
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

  /**
   * The nav's groups in order, each with its panes (nightshift backlog
   * 109): ⌘1…⌘7 is the group — its first pane, or the next pane of the
   * group when already in it, so ⌘1 again steps through the providers —
   * and ⌘] / ⌘[ walk every pane in nav order. Groups rather than panes
   * because the panes number well past nine (six providers, the
   * backends, and five more); the chip on each group title says which
   * key. Scoped to the modal: `App.svelte` stands aside from these chords
   * while it is open, and the app's own ⌘-digits are back on close.
   */
  const groups = $derived.by(() => [
    { title: "Providers", panes: app.providers.map((p) => p.kind) },
    { title: "Subscription", panes: ["claude-code"] },
    { title: "Web search", panes: app.searchBackends.map((b) => "search:" + b.name) },
    { title: "Knowledge", panes: ["knowledge", "models"] },
    { title: "Projects", panes: ["projects"] },
    { title: "Usage", panes: ["usage"] },
    { title: "Appearance", panes: ["appearance"] },
  ]);
  function keyOf(groupIndex: number): string {
    return `⌘${groupIndex + 1}`;
  }
  function selectGroup(n: number) {
    const g = groups[n - 1];
    if (!g || g.panes.length === 0) return;
    const at = g.panes.indexOf(selected);
    select(at < 0 ? g.panes[0] : g.panes[(at + 1) % g.panes.length]);
  }
  function stepPane(dir: 1 | -1) {
    const all = groups.flatMap((g) => g.panes);
    if (all.length === 0) return;
    const at = all.indexOf(selected);
    select(all[(at < 0 ? 0 : at + dir + all.length) % all.length]);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      app.showSettings = false;
      return;
    }
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (!primary || e.altKey || e.shiftKey) return;
    if (/^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      selectGroup(Number(e.code.slice(5)));
    } else if (e.code === "BracketRight" || e.code === "BracketLeft") {
      e.preventDefault();
      stepPane(e.code === "BracketRight" ? 1 : -1);
    }
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
  <nav class="nav" bind:this={navEl}>
    <div class="nav-h">Settings</div>
    <div class="nav-title">Providers<Kbd keys={keyOf(0)} dim /></div>
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
    <!-- The Claude Code engine's own pane (nightshift backlog 086 pass 2):
         not a provider — no key, no model list — but the place its
         defaults live: the hand-off, and the cards other items add. -->
    <div class="nav-title">Subscription<Kbd keys={keyOf(1)} dim /></div>
    <button
      class="nav-item"
      class:active={selected === "claude-code"}
      onclick={() => select("claude-code")}
    >
      <span class="nav-label">Subscription</span>
      <span class="st">hand-off {handoffDefaultPct}%</span>
    </button>
    <div class="nav-title">Web search<Kbd keys={keyOf(2)} dim /></div>
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
    <div class="nav-title">Knowledge<Kbd keys={keyOf(3)} dim /></div>
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
    <div class="nav-title">Projects<Kbd keys={keyOf(4)} dim /></div>
    <button
      class="nav-item"
      class:active={selected === "projects"}
      onclick={() => select("projects")}
    >
      <span class="nav-label">Projects folder</span>
      <span class="st">
        <span class="dot" class:ok={!!app.projectsFolder}></span>
        {app.projectsFolder ? (app.projectsFolder.is_default ? "default" : "set") : "none"}
      </span>
    </button>
    <div class="nav-title">Usage<Kbd keys={keyOf(5)} dim /></div>
    <button
      class="nav-item"
      class:active={selected === "usage"}
      onclick={() => select("usage")}
    >
      <span class="nav-label">Usage</span>
      <span class="st">
        <span class="dot" class:ok={!!usage?.available}></span>
        {usage?.available && usage.week ? `${usd(usage.week.usd)} / 7d` : "none"}
      </span>
    </button>
    <div class="nav-title">Appearance<Kbd keys={keyOf(6)} dim /></div>
    <button
      class="nav-item"
      class:active={selected === "appearance"}
      onclick={() => select("appearance")}
    >
      <span class="nav-label">Palette</span>
      <!-- The palette's name, not its letter: "B" read as a key (backlog 109). -->
      <span class="st">{PALETTES.find((p) => p.id === app.palette)?.name ?? app.palette}</span>
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

      <!-- The transcript's type (nightshift backlog 051). No sample card:
           the change lands in the open transcript behind this pane, which
           is where a face is judged — a sample at the same size read as
           "too big" to him. -->
      <section class="card">
        <div class="ch"><span class="t">Transcript type</span></div>
        <p class="note small">
          The face and size of replies and your own messages. Applies at once
          to the transcript behind this window and is remembered. The rest of
          the interface stays in Plex Sans.
        </p>
        <div class="type-rows">
          <div class="type-row">
            <span class="type-label">Face</span>
            <div class="seg" role="radiogroup" aria-label="Transcript face">
              {#each TRANSCRIPT_FONTS as f (f.id)}
                <button
                  class:on={transcript.font === f.id}
                  role="radio"
                  aria-checked={transcript.font === f.id}
                  style:font-family={f.css}
                  onclick={() => setTranscriptFont(f.id)}
                >{f.name}</button>
              {/each}
            </div>
          </div>
          <div class="type-row">
            <span class="type-label">Size</span>
            <div class="seg" role="radiogroup" aria-label="Transcript size">
              {#each TRANSCRIPT_SIZES as n (n)}
                <button
                  class:on={transcript.size === n}
                  role="radio"
                  aria-checked={transcript.size === n}
                  onclick={() => setTranscriptSize(n)}
                >{n} px</button>
              {/each}
            </div>
          </div>
        </div>
      </section>

      <!-- The turn-end banner (nightshift backlog 079): two switches, one
           per kind. The rule they cannot change is the focus one — a
           window in front is never notified. -->
      <section class="card">
        <div class="ch"><span class="t">Notifications</span></div>
        <p class="note small">
          A native banner while Nightloom is behind another window, on either
          engine. Never for the window in front. Clicking one brings Nightloom
          forward.
        </p>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={notifyPrefs.turnEnd}
            onchange={(e) => setNotify("turnEnd", e.currentTarget.checked)}
          />
          <span>When a turn finishes — files changed, tokens, time</span>
        </label>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={notifyPrefs.needsYou}
            onchange={(e) => setNotify("needsYou", e.currentTarget.checked)}
          />
          <span>When a turn needs you — a permission, a question, a plan</span>
        </label>
      </section>
    </div>
  {:else if selected === "claude-code"}
    <!-- The Claude Code engine's pane (nightshift backlog 086 pass 2,
         blocker 120): the hand-off's defaults. A chat overrides both on
         the composer's notice; this is what every chat starts from. -->
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Subscription</h2>
        <span class="slug">the engine on your Claude plan — its defaults</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        What a chat on this engine does when its context window fills. The CLI's
        own auto-compact is off on this engine; instead, past the mark below,
        the composer shows a notice with <em>Wrap up now</em>, which sends the
        message below as a turn of its own — the model finishes what is
        half-done, writes <code>HANDOFF.md</code>, and ends with a start prompt
        that a linked new chat opens with, never sent by itself.
      </p>

      <section class="card">
        <div class="ch"><span class="t">Hand-off</span></div>
        <label class="handoff-row">
          <span>Hand off at</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={handoffDefaultPct}
            aria-label="Hand-off threshold, percent of the context window, for every chat"
            onchange={(e) => setHandoffDefaultPct((e.currentTarget as HTMLInputElement).value)}
          />
          <span>% of the window, for every chat without a mark of its own (70% to begin with)</span>
        </label>
        <p class="note small">
          Away from the chat — nothing sent or typed for a minute and the
          window not in front — when the mark is crossed, the wrap-up is put
          in the composer's queue and goes when the turn ends; the queue's ×
          takes it back. With you present, only the notice shows.
        </p>
        <div class="ch"><span class="t">The wrap-up message</span>
          <span class="spacer"></span>
          {#if hasOwnDefaultMessage()}
            <button class="ns-btn ghost small" onclick={() => setHandoffDefaultMessage("")}>Reset to default</button>
          {/if}
        </div>
        <textarea
          class="handoff-msg"
          rows="9"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="The default wrap-up message"
          value={handoffDefaultMessage()}
          oninput={(e) => setHandoffDefaultMessage((e.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
        <p class="note small">
          Sent as typed. Keep the ask for a fenced block tagged
          <code>start-prompt</code>: that is what the new chat's first message
          is read out of; without one its box opens empty. A chat can edit its
          own copy on the notice without changing this.
          {#if hasOwnDefaultMessage()}<em>Edited; Reset to default restores the built-in text (a box left empty reads as the built-in after a relaunch).</em>{:else}<em>The built-in text ({WRAP_UP.length} characters).</em>{/if}
        </p>
      </section>

      <!-- Sleep-safe turns (nightshift backlog 101): his `caffeinate -dis`
           made automatic while anything runs, and the turn a closed lid
           cut off resumed on wake. Agent C's card, placed here rather than
           after Notifications (its blocker 129) once this pane existed. -->
      <section class="card">
        <div class="ch"><span class="t">Sleep</span></div>
        <p class="note small">
          While a turn, dream or capture runs the Mac is kept awake (a
          caffeinate assertion — see it under pmset -g assertions). A closed
          lid on battery still sleeps it; on wake, a turn that was cut off
          is continued.
        </p>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={sleepPrefs.keepAwake}
            onchange={(e) => setSleep("keepAwake", e.currentTarget.checked)}
          />
          <span>Keep the Mac awake while a turn runs</span>
        </label>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={sleepPrefs.keepDisplayAwake}
            disabled={!sleepPrefs.keepAwake}
            onchange={(e) => setSleep("keepDisplayAwake", e.currentTarget.checked)}
          />
          <span>Keep the display on too</span>
        </label>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={sleepPrefs.resumeAfterSleep}
            onchange={(e) => setSleep("resumeAfterSleep", e.currentTarget.checked)}
          />
          <span>Resume a turn interrupted by sleep</span>
        </label>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={sleepPrefs.resumeAsks}
            disabled={!sleepPrefs.resumeAfterSleep}
            onchange={(e) => setSleep("resumeAsks", e.currentTarget.checked)}
          />
          <span>Ask first (a Resume toast) instead of resuming automatically</span>
        </label>
      </section>
    </div>
  {:else if selected === "usage"}
    <!-- The usage ledger (nightshift backlog 045, blocker 060): a Settings
         pane rather than anything in the transcript, on the dashboard's own
         reasoning — text in a message is stored and replayed forever. -->
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Usage</h2>
        <span class="slug">{usage?.available && usage.week ? `${usd(usage.week.usd)} in 7 days` : "no ledger"}</span>
        <span class="spacer"></span>
        <button
          class="ns-btn small"
          disabled={usageRefreshing}
          title="Run the collector now (python3 ~/.claude/usage-ledger.py update) and reread the ledger"
          onclick={() => void refreshUsageNow()}
        >{usageRefreshing ? "Refreshing…" : "Refresh now"}</button>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      {#if usageRefreshNote}
        <p class="note small">{usageRefreshNote}</p>
      {/if}
      <p class="note">
        What Claude Code has cost, from the usage ledger under
        <code>~/.claude</code>. These are the API's own usage fields — tokens
        in, out, cache written and cache read, one count per API message —
        priced by <code>usage-rates.json</code>. Turns run on a subscription
        are shown as what they <em>would</em> have cost on the API, not as a
        bill; a rate change in that file restates every figure here. Days are
        UTC, as on Anthropic's dashboard.
      </p>

      {#if !usage}
        <p class="note small">Reading the ledger…</p>
      {:else if !usage.available}
        <section class="card">
          <div class="ch"><span class="t">No ledger yet</span></div>
          <div class="key-status">{usage.reason}</div>
          <p class="note small">
            The collector is <code>{usage.collector}</code>, run every six hours by
            a LaunchAgent; nothing in Nightloom writes these files. Run
            <code>python3 {usage.collector} update --all</code> once and this
            pane fills.
          </p>
        </section>
      {:else}
        <section class="card">
          <div class="ch"><span class="t">Spend</span><span class="dim small">dedup basis · API-equivalent</span></div>
          <div class="usage-table">
            <table>
              <thead>
                <tr>
                  <th class="l">model</th>
                  <th>today<br /><span class="sub">{usage.today?.to}</span></th>
                  <th>7 days<br /><span class="sub">{usage.week?.from} →</span></th>
                  <th>30 days<br /><span class="sub">{usage.month?.from} →</span></th>
                </tr>
              </thead>
              <tbody>
                {#each usageModels as m (m)}
                  <tr>
                    <td class="l"><code>{m}</code></td>
                    <td>{usdOf(usage.today, m)}</td>
                    <td>{usdOf(usage.week, m)}</td>
                    <td>{usdOf(usage.month, m)}</td>
                  </tr>
                {/each}
                <tr class="total">
                  <td class="l">total</td>
                  <td>{usd(usage.today?.usd ?? 0)}</td>
                  <td>{usd(usage.week?.usd ?? 0)}</td>
                  <td>{usd(usage.month?.usd ?? 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {#if usage.unpriced_models.length}
            <p class="note small">
              Counted but not priced — the rates table has no row for
              {#each usage.unpriced_models as m, i (m)}{i ? ", " : ""}<code>{m}</code>{/each}.
              Their turns are in the request counts and in none of the dollars.
            </p>
          {/if}
          <p class="note small">
            A model's <em>main</em> and <em>subagent</em> scopes are added
            together here; a fast-mode request is its own row, suffixed
            <code>#fast</code>, at its own price.
          </p>
        </section>

        <section class="card">
          <div class="ch"><span class="t">Surfaces</span><span class="dim small">share of the weekly limit, last 7 days</span></div>
          {#if usage.surfaces}
            {@const s = usage.surfaces}
            <!-- One row per fact, with a bar: the one-line version read as
                 "stuffed" (his word, 2026-09-14). -->
            <div class="usage-rows">
              {#each [
                { label: "Claude Code", value: s.claude_code_pct },
                { label: "Chat", value: s.chat_pct },
                { label: "Cowork", value: s.cowork_pct },
                { label: "Other", value: s.other_pct },
              ] as { label, value } (label)}
                <div class="usage-row">
                  <span class="usage-row-label">{label}</span>
                  <span class="usage-bar"><span class="usage-bar-fill" style:width="{Math.max(0, Math.min(100, value ?? 0))}%"></span></span>
                  <b class="usage-row-value">{pct(value)}</b>
                </div>
              {/each}
            </div>
            <div class="usage-rows caps">
              <div class="usage-row">
                <span class="usage-row-label">Weekly cap, all models</span>
                <span class="usage-bar"><span class="usage-bar-fill cap" style:width="{Math.max(0, Math.min(100, s.weekly_all_pct ?? 0))}%"></span></span>
                <b class="usage-row-value">{pct(s.weekly_all_pct)} used</b>
              </div>
              {#if s.weekly_scoped_model}
                <div class="usage-row">
                  <span class="usage-row-label">Weekly cap, {s.weekly_scoped_model} alone</span>
                  <span class="usage-bar"><span class="usage-bar-fill cap" style:width="{Math.max(0, Math.min(100, s.weekly_scoped_pct ?? 0))}%"></span></span>
                  <b class="usage-row-value">{pct(s.weekly_scoped_pct)} used</b>
                </div>
              {/if}
            </div>
            <div class="key-status">
              Window from {s.window_started_at.replace("T", " ")} UTC · snapshot {s.as_of.replace("T", " ")} UTC.
            </div>
            <p class="note small">
              From the desktop app's own usage response, read from its cache on
              disk. Percents are of weekly rate-limit utilization — cost-weighted,
              rounded to whole numbers, and not dollars.
            </p>
          {:else}
            <div class="key-status">No surfaces snapshot yet — the collector records one when the desktop app has fetched its usage page.</div>
          {/if}
        </section>

        <section class="card">
          <div class="ch"><span class="t">Ledger</span></div>
          <div class="key-status">
            <code class="path">{usage.dir}</code>
            <br />
            {usage.first_date} → {usage.last_date}{usage.updated_at
              ? `, last updated ${relativeTime(usage.updated_at)} (${new Date(usage.updated_at).toLocaleString()})`
              : ""}.
          </div>
          <p class="note small">
            The collector is <code>{usage.collector}</code>, run every six hours by
            a LaunchAgent (<code>com.swaraagsistla.claude-usage-ledger</code>).
            Nightloom reads its three files and writes none of them; the
            same numbers, to the cent, are <code>claude_usage</code> in a shell.
          </p>
        </section>
      {/if}
    </div>
  {:else if selected === "projects"}
    <div class="pane">
      <div class="pane-head">
        <h2 class="pane-title">Projects folder</h2>
        <span class="slug">new projects go in</span>
        <span class="spacer"></span>
        <button class="close" title="Close" aria-label="Close settings" onclick={close}><Icon name="x" size={14} /></button>
      </div>
      <p class="note">
        Where <em>New project…</em> makes a folder: <code>&lt;this folder&gt;/&lt;name&gt;</code>,
        with the name spelled the way the importer spells folders
        (<code>Value Generalization</code> → <code>Value-Generalization</code>).
        The form shows the path as you type and its Change… picks another
        folder for one project; this is the default for all of them.
      </p>

      <section class="card">
        <div class="ch"><span class="t">Folder</span></div>
        <div class="key-status">
          {#if !app.projectsFolder}
            No user config directory on this machine, so there is nowhere to
            record one.
          {:else}
            <code class="path">{app.projectsFolder.dir}</code>
            <br />
            {app.projectsFolder.is_default
              ? "The default — beside the last project made under a projects folder, or ~/Documents/Nightloom/projects."
              : "Set here rather than the default."}{app.projectsFolder.exists
              ? ""
              : " Not created yet; the first New project makes it."}
          {/if}
        </div>
        <!-- As the vault pane says: repointing is a setting, not a move. -->
        <p class="note small">
          Nothing is moved: the projects you already have are registered by
          their own paths and stay where they are. This only decides where
          the next one goes.
        </p>
        <div class="kf">
          <button class="ns-btn" disabled={!app.projectsFolder} onclick={() => void pickProjectsFolder()}
            >Choose folder…</button
          >
          <button
            class="ns-btn ghost"
            disabled={!app.projectsFolder || app.projectsFolder.is_default}
            onclick={() => void useProjectsFolder(null)}
          >
            Reset to default
          </button>
        </div>
      </section>
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
          consolidation evidence points at. A capture pass runs first, reading
          the chats since the last one into the inbox, on the same engine. Both
          run unattended and bill whatever runs them, so it is off until you
          say otherwise.
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
             exactly where cost compounds. The Claude Code engine is a real
             option here since 2026-09-16 (nightshift backlog 070): a dream
             on it is one `claude -p` turn per folder, billed to the
             subscription like a chat on that engine. -->
        <!-- The engine and the model as rows and pills (nightshift backlog
             071), in the Models card's idiom: no dropdown, no typed id. The
             sentence above the rows is the whole answer to "what will run,
             on what, billed to what"; the rows are how to change it. -->
        <p class="note small dream-summary">{dreamSummary}</p>
        <div class="dream-rows" role="radiogroup" aria-label="Which engine dreams">
          {#each dreamEngines as e (e.value)}
            {@const on = app.dreamPrefs.provider === e.value}
            <div class="mr dream-row" class:on>
              <button
                class="cb"
                class:on
                role="radio"
                aria-checked={on}
                aria-label="Dream on {e.name}"
                onclick={() => pickDreamEngine(e.value)}
              >
                {#if on}<Icon name="check" size={11} />{/if}
              </button>
              <span class="dream-name">
                <button class="dream-pick" onclick={() => pickDreamEngine(e.value)}>{e.name}</button>
                {#if e.sub}<span class="dream-sub">{e.sub}</span>{/if}
              </span>
              <span class="ns-pill" class:open={!e.warn} class:failed={e.warn}>{e.bills}</span>
            </div>
            {#if on && dreamModels.length > 0}
              <div class="dream-models">
                <span class="ns-k">Model</span>
                {#each dreamModels as m (m.value)}
                  <button
                    class="cart"
                    class:on={app.dreamPrefs.model === m.value}
                    title={m.value === app.dreamPrefs.model ? "The model that dreams" : `Dream on ${m.label}`}
                    onclick={() => pickDreamModel(m.value)}
                  >
                    {#if app.dreamPrefs.model === m.value}<Icon name="check" size={11} />{/if}{m.label}
                  </button>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      </section>

      <!-- The daily pass (nightshift backlog 069): capture → dream → tidy
           once a day, on the engine the rows above choose. Off until he
           says otherwise — it runs unattended. -->
      <section class="card">
        <div class="ch"><span class="t">Every day</span></div>
        <p class="note small">
          Once a day, capture the chats since the last pass into the memory
          inbox, dream them into the vault and each project's memory, and
          archive struck-through lines older than 30 days — on the engine
          chosen above. At the hour if Nightloom is open; otherwise on the
          next launch or wake after it. What the pass proposed and changed
          lands in the bell.
        </p>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={app.centre.daily.on}
            onchange={(e) => setDailyPrefs({ ...app.centre.daily, on: e.currentTarget.checked })}
          />
          <span>Capture and dream every day at</span>
          <select
            class="daily-hour"
            value={String(app.centre.daily.hour)}
            onchange={(e) => setDailyPrefs({ ...app.centre.daily, hour: Number(e.currentTarget.value) })}
          >
            {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
              <option value={String(h)}>{String(h).padStart(2, "0")}:00</option>
            {/each}
          </select>
        </label>
        <label class="dream-auto">
          <input
            type="checkbox"
            checked={app.centre.daily.notifyMac}
            onchange={(e) => setDailyPrefs({ ...app.centre.daily, notifyMac: e.currentTarget.checked })}
          />
          <span>A macOS notification when the bell gains something</span>
        </label>
        <div class="daily-row">
          <button
            class="ns-btn small"
            disabled={app.centre.dailyRunning || app.dreaming || app.capturing}
            onclick={() => void runDailyPass()}
          >
            {app.centre.dailyRunning ? "Running…" : "Run the daily pass now"}
          </button>
          <span class="dim small">
            {#if app.centre.dailyLast}last: {app.centre.dailyLast}{:else if app.centre.lastDaily}last ran {new Date(app.centre.lastDaily).toLocaleString()}{:else}never run{/if}
          </span>
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
        <code>claude-opus-5.md</code>. On the subscription engine the name is
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

      <!-- The Chat instructions (nightshift backlog 102, board 8b): how a
           Chat talks. One file for the kind, beside the models' folder; the
           same editor as a model's file, and a missing file opens empty. -->
      <section class="card">
        <div class="ch"><span class="t">Chat instructions</span></div>
        <p class="note small">
          How a <em>Chat</em> — the conversational kind, no folder, reads only
          — talks. Read into the system prompt of every Chat and no Claude
          Code chat's, after the model's file and before the project's. On
          the subscription engine it sits on top of the CLI's own prompt,
          which stays underneath; on the provider engine Nightloom owns the
          whole prompt. Something like: <em>Talk, don't build. Answer in prose
          first; no file edits, no commands.</em>
        </p>
        <div class="kf pick-row">
          <span class="dot" class:ok={(chatBytes ?? 0) > 0}></span>
          <span class="key-status pick-st">
            {#if chatPath === null}
              No user config directory to keep it in.
            {:else if (chatBytes ?? 0) > 0}
              <code>{chatPath}</code> · {size(chatBytes ?? 0)}
            {:else}
              No file yet — it would be <code>{chatPath}</code>.
            {/if}
          </span>
          <span class="spacer"></span>
          <button
            class="ns-btn"
            disabled={chatPath === null}
            title={chatPath ? `Opens the editor on ${chatPath}` : "No config directory"}
            onclick={() => openChatInstructions("settings")}
          >
            {(chatBytes ?? 0) > 0 ? "Edit" : "Create"}
          </button>
        </div>
      </section>

      <!-- Any provider and model, not only the rail's (nightshift backlog
           053): the file the preamble reads for that pair, opened when it
           exists and created — one header line naming the pair — when not.
           The same editor path as the row above. -->
      <section class="card">
        <div class="ch"><span class="t">Any model</span></div>
        <p class="note small">
          Read or start the file for a model the chat is not on. The list is
          what the picker knows for that provider — its curated ids and, with
          a key, what its API lists — and an id in neither can be typed.
        </p>
        <div class="kf">
          <select aria-label="Provider" value={pickProvider} onchange={(e) => (pickProvider = e.currentTarget.value)}>
            {#each pickProviders as p (p.kind)}
              <option value={p.kind}>{p.label}</option>
            {/each}
          </select>
          <select aria-label="Model" value={pickOther ? OTHER : pickModel} onchange={pickModelChanged}>
            {#each pickModels as m (m)}
              <option value={m}>{m}</option>
            {/each}
            <option value={OTHER}>Other — type an id…</option>
          </select>
          {#if pickOther}
            <input
              type="text"
              class="pick-id"
              placeholder="model id, exactly as the provider names it"
              aria-label="Model id"
              bind:value={pickText}
            />
          {/if}
        </div>
        <div class="kf pick-row">
          <span class="dot" class:ok={!!pickFile}></span>
          <span class="key-status pick-st">
            {#if !pickId}
              Pick a model.
            {:else if pickFile}
              <code>{pickFile.name}</code> · {size(pickFile.bytes)}
            {:else}
              No file yet — it would be <code>{modelInstructionFile(pickId)}</code>.
            {/if}
          </span>
          <span class="spacer"></span>
          <button
            class="ns-btn"
            disabled={!pickId || pickBusy}
            title={!pickId
              ? "Pick a model first"
              : pickFile
                ? `Opens the editor on ${pickFile.name}`
                : `Writes ${modelInstructionFile(pickId)} with a header line and opens it`}
            onclick={() => void openPicked()}
          >
            {pickBusy ? "creating…" : pickFile ? "Open" : "Create"}
          </button>
        </div>
        {#if pickError}
          <div class="error">{pickError}</div>
        {/if}
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
    display: flex;
    align-items: center;
    justify-content: space-between;
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
  /* The usage pane's spend table: models down, windows across, mono
     figures right-aligned so the decimal points line up. */
  .usage-table {
    overflow-x: auto;
  }
  .usage-table table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  .usage-table th,
  .usage-table td {
    padding: 5px 8px;
    text-align: right;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    border-bottom: 1px solid var(--line);
  }
  .usage-table th {
    font-weight: 500;
    color: var(--dim);
    font-size: 11px;
    vertical-align: bottom;
  }
  .usage-table th .sub {
    font-weight: 400;
    font-size: 10px;
  }
  .usage-table .l {
    text-align: left;
  }
  .usage-table td.l code {
    font-family: var(--mono);
    font-size: 12px;
  }
  .usage-table tr.total td {
    border-bottom: none;
    font-weight: 600;
    color: var(--ink);
  }
  .usage-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    margin-bottom: 10px;
  }
  .usage-rows.caps {
    padding-top: 10px;
    border-top: 1px solid var(--line2);
  }
  .usage-row {
    display: grid;
    grid-template-columns: 190px 1fr 72px;
    align-items: center;
    gap: 12px;
  }
  .usage-row-label {
    color: var(--ink2);
  }
  .usage-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--well);
    overflow: hidden;
  }
  .usage-bar-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
  }
  .usage-bar-fill.cap {
    background: var(--ink2);
  }
  .usage-row-value {
    font-family: var(--mono);
    font-weight: 600;
    text-align: right;
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
  /* The any-model picker's second row: dot · file or "no file yet" · Open/Create. */
  .pick-row {
    flex-wrap: nowrap;
  }
  .pick-st {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .pick-st code {
    font-family: var(--mono);
    font-size: 0.92em;
  }
  .kf input.pick-id {
    flex: 1 1 100%;
  }
  .dream-auto {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 13px;
    color: var(--ink);
    cursor: pointer;
  }
  .daily-hour {
    margin-left: 6px;
    font: inherit;
    font-size: 12.5px;
    background: var(--well);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 2px 6px;
  }
  .daily-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  /* The hand-off card (nightshift backlog 086 pass 2): the Context page's
     threshold row and the composer's field face for the message. */
  .handoff-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--ink);
  }
  .handoff-row input {
    width: 4rem;
    font-family: var(--mono);
    font-size: 12px;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 3px 6px;
  }
  .handoff-msg {
    width: 100%;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.45;
    resize: vertical;
  }
  .handoff-msg:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* The dream row as rows and pills (nightshift backlog 071): the Models
     card's `.mr` / `.cb` / `.cart` shapes, a name in the sans with one dim
     line under it, the billing pill at the right. */
  .dream-summary {
    color: var(--ink);
  }
  .dream-rows {
    display: flex;
    flex-direction: column;
  }
  .dream-row .cb {
    border-radius: 999px;
  }
  .dream-name {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .dream-pick {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--ink2);
    text-align: left;
    cursor: pointer;
  }
  .dream-row.on .dream-pick {
    color: var(--ink);
  }
  .dream-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dream-models {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 4px 10px 8px 37px;
  }
  .dream-models .cart.on:hover {
    /* Picking, not dropping: the strip's red "click to drop" hover is
       wrong here — the pill that is on stays on. */
    color: var(--accent-ink);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
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
  /* The transcript-type rows: label, then a segmented control in the
     NightshiftHeader's shape; the face buttons wear their own face. */
  .type-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .type-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .type-label {
    width: 44px;
    font-size: 12.5px;
    color: var(--dim);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px;
    background: var(--well);
  }
  .seg button {
    padding: 5px 14px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 13.5px;
    font-weight: 500;
    font-family: var(--sans);
    cursor: pointer;
  }
  .seg button:hover {
    color: var(--ink);
  }
  .seg button.on {
    background: var(--accent);
    color: var(--paper);
  }
</style>
