// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { suggestions } from "../suggestions.svelte";
import { isProviderVisible, modelsFor, newPromptId, sanitizeThinking, saveLastConnection, savePrefs, savePrompts, thinkingString, type CatalogPrefs, type Engine } from "../catalog";
import { applyChoice, choiceOf, loadChoices, noteConnected, noteMade, saveChoices, wantedChoice, type ChatChoice, type ChatChoices } from "../chatChoice";
import { adoptNewChat, emptyRules, loadRules, rulesFor, saveRules, setRulesFor, useDefaultFor, type SubagentRulesStore } from "../subagentRules";
import { probeAuth } from "../claudeAuth.svelte";
import { chatIsCold } from "../promptVersions";
import { CONNECT_DEADLINE_MS, withDeadline } from "../deadline";
import type { PromptLayer, ProviderInfo } from "../types";
import { refreshPlanUsage } from "./usage.svelte";
import { app } from "../state.svelte";

/** A provider the backend can actually construct a client for right now. */
export function usable(p: ProviderInfo): boolean {
  // openai-chat can point at a local server without an API key.
  return p.available || (p.kind === "openai-chat" && app.draft.baseUrl.trim() !== "");
}

/** Connect on launch: last-used provider if still usable, else the first that is. */
export async function autoConnect(): Promise<void> {
  // The agent engine has no key to check and no model list to fall back
  // through — the binary either runs or the rail says why not.
  if (app.draft.engine === "claude-code") {
    await applyDraft();
    return;
  }
  let target = app.providers.find((p) => p.kind === app.draft.provider);
  if (!target || !usable(target)) {
    target =
      app.providers.find((p) => isProviderVisible(p.kind, app.prefs) && usable(p)) ??
      app.providers.find(usable);
    if (!target) return; // nothing usable — the rail shows why
    app.draft.provider = target.kind;
    app.draft.model = "";
  }
  if (!app.draft.model) {
    const models = modelsFor(target.kind, app.prefs, target.default_model);
    app.draft.model = target.default_model ?? models[0] ?? "";
  }
  if (!app.draft.model) return; // e.g. openai-chat before a model is chosen
  await applyDraft();
}

/**
 * Each chat's model and engine (nightshift backlog 205): every chat's
 * recorded choice and the New-chat default (`chatChoice.ts`), whether
 * launch has finished reading the draft (`ready`), and which chat the
 * draft's choice was last put back for (`shownFor`; undefined before the
 * first). Exported for the tests.
 */
export const chatChoice = {
  choices: (typeof localStorage === "undefined"
    ? { default: null, chats: {} }
    : loadChoices(localStorage)) as ChatChoices,
  ready: false,
  shownFor: undefined as string | null | undefined,
  /** The draft was put back while a turn or connect ran; reconnect after. */
  reconnect: false,
};

export function saveChatChoices(): void {
  if (typeof localStorage !== "undefined") saveChoices(localStorage, chatChoice.choices);
}

/**
 * His subagent rules in words (nightshift backlog 291): each chat's text
 * and the Settings default (`subagentRules.ts`). Saved on every keystroke;
 * a pause in typing reconnects, which states them in the chat's subagent
 * rules layer (293) — at once on a cold chat, as a note on the next
 * message on a warm one.
 */
export const subagentRules = $state({
  store: (typeof localStorage === "undefined" ? emptyRules() : loadRules(localStorage)) as SubagentRulesStore,
});

function saveSubagentRules(): void {
  if (typeof localStorage !== "undefined") saveRules(localStorage, subagentRules.store);
}

/** How long typing in a rules box waits before it reconnects. */
export const RULES_DEBOUNCE_MS = 1_500;
let rulesTimer: ReturnType<typeof setTimeout> | null = null;
function rulesChanged(): void {
  saveSubagentRules();
  if (app.draft.engine !== "claude-code") return;
  if (rulesTimer !== null) clearTimeout(rulesTimer);
  rulesTimer = setTimeout(() => {
    rulesTimer = null;
    scheduleApply();
  }, RULES_DEBOUNCE_MS);
}

