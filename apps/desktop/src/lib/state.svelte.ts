import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { isMac } from "./platform";
import {
  defaultDraft,
  isProviderVisible,
  loadLastConnection,
  loadPrefs,
  loadPrompts,
  modelInstructionFile,
  modelsFor,
  providerLabel,
  newPromptId,
  sanitizeThinking,
  saveLastConnection,
  savePrefs,
  savePrompts,
  thinkingString,
  type CatalogPrefs,
  type Engine,
  type SavedPrompt,
} from "./catalog";
import type {
  AgentInfo,
  AgentTurnResult,
  ApprovalDecision,
  ApprovalRequest,
  BlockerList,
  DocumentInput,
  ImageInput,
  ItemList,
  KnowledgeInfo,
  McpServerInfo,
  Morning,
  MorningPage,
  NightshiftChange,
  NightshiftLaunched,
  NightshiftRow,
  NightshiftUsage,
  InterviewEvent,
  InterviewMessage,
  NoteEntry,
  PendingLaunch,
  Plan,
  RevertPreview,
  ShiftSummary,
  ReviewerInfo,
  Note,
  NoteScope,
  Price,
  ProjectInfo,
  ProposalEntry,
  ProposalScope,
  ProviderInfo,
  SearchBackendInfo,
  SessionEvent,
  SessionMeta,
  TodoItem,
  TurnEvent,
  Usage,
} from "./types";

/**
 * Which project the app reopens at launch. A UI preference, not a source of
 * truth — the backend registry is that, and this only records where the user
 * left off.
 */
const LAST_PROJECT_KEY = "nightloom.last-project";

function loadLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function saveLastProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // best-effort
  }
}

/**
 * How the dream runs: whether a compaction triggers one, and on which model.
 * A UI preference like the last connection — the backend holds no opinion.
 */
const DREAM_PREFS_KEY = "nightloom.dream";

export interface DreamPrefs {
  /** Dream automatically after a compaction, when the inbox has entries. */
  auto: boolean;
  /** Provider that dreams; "" means whatever the rail is connected to. */
  provider: string;
  /** Model that dreams; "" means the provider's default. */
  model: string;
}

function loadDreamPrefs(): DreamPrefs {
  try {
    const raw = localStorage.getItem(DREAM_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DreamPrefs>;
      return {
        auto: !!p.auto,
        provider: typeof p.provider === "string" ? p.provider : "",
        model: typeof p.model === "string" ? p.model : "",
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { auto: false, provider: "", model: "" };
}

export function saveDreamPrefs(): void {
  try {
    localStorage.setItem(DREAM_PREFS_KEY, JSON.stringify(app.dreamPrefs));
  } catch {
    // best-effort
  }
}

/**
 * The colour palette — one of the four dark candidates in `app.css`. "A"
 * (charcoal & amber) is the default and needs no attribute; the others are
 * applied as `data-palette` on the root element so the token blocks in
 * `app.css` select themselves.
 */
export type Palette = "A" | "B" | "C" | "D";
export const PALETTES: { id: Palette; name: string }[] = [
  { id: "A", name: "Charcoal & amber" },
  { id: "B", name: "Slate & copper" },
  { id: "C", name: "Graphite & teal" },
  { id: "D", name: "Espresso & gold" },
];
const PALETTE_KEY = "nightloom.palette";

function loadPalette(): Palette {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    if (raw === "B" || raw === "C" || raw === "D") return raw;
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return "A";
}

/** Stamp the palette on the document. Safe where there is no document. */
export function applyPalette(p: Palette): void {
  if (typeof document === "undefined") return;
  if (p === "A") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
}

export function setPalette(p: Palette): void {
  app.palette = p;
  applyPalette(p);
  try {
    localStorage.setItem(PALETTE_KEY, p);
  } catch {
    // best-effort
  }
}

/**
 * Where the panes sit: the sidebar's width and whether it is collapsed, and
 * the width of every resizable pane on the Nightshift screens, keyed by
 * screen and side (`morning.aside`, `runs.list`, …). A UI preference; a
 * lost one costs a drag, not data.
 */
export interface Layout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  panes: Record<string, number>;
}
const LAYOUT_KEY = "nightloom.layout";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 440;

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>;
      const w = typeof p.sidebarWidth === "number" ? p.sidebarWidth : 260;
      return {
        sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
        sidebarCollapsed: !!p.sidebarCollapsed,
        panes:
          p.panes && typeof p.panes === "object"
            ? Object.fromEntries(
                Object.entries(p.panes).filter(
                  ([, v]) => typeof v === "number" && Number.isFinite(v),
                ),
              )
            : {},
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { sidebarWidth: 260, sidebarCollapsed: false, panes: {} };
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(app.layout));
  } catch {
    // best-effort
  }
}

export function toggleSidebar(): void {
  app.layout.sidebarCollapsed = !app.layout.sidebarCollapsed;
  saveLayout();
}

export function setSidebarWidth(px: number): void {
  app.layout.sidebarWidth = Math.round(
    Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)),
  );
  saveLayout();
}

/** A pane's saved width, or the screen's default. */
export function paneWidth(key: string, fallback: number): number {
  return app.layout.panes[key] ?? fallback;
}

export function setPaneWidth(key: string, px: number): void {
  app.layout.panes[key] = Math.round(px);
  saveLayout();
}

/**
 * Morning pages the user has opened, per project. The contract has no
 * notion of a read page — the runner writes them and nothing reads them
 * back — so "unread" is a fact about this window, kept here.
 */
const READ_KEY = "nightloom.nightshift.read";

function loadReadPages(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(p)) {
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
      }
      return out;
    }
  } catch {
    // best-effort
  }
  return {};
}

/** The diff on show under Runs: one unit's commit, or the whole shift. */
export interface NightshiftDiff {
  kind: "unit" | "shift";
  /** The commit sha, or the shift id. */
  key: string;
  text: string;
  loading: boolean;
  error: string | null;
}

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  result: { content: string; is_error: boolean } | null;
  /** Refused at the approval gate: nothing ran, `result` holds the reason. */
  denied?: boolean;
}

/**
 * Normalized assistant-message segment, used both for the live streaming
 * message and for completed messages projected from SessionEvents.
 */
export type Segment =
  | { kind: "thinking"; text: string; done: boolean }
  | { kind: "redacted" }
  | { kind: "text"; text: string }
  | { kind: "tool"; call: ToolCallView }
  | { kind: "notice"; text: string };

export interface Connection {
  provider: string;
  model: string;
  thinking: string;
  tools: boolean;
  /** Context window of the connected model; null when unknown. */
  contextLimit: number | null;
  /** Per-MTok rates for the connected model; null when unpriced. */
  price: Price | null;
  /** MCP servers for this workspace, including ones that failed to start. */
  mcp: McpServerInfo[];
  /** The curated bench `review` can ask for a second opinion; empty when no
   *  other lineage is reachable, in which case the tool is not offered. */
  reviewers: ReviewerInfo[];
  /** Resolved workspace root the file tools operate in. */
  workspace: string;
  /** Which provider answers `web_search`, or null when no key is set and the
   *  tool is absent. `web_fetch` needs none and is always there. */
  search: string | null;
  /** The knowledge base the model can reach, or null when the switch is off
   *  (always null on the agent engine, which owns its own file access). */
  knowledge: KnowledgeInfo | null;
  /**
   * Which engine is running. Read from the backend's answer rather than from
   * the draft that asked, so the two cannot disagree about it — the same
   * reason `project` is read back.
   */
  engine: Engine;
  /** Present only on the agent engine. */
  agent: AgentInfo | null;
}

