import { tick } from "svelte";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import {
  carryReadOrder,
  firstMessage,
  handoff,
  noteAgentTurnEnd,
  readOrder,
  resetHandoff,
} from "./handoff.svelte";
import { suggestions } from "./suggestions.svelte";
import { isMac } from "./platform";
import { UNFILED, draftKey, enqueueMessage, moveDraft, newDraftKey, setDraftText } from "./drafts.svelte";
import {
  CURATED,
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
  type ConnectionDraft,
  type Engine,
  type SavedPrompt,
} from "./catalog";
import {
  applyChoice,
  choiceOf,
  loadChoices,
  noteConnected,
  noteMade,
  saveChoices,
  wantedChoice,
  type ChatChoice,
  type ChatChoices,
} from "./chatChoice";
import { EDITABLE_LAYERS } from "./types";
import { LIST_SCOPE, NEW_CHAT_SCOPE, UndoHistory } from "./undo";
import { chatName, notifyNeedsYou, notifyTurnEnd } from "./notify";
import { RESUME_TEXT, SleepWatch, loadSleepPrefs, pushPowerPrefs, type Woke } from "./sleep";
import { asideFollowUp, asideQuestion, type AsideQuote } from "./asideQuote";
import type { AsideAnchor } from "./asideCard";
import { isPrivateChat, loadAsides, markChatMode, nextAsideId } from "./asides";
import { MAX_OPEN_ASIDES, foldTheOldest } from "./asideCard";
import { loadCouncilPrefs, type CouncilPrefs, type CouncilRequest } from "./council";
import { limitPauseFrom, resumeDelayMs, resumeMessage, type LimitPause } from "./limit";
import {
  backgroundAskToast,
  backgroundEndToast,
  canDetach,
  eventHost,
  liveHost,
  settlePlan,
  type Background,
  type Parked,
} from "./browse";
import { SEARCH_COLUMN_MAX, searchGrowth } from "./search.svelte";
import * as tabs from "./tabs";
import { adoptPending, latestAgents, mergeRows, rowsFromLog, rowsOf } from "./subagentRows";
import { cli, startCliClock } from "./cliUpdate.svelte";
import { chatIsCold, loadLayerPrefs, reconnectBeforeTurn, saveLayerPrefs } from "./promptVersions";
import type { TabContent, Workspace } from "./tabs";
import { UNFILED_TABS, loadSavedWorkspaces, rebuild, saveWorkspaceFor, snapshot } from "./tabsStore";
import {
  buildNotices,
  dailyDue,
  loadDailyPrefs,
  loadDismissed,
  loadLastDaily,
  loadSeenStamp,
  saveDailyPrefs,
  saveDismissed,
  saveLastDaily,
  saveSeenStamp,
  type DailyPrefs,
  type Notice,
} from "./centre";
import type {
  AgentInfo,
  AgentInit,
  AgentTurnResult,
  SubagentStatus,
  PlanUsage,
  ApprovalDecision,
  ApprovalRequest,
  AsideDelta,
  BlockerList,
  ChatKind,
  ChatMode,
  DocumentInput,
  FolderGrant,
  FolderInfo,
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
  ProjectsFolderInfo,
  NewProjectPath,
  ContextEdit,
  EditableLayer,
  PromptLayer,
  PromptLayerEdits,
  ProposalEntry,
  ProposalScope,
  ProviderInfo,
  SearchBackendInfo,
  SearchResult,
  SearchScope,
  SessionEvent,
  SessionMeta,
  TodoItem,
  TurnBudget,
  Checkpoint,
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

/**
 * The `provider` value that means the Claude Code engine (2026-09-16,
 * nightshift backlog 070): the same string the backend's `AGENT` is, and
 * the one value in the dream dropdown that is not a provider kind.
 */
export const DREAM_ENGINE = "claude-code";

export interface DreamPrefs {
  /** Dream automatically after a compaction, when the inbox has entries. */
  auto: boolean;
  /** Provider that dreams — a provider kind or `DREAM_ENGINE`; "" means
   *  whatever the rail is connected to, the Claude Code engine included. */
  provider: string;
  /** Model that dreams; "" means the provider's default. On `DREAM_ENGINE`
   *  a CLI alias (`haiku`, `sonnet`) and "" the CLI's default. */
  model: string;
}

/** The stored preference read back, or the default when absent or malformed. */
export function parseDreamPrefs(raw: string | null): DreamPrefs {
  try {
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

function loadDreamPrefs(): DreamPrefs {
  try {
    return parseDreamPrefs(localStorage.getItem(DREAM_PREFS_KEY));
  } catch {
    return parseDreamPrefs(null);
  }
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

/** The sidebar's column while the search panel is open (nightshift backlog
 *  117, board 11a): ~~widened to 380px, or the sidebar's own width when that
 *  is already wider~~ — since backlog 138 (2026-09-17) the sidebar's width
 *  plus a small growth the panel tweens in on open and out on close
 *  (`search.svelte.ts`: up to 80px, never past 380, eased over 160 ms),
 *  so the column no longer jumps; the saved width is untouched. */
export const SEARCH_COLUMN = SEARCH_COLUMN_MAX;
export function sidebarColumn(): number {
  return app.layout.sidebarWidth + Math.round(searchGrowth.current);
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
  /**
   * A subagent's own turn, when this call spawned one (Claude Code's
   * `Agent`; nightshift backlog 075): its calls, thinking and words as
   * segments of their own, drawn collapsed under this row. Live they
   * arrive as `subagent` turn events; from the log they are the marked
   * text block the recorder wrote against this call's id.
   */
  children?: Segment[];
}

/**
 * One subagent of the open chat, for the Running-tasks panel (nightshift
 * backlog 152): the translator's `subagent_status` row, whole, plus what
 * the window keeps beside it — when it was first seen and last changed,
 * which turn it belongs to, and its own copy of the child's segments
 * (calls, results, words), so the *View transcript* tab draws from the
 * row and not from a live message that the post-turn re-sync replaces.
 */
export interface SubagentRow extends SubagentStatus {
  /** The chat it ran in (backlog 160: rows are kept per chat, not cleared
   *  on a switch); null for a New chat's until its first turn names it. */
  session: string | null;
  /** Rebuilt from the chat's log on reopening it (`rowsFromLog`). */
  restored?: boolean;
  /** The send this subagent ran under: `app.turnSeq` at its first event. */
  turn: number;
  /** Clock at the first event, for the elapsed count while it runs. */
  startedAt: number;
  /** Clock at the last event; the elapsed count stops here once done. */
  updatedAt: number;
  /** The child's own calls, thinking and words, as the transcript's
   *  collapsed row has them (backlog 075) — a second copy, kept here. */
  segments: Segment[];
}

/**
 * Normalized assistant-message segment, used both for the live streaming
 * message and for completed messages projected from SessionEvents.
 */
export type Segment =
  /** `ms` — how long the block streamed, for the row's `thought for 6 s`
   *  (the design's board 1, 2026-09-16); set on the live turn only, a
   *  recorded reply has no clock to read it from. `at` is the clock while
   *  it streams, cleared when `ms` is written. */
  | { kind: "thinking"; text: string; done: boolean; ms?: number; at?: number }
  | { kind: "redacted" }
  | { kind: "text"; text: string }
  /** `block` — the index into the reply's `blocks` — is set on a recorded
   *  reply's call so the hover Remove (backlog 066) can name it; absent
   *  while streaming, when there is nothing to remove yet. */
  | { kind: "tool"; call: ToolCallView; block?: number }
  /** A block of a recorded reply removed from the context on its own
   *  (backlog 066): drawn as its placeholder, greyed, with the original a
   *  click away and Restore beside it. Never in a live message. */
  | { kind: "removed_text"; block: number; text: string }
  | { kind: "removed_tool"; block: number; call: ToolCallView }
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
  /** The extra folders this connection may reach (nightshift backlog 143),
   *  each with its source and, on the API engine, its `@alias`. Optional so
   *  a fixture built before the field existed still types. */
  folders?: FolderInfo[];
  /** Folders outside every tree that the CLI refused a read in during the
   *  last turn (backlog 143, pass 2) — the rail offers each for a grant.
   *  Cleared by the next connect (a grant reconnects) or the next turn. */
  refused?: string[];
}

/** One exchange of the open chat's aside (backlog 081; streamed since
 *  backlog 128; a thread of them since backlog 130) — see `app.aside`. */
export interface AsideTurn {
  /** Tells this exchange's deltas and result from a cancelled or replaced
   *  one's: the backend echoes it on every `aside-delta`. */
  seq: number;
  /** His question as typed — not the framed string the backend gets. */
  question: string;
  /** The answer as it streams (backlog 128): what has arrived so far,
   *  drawn as it lands; equal to `answer` once that is set. */
  partial: string;
  /** The whole answer, once the backend's result is in; null while asking. */
  answer: string | null;
  error: string | null;
  /** × pressed mid-stream: the partial text stays on the card, marked. */
  cancelled: boolean;
  cacheRead: number;
}

/** The open chat's aside (backlog 081, the passage form backlog 107) — see
 *  `app.aside`. */
export interface Aside {
  /** The thread's own id (backlog 176): several are open at once, and a
   *  tab or the side panel shows the one it names. Per window. */
  id: number;
  /** Folded to its head row (blocker 318): past `MAX_OPEN_ASIDES` open
   *  cards the oldest fold; a click on the strip opens it again. */
  folded?: boolean;
  /** The highlighted passage the thread is about, if any. */
  quote: AsideQuote | null;
  /** Opened from a selection and not yet asked: the card is the question box. */
  draft: boolean;
  /** The exchanges in order; the last one is the live one. Empty only
   *  while a draft. */
  turns: AsideTurn[];
  /** Where the passage is in the transcript (backlog 141): the floating
   *  card opens under it and the text stays marked. Null for a composer
   *  aside, which has no passage; the card then sits above the composer
   *  (blocker 225). */
  anchor: AsideAnchor | null;
  /** Where he moved the floating card, in window px (backlog 156): kept
   *  while the thread is open, never saved — a relaunch puts the card back
   *  under its passage. Absent or null: the card is at its home. */
  moved?: { left: number; top: number; width: number } | null;
}

/** The aside's live exchange — the last turn while it is still asking. */
export function asideAsking(a: Aside | null): AsideTurn | null {
  const t = a?.turns[a.turns.length - 1] ?? null;
  return t && t.answer === null && t.error === null && !t.cancelled ? t : null;
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
   * Where new projects go (Settings → Projects folder); null on a machine
   * with no user config directory. Read on launch and after Settings
   * repoints it.
   */
  projectsFolder: null as ProjectsFolderInfo | null,
  /**
   * The New project form's draft, kept here rather than in the form so a
   * stray Escape, a click on a chat, or a switch of project loses nothing
   * typed (the never-lose-work rule): coming back finds the name, the
   * instructions and a picked folder still there. Cleared by Create and by
   * an explicit Discard, nothing else.
   */
  newProjectDraft: { name: "", instructions: "", pickedPath: null } as {
    name: string;
    instructions: string;
    /** A folder chosen through Change…; null means `<projects folder>/<slug>`. */
    pickedPath: string | null;
  },
  /**
   * What the centre pane shows. "note" is the note editor and "graph" the
   * vault's link graph, both of which replace the transcript rather than
   * floating over it — reading, writing and navigating notes is work, not a
   * dialog. "new-project" is the form that makes a project (backlog 047,
   * 2026-09-14): a screen in Welcome's place, for the same reason.
   */
  view: "chat" as "chat" | "note" | "graph" | "nightshift" | "new-project",
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
  /** The connected chat's *newer version exists* marks (backlog 174). */
  promptPending: null as import("./types").PendingView | null,
  /** Settings: take changed layers at the next cold moment (backlog 174). */
  layerPrefs: loadLayerPrefs(),
  sessions: [] as SessionMeta[],
  activeSessionId: null as string | null,
  /**
   * The kind the next chat will be while no chat is open (nightshift
   * backlog 061, 2026-09-15). New chat is a state, not a file: `newSession`
   * records the kind here and clears the chat, and the first message
   * creates the log in that kind. `chatMode` reads this when the transcript
   * has no `session_created` line, so the top bar's mark, the Context
   * caveat and the reconnect all see the pending kind before the first
   * message. The backend holds the same value (`AppState::pending_mode`)
   * and creates from its own copy; this one is for what is drawn.
   */
  pendingMode: "normal" as ChatMode,
  /**
   * What the next chat is for, on the same terms as `pendingMode`
   * (nightshift backlog 102): set by `newSession`, read by `chatKind`
   * while the transcript has no creation line, reset on a project switch.
   * Starts as the default kind for no project — a Chat — and `initialize`
   * and the project switch set it from `defaultKind()`.
   */
  pendingKind: "chat" as ChatKind,
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
  settingsOpenOn: null as null | "models" | "usage",
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
  /**
   * His edits to a proposal's proposed side on the review card (nightshift
   * backlog 184), by proposal id, while they differ from the dream's text —
   * kept here rather than in the card so leaving it (Keep for later, another
   * note, a tab switch) loses nothing. Dropped on Accept and on Dismiss.
   */
  proposalEdits: {} as Record<string, string>,
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
  /**
   * The last turn paused by the plan's usage limit (nightshift backlog
   * 164): the transcript's card with its Resume. Kept until a turn runs
   * in that chat again; `limitResumeAt` is the scheduled resume's time
   * while one waits for the window.
   */
  limitPause: null as LimitPause | null,
  limitResumeAt: null as number | null,
  /** The chat whose budget ledger `turnBudget` follows (nightshift backlog
   *  192): the running chat, parked or not, known from its first turn's
   *  start — the stop card answers for it. */
  budgetSession: null as string | null,
  /**
   * The running chat, set aside while he looks at another during its turn
   * (nightshift backlog 159, pass 1; `browse.ts`). Null when the chat on
   * screen is the one running, or nothing runs. The stream keeps landing
   * in its `live`; the turn's end drops it and re-aligns the backend to
   * the chat on screen.
   */
  parked: null as Parked<Segment> | null,
  /**
   * The chats whose turn runs off screen, by id (nightshift backlog 159,
   * pass 2 step A2; `browse.ts`): each keeps its log, its stream and the
   * prompts it asked, and its events land there. The chat on screen is
   * idle unless it runs a turn of its own.
   */
  background: {} as Record<string, Background<Segment, ApprovalRequest>>,
  /**
   * The running message's budget ledger (nightshift backlog 165, pass 2):
   * the hook's `turn-budget.json`, read every `TURN_BUDGET_EVERY_MS`
   * while a Claude Code turn runs and once as it ends, for the meter on
   * the agents chip, the composer's busy row and Running tasks. Null
   * before a chat's first turn.
   */
  turnBudget: null as TurnBudget | null,
  /**
   * The open chat's checkpoint (nightshift backlog 104, pass 3): the
   * message helpers fork from, read when a chat opens and as each turn
   * ends, set by "fork from here" on a message. Null before the chat's
   * first exchange.
   */
  checkpoint: null as Checkpoint | null,
  /**
   * The plan's five-hour and seven-day percentages for the top bar's plan
   * chip on the Claude Code engine (nightshift backlog 073). Read from two
   * local sample files at connect and at every turn end — never on a
   * timer faster than the sample changes — and shown with its age.
   */
  planUsage: null as PlanUsage | null,
  /**
   * What the open chat's Claude Code session has — the CLI's `system/init`
   * line from its latest turn (nightshift backlog 077), for the Context
   * page's *This session* pane. Cleared when the chat changes; null before
   * the chat's first turn and on the other engine.
   */
  agentInit: null as AgentInit | null,
  /**
   * The subagents (nightshift backlog 152): a row per `Agent` call the CLI
   * spawned, newest turn last. ~~Kept for the chat while it is open —
   * cleared with `agentInit` on a chat switch~~ — since backlog 160
   * (2026-09-25) every chat's, each row naming its chat, never cleared on
   * a switch, and rebuilt from the log when a chat is opened
   * (`subagentRows.ts`). `turnSeq` counts sends, so the gauge's
   * "+ subagents" line can read the latest turn's rows alone; the chip
   * reads the chat's latest turn that had any.
   */
  subagents: [] as SubagentRow[],
  turnSeq: 0,
  /** The Running-tasks popover under the top bar's agents chip. */
  showTasks: false,
  /** The CLI's predicted next prompt for the open chat (nightshift backlog
   *  083), the composer's ghost line; cleared by a send or a chat switch. */
  suggestion: null as string | null,
  /** The open chat's aside (nightshift backlog 081): a side question and
   *  its answer, shown at the foot of the transcript and recorded nowhere;
   *  `answer` null while it is being asked. Cleared by a chat switch or
   *  its own ×. Since backlog 107 it may be *about a passage*: `quote` is
   *  what he highlighted in the transcript, and a card opened from a
   *  selection starts as a `draft` — the quote shown, the question box
   *  waiting under it, nothing sent yet. `seq` tells one aside from the
   *  next when an answer lands late. Since backlog 128 the answer streams
   *  into the card (`partial`) and since 130 the card is a thread of
   *  exchanges (`turns`, each with its own `seq`).
   *  Since backlog 176 (2026-09-23) a chat holds several threads —
   *  `asides`, below — and this is the **front** one, the newest: a
   *  mirror kept by `syncFrontAside` for what reads a single card. */
  aside: null as Aside | null,
  /** The open chat's aside threads, oldest first (backlog 176): a card
   *  each, each with its own passage, thread and follow-up box. */
  asides: [] as Aside[],
  /** The thread whose question box takes the caret once its card is
   *  placed (a draft just opened); cleared by the card that took it. */
  asideFocus: null as number | null,
  /** Observations awaiting the next dream — the badge on the Dream button. */
  dreamPending: 0,
  /** A dream is running; the button becomes its progress line. */
  dreaming: false,
  /** The dream's most recent tool call, for the running button's tooltip. */
  dreamActivity: "",
  /** Auto-dream and the dream model, Settings → Knowledge. */
  dreamPrefs: loadDreamPrefs(),
  /**
   * The notification centre and the daily pass (nightshift backlog 069).
   * The notices are derived from their sources on every `refreshCentre`;
   * only `dismissed`, the daily switch and the last run's stamp are kept.
   */
  centre: {
    open: false,
    notices: [] as Notice[],
    dismissed: loadDismissed(),
    daily: loadDailyPrefs() as DailyPrefs,
    /** ms since the epoch, or null when no daily pass has run. */
    lastDaily: loadLastDaily(),
    /** A daily pass is in flight (capture → dream → tidy). */
    dailyRunning: false,
    /** What the last daily pass said, one line, for the Settings card. */
    dailyLast: "" as string,
    /** The rows every project reports — the morning and blocker sources —
     *  read here so the bell works off the Nightshift page. */
    rows: [] as NightshiftRow[],
    /** The build stamp seen at the last refresh (`loadSeenStamp` at start). */
    seenStamp: loadSeenStamp(),
  },
  /** Session logs with something new since the last capture — the count on
   *  the Capture button. Always shown: the chat open right now is one. */
  capturePending: 0,
  /** A capture is running; the button becomes its progress line. */
  capturing: false,
  /** The colour palette, Settings → Appearance. */
  palette: loadPalette() as Palette,
  /** Sidebar width and collapse, pane widths on the Nightshift screens. */
  layout: loadLayout(),
  /**
   * The tabs and panes (nightshift backlog 099, 2026-09-17): one or two
   * panes side by side, each with its strip of tabs, each tab a chat or
   * a note. A navigation layer over the fields above — `view`,
   * `activeSessionId`, `events`, `openNote` stay the one open chat and
   * note, and `reflectTabs` records what they show into the focused
   * pane's active tab, while activating a tab opens its content through
   * the same `openSession` / `showNote` the sidebar calls. Not persisted:
   * the app opens, as it always has, on one new-chat tab.
   */
  tabs: tabs.emptyWorkspace() as Workspace,
  /**
   * How the next chat or note shown lands in the focused pane: `replace`
   * takes over the active tab (a plain click, blocker 140), `new` opens a
   * tab beside it (⌘-click, ⌘T), `beside` the other pane (Open beside).
   * Read once by `reflectTabs` and reset.
   */
  openNext: "replace" as "replace" | "new" | "beside",
  /** The tab being dragged, while one is: the strips and the panes' drop
   *  halves read it, since `dataTransfer` is unreadable during `dragover`. */
  draggingTab: null as string | null,
  /** A content descriptor being dragged in from outside the strips (a
   *  sidebar row, a note row, the Nightshift or Graph button, a project
   *  row, the aside card — backlog 140 pass 2), for the same reason. */
  draggingContent: null as TabContent | null,
  /** The terminal dock's strip being dragged between panes (backlog 113's
   *  12b): the halves light *dock here* and a drop moves `term.pane`. */
  draggingTerm: false,
  /**
   * The chat whose aside thread shows in the side panel (backlog 141
   * pass 2): the floating card dragged to the window's right edge. Not a
   * pane — `App.svelte` draws it as a third column beside the panes —
   * and, like an aside tab, a second view of the thread where it lives
   * (`asideOf`), never a copy; the transcript hides its card meanwhile
   * (`asideInTab`). In memory only, as the workspace is.
   */
  asidePanel: null as string | null,
  /** Which of that chat's threads the panel shows (backlog 176); null
   *  reads as its front thread, as before. */
  asidePanelThread: null as number | null,
  /**
   * The search-everywhere panel (nightshift backlog 117, with 106's second
   * half): whether it is showing in the sidebar's column, the query and
   * scope, the last answer and which row is selected. Here rather than in
   * the component so a jump to a chat in another project — which swaps
   * `app.project` and every list under it — keeps the results and the
   * selection for the `back to results` link.
   */
  search: {
    open: false,
    query: "",
    scope: "this" as SearchScope,
    result: null as SearchResult | null,
    selected: 0,
  },
  /** `action` (backlog 066) is the toast's one button — "Undo" on a
   *  removal or a rewind — and such a toast stays 8 s rather than 5. */
  toasts: [] as { id: number; text: string; action?: { label: string; run: () => void } }[],
  /** Bumped whenever the undo stack changes, so the menu titles and the
   *  palette rows that read it re-derive (nightshift backlog 064). The
   *  stack itself is `history`, which is not reactive. */
  undoTick: 0,
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
    case "model_sonnet":
    case "model_opus":
    case "model_fable":
    case "model_haiku":
      void switchModel(id.slice(6));
      break;
    // The Edit menu's Undo and Redo, ours since nightshift backlog 064: in
    // a text box the key is the box's — the webview's own command keeps
    // the typing history — and anywhere else it is the app's stack.
    case "undo_app":
      if (inTextField()) document.execCommand("undo");
      else void undo();
      break;
    case "redo_app":
      if (inTextField()) document.execCommand("redo");
      else void redo();
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
  await listen<TurnEvent & { chat?: string }>("turn-event", (e) => applyTurnEvent(e.payload));
  // The aside's answer as it streams (nightshift backlog 128): a delta
  // for the live exchange is appended; one for a cancelled or replaced
  // exchange (its `seq` differs) is dropped.
  await listen<AsideDelta>("aside-delta", (e) => {
    const t = findAsideTurn(e.payload.seq);
    if (t && t.answer === null && !t.cancelled) t.partial += e.payload.text;
  });
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  // The Mac came back from sleep (nightshift backlog 101): `sleepWatch`
  // matches it against the turn that was running, and the keep-awake
  // switches reach Rust once at start-up.
  await listen<Woke>("system-woke", (e) => sleepWatch.woke(e.payload));
  void pushPowerPrefs();
  // The daily pass (nightshift backlog 069): a minute clock while the app
  // is open, and a look on wake — a pass missed while the Mac slept happens
  // now — and one at start-up, below, for a pass missed while it was closed.
  await listen<Woke>("system-woke", () => void maybeDailyPass());
  startDailyClock();
  startPlanUsageClock();
  // Claude Code's version (nightshift backlog 182): a check shortly after
  // launch and every six hours; an Update waits for a cold moment.
  startCliClock();
  // The Refresh-now banner's click (nightshift backlog 116): Rust has
  // already brought the window forward; this opens Settings on Usage.
  await listen("usage-banner-clicked", () => {
    app.settingsOpenOn = "usage";
    app.showSettings = true;
  });
  void refreshCentre().then(() => maybeDailyPass());
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
  await listen<ApprovalRequest>("tool-approval", (e) => {
    // A background chat's prompt waits in that chat (backlog 159, A2):
    // its tab's dot, the banner, and a light toast here (guess pass 5).
    const bg = eventHost(app.background, e.payload.chat);
    if (bg) {
      bg.approvals.push(e.payload);
      const name = backgroundName(bg.session);
      addToast(backgroundAskToast(name));
      void notifyNeedsYou(name, e.payload);
      return;
    }
    app.pendingApprovals.push(e.payload);
    // The needs-you banner (backlog 079): the turn waits on him, and if the
    // window is behind something else nothing on screen says so.
    void notifyNeedsYou(bannerChat(), e.payload);
  });
  // The phone page (nightshift backlog 091, Shape B): a message, an answer
  // or a stop from the phone reaches this window as an event and runs
  // through the same `send`, `resolveApproval` and `cancelTurn` a click
  // here does, so the transcript, the queue, the hand-off and the sleep
  // watch see it as typed. A message for a chat that is not open opens
  // it first; one that arrives while a turn runs joins the composer's
  // queue (the phone also holds one for while the Mac is unreachable).
  // The listener waits for the answer (backlog 132): what became of the
  // message goes back through `remote_sent`, and the phone hears it.
  await listen<{ id: number; chat: string | null; text: string }>("remote-send", (e) => {
    const { id, chat, text } = e.payload;
    remoteSend(chat, text).then(
      (outcome) => void api.remoteSent(id, outcome === "queued", null).catch(() => {}),
      (err: unknown) => void api.remoteSent(id, false, String(err)).catch(() => {}),
    );
  });
  await listen<{
    id: string;
    name: string;
    decision: ApprovalDecision;
    reason?: string | null;
    answer?: unknown;
    then?: "ask" | "auto" | null;
  }>("remote-approve", (e) => {
    const { id, name, decision, reason, answer, then } = e.payload;
    void resolveApproval(id, name, decision, reason ?? undefined, answer ?? undefined, then ?? undefined);
  });
  // The phone names the chat it shows (backlog 159, A3); `null` is the
  // chat on screen, as before.
  await listen<{ chat?: string | null } | null>("remote-cancel", (e) => void cancelTurn(e.payload?.chat ?? null));
  // A chat's first turn names its chat as it starts (backlog 192; review
  // 2026-09-23 finding 4): the budget meter and stop card follow it now,
  // not only once the turn has ended.
  await listen<string>("turn-chat", (e) => {
    if (app.busy && app.budgetSession === null && e.payload) startBudgetPoll(e.payload, budgetTyped);
  });
  await listen<string>("menu", (e) => runMenuCommand(e.payload));
  // Only the watched project (selectNightshiftProject calls nightshiftWatch)
  // emits this, and only that project's row and morning page are worth
  // re-reading — a change event for anything else could not reach here.
  await listen<NightshiftChange>("nightshift-change", (e) => {
    // The bell's morning and blocker counts follow the watched root.
    void refreshCentre();
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
  // No chat is open at launch, so the next one is of the default kind
  // (nightshift backlog 102) — said to the backend before the engine is
  // built, since `connect` roots a Chat in the neutral folder.
  app.pendingKind = defaultKind();
  try {
    await api.newSession(undefined, app.pendingKind);
  } catch {
    // The first New chat click sends it again.
  }
  await refreshSessions();
  await refreshKnowledge();
  await refreshProjectsFolder();
  await refreshNotes();
  await refreshDreamStatus();
  await refreshCaptureStatus();
  await autoConnect();
  // Each chat's model and engine are put back from here on (backlog 205):
  // before this the draft is still being read and the launch connect made.
  chatChoice.ready = true;
  // The tabs he left open (backlog 201), once the lists that decide which
  // survive are read and the engine is connected.
  await restoreTabs();
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

/** Where new projects go. Read on launch and after Settings repoints it. */
export async function refreshProjectsFolder(): Promise<void> {
  try {
    app.projectsFolder = await api.projectsFolderInfo();
  } catch {
    app.projectsFolder = null;
  }
}

/**
 * Point new projects at a folder, or back at the default with null. Moves
 * nothing; the projects already made are registered by their own paths.
 */
export async function useProjectsFolder(dir: string | null): Promise<void> {
  try {
    app.projectsFolder = await api.setProjectsFolder(dir);
  } catch (e) {
    addToast(String(e));
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

/**
 * Re-read the plan's percentages (nightshift backlog 073). Two small file
 * reads on the backend; called on connect to the Claude Code engine and at
 * the end of every agent turn, which is as often as the figure can have
 * moved on Nightloom's account of it.
 */
export async function refreshPlanUsage(live = false): Promise<void> {
  try {
    // A turn that brought its own rate-limit figure is the account's
    // number at that moment (source `turn`); a live `/usage` within the
    // minute would only repeat it. Past that, ask the CLI.
    const held0 = app.planUsage;
    if (
      live &&
      held0?.source === "turn" &&
      held0.sampled_at_ms != null &&
      Date.now() - held0.sampled_at_ms < 60_000
    ) {
      return;
    }
    const fresh = await (live ? api.planUsageRefresh() : api.planUsage());
    // A file older than the turn-sourced reading already held is not an
    // update: the turn's figure was the account's at that moment.
    const held = app.planUsage;
    if (
      held?.source === "turn" &&
      held.sampled_at_ms != null &&
      fresh.sampled_at_ms != null &&
      fresh.sampled_at_ms < held.sampled_at_ms
    ) {
      return;
    }
    app.planUsage = fresh;
  } catch {
    // A failed read keeps the last reading, whose age the chip shows.
  }
}

/**
 * The plan chip from the turn itself (nightshift backlog 073). On CLI
 * 2.1.263 the `rate_limit_event` carries both windows' share used
 * (`unifiedWindows`, measured 2026-09-16); that is the account's figure at
 * the moment the turn ran, fresher than the Claude app's sample or the
 * CLI's `/usage` cache, so it wins and the files are the fallback for a
 * build that does not send it. Pure over its inputs so the suite can pin it.
 */
export function planUsageFromTurn(
  plan: AgentTurnResult["plan"],
  nowMs: number = Date.now(),
): PlanUsage | null {
  const w = plan?.unifiedWindows;
  const fh = w?.five_hour?.utilization;
  if (fh == null) return null;
  const pct = (u: number | null | undefined) =>
    u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  const iso = (secs: number | null | undefined) =>
    secs == null ? null : new Date(secs * 1000).toISOString();
  return {
    five_hour: pct(fh),
    seven_day: pct(w?.seven_day?.utilization),
    sampled_at_ms: nowMs,
    age_seconds: 0,
    stale: false,
    five_hour_resets_at: iso(w?.five_hour?.resetsAt),
    seven_day_resets_at: iso(w?.seven_day?.resetsAt),
    source: "turn",
  };
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
 * Which connection a background pass runs on: the engine set in Settings,
 * or the rail's. One knob answers "which model dreams" for the button and
 * the auto-trigger alike — and the capture pass uses the same one, being
 * the front half of the same pipeline. Since 2026-09-16 (nightshift
 * backlog 070) the Claude Code engine is a real answer: chosen in Settings
 * it runs with the rail's binary and safe mode and the Settings alias;
 * left on the rail's connection while the rail is on Claude Code, it runs
 * with the rail's alias too, billed to the subscription either way. Pure,
 * so a test can pin the routing; `passTarget` reads the live state.
 */
export function passTargetFor(prefs: DreamPrefs, d: ConnectionDraft): api.PassArgs {
  if (prefs.provider === DREAM_ENGINE) {
    return {
      provider: DREAM_ENGINE,
      model: prefs.model.trim() || undefined,
      binary: d.agentBinary.trim() || undefined,
      safeMode: d.agentSafeMode,
    };
  }
  if (prefs.provider) {
    return { provider: prefs.provider, model: prefs.model.trim() || undefined };
  }
  if (d.engine === "claude-code") {
    return {
      provider: DREAM_ENGINE,
      model: d.agentModel.trim() || undefined,
      binary: d.agentBinary.trim() || undefined,
      safeMode: d.agentSafeMode,
    };
  }
  return {
    provider: d.provider,
    model: d.model || undefined,
    baseUrl: d.baseUrl.trim() || undefined,
    thinking: thinkingString(d),
  };
}

function passTarget(): api.PassArgs {
  return passTargetFor(app.dreamPrefs, app.draft);
}

/**
 * Run one capture pass with the dream's connection: read every session log
 * since its watermark and extract observations into the inbox. Its own job
 * on the backend, sharing the dream's one-at-a-time lock, since the two are
 * one pipeline.
 */
export async function runCapture(): Promise<void> {
  if (app.capturing || app.dreaming) return;
  const target = passTarget();
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
        (r.incognito > 0 ? `; ${r.incognito} incognito, not read` : "") +
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
 * same whichever engine the window is on — the Claude Code engine included,
 * since 2026-09-16 (`passTargetFor`).
 */
export async function runDream(): Promise<void> {
  if (app.dreaming || app.capturing) return;
  const target = passTarget();
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
  // The pass writes notes and consumes the inbox; both surfaces follow —
  // and the bell, which lists what the dream proposed and changed.
  await refreshNotes();
  await refreshDreamStatus();
  void refreshCentre();
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

// ---- the notification centre and the daily pass (nightshift backlog 069) ----

/**
 * Re-derive the bell's list from its sources: every project's proposals,
 * the dream's commits, the Nightshift rows, the build stamp. Four cheap
 * reads (directories and `git log`), so it runs after every pass, on the
 * panel opening, and on a Nightshift change. With the macOS banner on, a
 * notice that was not there at the previous refresh posts one — never on
 * the first refresh of a window, which would announce the whole backlog.
 */
let centreSeen: Set<string> | null = null;
export async function refreshCentre(): Promise<void> {
  const [proposals, commits, rows, stamp] = await Promise.all([
    api.centreProposals().catch(() => []),
    api.centreDreamCommits(10).catch(() => []),
    api.nightshiftProjects().catch(() => [] as NightshiftRow[]),
    api.buildStamp().catch(() => null),
  ]);
  app.centre.rows = rows;
  app.centre.notices = buildNotices({
    proposals,
    commits,
    rows,
    read: app.nightshift.read,
    stamp,
    seenStamp: app.centre.seenStamp,
    dismissed: app.centre.dismissed,
    cli: cli.status,
    curated: CURATED.anthropic ?? [],
  });
  // A first run has no stamp on record: the one seen now becomes it, so
  // the next roll is the first release the bell announces.
  if (stamp?.exe_modified && !app.centre.seenStamp) {
    app.centre.seenStamp = stamp.exe_modified;
    saveSeenStamp(stamp.exe_modified);
  }
  const ids = new Set(app.centre.notices.map((n) => n.id));
  if (centreSeen && app.centre.daily.notifyMac) {
    const fresh = app.centre.notices.filter((n) => !centreSeen!.has(n.id));
    if (fresh.length > 0) {
      const body =
        fresh.length === 1 ? fresh[0].title : `${fresh[0].title} — and ${fresh.length - 1} more`;
      api.notify("Nightloom — to review", body).catch(() => {});
    }
  }
  centreSeen = ids;
}

/** The bell's count: everything listed. */
export function centreCount(): number {
  return app.centre.notices.length;
}

/** Take a notice off the list. The thing it names is untouched — a
 *  dismissed proposal is still pending under Notes, a dismissed blocker
 *  still open — and comes back only as a different notice (a new page, a
 *  changed count). */
export function dismissNotice(id: string): void {
  if (!app.centre.dismissed.includes(id)) app.centre.dismissed = [...app.centre.dismissed, id];
  saveDismissed(app.centre.dismissed);
  app.centre.notices = app.centre.notices.filter((n) => n.id !== id);
  // A release notice is dismissed by recording the stamp as seen.
  if (id.startsWith("release:")) {
    const stamp = id.slice("release:".length);
    app.centre.seenStamp = stamp;
    saveSeenStamp(stamp);
  }
}

/**
 * Open a notice's review — always the existing flow, reached from the
 * panel: a proposal opens `NoteView` in proposal mode (switching to the
 * project first when it is not the open one), a morning page or the
 * blockers open the Nightshift Review tab on that project. A dream's notes
 * are reviewed in the panel itself (`NotificationCentre.svelte` shows the
 * diff and the per-file Revert), and a release has nothing to open.
 */
export async function openNotice(n: Notice): Promise<void> {
  app.centre.open = false;
  if (n.project && app.project?.id !== n.project.id) {
    await useProject(n.project.id);
  }
  if (n.kind === "proposal" && n.proposal) {
    await refreshProposals();
    reviewProposal(n.proposal.project ? "instructions" : "memory", n.proposal.entry.id);
    return;
  }
  if (n.kind === "morning" || n.kind === "blocker") {
    showNightshift();
    app.nightshift.tab = "review";
    app.nightshift.reviewTab = n.kind === "morning" ? "morning" : "blockers";
  }
}

/** Put one file a dream changed back as it was before that dream, as a
 *  commit; the notice stays until dismissed, so the other files can follow. */
export async function revertDreamFile(n: Notice, file: string): Promise<boolean> {
  if (!n.commit) return false;
  try {
    addToast(await api.centreRevertFile(n.commit.repo, n.commit.hash, file));
  } catch (e) {
    addToast(`revert failed: ${String(e)}`);
    return false;
  }
  await refreshNotes();
  return true;
}

export function setDailyPrefs(p: DailyPrefs): void {
  app.centre.daily = p;
  saveDailyPrefs(p);
}

/**
 * The daily pass: capture → dream → tidy, on the connection `passTargetFor`
 * chooses (so it runs on either engine), under the same one-at-a-time lock
 * as the buttons. Nothing is spent when there is nothing to read: an empty
 * set of logs skips the capture, an empty inbox skips the dream, and the
 * tidy is directory work. The run is stamped as it starts, not as it ends,
 * so a pass that fails is not retried every minute until the hour comes
 * round — the next day's hour, or the *Run now* button, is the retry.
 */
export async function runDailyPass(): Promise<void> {
  if (app.centre.dailyRunning || app.dreaming || app.capturing) return;
  app.centre.dailyRunning = true;
  const started = Date.now();
  app.centre.lastDaily = started;
  saveLastDaily(started);
  const said: string[] = [];
  try {
    await refreshCaptureStatus();
    if (app.capturePending > 0) {
      await runCapture();
      said.push(`captured from ${app.capturePending} chat${app.capturePending === 1 ? "" : "s"}`);
    } else {
      said.push("nothing new to capture");
    }
    await refreshDreamStatus();
    if (app.dreamPending > 0) {
      const pending = app.dreamPending;
      await runDream();
      said.push(`dreamed ${pending} observation${pending === 1 ? "" : "s"}`);
    } else {
      said.push("nothing to dream");
    }
    try {
      const tidy = await api.tidyMemory(true);
      const moved = tidy.reduce((n, t) => n + t.report.movable, 0);
      said.push(
        moved > 0
          ? `archived ${moved} struck line${moved === 1 ? "" : "s"} older than 30 days`
          : "nothing old enough to archive",
      );
    } catch (e) {
      said.push(`tidy failed: ${String(e)}`);
    }
  } catch (e) {
    // A capture or a dream that failed — the pass lock held by another
    // Nightloom, a provider without a key — used to leave through here
    // with no line and no toast, and Settings read "last ran 04:00" as
    // if it had (backlog 133, review B's FB9). Now the failure is the
    // line and the toast; the day was stamped as run at the start, as
    // before, so the minute clock does not retry the same failure.
    said.push(`failed: ${String(e)}`);
  } finally {
    app.centre.dailyRunning = false;
  }
  const when = new Date(started);
  app.centre.dailyLast = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${said.join(", ")}`;
  addToast(`daily pass: ${said.join(", ")}`);
  await refreshCentre();
}

/** Run the daily pass if its hour has come and it has not run since. */
export async function maybeDailyPass(): Promise<void> {
  if (!dailyDue(app.centre.daily, app.centre.lastDaily, new Date())) return;
  await runDailyPass();
}

let dailyClock: ReturnType<typeof setInterval> | null = null;
function startDailyClock(): void {
  if (dailyClock) return;
  dailyClock = setInterval(() => void maybeDailyPass(), 60_000);
}

/**
 * The plan gauge refreshed through the CLI's print-mode `/usage` every five
 * minutes while the Claude Code engine is connected (backlog 166, blocker
 * 264, his yes 2026-09-18): the exact figure for zero tokens, so the chip
 * and the subagent limits (165) never act on a stale file. Started with the
 * daily clock; a provider connection makes each tick a no-op.
 */
export const PLAN_USAGE_LIVE_EVERY_MS = 5 * 60_000;

/**
 * The message's budget meter (nightshift backlog 165, pass 2): the ledger
 * the hook writes on every tool call, read every five seconds while a
 * Claude Code turn runs (a file read, no `/usage`), and once as the turn
 * ends so the final figure stays on the chip.
 */
export const TURN_BUDGET_EVERY_MS = 5_000;
let budgetPoll: ReturnType<typeof setInterval> | null = null;
export async function readTurnBudget(session: string | null): Promise<void> {
  if (!session || app.connection?.engine !== "claude-code") return;
  try {
    app.turnBudget = await api.turnBudget(session);
  } catch {
    // A failed read keeps the last ledger.
  }
}
/** The chat's checkpoint (backlog 104), for the transcript's marker. */
export async function readCheckpoint(session: string | null): Promise<void> {
  if (!session || app.connection?.engine !== "claude-code") {
    app.checkpoint = null;
    return;
  }
  try {
    app.checkpoint = await api.checkpoint(session);
  } catch {
    app.checkpoint = null;
  }
}
/** "Fork from here" (backlog 104): helpers fork from the end of the
 *  exchange the message at `index` belongs to. */
export async function setCheckpoint(index: number): Promise<void> {
  const session = app.activeSessionId;
  if (!session) return;
  try {
    app.checkpoint = await api.setCheckpoint(session, index);
    addToast("helpers now fork from here");
  } catch (e) {
    addToast(String(e));
  }
}
/** He is here (backlog 189): this running chat is the one open, in a
 *  focused window. The hook holds a call past the stop line for his
 *  answer only then, or within five minutes of his message. */
function notePresence(session: string, input: boolean): void {
  const looking = typeof document !== "undefined" && document.hasFocus() && !app.parked && app.activeSessionId === session;
  if (!input && !looking) return;
  void api.notePresence(session, input).catch(() => {});
}
/** This turn's message was typed in the window (backlog 192; review
 *  2026-09-23 finding 3): only then is it his *input* for presence — not
 *  a message from the phone, not an automatic resume. */
let turnTyped = true;
/** Whether the running turn's message was typed here, for its first
 *  turn's late start of the poll (`turn-chat`). */
let budgetTyped = true;
/** `send` for a message he did not type here (the phone, a resume). */
async function sendUntyped(text: string): Promise<void> {
  turnTyped = false;
  try {
    await send(text);
  } finally {
    turnTyped = true;
  }
}
function startBudgetPoll(session: string | null, typed = false): void {
  if (budgetPoll) clearInterval(budgetPoll);
  budgetPoll = null;
  app.turnBudget = null;
  app.budgetSession = session;
  if (!session || app.connection?.engine !== "claude-code") return;
  notePresence(session, typed);
  void readTurnBudget(session);
  budgetPoll = setInterval(() => {
    if (!app.busy) {
      if (budgetPoll) clearInterval(budgetPoll);
      budgetPoll = null;
      return;
    }
    notePresence(session, false);
    void readTurnBudget(session);
  }, TURN_BUDGET_EVERY_MS);
}

let planUsageClock: ReturnType<typeof setInterval> | null = null;
function startPlanUsageClock(): void {
  if (planUsageClock) return;
  planUsageClock = setInterval(() => {
    if (app.connection?.engine === "claude-code" && !app.busy) void refreshPlanUsage(true);
  }, PLAN_USAGE_LIVE_EVERY_MS);
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
  if (app.openNote?.scope === "knowledge") leaveNote();
  dropNoteTabs("knowledge");
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
  // ~~The workspace just left is dropped~~ — since backlog 201 it is
  // written under its project first (while its chat is still the open
  // one, so an aside tab of it finds its threads), and the new project's
  // comes back at the end (`restoreTabs`), once its lists are read.
  flushTabs();
  tabsOwner = null;
  // The chat left keeps its asides (backlog 203): without this its cards
  // stayed on the pending chat and went with the first send into the new
  // chat, saved under that chat's id too.
  switchAside(null);
  app.activeSessionId = null;
  app.events = [];
  // The tabs were the list just left too (backlog 099): a workspace is a
  // project's, as an editor's is a folder's. The view that stays (the
  // Nightshift page, below) lands in the fresh workspace at the end.
  app.tabs = tabs.emptyWorkspace();
  // The pending kind was chosen for the list just left; the backend reset
  // its copy in `open_project` / `close_project` (nightshift backlog 061).
  app.pendingMode = "normal";
  // The kind follows the list too (nightshift backlog 102): Claude Code in
  // a project with a folder, Chat unfiled or in a folderless project. The
  // backend reset its copy to build, so it is told — the same call the
  // button makes, on a chat that is already closed.
  app.pendingKind = defaultKind();
  try {
    await api.newSession(undefined, app.pendingKind);
  } catch {
    // The first New chat click sends it again.
  }
  app.error = null;
  // Switching projects from the Nightshift page stays on it — the page
  // follows the open project (round 2, point 12); everywhere else it is a
  // navigation to the new project's chat.
  if (app.view !== "nightshift") app.view = "chat";
  app.openNote = null;
  reflectTabs();
  await applyDraft();
  await refreshProjects();
  await refreshSessions();
  await refreshNotes();
  // The project's own tabs (backlog 201). On the Nightshift page the page
  // stays in front and lands in the restored workspace.
  const stay = app.view === "nightshift";
  await restoreTabs({ show: !stay });
  if (stay) reflectTabs();
}

/**
 * Open project…: pick a folder and open it as a project.
 *
 * `createProject` is idempotent on the path, so choosing a folder that is
 * already a project opens it rather than erroring — which is what someone who
 * navigated back to it meant. This was *New project…* until 2026-09-14
 * (backlog 047): making a project is now a form (`showNewProject`), and
 * this is the flow for work that already has a folder — imported, cloned,
 * or simply not on the list.
 */
export async function openProjectFolder(): Promise<void> {
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

// ---- the New project form ----

/**
 * New project…: the form in the centre pane (backlog 047, 2026-09-14). A
 * screen rather than a modal because it replaces Welcome, the page it is
 * reached from; the draft lives in `app.newProjectDraft` and survives every
 * way out of the screen except Create and Discard.
 */
export function showNewProject(): void {
  app.overlay = null;
  app.view = "new-project";
  app.openNote = null;
  app.proposalReview = null;
  // The form is a tab (backlog 140); landed here as well as by the
  // effect, so a click with the form already the view still finds it.
  reflectTabs();
}

/** Leave the form. The draft stays — Escape and Cancel both come here.
 *  The form is a tab (backlog 140): leaving closes its tab and lands the
 *  neighbour, as the note view's ← Chat does. */
export function closeNewProject(): void {
  if (app.view !== "new-project") return;
  const front = tabs.activeTab(tabs.focusedPane(app.tabs));
  if (front.content.kind === "new-project") {
    void closeTab(front.id);
    return;
  }
  app.view = "chat";
}

/** Drop the draft and leave. Behind a confirmation in the form. */
export function discardNewProject(): void {
  app.newProjectDraft = { name: "", instructions: "", pickedPath: null };
  closeNewProject();
}

/**
 * The folder row's Change…: the native picker, for "I already have work
 * somewhere". Picking replaces the resolved path with the picked one; a
 * cancel leaves whatever was there.
 */
export async function pickNewProjectFolder(): Promise<void> {
  try {
    const picked = await api.pickFolder(
      "Choose the project's folder",
      app.newProjectDraft.pickedPath ?? app.projectsFolder?.dir,
    );
    if (picked) app.newProjectDraft.pickedPath = picked;
  } catch (e) {
    addToast(String(e));
  }
}

/** The form's live folder row: what the backend would make for this name. */
export function resolveNewProjectPath(name: string): Promise<NewProjectPath> {
  return api.resolveNewProjectPath(name);
}

/**
 * Create: make the folder, write the instructions, register, open. No
 * picker appears. The draft is cleared only once the project exists, so a
 * refusal (a folder already holding work, a name that makes no slug) leaves
 * the form as it was with the reason in a toast.
 */
export async function createNewProject(): Promise<boolean> {
  if (app.busy) return false;
  const d = app.newProjectDraft;
  try {
    const project = await api.newProject(d.name, d.pickedPath, d.instructions);
    app.newProjectDraft = { name: "", instructions: "", pickedPath: null };
    await refreshProjects();
    // The folder now exists if it did not; the Settings pane's line reads
    // off `exists`.
    await refreshProjectsFolder();
    app.view = "chat";
    await useProject(project.id);
    return true;
  } catch (e) {
    addToast(String(e));
    return false;
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
  dropProjectTabs(id);
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
  // Landed here as well as by the effect (backlog 140): a ⌘-click on the
  // note already in front changes nothing the effect sees, and the
  // modifier must be consumed rather than left armed (review E's rule).
  reflectTabs();
}

export function showGraph(): void {
  app.view = "graph";
  app.openNote = null;
  app.leftTab = "notes";
  // The graph is a tab (backlog 140).
  reflectTabs();
}

/**
 * The note view's way out — ← Chat, Save from the rail or Settings,
 * Close for now on a proposal. With tabs (nightshift backlog 099) a note
 * is a tab, so this closes the focused pane's note tab and lands its
 * neighbour; `leaveNote` below is the view-level half, which the chat
 * openers call themselves (a chat opened from the sidebar *replaces* the
 * note tab rather than closing it, blocker 140).
 */
export function closeNote(): void {
  const front = tabs.activeTab(tabs.focusedPane(app.tabs));
  if (front.content.kind === "note") {
    void closeTab(front.id);
    return;
  }
  leaveNote();
}

export function leaveNote(): void {
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

/** The one file the Chat instructions layer reads (nightshift backlog 102). */
export const CHAT_INSTRUCTIONS_FILE = "CHAT.md";

/**
 * Open the editor on the Chat instructions — `~/.nightloom/CHAT.md`, how
 * a Chat talks (nightshift backlog 102) — the way `openModelInstructions`
 * opens a model's file; `closeNote` brings Settings back to the pane the
 * card sits on.
 */
export function openChatInstructions(from: "rail" | "settings"): void {
  const tab = app.leftTab;
  app.showRail = false;
  app.showSettings = false;
  app.noteFrom = from;
  showNote("chat", CHAT_INSTRUCTIONS_FILE);
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
  if (staged && staged.key === noteDraftKey(scope, name)) {
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
    (scope === "instructions" || scope === "memory" || scope === "models" || scope === "chat") &&
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
  if (app.openNote?.scope === scope && app.openNote.name === name) leaveNote();
  dropNoteTabs(scope, name);
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
 * The key a note's draft and a staged proposal live under. `scope:name`
 * — and, for the scopes that are one file *per project* (the project's
 * notes and its `AGENTS.md`), the project's id in front (backlog 133,
 * review B's FB8): with one key for every project's `AGENTS.md`, a
 * proposal loaded into project A's editor and left unsaved came back as
 * B's unsaved draft after a switch from the bell, and a Save wrote A's
 * instructions over B's file. The vault's, the models' and the unfiled
 * chats' files are one each, so their keys carry no project.
 */
export function noteDraftKey(scope: NoteScope, name: string, projectId: string | null = app.project?.id ?? null): string {
  return scope === "project" || scope === "instructions"
    ? `${projectId ?? UNFILED}:${scope}:${name}`
    : `${scope}:${name}`;
}

/**
 * Put a proposal's text in the editor as a draft. The file is untouched:
 * `noteDrafts` is where unsaved text lives, the ● draft marker and Revert
 * follow from it, and the only way the text reaches the file is the same
 * Save any edit takes — which, seeing `stagedProposal`, records the
 * proposal as applied afterwards.
 */
export function stageProposal(
  scope: ProposalScope,
  entry: ProposalEntry,
  saved: string,
  // The proposed side as the card shows it — his edits on the card
  // included (backlog 184); the dream's text when there are none.
  text: string = entry.proposal.text,
): void {
  const key = noteDraftKey(scope, AGENTS_MD);
  mirrorDraft(key, text, saved);
  app.stagedProposal = { key, scope, id: entry.id };
  app.proposalReview = null;
}

/**
 * Accept on the proposal card (nightshift backlog 184): save the proposed
 * side — the dream's text, or his edit of it — to the file in one click,
 * through the same `saveNote` the header's Save takes, so the proposal is
 * filed as applied with the text actually saved and the open chat is
 * re-connected. A draft typed in the editor is not touched; a different
 * proposal staged there stays staged.
 */
export async function acceptProposal(scope: ProposalScope, entry: ProposalEntry, text: string): Promise<boolean> {
  const key = noteDraftKey(scope, AGENTS_MD);
  const before = app.stagedProposal;
  app.stagedProposal = { key, scope, id: entry.id };
  const ok = await saveNote(scope, AGENTS_MD, text);
  if (!ok) {
    app.stagedProposal = before;
    return false;
  }
  if (before && before.id !== entry.id) app.stagedProposal = before;
  delete app.proposalEdits[entry.id];
  if (app.proposalReview?.entry.id === entry.id) app.proposalReview = null;
  return true;
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
  delete app.proposalEdits[id];
  // The key `stageProposal` used (nightshift backlog 185): a hand-built
  // `${scope}:AGENTS.md` missed the project's own key, so a later Save tried
  // to mark a dismissed proposal applied.
  unstageProposal(noteDraftKey(scope, AGENTS_MD));
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

function saveChatChoices(): void {
  if (typeof localStorage !== "undefined") saveChoices(localStorage, chatChoice.choices);
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
  if (app.busy || app.connecting) return;
  if (d.engine === "claude-code") return applyAgentDraft();
  if (!d.provider) return;
  sanitizeThinking(d); // a saved draft may hold a mode this target rejects
  // The chat this connect is for, and the choice it sends (backlog 205).
  const chat = app.activeSessionId;
  const sent = choiceOf(d);
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
async function applyAgentDraft(updateNow: PromptLayer[] = []): Promise<void> {
  const d = app.draft;
  // As `applyDraft` (backlog 205).
  const chat = app.activeSessionId;
  const sent = choiceOf(d);
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
      ask: d.agentAsk,
      plan: d.agentPlan,
      subagentsAuto: d.agentSubagentsAuto,
      limits: d.agentLimits,
      forkMode: d.agentForkMode,
      promptSuggestions: suggestions.enabled,
      effort: d.agentEffort.trim() || undefined,
      fallbackModel: d.agentFallback.trim() || undefined,
      // A changed layer waits for this chat's cold moment (backlog 174).
      cold: chatIsCold(app.events, Date.now()),
      autoLayers: app.layerPrefs.autoAtCold,
      updateNow,
    });
    app.promptPending = await api.promptPending().catch(() => null);
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
    app.project = res.project ?? null;
    saveLastConnection({ ...d });
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

/**
 * Before an agent turn (nightshift backlog 174): reconnect when the engine
 * was built for another chat, or when this chat's cache is cold and a
 * *newer version exists* mark is taken then — never on a warm cache.
 */
async function layersBeforeTurn(): Promise<void> {
  // A New chat's first turn hands its connection to the chat it created
  // (`bind_new_chat` in Rust): read that back rather than reconnect for it.
  if (app.promptPending && app.promptPending.session === null && app.activeSessionId !== null) {
    app.promptPending = await api.promptPending().catch(() => app.promptPending);
  }
  const cold = chatIsCold(app.events, Date.now());
  if (!reconnectBeforeTurn(app.promptPending, app.activeSessionId, cold, app.layerPrefs.autoAtCold)) return;
  if (app.busy || app.connecting) return;
  await applyAgentDraft();
}

/** *Update now* on a mark: the new text goes out with the next message,
 *  whatever the cache (its cost was shown on the button). */
export async function updateLayerNow(kind: PromptLayer): Promise<void> {
  if (app.busy || app.connecting || app.connection?.engine !== "claude-code") return;
  await applyAgentDraft([kind]);
}

/** *Update at the next cold moment* / *Keep this version* / the default. */
export async function chooseLayerVersion(kind: PromptLayer, choice: import("./types").LayerChoice): Promise<void> {
  // The chat whose Context page was clicked; Rust refuses it when the
  // connection belongs to another (batch review 2026-09-23, finding 3).
  const session = app.activeSessionId;
  if (session === null) return;
  try {
    app.promptPending = await api.setPromptLayerChoice(session, kind, choice);
  } catch (e) {
    addToast(String(e));
  }
}

/** Settings: take every changed layer at the next cold moment, or wait for the click. */
export function setAutoLayers(on: boolean): void {
  app.layerPrefs.autoAtCold = on;
  saveLayerPrefs(app.layerPrefs);
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


// ---- tabs and panes (nightshift backlog 099) ----

/**
 * What the centre shows now, as tab content: the open note when the view
 * is the note, the open chat (null while it is a new, unsent one) when it
 * is the chat, and — since nightshift backlog 140 — the Nightshift page,
 * the graph or the New project form as the singleton tab each is.
 * ~~Null on the views that are not tabs — the graph, Nightshift, the New
 * project form — which take the whole centre as they always have.~~
 * (2026-09-17: tabs sit above everything now; nothing takes the whole
 * centre.) Null only for a note view with no note.
 */
export function shownContent(): TabContent | null {
  switch (app.view) {
    case "note":
      return app.openNote ? { kind: "note", ...app.openNote } : null;
    case "chat":
      return { kind: "chat", session: app.activeSessionId };
    case "nightshift":
      return { kind: "nightshift" };
    case "graph":
      return { kind: "graph" };
    case "new-project":
      return { kind: "new-project" };
  }
}

/**
 * Record what the centre now shows into the focused pane's active tab —
 * the reflection half of the tab model. Called from an effect in
 * `App.svelte` on every change of the view, the open chat or the open
 * note, so every existing opener (the sidebar, the palette, the search
 * panel, the hand-off card, the phone's `remote-send`) lands in a tab
 * without knowing tabs exist. The tab already holding the content is
 * activated; else the active tab is retargeted, or a new one opened
 * beside it when the click carried ⌘ (`app.openNext`).
 */
let activating = 0;
export function reflectTabs(): void {
  // A tab being activated is already in front; the changes its opener
  // makes on the way are not a new landing.
  if (activating > 0) return;
  const content = shownContent();
  if (!content) return;
  const how = app.openNext;
  app.openNext = "replace";
  const ws = app.tabs;
  if (how === "beside") {
    tabs.openBeside(ws, content, "new");
    return;
  }
  tabs.land(ws, tabs.focusedPane(ws), content, how);
}

/**
 * Show a tab's content: the activation half. A chat tab opens its chat
 * (or the new-chat state), a note tab its note; a chat other than the open
 * one is refused while a turn runs — the backend holds one session, and
 * `openSession` says no (blocker 182) — so the click lands nothing and a
 * toast says why. The tab is made active first, so the reflection finds
 * it in front and has nothing to change.
 */
export async function activateTab(tabId: string): Promise<void> {
  const tab = tabs.tabById(app.tabs, tabId);
  if (!tab) return;
  const c = tab.content;
  // ~~A chat other than the open one is refused while a turn runs~~ —
  // since backlog 159 it opens as a view (`peekSession`), the running
  // chat parked; New chat during the pending chat's first turn is the
  // one refusal, in `newSession`, which keeps the tab in front only if
  // the view changed.
  const wasNewRefused = c.kind === "chat" && c.session === null && app.busy && (app.parked ? app.parked.session : app.activeSessionId) === null && !app.parked;
  if (wasNewRefused) {
    addToast("This chat is having its first turn — New chat opens when it ends");
    return;
  }
  tabs.activate(app.tabs, tabId);
  activating += 1;
  try {
    await showContentOf(c);
  } finally {
    activating -= 1;
  }
}

/**
 * Make the globals show `c` — the view, the open chat, the open note —
 * without touching the workspace: the tab is already in front. A chat
 * opens as the sidebar opens it; a note as the Notes list does; the
 * three whole-centre pages through their own openers (backlog 140). A
 * project card and an aside tab are drawn by the pane from the tab
 * alone and change nothing global.
 */
async function showContentOf(c: TabContent): Promise<void> {
  switch (c.kind) {
    case "note":
      if (app.view !== "note" || app.openNote?.scope !== c.scope || app.openNote?.name !== c.name) {
        showNote(c.scope, c.name);
      }
      return;
    case "chat":
      if (c.session === app.activeSessionId) {
        if (app.view !== "chat") leaveNote();
        return;
      }
      if (c.session === null) await newSession();
      else await openSession(c.session);
      return;
    case "nightshift":
      if (app.view !== "nightshift") showNightshift();
      return;
    case "graph":
      if (app.view !== "graph") showGraph();
      return;
    case "new-project":
      if (app.view !== "new-project") showNewProject();
      return;
    case "project":
    case "aside":
    case "attachment":
    case "subagent":
    case "file":
      return;
  }
}

/**
 * Open `content` in the focused pane the way the sidebar would (backlog
 * 140: the + chooser, a drop on a strip's far end): `new` a tab beside
 * the active one, `replace` in its place. The globals are shown through
 * the same openers the sidebar calls and the reflection lands the tab;
 * the two kinds nothing global describes — a project card, an aside —
 * are landed here directly. A chat other than the open one is refused
 * while a turn runs, with the toast (blocker 182).
 */
export async function openContent(content: TabContent, how: tabs.LandHow = "new"): Promise<void> {
  if (
    content.kind === "project" ||
    content.kind === "aside" ||
    content.kind === "attachment" ||
    content.kind === "subagent" ||
    content.kind === "file"
  ) {
    const t = tabs.land(app.tabs, tabs.focusedPane(app.tabs), content, how);
    await activateTab(t.id);
    return;
  }
  // ~~A chat other than the open one is refused while a turn runs~~ —
  // since backlog 159 (2026-09-18) it opens as a view of its log, the
  // running chat parked (`peekSession`); only New chat during the pending
  // chat's own first turn is refused, in `newSession`.
  app.openNext = how;
  await showContentOf(content);
  // The reflection is idempotent; run it here too so an opener that
  // changed nothing visible (the page already in front) still lands the
  // tab and hands the modifier back (review E's rule, generalised).
  reflectTabs();
  app.openNext = "replace";
}

/**
 * A content descriptor dropped on a strip (a new tab at `index` in that
 * pane) or on a pane's half (a second pane holding it when there is one
 * pane; the pane it was dropped on when there are two) — backlog 140
 * pass 2. The tab is made first and then activated, so the reflection
 * finds it in front.
 */
export async function dropContent(
  content: TabContent,
  target: { pane: string; index: number } | { side: "left" | "right"; pane: string },
): Promise<void> {
  const ws = app.tabs;
  let tab: tabs.Tab;
  // The floating tab dropped (backlog 145 pass 2): kept where it lands —
  // the same tab moves into the strip or a new pane, and the slot
  // empties — rather than a second tab made beside it.
  const floating = ws.floating;
  if (floating && tabs.sameContent(floating.content, content)) {
    let kept: tabs.Tab | null;
    if ("index" in target) {
      const pane = tabs.paneById(ws, target.pane);
      if (!pane) return;
      kept = tabs.keepFloating(ws, pane, target.index);
    } else if (ws.panes.length < tabs.MAX_PANES) {
      kept = tabs.keepFloatingBeside(ws, target.side);
    } else {
      const pane = tabs.paneById(ws, target.pane);
      if (!pane) return;
      kept = tabs.keepFloating(ws, pane, pane.tabs.length);
    }
    if (kept) await activateTab(kept.id);
    return;
  }
  if ("index" in target) {
    const pane = tabs.paneById(ws, target.pane);
    if (!pane) return;
    tab = tabs.insertAt(ws, pane, content, target.index);
  } else if (ws.panes.length < tabs.MAX_PANES) {
    const existing = tabs.isSingleton(content) ? tabs.findAnywhere(ws, content) : undefined;
    if (existing) {
      tab = existing;
    } else {
      const pane = tabs.makePane([tabs.makeTab(content)]);
      if (target.side === "left") ws.panes.unshift(pane);
      else ws.panes.push(pane);
      tab = pane.tabs[0];
    }
  } else {
    const pane = tabs.paneById(ws, target.pane);
    if (!pane) return;
    tab = tabs.insertAt(ws, pane, content, pane.tabs.length);
  }
  await activateTab(tab.id);
}

/**
 * Focus a pane without changing its tab (a click inside it). A note in
 * front becomes the open note, so the Notes list and ⌘S follow it; a chat
 * in front that is not the open one stays a card — focus alone must not
 * swap the backend's session under a running turn.
 */
export function focusPane(paneId: string): void {
  const ws = app.tabs;
  if (ws.focused === paneId) return;
  const pane = tabs.paneById(ws, paneId);
  if (!pane) return;
  ws.focused = paneId;
  const c = tabs.activeTab(pane).content;
  if (c.kind === "chat") {
    // The live chat in front: the view follows it; a card stays a card.
    if (c.session === app.activeSessionId && app.view !== "chat") leaveNote();
  } else if (c.kind !== "project" && c.kind !== "aside" && c.kind !== "attachment") {
    // A note or one of the whole-centre pages (backlog 140): the view
    // follows the pane, as it did for a note. A project card, an aside
    // and an attachment (backlog 145) are drawn from the tab alone;
    // nothing global follows them.
    void showContentOf(c);
  }
}

/** ⌘T: a new chat in a new tab beside the active one. */
export async function newTab(): Promise<void> {
  // ~~Refused while a turn runs~~ — since backlog 159 New chat opens as a
  // view, the running chat parked; the one refusal is the pending
  // chat's own first turn (one pending slot per project and kind).
  // Lifted once the turn can go to the background (backlog 159, A2).
  if (app.busy && !app.parked && app.activeSessionId === null && !canLeaveRunning()) {
    addToast("This chat is having its first turn — New chat opens when it ends");
    return;
  }
  app.openNext = "new";
  const front = tabs.activeTab(tabs.focusedPane(app.tabs));
  // Already on the new-chat page: the reflection would find the same
  // content and do nothing, and the key would seem dead. Open a second
  // pane's worth of nothing? No — the one new chat is the one new chat.
  if (front.content.kind === "chat" && front.content.session === null && app.view === "chat") {
    app.openNext = "replace";
    return;
  }
  await newSession();
  if (app.error) app.openNext = "replace";
}

/**
 * ⌘W: close a tab — the focused pane's active one when none is named.
 * A running turn's chat cannot be left (the neighbour could not be
 * opened under it), so that one tab waits; every other closes at once,
 * and a background chat's turn keeps running. The neighbour that lands
 * is shown through `activateTab`.
 */
export async function closeTab(tabId?: string): Promise<void> {
  const ws = app.tabs;
  const id = tabId ?? tabs.activeTab(tabs.focusedPane(ws)).id;
  const tab = tabs.tabById(ws, id);
  if (!tab) return;
  const live = tabs.liveTab(ws, app.activeSessionId);
  if (app.busy && live?.id === id) {
    addToast("This chat's turn is running — stop it or wait, then close the tab");
    return;
  }
  // The sole tab, already the new-chat page (backlog 140 — the × he
  // found dead on `b6a9c07`): the model would swap it for an identical
  // one and nothing would show. Say so instead; the window closes from
  // its red light (blocker 183).
  const pane = tabs.paneOf(ws, id);
  if (
    ws.panes.length === 1 &&
    pane?.tabs.length === 1 &&
    tab.content.kind === "chat" &&
    tab.content.session === null &&
    app.view === "chat"
  ) {
    addToast("This is the last tab and it is already a new chat — the window closes from its red light");
    return;
  }
  const r = tabs.close(ws, id);
  if (r.show) await activateTab(r.show.id);
}

/** ⌘⇧] / ⌘⇧[: the next or previous tab, across both panes, wrapping. */
export async function stepTab(dir: 1 | -1): Promise<void> {
  const next = tabs.step(app.tabs, dir);
  if (next) await activateTab(next.id);
}

/** A tab dropped on a strip: reorder, or move into the other pane. */
export async function moveTab(tabId: string, toPaneId: string, index: number): Promise<void> {
  if (!tabs.move(app.tabs, tabId, toPaneId, index)) return;
  await activateTab(tabId);
}

/**
 * Open beside: a second pane holding the tab (a drag to a pane's half,
 * or the menu item on the active tab). With two panes already the tab
 * moves to the other one. A pane's only tab cannot be split off — the
 * model refuses — and the toast says so.
 */
export async function splitTab(tabId: string, side: "left" | "right" = "right"): Promise<void> {
  const ws = app.tabs;
  if (ws.panes.length >= tabs.MAX_PANES) {
    const from = tabs.paneOf(ws, tabId);
    const other = from ? tabs.otherPane(ws, from.id) : undefined;
    if (other) await moveTab(tabId, other.id, other.tabs.length);
    return;
  }
  if (!tabs.split(ws, tabId, side)) {
    addToast("A pane keeps at least one tab — open something else here first");
    return;
  }
  await activateTab(tabId);
}

export async function splitActiveTab(): Promise<void> {
  await splitTab(tabs.activeTab(tabs.focusedPane(app.tabs)).id);
}

/** A deleted chat's tabs go with it; the focused pane lands its neighbour. */
function dropChatTabs(session: string): void {
  for (const r of tabs.dropChat(app.tabs, session)) {
    if (r.show) void activateTab(r.show.id);
  }
  // And its Running-tasks rows (backlog 160: kept until the chat goes).
  app.subagents = app.subagents.filter((r) => r.session !== session);
}

/** A deleted note's tabs, or every vault note's when the vault moves. */
function dropNoteTabs(scope: NoteScope, name?: string): void {
  const gone = tabs
    .allTabs(app.tabs)
    .filter((t) => t.content.kind === "note" && t.content.scope === scope && (name === undefined || t.content.name === name));
  for (const t of gone) {
    const r = tabs.close(app.tabs, t.id);
    if (r.show) void activateTab(r.show.id);
  }
}

/** A forgotten project's card goes (backlog 140). */
function dropProjectTabs(id: string): void {
  for (const r of tabs.dropProject(app.tabs, id)) {
    if (r.show) void activateTab(r.show.id);
  }
}

// ---- the workspace across a quit (nightshift backlog 201) ----

/**
 * The project the workspace in `app.tabs` belongs to, as a store key
 * (`tabsStore.ts`), or null while it belongs to none yet — at launch
 * until `restoreTabs` has run, and during a project switch. Nothing is
 * saved while it is null, so the one New chat tab a launch opens with
 * never overwrites the stored workspace it is about to be replaced by.
 */
let tabsOwner: string | null = null;

/** The key of the open project's workspace. */
function tabsKeyNow(): string {
  return app.project?.id ?? UNFILED_TABS;
}

/**
 * The terminal docks' part (`terminal.svelte.ts` registers it; this file
 * cannot import that one, which imports this): how many shells a pane's
 * dock holds, whether any shell is open, and opening fresh ones.
 */
interface TerminalHooks {
  count(pane: string): number;
  any(): boolean;
  open(pane: string, n: number): Promise<void>;
}
let terminalHooks: TerminalHooks | null = null;
export function registerTerminalHooks(h: TerminalHooks): void {
  terminalHooks = h;
}

/** Write the workspace now, under the project it belongs to. Called on
 *  the keeper's debounce (`tabsKeeper.svelte.ts`), on `pagehide` and
 *  before a project switch replaces it. Best-effort. */
export function flushTabs(): void {
  if (tabsOwner === null || typeof localStorage === "undefined") return;
  // An ephemeral chat still open at the window's close is recorded as
  // private before its tabs are stored (blocker 217, batch D's patch note).
  if (app.activeSessionId !== null) markChatMode(app.activeSessionId, chatMode(app.events));
  const counter = terminalHooks;
  saveWorkspaceFor(
    localStorage,
    tabsOwner,
    snapshot(app.tabs, counter ? (p) => counter.count(p) : undefined, storeTabContent),
  );
}

/**
 * The threads of a chat the aside store writes (`asides.ts`: a draft is
 * not kept, nor a turn still asking with nothing arrived), in its order.
 * An aside thread's id is per window — a relaunch numbers them again —
 * so an aside tab is stored by its thread's place in this list.
 */
function storedThreads(session: string): Aside[] {
  return asidesOf(session).filter(
    (a) =>
      !a.draft &&
      a.turns.some((t) => {
        const asking = t.answer === null && t.error === null && !t.cancelled;
        return !(asking && !(t.answer ?? t.partial).trim());
      }),
  );
}

/** A tab's content as the store keeps it: an aside tab's thread id as the
 *  thread's place (`storedThreads`); -1 for a thread the store will not
 *  keep, which then does not come back. Everything else as it is. */
function storeTabContent(c: TabContent): TabContent | null {
  if (c.kind !== "aside") return c;
  if (isPrivateChat(c.session, app.sessions)) return null; // blocker 217
  if (c.thread === undefined) return c;
  const at = storedThreads(c.session).findIndex((a) => a.id === c.thread);
  return { kind: "aside", session: c.session, thread: at };
}

/**
 * A stored tab's content made live, or null when its target is gone: a
 * chat not on the list, a project or vault note that no longer lists, a
 * forgotten project, an aside thread not in the stash (its place mapped
 * back to this window's id). A web tab reopens at its address; the
 * singletons and the note scopes no list covers are kept.
 */
function resolveTabContent(c: TabContent): TabContent | null {
  const chat = (id: string) => app.sessions.some((s) => s.id === id);
  switch (c.kind) {
    case "chat":
      return c.session === null || chat(c.session) ? c : null;
    case "note":
      if (c.scope === "project") return app.notes.some((n) => n.name === c.name) ? c : null;
      if (c.scope === "knowledge") return app.vault.some((n) => n.name === c.name) ? c : null;
      return c;
    case "project":
      return app.projects.some((p) => p.id === c.id) ? c : null;
    case "aside": {
      if (!chat(c.session)) return null;
      const list = asidesOf(c.session);
      if (c.thread === undefined) return list.length > 0 ? c : null;
      const a = list[c.thread];
      return a ? { kind: "aside", session: c.session, thread: a.id } : null;
    }
    case "attachment":
    case "subagent":
      return chat(c.session) ? c : null;
    case "web":
    case "nightshift":
    case "graph":
    case "new-project":
    // A file tab comes back like the rest (guess pass 2026-09-25, question
    // 20); a file gone since says so in its tab, which reads it again.
    case "file":
      return c;
  }
}

/**
 * Put back the open project's stored workspace (backlog 201): at launch
 * and after a project switch, once the chat, note and project lists are
 * read (they decide which tabs survive). With nothing stored, or nothing
 * that survives, the workspace stays as it is. `show` (the default)
 * brings the focused pane's front tab forward through the tab's own
 * opener — a chat's transcript is read, no turn is started; a caller
 * that keeps the page in front (a switch on the Nightshift page) passes
 * false. At launch only — no shell open yet — the docks' shells reopen,
 * fresh, in the project's folder. A malformed store costs the layout,
 * never the launch.
 */
export async function restoreTabs(opts: { show?: boolean } = {}): Promise<void> {
  const key = tabsKeyNow();
  let reopenShells: { pane: string; count: number }[] = [];
  try {
    const saved = typeof localStorage === "undefined" ? undefined : loadSavedWorkspaces(localStorage)[key];
    const rebuilt = saved ? rebuild(saved, resolveTabContent) : null;
    if (rebuilt) {
      app.tabs = rebuilt.ws;
      reopenShells = rebuilt.shells;
    }
  } catch {
    // The layout is lost; the launch is not.
  }
  tabsOwner = key;
  if (opts.show !== false) {
    try {
      await activateTab(tabs.activeTab(tabs.focusedPane(app.tabs)).id);
    } catch {
      // The tab stays; its content opens on the next click.
    }
  }
  const hooks = terminalHooks;
  if (hooks && reopenShells.length > 0 && !hooks.any()) {
    for (const s of reopenShells) {
      try {
        await hooks.open(s.pane, s.count);
      } catch {
        // A shell that cannot open says so in its own toast.
      }
    }
  }
}

/** The pane a tab is drawn in, for the strip's drag handlers. */
export function paneOfTab(tabId: string): string | null {
  return tabs.paneOf(app.tabs, tabId)?.id ?? null;
}

/**
 * A drag source outside the strips (backlog 140 pass 2): the row or
 * button calls this from `dragstart` with what it stands for, and
 * `endContentDrag` from `dragend`. The descriptor rides in the drag
 * under `CONTENT_DRAG` and is mirrored in `app.draggingContent` for the
 * strips' and halves' `dragover`, which cannot read the data.
 */
export function startContentDrag(e: DragEvent, content: TabContent): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(tabs.CONTENT_DRAG, JSON.stringify(content));
  e.dataTransfer.effectAllowed = "copy";
  app.draggingContent = content;
}

export function endContentDrag(): void {
  app.draggingContent = null;
}

/** The content a drop carries: the drag's data, else the mirror. */
export function droppedContent(e: DragEvent): TabContent | null {
  return tabs.parseContentDrag(e.dataTransfer?.getData(tabs.CONTENT_DRAG)) ?? app.draggingContent;
}

/**
 * Whether a chat's aside thread is showing in a tab of its own (backlog
 * 130 part 2) or in the side panel (backlog 141 pass 2): the transcript
 * hides its card while one is, and shows it again when the tab or the
 * panel closes — the thread itself never moves (blocker 194).
 */
export function asideInTab(session: string | null, thread?: number): boolean {
  if (session === null) return false;
  // Several threads per chat (backlog 176): with `thread`, only that
  // thread's tab or panel counts; a tab or panel naming no thread shows
  // the chat's front one.
  const front = asideOf(session)?.id;
  const shows = (named: number | null | undefined) => thread === undefined || (named ?? front) === thread;
  if (app.asidePanel === session && shows(app.asidePanelThread)) return true;
  return tabs
    .allTabs(app.tabs)
    .some((t) => t.content.kind === "aside" && t.content.session === session && shows(asideTabThread(t.content)));
}

/** The thread an aside tab names (backlog 176); absent on a tab made
 *  before threads had ids. Read loosely so `tabs.ts` may name it or not. */
export function asideTabThread(content: TabContent): number | undefined {
  const t = (content as { thread?: unknown }).thread;
  return typeof t === "number" ? t : undefined;
}

/** A chat's aside threads, oldest first: the open chat's cards, or a
 *  stashed chat's list (backlog 176). */
export function asidesOf(session: string): Aside[] {
  if (session === app.activeSessionId) return app.asides;
  return asideStash.get(session) ?? [];
}

/**
 * The aside thread a tab shows: the open chat's card, or the stashed
 * thread of a chat that is not open (read-only there — the backend forks
 * the open chat, so a follow-up needs the chat in front).
 */
export function asideOf(session: string, thread?: number | null): Aside | null {
  const list = asidesOf(session);
  // Since backlog 176: the thread named, else the chat's front (newest).
  if (thread !== undefined && thread !== null) return list.find((a) => a.id === thread) ?? null;
  return list[list.length - 1] ?? null;
}

// ---- nightshift ----

export function showNightshift(): void {
  app.view = "nightshift";
  app.leftTab = "nightshift";
  app.openNote = null;
  // The page is a tab (backlog 140): one in the workspace; a second
  // click activates it wherever it sits. Landed here as well as by the
  // effect, so the click works when the view is already Nightshift but
  // its tab is in the background of the other pane.
  reflectTabs();
  void refreshNightshift();
}

/**
 * ~~Leave the Nightshift page for the chat.~~ Since backlog 140 the page
 * is a tab and the sidebar's Chats and Notes modes no longer leave it;
 * this remains for the one caller that means "the chat, now".
 */
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
  // The page's notice leaves the bell (nightshift backlog 069).
  app.centre.notices = app.centre.notices.filter((n) => n.id !== `morning:${id}:${name}`);
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

/**
 * New chat: leave the open one and say what kind the next one will be.
 * `mode` absent is an ordinary one; `incognito` and `ephemeral` are the
 * two kinds that write nothing (see `ChatMode`).
 *
 * Nothing is created and the list is not refreshed (nightshift backlog
 * 061, 2026-09-15). Until today this made the log at once and the sidebar
 * filled with empty rows, one per click. Now the click is a state — no
 * chat open, `pendingMode` set, the sidebar's New chat drawn as the
 * selected item — and the first message creates the log in that kind;
 * `send` picks the id off the transcript it fetches back and refreshes the
 * list then, which is when the row appears with its name. Clicking twice
 * is the same state twice. The backend is told so it drops its session and
 * records the same kind (`AppState::pending_mode`).
 *
 * The transcript is `[]`, not a fetched creation line: there is no line
 * yet, so `chatMode` reads `pendingMode` instead, and the top bar's mark,
 * the Context page's caveat and the reconnect that strips the engine's
 * writers all see the pending kind through it.
 */
export async function newSession(mode?: ChatMode, kind?: ChatKind): Promise<void> {
  if (app.busy) {
    await peekNew(mode, kind);
    return;
  }
  // The kind is the second axis (nightshift backlog 102): absent means the
  // project's default — Claude Code where there is a folder, Chat where
  // there is none — never the backend's `build`, so the wide button and
  // the privacy rows make the kind the sidebar's dot shows.
  const wanted = kind ?? defaultKind();
  try {
    await api.newSession(mode, wanted);
    // The aside thread stays with the chat being left (backlog 130).
    switchAside(null);
    app.activeSessionId = null;
    app.events = [];
    app.pendingMode = mode ?? "normal";
    app.pendingKind = wanted;
    app.error = null;
    app.agentTurn = null;
    app.agentInit = null;
    // ~~`app.subagents = []`~~ — rows are per chat since backlog 160.
    app.suggestion = null;
    leaveNote();
  } catch (e) {
    app.error = String(e);
  }
}

/**
 * What the open chat was started as, projected from the log the way
 * `Session::mode()` projects it in the core: the first `session_created`
 * line's `mode`, `normal` when it carries none — and, when there is no
 * chat yet, the kind the next one will be (`app.pendingMode`), the same
 * fallback the backend's `session_mode` makes. A rewind cannot reach the
 * creation line, so this never reads the live flags.
 */
export function chatMode(events: SessionEvent[]): ChatMode {
  for (const e of events) {
    if (e.event === "session_created") return e.mode ?? "normal";
  }
  return app.pendingMode;
}

/**
 * What the open chat is for (nightshift backlog 102), projected from the
 * log: ~~the creation line's `kind`~~ — since backlog 144 (2026-09-17) the
 * latest live `kind` event, as `Session::kind()` reads it in the core, and
 * only where there is none the creation line's (`build` when it carries
 * none), and the pending kind while there is no chat yet. Live, like a
 * title: a rewind past a switch restores the kind before it.
 */
export function chatKind(events: SessionEvent[]): ChatKind {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "kind") return e.kind;
  }
  return bornKind(events);
}

/** What the chat was started as — the creation line, which a switch never
 *  rewrites — or the pending kind with no chat open. */
export function bornKind(events: SessionEvent[]): ChatKind {
  for (const e of events) {
    if (e.event === "session_created") return e.kind ?? "build";
  }
  return app.pendingKind;
}

/**
 * What the engine's request is *built* for (`Session::declared_kind`,
 * nightshift backlog 144): `build` once the chat was born one or has ever
 * been switched to one over the live events, else `chat`. A switch changes
 * the policy (`chatKind`) and leaves this alone, so the declared tools and
 * the system prompt — and with them the cached prefix — survive it; the
 * one switch that changes it is a chat born as a Chat becoming Claude
 * Code, which pays one re-warm (`kindSwitchCost`).
 */
export function declaredKind(events: SessionEvent[]): ChatKind {
  if (bornKind(events) === "build") return "build";
  const live = liveFlags(events);
  return events.some((e, i) => live[i] && e.event === "kind" && e.kind === "build")
    ? "build"
    : "chat";
}

/**
 * What switching the open chat to `kind` would cost on the next turn, in
 * tokens written to the cache — `contextUsed()` when the declaration
 * changes (a chat born as a Chat becoming Claude Code: the tools were
 * never declared), and nothing otherwise, since the switch is a policy
 * over an unchanged request. Null when nothing has been sent yet.
 */
export function kindSwitchCost(events: SessionEvent[], kind: ChatKind): number | null {
  if (kind === declaredKind(events)) return 0;
  if (kind === "chat") return 0;
  return contextUsed() ?? null;
}

/**
 * Make the open chat the other kind from the next turn on (nightshift
 * backlog 144; blocker 143 answered *switchable*). The same two steps as
 * a layer switch: the log first (creating the chat's log if the first
 * send has not yet), then the reconnect that reads it back — `connect` /
 * `connect_agent` build the declaration from `declaredKind` and enforce
 * `chatKind` over it. `workspace` is the folder for a switch to Claude
 * Code on a chat born as a Chat; the project's when omitted. Undoable,
 * scoped to the chat; a switch on a live turn is refused like a layer
 * change.
 */
export async function switchChatKind(kind: ChatKind, workspace?: string): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = chatKind(app.events);
  const before = kindWorkspace(app.events);
  if (kind === current && (workspace ?? null) === before) return;
  if (!(await applyKind(kind, workspace))) return;
  pushUndo(chatScope(), {
    label: `kind → ${kind === "chat" ? "Chat" : "Claude Code"}`,
    undo: async () => {
      await applyKind(current, before ?? undefined);
    },
    redo: async () => {
      await applyKind(kind, workspace);
    },
  });
}

/** The folder the latest live switch to Claude Code named, if any. */
export function kindWorkspace(events: SessionEvent[]): string | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "kind") return e.kind === "build" ? (e.workspace ?? null) : null;
  }
  return null;
}

/** The two steps of a kind switch: the log, then the reconnect that reads
 *  it back. False on a refusal, toasted. */
async function applyKind(kind: ChatKind, workspace?: string): Promise<boolean> {
  try {
    app.events = await api.setChatKind(kind, workspace);
    const first = app.events[0];
    if (first && first.event === "session_created") app.activeSessionId = first.id;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * The extra folders the open chat has granted itself (nightshift backlog
 * 143), projected from the log as `Session::folders()` projects them: the
 * latest live `folders` event, or none. The project's own are on
 * `app.project.extra_folders`; the connection's `folders` is the union
 * the backend granted, with each one's source and alias.
 */
export function chatFolders(events: SessionEvent[]): string[] {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "folders") return e.folders;
  }
  return [];
}

/**
 * Set the open chat's extra folders — the whole list (backlog 143). The
 * same two steps as a layer switch: the log first, creating the chat's
 * log if the first send has not yet, then the reconnect that grants each
 * folder on the engine in use. Undoable, scoped to the chat.
 */
export async function setChatFolders(folders: string[]): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = chatFolders(app.events);
  const wanted = folders.filter((f, i) => f.trim() !== "" && folders.indexOf(f) === i);
  if (wanted.join("\n") === current.join("\n")) return;
  if (!(await applyFolders(wanted))) return;
  pushUndo(chatScope(), {
    label: wanted.length > current.length ? "add a folder" : "remove a folder",
    undo: async () => {
      await applyFolders(current);
    },
    redo: async () => {
      await applyFolders(wanted);
    },
  });
}

async function applyFolders(folders: string[]): Promise<boolean> {
  try {
    app.events = await api.setChatFolders(folders);
    const first = app.events[0];
    if (first && first.event === "session_created") app.activeSessionId = first.id;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * Set the open project's extra folders — the whole list (backlog 143);
 * the registry is written, `app.project` picks the new shape up, and the
 * open chat reconnects so the grant reaches it now rather than at its
 * next open. Nothing to do without a project.
 */
export async function setProjectFolders(folders: string[]): Promise<void> {
  const project = app.project;
  if (!project || app.busy || app.connecting) return;
  try {
    const updated = await api.setProjectFolders(project.id, folders);
    app.project = updated;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  await applyDraft();
}

/**
 * The kind a New chat makes when nothing said otherwise (backlog 102's
 * definition of done): Claude Code in a project with a folder of its own,
 * Chat unfiled or in a project that has none — a folderless project is
 * notes and chats only, which is what a Chat is for. The import's
 * "Unfiled chats" holder counts as unfiled though the consolidation (114)
 * gave it a folder — the walk of 2026-09-25 found Claude Code the default
 * there.
 */
export function defaultKind(): ChatKind {
  return app.project?.root && !app.project.unfiled ? "build" : "chat";
}

/**
 * What a kind is called on screen, per engine (his naming, 2026-09-16):
 * on the subscription engine the build kind *is* Claude Code and the other
 * is Chat; on the provider engine (blocker 139's default: the dial on
 * both) the pair reads Build · Chat. `engine` is the connection's
 * `engine` field, or the draft's when nothing is connected yet.
 */
export function kindLabel(kind: ChatKind, engine: string | null | undefined): string {
  if (kind === "chat") return "Chat";
  return engine === "claude-code" ? "Claude Code" : "Build";
}

/** One line on what a kind means, for the places that offer it. */
export const KIND_LINES: Record<ChatKind, string> = {
  build: "the project folder · all tools · Ask / Auto · plans",
  chat: "reads only · Nightloom's tools · the web · no folder",
};

/**
 * The sidebar's New chat button is the selected item while no chat is open
 * — it is the "tab" being pressed until the first message lands a row —
 * and it carries the pending kind's glyph when that is not the ordinary
 * one. Two small projections rather than template expressions, so the
 * suite can pin them without a DOM.
 */
export function newChatSelected(): boolean {
  return app.activeSessionId === null;
}

export function newChatLabel(): string {
  const glyph = MODE_GLYPH[app.pendingMode];
  return glyph ? `New chat ${glyph}` : "New chat";
}

/** One line on what a mode means, for the places that offer it. */
export const MODE_LINES: Record<ChatMode, string> = {
  normal: "kept, indexed, remembered",
  incognito: "kept and marked; writes nothing, unread by other chats",
  ephemeral: "nothing is kept; gone when you close it",
};

/** The glyph a mark carries: half-shaded for kept-but-hidden, a dotted ring
 *  for there-and-not-there. Text, so it renders in a mono meta line and the
 *  top bar alike. Empty for a normal chat, which is not marked. */
export const MODE_GLYPH: Record<ChatMode, string> = {
  normal: "",
  incognito: "◐",
  ephemeral: "◌",
};

/**
 * Continue the open chat in a fresh, linked one after the hand-off
 * (nightshift backlog 086): the *Continue in a new chat* card. The new
 * chat opens with the model's own start prompt — the last `start-prompt`
 * block of the wrap-up reply, kept by `noteAgentTurnEnd` — in its box,
 * never sent (blocker 120, answering blocker 092). ~~with "Read HANDOFF.md
 * and continue." in its box~~ (pass 1). No block in the reply: the box is
 * left empty, a toast says so, and the composer's hint line repeats it
 * until he types.
 *
 * Since backlog 193 (2026-09-25) the box holds the read order first — the
 * Settings default or the wrapped chat's own (`handoff.svelte.ts`
 * `readOrder`) — then the model's start prompt; with no block, the read
 * order alone, and the toast still says the block was missing. A read
 * order of the chat's own goes on to the new chat.
 */
export async function continueChat(): Promise<void> {
  if (app.busy) return;
  try {
    const start = handoff.startPrompt;
    const from = handoff.chat ?? app.activeSessionId;
    const lead = readOrder(from);
    const res = await api.continueSession();
    // The aside thread stays with the chat being left (backlog 130).
    switchAside(res.session);
    app.events = res.events;
    app.activeSessionId = res.session;
    app.error = null;
    app.agentTurn = null;
    app.agentInit = null;
    // ~~`app.subagents = []`~~ — rows are per chat since backlog 160.
    app.suggestion = null;
    resetHandoff();
    carryReadOrder(from, res.session);
    const first = firstMessage(lead, start);
    if (first) setDraftText(res.session, first);
    if (!start) {
      handoff.noStartPromptChat = res.session;
      addToast(
        first
          ? "The wrap-up reply had no start-prompt block — the new chat's box holds only the read order; say what to do first."
          : "The wrap-up reply had no start-prompt block — the new chat's box is empty; say what to read first.",
      );
    }
    leaveNote();
  } catch (e) {
    addToast(String(e));
    return;
  }
  void refreshSessions();
}

/** The running chat's name, for the toast that says where the turn is. */
export function runningChatName(): string {
  const id = app.parked ? app.parked.session : app.activeSessionId;
  if (id === null) return "the new chat";
  const s = app.sessions.find((x) => x.id === id);
  return s ? chatName(s.title, s.first_user) : "another chat";
}

/** Set the running chat aside: its log, its stream, its pending kind. */
function park(): void {
  if (app.parked) return;
  app.parked = {
    session: app.activeSessionId,
    pendingMode: app.pendingMode,
    pendingKind: app.pendingKind,
    events: app.events,
    live: app.live,
    liveUsage: app.liveUsage,
  };
  app.live = null;
  app.liveUsage = null;
}

/** The running chat back on screen, its reply where it got to; the
 *  backend's open chat follows it (backlog 159, A1 — `open_session` is a
 *  focus now and answers during the turn). A New chat's first turn has
 *  no id on this side yet; the backend names it (`turn_session`). */
async function unpark(): Promise<void> {
  const p = app.parked;
  if (!p) return;
  app.parked = null;
  switchAside(p.session);
  app.activeSessionId = p.session;
  app.pendingMode = p.pendingMode;
  app.pendingKind = p.pendingKind;
  app.events = p.events;
  app.live = p.live;
  app.liveUsage = p.liveUsage;
  app.liveVersion++;
  app.error = null;
  leaveNote();
  await refocus(p.session);
}

/** Point the backend's open chat at the running one again (backlog 159,
 *  A1). Best-effort: the turn's end re-aligns the backend anyway. */
async function refocus(session: string | null): Promise<void> {
  try {
    const id = session ?? (await api.turnSession());
    if (id !== null) await api.openSession(id);
  } catch {
    // the turn's end re-aligns (`settleTurnView`)
  }
}

/** A Claude Code turn the window started (backlog 159, A2): the chat it
 *  runs in — learned from its first event on a New chat — and whether it
 *  is off screen now. */
interface TurnCtx {
  chat: string | null;
  detached: boolean;
  /** The window's own name for the turn (A3), sent with it: what its Stop
   *  names until the chat is known. */
  key: string;
  /** The model and engine it started on (backlog 205): a New chat's first
   *  turn records them for the chat it makes. */
  choice?: ChatChoice;
}

let turnKeys = 0;
function newTurnKey(): string {
  turnKeys += 1;
  return `turn:${Date.now().toString(36)}-${turnKeys}`;
}

/** What a Stop for the turn on screen names (A3): its chat, or its turn
 *  key before the chat is known — never nothing, which the backend reads
 *  as "the latest turn", possibly another chat's. `null` only when no
 *  Claude Code turn runs here (the provider engine, a compaction). */
export function stopTarget(t: { chat: string | null; key: string } | null): string | null {
  return t ? (t.chat ?? t.key) : null;
}

/** The turn on screen (or parked), if one runs. */
let fg: TurnCtx | null = null;
/** The turns in `app.background`, by chat. */
const bgTurns = new Map<string, TurnCtx>();

/** The background turn's chat id that `chat` names (the full id or a
 *  prefix, as the phone may send), or `null` when that chat is not
 *  running in the background (A3). */
export function backgroundTurnOf(chat: string): string | null {
  if (bgTurns.has(chat)) return chat;
  const hits = [...bgTurns.keys()].filter((id) => id.startsWith(chat));
  return hits.length === 1 ? hits[0] : null;
}

/** A background chat's name, for its toasts. */
function backgroundName(id: string): string {
  const s = app.sessions.find((x) => x.id === id);
  return s ? chatName(s.title, s.first_user) : "another chat";
}

/** Whether a chat can be opened while a turn runs without parking it —
 *  the Claude Code engine's turns go to the background (A2). */
export function browseFree(): boolean {
  return app.connection?.engine === "claude-code";
}

/** Whether the turn on screen can go to the background right now (A2):
 *  what lifts the New-chat refusals during a New chat's first turn. */
export function canLeaveRunning(): boolean {
  return !app.busy || (fg !== null && !app.parked && canDetach(app.connection?.engine, fg.chat));
}

/**
 * The turn on screen to the background (backlog 159, A2): its view kept
 * under its chat's id, the window idle for the chat he opens next. False
 * when it cannot go (`canDetach`): the caller parks it instead.
 */
function detach(): boolean {
  const t = fg;
  if (!t || app.parked || !canDetach(app.connection?.engine, t.chat)) return false;
  const id = t.chat as string;
  // A New chat's first turn: its tab still says "New chat", and the next
  // New chat would land in it (one new-chat tab per pane). The tab takes
  // the chat's id first, as the turn's end would have given it.
  // The tab is retitled here and the reflection skipped for this one
  // change (`activating`), so the opener's "new tab" is still armed for
  // the chat he is opening.
  if (app.activeSessionId === null) {
    const tab = tabs.activeTab(tabs.focusedPane(app.tabs));
    if (tab.content.kind === "chat" && tab.content.session === null) tab.content = { kind: "chat", session: id };
    activating++;
    app.activeSessionId = id;
    void tick().then(() => activating--);
  }
  const mine = (r: ApprovalRequest) => !r.chat || r.chat === id;
  app.background[id] = {
    session: id,
    pendingMode: app.pendingMode,
    pendingKind: app.pendingKind,
    events: app.events,
    live: app.live,
    liveUsage: app.liveUsage,
    approvals: app.pendingApprovals.filter(mine),
  };
  app.pendingApprovals = app.pendingApprovals.filter((r) => !mine(r));
  t.detached = true;
  bgTurns.set(id, t);
  fg = null;
  app.live = null;
  app.liveUsage = null;
  app.busy = false;
  return true;
}

/** A parked turn whose chat has just been named goes to the background,
 *  so the chat on screen stops waiting on it (A2). */
function promoteParked(): void {
  const t = fg;
  const p = app.parked;
  if (!t || !p || !canDetach(app.connection?.engine, t.chat)) return;
  const id = t.chat as string;
  app.background[id] = { ...p, session: id, approvals: app.pendingApprovals.filter((r) => !r.chat || r.chat === id) };
  app.pendingApprovals = app.pendingApprovals.filter((r) => r.chat && r.chat !== id);
  app.parked = null;
  t.detached = true;
  bgTurns.set(id, t);
  fg = null;
  app.busy = false;
}

/** A background chat back on screen, streaming (A2); whatever turn was on
 *  screen goes to the background in its place. */
async function attach(id: string): Promise<void> {
  const b = app.background[id];
  const t = bgTurns.get(id);
  if (!b || !t) return;
  if (app.busy && !detach()) {
    addToast("A turn is just starting here — open that chat again in a moment");
    app.openNext = "replace";
    return;
  }
  delete app.background[id];
  bgTurns.delete(id);
  t.detached = false;
  fg = t;
  switchAside(id);
  app.activeSessionId = id;
  app.pendingMode = b.pendingMode;
  app.pendingKind = b.pendingKind;
  app.events = b.events;
  app.live = b.live;
  app.liveUsage = b.liveUsage;
  app.pendingApprovals.push(...b.approvals);
  app.busy = true;
  app.liveVersion++;
  app.error = null;
  app.suggestion = null;
  leaveNote();
  await refocus(id);
}

/** A background turn's end (A2): nothing on screen changes; the chat's
 *  record is on disk (or held, for an ephemeral chat), its row refreshes,
 *  and a light toast says where the reply is. */
function endBackground(t: TurnCtx, failed: string | null, notices: string[]): void {
  const id = t.chat as string;
  const b = app.background[id];
  delete app.background[id];
  bgTurns.delete(id);
  const used = b?.liveUsage ? b.liveUsage.input_tokens + b.liveUsage.output_tokens : null;
  addToast(backgroundEndToast(backgroundName(id), failed));
  for (const n of notices) addToast(n);
  void refreshSessions();
  void refreshNotes();
  void refreshPlanUsage(true);
  noteAgentTurnEnd(id, used, app.connection?.contextLimit ?? null, null);
}

/**
 * Another chat on screen while a turn runs (backlog 159, pass 1): its log
 * read from disk, the running chat parked; the running chat asked for
 * again comes back with its stream.
 *
 * ~~`peek_session`, a reader that opens nothing~~ — since pass 2 step A1
 * (2026-09-24) the backend holds each chat behind its own lock and
 * `open_session` is a focus that answers during the turn, so the chat on
 * screen is the backend's open chat too: the prompt layers, the context
 * page and the other commands of the open chat act on it at once.
 */
async function peekSession(id: string): Promise<void> {
  if (app.background[id]) {
    await attach(id);
    return;
  }
  // The running chat to the background, and the chat opens as it would
  // with nothing running (backlog 159, A2).
  if (id !== app.activeSessionId && detach()) {
    await openSession(id);
    return;
  }
  if (id === app.activeSessionId) {
    if (app.view !== "chat") leaveNote();
    app.openNext = "replace";
    return;
  }
  if (app.parked && id === app.parked.session) {
    await unpark();
    return;
  }
  try {
    const events = await api.openSession(id);
    park();
    switchAside(id);
    app.activeSessionId = id;
    app.events = events;
    // Its recorded agents, as `openSession` (backlog 160).
    app.subagents = mergeRows(app.subagents, rowsFromLog(events, id));
    app.error = null;
    app.suggestion = null;
    leaveNote();
  } catch (e) {
    app.error = String(e);
    app.openNext = "replace";
  }
}

/** New chat on screen while a turn runs: refused only while the running
 *  turn is the pending chat's own first (one pending slot per project
 *  and kind — see `browse.ts`). */
async function peekNew(mode?: ChatMode, kind?: ChatKind): Promise<void> {
  // As `peekSession` (backlog 159, A2): the running chat to the
  // background, New chat as with nothing running.
  if (detach()) {
    await newSession(mode, kind);
    return;
  }
  const running = app.parked ? app.parked.session : app.activeSessionId;
  if (running === null) {
    if (app.parked) {
      await unpark();
      return;
    }
    addToast("This chat is having its first turn — New chat opens when it ends");
    app.openNext = "replace";
    return;
  }
  park();
  switchAside(null);
  app.activeSessionId = null;
  app.events = [];
  app.pendingMode = mode ?? "normal";
  app.pendingKind = kind ?? defaultKind();
  app.error = null;
  app.suggestion = null;
  leaveNote();
  // The backend's open chat is New chat too (backlog 159, A1): it answers
  // during the turn now, and the kind asked for is the one its first
  // message makes. Best-effort: the turn's end re-aligns (`settleTurnView`).
  try {
    await api.newSession(app.pendingMode, app.pendingKind);
  } catch {
    // re-aligned at the turn's end
  }
}

/**
 * The turn's end, for the view (backlog 065, 159): the log re-synced and
 * the pending chat's draft moved to the chat it made — or, when he
 * browsed away, the running chat's record left on disk and the backend
 * re-opened on the chat on screen, so what the composer drains next goes
 * where he is looking. The plan is `settlePlan`'s, which the suite pins.
 */
async function settleTurnView(
  pendingKey: string | null,
  chat: string | null = null,
  choice: ChatChoice | null = null,
): Promise<void> {
  const parked = app.parked;
  app.parked = null;
  try {
    // The chat the turn ran in, whichever is open now (backlog 159, A1:
    // the backend's open chat follows the screen during the turn) — by
    // its id when known (A2: two turns may have run; "the latest" may be
    // the other's).
    const events = chat ? await api.transcript(false, chat) : await api.transcript(true);
    const first = events[0];
    const made = first && first.event === "session_created" ? first.id : null;
    const plan = settlePlan({ parked, viewed: app.activeSessionId, made, pendingKey });
    // A New chat's agents, made before its id was known (backlog 160).
    if (made) adoptPending(app.subagents, made);
    // And the model and engine its first turn ran on (backlog 205), before
    // the view moves to it and the choice is read back.
    if (made && choice) {
      noteMade(chatChoice.choices, made, choice);
      saveChatChoices();
    }
    if (plan.moveDraft) moveDraft(plan.moveDraft[0], plan.moveDraft[1]);
    if (plan.adopt) app.events = events;
    if (plan.activeSessionId !== undefined) app.activeSessionId = plan.activeSessionId;
    if (plan.realign?.kind === "open") app.events = await api.openSession(plan.realign.id);
    else if (plan.realign?.kind === "new") await api.newSession(app.pendingMode, app.pendingKind);
  } catch {
    // keep the locally-built view if re-sync fails
  }
}

export async function openSession(id: string): Promise<void> {
  if (app.background[id]) {
    await attach(id);
    return;
  }
  if (app.busy) {
    await peekSession(id);
    return;
  }
  // A ⌘-click's "open in a new tab" (`app.openNext`, backlog 099) is
  // consumed by the tab reflection, which runs only when the open changes
  // the view or the chat. Opening the chat already in front changes
  // neither, and a failed open changes nothing — so the modifier would
  // stay armed and the *next* plain click would open a tab (review E,
  // 2026-09-17). Both paths hand it back here; `newTab` does the same.
  const inFront = id === app.activeSessionId && app.view === "chat";
  try {
    app.events = await api.openSession(id);
    // The aside thread stays with the chat being left and the opened
    // chat's comes back (backlog 130).
    switchAside(id);
    app.activeSessionId = id;
    app.error = null;
    // The chat's checkpoint, for the transcript's marker (backlog 104).
    void readCheckpoint(id);
    // The plan window and estimate belong to the chat you just left.
    app.agentTurn = null;
    app.agentInit = null;
    // ~~`app.subagents = []`~~ (backlog 160): the rows stay, keyed by
    // chat, and this chat's recorded agents join them from its log.
    app.subagents = mergeRows(app.subagents, rowsFromLog(app.events, id));
    app.suggestion = null;
    leaveNote();
    if (inFront) app.openNext = "replace";
  } catch (e) {
    app.error = String(e);
    app.openNext = "replace";
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
  let full: string;
  try {
    full = await api.deleteSession(id, app.activeSessionId);
    if (id === app.activeSessionId || full === app.activeSessionId) {
      switchAside(null); // its asides stay its own (backlog 203), for the undo
      app.activeSessionId = null;
      app.events = [];
    }
    dropChatTabs(full);
  } catch (e) {
    addToast(String(e));
    await refreshSessions();
    return;
  }
  await refreshSessions();
  // A delete is a move to the trash, so its undo is the move back — and,
  // when nothing is open, the chat reopened, since that is where the user
  // was. On the list's stack: after the delete there is no chat to hold it.
  pushUndo(LIST_SCOPE, {
    label: "delete",
    undo: async () => {
      await api.restoreSession(full);
      await refreshSessions();
      if (app.activeSessionId === null) await openSession(full);
    },
    redo: async () => {
      await api.deleteSession(full, app.activeSessionId);
      if (full === app.activeSessionId) {
        switchAside(null);
        app.activeSessionId = null;
        app.events = [];
      }
      await refreshSessions();
    },
  });
}

/**
 * A message from the phone (backlog 091): for the open chat, or for one
 * that is opened first. `openSession` refuses while a turn runs (blocker
 * 182) and can fail; either way the chat asked for is not the one open,
 * and the words must be held under *its* key — before review E
 * (2026-09-17) they were queued under the open chat's and went into it
 * at that turn's end. ~~Held this way they show in the asked-for chat's
 * queue when it is opened, and go with its next send or *Send next*.~~
 * Since backlog 132 (2026-09-17) the phone is told instead: the answer
 * is `"sent"` (the turn starts), `"queued"` (the open chat is running a
 * turn; the message is in its composer queue and goes when that turn
 * ends), or a thrown sentence — the chat asked for could not be opened
 * (busy in another chat, a bad id), or no engine is connected — and the
 * listener turns that into a 409, so the phone keeps the text in its own
 * queue and tries again when the Mac is idle. Nothing is held here for a
 * chat that is not open: that queue drained only when he opened the chat
 * and pressed Send next, which the phone could not see.
 */
export async function remoteSend(chat: string | null, text: string): Promise<"sent" | "queued"> {
  if (chat && chat !== app.activeSessionId) {
    if (app.busy) throw new Error("the desktop is busy in another chat — held on the phone until it is free");
    await openSession(chat);
    if (chat !== app.activeSessionId) {
      throw new Error(app.error ? `the desktop could not open that chat: ${app.error}` : "the desktop could not open that chat");
    }
  }
  if (app.busy) {
    enqueueMessage(draftKey(app.activeSessionId, app.project?.id, app.pendingMode), text, []);
    return "queued";
  }
  if (!app.connection) throw new Error("no engine is connected on the desktop — connect one there first");
  // Answered before the turn, not after: `send` resolves at the turn's
  // end, and the phone is waiting to hear the message was taken.
  void sendUntyped(text);
  return "sent";
}

/**
 * Resume a turn the usage limit paused (nightshift backlog 164): sends the
 * continue that names the subagents that died. Before the window has
 * reset it is scheduled for the reset plus a margin — never into a window
 * that is still exhausted — and `app.limitResumeAt` says so on the card;
 * a second click while it waits cancels. A chat switch under a scheduled
 * resume leaves it: it sends into the chat that was paused only if that
 * chat is still the open one when the time comes, else it is dropped
 * with a toast, since a turn cannot start in a chat that is not open.
 */
let limitTimer: ReturnType<typeof setTimeout> | null = null;
export function resumeAfterLimit(): void {
  const p = app.limitPause;
  if (!p) return;
  if (limitTimer !== null) {
    clearTimeout(limitTimer);
    limitTimer = null;
    app.limitResumeAt = null;
    return;
  }
  const go = () => {
    limitTimer = null;
    app.limitResumeAt = null;
    if (app.limitPause !== p) return;
    if (app.busy || !app.connection || app.activeSessionId !== p.session) {
      addToast("The paused chat is not open or is busy — open it and press Resume again.");
      return;
    }
    app.limitPause = null;
    void sendUntyped(resumeMessage(p));
  };
  const delay = resumeDelayMs(p);
  if (delay === 0) {
    go();
    return;
  }
  app.limitResumeAt = Date.now() + delay;
  limitTimer = setTimeout(go, delay);
}

/** The chat as a banner names it (nightshift backlog 079): the open
 *  session's title, else the first message of the turn just sent. */
function bannerChat(): string {
  const s = app.sessions.find((x) => x.id === app.activeSessionId);
  const sent = [...app.events].reverse().find((e) => e.event === "user_message");
  return chatName(s?.title, s?.first_user ?? (sent?.event === "user_message" ? sent.text : null));
}

/**
 * The turn-end banner (nightshift backlog 079), read from the live state
 * before `finally` clears it — the segments for the files changed, the
 * last usage for the tokens, the optimistic `user_message`'s `at` for the
 * time. Whether it is posted at all (the window's focus, the setting) is
 * `notify.ts`'s decision.
 */
function notifyTurnEnded(error: string | null): void {
  const sent = [...app.events].reverse().find((e) => e.event === "user_message");
  const since = sent?.event === "user_message" ? Date.parse(sent.at) : NaN;
  // The wrap-up's own turn (backlog 079's third banner, with 193): the
  // hand-off is still `wrapping` in the chat the turn ran in — the turn's
  // end moves it on only after this. A turn the CLI ended with an error
  // wrote no hand-off worth announcing.
  const ranIn = app.parked ? app.parked.session : app.activeSessionId;
  const wrapUp =
    ranIn !== null && handoff.chat === ranIn && handoff.stage === "wrapping" && app.agentTurn?.is_error !== true;
  void notifyTurnEnd({
    chat: bannerChat(),
    segs: app.live?.segments ?? [],
    outTokens: app.liveUsage?.output_tokens ?? null,
    elapsedMs: Number.isNaN(since) ? null : Date.now() - since,
    error,
    handoffFill: wrapUp ? handoff.fill : null,
  });
}

export async function send(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
): Promise<void> {
  if (!app.connection || app.busy) return;
  stopped = false;
  // A turn the model answers is not undoable, and nothing under it is:
  // a rewind lifted from under a reply would put the model in a
  // conversation it never had (nightshift backlog 064).
  history.clear(chatScope());
  app.undoTick++;
  if (app.connection.engine === "claude-code") {
    return sendAgent(text, images, documents, council);
  }
  // The pending chat's draft key, taken now: it names the project and the
  // kind this send is making a chat in (nightshift backlog 094).
  const pendingKey = app.activeSessionId === null ? newDraftKey(app.project?.id, app.pendingMode) : null;
  // The model and engine this turn runs on (backlog 205).
  const choice = choiceOf(app.draft);
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
  app.turnSeq += 1;
  app.busy = true;
  let failed: string | null = null;
  try {
    await api.send(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
    );
  } catch (e) {
    failed = String(e);
    app.error = failed;
  } finally {
    // The banner for an unfocused window (backlog 079), before the live
    // state it reads is cleared.
    notifyTurnEnded(failed);
    app.live = null;
    // The trailing assistant message now carries the same reading.
    app.liveUsage = null;
    // The turn is over: anything still parked was answered by the backend
    // (or died with the turn), so the prompts can no longer decide anything.
    app.pendingApprovals = [];
    app.busy = false;
    // Sessions are created lazily on first send; the id is picked up here.
    await settleTurnView(pendingKey, null, choice);
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
    // Last, once the turn is fully over: was it sleep that ended it
    // (nightshift backlog 101)?
    sleepTurnEnded(failed !== null);
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
async function sendAgent(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
): Promise<void> {
  // ~~The hand-off's wrap-up rides this message when the window has crossed
  // the chat's threshold (nightshift backlog 086); `withWrapUp` also moves
  // the stage on, so it goes exactly once.~~ Superseded 2026-09-16 (pass 2,
  // blocker 120): the wrap-up is a message of its own, sent from the
  // composer's notice or by the queue; nothing is appended here.
  app.suggestion = null;
  // A changed layer is taken at the first cold turn (backlog 174).
  await layersBeforeTurn();
  // Same as `send`: the pending chat's key at the moment of the send
  // (nightshift backlog 094).
  const pendingKey = app.activeSessionId === null ? newDraftKey(app.project?.id, app.pendingMode) : null;
  app.error = null;
  app.events.push({
    event: "user_message",
    text,
    // Same omission as `send`: the backend logs no key for an empty list,
    // and the optimistic entry should project as the re-synced one will.
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    at: new Date().toISOString(),
  });
  // A council turn (nightshift backlog 149): the seats run first, each a
  // row in Running tasks (their `subagent_status` rows arrive on the
  // ordinary `turn-event`), and the chair's reply streams as the turn's
  // own. The live message says so until the chair's first word.
  app.live = {
    segments: council
      ? [
          {
            kind: "notice",
            text: `Council: ${council.seats.length} seats answering in parallel (${council.seats.map((s) => s.model).join(" + ")}) — each is a row in Running tasks; the chair replies when they return.`,
          },
        ]
      : [],
  };
  app.liveUsage = null;
  app.turnSeq += 1;
  app.busy = true;
  // This turn, for the background (backlog 159, A2): he may open another
  // chat while it runs, and send there.
  const turn: TurnCtx = {
    chat: app.activeSessionId,
    detached: false,
    key: newTurnKey(),
    choice: choiceOf(app.draft),
  };
  fg = turn;
  // The budget meter (backlog 165, pass 2) follows this chat's ledger
  // while the turn runs; a chat not yet created has no directory to read.
  budgetTyped = turnTyped;
  startBudgetPoll(app.activeSessionId, turnTyped);
  let failed: string | null = null;
  try {
    const res = await api.sendAgent(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
      council ?? undefined,
      turn.key,
    );
    // Off screen at its end (A2): the chat on screen is another's, and
    // nothing below is about it.
    if (turn.detached) {
      endBackground(turn, null, res.notices);
      return;
    }
    app.agentTurn = res;
    // The turn stopped by the usage limit (backlog 164): marked paused,
    // not failed, with its Resume; any other end clears an old mark.
    app.limitPause = limitPauseFrom(res, app.activeSessionId);
    // The plan chip from this turn's own rate-limit event when the CLI
    // sent one with figures (nightshift backlog 073), else from the files
    // in `finally`.
    const fromTurn = planUsageFromTurn(res.plan);
    if (fromTurn) app.planUsage = fromTurn;
    // The CLI resolves an alias to a real model id, which is the first
    // moment a context window can be looked up at all: `sonnet` is in no
    // limits table and a guessed denominator would promise headroom nobody
    // verified.
    if (app.connection && res.context_limit != null) {
      app.connection.contextLimit = res.context_limit;
    }
    if (app.connection && res.model) app.connection.model = res.model;
    // The folder entrance's two halves (backlog 143, pass 2): a grant the
    // approval card made refreshes the rail's list; a read the CLI refused
    // outside the trees is offered there for a grant after the fact.
    if (app.connection) {
      if (res.folders) app.connection.folders = res.folders;
      app.connection.refused = res.refused ?? [];
    }
    for (const notice of res.notices) addToast(notice);
  } catch (e) {
    failed = String(e);
    if (turn.detached) {
      endBackground(turn, failed, []);
      return;
    }
    app.error = failed;
  } finally {
    if (!turn.detached) await endForeground();
  }
  /** The turn's end with its chat on screen (or parked) — everything that
   *  was this function's `finally` before A2. */
  async function endForeground(): Promise<void> {
    if (fg === turn) fg = null;
    // The banner for an unfocused window (backlog 079), before the live
    // state it reads is cleared.
    notifyTurnEnded(failed);
    app.live = null;
    app.liveUsage = null;
    // As in `send`: a prompt the CLI deferred (backlog 084) is answered or
    // abandoned by the time the turn returns, and one left on screen would
    // answer nothing.
    app.pendingApprovals = [];
    app.busy = false;
    // The chat the turn ran in, and its context reading, taken before the
    // view settles: he may be looking at another chat (backlog 159), and
    // the hand-off's gauge is the running chat's, not the viewed one's.
    const ranIn = app.parked ? app.parked.session : app.activeSessionId;
    const parkedUsed = app.parked?.liveUsage
      ? app.parked.liveUsage.input_tokens + app.parked.liveUsage.output_tokens
      : null;
    const browsed = app.parked !== null;
    await settleTurnView(pendingKey, turn.chat, turn.choice ?? null);
    // The meter's final figure, now that the chat exists and the hook's
    // last write is in (backlog 165, pass 2).
    void readTurnBudget(ranIn ?? app.activeSessionId);
    // The checkpoint the first exchange set, or its uuid now resolved
    // (backlog 104) — for the chat in view.
    if (!app.parked) void readCheckpoint(app.activeSessionId);
    void refreshSessions();
    void refreshNotes();
    // The plan chip follows the turn (nightshift backlog 073) — through
    // the CLI's own `/usage` when the turn brought no figure of its own
    // (his ask, 2026-09-18: "whenever the response finishes hit /usage so
    // the number reflects that"); zero tokens, a few seconds, in the
    // background.
    void refreshPlanUsage(true);
    // The hand-off reads the gauge's pair at each turn's end (backlog 086),
    // and the log, for the start prompt in the wrap-up's own reply (pass 2).
    noteAgentTurnEnd(
      browsed ? ranIn : app.activeSessionId,
      browsed ? parkedUsed : contextUsed(),
      app.connection?.contextLimit ?? null,
      browsed ? null : app.events,
    );
    // Last, once the turn is fully over: was it sleep that ended it
    // (nightshift backlog 101)? The CLI reports a mid-turn network death
    // as its `result` line with `is_error`, not as a rejected send, so
    // both count; `app.agentTurn` is this turn's when the send resolved.
    sleepTurnEnded(failed !== null || app.agentTurn?.is_error === true);
  }
}

/**
 * Ask a side question of the open chat without adding to it (backlog 081):
 * the answer comes from the chat's context off its warm cache, and neither
 * the question nor the answer is in the log or the CLI's session. ~~One at
 * a time~~ — several threads may be open since backlog 176 (2026-09-23),
 * each its own card; the backend's lock still lets **one ask at a time**
 * (blocker 317's default), so a second question waits, its card marked
 * (`asideWaiting`), and a running turn is waited for as before.
 *
 * `draft` is the card's own draft thread when a passage's question box
 * asks: that thread becomes the asked one, in place. Without it a quote
 * opens a new card.
 */
let asideSeq = 0;
export async function askAside(question: string, quote: AsideQuote | null = null, draft: Aside | null = null): Promise<void> {
  const q = question.trim();
  if ((!q && !quote) || app.connection?.engine !== "claude-code") return;
  // From the composer, with an answered thread on the card (backlog 137,
  // blocker 201): the question continues that thread rather than
  // replacing it — the thread is written nowhere else. With several open
  // (backlog 176, blocker 319): the newest composer thread, the one with
  // no passage; a passage's thread is about its passage, not this.
  const on = [...app.asides].reverse().find((a) => a.quote === null && !a.draft) ?? null;
  if (!quote && q && on && !asideAsking(on) && on.turns.some((t) => t.partial.trim())) {
    await followUpAside(q, on);
    return;
  }
  // About a passage (backlog 107): the highlighted text rides inside the
  // one string the backend takes, framed as a selection and quoted
  // exactly (`asideQuestion`); the card keeps his words and the quote
  // apart. The backend is 081's, untouched.
  const sent = quote ? asideQuestion(quote, q) : q;
  const seq = ++asideSeq;
  const turn: AsideTurn = { seq, question: q, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0 };
  // ~~A running exchange is replaced (one at a time): cancelled on the
  // backend~~ — nothing is replaced since backlog 176: the other cards
  // keep their threads, and a running one runs on.
  const own = draft && draft.draft && app.asides.includes(draft) ? draft : null;
  if (own) {
    // The card's draft (backlog 141): asked under its passage, in place.
    own.quote = quote;
    own.draft = false;
    own.turns.push(turn);
  } else {
    openAsideThread({ id: nextAsideId(), quote, draft: false, turns: [turn], anchor: null });
  }
  await runAside(turn, sent);
}

/** A new card for the open chat (backlog 176): appended, the newest, and
 *  the oldest folded past `MAX_OPEN_ASIDES` (blocker 318). */
function openAsideThread(a: Aside): Aside {
  app.asides.push(a);
  const live = app.asides[app.asides.length - 1]!;
  foldCrowd(live);
  syncFrontAside();
  return live;
}

/** Fold the oldest open cards past the cap, never `keep` (blocker 318). */
function foldCrowd(keep: Aside | null): void {
  const list = app.asides;
  const idx = keep ? list.indexOf(keep) : -1;
  for (const i of foldTheOldest(list.map((a) => a.folded === true), idx < 0 ? null : idx, MAX_OPEN_ASIDES)) {
    list[i]!.folded = true;
  }
}

/** A folded card's strip clicked (blocker 318): open, and the oldest other
 *  open card folds if that makes one too many. */
export function unfoldAside(a: Aside): void {
  a.folded = false;
  foldCrowd(a);
}

/** `app.aside`, the front thread, kept equal to the newest of `app.asides`
 *  (backlog 176) for what still reads one card. */
function syncFrontAside(): void {
  app.aside = app.asides[app.asides.length - 1] ?? null;
}

/**
 * Whether the thread's live exchange is waiting for another aside to
 * finish (backlog 176, blocker 317): the backend answers one aside at a
 * time, in the order asked, so an exchange is waiting while an earlier
 * one — on any card, in any chat — is still asking.
 */
export function asideWaiting(a: Aside | null): boolean {
  const t = asideAsking(a);
  if (!t) return false;
  const all = [...app.asides, ...[...asideStash.values()].flat()];
  return all.some((b) => {
    const u = asideAsking(b);
    return u !== null && u.seq < t.seq;
  });
}

/**
 * Run one exchange of the aside to its end (backlog 128): the deltas land
 * through the `aside-delta` listener in `init` while this awaits the
 * result; the result's text then stands in for the partial, so the card
 * shows the whole answer even where a delta was lost. A turn cancelled
 * from the card keeps its partial text and ignores the late result.
 */
async function runAside(turn: AsideTurn, sent: string): Promise<void> {
  const live = () => findAsideTurn(turn.seq);
  try {
    const res = await api.askAside(sent, turn.seq);
    const t = live();
    if (!t || t.cancelled) return; // dismissed, replaced or cancelled meanwhile
    t.answer = res.answer;
    t.partial = res.answer;
    t.error = res.is_error ? (res.notices.join("; ") || "the aside failed") : null;
    t.cacheRead = res.cache_read;
  } catch (e) {
    const t = live();
    if (t && !t.cancelled) t.error = String(e);
  }
}

/**
 * A follow-up in the aside's own thread (nightshift backlog 130): the
 * card's reply box. The CLI's aside is single-shot, so the thread so far
 * — each earlier question and the answer as he saw it, the passage first
 * when there is one — travels inside the new question (`asideFollowUp`),
 * and the chat's context is the fork's as before. The new exchange is
 * appended to the card; nothing enters the chat or the CLI's files.
 */
export async function followUpAside(question: string, thread: Aside | null = null): Promise<void> {
  const q = question.trim();
  // The card's own thread (backlog 176); the front one when none is named.
  const a = thread ?? app.aside;
  if (!q || !a || a.draft || asideAsking(a) || app.connection?.engine !== "claude-code") return;
  const prior = a.turns.filter((t) => t.partial.trim()).map((t) => ({ question: t.question, answer: t.partial }));
  const sent = asideFollowUp(a.quote, prior, q);
  const turn: AsideTurn = { seq: ++asideSeq, question: q, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0 };
  a.turns.push(turn);
  await runAside(turn, sent);
}

/**
 * The aside thread of each chat left open (backlog 130): a chat switch
 * used to clear the card; now the thread is kept under the chat's id, the
 * way drafts are kept (backlog 065), and comes back when the chat does —
 * ~~never written anywhere~~ written to localStorage since backlog 137
 * (2026-09-17, `asides.ts` / `asides.svelte.ts`: text only, debounced,
 * read back here at launch — a relaunch used to drop every thread). A
 * plain map, read once per switch. An exchange still streaming when the
 * chat is left keeps streaming into the stashed thread (`findAsideTurn`
 * looks here too), so the answer is whole when he returns.
 */
export const asideStash: Map<string, Aside[]> =
  typeof localStorage === "undefined" ? new Map() : loadAsides(localStorage);

/**
 * The council roster and mode each chat last used (nightshift backlog
 * 149, blocker 239): the Settings default until the popover changes it
 * for a chat, then that chat's, for the life of the window — the drafts
 * pattern, never persisted. The pending chat (no id yet) shares one slot.
 */
const councilByChat: Map<string, CouncilPrefs> = new Map();
const PENDING_COUNCIL = "\u0000pending";
export function councilFor(chat: string | null): CouncilPrefs {
  return councilByChat.get(chat ?? PENDING_COUNCIL) ?? loadCouncilPrefs();
}
export function setCouncilFor(chat: string | null, prefs: CouncilPrefs): void {
  councilByChat.set(chat ?? PENDING_COUNCIL, structuredClone(prefs));
}

/** Stash the open chat's threads and take the next chat's, if any —
 *  every open thread, not only the front one (backlog 176; 137's FE4).
 *  Exported for the suite; the chat openers call it. */
export function switchAside(next: string | null): void {
  const from = app.activeSessionId;
  if (from !== null) {
    if (app.asides.length > 0) asideStash.set(from, app.asides);
    else asideStash.delete(from);
  }
  app.asides = next === null ? [] : (asideStash.get(next) ?? []);
  syncFrontAside();
}

/** The exchange with `seq`, on a card or in a stashed thread. */
function findAsideTurn(seq: number): AsideTurn | null {
  for (const a of app.asides) {
    const t = a.turns.find((t) => t.seq === seq);
    if (t) return t;
  }
  for (const list of asideStash.values()) {
    for (const a of list) {
      const t = a.turns.find((t) => t.seq === seq);
      if (t) return t;
    }
  }
  return null;
}

/**
 * Open the aside card as a question box about a highlighted passage
 * (backlog 107): the quote is shown, nothing is sent until he asks.
 * ~~A running or answered aside is replaced — one at a time~~ — since
 * backlog 176 (2026-09-23) a new passage opens a **new card** beside the
 * others and replaces nothing; the new card's box takes the caret.
 * Returns the new thread (null off the Claude Code engine).
 */
export function draftAside(quote: AsideQuote, anchor: AsideAnchor | null = null): Aside | null {
  if (app.connection?.engine !== "claude-code") return null;
  // ~~One floating card at a time (backlog 141): a second passage
  // replaces the first's card~~ — each passage its own card (176).
  const a = openAsideThread({ id: nextAsideId(), quote, draft: true, turns: [], anchor });
  app.asideFocus = a.id;
  return a;
}

/**
 * The card's ×. An aside still `asking…` is cancelled on the backend too
 * (whole-project review F13, `cancel_aside`): before this it was only
 * hidden, and the CLI ran its `--max-turns 2` out behind the card.
 * Mid-stream (backlog 128) the card stays, with what had arrived and a
 * mark that it was cut short — his reading is not thrown away with the
 * process; the next × dismisses. Nothing had arrived: the card goes at
 * once, as before.
 */
export function dismissAside(thread: Aside | null = null): void {
  // The card's own thread since backlog 176; the front one when none is
  // named. Its own exchange is the one cancelled, by `seq`, and no other.
  const a = thread ?? app.aside;
  if (!a) return;
  const t = asideAsking(a);
  if (t) {
    void api.cancelAside(t.seq).catch(() => {});
    if (t.partial.trim()) {
      t.cancelled = true;
      return;
    }
    // Nothing arrived: marked cancelled too, so a late result is dropped.
    t.cancelled = true;
  }
  const i = app.asides.indexOf(a);
  if (i >= 0) {
    app.asides.splice(i, 1);
    syncFrontAside();
  } else {
    // A stashed chat's thread (its tab's ×): out of that chat's list.
    for (const [k, list] of asideStash) {
      const j = list.indexOf(a);
      if (j < 0) continue;
      list.splice(j, 1);
      if (list.length === 0) asideStash.delete(k);
    }
  }
  if (app.asidePanelThread === a.id) app.asidePanelThread = null;
  if (app.asideFocus === a.id) app.asideFocus = null;
}

/**
 * A turn that sleep cut off, resumed on wake (nightshift backlog 101).
 *
 * `sleepWatch` pairs the wake Rust reports (`system-woke`) with the turn
 * that was running — the rule is `sleep.ts`'s `sleptThrough` — and this
 * is what happens on a match: with the switch on, "continue" goes to the
 * same chat as a turn of its own, worded so the transcript says why, and
 * a toast says so; with *ask* set, the toast carries Resume instead and
 * letting it go is Leave it. Both engines the same way — the CLI's session
 * file holds every completed step, and the provider path records the
 * partial reply before it surfaces the error — so "continue" is the next
 * turn on what already happened either way. Deferred a tick so the send
 * runs after the ended turn's `finally` has let go of `busy`.
 */
const sleepWatch = new SleepWatch((turn) => {
  const prefs = loadSleepPrefs();
  if (!prefs.resumeAfterSleep) return;
  // The chat the turn ran in (backlog 137): the wake is noticed up to a
  // poll later, and by then he may have opened another chat — "continue"
  // used to go into that one. Another chat open, or a chat with no id:
  // the toast names it and Resume opens it first; never sent unasked.
  const chat = turn.chat;
  if (chat === null) return;
  if (chat !== app.activeSessionId) {
    const s = app.sessions.find((x) => x.id === chat);
    const name = chatName(s?.title, s?.first_user);
    addToast(`The Mac slept and cut off the turn in “${name}”`, {
      label: "Resume there",
      run: () => void resumeAfterSleep(chat),
    });
    return;
  }
  if (prefs.resumeAsks) {
    addToast("The Mac slept and cut the turn off", { label: "Resume", run: () => void resumeAfterSleep(chat) });
    return;
  }
  addToast("The Mac slept and cut the turn off — resuming");
  setTimeout(() => void resumeAfterSleep(chat), 0);
});

/** "continue" into the chat sleep cut off — opened first when it is not
 *  the one in front (backlog 137). */
export async function resumeAfterSleep(chat: string | null = app.activeSessionId): Promise<void> {
  if (app.busy) return;
  if (chat !== null && chat !== app.activeSessionId) {
    try {
      await openSession(chat);
    } catch {
      return; // the open's own error is on screen
    }
    if (app.activeSessionId !== chat) return;
  }
  if (!app.connection || app.busy) return;
  await sendUntyped(RESUME_TEXT);
}

/** Report a turn's end to `sleepWatch`: when it started (the log's own
 *  `user_message`, the way the banner reads it), when it ended, how. */
function sleepTurnEnded(errored: boolean): void {
  const sent = [...app.events].reverse().find((e) => e.event === "user_message");
  const started = sent?.event === "user_message" ? Date.parse(sent.at) : NaN;
  sleepWatch.turnEnded({
    startedAtMs: Number.isNaN(started) ? Date.now() : started,
    endedAtMs: Date.now(),
    errored,
    stopped,
    chat: app.activeSessionId,
  });
}

/**
 * Whether the turn now ending, or just ended, is one he stopped (the
 * whole-project review of 2026-09-16, F12). A Stop ends the turn like any
 * other end, so the composer's queue (backlog 089) would otherwise send
 * the next held message the moment the stopped turn returned. Set by
 * `cancelTurn` as it asks, cleared when the next send starts,
 * read by the composer's `drain` through `queueHold`.
 */
let stopped = $state(false);
export function turnWasStopped(): boolean {
  return stopped;
}

export async function cancelTurn(chat?: string | null): Promise<void> {
  // A named chat that is not the one on screen (backlog 159, A3: the
  // phone's Stop for the chat it shows): stop that chat's turn only; the
  // screen's turn, its queue flag and its prompts are left alone.
  const bg = chat ? backgroundTurnOf(chat) : null;
  if (bg) {
    try {
      await api.cancel(bg);
      const b = app.background[bg];
      if (b) b.approvals = [];
    } catch (e) {
      addToast(String(e));
    }
    return;
  }
  // A named chat with no turn here at all: nothing to stop — never the
  // screen's turn in its place.
  // (The provider engine's turn has no `fg`: the chat on screen is its.)
  // A parked turn (the provider engine's, looked away from) is the one
  // that runs, so its chat is the one a Stop may name.
  const running = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
  if (chat && !running?.startsWith(chat)) return;
  // Before the call, not after: the stopped turn can return before the
  // cancel's own reply does, and the queue reads the flag at that return.
  stopped = true;
  try {
    // The turn on screen (or parked) only (backlog 159, A2): a chat
    // running in the background keeps running.
    // Its turn key before its first event names the chat (A3: a New
    // chat's first turn stopped at once named nothing, and the backend
    // then stopped the latest-registered turn — another chat's).
    await api.cancel(stopTarget(fg));
    // Cancelling refuses every parked prompt on the backend, so they stop
    // being answerable — but only once the call actually lands. Clearing
    // them before that could strand a still-running turn with no prompt.
    app.pendingApprovals = [];
  } catch (e) {
    stopped = false;
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
  answer?: unknown,
  then?: "ask" | "auto",
  grant?: FolderGrant,
): Promise<void> {
  const i = app.pendingApprovals.findIndex((r) => r.id === id);
  if (i < 0) return;
  app.pendingApprovals.splice(i, 1);
  // An approved plan moves the chat off the Plan position (backlog 085):
  // the backend's agent takes the pick as it resumes, and the rail's
  // switch follows here so the two never disagree about what the next
  // turn runs as. Saved like any rail change; no reconnect, the agent is
  // already there.
  if (then && name === "ExitPlanMode" && decision === "allow" && app.draft.agentPlan) {
    app.draft.agentPlan = false;
    app.draft.agentAsk = then === "ask";
    if (app.connection?.agent) {
      app.connection.agent.permission_mode = then === "ask" ? "default (ask)" : "auto";
    }
    saveLastConnection({ ...app.draft });
  }
  try {
    await api.approveCall(id, name, decision, reason, answer, then, grant);
  } catch (e) {
    addToast(String(e));
  }
}

let toastSeq = 0;

/** How long a toast stays: five seconds, eight when it carries an action
 *  — his "an undo floating button for 8s" (backlog 066). */
export const TOAST_MS = 5000;
export const ACTION_TOAST_MS = 8000;

export function addToast(text: string, action?: { label: string; run: () => void }): void {
  const id = ++toastSeq;
  app.toasts.push(action ? { id, text, action } : { id, text });
  setTimeout(() => dismissToast(id), action ? ACTION_TOAST_MS : TOAST_MS);
}

export function dismissToast(id: number): void {
  const i = app.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.toasts.splice(i, 1);
}

/** A toast's action, run once: the toast goes with the click, so the
 *  same Undo cannot fire twice. */
export function runToastAction(id: number): void {
  const t = app.toasts.find((t) => t.id === id);
  if (!t?.action) return;
  dismissToast(id);
  t.action.run();
}

/** Mark a trailing in-progress thinking segment as complete (collapses its pill). */
function closeThinking(segments: Segment[]): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === "thinking" && !last.done) {
    last.done = true;
    if (last.at != null) {
      last.ms = Date.now() - last.at;
      delete last.at;
    }
  }
}

/** A background chat's event (backlog 159, A2): its stream and usage,
 *  the way `applyTurnEvent` builds the chat on screen's — through it,
 *  with the background's state in the host's place for the moment. */
function applyBackgroundEvent(bg: Background<Segment, ApprovalRequest>, ev: TurnEvent): void {
  if (ev.type === "usage") {
    bg.liveUsage = ev.usage;
    return;
  }
  if (ev.type === "tool_denied" || ev.type === "tool_result") {
    const i = bg.approvals.findIndex((r) => r.id === ev.tool_use_id);
    if (i >= 0) bg.approvals.splice(i, 1);
  }
  // A background chat's subagents are rows of that chat (backlog 160).
  if (ev.type === "subagent_status") {
    upsertSubagentRow(ev, bg.session);
    return;
  }
  if (!bg.live) return;
  // The stream's own shapes are one function's (`applyStream`), shared
  // with the chat on screen; the app-wide rows (agent init, suggestions)
  // stay the chat on screen's.
  if (ev.type === "agent_init" || ev.type === "prompt_suggestion") return;
  // Without its `chat`, or it would be routed here again.
  const { chat: _chat, ...plain } = ev as TurnEvent & { chat?: string };
  const saved = app.parked;
  app.parked = bg;
  try {
    applyTurnEvent(plain as TurnEvent);
  } finally {
    app.parked = saved;
  }
}

/** Exported for the tests of what a turn's events do to the state. */
export function applyTurnEvent(ev: TurnEvent & { chat?: string }): void {
  // A background chat's event lands in its own state (backlog 159, A2);
  // what else an event does is for the chat on screen, so it stops here.
  const bg = eventHost(app.background, ev.chat);
  if (bg) {
    applyBackgroundEvent(bg, ev);
    return;
  }
  // The turn on screen learns its chat from its first event (a New
  // chat's first turn), and a parked one can then go to the background.
  if (ev.chat && fg && fg.chat === null) {
    fg.chat = ev.chat;
    // The chat it made keeps the model it was made on (backlog 205).
    if (fg.choice) {
      noteMade(chatChoice.choices, ev.chat, fg.choice);
      saveChatChoices();
    }
    if (app.parked) promoteParked();
    if (fg === null) {
      const moved = eventHost(app.background, ev.chat);
      if (moved) applyBackgroundEvent(moved, ev);
      return;
    }
  }
  // The running chat's live state, parked or on screen (backlog 159).
  const host = liveHost(app);
  if (ev.type === "usage") {
    host.liveUsage = ev.usage;
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
    if (host.live) {
      closeThinking(host.live.segments);
      host.live.segments.push({
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
  // The Running-tasks rows outlive the live message (backlog 160): a
  // status or a child's event that lands after it ended still reaches its
  // row, which is the chat's and not the message's.
  if (ev.type === "subagent_status") {
    upsertSubagentRow(ev, ev.chat ?? fg?.chat ?? app.activeSessionId);
    app.liveVersion++;
    return;
  }
  if (ev.type === "subagent") {
    const row = subagentRow(ev.parent_tool_use_id);
    if (row) applyToSegments(row.segments, ev.event);
  }
  if (!host.live) return;
  const segments = host.live.segments;
  switch (ev.type) {
    case "text_delta":
    case "thinking_delta":
    case "redacted_thinking":
    case "tool_call":
    case "tool_result":
    case "tool_denied":
      applyToSegments(segments, ev);
      break;
    case "subagent": {
      // A subagent's event (backlog 075) goes under the row of the call
      // that spawned it — found by id, at any depth, since a subagent's
      // subagent is under a child's call — and is applied there exactly
      // as the main thread's would be, so the same renderer draws it.
      // The Running-tasks row keeps its own copy (backlog 152), applied
      // the same way, so its transcript outlives the live message — above,
      // before the live message is asked for (backlog 160).
      const parent = findCall(segments, ev.parent_tool_use_id);
      if (!parent) break;
      parent.children ??= [];
      applyToSegments(parent.children, ev.event);
      break;
    }
    case "round_limit":
      closeThinking(segments);
      segments.push({
        kind: "notice",
        text: `tool round limit reached (${ev.rounds} rounds)`,
      });
      break;
    case "agent_init":
      // The CLI's init line (nightshift backlog 077): kept whole for the
      // Context page. Nothing in the transcript changes.
      app.agentInit = ev;
      break;
    case "prompt_suggestion":
      // After the result (backlog 083): the composer's ghost line.
      app.suggestion = ev.text;
      break;
    default:
      // Unknown turn-event types are ignored by contract.
      break;
  }
  app.liveVersion++;
}

/** The Running-tasks row for the `Agent` call `id`, if the CLI has
 *  announced it (backlog 152). */
function subagentRow(id: string): SubagentRow | null {
  return app.subagents.find((r) => r.tool_use_id === id) ?? null;
}

/**
 * The translator's whole row each time (backlog 152): replace the figures,
 * keep what the window holds beside them. `session` is the chat it runs in
 * (backlog 160); a row rebuilt from the log is live again once the CLI
 * speaks of it.
 */
function upsertSubagentRow(ev: Extract<TurnEvent, { type: "subagent_status" }>, session: string | null): void {
  const { type: _type, chat: _chat, ...status } = ev as typeof ev & { chat?: string };
  const row = subagentRow(status.tool_use_id);
  const now = Date.now();
  if (row) {
    Object.assign(row, status, { updatedAt: now, restored: false });
    row.session ??= session;
  } else {
    app.subagents.push({
      ...status,
      session,
      turn: app.turnSeq,
      startedAt: now,
      updatedAt: now,
      segments: [],
    });
  }
}

/** The open chat's rows (backlog 160), for the Running-tasks panel. */
export function openChatSubagents(): SubagentRow[] {
  return rowsOf(app.subagents, app.activeSessionId);
}

/** The chip's rows (backlog 160): the open chat's latest turn that had
 *  agents, kept after they finish. */
export function latestSubagents(): { rows: SubagentRow[]; running: number; tokens: number } {
  return latestAgents(app.subagents, app.activeSessionId);
}

/** Whether a subagent is still running (backlog 152). */
export function subagentRunning(r: SubagentRow): boolean {
  return r.status === "running";
}

/**
 * The latest turn's subagents and their tokens (backlog 152), for the
 * top bar's chip and the gauge's "+ subagents" line: the CLI's figure per
 * agent — the latest round's whole request and response, what the Claude
 * app's panel shows — summed. Not in the window figure, which is the
 * main thread's alone; said beside it rather than added to it, since a
 * child's context is its own and not the next request's.
 */
export function subagentsOfTurn(): { rows: SubagentRow[]; running: number; tokens: number } {
  // The open chat's alone since rows are kept per chat (backlog 160).
  const rows = app.subagents.filter((r) => r.turn === app.turnSeq && r.session === app.activeSessionId);
  return {
    rows,
    running: rows.filter(subagentRunning).length,
    tokens: rows.reduce((n, r) => n + r.tokens, 0),
  };
}

/** The tool call with `id` among `segments`, or under any call's subagent. */
function findCall(segments: Segment[], id: string): ToolCallView | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind !== "tool") continue;
    if (seg.call.id === id) return seg.call;
    if (seg.call.children) {
      const inner = findCall(seg.call.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Apply one content event to a list of segments — the live reply's, or a
 * subagent's under its parent call (backlog 075). One function for both
 * so a child's text, thinking and calls accumulate exactly as the main
 * thread's do.
 */
function applyToSegments(segments: Segment[], ev: TurnEvent): void {
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
        segments.push({ kind: "thinking", text: ev.text, done: false, at: Date.now() });
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
    default:
      break;
  }
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
 * The prompt layers the open chat has switched off, projected from the log
 * the way `Session::prompt_layers_off()` projects it in the core: the latest
 * live `prompt_layers` event wins, a compaction leaves it alone (the chat is
 * the same chat), and none means every layer is on.
 */
export function promptLayersOff(events: SessionEvent[]): PromptLayer[] {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "prompt_layers") return e.off;
  }
  return [];
}

/** The same set, as the backend normalizes it: ladder order, no repeats. */
const LAYER_ORDER: PromptLayer[] = [
  "identity",
  "environment",
  "user_memory",
  "model_instructions",
  "project_instructions",
  "project_notes",
  "knowledge",
  "engine_note",
];

/** Whether two layer sets are the same set, whatever order they came in. */
export function sameLayers(a: PromptLayer[], b: PromptLayer[]): boolean {
  const key = (xs: PromptLayer[]) =>
    LAYER_ORDER.filter((l) => xs.includes(l)).join(",");
  return key(a) === key(b);
}

/**
 * Switch one prompt layer off or on for the open chat.
 *
 * Two steps, in the order that keeps the log ahead of the wire: the event
 * is recorded first (creating the chat's log if the first send has not yet),
 * then the engine reconnects exactly as a rail knob would, and `connect` /
 * `connect_agent` read the new set back off the log. The transcript comes
 * back from the same call the way it does from `rewind`, so the popover's
 * switches — which project the log — flip when the log does and not before.
 */
export async function setPromptLayer(layer: PromptLayer, on: boolean): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = promptLayersOff(app.events);
  const off = on ? current.filter((l) => l !== layer) : [...current, layer];
  if (sameLayers(off, current)) return;
  if (!(await applyLayers(off))) return;
  // The inverse is the set as it was; scoped to the chat the call may
  // just have created, which is why the scope is read after it.
  pushUndo(chatScope(), {
    label: `${layer.replace(/_/g, " ")} ${on ? "on" : "off"}`,
    undo: async () => {
      await applyLayers(current);
    },
    redo: async () => {
      await applyLayers(off);
    },
  });
}

/** The two steps of a layer change: the log, then the reconnect that
 *  reads it back. False on a refusal, toasted. */
async function applyLayers(off: PromptLayer[]): Promise<boolean> {
  try {
    app.events = await api.setPromptLayers(off);
    // A chat whose log was just created by this call: pick up its id the way
    // `send` does, so the sidebar and the next open agree on which chat this is.
    const first = app.events[0];
    if (first && first.event === "session_created") app.activeSessionId = first.id;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * The open chat's own text per layer, projected from the log the way
 * `Session::prompt_layer_edits()` projects it in the core: the same event
 * as the off set, so the same latest-wins, the same survival of a
 * compaction, the same reversal by a rewind. A line written before the
 * field existed carries none, which reads as no override.
 */
export function promptLayerEdits(events: SessionEvent[]): PromptLayerEdits {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "prompt_layers") return e.edits ?? {};
  }
  return {};
}

/** Whether two edit maps say the same thing: same kinds, same text. */
export function sameEdits(a: PromptLayerEdits, b: PromptLayerEdits): boolean {
  const key = (m: PromptLayerEdits) =>
    JSON.stringify(EDITABLE_LAYERS.map((l) => [l, m[l] ?? null]));
  return key(a) === key(b);
}

/**
 * Give the open chat its own text for one layer, or take it back with
 * `text` null (*Revert to the file*). The same two steps as `setPromptLayer`
 * and for the same reason: the log first, then the reconnect that reads it
 * back. A body that trims to nothing is recorded as no override — the
 * backend normalizes it so — since "send nothing" is what the switch is for.
 */
export async function setPromptLayerText(
  layer: EditableLayer,
  text: string | null,
): Promise<boolean> {
  if (app.busy || app.connecting) return false;
  const current = promptLayerEdits(app.events);
  const wanted = text?.trim() || null;
  const previous = current[layer] ?? null;
  if (previous === wanted) return true;
  if (!(await applyLayerText(layer, wanted))) return false;
  pushUndo(chatScope(), {
    label: `${layer.replace(/_/g, " ")} text`,
    undo: async () => {
      await applyLayerText(layer, previous);
    },
    redo: async () => {
      await applyLayerText(layer, wanted);
    },
  });
  return true;
}

/** `applyLayers` for one layer's own text. */
async function applyLayerText(layer: EditableLayer, text: string | null): Promise<boolean> {
  try {
    app.events = await api.setPromptLayerText(layer, text);
    const first = app.events[0];
    if (first && first.event === "session_created") app.activeSessionId = first.id;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * *Make this the file*: open the store editor on the file a layer reads,
 * with the chat's text in the buffer as a draft — never a write. The draft
 * goes through `noteDrafts`, so the ● marker, Revert and the same Save any
 * edit takes all apply; the override stays on the chat until it is reverted
 * here, so nothing is lost if the editor is closed without saving.
 *
 * Which file: memory is `~/.nightloom/AGENTS.md`; project instructions are
 * the workspace's `AGENTS.md` (the innermost file of the walk, the one the
 * Notes panel edits — an override that replaced several files lands in the
 * one a save can reach, and the editor shows the difference); the model's
 * is its file under `~/.nightloom/models/` by the id the chat is on. False
 * when there is no such file to open — no project for the instructions, no
 * model id for the model's — with the reason as a toast.
 */
export function promoteLayerText(layer: EditableLayer, text: string): boolean {
  let scope: NoteScope;
  let name: string;
  if (layer === "user_memory") {
    scope = "memory";
    name = "AGENTS.md";
  } else if (layer === "project_instructions") {
    if (!app.project) {
      addToast("Open a project first — the instructions file is the project's");
      return false;
    }
    scope = "instructions";
    name = "AGENTS.md";
  } else {
    const model = currentModelId();
    if (!model) {
      addToast("This chat is on the engine's default model, which has no file to edit");
      return false;
    }
    scope = "models";
    name = modelInstructionFile(model);
  }
  const key = noteDraftKey(scope, name);
  app.noteDrafts[key] = text;
  app.showContext = false;
  const tab = app.leftTab;
  showNote(scope, name);
  // The model's file is not in the Notes list, so the tab stays where it
  // was, as `openModelInstructions` leaves it.
  if (scope === "models") app.leftTab = tab;
  return true;
}

/**
 * Reconnect if the open chat's layer set or its own texts are not the ones
 * the engine was built with — which is the case after opening another chat,
 * or a new one, since the engine is built once per rail change and not per
 * chat. Cheap when the pairs agree, which is every other time it runs; a
 * no-op while a turn or a connect is in flight, and the caller's effect
 * re-runs it when either ends.
 */
export async function syncPromptLayers(): Promise<void> {
  // The open chat's own model and engine first (backlog 205): shown at
  // once, and a chat switch that changes them reconnects — which also
  // builds the layers. The reconnect waits while a turn or a connect is
  // in flight, so a running turn keeps the model it started with.
  if (restoreChatChoice()) chatChoice.reconnect = true;
  if (app.busy || app.connecting) return;
  if (chatChoice.reconnect) {
    chatChoice.reconnect = false;
    await applyDraft();
    return;
  }
  if (!app.connection) return;
  try {
    const { off, built, edits, built_edits, mode, built_mode, kind, built_kind } =
      await api.promptLayers();
    // The mode is the third pair (2026-09-15): an incognito chat's engine
    // was built with no writers, and the ordinary chat opened after it
    // needs them back — and the other way round. The kind is the fourth
    // (nightshift backlog 102): a Chat's engine has no folder and the
    // read-only tools, and the Claude Code chat opened after it needs
    // both back.
    if (
      !sameLayers(off, built) ||
      !sameEdits(edits ?? {}, built_edits ?? {}) ||
      (mode ?? "normal") !== (built_mode ?? "normal") ||
      (kind ?? "build") !== (built_kind ?? "build")
    ) {
      // A provider connect that fails leaves the built set as it was, so
      // the pairs still disagree, `connecting` flips, the effect re-runs
      // and this would reconnect again at once, forever (backlog 137,
      // review E's FE8). The one pair that just failed is not retried;
      // another chat, another set, or a rail change (which clears
      // `connectError`) tries afresh.
      const pair = JSON.stringify([app.activeSessionId, off, edits ?? {}, mode ?? "normal", kind ?? "build"]);
      if (lastFailedSync === pair && app.connectError) return;
      await applyDraft();
      lastFailedSync = app.connectError ? pair : null;
    }
  } catch {
    // Best-effort: the next rail change reconnects with the right set anyway.
  }
}
/** The (chat, wanted set) whose sync last failed to connect; see above. */
let lastFailedSync: string | null = null;

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
  // An `unrewind` lifts one rewind for good (nightshift backlog 064): the
  // flags are built with every lifted rewind left out, rather than that
  // rewind's range un-cleared, so what remains is the union of the rewinds
  // still standing — the same rebuild the core does.
  const lifted = events.map(() => false);
  for (const e of events) {
    if (e.event === "unrewind" && e.of < lifted.length) lifted[e.of] = true;
  }
  const live = events.map(() => true);
  events.forEach((e, i) => {
    if (e.event === "unrewind") {
      live[i] = false;
      return;
    }
    if (e.event !== "rewind") return;
    live[i] = false; // the marker is not part of the conversation
    if (lifted[i]) return;
    for (let j = e.to; j < i; j++) live[j] = false;
  });
  return live;
}

/**
 * The Claude Code session a chat's next turn continues, read off its own
 * log: the latest live `agent_session` line — `Session::agent_session`
 * and the backend's `resume_of`, mirrored. The engine rail names this
 * (backlog 159, walk 2026-09-25): it named `connection.agent.resume`,
 * which is the chat open when the connection was made, so chat B read
 * "Continuing Claude Code session ece63fa7" — chat A's.
 */
export function chatAgentSession(events: SessionEvent[]): string | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (live[i] && e.event === "agent_session" && e.agent === "claude-code") return e.id;
  }
  return null;
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
    return;
  }
  // The inverse lifts the marker this call landed — and, after a redo,
  // the marker *that* call lands, which is why the index is a variable.
  let marker = lastMarker("rewind");
  const handle = pushUndo(chatScope(), {
    label: "rewind",
    undo: async () => {
      app.events = await api.unrewind(marker);
    },
    redo: async () => {
      app.events = await api.rewind(to);
      marker = lastMarker("rewind");
    },
  });
  undoToast("Rewound to here", handle);
}

/** The log index of the newest event of `kind` — the marker an operation
 *  just recorded, for its inverse to name. */
function lastMarker(kind: SessionEvent["event"]): number {
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (app.events[i].event === kind) return i;
  }
  return -1;
}

// ---- Undo and redo (nightshift backlog 064, 2026-09-15) ---------------
//
// The stack is `undo.ts`; this is where it meets the app. Each operation
// below pushes its inverse after it succeeds — `rewindTo`, `saveEdit`,
// `removeTurn`, `editContextItems`, `renameSession`, `deleteSession`,
// `setPromptLayer`, `setPromptLayerText` — and `send` clears the chat's
// stack, since a turn the model has answered is not undoable and nothing
// under it is either. Not on the stack, and the doc says so: a send, a
// fork (edit-and-send; undo is to trash the fork), a compaction, a dream,
// a capture, a project forget.

/** The stack. Not reactive; `app.undoTick` is bumped on every change. */
export const history = new UndoHistory(() => app.busy);

/** The open chat's scope: its id, or the pending New chat's key. */
export function chatScope(): string {
  return app.activeSessionId ?? NEW_CHAT_SCOPE;
}

/** What ⌘Z looks at: the open chat's stack and the list's. */
function undoScopes(): string[] {
  return [chatScope(), LIST_SCOPE];
}

function pushUndo(scope: string, entry: { label: string; undo: () => Promise<void>; redo: () => Promise<void> }): number {
  const handle = history.push(scope, entry);
  app.undoTick++;
  return handle;
}

/**
 * The toast a removal or a rewind raises (backlog 066): "Removed from
 * context · Undo", eight seconds, the Undo reversing *that* entry and
 * nothing else — `undoIf` refuses once something newer is on the stack,
 * and says so, since an Undo that lifted a later edit would be worse than
 * one that did nothing.
 */
function undoToast(text: string, handle: number): void {
  addToast(text, {
    label: "Undo",
    run: () => {
      void (async () => {
        try {
          const step = await history.undoIf(undoScopes(), handle);
          if (!step) addToast("Something was done since; use ⌘Z to undo in order");
        } catch (e) {
          addToast(`Could not undo: ${String(e)}`);
        } finally {
          app.undoTick++;
        }
      })();
    },
  });
}

/** "rewind" or null: what Undo would reverse right now. Reactive through
 *  the tick and the open chat. */
export function undoLabel(): string | null {
  void app.undoTick;
  return history.undoLabel(undoScopes());
}

export function redoLabel(): string | null {
  void app.undoTick;
  return history.redoLabel(undoScopes());
}

/**
 * Reverse the newest operation on the open chat or the list. A toast names
 * it, since the change may be off screen (a rename in the sidebar, a layer
 * in a closed panel). A refusal is a toast too, and the stack is left as
 * it was so the entry can be tried again.
 */
export async function undo(): Promise<void> {
  try {
    const step = await history.undo(undoScopes());
    if (step) addToast(`Undid ${step.label}`);
  } catch (e) {
    addToast(`Could not undo: ${String(e)}`);
  } finally {
    app.undoTick++;
  }
}

export async function redo(): Promise<void> {
  try {
    const step = await history.redo(undoScopes());
    if (step) addToast(`Redid ${step.label}`);
  } catch (e) {
    addToast(`Could not redo: ${String(e)}`);
  } finally {
    app.undoTick++;
  }
}

/**
 * Whether the keyboard focus is in something with a history of its own — a
 * text box or a contenteditable — where ⌘Z belongs to the typing and not
 * to the app. Read at the moment of the key or the menu click.
 */
export function inTextField(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Keep the macOS Edit menu's Undo and Redo in step with the stack and the
 * focus: retitled with the operation, disabled when there is nothing to
 * reverse and no text box to hand the key to. Memoized on what was last
 * sent, since focus moves often and the menu rarely changes. A no-op off
 * macOS, where App.svelte binds the keys itself.
 */
let undoMenuSent = "";
export async function syncUndoMenu(): Promise<void> {
  if (!isMac) return;
  const undo = undoLabel();
  const redo = redoLabel();
  const textField = inTextField();
  const key = `${undo}|${redo}|${textField}`;
  if (key === undoMenuSent) return;
  undoMenuSent = key;
  try {
    await api.setUndoMenu(undo, redo, textField);
  } catch {
    // A missing menu (a test, a window without one) is not worth a toast.
  }
}

/** The text the turn at `index` says now: its latest live edit, else its
 *  own — what an undo of an edit puts back. For a reply, its first text
 *  block, which is what `saveEdit` on a reply rewords (backlog 066: the
 *  transcript's reply editor goes block by block through `saveReplyEdit`
 *  instead). */
function currentText(index: number): string {
  const e = app.events[index];
  if (!e) return "";
  if (e.event === "user_message") {
    const live = liveFlags(app.events);
    for (let i = app.events.length - 1; i > index; i--) {
      const m = app.events[i];
      if (live[i] && m.event === "edit" && m.target === index) return m.text;
    }
    return e.text;
  }
  if (e.event === "assistant_message") {
    const first = e.blocks.findIndex((b) => b.type === "text");
    const b = e.blocks[first];
    const own = b?.type === "text" ? b.text : "";
    return blockEditsOf(index).get(first >= 0 ? first : e.blocks.length) ?? own;
  }
  return "";
}

/**
 * Edit and save (nightshift backlog 062): the turn at `index` says `text`
 * from here on, in this chat. The transcript re-syncs from the log, which
 * now carries the marker; on Claude Code the backend has also rewritten
 * the CLI's history by copy, or refused with a notice and recorded
 * nothing. Refused mid-turn on `rewindTo`'s reasoning.
 */
export async function saveEdit(index: number, text: string): Promise<boolean> {
  if (app.busy) return false;
  const previous = currentText(index);
  try {
    const res = await api.editMessage(index, text, "save");
    app.events = res.events;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  // An edit is undone by an edit back to what the turn said before: the
  // same marker, the same CLI copy on Claude Code, the original kept.
  const editTo = async (t: string) => {
    const res = await api.editMessage(index, t, "save");
    app.events = res.events;
  };
  pushUndo(chatScope(), {
    label: "edit",
    undo: () => editTo(previous),
    redo: () => editTo(text),
  });
  return true;
}

/**
 * Edit and send: fork this chat before the user turn at `index`, open the
 * fork, and send `text` as its next turn — with the original turn's
 * attachments, since the words changed and the file did not. The parent
 * stays in the list, untouched; the fork's row says where it came from.
 * The fork is opened before the send so that, should the send fail, the
 * user is looking at the fork with the text still in the composer's
 * history rather than at a parent that quietly grew a sibling.
 */
export async function sendEdit(
  index: number,
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
): Promise<boolean> {
  if (app.busy) return false;
  try {
    const res = await api.editMessage(index, text, "send");
    app.events = res.events;
    // The fork starts with no asides; the parent keeps its own (backlog 203).
    switchAside(res.session);
    app.activeSessionId = res.session;
    app.error = null;
    app.agentTurn = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  void refreshSessions();
  await send(text, images, documents);
  return true;
}

/**
 * Remove the turn at `index` from the context. A marker, asked about
 * nothing: the transcript shows the placeholder greyed with the original
 * a click away, and the context panel's Restore (or backlog 064's undo)
 * brings it back.
 */
export async function removeTurn(index: number): Promise<void> {
  if (app.busy) return;
  try {
    const res = await api.removeMessage(index);
    app.events = res.events;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  const handle = pushUndo(chatScope(), {
    label: "remove",
    undo: async () => {
      app.events = (await api.restoreMessage(index)).events;
    },
    redo: async () => {
      app.events = (await api.removeMessage(index)).events;
    },
  });
  undoToast("Removed from context", handle);
}

/**
 * The Restore on a removed turn's placeholder (backlog 066): the same
 * restore an undo of the removal runs — `unelide`; on Claude Code the
 * turn's nodes back from the original — with its own inverse on the
 * stack, so a restore is itself undoable.
 */
export async function restoreTurn(index: number): Promise<void> {
  if (app.busy) return;
  try {
    app.events = (await api.restoreMessage(index)).events;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  pushUndo(chatScope(), {
    label: "restore",
    undo: async () => {
      app.events = (await api.removeMessage(index)).events;
    },
    redo: async () => {
      app.events = (await api.restoreMessage(index)).events;
    },
  });
}

/**
 * Remove one block of a reply from the context (backlog 066): a tool call
 * with its result, from the hover on the call; or a text block, which is
 * what a Save with that block's text deleted does. The inverse is the
 * block's restore; the toast offers it for eight seconds.
 */
export async function removeBlock(index: number, block: number, toast = true): Promise<boolean> {
  if (app.busy) return false;
  try {
    app.events = (await api.removeBlock(index, block)).events;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  const handle = pushUndo(chatScope(), {
    label: "remove",
    undo: async () => {
      app.events = (await api.restoreBlock(index, block)).events;
    },
    redo: async () => {
      app.events = (await api.removeBlock(index, block)).events;
    },
  });
  if (toast) undoToast("Removed from context", handle);
  return true;
}

/** The Restore on a removed block's placeholder, on `restoreTurn`'s terms. */
export async function restoreBlock(index: number, block: number): Promise<void> {
  if (app.busy) return;
  try {
    app.events = (await api.restoreBlock(index, block)).events;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  pushUndo(chatScope(), {
    label: "restore",
    undo: async () => {
      app.events = (await api.removeBlock(index, block)).events;
    },
    redo: async () => {
      app.events = (await api.restoreBlock(index, block)).events;
    },
  });
}

/**
 * Save a reply's editor (backlog 066): each changed text block reworded
 * (`editBlock`), each emptied one removed (`removeBlock`), in order, as
 * one entry on the stack — one Save, one undo — whose inverse puts every
 * block back to what it said: an edit back for an edit, a restore for a
 * removal. On Claude Code each step is its own copy of the CLI's file;
 * a step that is refused stops the sequence, with what landed before it
 * kept and undoable.
 */
export async function saveReplyEdit(
  index: number,
  changes: { block: number; text: string }[],
): Promise<boolean> {
  if (app.busy || changes.length === 0) return false;
  const e = app.events[index];
  if (e?.event !== "assistant_message") return false;
  const edits = blockEditsOf(index);
  const done: { block: number; text: string; previous: string }[] = [];
  for (const c of changes) {
    const b = e.blocks[c.block];
    const previous = edits.get(c.block) ?? (b?.type === "text" ? b.text : "");
    try {
      app.events = (
        c.text.length === 0
          ? await api.removeBlock(index, c.block)
          : await api.editBlock(index, c.block, c.text)
      ).events;
      app.error = null;
    } catch (err) {
      addToast(String(err));
      break;
    }
    done.push({ block: c.block, text: c.text, previous });
  }
  if (done.length === 0) return false;
  const apply = async (forward: boolean) => {
    for (const d of forward ? done : [...done].reverse()) {
      const text = forward ? d.text : d.previous;
      app.events = (
        forward && d.text.length === 0
          ? await api.removeBlock(index, d.block)
          : !forward && d.text.length === 0
            ? await api.restoreBlock(index, d.block)
            : await api.editBlock(index, d.block, text)
      ).events;
    }
  };
  pushUndo(chatScope(), {
    label: "edit",
    undo: () => apply(false),
    redo: () => apply(true),
  });
  return done.length === changes.length;
}

/** The reply at `index`'s live block edits, without importing the whole
 *  of edit.ts into this module's cycle. */
function blockEditsOf(index: number): Map<number, string> {
  const live = liveFlags(app.events);
  const out = new Map<number, string>();
  const e = app.events[index];
  if (e?.event !== "assistant_message") return out;
  app.events.forEach((m, i) => {
    if (!live[i] || m.event !== "edit" || m.target !== index) return;
    let block = m.block;
    if (block == null) {
      const first = e.blocks.findIndex((b) => b.type === "text");
      block = first >= 0 ? first : e.blocks.length;
    }
    out.set(block, m.text);
  });
  return out;
}

/**
 * The context panel's Remove and Restore (`edit_context`), with the
 * inverse on the stack: a removal is undone by a restore of the same
 * items and the other way round. Resolves with the panel's new view, or
 * null on a refusal (toasted here). The API engine only, as the command
 * is; the transcript's own controls go through `removeTurn`.
 */
export async function editContextItems(
  targets: number[],
  remove: boolean,
): Promise<ContextEdit | null> {
  let result: ContextEdit;
  try {
    result = await api.editContext(targets, remove);
    app.events = result.events;
  } catch (e) {
    addToast(String(e));
    return null;
  }
  const apply = async (rm: boolean) => {
    app.events = (await api.editContext(targets, rm)).events;
  };
  pushUndo(chatScope(), {
    label: remove ? "remove" : "restore",
    undo: () => apply(!remove),
    redo: () => apply(remove),
  });
  return result;
}

/**
 * Rename a chat, the old name kept for the undo. A chat that was never
 * named shows its first message, and that is what the undo names it —
 * the log's `Title` cannot be un-recorded, only superseded — so the row
 * reads as it did, now by a title. On the list's stack, since the chat
 * renamed need not be the open one.
 */
export async function renameSession(id: string, title: string): Promise<void> {
  const row = app.sessions.find((s) => s.id === id);
  const previous = row?.title ?? row?.first_user ?? null;
  try {
    // The open chat named (backlog 136): mid-turn, another chat's rename
    // lands at once and the running one is refused, not waited on.
    await api.renameSession(id, title, app.activeSessionId);
  } catch (e) {
    addToast(String(e));
    return;
  }
  await refreshSessions();
  if (previous === null) return;
  const nameIt = async (t: string) => {
    await api.renameSession(id, t, app.activeSessionId);
    await refreshSessions();
  };
  pushUndo(LIST_SCOPE, {
    label: "rename",
    undo: () => nameIt(previous),
    redo: () => nameIt(title),
  });
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
