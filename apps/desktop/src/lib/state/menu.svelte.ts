// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { isMac } from "../platform";
import { stopChordTarget } from "../stopButton";
import { isProviderVisible, modelsFor, providerLabel, sanitizeThinking } from "../catalog";
import { stepFocusedField } from "../fieldUndo";
import type { ProviderInfo } from "../types";
import { newTab, closeTab, stepTab, splitActiveTab } from "./tabs.svelte";
import { undo, redo, inTextField } from "./edits.svelte";
import { openProjectFolder, showNewProject, importFromClaude } from "./projects.svelte";
import { usable, applyDraft, useEngine } from "./connection.svelte";
import { app, newSession, cancelTurn, addToast } from "../state.svelte";

/**
 * Panels that may take a menu command before `runMenuCommand`'s own
 * switch: each is asked in turn and answers true to keep the command
 * (nightshift backlog 113 — the terminal pane's ⌘T / ⌘W while focused).
 */
export const menuInterceptors: Array<(id: string) => boolean> = [];

/**
 * A click in the macOS menu bar (`mac_menu` in `main.rs`), which is where
 * that platform's window commands live because its frame is native and there
 * is no bar of ours to hang them on.
 *
 * Every id here names a flow that already exists and is reached some other
 * way as well — nothing is only in the menu, so a Windows user is missing no
 * capability. Unknown ids are ignored rather than logged: the OS performs its
 * own predefined items (quit, copy, minimize) and forwards them here anyway.
 *
 * Settings *opens* rather than toggles. A menu item reading "Settings…" that
 * closed the pane when it happened to be open would be answering a question
 * nobody asked.
 */
export function runMenuCommand(id: string): void {
  // A panel with the focus may take a command first (the terminal pane,
  // nightshift backlog 113: ⌘T, ⌘W, ⌘⇧], ⌘⇧[ act on its shells while it
  // has the keyboard — board 12c). Registered by the panel's own module,
  // so this file imports nothing of it.
  for (const take of menuInterceptors) if (take(id)) return;
  switch (id) {
    case "settings":
      // Settings takes the popover's place rather than stacking on it
      // (review round 1, 2026-09-13).
      app.showRail = false;
      app.showContext = false;
      app.showSettings = true;
      break;
    case "new_chat":
      void newSession();
      break;
    // The two kinds (nightshift backlog 102, 2026-09-16): ⌘N a Claude
    // Code chat, ⌥⌘N a Chat, fixed rather than "the default and the
    // other" so the File menu can name them. `new_chat` above stays the
    // project's default kind for the wide button, ⌘K and the Welcome strip.
    case "new_build":
      void newSession(undefined, "build");
      break;
    case "new_talk":
      void newSession(undefined, "chat");
      break;
    // The two other kinds (nightshift backlog 059, 2026-09-15), offered
    // wherever New chat is: the sidebar's split button, ⌘K, the Welcome
    // strip, the File menu.
    case "new_incognito":
      void newSession("incognito");
      break;
    case "new_ephemeral":
      void newSession("ephemeral");
      break;
    // Tabs (nightshift backlog 099, 2026-09-17): ⌘T, ⌘W, ⌘⇧], ⌘⇧[ and
    // Open beside, from the macOS menu; `App.svelte` binds the chords
    // elsewhere.
    case "new_tab":
      void newTab();
      break;
    case "close_tab":
      void closeTab();
      break;
    case "next_tab":
      void stepTab(1);
      break;
    case "prev_tab":
      void stepTab(-1);
      break;
    case "split_tab":
      void splitActiveTab();
      break;
    case "new_project":
      showNewProject();
      break;
    case "add_project":
      void openProjectFolder();
      break;
    case "import_claude":
      void importFromClaude();
      break;
    // The redesign's set (nightshift blocker 035, built as drawn). The
    // popover and the overlays *toggle*, unlike Settings: each is a thing
    // you glance at and dismiss, and the key that opened it is the natural
    // way back.
    case "model":
      app.overlay = null;
      app.showContext = false;
      app.showRail = !app.showRail;
      break;
    case "context":
      app.overlay = null;
      app.showRail = false;
      app.showContext = !app.showContext;
      break;
    case "commands":
      app.overlay = app.overlay === "commands" ? null : "commands";
      break;
    case "projects":
      app.overlay = app.overlay === "projects" ? null : "projects";
      break;
    case "engine":
      void toggleEngine();
      break;
    // ⌘. (item 398, blocker 1506): the composer's Stop, by key. An aside
    // box with the keyboard takes it first (Composer's interceptor); here
    // it is the chat's turn, and nothing when none runs — the same
    // `app.busy` that puts the Stop on screen.
    case "stop_turn":
      if (stopChordTarget({ asideFocused: false, asideBusy: false, turnBusy: app.busy }) === "turn") void cancelTurn();
      break;
    case "model_sonnet":
    case "model_opus":
    case "model_fable":
    case "model_haiku":
      void switchModel(id.slice(6));
      break;
    // The Edit menu's Undo and Redo, ours since nightshift backlog 064: in
    // a text box the key is the box's — the webview's own command keeps
    // the typing history — and anywhere else it is the app's stack.
    // Item 421: a plain field or a CodeMirror editor steps its OWN history
    // (`fieldUndo.ts`) — WebKit's `execCommand` stack is the whole page's,
    // so ⌘Z in the Find bar undid the message box. The message box and the
    // edit box took the command above (their interceptors).
    case "undo_app":
      if (inTextField()) {
        if (!stepFocusedField("undo")) document.execCommand("undo");
      } else void undo();
      break;
    case "redo_app":
      if (inTextField()) {
        if (!stepFocusedField("redo")) document.execCommand("redo");
      } else void redo();
      break;
    // ⌘F (nightshift backlog 287): since web tabs pass 2 (backlog 172) the
    // Edit menu's Find… holds ⌘F, so on macOS the key never reaches the
    // page; when no web page has the keyboard the item lands here. Replay
    // it as the key so the chat's find bar and the Context page's — each
    // listening for ⌘F on the window — open exactly as they did before.
    case "find_in_page": {
      const mac = navigator.platform.toUpperCase().includes("MAC");
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: mac, ctrlKey: !mac, bubbles: true }),
      );
      break;
    }
    default:
      // ⌘1…9: the n-th provider pill; ⌘⇧1…9: the n-th model in the picker
      // (review round 1, 2026-09-13/14).
      if (id.startsWith("provider_")) void switchProvider(Number(id.slice(9)));
      else if (/^model_[1-9]$/.test(id)) void switchModelAt(Number(id.slice(6)));
  }
}