export const app = $state({
  providers: [] as ProviderInfo[],
  /** Web-search backends and which one has a key (settings modal edits this). */
  searchBackends: [] as SearchBackendInfo[],
  /** Which providers/models the rail dropdowns offer (settings modal edits this). */
  prefs: loadPrefs() as CatalogPrefs,
  /** Every registered project, newest-opened first. */
  projects: [] as ProjectInfo[],
  /**
   * The open project, or null for an unfiled chat.
   *
   * Not derived from `draft.workspace`: an open project overrides it on the
   * backend, and two answers to "which folder is this" is one too many.
   */
  project: null as ProjectInfo | null,
  /** The open project's shared notes. Empty when nothing is open. */
  notes: [] as Note[],
  /**
   * The user's knowledge base. Listed whether or not a project is open, which
   * is the point of it — an unfiled chat has a vault.
   */
  vault: [] as Note[],
  /** Where the vault is; null on a machine with no user config directory. */
  knowledge: null as KnowledgeInfo | null,
  /**
   * What the centre pane shows. "note" is the note editor and "graph" the
   * vault's link graph, both of which replace the transcript rather than
   * floating over it — reading, writing and navigating notes is work, not a
   * dialog.
   */
  view: "chat" as "chat" | "note" | "graph" | "nightshift",
  /**
   * The note open in the centre pane, when `view` is "note".
   *
   * Carries its scope: the two stores can hold a note of the same name, and a
   * bare string would make saving depend on which sidebar tab happened to be
   * showing.
   */
  openNote: null as { scope: NoteScope; name: string } | null,
  /** Which mode the left sidebar is in: its list follows. */
  leftTab: "chats" as "chats" | "notes" | "nightshift",
  /** The rail's connection settings; any change re-connects via applyDraft(). */
  draft: defaultDraft(),
  connection: null as Connection | null,
  connecting: false,
  /** Last connect failure, shown in the rail until the next attempt. */
  connectError: null as string | null,
  sessions: [] as SessionMeta[],
  activeSessionId: null as string | null,
  /** Source of truth for the transcript (re-synced from the backend after each turn). */
  events: [] as SessionEvent[],
  /** In-progress assistant turn built from turn-events; null when idle. */
  live: null as { segments: Segment[] } | null,
  /** Bumped on every turn-event so effects (auto-scroll) can depend on stream progress. */
  liveVersion: 0,
  /**
   * Tool calls parked at the approval gate, oldest first. The turn is
   * blocked on each of these, so every path that ends a turn has to empty
   * this — a prompt left on screen after the turn is gone answers nothing.
   */
  pendingApprovals: [] as ApprovalRequest[],
  /**
   * Newest per-round usage from the in-flight turn. Cleared when the turn
   * ends, at which point `contextUsed()` reads the same number back off the
   * trailing assistant message instead.
   */
  liveUsage: null as Usage | null,
  busy: false,
  /** Error banner shown in the transcript until the next send. */
  error: null as string | null,
  /** Settings modal (providers: API keys, model visibility). */
  showSettings: false,
  /**
   * The model popover under the top bar's chip (Model · Tasks · Context).
   * App state rather than the bar's own, so ⌘M and the ⌘K palette can open
   * it from anywhere (chat-surface redesign, 2026-09-13).
   */
  showRail: false,
  /**
   * The context popover under the top bar's gauge chip — the Context tab
   * of the rail, given its own button (review round 1, 2026-09-13). Its
   * own flag rather than a tab in `showRail` so ⌘⇧C can open it alone.
   */
  showContext: false,
  /**
   * The keyboard overlays: ⌘P's project switcher and ⌘K's command palette.
   * One slot, because two palettes open at once would both be listening for
   * the same keys.
   */
  overlay: null as null | "projects" | "commands",
  /**
   * Context windows from the backend's limits table, per provider then
   * model id; null where the table is silent. Read once per list and kept:
   * the table is static, so a second look-up can only answer the same.
   */
  contextLimits: {} as Record<string, Record<string, number | null>>,
  /** The user's saved system prompts, newest-written first. */
  prompts: loadPrompts() as SavedPrompt[],
  /** Prompt library modal; a string is the id it opens on. */
  showPrompts: false,
  /**
   * Who opened the library. `"rail"` when the popover's pencil did, so
   * closing the library — by Save & use, Close, Esc or a click outside —
   * brings the popover back with the chosen prompt in its dropdown
   * (review round 1, 2026-09-13: the library used to open *behind* the
   * popover).
   */
  promptsFrom: null as null | "rail",
  /** The popover scrolls to this section when it next opens, then clears
   *  it — so the round trip through the library lands on the dropdown, and
   *  the one through a model's instruction file lands on the model list. */
  railScrollTo: null as null | "prompt" | "model",
  /**
   * Who opened the note editor on a model's instruction file — the popover's
   * pencil or the Settings row — so closing it (Save, ← Chat) brings that
   * surface back, the same round trip the prompt library makes for the
   * popover (nightshift blocker 042). Null for a note opened from the
   * sidebar, which goes back to the chat as it always did.
   */
  noteFrom: null as null | "rail" | "settings",
  /** Which pane Settings opens on next time, then clears; the round trip
   *  back from a model's file lands on the Model instructions row. */
  settingsOpenOn: null as null | "models",
  /**
   * The library's unsaved edit, kept here rather than in the component so
   * that no way out of the modal loses typed text (memory never-lose-work):
   * reopening the library offers the draft back. `selected` is the entry
   * being edited, null for a new one.
   */
  promptDraft: null as null | { selected: string | null; name: string; text: string },
  /**
   * Unsaved note text, keyed `scope:name`, kept for the life of the app (the
   * never-lose-work rule): leaving a note and coming back finds the edit
   * still there, marked as a draft, with Revert to drop it and Save to keep
   * it. Not persisted to disk — a draft the user has not saved is not the
   * file's content — and cleared on save and on revert.
   */
  noteDrafts: {} as Record<string, string>,
  /**
   * The dream's pending proposals for the two always-loaded files, per
   * scope, newest first — the badge on each pinned row. Re-listed with the
   * notes after every turn and every dream. The pass never writes either
   * file: a proposal is applied only by loading it into the editor as a
   * draft and saving (`stageProposal`, then the ordinary `saveNote`).
   */
  proposals: { instructions: [], memory: [] } as Record<ProposalScope, ProposalEntry[]>,
  /**
   * The proposal `NoteView` is showing as a diff, when it is showing one
   * rather than the editor. Cleared by every way out: loading it into the
   * editor, dismissing it, keeping it for later, opening another note.
   */
  proposalReview: null as null | { scope: ProposalScope; entry: ProposalEntry },
  /**
   * The proposal whose text is in the buffer as a draft, so a Save of that
   * draft can record it as applied (`mark_applied`) and a Revert can
   * forget it. Keyed like `noteDrafts`; null when the buffer holds no
   * proposal.
   */
  stagedProposal: null as null | { key: string; scope: ProposalScope; id: string },
  /** Live model lists fetched from provider APIs, per provider kind. */
  modelLists: {} as Record<string, string[]>,
  /** Fetch status per provider kind (settings modal UI). */
  modelFetch: {} as Record<string, { loading: boolean; error: string | null }>,
  /**
   * What the last agent turn reported: the plan window it came out of, and
   * the CLI's estimate of what the same turn would have cost on the API.
   *
   * Kept apart from the cost readout in the top bar, which sums money that
   * was actually charged. Under a subscription none of this was, and showing
   * an estimate where a bill goes would be the one reading of the number
   * that is false.
   */
  agentTurn: null as AgentTurnResult | null,
  /** Observations awaiting the next dream — the badge on the Dream button. */
  dreamPending: 0,
  /** A dream is running; the button becomes its progress line. */
  dreaming: false,
  /** The dream's most recent tool call, for the running button's tooltip. */
  dreamActivity: "",
  /** Auto-dream and the dream model, Settings → Knowledge. */
  dreamPrefs: loadDreamPrefs(),
  /** Session logs with something new since the last capture — the count on
   *  the Capture button. Always shown: the chat open right now is one. */
  capturePending: 0,
  /** A capture is running; the button becomes its progress line. */
  capturing: false,
  /** The colour palette, Settings → Appearance. */
  palette: loadPalette() as Palette,
  /** Sidebar width and collapse, pane widths on the Nightshift screens. */
  layout: loadLayout(),
  toasts: [] as { id: number; text: string }[],
  /**
   * The Nightshift surface: every registered project's detection row, which
   * one is selected, which tab is showing, and the selected project's newest
   * morning page. `rows` mirrors the backend registry the same way
   * `app.projects` does — re-read after anything that could have changed it,
   * never mutated locally except to splice in a fresher row.
   */
  nightshift: {
    rows: [] as NightshiftRow[],
    selected: null as string | null,
    tab: "review" as "start" | "review",
    morning: null as MorningPage | null,
    loading: false,
    error: null as string | null,
    /** The runner install the Enable form is prefilled with; null when no
     *  registered project shows one. Read once per refresh. */
    defaultRunner: null as string | null,
    /** Which Review screen is showing. */
    reviewTab: "morning" as "morning" | "runs" | "blockers" | "notes",
    /** Every page under `mornings/`, newest first as the backend lists them. */
    mornings: [] as Morning[],
    /** Every `shifts/<id>/`, as the backend lists them. */
    shifts: [] as ShiftSummary[],
    selectedShift: null as string | null,
    /** The tail of the selected shift's `run.log`. */
    log: "",
    diff: null as NightshiftDiff | null,
    blockers: null as BlockerList | null,
    selectedBlocker: null as string | null,
    /** The flat listing `nightshift_notes` returns; folded into a tree by
     *  `notesTree` for the Notes screen. */
    notes: [] as NoteEntry[],
    /** Root-relative path of the file open in the Notes screen's main
     *  column; not necessarily one of `notes` above (a cross-link can open
     *  any file under the contract root, e.g. `mornings/<name>`). */
    selectedNote: null as string | null,
    /** The open note's text, or null while it is loading. */
    noteText: null as string | null,
    /** Morning pages opened in this window, by project id. */
    read: loadReadPages(),
    /** Which Start screen is showing. */
    startTab: "backlog" as "backlog" | "plan",
    /** `backlog/*` as `nightshift_items` lists it. */
    items: null as ItemList | null,
    /** The item shown in the Backlog screen's main column. */
    selectedItem: null as string | null,
    /** The in-progress plan the Plan screen edits locally; written only on
     *  Launch. */
    planDraft: null as Plan | null,
    /** `shifts/<id>/plan.json`'s path once `writeAndLaunch` has written it. */
    planPath: null as string | null,
    /** Set for the span of `writeAndLaunch`'s write-then-launch round trip. */
    launching: false,
    /** The launch the backend is holding for the selected project, or null.
     *  Read on entry (`loadPendingLaunch`), set by `scheduleLaunch`, cleared
     *  by `cancelLaunch` and by the `nightshift-launched` event. */
    pending: null as PendingLaunch | null,
    /** The runner's usage probe, for the Start field's reset time; null
     *  until read, and when the probe cannot answer. */
    usage: null as NightshiftUsage | null,
    /** The intake interview (item 005) for the selected project: null when
     *  none; `streaming` is the reply in flight; `busy` while a turn runs. */
    interview: null as {
      messages: InterviewMessage[];
      streaming: string;
      busy: boolean;
      model: string | null;
      /** The last answer the API refused (a false positive of its safeguards
       *  classifier happens on ordinary text); offered back for a rephrase. */
      lastRefused?: string;
    } | null,
    /** The interview drawer's draft, kept here so switching screens (to
     *  read an item, a note, the Plan) does not lose it: whether the drawer
     *  is open, the idea not yet sent, the reply being typed. */
    interviewDraft: { open: false, idea: "", reply: "" } as { open: boolean; idea: string; reply: string },
    /** Unsaved item edits by id — kept when the selection moves, offered
     *  back ("Continue editing") when it returns, dropped only by Save,
     *  Discard or Delete. Work is never lost to a click (2026-09-13). */
    editDrafts: {} as Record<string, string>,
  },
});

let initialized = false;

/**
 * A compaction landed during the in-flight turn (the model asked, the engine
 * honoured it at the boundary). Consumed by `send` once the transcript has
 * re-synced, which is where the auto-dream fires from.
 */
let compactedThisTurn = false;

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
    case "add_project":
      void addProject();
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
    case "model_sonnet":
    case "model_opus":
    case "model_fable":
    case "model_haiku":
      void switchModel(id.slice(6));
      break;
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
 * What ⌘⇧<letter> switches to. The letters are the Claude Code engine's
 * (2026-09-14, his second look: the CLI takes an alias, so `sonnet` *is* the
 * answer there); on the API engine models are numbered, so the letters name
 * nothing and this is null.
 */