/** He typed in the rail's box. */
export function setOpenChatRules(text: string): void {
  setRulesFor(subagentRules.store, app.activeSessionId, text);
  rulesChanged();
}
/** *Use the default* on the rail (asked first when there is text). */
export function useDefaultRules(): void {
  useDefaultFor(subagentRules.store, app.activeSessionId);
  rulesChanged();
}
/** Settings' default for chats with no text of their own. */
export function setDefaultRules(text: string): void {
  subagentRules.store.default = text;
  rulesChanged();
}
/** A New chat's first turn made `chat`: its typed rules become its own. */
export function adoptChatRules(chat: string): void {
  if (adoptNewChat(subagentRules.store, chat)) saveSubagentRules();
}

/**
 * The window from the id the CLI names in its init line (backlog 216), when
 * the connection does not know it yet — a chat's first turn on an alias, or
 * the first on a newly picked family. The turn's end sets it again from the
 * result's id; this makes it right from the turn's first second. Exported
 * for the tests.
 */
export async function windowFromInit(model: string | null | undefined): Promise<void> {
  const conn = app.connection;
  if (!model || !conn || conn.engine !== "claude-code" || conn.contextLimit != null) return;
  try {
    const [limit] = await api.contextLimits("anthropic", [model]);
    if (limit != null && app.connection === conn && conn.contextLimit == null) conn.contextLimit = limit;
  } catch {
    // Best-effort, as every other look-up: the turn's end tries again.
  }
}

/** A pick that must wait for the running turn or connect (backlog 214):
 *  the chat on screen keeps it — so switching away and back shows it —
 *  and the effect's re-run at the end connects it. */
function deferPick(): void {
  if (chatChoice.ready) chatConnected(app.activeSessionId, choiceOf(app.draft));
  chatChoice.reconnect = true;
  // Held behind a connect, the pick is owed a connect of its own (item
  // 222); behind a turn alone, Send keeps backlog 214's rules.
  app.applyPending = app.connecting || applyTimer !== null;
}

/** Send waits while a connect runs or a rail change is owed one (item
 *  222), so no message goes out on settings the rail no longer shows. A
 *  running turn is backlog 214's business, not this: its queue still takes
 *  messages. */
export function sendHeld(): boolean {
  return !app.busy && (app.connecting || app.applyPending);
}

/** How long a rail change waits for the next one before connecting (item 222). */
export const APPLY_DEBOUNCE_MS = 400;
export let applyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A rail change (item 222): the rail no longer greys out while a connect
 * runs, so a run of clicks (Subagent limits 6 → 2) waits ~400 ms for the
 * next one and then connects once. One made during a connect is kept on
 * the draft (`deferPick`) and connected once that settles, if the draft
 * still differs from what that connect sent (`syncPromptLayers`).
 */
export function scheduleApply(): void {
  app.applyPending = true;
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    void applyDraft();
  }, APPLY_DEBOUNCE_MS);
}

/** What the last connect was built from — its chat and its draft (item
 *  222): a pick held behind a connect is connected afterwards only when
 *  the draft moved on from this. */
export let lastSent: string | null = null;
export function sentKey(): string {
  // The chat's subagent rules too (backlog 291): edited, they reconnect.
  return JSON.stringify([app.activeSessionId, app.draft, rulesFor(subagentRules.store, app.activeSessionId)]);
}

/** A connect is starting: note what it is built from, and the pending
 *  flag now covers only a debounce still running. */
function connectStarting(): void {
  lastSent = sentKey();
  app.applyPending = applyTimer !== null;
}

/** A connect built for `chat` succeeded with `c` (backlog 205) — recorded
 *  only while that chat is still the one on screen. */
function chatConnected(chat: string | null, c: ChatChoice): void {
  if (app.activeSessionId !== chat) return;
  noteConnected(chatChoice.choices, chat, c);
  saveChatChoices();
}

/**
 * Put the open chat's model and engine back on the draft when the open
 * chat has changed since the last time (backlog 205): its own choice, or
 * the default for a New chat. True when the draft changed and the caller
 * must reconnect. Only on a change of chat, so a pick made on the rail
 * while a turn ran is not overwritten when the turn ends. A chat opened
 * for the first time since this item keeps what it is shown on, recorded
 * at once, so a later pick elsewhere cannot move it.
 */