/**
 * The provider pills in the popover's order — visible ones, plus the one
 * selected even if Settings has since hidden it — so a key cap printed on
 * a pill and the ⌘-digit that switches to it count the same list.
 */
export function providerPills(): ProviderInfo[] {
  return app.providers.filter(
    (p) => isProviderVisible(p.kind, app.prefs) || p.kind === app.draft.provider,
  );
}

/**
 * Switch to the n-th provider pill (1-based), taking its default model the
 * way a click on the pill does. A keyless provider is declined with a
 * toast, as its pill is disabled; on the Claude Code engine the keys do
 * nothing, since there is no provider to pick.
 */
export async function switchProvider(n: number): Promise<void> {
  if (app.busy || app.connecting || app.draft.engine === "claude-code") return;
  const p = providerPills()[n - 1];
  if (!p) return;
  if (!usable(p)) {
    addToast(`${providerLabel(p.kind)} has no key — add one in Settings`);
    return;
  }
  if (p.kind === app.draft.provider) return;
  app.draft.provider = p.kind;
  const list = modelsFor(p.kind, app.prefs, p.default_model ?? null);
  app.draft.model =
    p.default_model && list.includes(p.default_model) ? p.default_model : (list[0] ?? "");
  sanitizeThinking(app.draft);
  if (app.draft.model) await applyDraft();
}

/** The other engine. */
export async function toggleEngine(): Promise<void> {
  await useEngine(app.draft.engine === "claude-code" ? "provider" : "claude-code");
}

/**
 * The model list the popover draws for the current provider — what Settings
 * switched on, in the picker's order, with the draft's own model kept at the
 * head if Settings has since hidden it. `switchModelAt` counts the same
 * list, so the ⌘⇧-digit on a row is the digit that picks it.
 */
export function pickerModels(): string[] {
  const sel = app.providers.find((p) => p.kind === app.draft.provider);
  const list = modelsFor(app.draft.provider, app.prefs, sel?.default_model ?? null);
  if (app.draft.model && !list.includes(app.draft.model)) list.unshift(app.draft.model);
  return list;
}

/**
 * ⌘⇧S / O / F / H — the Claude Code engine's aliases. On the API engine the
 * key declines with the hint that models are numbered there: the four
 * letters were Anthropic-only, and he asked that no provider be special
 * (nightshift blockers 035, 044).
 */
export async function switchModel(alias: string): Promise<void> {
  // ~~Refused while a turn or connect ran~~ — taken, for the next turn
  // (backlog 214; `applyDraft` defers the connect).
  if (app.draft.engine !== "claude-code") {
    addToast(`On the API engine models are ${keyMod()}${keyShift()}1–9; the letters are Claude Code's`);
    return;
  }
  if (app.draft.agentModel === alias) return;
  app.draft.agentModel = alias;
  await applyDraft();
}

/** ⌘⇧1…9: the n-th model of the picker, on the API engine. */
export async function switchModelAt(n: number): Promise<void> {
  // As `switchModel`: a pick during a turn waits for it (backlog 214).
  if (app.draft.engine === "claude-code") return;
  const target = pickerModels()[n - 1];
  if (!target) {
    addToast(`${providerLabel(app.draft.provider)}'s picker has no model ${n}`);
    return;
  }
  if (app.draft.model === target) return;
  app.draft.model = target;
  sanitizeThinking(app.draft);
  await applyDraft();
}

const keyMod = () => (isMac ? "⌘" : "Ctrl+");
const keyShift = () => (isMac ? "⇧" : "Shift+");

/**
 * Fill `app.contextLimits[kind]` for `models`, asking only about ids not
 * already answered. Best-effort like every other look-up the rail makes: a
 * failure leaves the column blank, which is also what "unknown" looks like.
 */
export async function loadContextLimits(kind: string, models: string[]): Promise<void> {
  if (!kind) return;
  const known = (app.contextLimits[kind] ??= {});
  const missing = models.filter((m) => !(m in known));
  if (missing.length === 0) return;
  try {
    const limits = await api.contextLimits(kind, missing);
    missing.forEach((m, i) => (app.contextLimits[kind][m] = limits[i] ?? null));
  } catch {
    // leave them unanswered; the next look asks again
  }
}