export function modelForKey(alias: string): string | null {
  return app.draft.engine === "claude-code" ? alias : null;
}

/**
 * ⌘⇧S / O / F / H — the Claude Code engine's aliases. On the API engine the
 * key declines with the hint that models are numbered there: the four
 * letters were Anthropic-only, and he asked that no provider be special
 * (nightshift blockers 035, 044).
 */
export async function switchModel(alias: string): Promise<void> {
  if (app.busy || app.connecting) return;
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
  if (app.busy || app.connecting || app.draft.engine === "claude-code") return;
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

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<TurnEvent>("turn-event", (e) => applyTurnEvent(e.payload));
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  // The dream's own channel: a running chat and a running dream must not
  // interleave in the transcript, so its events never reach applyTurnEvent.
  // All the panel wants from them is a sign of life.
  await listen<TurnEvent>("dream-event", (e) => {
    if (e.payload.type === "tool_call") app.dreamActivity = e.payload.name;
  });
  // The capture pass has no tools and its reply is parsed on the backend;
  // nothing in its stream is for the panel. Listened to so the channel is
  // drained rather than for anything it carries.
  await listen<TurnEvent>("capture-event", () => {});
  await listen<ApprovalRequest>("tool-approval", (e) =>
    app.pendingApprovals.push(e.payload),
  );
  await listen<string>("menu", (e) => runMenuCommand(e.payload));
  // Only the watched project (selectNightshiftProject calls nightshiftWatch)
  // emits this, and only that project's row and morning page are worth
  // re-reading — a change event for anything else could not reach here.
  await listen<NightshiftChange>("nightshift-change", (e) => {
    if (e.payload.project_id === app.nightshift.selected) {
      void refreshNightshiftRow(e.payload.project_id);
      void refreshNightshiftReview(e.payload.paths);
    }
  });
  // A held launch fired (the Start field's timer): the same toast and the
  // same follow-up as the button, or the reason it could not.
  await listen<NightshiftLaunched>("nightshift-launched", (e) => {
    const { project_id, shift_id, pid, error } = e.payload;
    if (project_id === app.nightshift.selected) app.nightshift.pending = null;
    if (error) {
      addToast(`Scheduled launch failed: ${error}`);
      return;
    }
    addToast(`Launched shift ${shift_id} — pid ${pid}`);
    if (project_id !== app.nightshift.selected) return;
    void (async () => {
      await Promise.all([refreshNightshiftRow(project_id), loadNightshiftReview()]);
      if (shift_id) await selectShift(shift_id);
    })();
  });
  // The interviewer's reply, a delta at a time; `done` lands the text.
  await listen<InterviewEvent>("nightshift-interview", (e) => {
    const { project_id, kind, text } = e.payload;
    if (project_id !== app.nightshift.selected) return;
    const iv = app.nightshift.interview;
    if (!iv) return;
    if (kind === "delta") iv.streaming += text;
    else if (kind === "done") {
      iv.streaming = "";
      iv.messages.push({ role: "assistant", text });
    } else iv.streaming = "";
  });
  // A folder coming back is something that happens outside this window, so
  // nothing in here would otherwise notice it. Re-reading on focus is what
  // makes the missing-folder warning's "until it comes back" a promise the UI
  // can keep: the user leaves to put the folder back and it has cleared by
  // the time they return. Cheap enough to leave unconditional — one command
  // that stats a handful of paths, and only when the window is activated —
  // where a poll would be a filesystem check every few seconds forever.
  window.addEventListener("focus", () => void refreshProjects());
  const last = loadLastConnection();
  if (last) {
    app.draft = last;
    sanitizeThinking(app.draft);
  }
  try {
    app.providers = await api.providers();
  } catch (e) {
    app.error = String(e);
  }
  await refreshProjects();
  // Reopen where the user left off *before* connecting: the project decides
  // the workspace, so connecting first would root the tools at the previous
  // folder and then immediately re-connect to correct it.
  const lastProject = loadLastProject();
  if (lastProject && app.projects.some((p) => p.id === lastProject)) {
    try {
      app.project = await api.openProject(lastProject);
      // Opening bumps last-opened on the backend, so the list read a
      // moment ago is already stale in its ordering.
      await refreshProjects();
    } catch {
      // A project whose folder vanished must not stop the app launching.
      saveLastProject(null);
    }
  }
  await refreshSessions();
  await refreshKnowledge();
  await refreshNotes();
  await refreshDreamStatus();
  await refreshCaptureStatus();
  await autoConnect();
}

// ---- projects ----