export function restoreChatChoice(): boolean {
  if (!chatChoice.ready) return false;
  const chat = app.activeSessionId;
  if (chat === chatChoice.shownFor) return false;
  const wanted = wantedChoice(chatChoice.choices, chat);
  const engineChanged = wanted !== null && wanted.engine !== app.draft.engine;
  // While a turn runs on screen the rail may show the chat's model, but
  // not tear down the connection that turn belongs to: an engine change
  // waits for the turn's end.
  if (engineChanged && (app.busy || app.connecting)) return false;
  chatChoice.shownFor = chat;
  if (!wanted) return false;
  if (chat !== null) {
    noteMade(chatChoice.choices, chat, wanted);
    saveChatChoices();
  }
  if (!applyChoice(app.draft, wanted)) return false;
  sanitizeThinking(app.draft);
  if (engineChanged) {
    // As `useEngine`: the other engine's connection, plan window and
    // suggestion are not this one's.
    app.connection = null;
    app.agentTurn = null;
    app.agentInit = null;
    app.suggestion = null;
  }
  return true;
}

/** (Re)connect with the rail's current settings. Called on every rail change. */
export async function applyDraft(): Promise<void> {
  const d = app.draft;
  if (app.busy || app.connecting) {
    // ~~Dropped~~ — deferred since backlog 214: a pick made while a turn
    // or a connect runs is kept on the draft, recorded as the open chat's,
    // and connected when either ends (the effect that re-runs
    // `syncPromptLayers`), so it applies to the next turn. The running
    // turn keeps the model it started on: its CLI process was spawned
    // with it, and a connect under it would tear down its engine.
    deferPick();
    return;
  }
  if (d.engine === "claude-code") return applyAgentDraft();
  if (!d.provider) {
    app.applyPending = applyTimer !== null; // nothing to connect (item 222)
    return;
  }
  sanitizeThinking(d); // a saved draft may hold a mode this target rejects
  // The chat this connect is for, and the choice it sends (backlog 205).
  const chat = app.activeSessionId;
  const sent = choiceOf(d);
  connectStarting();
  app.connecting = true;
  app.connectError = null;
  try {
    const res = await api.connect({
      provider: d.provider,
      model: d.model.trim() || undefined,
      baseUrl: d.baseUrl.trim() || undefined,
      thinking: thinkingString(d),
      system: d.system.trim() || undefined,
      tools: d.tools,
      preamble: d.preamble,
      sidecar: d.sidecar,
      approval: d.approval,
      web: d.web,
      selfCompact: d.selfCompact,
      knowledge: d.knowledge,
      workspace: d.workspace.trim() || undefined,
    });
    app.connection = {
      provider: res.provider,
      model: res.model,
      thinking: thinkingString(d),
      tools: d.tools,
      contextLimit: res.context_limit ?? null,
      price: res.price ?? null,
      mcp: res.mcp ?? [],
      reviewers: res.reviewers ?? [],
      workspace: res.workspace,
      search: res.search ?? null,
      knowledge: res.knowledge ?? null,
      engine: "provider",
      agent: null,
      folders: res.folders ?? [],
    };
    // The backend is the authority on which project a connection is filed
    // under: an open project overrides the workspace the rail saved, so
    // reading it back is what keeps the two from disagreeing.
    app.project = res.project ?? null;
    // The backend resolved the default — for this chat's draft only: one
    // opened meanwhile has its own choice on it now (backlog 205).
    if (!d.model.trim() && app.activeSessionId === chat) d.model = res.model;
    saveLastConnection({ ...d });
    app.connectedFor = { chat, choice: { ...sent, model: sent.model.trim() || res.model } };
    chatConnected(chat, { ...sent, model: sent.model.trim() || res.model });
  } catch (e) {
    // The backend keeps the previous Chat on failure, so app.connection
    // (if any) is still accurate — just surface the error.
    app.connectError = String(e);
  } finally {
    app.connecting = false;
  }
}

/**
 * Connect the agent engine with the rail's current settings.
 *
 * Its own function rather than a branch inside `applyDraft` because almost
 * nothing in that call survives the crossing: no thinking mode, no base URL,
 * no sidecar, no MCP or reviewers. What it shares is the shape —
 * one connect per rail change, the backend's answer read back rather than the
 * draft echoed — and that is what `Connection` is.
 */
