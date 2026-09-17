import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { handoff, noteAgentTurnEnd, resetHandoff } from "./handoff.svelte";
import { suggestions } from "./suggestions.svelte";
import { isMac } from "./platform";
import { moveDraft, newDraftKey, setDraftText } from "./drafts.svelte";
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
  type ConnectionDraft,
  type Engine,
  type SavedPrompt,
} from "./catalog";
import { EDITABLE_LAYERS } from "./types";
import { LIST_SCOPE, NEW_CHAT_SCOPE, UndoHistory } from "./undo";
import { chatName, notifyNeedsYou, notifyTurnEnd } from "./notify";
import { RESUME_TEXT, SleepWatch, loadSleepPrefs, pushPowerPrefs, type Woke } from "./sleep";
import { asideQuestion, type AsideQuote } from "./asideQuote";
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
  PlanUsage,
  ApprovalDecision,
  ApprovalRequest,
  BlockerList,
  ChatKind,
  ChatMode,
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
}

/** The open chat's aside (backlog 081, the passage form backlog 107) — see
 *  `app.aside`. */
export interface Aside {
  seq: number;
  /** His question as typed — not the framed string the backend gets. */
  question: string;
  /** The highlighted passage the question is about, if any. */
  quote: AsideQuote | null;
  /** Opened from a selection and not yet asked: the card is the question box. */
  draft: boolean;
  answer: string | null;
  error: string | null;
  cacheRead: number;
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
   *  next when an answer lands late. */
  aside: null as Aside | null,
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
  await listen<TurnEvent>("turn-event", (e) => applyTurnEvent(e.payload));
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
    app.pendingApprovals.push(e.payload);
    // The needs-you banner (backlog 079): the turn waits on him, and if the
    // window is behind something else nothing on screen says so.
    void notifyNeedsYou(bannerChat(), e.payload);
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
export async function refreshPlanUsage(): Promise<void> {
  try {
    const fresh = await api.planUsage();
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
  await applyDraft();
  await refreshProjects();
  await refreshSessions();
  await refreshNotes();
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
}

/** Leave the form. The draft stays — Escape and Cancel both come here. */
export function closeNewProject(): void {
  if (app.view === "new-project") app.view = "chat";
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
      ask: d.agentAsk,
      plan: d.agentPlan,
      promptSuggestions: suggestions.enabled,
      effort: d.agentEffort.trim() || undefined,
      fallbackModel: d.agentFallback.trim() || undefined,
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
  app.suggestion = null;
  app.aside = null;
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
  if (app.busy) return;
  // The kind is the second axis (nightshift backlog 102): absent means the
  // project's default — Claude Code where there is a folder, Chat where
  // there is none — never the backend's `build`, so the wide button and
  // the privacy rows make the kind the sidebar's dot shows.
  const wanted = kind ?? defaultKind();
  try {
    await api.newSession(mode, wanted);
    app.activeSessionId = null;
    app.events = [];
    app.pendingMode = mode ?? "normal";
    app.pendingKind = wanted;
    app.error = null;
    app.agentTurn = null;
    app.agentInit = null;
    app.suggestion = null;
    app.aside = null;
    closeNote();
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
 * log as `chatMode` is — the creation line's `kind`, `build` when it
 * carries none — and the pending kind while there is no chat yet.
 */
export function chatKind(events: SessionEvent[]): ChatKind {
  for (const e of events) {
    if (e.event === "session_created") return e.kind ?? "build";
  }
  return app.pendingKind;
}

/**
 * The kind a New chat makes when nothing said otherwise (backlog 102's
 * definition of done): Claude Code in a project with a folder of its own,
 * Chat unfiled or in a project that has none — a folderless project is
 * notes and chats only, which is what a Chat is for.
 */
export function defaultKind(): ChatKind {
  return app.project?.root ? "build" : "chat";
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
 */
export async function continueChat(): Promise<void> {
  if (app.busy) return;
  try {
    const start = handoff.startPrompt;
    const res = await api.continueSession();
    app.events = res.events;
    app.activeSessionId = res.session;
    app.error = null;
    app.agentTurn = null;
    app.agentInit = null;
    app.suggestion = null;
    app.aside = null;
    resetHandoff();
    if (start) {
      setDraftText(res.session, start);
    } else {
      handoff.noStartPromptChat = res.session;
      addToast("The wrap-up reply had no start-prompt block — the new chat's box is empty; say what to read first.");
    }
    closeNote();
  } catch (e) {
    addToast(String(e));
    return;
  }
  void refreshSessions();
}

export async function openSession(id: string): Promise<void> {
  if (app.busy) return;
  try {
    app.events = await api.openSession(id);
    app.activeSessionId = id;
    app.error = null;
    // The plan window and estimate belong to the chat you just left.
    app.agentTurn = null;
    app.agentInit = null;
    app.suggestion = null;
    app.aside = null;
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
  let full: string;
  try {
    full = await api.deleteSession(id);
    if (id === app.activeSessionId || full === app.activeSessionId) {
      app.activeSessionId = null;
      app.events = [];
    }
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
      await api.deleteSession(full);
      if (full === app.activeSessionId) {
        app.activeSessionId = null;
        app.events = [];
      }
      await refreshSessions();
    },
  });
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
  void notifyTurnEnd({
    chat: bannerChat(),
    segs: app.live?.segments ?? [],
    outTokens: app.liveUsage?.output_tokens ?? null,
    elapsedMs: Number.isNaN(since) ? null : Date.now() - since,
    error,
  });
}

export async function send(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
): Promise<void> {
  if (!app.connection || app.busy) return;
  stopped = false;
  // A turn the model answers is not undoable, and nothing under it is:
  // a rewind lifted from under a reply would put the model in a
  // conversation it never had (nightshift backlog 064).
  history.clear(chatScope());
  app.undoTick++;
  if (app.connection.engine === "claude-code") {
    return sendAgent(text, images, documents);
  }
  // The pending chat's draft key, taken now: it names the project and the
  // kind this send is making a chat in (nightshift backlog 094).
  const pendingKey = app.activeSessionId === null ? newDraftKey(app.project?.id, app.pendingMode) : null;
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
    try {
      app.events = await api.transcript();
      // Sessions are created lazily on first send; pick up the id.
      const first = app.events[0];
      if (first && first.event === "session_created") {
        // The pending chat's draft follows the chat it made (backlog 065).
        if (pendingKey !== null && app.activeSessionId === null) moveDraft(pendingKey, first.id);
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
): Promise<void> {
  // ~~The hand-off's wrap-up rides this message when the window has crossed
  // the chat's threshold (nightshift backlog 086); `withWrapUp` also moves
  // the stage on, so it goes exactly once.~~ Superseded 2026-09-16 (pass 2,
  // blocker 120): the wrap-up is a message of its own, sent from the
  // composer's notice or by the queue; nothing is appended here.
  app.suggestion = null;
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
  app.live = { segments: [] };
  app.liveUsage = null;
  app.busy = true;
  let failed: string | null = null;
  try {
    const res = await api.sendAgent(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
    );
    app.agentTurn = res;
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
    for (const notice of res.notices) addToast(notice);
  } catch (e) {
    failed = String(e);
    app.error = failed;
  } finally {
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
    try {
      app.events = await api.transcript();
      const first = app.events[0];
      if (first && first.event === "session_created") {
        // The pending chat's draft follows the chat it made (backlog 065).
        if (pendingKey !== null && app.activeSessionId === null) moveDraft(pendingKey, first.id);
        app.activeSessionId = first.id;
      }
    } catch {
      // keep the locally-built view if re-sync fails
    }
    void refreshSessions();
    void refreshNotes();
    // The plan chip follows the turn (nightshift backlog 073).
    void refreshPlanUsage();
    // The hand-off reads the gauge's pair at each turn's end (backlog 086),
    // and the log, for the start prompt in the wrap-up's own reply (pass 2).
    noteAgentTurnEnd(app.activeSessionId, contextUsed(), app.connection?.contextLimit ?? null, app.events);
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
 * the question nor the answer is in the log or the CLI's session. One at a
 * time; a running turn is waited for on the backend's lock.
 */
let asideSeq = 0;
export async function askAside(question: string, quote: AsideQuote | null = null): Promise<void> {
  const q = question.trim();
  if ((!q && !quote) || app.connection?.engine !== "claude-code") return;
  // About a passage (backlog 107): the highlighted text rides inside the
  // one string the backend takes, framed as a selection and quoted
  // exactly (`asideQuestion`); the card keeps his words and the quote
  // apart. The backend is 081's, untouched.
  const sent = quote ? asideQuestion(quote, q) : q;
  const seq = ++asideSeq;
  app.aside = { seq, question: q, quote, draft: false, answer: null, error: null, cacheRead: 0 };
  try {
    const res = await api.askAside(sent);
    if (app.aside?.seq !== seq) return; // dismissed or replaced meanwhile
    app.aside = {
      seq,
      question: q,
      quote,
      draft: false,
      answer: res.answer,
      error: res.is_error ? (res.notices.join("; ") || "the aside failed") : null,
      cacheRead: res.cache_read,
    };
  } catch (e) {
    if (app.aside?.seq === seq)
      app.aside = { seq, question: q, quote, draft: false, answer: null, error: String(e), cacheRead: 0 };
  }
}

/**
 * Open the aside card as a question box about a highlighted passage
 * (backlog 107): the quote is shown, nothing is sent until he asks. A
 * running or answered aside is replaced — one at a time, as before.
 */
export function draftAside(quote: AsideQuote): void {
  if (app.connection?.engine !== "claude-code") return;
  const a = app.aside;
  if (a && !a.draft && a.answer === null && a.error === null) void api.cancelAside().catch(() => {});
  app.aside = { seq: ++asideSeq, question: "", quote, draft: true, answer: null, error: null, cacheRead: 0 };
}

/**
 * The card's ×. An aside still `asking…` is cancelled on the backend too
 * (whole-project review F13, `cancel_aside`): before this it was only
 * hidden, and the CLI ran its `--max-turns 2` out behind the card.
 */
export function dismissAside(): void {
  const a = app.aside;
  if (a && !a.draft && a.answer === null && a.error === null) void api.cancelAside().catch(() => {});
  app.aside = null;
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
const sleepWatch = new SleepWatch(() => {
  const prefs = loadSleepPrefs();
  if (!prefs.resumeAfterSleep) return;
  if (prefs.resumeAsks) {
    addToast("The Mac slept and cut the turn off", { label: "Resume", run: () => void resumeAfterSleep() });
    return;
  }
  addToast("The Mac slept and cut the turn off — resuming");
  setTimeout(() => void resumeAfterSleep(), 0);
});

export async function resumeAfterSleep(): Promise<void> {
  if (!app.connection || app.busy) return;
  await send(RESUME_TEXT);
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

export async function cancelTurn(): Promise<void> {
  // Before the call, not after: the stopped turn can return before the
  // cancel's own reply does, and the queue reads the flag at that return.
  stopped = true;
  try {
    await api.cancel();
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
    await api.approveCall(id, name, decision, reason, answer, then);
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
  const key = `${scope}:${name}`;
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
  if (!app.connection || app.busy || app.connecting) return;
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
      await applyDraft();
    }
  } catch {
    // Best-effort: the next rail change reconnects with the right set anyway.
  }
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
    await api.renameSession(id, title);
  } catch (e) {
    addToast(String(e));
    return;
  }
  await refreshSessions();
  if (previous === null) return;
  const nameIt = async (t: string) => {
    await api.renameSession(id, t);
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