export async function refreshProjects(): Promise<void> {
  try {
    app.projects = await api.listProjects();
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Keep the open project in step with the list it is a row of. `app.project`
  // is otherwise a snapshot taken at open/connect/rename, and `exists` is a
  // fact about the disk that changes underneath it — so the Welcome pane went
  // on saying the folder was gone after it came back, while the project menu,
  // reading this same list, said it was fine. Two answers to one question,
  // and the warning's own "until it comes back" was the one that was wrong.
  //
  // Only a matching row updates it. A project missing from the list has been
  // forgotten, and closing it is `forgetProject`'s job — doing it here would
  // put a second, silent close in the one function everything else calls to
  // refresh.
  const open = app.project;
  if (open) {
    const fresh = app.projects.find((p) => p.id === open.id);
    if (fresh) app.project = fresh;
  }
  // The Nightshift page follows the open project (round 2, point 12).
  void syncNightshiftProject();
}

/**
 * Re-read both note stores.
 *
 * Called after every turn, which is the visible half of shared knowledge: a
 * note the model just left appears in the sidebar without a reload. Both are
 * refreshed together because the model can write to either.
 */
export async function refreshNotes(): Promise<void> {
  if (app.project) {
    try {
      app.notes = await api.listNotes("project");
    } catch {
      // A store that cannot be listed shows as empty; the failure surfaces
      // when something is actually read or written.
      app.notes = [];
    }
  } else {
    app.notes = [];
  }
  try {
    app.vault = await api.listNotes("knowledge");
  } catch {
    app.vault = [];
  }
  await refreshProposals();
}

/**
 * Re-list the dream's pending proposals for both fixed files. With the
 * notes rather than on its own timer: a dream that proposed has just
 * refreshed the notes, and the badge should appear on the same tick as the
 * memory notes it filed.
 */
export async function refreshProposals(): Promise<void> {
  app.proposals.instructions = app.project
    ? await api.listProposals("instructions").catch(() => [])
    : [];
  app.proposals.memory = app.knowledge ? await api.listProposals("memory").catch(() => []) : [];
}

/** Where the vault is. Read on launch and after Settings repoints it. */
export async function refreshKnowledge(): Promise<void> {
  try {
    app.knowledge = await api.knowledgeInfo();
  } catch {
    app.knowledge = null;
  }
}

/** Re-count the memory inbox. Cheap: one file read on the backend. */
export async function refreshDreamStatus(): Promise<void> {
  try {
    app.dreamPending = await api.dreamStatus();
  } catch {
    // No config dir reads as zero on the backend; anything else is not
    // worth a toast for a badge.
  }
}

/** Re-count the session logs with something new. Directory scans only. */
export async function refreshCaptureStatus(): Promise<void> {
  try {
    app.capturePending = await api.captureStatus();
  } catch {
    // No config dir reads as zero on the backend; anything else is not
    // worth a toast for a count.
  }
}

/**
 * Which connection a background pass runs on: the dream model set in
 * Settings, or the rail's. One knob answers "which model dreams" for the
 * button and the auto-trigger alike — and the capture pass uses the same
 * one, being the front half of the same pipeline — and it is also what lets
 * the agent engine run either pass at all, having no provider of its own to
 * lend. `null` with a toast when there is nothing to run on.
 */
function passTarget(
  what: string,
): { provider: string; model?: string; baseUrl?: string; thinking?: string } | null {
  const d = app.draft;
  const prefs = app.dreamPrefs;
  if (prefs.provider) {
    return { provider: prefs.provider, model: prefs.model.trim() || undefined };
  }
  if (d.engine === "claude-code") {
    addToast(
      `${what} runs on a provider API — set a dream model in Settings → Knowledge, or pick a provider in the rail`,
    );
    return null;
  }
  return {
    provider: d.provider,
    model: d.model || undefined,
    baseUrl: d.baseUrl.trim() || undefined,
    thinking: thinkingString(d),
  };
}

/**
 * Run one capture pass with the dream's connection: read every session log
 * since its watermark and extract observations into the inbox. Its own job
 * on the backend, sharing the dream's one-at-a-time lock, since the two are
 * one pipeline.
 */
export async function runCapture(): Promise<void> {
  if (app.capturing || app.dreaming) return;
  const target = passTarget("capturing");
  if (!target) return;
  app.capturing = true;
  try {
    const r = await api.capture(target);
    // "3 from Lanternfish, 1 unfiled": the split by source.
    const split = r.per_project
      .map((p) =>
        p.project === "unfiled" ? `${p.observations} unfiled` : `${p.observations} from ${p.project}`,
      )
      .join(", ");
    addToast(
      (r.interrupted ? "capture interrupted — " : "capture: ") +
        `captured ${r.observations} observation${r.observations === 1 ? "" : "s"}` +
        ` from ${r.logs_read} chat${r.logs_read === 1 ? "" : "s"}` +
        (r.skipped > 0 ? ` (${r.skipped} line${r.skipped === 1 ? "" : "s"} skipped)` : "") +
        (split ? ` — ${split}` : "") +
        (r.deferred > 0 ? `; ${r.deferred} waiting for more turns` : "") +
        (r.remaining > 0 ? `; ${r.remaining} left for the next run` : "") +
        (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    addToast(`capture failed: ${String(e)}`);
  } finally {
    app.capturing = false;
  }
  // The pass fills the inbox and moves the watermarks; both counts follow.
  await refreshCaptureStatus();
  await refreshDreamStatus();
}

/** Interrupt the in-flight capture. The chat it stopped in is re-read next time. */
export async function stopCapture(): Promise<void> {
  try {
    await api.cancelCapture();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Run one dream with the rail's current provider settings.
 *
 * The connection travels as arguments rather than reusing the window's chat:
 * a dream is its own job with its own prompt and tool set, and it works the
 * same whichever engine the window is on — except that the agent engine has
 * no provider to lend it, which gets a sentence instead of a guess.
 */
export async function runDream(): Promise<void> {
  if (app.dreaming || app.capturing) return;
  const target = passTarget("dreaming");
  if (!target) return;
  app.dreaming = true;
  app.dreamActivity = "";
  try {
    const r = await api.dream(target);
    // "3 into Lanternfish, 2 into the vault": the split by target, which is
    // how the user learns a project's memory folder exists at all.
    const split = r.filed
      .map((f) => `${f.consolidated} into ${f.project ?? "the vault"}`)
      .join(", ");
    addToast(
      r.interrupted
        ? "dream interrupted — nothing consumed; the same batch is offered next time"
        : `dream: consolidated ${r.consolidated} observation${r.consolidated === 1 ? "" : "s"}` +
            (split ? ` — ${split}` : "") +
            (r.remaining > 0 ? `, ${r.remaining} left for the next run` : "") +
            ` — ${r.git}` +
            // "… and proposed a change to Lanternfish's instructions": the
            // one thing a dream leaves that is not yet in effect.
            (r.proposed ? ` — and ${r.proposed}` : "") +
            (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    addToast(`dream failed: ${String(e)}`);
  } finally {
    app.dreaming = false;
    app.dreamActivity = "";
  }
  // The pass writes notes and consumes the inbox; both surfaces follow.
  await refreshNotes();
  await refreshDreamStatus();
}

/**
 * The auto-dream trigger: a compaction just landed, which is the moment the
 * evidence supports — the conversation's detail is already being traded for
 * a summary, so a background consolidation interrupts nothing the user was
 * still watching. Opt-in (Settings → Knowledge) because it spends a
 * provider turn unattended; an empty inbox spends nothing and says nothing.
 *
 * Capture runs first, since 2026-09-14: the inbox only fills when a pass
 * reads the logs, so a dream without one would consolidate an inbox that is
 * empty on this machine. The compacted chat is among the logs read — up to
 * its watermark, which is fine.
 */
async function maybeAutoDream(): Promise<void> {
  if (!app.dreamPrefs.auto || app.dreaming || app.capturing) return;
  await refreshCaptureStatus();
  if (app.capturePending > 0) {
    addToast("auto-dream: reading the chats into the memory inbox");
    await runCapture();
  }
  await refreshDreamStatus();
  if (app.dreamPending === 0) return;
  addToast("auto-dream: consolidating the memory inbox");
  await runDream();
}

/** Interrupt the in-flight dream. Nothing is consumed; the batch returns. */
export async function stopDream(): Promise<void> {
  try {
    await api.cancelDream();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Point the knowledge base at a folder, or back at the default with null.
 *
 * Re-connects afterwards, because the vault is part of what `connect` roots
 * the file tools at and indexes into the preamble — leaving it would have the
 * sidebar showing one folder and the model reading another.
 */
export async function useKnowledgeDir(dir: string | null): Promise<void> {
  try {
    app.knowledge = await api.setKnowledgeDir(dir);
  } catch (e) {
    addToast(String(e));
    return;
  }
  // The open note may not exist in the new vault.
  if (app.openNote?.scope === "knowledge") closeNote();
  await refreshNotes();
  await applyDraft();
}

/**
 * Open a project (or, with null, leave the one that is open) and re-point
 * everything at it.
 *
 * One function rather than a handful the callers compose, because the order
 * matters and getting it wrong is silent: the backend has to know the project
 * before `connect` reads it — the project decides the workspace — and the
 * chat list has to be re-read after, since it comes from the project folder.
 */
export async function useProject(id: string | null): Promise<void> {
  if (app.busy) return;
  try {
    if (id) {
      app.project = await api.openProject(id);
    } else {
      await api.closeProject();
      app.project = null;
    }
  } catch (e) {
    addToast(String(e));
    return;
  }
  saveLastProject(app.project?.id ?? null);
  app.activeSessionId = null;
  app.events = [];
  app.error = null;
  // Switching projects from the Nightshift page stays on it — the page
  // follows the open project (round 2, point 12); everywhere else it is a
  // navigation to the new project's chat.
  if (app.view !== "nightshift") app.view = "chat";
  app.openNote = null;
  await applyDraft();
  await refreshProjects();
  await refreshSessions();
  await refreshNotes();
}

/**
 * Pick a folder and open it as a project.
 *
 * `createProject` is idempotent on the path, so choosing a folder that is
 * already a project opens it rather than erroring — which is what someone who
 * navigated back to it meant.
 */
export async function addProject(): Promise<void> {
  let path: string | null = null;
  try {
    path = await api.pickFolder();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!path) return; // cancelled
  try {
    const project = await api.createProject(path);
    await refreshProjects();
    await useProject(project.id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Import a claude.ai export: pick the archive, pick where the projects go,
 * write them, then show the list.
 *
 * One dialog, for the archive. There used to be a second asking where the
 * projects should be created, which stopped being a question worth asking
 * once a project stopped being a folder: an imported one is instructions,
 * documents and conversations, and the folder it was made to live in only
 * ever existed to give it an identity.
 */
export async function importFromClaude(): Promise<void> {
  let archive: string | null = null;
  try {
    archive = await api.pickExport();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!archive) return; // cancelled

  addToast("Importing…");
  try {
    const result = await api.importClaude(archive, true);
    await refreshProjects();
    addToast(`Imported ${result.summary}`);
    // The memory summaries that were too long for AGENTS.md: their file
    // points at the full text and someone owes a short version. Named, so
    // the toast says which projects rather than only how many.
    if (result.needs_condensing.length > 0) {
      const names = result.needs_condensing.map(([name]) => name).join(", ");
      addToast(`Memory to condense in AGENTS.md: ${names}`);
    }
    for (const warning of result.warnings.slice(0, 3)) addToast(warning);
  } catch (e) {
    addToast(String(e));
  }
}

export async function renameProject(id: string, name: string): Promise<void> {
  try {
    const project = await api.renameProject(id, name);
    if (app.project?.id === id) app.project = project;
    await refreshProjects();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Drop a project from the list. Nothing on disk is touched, and the toast
 * says so — a "remove" next to a folder full of work has to be unambiguous.
 */
export async function forgetProject(id: string): Promise<void> {
  const wasOpen = app.project?.id === id;
  try {
    await api.forgetProject(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  addToast(
    "Removed from the list — the folder, its notes and its chats are untouched on disk.",
  );
  await refreshProjects();
  if (wasOpen) await useProject(null);
}

export async function revealFolder(path?: string): Promise<void> {
  try {
    await api.reveal(path);
  } catch (e) {
    addToast(String(e));
  }
}

// ---- the docspace ----

export function showNote(scope: NoteScope, name: string): void {
  app.openNote = { scope, name };
  app.view = "note";
  // Opening a note is the editor, not the review; `reviewProposal` sets
  // the review back after calling this.
  app.proposalReview = null;
  // So the list highlighting the open note is the list on screen — this is
  // also reachable from the welcome page and from the graph, where the
  // sidebar may be on Chats.
  app.leftTab = "notes";
}

export function showGraph(): void {
  app.view = "graph";
  app.openNote = null;
  app.leftTab = "notes";
}

export function closeNote(): void {
  app.view = "chat";
  app.openNote = null;
  app.proposalReview = null;
  // Back to whoever opened it. One function for every way out — Save,
  // ← Chat — so no route can strand `noteFrom`.
  if (app.noteFrom === "rail") {
    app.railScrollTo = "model";
    app.showRail = true;
  } else if (app.noteFrom === "settings") {
    app.settingsOpenOn = "models";
    app.showSettings = true;
  }
  app.noteFrom = null;
}

/**
 * The model a chat is (or would be) on, for its instruction file: the id
 * the rail sends, or the one the connection resolved when the rail sent
 * none. On the Claude Code engine it is the alias — the file is named after
 * what the rail sends, since the CLI's resolved id arrives with the first
 * turn, after the prompt is built — and null on the CLI's own default,
 * which has no name to file under.
 */
export function currentModelId(): string | null {
  const d = app.draft;
  if (d.engine === "claude-code") return d.agentModel.trim() || null;
  return d.model.trim() || app.connection?.model || null;
}

/**
 * Open the editor on a model's instruction file, in place of the popover or
 * Settings; `closeNote` brings that surface back. The sidebar tab is left
 * where it was: the file is not in the Notes list, so switching to it would
 * show a list with nothing highlighted.
 */
export function openModelInstructions(model: string, from: "rail" | "settings"): void {
  const tab = app.leftTab;
  app.showRail = false;
  app.showSettings = false;
  app.noteFrom = from;
  showNote("models", modelInstructionFile(model));
  app.leftTab = tab;
}

export async function saveNote(
  scope: NoteScope,
  name: string,
  content: string,
): Promise<boolean> {
  try {
    await api.saveNote(scope, name, content);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  // The draft that was saved came from a proposal: record it as applied,
  // with the text that was actually saved. After the save and never
  // instead of it — the file was written by the editor's own path above,
  // which is the whole design of proposals.
  const staged = app.stagedProposal;
  if (staged && staged.key === `${scope}:${name}`) {
    app.stagedProposal = null;
    try {
      await api.markApplied(staged.scope, staged.id, content);
    } catch (e) {
      addToast(`saved, but could not file the proposal as applied: ${String(e)}`);
    }
  }
  await refreshNotes();
  await refreshProjects();
  // The always-loaded files are read once, when the connection's preamble
  // is assembled — so a saved edit would otherwise sit unread until the
  // next connect. Re-connect the live connection, the same rule as editing
  // the active prompt-library entry. Nothing is done when there is no
  // connection to refresh. A model's file is one of them: saved for the
  // model the chat is on it takes effect now, and for another model the
  // re-connect is a no-op on the prompt, which is cheaper than working out
  // which it was.
  if (
    (scope === "instructions" || scope === "memory" || scope === "models") &&
    app.connection
  ) {
    await applyDraft();
  }
  return true;
}

export async function deleteNote(scope: NoteScope, name: string): Promise<void> {
  try {
    await api.deleteNote(scope, name);
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (app.openNote?.scope === scope && app.openNote.name === name) closeNote();
  await refreshNotes();
  await refreshProjects();
}

// ---- proposals: the dream's suggested edits to the fixed files ----

/** The one file each proposal scope names. */
const AGENTS_MD = "AGENTS.md";

/**
 * Open `NoteView` on a fixed file in proposal mode: the newest pending
 * proposal for that scope as a diff against the file, with Load into
 * editor, Dismiss and Keep for later. Nothing happens to the file or the
 * buffer until Load is pressed.
 */
export function reviewProposal(scope: ProposalScope, id?: string): void {
  const list = app.proposals[scope];
  const entry = (id ? list.find((e) => e.id === id) : undefined) ?? list[0];
  if (!entry) return;
  showNote(scope, AGENTS_MD);
  app.proposalReview = { scope, entry };
}

/**
 * The draft-mirror rule the editor applies on every keystroke: the buffer
 * is a draft while it differs from the saved text, and no draft once it
 * matches again — so a Revert (buffer back to saved) leaves nothing behind.
 * A function rather than an effect body so the rule can be tested: it is
 * what makes a loaded proposal a draft and not a save.
 */
export function mirrorDraft(key: string, text: string, saved: string): void {
  if (text !== saved) app.noteDrafts[key] = text;
  else delete app.noteDrafts[key];
}

/**
 * Put a proposal's text in the editor as a draft. The file is untouched:
 * `noteDrafts` is where unsaved text lives, the ● draft marker and Revert
 * follow from it, and the only way the text reaches the file is the same
 * Save any edit takes — which, seeing `stagedProposal`, records the
 * proposal as applied afterwards.
 */
export function stageProposal(scope: ProposalScope, entry: ProposalEntry, saved: string): void {
  const key = `${scope}:${AGENTS_MD}`;
  mirrorDraft(key, entry.proposal.text, saved);
  app.stagedProposal = { key, scope, id: entry.id };
  app.proposalReview = null;
}

/** The buffer went back to the saved text: the proposal is no longer what
 *  a Save would apply. The proposal itself stays pending. */
export function unstageProposal(key: string): void {
  if (app.stagedProposal?.key === key) app.stagedProposal = null;
}

/** Turn a proposal down. Confirmed by the caller first; the backend moves
 *  the file aside rather than deleting it. */
export async function dismissProposal(scope: ProposalScope, id: string): Promise<boolean> {
  try {
    await api.dismissProposal(scope, id);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  if (app.proposalReview?.entry.id === id) app.proposalReview = null;
  unstageProposal(`${scope}:${AGENTS_MD}`);
  await refreshProposals();
  return true;
}

/** A provider the backend can actually construct a client for right now. */
export function usable(p: ProviderInfo): boolean {
  // openai-chat can point at a local server without an API key.
  return p.available || (p.kind === "openai-chat" && app.draft.baseUrl.trim() !== "");
}

/** Connect on launch: last-used provider if still usable, else the first that is. */
async function autoConnect(): Promise<void> {
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

/** (Re)connect with the rail's current settings. Called on every rail change. */
export async function applyDraft(): Promise<void> {
  const d = app.draft;
  if (app.busy || app.connecting) return;
  if (d.engine === "claude-code") return applyAgentDraft();
  if (!d.provider) return;
  sanitizeThinking(d); // a saved draft may hold a mode this target rejects
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
    };
    // The backend is the authority on which project a connection is filed
    // under: an open project overrides the workspace the rail saved, so
    // reading it back is what keeps the two from disagreeing.
    app.project = res.project ?? null;
    if (!d.model.trim()) d.model = res.model; // backend resolved the default
    saveLastConnection({ ...d });
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
async function applyAgentDraft(): Promise<void> {
  const d = app.draft;
  app.connecting = true;
  app.connectError = null;
  try {
    const res = await api.connectAgent({
      binary: d.agentBinary.trim() || undefined,
      model: d.agentModel.trim() || undefined,
      workspace: d.workspace.trim() || undefined,
      tools: d.tools,
      approval: d.approval,
      safeMode: d.agentSafeMode,
      budget: d.agentBudget > 0 ? d.agentBudget : undefined,
      system: d.system.trim() || undefined,
      preamble: d.preamble,
    });
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
    };
    app.project = res.project ?? null;
    saveLastConnection({ ...d });
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
  await applyDraft();
}

// ---- nightshift ----

export function showNightshift(): void {
  app.view = "nightshift";
  app.leftTab = "nightshift";
  app.openNote = null;
  void refreshNightshift();
}

export function closeNightshift(): void {
  app.view = "chat";
  if (app.leftTab === "nightshift") app.leftTab = "chats";
}

/**
 * Re-read every project's Nightshift row, then point the surface at the
 * open project. There is no separate Nightshift selection any more: the
 * page shows the project in the top-left chip (Swaraag's round-2 point 12
 * — two project lists with two selections was the confusing part), so this
 * always re-selects `app.project`, which re-watches its root and re-reads
 * the Review screens.
 */
export async function refreshNightshift(): Promise<void> {
  app.nightshift.loading = true;
  app.nightshift.error = null;
  try {
    app.nightshift.rows = await api.nightshiftProjects();
    app.nightshift.defaultRunner = await api.nightshiftDefaultRunner();
  } catch (e) {
    app.nightshift.error = String(e);
    addToast(String(e));
    return;
  } finally {
    app.nightshift.loading = false;
  }
  await selectNightshiftProject(app.project?.id ?? null);
}

/**
 * Keep the Nightshift surface on the open project. Called wherever
 * `app.project` can change (`refreshProjects` runs after every open, create
 * and import); a no-op when nothing moved, so the frequent refreshes cost
 * nothing.
 */
export async function syncNightshiftProject(): Promise<void> {
  const id = app.project?.id ?? null;
  if (id === app.nightshift.selected) return;
  // A project registered a moment ago (New project…, the importer) is not in
  // `rows` yet, and selecting an unknown id dead-ends on "not in the project
  // list yet" until the nav button re-reads the rows (review F8). Re-read
  // them here instead; refreshNightshift re-selects the open project itself.
  if (id && !app.nightshift.rows.some((r) => r.id === id)) {
    await refreshNightshift();
    return;
  }
  await selectNightshiftProject(id);
}

/** Bumped by every selectNightshiftProject; a call that finds itself
 *  superseded after its awaits stops rather than overwriting the newer one
 *  (review F9: two switches inside one unwatch round trip). */
let selectSeq = 0;

/** Re-read one row in place — what a `nightshift-change` event triggers. */
async function refreshNightshiftRow(id: string): Promise<void> {
  try {
    const fresh = await api.nightshiftProject(id);
    const i = app.nightshift.rows.findIndex((r) => r.id === id);
    if (i >= 0) app.nightshift.rows[i] = fresh;
    else app.nightshift.rows.push(fresh);
  } catch {
    // The row it replaces is left as-is; a live watch failing quietly here
    // is better than a toast on every filesystem hiccup.
  }
}

/**
 * Point the surface at a project — the open one, in practice (see
 * `syncNightshiftProject`) — or at nothing. Unwatches the previous root,
 * drops everything read for it, watches the new one when it has a contract,
 * and re-reads the Review screens.
 */
export async function selectNightshiftProject(id: string | null): Promise<void> {
  const seq = ++selectSeq;
  const prev = app.nightshift.selected;
  if (prev && prev !== id) {
    try {
      await api.nightshiftUnwatch(prev);
    } catch {
      // Best-effort: an unwatch failing leaves an extra watch running, not a
      // broken UI.
    }
  }
  if (seq !== selectSeq) return;
  if (prev !== id) {
    // Everything below is about the previous project.
    app.nightshift.mornings = [];
    app.nightshift.shifts = [];
    app.nightshift.selectedShift = null;
    app.nightshift.log = "";
    app.nightshift.diff = null;
    app.nightshift.blockers = null;
    app.nightshift.selectedBlocker = null;
    app.nightshift.notes = [];
    app.nightshift.selectedNote = null;
    app.nightshift.noteText = null;
    app.nightshift.items = null;
    app.nightshift.selectedItem = null;
    app.nightshift.planDraft = null;
    app.nightshift.planPath = null;
    app.nightshift.pending = null;
    app.nightshift.usage = null;
    app.nightshift.interview = null;
    app.nightshift.interviewDraft = { open: false, idea: "", reply: "" };
    app.nightshift.editDrafts = {};
  }
  app.nightshift.selected = id;
  // Only a root can be watched; a project without a contract (the Enable
  // card) has nothing to subscribe to, and asking would toast an error.
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (id && row?.nightshift) {
    try {
      await api.nightshiftWatch(id);
    } catch (e) {
      addToast(String(e));
    }
  }
  if (seq !== selectSeq) return;
  await loadNightshiftReview();
}

/**
 * Everything the Review screens show for the selected project: the newest
 * morning page and the list of pages, the shifts, the blockers. Read in one
 * go rather than per tab so the tab counts in the header are right before a
 * tab is opened.
 */
export async function loadNightshiftReview(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) {
    app.nightshift.morning = null;
    app.nightshift.mornings = [];
    app.nightshift.shifts = [];
    app.nightshift.blockers = null;
    app.nightshift.notes = [];
    app.nightshift.items = null;
    return;
  }
  await Promise.all([
    loadNightshiftMorning(),
    loadMornings(),
    loadShifts(),
    loadBlockers(),
    loadNotes(),
    loadItems(),
    // The backend holds a timer across project switches and webview
    // reloads; the chip must show it wherever the surface lands, not only
    // once the Plan screen mounts (review F3).
    loadPendingLaunch(),
  ]);
}

/**
 * What a change event re-reads. The runner writes `status.json` many times a
 * shift and `run.log` continuously, so only the lists the paths touch are
 * re-read; the morning page always is, since the newest one is what the
 * header's "new" pill hangs on.
 */
async function refreshNightshiftReview(paths: string[]): Promise<void> {
  const touches = (prefix: string) => paths.some((p) => p.startsWith(prefix));
  const jobs: Promise<void>[] = [loadNightshiftMorning()];
  if (touches("mornings/")) jobs.push(loadMornings());
  if (touches("shifts/")) jobs.push(loadShifts().then(() => loadShiftLog()).then(refreshLiveDiff));
  if (touches("blockers/")) jobs.push(loadBlockers());
  if (touches("notes/")) jobs.push(loadNotes());
  if (touches("backlog/")) jobs.push(loadItems());
  await Promise.all(jobs);
}

/**
 * Runs → Changes for a live shift is `head_at_start..HEAD`, which grows with
 * every unit commit; showDiff reads it once and skips a repeat request for
 * the same key, so a running shift's diff went stale (review F10). Re-read
 * it when the shift list changes and the shown diff is a live shift's.
 */
let liveDiffCommits = "";
async function refreshLiveDiff(): Promise<void> {
  const d = app.nightshift.diff;
  if (!d || d.kind !== "shift" || d.loading) return;
  const shift = app.nightshift.shifts.find((s) => s.id === d.key);
  if (!shift?.live) return;
  // `shifts/` changes on every run.log line; only a landed unit moves HEAD.
  const commits = (shift.status?.units ?? []).map((u) => u.commit ?? "").join(",");
  if (commits === liveDiffCommits) return;
  liveDiffCommits = commits;
  app.nightshift.diff = null;
  await showDiff("shift", d.key);
}

export async function loadMornings(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.mornings = await api.nightshiftMornings(id);
  } catch (e) {
    addToast(String(e));
  }
}

/** Open a page by name, or the newest with `null`. Opening marks it read. */
export async function openMorning(name: string | null): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.morning = await api.nightshiftMorning(id, name ?? undefined);
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (app.nightshift.morning) markMorningRead(app.nightshift.morning.name);
}

export function morningIsRead(projectId: string, name: string): boolean {
  return (app.nightshift.read[projectId] ?? []).includes(name);
}

export function markMorningRead(name: string): void {
  const id = app.nightshift.selected;
  if (!id) return;
  const list = app.nightshift.read[id] ?? [];
  if (list.includes(name)) return;
  app.nightshift.read[id] = [...list, name];
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(app.nightshift.read));
  } catch {
    // best-effort
  }
}

export async function loadShifts(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    const shifts = await api.nightshiftShifts(id);
    // Newest first: ids are timestamps, so the string order is the time order.
    shifts.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    app.nightshift.shifts = shifts;
  } catch (e) {
    addToast(String(e));
    return;
  }
  const still = app.nightshift.shifts.some(
    (s) => s.id === app.nightshift.selectedShift,
  );
  if (!still) {
    app.nightshift.selectedShift = app.nightshift.shifts[0]?.id ?? null;
    app.nightshift.diff = null;
    await loadShiftLog();
  }
}

/** The newest shift's status — what the header's state chip reads. */
export function latestShift(): ShiftSummary | null {
  return app.nightshift.shifts[0] ?? null;
}

export async function selectShift(id: string | null): Promise<void> {
  if (app.nightshift.selectedShift === id) return;
  app.nightshift.selectedShift = id;
  app.nightshift.diff = null;
  await loadShiftLog();
}

export async function loadShiftLog(): Promise<void> {
  const id = app.nightshift.selected;
  const shift = app.nightshift.selectedShift;
  if (!id || !shift) {
    app.nightshift.log = "";
    return;
  }
  try {
    app.nightshift.log = await api.nightshiftShiftLog(id, shift);
  } catch (e) {
    app.nightshift.log = `(could not read run.log: ${String(e)})`;
  }
}

/** Show one unit's commit, or the whole shift's `head_at_start..HEAD`. */
export async function showDiff(
  kind: "unit" | "shift",
  key: string,
): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  const cur = app.nightshift.diff;
  if (cur && cur.kind === kind && cur.key === key && !cur.error) return;
  app.nightshift.diff = { kind, key, text: "", loading: true, error: null };
  try {
    const text =
      kind === "unit"
        ? await api.nightshiftDiff(id, key)
        : await api.nightshiftShiftDiff(id, key);
    // Still the one asked for? A slow read for a diff nobody is looking at
    // any more must not overwrite the one they are.
    const now = app.nightshift.diff;
    if (now && now.kind === kind && now.key === key) {
      app.nightshift.diff = { kind, key, text, loading: false, error: null };
    }
  } catch (e) {
    const now = app.nightshift.diff;
    if (now && now.kind === kind && now.key === key) {
      app.nightshift.diff = {
        kind,
        key,
        text: "",
        loading: false,
        error: String(e),
      };
    }
  }
}

export async function loadBlockers(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.blockers = await api.nightshiftBlockers(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const list = app.nightshift.blockers.blockers;
  const still = list.some((b) => b.id === app.nightshift.selectedBlocker);
  if (!still) {
    // Open first, as the list is shown.
    const first = list.find((b) => b.status === "open") ?? list[0];
    app.nightshift.selectedBlocker = first?.id ?? null;
  }
}

export function selectBlocker(id: string): void {
  app.nightshift.selectedBlocker = id;
}

// ---- Start: backlog and plan (3.6, 3.7) ----

/** Re-read `backlog/*` and `order.json` — what both Start screens list. */
export async function loadItems(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.items = await api.nightshiftItems(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const list = app.nightshift.items.items;
  const still = list.some((i) => i.id === app.nightshift.selectedItem);
  if (!still) app.nightshift.selectedItem = list[0]?.id ?? null;
}

/** Select an item for the Backlog screen's main column. */
export function selectItem(id: string): void {
  app.nightshift.selectedItem = id;
}

/** Scaffold a new item, re-read the backlog, select it. Returns the id. */
export async function newItem(title: string, kind: string): Promise<string | null> {
  const id = app.nightshift.selected;
  if (!id) return null;
  try {
    const created = await api.nightshiftNewItem(id, title, kind);
    await loadItems();
    app.nightshift.selectedItem = created;
    return created;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

// ---- the intake interview (item 005) ----

/** Begin an interview with the idea; the interviewer's first questions
 *  stream in. Replaces one in progress. */
export async function startInterview(idea: string): Promise<boolean> {
  const id = app.nightshift.selected;
  if (!id) return false;
  app.nightshift.interview = {
    messages: [{ role: "user", text: idea }],
    streaming: "",
    busy: true,
    model: null,
  };
  try {
    const view = await api.nightshiftInterviewStart(id, idea);
    if (app.nightshift.interview) {
      app.nightshift.interview.messages = view.messages;
      app.nightshift.interview.model = view.model;
    }
    return true;
  } catch (e) {
    addToast(String(e));
    if (app.nightshift.interview) app.nightshift.interview.messages = [{ role: "user", text: idea }];
    return false;
  } finally {
    if (app.nightshift.interview) app.nightshift.interview.busy = false;
  }
}

export async function sendInterview(text: string): Promise<void> {
  const id = app.nightshift.selected;
  const iv = app.nightshift.interview;
  if (!id || !iv || iv.busy) return;
  iv.messages.push({ role: "user", text });
  iv.busy = true;
  try {
    const view = await api.nightshiftInterviewSend(id, text);
    iv.messages = view.messages;
    iv.model = view.model;
  } catch (e) {
    // The backend dropped the refused turn; the pane matches, and the text
    // goes back so a rephrase does not start from nothing.
    iv.messages = iv.messages.filter((m, i) => !(i === iv.messages.length - 1 && m.role === "user" && m.text === text));
    iv.lastRefused = text;
    addToast(String(e));
  } finally {
    iv.busy = false;
  }
}

/** What the backend holds, for a Backlog screen that comes back mid-interview. */
export async function loadInterview(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    const view = await api.nightshiftInterviewState(id);
    app.nightshift.interview = view
      ? { messages: view.messages, streaming: "", busy: false, model: view.model }
      : null;
  } catch {
    // An older backend without the command: no interview to show.
    app.nightshift.interview = null;
  }
}

export async function cancelInterview(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftInterviewCancel(id);
  } catch (e) {
    addToast(String(e));
  }
  app.nightshift.interview = null;
}

/** Close the interview: the item is written with the transcript beside it,
 *  the backlog re-read, the new item selected. Returns its id. */
export async function writeInterviewItem(): Promise<string | null> {
  const id = app.nightshift.selected;
  const iv = app.nightshift.interview;
  if (!id || !iv || iv.busy) return null;
  iv.busy = true;
  try {
    const written = await api.nightshiftInterviewWrite(id);
    app.nightshift.interview = null;
    await loadItems();
    app.nightshift.selectedItem = written.id;
    addToast(`Item ${written.id} written — ${written.title}`);
    return written.id;
  } catch (e) {
    addToast(String(e));
    iv.busy = false;
    return null;
  }
}

/** Delete an item — to backlog/trash/, never unlinked — then re-read. */
export async function deleteItem(id: string): Promise<string | null> {
  const proj = app.nightshift.selected;
  if (!proj) return null;
  try {
    const went = await api.nightshiftDeleteItem(proj, id);
    delete app.nightshift.editDrafts[id];
    await loadItems();
    if (app.nightshift.selectedItem === id) app.nightshift.selectedItem = null;
    addToast(`Item ${id} moved to ${went}`);
    return went;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** Save an item's edited text, then re-read the backlog. */
export async function saveItem(itemId: string, text: string): Promise<boolean> {
  const id = app.nightshift.selected;
  if (!id) return false;
  try {
    await api.nightshiftWriteItem(id, itemId, text);
    delete app.nightshift.editDrafts[itemId];
    await loadItems();
    return true;
  } catch (e) {
    addToast(String(e));
    return false;
  }
}

/**
 * Rewrite `backlog/order.json` to `order`, then re-read the backlog so the
 * rows and their position numbers reflect it. Refused by the backend while a
 * shift is live — callers disable the drag in that case rather than relying
 * on this to fail quietly.
 */
export async function reorderItems(order: string[]): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftSetOrder(id, order);
  } catch (e) {
    addToast(String(e));
    return;
  }
  await loadItems();
}

/**
 * A fresh plan the way `shiftctl plan synth` would write it, seeded from the
 * project's current backlog and order — for the Plan screen to start
 * editing locally. Writes nothing; every subsequent edit (selection,
 * reorder, kind, bounds) mutates `planDraft` in place until Launch.
 */
export async function synthPlan(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) return;
  try {
    app.nightshift.planDraft = await api.nightshiftSynthPlan(id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Launch tonight: write `planDraft` to `shifts/<id>/plan.json`, then launch
 * the runner on it. Both are refused in cases the backend's error already
 * names (a live shift, a plan that already exists, a non-macOS host) — those
 * surface as toasts rather than being predicted here.
 */
export async function writeAndLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  const plan = app.nightshift.planDraft;
  if (!id || !plan) return;
  app.nightshift.launching = true;
  try {
    const path = await api.nightshiftWritePlan(id, plan);
    app.nightshift.planPath = path;
    const pid = await api.nightshiftLaunch(id, path);
    addToast(`Launched shift ${plan.shift_id} — pid ${pid}`);
    await Promise.all([refreshNightshiftRow(id), loadNightshiftReview()]);
    // Runs keeps whichever shift was last looked at; the one just launched
    // is the one worth following (first launch from the app, 2026-09-12:
    // Runs opened on yesterday's shift while tonight's ran).
    await selectShift(plan.shift_id);
  } catch (e) {
    addToast(String(e));
  } finally {
    app.nightshift.launching = false;
  }
}

/**
 * Hold the draft and launch it at `fireAtMs` (the Start field's "when usage
 * resets" and "at a time"). The backend keeps the timer; the app shows it as
 * `app.nightshift.pending` and, in the state chip, "launches at …". Nothing
 * is written until it fires.
 */
export async function scheduleLaunch(fireAtMs: number): Promise<void> {
  const id = app.nightshift.selected;
  const plan = app.nightshift.planDraft;
  if (!id || !plan) return;
  app.nightshift.launching = true;
  try {
    app.nightshift.pending = await api.nightshiftScheduleLaunch(id, plan, fireAtMs);
    addToast(`Shift held — launches ${clockOf(fireAtMs)}`);
  } catch (e) {
    addToast(String(e));
  } finally {
    app.nightshift.launching = false;
  }
}

export async function cancelLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    await api.nightshiftCancelLaunch(id);
    app.nightshift.pending = null;
    addToast("Scheduled launch cancelled");
  } catch (e) {
    addToast(String(e));
  }
}

/** What the backend is holding for the selected project, if anything. */
export async function loadPendingLaunch(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.pending = await api.nightshiftPendingLaunch(id);
  } catch {
    // An older backend without the command: no pending launch to show.
    app.nightshift.pending = null;
  }
}

/** The runner's usage probe, for the Start field. A probe that cannot
 *  answer leaves `usage` null and the field says so. */
export async function loadUsage(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.usage = await api.nightshiftUsage(id);
  } catch {
    app.nightshift.usage = null;
  }
}

/** `at 05:10` or `at 05:10 tomorrow`, local time, for toasts and the chip. */
export function clockOf(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = d.toDateString() === now.toDateString();
  return `at ${hh}:${mm}${sameDay ? "" : " tomorrow"}`;
}

/** Re-read the flat file listing under `notes/` — what the Notes screen's
 *  tree is built from. */
export async function loadNotes(): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  try {
    app.nightshift.notes = await api.nightshiftNotes(id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Open a file by root-relative path in the Notes screen's main column. Not
 * limited to paths under `notes/` — `nightshift_read_file` reads anything
 * under the contract root, which is how "Open in Notes" on the Morning
 * screen can open `mornings/<name>` even though that file is not in the
 * `notes` tree.
 */
export async function openNote(path: string): Promise<void> {
  const id = app.nightshift.selected;
  if (!id) return;
  app.nightshift.selectedNote = path;
  app.nightshift.noteText = null;
  try {
    const text = await api.nightshiftReadFile(id, path);
    // Still the one asked for? A slow read for a note no longer selected
    // must not overwrite the current one.
    if (app.nightshift.selectedNote === path) app.nightshift.noteText = text;
  } catch (e) {
    if (app.nightshift.selectedNote === path) {
      app.nightshift.noteText = null;
      addToast(String(e));
    }
  }
}

/** Write `## Answer` and flip the blocker to `answered`; re-read the list. */
export async function answerBlocker(id: string, answer: string): Promise<boolean> {
  const project = app.nightshift.selected;
  if (!project) return false;
  try {
    await api.nightshiftAnswerBlocker(project, id, answer);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await loadBlockers();
  return true;
}

export async function revertPreview(
  shiftId: string,
): Promise<RevertPreview | null> {
  const project = app.nightshift.selected;
  if (!project) return null;
  try {
    return await api.nightshiftRevertPreview(project, shiftId);
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** The confirmed revert. The caller has shown the preview and been told yes. */
export async function revertShift(
  shiftId: string,
): Promise<RevertPreview | null> {
  const project = app.nightshift.selected;
  if (!project) return null;
  try {
    const done = await api.nightshiftRevert(project, shiftId, true);
    addToast(`Reverted to ${done.target.slice(0, 7)} — ${done.commits} commits discarded`);
    await Promise.all([loadShifts(), refreshNightshiftRow(project)]);
    app.nightshift.diff = null;
    return done;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/** The selected project's newest morning page, or null when it has none. */
export async function loadNightshiftMorning(): Promise<void> {
  const id = app.nightshift.selected;
  const row = app.nightshift.rows.find((r) => r.id === id);
  if (!id || !row?.nightshift) {
    app.nightshift.morning = null;
    return;
  }
  try {
    app.nightshift.morning = await api.nightshiftMorning(id);
  } catch (e) {
    app.nightshift.morning = null;
    addToast(String(e));
  }
}

/**
 * **Enable Nightshift** on a project: scaffold `<workspace>/nightshift/` and
 * select it. The scaffold's notes are its caveats (a missing git repo, a
 * runner that is not installed) — surfaced as toasts since there is nowhere
 * in the list for them to live once the row replaces itself.
 */
export async function enableNightshift(
  id: string,
  runner?: string,
): Promise<void> {
  let row: NightshiftRow;
  let notes: string[];
  try {
    [row, notes] = await api.nightshiftEnable(id, undefined, runner);
  } catch (e) {
    addToast(String(e));
    return;
  }
  const i = app.nightshift.rows.findIndex((r) => r.id === id);
  if (i >= 0) app.nightshift.rows[i] = row;
  else app.nightshift.rows.push(row);
  for (const note of notes) addToast(note);
  await selectNightshiftProject(id);
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

export async function refreshSessions(): Promise<void> {
  try {
    app.sessions = await api.listSessions();
  } catch {
    // sidebar refresh is best-effort
  }
}

export async function newSession(): Promise<void> {
  if (app.busy) return;
  try {
    const { id } = await api.newSession();
    app.activeSessionId = id;
    app.events = [];
    app.error = null;
    app.agentTurn = null;
    closeNote();
    await refreshSessions();
  } catch (e) {
    app.error = String(e);
  }
}

export async function openSession(id: string): Promise<void> {
  if (app.busy) return;
  try {
    app.events = await api.openSession(id);
    app.activeSessionId = id;
    app.error = null;
    // The plan window and estimate belong to the chat you just left.
    app.agentTurn = null;
    closeNote();
  } catch (e) {
    app.error = String(e);
  }
}

/** Compact the active session: earlier turns collapse into a summary. */
export async function compactSession(): Promise<void> {
  if (!app.connection || app.busy) return;
  app.busy = true;
  app.error = null;
  try {
    const res = await api.compact();
    if (res.interrupted) {
      addToast("compaction cancelled — session unchanged");
    } else {
      addToast("session compacted");
      app.events = await api.transcript();
      void maybeAutoDream();
    }
  } catch (e) {
    app.error = String(e);
  } finally {
    app.busy = false;
    void refreshSessions();
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (app.busy) return;
  try {
    await api.deleteSession(id);
    if (id === app.activeSessionId) {
      app.activeSessionId = null;
      app.events = [];
    }
  } catch (e) {
    addToast(String(e));
  }
  await refreshSessions();
}

export async function send(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
): Promise<void> {
  if (!app.connection || app.busy) return;
  if (app.connection.engine === "claude-code") {
    // Claude Code takes a prompt on argv and reads no attachments from us.
    // Refusing loudly rather than sending the caption alone: a question
    // about an image the model never received gets a confident answer about
    // nothing, which is the failure mode worth spending a toast on.
    if (images.length > 0 || documents.length > 0) {
      addToast("Claude Code takes text only — attachments are not sent on this engine");
      return;
    }
    return sendAgent(text);
  }
  app.error = null;
  app.events.push({
    event: "user_message",
    text,
    // Mirror the backend's omission rather than logging an empty array, so the
    // optimistic entry and the re-synced one project identically.
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    at: new Date().toISOString(),
  });
  app.live = { segments: [] };
  app.liveUsage = null;
  app.busy = true;
  try {
    await api.send(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
    );
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    // The trailing assistant message now carries the same reading.
    app.liveUsage = null;
    // The turn is over: anything still parked was answered by the backend
    // (or died with the turn), so the prompts can no longer decide anything.
    app.pendingApprovals = [];
    app.busy = false;
    try {
      app.events = await api.transcript();
      // Sessions are created lazily on first send; pick up the id.
      const first = app.events[0];
      if (first && first.event === "session_created") {
        app.activeSessionId = first.id;
      }
    } catch {
      // keep the locally-built view if re-sync fails
    }
    void refreshSessions();
    // The turn may have written to the docspace, and the sidebar showing a
    // note the model just left is the visible half of "shared knowledge".
    void refreshNotes();
    // And it may have remembered something; the Dream badge follows. The
    // turn was logged, so the Capture count follows too.
    void refreshDreamStatus();
    void refreshCaptureStatus();
    if (compactedThisTurn) {
      compactedThisTurn = false;
      void maybeAutoDream();
    }
  }
}

/**
 * One turn on the agent engine.
 *
 * The same shape as `send` down to the re-sync, and deliberately so: the
 * transcript is a projection of the log either way, and the backend records
 * an agent turn in the same events a provider turn writes. What differs is
 * what comes back — a plan window and an estimate instead of a stop reason
 * and a bill — and that the window's own approval prompts never fire, since
 * the gate belongs to whoever owns the loop.
 */
async function sendAgent(text: string): Promise<void> {
  app.error = null;
  app.events.push({ event: "user_message", text, at: new Date().toISOString() });
  app.live = { segments: [] };
  app.liveUsage = null;
  app.busy = true;
  try {
    const res = await api.sendAgent(text);
    app.agentTurn = res;
    // The CLI resolves an alias to a real model id, which is the first
    // moment a context window can be looked up at all: `sonnet` is in no
    // limits table and a guessed denominator would promise headroom nobody
    // verified.
    if (app.connection && res.context_limit != null) {
      app.connection.contextLimit = res.context_limit;
    }
    if (app.connection && res.model) app.connection.model = res.model;
    for (const notice of res.notices) addToast(notice);
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    app.liveUsage = null;
    app.busy = false;
    try {
      app.events = await api.transcript();
      const first = app.events[0];
      if (first && first.event === "session_created") {
        app.activeSessionId = first.id;
      }
    } catch {
      // keep the locally-built view if re-sync fails
    }
    void refreshSessions();
    void refreshNotes();
  }
}

export async function cancelTurn(): Promise<void> {
  try {
    await api.cancel();
    // Cancelling refuses every parked prompt on the backend, so they stop
    // being answerable — but only once the call actually lands. Clearing
    // them before that could strand a still-running turn with no prompt.
    app.pendingApprovals = [];
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Answer one approval prompt. Dropping it from the list before the call
 * makes a double-click a no-op instead of a second, unanswerable decision.
 */
export async function resolveApproval(
  id: string,
  name: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<void> {
  const i = app.pendingApprovals.findIndex((r) => r.id === id);
  if (i < 0) return;
  app.pendingApprovals.splice(i, 1);
  try {
    await api.approveCall(id, name, decision, reason);
  } catch (e) {
    addToast(String(e));
  }
}

let toastSeq = 0;

export function addToast(text: string): void {
  const id = ++toastSeq;
  app.toasts.push({ id, text });
  setTimeout(() => {
    const i = app.toasts.findIndex((t) => t.id === id);
    if (i >= 0) app.toasts.splice(i, 1);
  }, 5000);
}

/** Mark a trailing in-progress thinking segment as complete (collapses its pill). */
function closeThinking(segments: Segment[]): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === "thinking") last.done = true;
}

function applyTurnEvent(ev: TurnEvent): void {
  if (ev.type === "usage") {
    app.liveUsage = ev.usage;
    return;
  }
  if (ev.type === "compacted") {
    // The Compaction event itself arrives with the post-turn transcript
    // re-sync and renders there; this only makes the moment visible, matching
    // what the manual compact button reports.
    addToast("context compacted by the model");
    // Noted here, acted on when `send` settles: a dream that started while
    // the turn was still re-syncing would race the transcript for nothing.
    compactedThisTurn = true;
    if (app.live) {
      closeThinking(app.live.segments);
      app.live.segments.push({
        kind: "notice",
        text: "context compacted — earlier turns replaced by a summary",
      });
      app.liveVersion++;
    }
    return;
  }
  if (ev.type === "tool_denied" || ev.type === "tool_result") {
    // The gate answered this one, whoever decided it — a prompt still on
    // screen for it (cancellation denies server-side) can no longer be used.
    const i = app.pendingApprovals.findIndex((r) => r.id === ev.tool_use_id);
    if (i >= 0) app.pendingApprovals.splice(i, 1);
  }
  if (!app.live) return;
  const segments = app.live.segments;
  const last = segments[segments.length - 1];
  switch (ev.type) {
    case "text_delta":
      if (last && last.kind === "text") {
        last.text += ev.text;
      } else {
        closeThinking(segments);
        segments.push({ kind: "text", text: ev.text });
      }
      break;
    case "thinking_delta":
      if (last && last.kind === "thinking" && !last.done) {
        last.text += ev.text;
      } else {
        segments.push({ kind: "thinking", text: ev.text, done: false });
      }
      break;
    case "redacted_thinking":
      closeThinking(segments);
      segments.push({ kind: "redacted" });
      break;
    case "tool_call":
      closeThinking(segments);
      segments.push({
        kind: "tool",
        call: { id: ev.id, name: ev.name, input: ev.input, result: null },
      });
      break;
    case "tool_result":
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.kind === "tool" && seg.call.id === ev.tool_use_id) {
          seg.call.result = { content: ev.content, is_error: ev.is_error };
          break;
        }
      }
      break;
    case "tool_denied":
      // No tool_result follows a denial, so the call would otherwise render
      // as in-flight until the post-turn re-sync replaced the whole message.
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.kind === "tool" && seg.call.id === ev.tool_use_id) {
          seg.call.denied = true;
          seg.call.result = { content: ev.reason, is_error: true };
          break;
        }
      }
      break;
    case "round_limit":
      closeThinking(segments);
      segments.push({
        kind: "notice",
        text: `tool round limit reached (${ev.rounds} rounds)`,
      });
      break;
    default:
      // Unknown turn-event types are ignored by contract.
      break;
  }
  app.liveVersion++;
}

const DENIAL_PREFIX = "The user refused permission to run ";
const DENIAL_REASON = "They said: ";

/**
 * Recognize a refused call in a re-synced `tool_result`, returning its
 * reason ("" when none was given) or null if it is an ordinary failure.
 *
 * A denial is logged as a plain error result because that is what the model
 * must read it as, so the message itself is the only marker. Reading it back
 * is what keeps "you said no" from rendering as "the tool crashed" once the
 * live buffer is replaced; a message that doesn't match still renders as the
 * error it already was.
 */
export function denialReason(content: string, isError: boolean): string | null {
  if (!isError || !content.startsWith(DENIAL_PREFIX)) return null;
  const line = content.split("\n").find((l) => l.startsWith(DENIAL_REASON));
  return line ? line.slice(DENIAL_REASON.length) : "";
}

/**
 * The model's current task list, projected from the log exactly the way
 * `Session::todos()` projects it in the core: latest snapshot wins, and a
 * compaction clears it — the summary supersedes the plan that produced it,
 * so a stale list must not outlive the work it described.
 */
export function currentTodos(): TodoItem[] {
  const live = liveFlags(app.events);
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = app.events[i];
    if (e.event === "todo_state") return e.todos;
    if (e.event === "compaction") return [];
  }
  return [];
}

/**
 * Which events still count, after every `rewind` marker in the log.
 *
 * Mirrors `Session::live_flags` exactly, and has to: the backend projects the
 * model's view from its copy and the transcript is projected from this one,
 * so the two disagreeing means the user is reading a conversation the model
 * is not having. Returned as flags over the full array rather than a filtered
 * list because the superseded events are still rendered — greyed out, which
 * is the entire reason a rewind supersedes instead of deleting.
 */
export function liveFlags(events: SessionEvent[]): boolean[] {
  const live = events.map(() => true);
  events.forEach((e, i) => {
    if (e.event !== "rewind") return;
    live[i] = false; // the marker is not part of the conversation
    for (let j = e.to; j < i; j++) live[j] = false;
  });
  return live;
}

/**
 * Rewind to the turn at log index `to`.
 *
 * Refused mid-turn: the running turn holds the session and would record its
 * reply after the rewind landed, stitching the turn being undone onto the
 * history it was removed from.
 */
export async function rewindTo(to: number): Promise<void> {
  if (app.busy) return;
  try {
    app.events = await api.rewind(to);
    app.error = null;
  } catch (e) {
    app.error = String(e);
  }
}

/**
 * Tokens the next request will carry as its prefix: the newest round's
 * input plus output. Deliberately not the running total, which counts the
 * prefix once per round and would race past the window while the real
 * context sat half empty.
 */
export function contextUsed(): number | null {
  const u = app.liveUsage ?? lastAssistantUsage();
  return u ? u.input_tokens + u.output_tokens : null;
}

/**
 * What this session has cost so far, in USD.
 *
 * Completed exchanges are read back from the log, where the backend recorded
 * each one at the price in force when it ran — re-pricing them here would
 * restate history whenever a vendor changes a rate, and the log is the source
 * of truth for the same reason the transcript is. The in-flight round is the
 * exception: it has no log entry yet, so it is priced live from the
 * connection's rates and added on, which is the same live-then-log shape the
 * context gauge uses.
 *
 * `complete` is false when some exchange had no price, making `usd` a floor.
 * A session run entirely on an unpriced model is 0, and rendering that as
 * "$0.00" would claim it was free.
 */
export function sessionCost(): { usd: number; complete: boolean } | null {
  let usd = 0;
  let complete = true;
  let any = false;
  for (const e of app.events) {
    if (e.event !== "assistant_message") continue;
    any = true;
    if (typeof e.cost === "number") usd += e.cost;
    else complete = false;
  }
  const live = app.liveUsage;
  const price = app.connection?.price ?? null;
  if (live) {
    any = true;
    if (price) usd += roundCost(live, price);
    else complete = false;
  }
  return any ? { usd, complete } : null;
}

/**
 * Mirrors `Price::cost` on the backend: three disjoint input slices.
 *
 * Exported only so the suite can pin it against its Rust counterpart; nothing
 * outside this module calls it.
 */
export function roundCost(u: Usage, p: Price): number {
  const read = u.cache_read_tokens ?? 0;
  const write = u.cache_write_tokens ?? 0;
  const fresh = Math.max(0, u.input_tokens - read - write);
  const at = (tokens: number, rate: number) => (tokens * rate) / 1e6;
  return (
    at(fresh, p.input) +
    at(read, p.cache_read ?? p.input) +
    at(write, p.cache_write ?? p.input) +
    at(u.output_tokens, p.output)
  );
}

/**
 * Share of the newest round's prompt that was served from cache, or null on a
 * host that reports no caching. Between turns it reads the trailing assistant
 * message, exactly as the context gauge does.
 */
export function cacheHitRate(): number | null {
  const u = app.liveUsage ?? lastAssistantUsage();
  if (!u || u.cache_read_tokens == null || u.input_tokens === 0) return null;
  return u.cache_read_tokens / u.input_tokens;
}

function lastAssistantUsage(): Usage | null {
  // Live events only: the gauge describes the prefix the *next* request will
  // carry, and a rewound turn is not in it. Cost is the deliberate opposite —
  // it sums everything, because rewinding does not refund.
  const live = liveFlags(app.events);
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = app.events[i];
    if (e.event === "assistant_message") return e.usage;
  }
  return null;
}