export async function applyAgentDraft(updateNow: PromptLayer[] = [], take = true): Promise<void> {
  const d = app.draft;
  // As `applyDraft` (backlog 205).
  const chat = app.activeSessionId;
  // 535f (535-1): the project open when it started — the backend reads
  // its project at the connect's start, so its answer is stale if he
  // switched projects during these seconds.
  const projectAtStart = app.project?.id ?? null;
  const sent = choiceOf(d);
  // Item 306 review: the Keeps this connect's listing can include are the
  // ones made before it started; one landing while it runs stays owed.
  const filesGen = filesChangedGen;
  connectStarting();
  app.connecting = true;
  app.connectError = null;
  try {
    // Never an endless "connecting…" (item 220): the rail is locked while
    // this is pending, so a promise that never settles locks it for good.
    const connecting = api.connectAgent({
      binary: d.agentBinary.trim() || undefined,
      model: d.agentModel.trim() || undefined,
      workspace: d.workspace.trim() || undefined,
      tools: d.tools,
      approval: d.approval,
      safeMode: d.agentSafeMode,
      budget: d.agentBudget > 0 ? d.agentBudget : undefined,
      system: d.system.trim() || undefined,
      preamble: d.preamble,
      ask: d.agentAsk,
      plan: d.agentPlan,
      subagentsAuto: d.agentSubagentsAuto,
      limits: d.agentLimits,
      forkMode: d.agentForkMode,
      claudeAiConnectors: d.agentClaudeAi,
      claudeAiBlocked: d.agentClaudeAiBlocked,
      browser: d.agentChrome,
      promptSuggestions: suggestions.enabled,
      effort: d.agentEffort.trim() || undefined,
      fallbackModel: d.agentFallback.trim() || undefined,
      // A changed layer waits for this chat's cold moment (backlog 174).
      // `take` false (the Context page's look, review RF 2026-09-26): the
      // connect only reads the marks and never takes one, cold or not.
      cold: take && chatIsCold(app.events, Date.now()),
      autoLayers: app.layerPrefs.autoAtCold,
      updateNow,
      // His subagent rules in words (backlog 291), for the rules layer.
      subagentRules: rulesFor(subagentRules.store, chat),
    });
    const res = await withDeadline(connecting, CONNECT_DEADLINE_MS, "Connecting to Claude Code");
    filesSeenGen = Math.max(filesSeenGen, filesGen);
    app.promptPending = await withDeadline(api.promptPending(), 5_000, "The held prompt").catch(() => null);
    app.connection = {
      provider: res.provider,
      model: res.model,
      // Claude Code decides its own reasoning; there is no knob here to
      // report, and "default" is the honest thing for the annotation to say.
      thinking: "default",
      tools: d.tools,
      contextLimit: res.context_limit ?? null,
      price: res.price ?? null,
      mcp: res.mcp ?? [],
      reviewers: res.reviewers ?? [],
      workspace: res.workspace,
      search: res.search ?? null,
      knowledge: res.knowledge ?? null,
      engine: "claude-code",
      agent: res.agent ?? null,
      folders: res.folders ?? [],
    };
    // Whether Claude Code is signed in (backlog 409), for the engine chip:
    // a local `claude auth status`, zero tokens, not awaited.
    void probeAuth(res.agent?.binary ?? null);
    // A switch made during the connect wins (535f): its own `openProject`
    // answer is newer than this connect's.
    if ((app.project?.id ?? null) === projectAtStart) app.project = res.project ?? null;
    saveLastConnection({ ...d });
    app.connectedFor = { chat, choice: sent };
    chatConnected(chat, sent);
    void refreshPlanUsage();
  } catch (e) {
    // A failure here is usually the binary: not installed, or not on the
    // PATH this process inherited. The rail shows the message, which names
    // both possibilities.
    app.connectError = String(e);
    app.connection = null;
  } finally {
    app.connecting = false;
  }
}

/** Counts files kept in the project (item 306); `filesSeenGen` is the count
 *  the last finished connect started from: the project-notes listing a
 *  connection carries is as old as the connect's start. ~~A boolean cleared
 *  when a connect resolved~~ (review 2026-10-05: a Keep landing during an
 *  in-flight connect was cleared by it, and the New chat went without it). */
export let filesChangedGen = 0;
export let filesSeenGen = 0;

/** A file landed in the project's docspace (item 306's Keep): the next New
 *  chat turn connects first, so its prompt lists it. */
export function projectFilesChanged(): void {
  filesChangedGen += 1;
}

/** Switch engines and re-connect. */
export async function useEngine(engine: Engine): Promise<void> {
  if (app.draft.engine === engine || app.busy || app.connecting) return;
  app.draft.engine = engine;
  // The previous engine's connection is not this engine's, and leaving it up
  // while the new connect runs would show a provider chip over an agent
  // chat. A failed connect leaves it null, which reads as "not connected"
  // beside the error — which is what happened.
  app.connection = null;
  app.agentTurn = null;
  app.agentInit = null;
  // ~~`app.subagents = []`~~ — rows are per chat since backlog 160.
  app.suggestion = null;
  // ~~`app.aside = null`~~ — not since backlog 137 (2026-09-17): the thread
  // is his reading and belongs to the chat, not the engine; nulling it
  // here lost it (the next switch away then dropped the stash entry too).
  // The card stays; its follow-up box asks for the Claude Code engine.
  await applyDraft();
}

// ---- saved system prompts ----

/**
 * Close the library by any route — its Close, Esc, the scrim, Save & use —
 * and reopen the popover when the popover's pencil opened it. One function
 * so a click outside cannot strand `promptsFrom`.
 */
export function closePrompts(): void {
  app.showPrompts = false;
  if (app.promptsFrom === "rail") {
    app.railScrollTo = "prompt";
    app.showRail = true;
  }
  app.promptsFrom = null;
}

/**
 * Put a saved prompt on the draft and re-connect. `null` clears it.
 *
 * The text is *copied* onto the draft rather than referenced, so the chat's
 * prompt is whatever was applied — editing the library entry afterwards does
 * not silently change the prompt a running chat was connected with.
 */
export async function usePrompt(id: string | null): Promise<void> {
  const p = id ? app.prompts.find((x) => x.id === id) : null;
  app.draft.promptId = p?.id ?? null;
  app.draft.system = p?.text ?? "";
  await applyDraft();
}

/**
 * Write a prompt into the library. Passing an `id` updates that entry (a
 * rename included), otherwise a new one is added and returned.
 */
export function storePrompt(
  name: string,
  text: string,
  id?: string | null,
): string {
  const now = Date.now();
  const trimmed = name.trim() || "Untitled";
  const existing = id ? app.prompts.find((p) => p.id === id) : undefined;
  if (existing) {
    existing.name = trimmed;
    existing.text = text;
    existing.updated = now;
  } else {
    id = newPromptId();
    app.prompts.unshift({ id, name: trimmed, text, updated: now });
  }
  app.prompts.sort((a, b) => b.updated - a.updated);
  savePrompts([...app.prompts]);
  return id!;
}

/**
 * Remove a prompt. A chat connected with it keeps its text — the draft holds
 * a copy — but loses the pointer, so the rail stops naming a prompt that is
 * no longer in the library.
 */
export function deletePrompt(id: string): void {
  const i = app.prompts.findIndex((p) => p.id === id);
  if (i < 0) return;
  app.prompts.splice(i, 1);
  savePrompts([...app.prompts]);
  if (app.draft.promptId === id) {
    app.draft.promptId = null;
    saveLastConnection({ ...app.draft });
  }
}

/** Re-query provider availability (after storing/clearing an API key). */
export async function refreshProviders(): Promise<void> {
  try {
    app.providers = await api.providers();
  } catch {
    // availability refresh is best-effort
  }
}

/** Re-query which search backends have a key (after storing/clearing one). */
export async function refreshSearchBackends(): Promise<void> {
  try {
    app.searchBackends = await api.searchBackends();
  } catch {
    // same: the rail degrades to "no search key" rather than failing
  }
}

/** Fetch a provider's live model list (cached until `force`). */
export async function fetchModels(kind: string, force = false): Promise<void> {
  if (!force && app.modelLists[kind]) return;
  // Every write goes through `app.modelFetch[kind]` rather than through a
  // local alias: `??=` evaluates to the *raw* right-hand object, not the
  // deep-`$state` proxy the store wrapped it in, so mutating the alias
  // updated the target while the UI kept reading a stale signal — which is
  // what left the button saying "fetching…" forever once a fetch finished.
  app.modelFetch[kind] ??= { loading: false, error: null };
  if (app.modelFetch[kind].loading) return;
  app.modelFetch[kind].loading = true;
  app.modelFetch[kind].error = null;
  try {
    const baseUrl =
      kind === "openai-chat" ? app.draft.baseUrl.trim() || undefined : undefined;
    app.modelLists[kind] = await api.listModels(kind, baseUrl);
  } catch (e) {
    app.modelFetch[kind].error = String(e);
  } finally {
    app.modelFetch[kind].loading = false;
  }
}

/** Mutate catalog prefs and persist them. */
export function setPrefs(mutate: (p: CatalogPrefs) => void): void {
  mutate(app.prefs);
  savePrefs(JSON.parse(JSON.stringify(app.prefs)) as CatalogPrefs);
}
