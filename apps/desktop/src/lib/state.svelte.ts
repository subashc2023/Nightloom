import { noteContextLive } from "./liveContext.svelte";
import { passingEvent } from "./bashOutput.svelte";
import { isShellCall as isShellForPassing } from "./agentCommands";
import { projectSwitch } from "./projectSwitch.svelte";
import { tick, untrack } from "svelte";
import { noteThreadHandoff, peekThreadHandoff, takeThreadHandoff } from "./threadHandoff.svelte";
import { hasHiddenChars } from "./shellRun";
import { switchSameToChoose } from "./subagentSwitch";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { wakeNotice } from "./capWake";
import {
  carryReadOrder,
  firstMessage,
  awayNow,
  extractStartPrompt,
  handoff,
  lastReplyText,
  markAttended,
  markUnattended,
  neverHandsOff,
  noteAgentTurnEnd,
  noteChatProject,
  noteSystemIdle,
  noteRewound,
  noteThread,
  noteThreadFlags,
  leaveHandoff,
  readOrder,
  sentHere,
  threadFor,
} from "./handoff.svelte";
import { boxForHandoff, replaceStartHere, threadOfEvents } from "./thread";
import { suggestions } from "./suggestions.svelte";
import { isMac } from "./platform";
import { stopChordTarget } from "./stopButton";
import {
  clearDraft,
  draftKey,
  enqueueMessage,
  clearInjected,
  markDelivered,
  moveQueue,
  queueAfterTurn,
  ranKey,
  shiftQueue,
  nextQueueId,
  requeueFront,
  type QueuedMessage,
  markInjected,
  markSendNow,
  settleInjected,
  moveDraft,
  newDraftKey,
  nextAttachmentId,
  readDraft,
  recordDraft,
  setDraftAttachments,
  setDraftText,
  hasDraft,
  dropQueued,
} from "./drafts.svelte";
import { releaseSpec, scheduled, wantSpec } from "./scheduled.svelte";
import { contextOf } from "./chatContext.svelte";
import { clockText, nameScheduledRows } from "./schedule";
import { indexOfAim } from "./aim";
import { requestComposerFocus, rewoundMessage, swapIn, untouched, type BoxSwap } from "./rewindDraft.svelte";
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
  sameChoice,
  wantedChoice,
  type ChatChoice,
  type ChatChoices,
} from "./chatChoice";
import { madeChatRow, refreshWithin } from "./afterWrite";
import {
  adoptNewChat,
  emptyRules,
  loadRules,
  rulesFor,
  saveRules,
  setRulesFor,
  useDefaultFor,
  type SubagentRulesStore,
} from "./subagentRules";
import { runLaunch } from "./launch.svelte";
import { withProject, withoutProject } from "./projectRows";
import { EDITABLE_LAYERS } from "./types";
import { LIST_SCOPE } from "./undo";
import { chatName, notifyNeedsYou, notifyTurnEnd, postHeldNeedsYou } from "./notify";
import { onAway, watchPresence } from "./away.svelte";
import { RESUME_TEXT, SleepWatch, loadSleepPrefs, pushPowerPrefs, type Woke } from "./sleep";
import { type CouncilRequest } from "./council";
import { limitPauseFrom, resumeDelayMs, resumeMessage, type LimitPause } from "./limit";
import {
  askedResume,
  dueResumes,
  extractContinue,
  limitResumeTime,
  nextResumeAt,
  readResumes,
  RESUMES_KEY,
  writeResumes,
  type ChatResume,
} from "./chatResume";
import {
  backgroundEndToast,
  canDetach,
  eventHost,
  firstUserText,
  inOtherProject,
  keptPaneLogs,
  liveHost,
  paneChatOf,
  queuedElsewhereToast,
  settlePlan,
  type Background,
  type PaneChat,
  type Parked,
} from "./browse";
import { searchGrowth } from "./search.svelte";
import * as tabs from "./tabs";
import { midTurnWire, chipsFromInputs, sendNowToast, deliveredNotice, type SendNowResult } from "./midTurn";
import { carriesAlone, FOLLOWS, pendingFor, type ReplyResult } from "./askReply";
import { answerLanded, clearHandBack, handedHow, noteAnswered } from "./handBack.svelte";
import { recordRelay } from "./relay.svelte";
import { adoptPending, closeRunningRows, latestAgents, mergeRows, rowsFromLog, rowsOf } from "./subagentRows";
import { lineText, lineView, matchTasks, type StillRunningSegment } from "./stillRunning";
import { applyRetry, clearRetry, markRetryStopping, turnNotices, type RetrySegment } from "./retryLine";
import { pressStop, releaseStop, type StopClock } from "./stopState";
import { cli, startCliClock } from "./cliUpdate.svelte";
import { noteResolved } from "./modelSeen.svelte";
import { currentCliVersion } from "./modelSeen";
import { probeAuth } from "./claudeAuth.svelte";
import { chatIsCold, loadLayerPrefs, reconnectBeforeTurn, saveLayerPrefs } from "./promptVersions";
import { CONNECT_DEADLINE_MS, withDeadline } from "./deadline";
import { rewoundWrites, setAsideFiles } from "./rewoundFiles";
import type { TabContent, Workspace } from "./tabs";
import {
  UNFILED_TABS,
  carryTabsTo,
  emptyNewProjectDraft,
  loadNewProject,
  loadSavedWorkspaces,
  rebuild,
  type SavedNewProject,
} from "./tabsStore";
import { turnClock } from "./turnTiming";
import { FirstSeen, doingOf, quoteLine, sortRuns, type RunEntry, type RunKind } from "./running";
import { rememberScroll } from "./scroll.svelte";
import { stepFocusedField } from "./fieldUndo";
import {
  DEFAULT_USAGE_LIMITS,
  deferredRecheckAt,
  handoffPassDue,
  nightlyReady,
  parseLimit,
  turnWroteHandoff,
  usageGate,
} from "./autoPass";
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
  Attachment,
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
  FileInput,
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
  ShiftSummary,
  ReviewerInfo,
  Note,
  NoteScope,
  Price,
  ProjectInfo,
  ProjectsFolderInfo,
  NewProjectPath,
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
import { asidesOf, asideStash, chatHome, switchAside, findAsideTurn, asideTurnEvent, asidePhase, asideAsking, asideInTab, asideTabThread, asideReads, asideOf, askAside, ATTACHMENTS_ONLY, unfoldAside, asideWaiting, asideWire, followUpAside, rewindAside, restoreAsideTurns, councilFor, setCouncilFor, draftAside, dismissAside, stopAside, settleAsideSegments, setAsideUnsent, asideHasDraft, requestDismissAside, answerAsideDiscard, onAsideClosed, reopenAside, type AsideTurn, type Aside, type AsideAsk } from "./state/asides.svelte";
import { showNightshift, syncNightshiftProject, refreshNightshiftRow, loadNightshiftReview, refreshNightshiftReview, selectShift, refreshNightshift, selectNightshiftProject, loadMornings, openMorning, morningIsRead, markMorningRead, loadShifts, latestShift, loadShiftLog, showDiff, loadBlockers, selectBlocker, loadItems, selectItem, newItem, startInterview, sendInterview, loadInterview, cancelInterview, writeInterviewItem, deleteItem, saveItem, reorderItems, synthPlan, writeAndLaunch, scheduleLaunch, cancelLaunch, loadPendingLaunch, loadUsage, clockOf, loadNotes, openNote, answerBlocker, revertPreview, revertShift, loadNightshiftMorning, enableNightshift } from "./state/nightshift.svelte";
import { showNote, showGraph, leaveNote, currentModelId, followToolMoves, AGENTS_MD, reviewProposal, noteDraftKey, closeNote, openModelInstructions, CHAT_INSTRUCTIONS_FILE, openChatInstructions, saveNote, deleteNote, moveNoteTo, followNoteMove, onNoteMove, movedNoteName, newNoteFolder, deleteNoteFolder, mirrorDraft, stageProposal, acceptProposal, unstageProposal, dismissProposal } from "./state/notes.svelte";
import { reflectTabs, frontOpenChat, tabOpening, showContentOf, newTab, closeTab, stepTab, splitActiveTab, dropChatTabs, dropNoteTabs, dropProjectTabs, tabsKeyNow, terminalHooks, flushTabs, resolveTabContent, shownContent, openContent, dropContent, focusPane, moveTab, splitTab, registerTerminalHooks, flushNewProject, startContentDrag, endContentDrag, droppedContent } from "./state/tabs.svelte";
import { history, chatScope, pushUndo, undoToast, undo, redo, inTextField, editAttachments, sendInFork, contextUsed, undoLabel, redoLabel, syncUndoMenu, saveEdit, removeTurn, restoreTurn, removeBlock, restoreBlock, saveReplyEdit, editContextItems, renameSession, sessionCost, roundCost, cacheHitRate } from "./state/edits.svelte";
export { history, chatScope, undoLabel, redoLabel, undo, redo, inTextField, syncUndoMenu, saveEdit, removeTurn, restoreTurn, removeBlock, restoreBlock, saveReplyEdit, editContextItems, renameSession, contextUsed, sessionCost, roundCost, cacheHitRate };
export { shownContent, reflectTabs, tabOpening, openContent, dropContent, focusPane, newTab, closeTab, stepTab, moveTab, splitTab, splitActiveTab, dropNoteTabs, registerTerminalHooks, flushNewProject, flushTabs, startContentDrag, endContentDrag, droppedContent };
export { showNote, showGraph, closeNote, leaveNote, currentModelId, openModelInstructions, CHAT_INSTRUCTIONS_FILE, openChatInstructions, saveNote, deleteNote, moveNoteTo, followNoteMove, onNoteMove, movedNoteName, followToolMoves, newNoteFolder, deleteNoteFolder, reviewProposal, mirrorDraft, noteDraftKey, stageProposal, acceptProposal, unstageProposal, dismissProposal };
export { showNightshift, refreshNightshift, syncNightshiftProject, selectNightshiftProject, loadNightshiftReview, loadMornings, openMorning, morningIsRead, markMorningRead, loadShifts, latestShift, selectShift, loadShiftLog, showDiff, loadBlockers, selectBlocker, loadItems, selectItem, newItem, startInterview, sendInterview, loadInterview, cancelInterview, writeInterviewItem, deleteItem, saveItem, reorderItems, synthPlan, writeAndLaunch, scheduleLaunch, cancelLaunch, loadPendingLaunch, loadUsage, clockOf, loadNotes, openNote, answerBlocker, revertPreview, revertShift, loadNightshiftMorning, enableNightshift };
export { asideAsking, asideInTab, asideTabThread, asideReads, asidesOf, asideOf, askAside, ATTACHMENTS_ONLY, unfoldAside, asideWaiting, asideWire, followUpAside, rewindAside, restoreAsideTurns, asideStash, councilFor, setCouncilFor, switchAside, draftAside, dismissAside, stopAside, asideTurnEvent, asidePhase, settleAsideSegments, setAsideUnsent, asideHasDraft, requestDismissAside, answerAsideDiscard, onAsideClosed, reopenAside };
export type { AsideTurn, Aside, AsideAsk };

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
  /** ~~Dream automatically after a compaction, when the inbox has entries.~~
   *  Since nightshift item 278 (2026-10-02): capture and dream by themselves
   *  — at a hand-off, after a compaction, and (with the daily switch) once a
   *  night when the Mac is idle. On by default, his yes. */
  auto: boolean;
  /** Provider that dreams — a provider kind or `DREAM_ENGINE`; "" means
   *  whatever the rail is connected to, the Claude Code engine included. */
  provider: string;
  /** Model that dreams; "" means the provider's default. On `DREAM_ENGINE`
   *  a CLI alias (`haiku`, `sonnet`) and "" the CLI's default. */
  model: string;
  /** Automatic passes wait while the plan's five-hour window is above
   *  this percent (nightshift item 279; default 50). Run now ignores it. */
  limitFiveHour: number;
  /** … or the week above this percent (default 80). */
  limitWeek: number;
}

/**
 * The preference's version. A stored value without it predates item 278,
 * when `auto` defaulted off and meant "after a compaction" — a trigger he
 * never fires — so it is read as on, the new default (his yes, 2026-10-02);
 * the switch he sets from now on is saved with the version and kept.
 */
export const DREAM_PREFS_VERSION = 2;

/** The stored preference read back, or the default when absent or malformed. */
export function parseDreamPrefs(raw: string | null): DreamPrefs {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<DreamPrefs> & { v?: unknown };
      return {
        auto: p.v === DREAM_PREFS_VERSION ? !!p.auto : true,
        provider: typeof p.provider === "string" ? p.provider : "",
        model: typeof p.model === "string" ? p.model : "",
        // Item 279: a value stored before the limits existed reads them as
        // the defaults; the version is not bumped, so his switch is kept.
        limitFiveHour: parseLimit(p.limitFiveHour, DEFAULT_USAGE_LIMITS.fiveHour),
        limitWeek: parseLimit(p.limitWeek, DEFAULT_USAGE_LIMITS.week),
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return {
    auto: true,
    provider: "",
    model: "",
    limitFiveHour: DEFAULT_USAGE_LIMITS.fiveHour,
    limitWeek: DEFAULT_USAGE_LIMITS.week,
  };
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
    localStorage.setItem(DREAM_PREFS_KEY, JSON.stringify({ ...app.dreamPrefs, v: DREAM_PREFS_VERSION }));
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
  // Under the Classic layout (item 542, `layout.svelte.ts`) "A" is the old
  // charcoal & amber, kept in app.css as `classic-A`.
  if (p === "A" && document.documentElement.dataset.layout === "classic") document.documentElement.dataset.palette = "classic-A";
  else if (p === "A") delete document.documentElement.dataset.palette;
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

export function sidebarColumn(): number {
  return sidebarShown() + Math.round(searchGrowth.current);
}

/**
 * The most of the window the sidebar may take (nightshift item 360, the
 * zoom audit). Its width is CSS px, so ⌘+ (page zoom) grows it with
 * everything else while the window's CSS width shrinks: at the narrowest
 * window (700 points) and 125 % the 260 px sidebar took 46 % of a 560 px
 * page, and the chat was left 300 px — the top bar on two rows, the
 * approval card scrolling sideways, the welcome composer's Send cut off.
 * Past this share the sidebar is drawn narrower (never under its minimum);
 * the saved width is untouched and comes back as the window widens.
 */
export const SIDEBAR_SHARE = 0.34;
export function fitSidebar(saved: number, viewport: number): number {
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(saved, viewport * SIDEBAR_SHARE)));
}
/** The window's CSS width — what `innerWidth` reads, page zoom included. */
const viewport = $state({ w: typeof window === "undefined" ? 1440 : window.innerWidth });
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    viewport.w = window.innerWidth;
  });
}
/** The sidebar's drawn width: the saved one, fitted to the window. */
export function sidebarShown(): number {
  return fitSidebar(app.layout.sidebarWidth, viewport.w);
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
export const READ_KEY = "nightloom.nightshift.read";

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
  /** `delivered` (item 465): his mid-turn message the turn took, drawn as
   *  his bubble in place (`MidTurnBubble`); `text` keeps the old line for
   *  anything that reads notices as text. */
  | { kind: "notice"; text: string; delivered?: { text: string; after: string } }
  /** The reply ended with subagents still running (backlog 357): a status
   *  line with Stop and the agents' names, read live (`stillRunning.ts`). */
  | StillRunningSegment
  /** The CLI retrying a failed call (items 440 + 441): one line, updated
   *  in place, gone at the first word; live only (`retryLine.ts`). */
  | RetrySegment;

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

/** The New project form as the last window left it (backlog 394): its
 *  draft, whether its tab was open, and whether it was in front. */
function loadNewProjectNow(): SavedNewProject {
  try {
    if (typeof localStorage !== "undefined") return loadNewProject(localStorage);
  } catch {
    // A malformed store costs the draft, not the launch.
  }
  return { open: false, front: false, draft: emptyNewProjectDraft() };
}
const newProjectAtLaunch = loadNewProjectNow();

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
  /**
   * Item 457: each section's folders (empty ones too, so a New folder
   * shows), and whether its listing is whole — false when a bound (depth
   * 12, 20,000 files) left something out and the panel says so.
   */
  noteFolders: { project: [] as string[], knowledge: [] as string[] },
  notesComplete: { project: true, knowledge: true },
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
  newProjectDraft: newProjectAtLaunch.draft as {
    name: string;
    instructions: string;
    /** A folder chosen through Change…; null means `<projects folder>/<slug>`. */
    pickedPath: string | null;
    /** Backlog 432: `false` when "Use my practices" is unticked; absent
     *  means ticked. */
    claudeMd?: boolean;
  },
  /**
   * Whether the New project tab is open (nightshift backlog 394): from the
   * form's opening until Create, Cancel (or Esc, or ← Chat), Discard or
   * its ×. The tab is the whole workspace's, not a project's: while this
   * is set, every project switch and restore puts it back first in the
   * focused pane (`restoreTabs`). Kept across a relaunch with the draft
   * (`nightloom.newProject`, written by `tabsKeeper.svelte.ts`).
   */
  newProjectOpen: newProjectAtLaunch.open,
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
  /** Open the note at this line (a `memory_where` hit, backlog 296): read
   *  once by the note view, which puts the cursor there and clears it. */
  noteAt: null as { scope: NoteScope; name: string; line: number } | null,
  /** Which mode the left sidebar is in: its list follows. */
  leftTab: "chats" as "chats" | "notes" | "nightshift",
  /** The rail's connection settings; any change re-connects via applyDraft(). */
  draft: defaultDraft(),
  connection: null as Connection | null,
  connecting: false,
  /** The chat the connection was built for, and the model and engine it
   *  sent (559, the review's 534-2): a chat switch moves the screen at
   *  once and the connection only after its reconnect, so a window read
   *  meanwhile is the previous chat's (`connectionWindowFor`). */
  connectedFor: null as { chat: string | null; choice: ChatChoice } | null,
  /**
   * A rail change waits to be connected (item 222): its debounce is
   * running, or it came during a connect and goes out when that settles.
   * Send is held while this or `connecting` is true, so no message goes
   * out on the settings the rail no longer shows.
   */
  applyPending: false,
  /** Last connect failure, shown in the rail until the next attempt. */
  connectError: null as string | null,
  /** The files the last rewind's turns wrote, offered to be set aside
   *  (item 259); null when it removed none, or once he chose. */
  rewoundWrites: null as import("./rewoundFiles").RewoundWrites | null,
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
  /**
   * The thread the first send binds the new-chat screen to (item 510), on
   * the same terms as `pendingMode`: a thread's + or the chip's pick sets
   * it, nothing is written until that send, and `chatThread` reads it while
   * no chat is open. Plain New chat and a project switch clear it; while a
   * chat is open it means nothing, and the New chat tab finds it again.
   */
  pendingThread: null as string | null,
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
  settingsOpenOn: null as null | "models" | "usage" | "claude-code",
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
   * The logs of idle chats a pane shows while another chat is the open one
   * (nightshift backlog 159, piece 5; `browse.ts` `paneChatOf`): kept as
   * the chat leaves the screen, read from disk when a pane first needs
   * one, re-read when a turn that ran off screen ends. Only the chats a
   * pane shows are kept.
   */
  paneLogs: {} as Record<string, SessionEvent[]>,
  /** Bumped on each stream event of a chat off screen (piece 5): what a
   *  pane showing it follows, as the open chat's transcript follows
   *  `liveVersion`. */
  paneVersion: 0,
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
  /** Bumped to send the chat on screen's transcript to its foot, where the
   *  running turn is (backlog 309's jump from the running list). */
  toLatest: 0,
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
  /** The thread whose close waits on "Discard the unsent text?" (backlog
   *  228, practices §7): set by `requestDismissAside`, answered by the
   *  dialog in `App.svelte`. */
  asideDiscard: null as Aside | null,
  /** Observations awaiting the next dream — the badge on the Dream button. */
  dreamPending: 0,
  /** A dream is running; the button becomes its progress line. */
  dreaming: false,
  /** The dream's most recent tool call, for the running button's tooltip. */
  dreamActivity: "",
  /** Auto-dream and the dream model, Settings → Knowledge. */
  dreamPrefs: loadDreamPrefs(),
  /**
   * The usage gate's last word on an automatic pass (nightshift item 279),
   * for Settings → Knowledge: "deferred 3:41 PM — usage 5h 63 % (limit
   * 50 %)…", or that it ran without a check and why. "" until a gate ran.
   */
  autoPassNote: "",
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

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<TurnEvent & { chat?: string }>("turn-event", (e) => applyTurnEvent(e.payload));
  // The aside's answer as it streams (nightshift backlog 128): a delta
  // for the live exchange is appended; one for a cancelled or replaced
  // exchange (its `seq` differs) is dropped.
  await listen<AsideDelta>("aside-delta", (e) => {
    const t = findAsideTurn(e.payload.seq);
    if (t) asideTurnEvent(t, { type: "text_delta", text: e.payload.text });
  });
  // The rest of an aside's turn (item 403): its thinking and calls, into
  // the same segments the chat's live reply is made of.
  await listen<{ seq: number; event: TurnEvent }>("aside-turn-event", (e) => {
    // Item 649: an aside's running command passes its output too.
    if (passingEvent(e.payload.event, isShellForPassing)) return;
    const t = findAsideTurn(e.payload.seq);
    if (t) asideTurnEvent(t, e.payload.event);
    // Item 483: an aside's moves are followed too, card or no card.
    followToolMoves(e.payload.event);
  });
  // Queued behind the chat's own turn, or running (item 404).
  await listen<{ seq: number; phase: "queued" | "running" }>("aside-phase", (e) => {
    const t = findAsideTurn(e.payload.seq);
    if (t) asidePhase(t, e.payload.phase);
  });
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  // A chat named itself (nightshift backlog 209): the list re-reads its titles.
  await listen<{ chat: string; title: string }>("chat-titled", () => void refreshSessions());
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
      // ~~A five-second toast~~ (item 523, 2026-11-09): the waiting
      // notice in the same corner says it, and stays until he closes it.
      void notifyNeedsYou(name, e.payload);
      return;
    }
    app.pendingApprovals.push(e.payload);
    // A new card: whatever was being handed back has been (item 522).
    clearHandBack();
    // The needs-you banner (backlog 079): the turn waits on him, and if the
    // window is behind something else nothing on screen says so.
    void notifyNeedsYou(bannerChat(), e.payload);
  });
  // A card that landed while he looked posts its banner when he leaves with
  // it still waiting (nightshift backlog 373).
  watchPresence();
  onAway(() => void postHeldNeedsYou(approvalWaits));
  // The phone page (nightshift backlog 091, Shape B; item 246 wave 1):
  // a message, an answer, a stop or a chat action from the phone reaches
  // this window as an event and runs through the same state functions a
  // click here does. The handlers, and why each answers as it does, are
  // in `remoteHandlers.ts`; loaded here so it imports this module after
  // it has finished evaluating.
  await (await import("./remoteHandlers")).installRemoteHandlers();
  // A chat's first turn names its chat as it starts (backlog 192; review
  // 2026-09-23 finding 4): the budget meter and stop card follow it now,
  // not only once the turn has ended.
  await listen<string>("turn-chat", (e) => {
    // The provider engine names its chat too since backlog 211; the budget
    // meter is the agent engine's alone.
    if (app.busy && app.budgetSession === null && e.payload && app.connection?.engine === "claude-code") {
      startBudgetPoll(e.payload, budgetTyped);
    }
    showMadeChat(e.payload);
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
  // Blocker 1757, once ever: every chat's helpers on "Same" go to "Choose"
  // (item 540's model rule is enforced there) — the setting and the files.
  try {
    switchSameToChoose(app.draft, localStorage, () => saveLastConnection({ ...app.draft }), api.switchSubagentsSameToChoose);
  } catch {
    // Never blocks the launch.
  }
  try {
    app.providers = await api.providers();
  } catch (e) {
    app.error = String(e);
  }
  // The launch (item 220, 2026-09-26; `launch.svelte.ts`): ~~each step
  // awaited in turn, the connect last~~ — the window showed an empty app
  // saying "not connected" for 7–86 s on 2026-09-25. Now the launch screen
  // covers the list read and the reopen, and the connect runs beside the
  // reads. Still in order: reopen where the user left off *before*
  // connecting — the project decides the workspace, so connecting first
  // would root the tools at the previous folder and then re-connect.
  await runLaunch({
    listProjects: refreshProjects,
    lastProject: () => {
      const id = loadLastProject();
      const row = id ? app.projects.find((p) => p.id === id) : undefined;
      return row ? { id: row.id, name: row.name } : null;
    },
    openProject: async (id) => {
      app.project = await api.openProject(id);
      // Opening bumps last-opened on the backend, so the list read a
      // moment ago is stale in its ordering — re-read behind the launch.
      void refreshProjects();
    },
    // A project whose folder vanished must not stop the app launching.
    forgetLastProject: () => saveLastProject(null),
    // No chat is open at launch, so the next one is of the default kind
    // (nightshift backlog 102) — said to the backend before the engine is
    // built, since `connect` roots a Chat in the neutral folder. A failure
    // is fine: the first New chat click sends it again.
    newSession: async () => {
      app.pendingKind = defaultKind();
      await api.newSession(undefined, app.pendingKind);
    },
    connect: autoConnect,
    reads: [
      ["refreshSessions", refreshSessions],
      // The memory proposals `refreshNotes` lists need the vault first.
      ["refreshKnowledge+Notes", async () => {
        await refreshKnowledge();
        await refreshNotes();
      }],
      ["refreshProjectsFolder", refreshProjectsFolder],
      ["refreshDreamStatus", refreshDreamStatus],
      ["refreshCaptureStatus", refreshCaptureStatus],
    ],
    after: async () => {
      // Each chat's model and engine are put back from here on (backlog
      // 205): before this the draft is still being read and the launch
      // connect made.
      chatChoice.ready = true;
      // The tabs he left open (backlog 201), once the lists that decide
      // which survive are read and the engine is connected.
      await restoreTabs({ newProjectFront: newProjectAtLaunch.front });
      // Files opened with Nightloom from the Finder (backlog 378), after
      // the restored tabs so none lands over them.
      void import("./openedFiles.svelte").then((m) => m.installOpenedFiles()).catch(() => {});
    },
    mark: (step, ms, detail) => void api.startupMark(step, ms, detail).catch(() => {}),
    now: () => performance.now(),
  });
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
  // As a tree since item 457: the same notes, plus the folders (an empty
  // one is still a place to drop a note) and whether the list is whole.
  if (app.project) {
    try {
      const t = await api.listNoteTree("project");
      app.notes = t.notes;
      app.noteFolders.project = t.folders;
      app.notesComplete.project = t.complete;
    } catch {
      // A store that cannot be listed shows as empty; the failure surfaces
      // when something is actually read or written.
      app.notes = [];
      app.noteFolders.project = [];
      app.notesComplete.project = true;
    }
  } else {
    app.notes = [];
    app.noteFolders.project = [];
    app.notesComplete.project = true;
  }
  try {
    const t = await api.listNoteTree("knowledge");
    app.vault = t.notes;
    app.noteFolders.knowledge = t.folders;
    app.notesComplete.knowledge = t.complete;
  } catch {
    app.vault = [];
    app.noteFolders.knowledge = [];
    app.notesComplete.knowledge = true;
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
  planReadsInFlight++;
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
  } finally {
    planReadsInFlight--;
  }
}

/** Plan readings under way (`refreshPlanUsage`, `readPlanAtReplyEnd`). */
let planReadsInFlight = 0;

/**
 * The plan reading at a reply's end (item 323 review; his answer on
 * blocker 1270, 2026-10-08): taken at once, so the reply's usage line
 * closes now rather than at the next reading. Unlike `refreshPlanUsage(true)`
 * it does not stand on the turn's own figure (that is the reply's start),
 * and it asks the backend for a sample from after `endedAtMs`, which runs
 * the CLI's `/usage` (zero tokens; the backend's once-a-minute gap still
 * holds). Skipped while another reading is in flight; that one, or the
 * next, closes the line. Resolves to whether it ran.
 */
export async function readPlanAtReplyEnd(endedAtMs: number = Date.now()): Promise<boolean> {
  if (planReadsInFlight > 0) return false;
  planReadsInFlight++;
  try {
    const fresh = await api.planUsageRefresh(endedAtMs);
    const held = app.planUsage;
    if (
      held?.sampled_at_ms != null &&
      fresh.sampled_at_ms != null &&
      fresh.sampled_at_ms < held.sampled_at_ms
    ) {
      return true;
    }
    app.planUsage = fresh;
  } catch {
    // A failed read keeps the last reading; the next one closes the line.
  } finally {
    planReadsInFlight--;
  }
  return true;
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
export async function runCapture(quiet = false): Promise<void> {
  if (app.capturing || app.dreaming) return;
  const target = passTarget();
  app.capturing = true;
  try {
    const r = await api.capture(target);
    // An automatic pass that read nothing (every chat deferred) says
    // nothing (item 278: "skip silently when nothing is pending").
    if (quiet && r.logs_read === 0 && r.observations === 0 && !r.interrupted) return;
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
        (r.refused > 0 ? ` (${r.refused} refused)` : "") +
        (split ? ` — ${split}` : "") +
        (r.deferred > 0 ? `; ${r.deferred} waiting for more turns` : "") +
        (r.incognito > 0 ? `; ${r.incognito} incognito, not read` : "") +
        (r.remaining > 0 ? `; ${r.remaining} left for the next run` : "") +
        (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    // Another Nightloom's pass holding the lock is not news on an
    // automatic run; anything else is.
    if (!(quiet && String(e).includes("already running"))) addToast(`capture failed: ${String(e)}`);
  } finally {
    app.capturing = false;
  }
  // The pass fills the inbox and moves the watermarks; both counts follow.
  await refreshCaptureStatus();
  await refreshDreamStatus();
}

/**
 * "Save memory from this chat" (backlog 371): the capture pass over that one
 * chat — an imported one too, whatever the cutoff — then the toast offers
 * the Dream that files what it found into the project's memory or the vault.
 */
export async function saveMemoryFromChat(id: string): Promise<void> {
  if (app.capturing || app.dreaming) {
    addToast("a dream or a capture is already running");
    return;
  }
  const target = passTarget();
  app.capturing = true;
  let found = 0;
  try {
    const r = await api.capture(target, id);
    found = r.observations;
    addToast(
      (r.interrupted ? "save interrupted — " : "") +
        `saved ${r.observations} observation${r.observations === 1 ? "" : "s"} from this chat` +
        (r.refused > 0 ? ` (${r.refused} refused)` : "") +
        (r.remaining > 0 ? "; the rest of it is left for the next save" : "") +
        (r.observations > 0 ? " — Dream files them into memory" : ""),
      r.observations > 0 ? { label: "Dream", run: () => void runDream() } : undefined,
    );
  } catch (e) {
    addToast(`save memory failed: ${String(e)}`);
  } finally {
    app.capturing = false;
  }
  await refreshCaptureStatus();
  if (found > 0) await refreshDreamStatus();
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
            // Item 280: lines that named what his messages do not contain.
            (r.refused > 0 ? ` — ${r.refused} refused` : "") +
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
 * The automatic pass, from every trigger (since nightshift item 278, a
 * hand-off as well — `maybeHandoffPass` — and on by default; the rest of
 * this comment is the compaction trigger it started as).
 *
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
async function maybeAutoDream(kind: AutoPassKind = "compaction"): Promise<boolean> {
  if (!app.dreamPrefs.auto || app.dreaming || app.capturing || app.centre.dailyRunning) return false;
  await refreshCaptureStatus();
  await refreshDreamStatus();
  // Nothing to read and nothing to dream: no pass, so nothing to defer.
  if (app.capturePending === 0 && app.dreamPending === 0) return false;
  // Usage headroom (item 279): over a limit, the pass waits for the next
  // trigger, or the reset of the window that holds it.
  if (!(await autoPassMayRun(kind))) {
    autoPassDeferred = true;
    return true;
  }
  autoPassDeferred = false;
  // Quiet (item 278): a capture that reads nothing — the open chat has one
  // new turn, too little to be worth one — spends nothing and says nothing.
  if (app.capturePending > 0) await runCapture(true);
  await refreshDreamStatus();
  if (app.dreamPending === 0) return false;
  addToast("auto-dream: consolidating the memory inbox");
  await runDream();
  return false;
}

/*
 * The usage gate's wiring (nightshift item 279); the rules are pure in
 * `autoPass.ts` (`usageGate`, `deferredRecheckAt`).
 */
export type AutoPassKind = "hand-off" | "compaction" | "nightly" | "reset";

/** A hand-off or compaction pass the gate held, still owed. */
let autoPassDeferred = false;
/** When the gate first held the pass now owed, for the Settings line. */
let deferredSince: number | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

/** "2:05 PM" — 12-hour whatever the locale (item 611b; was the locale's own). */
const clockTime = clockText;

/**
 * May an automatic pass start? Reads the plan's figure the way the top
 * bar's chip does (`refreshPlanUsage`; a live `/usage` only when the held
 * reading is older than the chip's own five-minute tick), then asks
 * `usageGate`. Held: the Settings line says why, and a timer re-checks at
 * the reset of the window that holds it. Let through without a check: the
 * line and the console say why.
 */
async function autoPassMayRun(kind: AutoPassKind): Promise<boolean> {
  const limits = { fiveHour: app.dreamPrefs.limitFiveHour, week: app.dreamPrefs.limitWeek };
  const onPlan = passTarget().provider === DREAM_ENGINE;
  if (onPlan) {
    const u = app.planUsage;
    if (!u || u.sampled_at_ms == null || Date.now() - u.sampled_at_ms > PLAN_USAGE_LIVE_EVERY_MS) {
      await refreshPlanUsage(true);
    }
  }
  const now = Date.now();
  const v = usageGate(app.planUsage, limits, onPlan, now);
  if (!v.run) {
    deferredSince ??= now;
    app.autoPassNote =
      `automatic pass deferred ${clockTime(deferredSince)} — ${v.why}; ` +
      "it runs at the next trigger under the limits";
    scheduleRecheck(deferredRecheckAt(app.planUsage, limits));
    return false;
  }
  if (v.why) {
    console.info(`automatic ${kind} pass ran without a usage check: ${v.why}`);
    app.autoPassNote = `${kind} pass ${clockTime(now)} ran without a usage check — ${v.why}`;
  } else if (deferredSince !== null) {
    app.autoPassNote = `${kind} pass ran ${clockTime(now)}, usage under the limits (deferred since ${clockTime(deferredSince)})`;
  }
  deferredSince = null;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  return true;
}

/** Look again at `at` (a window's reset): the owed hand-off pass, and the
 *  nightly one if its day has come. */
function scheduleRecheck(at: number | null): void {
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  if (at === null) return;
  const delay = Math.min(Math.max(60_000, at - Date.now()), 2 ** 31 - 1);
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    if (autoPassDeferred) void maybeAutoDream("reset");
    else void maybeDailyPass();
  }, delay);
}

/**
 * The hand-off trigger (nightshift item 278): a turn that wrote
 * `HANDOFF.md`, or *Continue in a new chat*. The two land minutes apart
 * for one hand-off, so `handoffPassDue` makes them one pass. Runs on the
 * same connection and switch as every automatic pass (`passTargetFor`,
 * Settings → Knowledge).
 */
let lastHandoffPass: number | null = null;
export function maybeHandoffPass(): void {
  if (!app.dreamPrefs.auto) return;
  const now = Date.now();
  if (!handoffPassDue(lastHandoffPass, now)) return;
  lastHandoffPass = now;
  // A pass the usage gate held does not count against the spacing: the
  // Continue that follows the wrap-up minutes later asks again (item 279).
  void maybeAutoDream("hand-off").then((deferred) => {
    if (deferred && lastHandoffPass === now) lastHandoffPass = null;
  });
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
  const [proposals, commits, applied, rows, stamp] = await Promise.all([
    api.centreProposals().catch(() => []),
    api.centreDreamCommits(10).catch(() => []),
    api.centreApplied(10).catch(() => []),
    api.nightshiftProjects().catch(() => [] as NightshiftRow[]),
    api.buildStamp().catch(() => null),
  ]);
  app.centre.rows = rows;
  app.centre.notices = buildNotices({
    proposals,
    commits,
    applied,
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
  // In the background (backlog 211): the revert is done when it returns.
  void refreshWithin("reverting " + file, [refreshNotes]);
  return true;
}

/** Revert a dream's write to an `AGENTS.md` no commit carries (backlog
 *  344), from the copy kept before it; the row goes once it is done. */
export async function revertApplied(n: Notice): Promise<boolean> {
  if (!n.applied) return false;
  try {
    addToast(await api.centreRevertApplied(n.applied.project?.id ?? null, n.applied.entry.id));
  } catch (e) {
    addToast(`revert failed: ${String(e)}`);
    return false;
  }
  void refreshWithin("reverting AGENTS.md", [refreshNotes, refreshCentre]);
  return true;
}

/** Open the always-loaded file a dream changed (backlog 344) in the app's
 *  editor: the project's instructions, or the user's memory. */
export async function openInstructions(n: Notice): Promise<void> {
  app.centre.open = false;
  if (n.project && app.project?.id !== n.project.id) {
    await useProject(n.project.id);
  }
  showNote(n.project ? "instructions" : "memory", AGENTS_MD);
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
    // Research threads (backlog 271): struck lines from earlier rounds to
    // each thread's archive.md, duplicate queue rows merged, the index
    // rewritten. Mechanical; what needs a model is flagged for the next
    // bound chat's wrap-up.
    try {
      const tidied = await api.tidyThreads(true);
      const ups = tidied.flatMap((t) => t.threads);
      if (ups.length > 0) {
        const moved = ups.reduce((n, u) => n + u.struck_moved + u.merged.length, 0);
        const flagged = ups.reduce((n, u) => n + u.flags.length, 0);
        said.push(
          `threads: ${moved} line${moved === 1 ? "" : "s"} archived or merged` +
            (flagged > 0 ? `, ${flagged} flag${flagged === 1 ? "" : "s"} for the next wrap-up` : ""),
        );
      }
    } catch (e) {
      said.push(`thread upkeep failed: ${String(e)}`);
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
  // 12-hour whatever the locale (item 611b; was the locale's "02:05 PM" / "14:05").
  app.centre.dailyLast = `${when.toLocaleDateString()} ${clockText(started)} — ${said.join(", ")}`;
  addToast(`daily pass: ${said.join(", ")}`);
  await refreshCentre();
}

/** Run the daily pass if its hour has come and it has not run since. */
export async function maybeDailyPass(): Promise<void> {
  if (!dailyDue(app.centre.daily, app.centre.lastDaily, new Date())) return;
  // Once a night when the Mac is idle (item 278): the hour decides the
  // day, and the pass then waits for an idle Mac unless the last one is
  // stale. The minute clock asks again until it is.
  const idle = await api.macIdleMs().catch(() => null);
  if (!nightlyReady(idle, app.centre.lastDaily, Date.now())) return;
  // Usage headroom (item 279): over a limit, the minute clock asks again;
  // the day is not stamped, so the pass is owed until it runs.
  if (app.centre.dailyRunning || app.dreaming || app.capturing) return;
  if (!(await autoPassMayRun("nightly"))) return;
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
    const got = await api.turnBudget(session);
    // A chat running off screen keeps its own ledger (backlog 159, A4);
    // the meter on screen is the screen's running chat's, or the open
    // chat's — never another chat's read that came back late.
    const b = app.background[session];
    if (b) {
      b.budget = got;
      return;
    }
    if (app.budgetSession === session || app.activeSessionId === session) app.turnBudget = got;
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
/** This turn's message was said aloud in the phone's voice mode (item 246
 *  wave 3): read once, synchronously, at the top of `send`/`sendAgent`,
 *  and passed to the backend, which answers it "for the ear". */
let turnSpoken = false;
/** The chat this turn must run in, by id and project (backlog 535): set
 *  by `sendInChat` for a scheduled message whose chat is on screen, read
 *  once, synchronously, at the top of `send`, and passed to the backend —
 *  which runs it in that chat or refuses, never in "the open chat". */
let turnTarget: { chat: string; project: string | null } | null = null;
/** Where that message goes instead when its chat is no longer on screen,
 *  or no longer idle, once `sendAgent`'s reconnect returns (535f, the
 *  review's 535-1): set and read with `turnTarget`. `busyHere` true: the
 *  chat is still on screen but a turn started in it meanwhile. */
let turnElsewhere: ((busyHere: boolean) => Promise<unknown>) | null = null;
/** The chats a turn is starting in on screen (535f, 535-1): from the top
 *  of `sendAgent` — which `sendInChat`'s on-screen path reaches with no
 *  await between — until the turn is the window's (`app.busy`) or has
 *  gone elsewhere. `chatRuns` counts them, so a second sender (the limit
 *  resume and a tick at the same reset) waits instead of starting a turn
 *  beside it during the first one's reconnect. Keyed by a token per send,
 *  so a late end never clears a newer send's mark. */
const startingIn = new Map<string, symbol>();
/** `send` for a message he did not type here (the phone, a resume) —
 *  with the phone's photos, documents or council when it sent them
 *  (item 246, 1B's patch note 1), so such a turn is not his typed input. */
async function sendUntyped(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
  spoken = false,
): Promise<void> {
  turnTyped = false;
  turnSpoken = spoken;
  try {
    await send(text, images, documents, council);
  } finally {
    turnTyped = true;
    turnSpoken = false;
  }
}
function startBudgetPoll(session: string | null, typed = false): void {
  app.turnBudget = null;
  app.budgetSession = session;
  if (!session || app.connection?.engine !== "claude-code") return;
  notePresence(session, typed);
  void readTurnBudget(session);
  ensureBudgetPoll();
}
/** One clock for every running chat's meter (backlog 159, A4): the
 *  screen's running chat, with his presence, and each chat running off
 *  screen, into its own record. It stops once none runs. */
function ensureBudgetPoll(): void {
  if (budgetPoll) return;
  budgetPoll = setInterval(budgetTick, TURN_BUDGET_EVERY_MS);
}
function budgetTick(): void {
  const onScreen = app.busy ? app.budgetSession : null;
  if (!onScreen && bgTurns.size === 0) {
    if (budgetPoll) clearInterval(budgetPoll);
    budgetPoll = null;
    return;
  }
  if (onScreen) {
    notePresence(onScreen, false);
    void readTurnBudget(onScreen);
  }
  // A chat in another project (blocker 630): its ledger is under that
  // project's logs, which the backend does not read from here — its last
  // reading stands until it is back on screen.
  for (const id of bgTurns.keys()) {
    const b = app.background[id];
    if (!b || !inOtherProject(b, app.project?.id ?? null)) void readTurnBudget(id);
  }
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
  // ~~await refreshNotes()~~ first (backlog 211's leftovers, 2026-09-26):
  // the vault's notes are re-read in the background under the limit; the
  // reconnect, which is what points the model at the new vault, goes now.
  void refreshWithin("pointing the vault elsewhere", [refreshNotes]);
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
  // ~~`if (app.busy) return;`~~, ~~`if (turnsRunning()) return;`~~ (A4's
  // first gates audit) — blocker 630, "allow": the chat on screen that is
  // running goes off screen and keeps its turn, its record naming this
  // project; only a New chat's first turn, not yet named, waits.
  if (app.busy || app.parked) {
    if (app.parked && fg && canDetach(app.connection?.engine, fg.chat)) promoteParked();
    else if (app.busy) detach();
    if (app.busy || app.parked) {
      addToast("This chat's first turn is just starting — switch projects in a moment");
      return;
    }
  }
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
  // Item 598: the open chat is cleared now and the project's own re-opened
  // only once its lists are read; the new-chat page that showed in the gap
  // is covered meanwhile (`projectSwitch.svelte.ts`, `Welcome.svelte`).
  projectSwitch.on = true;
  try {
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
    clearPendingThread();
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
    // navigation to the new project's chat. The New project form in front
    // stays in front too (backlog 394): it is the workspace's, not the
    // project's, and he is still filling it in.
    const formFront = app.view === "new-project" && app.newProjectOpen;
    if (app.view !== "nightshift" && !formFront) app.view = "chat";
    app.openNote = null;
    reflectTabs();
    // ~~The connect, then the list, the chats and the notes, each awaited~~
    // (backlog 211's leftovers, 2026-09-26): the three re-reads run together,
    // beside the connect, and settle within `REFRESH_LIMIT_MS` whatever the
    // disk does — a late answer still lands. The tabs wait for them, since
    // the lists decide which tabs survive.
    await Promise.all([
      applyDraft(),
      refreshWithin("opening " + (app.project?.name ?? "unfiled chats"), [
        refreshProjects,
        refreshSessions,
        refreshNotes,
      ]),
    ]);
    // The project's own tabs (backlog 201). On the Nightshift page the page
    // stays in front and lands in the restored workspace.
    const stay = app.view === "nightshift" || formFront;
    await restoreTabs({ show: !stay, newProjectFront: formFront });
    if (stay) reflectTabs();
  } finally {
    projectSwitch.on = false;
  }
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
    // Its row from the answer; the list is re-read behind (backlog 211).
    app.projects = withProject(app.projects, project);
    void refreshWithin("opening " + project.name, [refreshProjects]);
    await useProject(project.id);
    void offerPracticesClaudeMd(project, path);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Backlog 432: a folder opened by Open project… with no `CLAUDE.md` gets an
 * offer, never a write — a toast whose button adds the practices
 * `CLAUDE.md`. Nothing when it has one, or when there is no
 * `~/.claude/practices/practices.md` for the line to import.
 */
export async function offerPracticesClaudeMd(project: ProjectInfo, path: string): Promise<void> {
  const offer = await api.claudeMdOffer(path).catch(() => null);
  if (!offer || offer.exists || !offer.practices) return;
  addToast(`${project.name} has no CLAUDE.md, so your practices file does not load in its chats.`, {
    label: "Add CLAUDE.md",
    run: () => {
      void api.addPracticesClaudeMd(project.id).then(
        (written) =>
          addToast(written ? `Added CLAUDE.md to ${project.name} with your practices line.` : `${project.name} already has a CLAUDE.md — left as it is.`),
        (e) => addToast(String(e)),
      );
    },
  });
}

// ---- the New project form ----

/**
 * New project…: the form in the centre pane (backlog 047, 2026-09-14). A
 * screen rather than a modal because it replaces Welcome, the page it is
 * reached from; the draft lives in `app.newProjectDraft` and survives every
 * way out of the screen except Create and Discard.
 */
export function showNewProject(): void {
  app.newProjectOpen = true;
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
  // ~~Only from the form in front, closing the front tab~~ — since backlog
  // 394 the tab is open until this (or Create, Discard, its ×), wherever
  // it sits, so it is found anywhere and the flag goes down with it.
  app.newProjectOpen = false;
  const tab = tabs.findAnywhere(app.tabs, { kind: "new-project" });
  if (tab) {
    void closeTab(tab.id);
    return;
  }
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
    // Backlog 432: the practices CLAUDE.md, when the box is ticked and
    // there is a practices file for its line to import. The backend writes
    // it only where the folder has none.
    const offer = d.claudeMd === false ? null : await api.claudeMdOffer(d.pickedPath ?? "").catch(() => null);
    const claudeMd = !!offer?.practices && !offer.exists;
    const project = await api.newProject(d.name, d.pickedPath, d.instructions, claudeMd);
    app.newProjectDraft = { name: "", instructions: "", pickedPath: null };
    // Its tab closes with Create (backlog 394); the switch below shows the
    // new project's strip, so nothing lands in its place here.
    app.newProjectOpen = false;
    const formTab = tabs.findAnywhere(app.tabs, { kind: "new-project" });
    if (formTab) tabs.close(app.tabs, formTab.id);
    // ~~The list and the folder re-read before the form closed~~ (backlog
    // 211's leftovers, 2026-09-26: the form stayed up for as long as a
    // listing could hang). The row comes from the answer, the form closes
    // at once, and the re-reads follow in the background — the folder's
    // because it now exists if it did not, and the Settings pane's line
    // reads off `exists`.
    app.projects = withProject(app.projects, project);
    void refreshWithin("creating " + project.name, [refreshProjects, refreshProjectsFolder]);
    app.view = "chat";
    void useProject(project.id);
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
    // The toast at once; the new rows follow the re-read (backlog 211).
    void refreshWithin("importing", [refreshProjects]);
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
    // The row renamed in place; the re-read follows (backlog 211).
    app.projects = withProject(app.projects, project);
    void refreshWithin("renaming " + name, [refreshProjects]);
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
  // The row goes at once; the re-read follows (backlog 211).
  app.projects = withoutProject(app.projects, id);
  void refreshWithin("forgetting a project", [refreshProjects]);
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
function adoptChatRules(chat: string): void {
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
let applyTimer: ReturnType<typeof setTimeout> | null = null;

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
let lastSent: string | null = null;
function sentKey(): string {
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
async function applyAgentDraft(updateNow: PromptLayer[] = [], take = true): Promise<void> {
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
let filesChangedGen = 0;
let filesSeenGen = 0;

/** A file landed in the project's docspace (item 306's Keep): the next New
 *  chat turn connects first, so its prompt lists it. */
export function projectFilesChanged(): void {
  filesChangedGen += 1;
}

/**
 * Before an agent turn (nightshift backlog 174): reconnect when the engine
 * was built for another chat, or when this chat's cache is cold and a
 * *newer version exists* mark is taken then — never on a warm cache.
 */
async function layersBeforeTurn(): Promise<void> {
  // A file kept in the project since the connect (item 306): a New chat's
  // first turn would go with the listing built before it, so it connects
  // again — nothing is cached yet, so it rewrites nothing.
  if (filesChangedGen !== filesSeenGen && app.activeSessionId === null && !app.busy && !app.connecting) {
    await applyAgentDraft();
    return;
  }
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

/**
 * Re-read which layers have a newer file (backlog 174; night batch F,
 * 2026-09-26, measured): the marks are computed at a connect, and a file
 * edited outside the app — his editor, the model's `remember`, another
 * chat's save — triggers none, so the Context page showed no mark for it.
 * Called when the Context page opens. A reconnect on a warm chat sends the
 * held text byte for byte (Rust `prompt_hold::resolve`), so it rewrites no
 * cache; ~~on a cold chat it takes what the choices allow, as the next turn
 * would~~ (struck 2026-09-26, review RF: under the Auto default that took
 * the newer file the moment he opened the page on a cold chat, before he
 * could see the mark and click *Keep this version* — the one place Keep
 * lives). It now only looks: the connect goes out as warm, so nothing is
 * taken here; the next cold turn takes what the choices then allow
 * (`reconnectBeforeTurn`). Never during a turn or a connect, never for
 * New chat.
 */
export async function refreshLayerVersions(): Promise<void> {
  if (app.busy || app.connecting || app.connection?.engine !== "claude-code") return;
  if (app.activeSessionId === null) return;
  await applyAgentDraft([], false);
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
export let activating = 0;

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
  const opening = c.kind === "chat" && c.session !== null && c.session !== app.activeSessionId ? c.session : null;
  if (opening) tabOpening.chat = opening;
  try {
    await showContentOf(c);
  } finally {
    activating -= 1;
    if (opening && tabOpening.chat === opening) tabOpening.chat = null;
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
export let tabsOwner: string | null = null;

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
export async function restoreTabs(opts: { show?: boolean; newProjectFront?: boolean } = {}): Promise<void> {
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
  // The New project tab, while open, is the workspace's (backlog 394):
  // first in the focused pane whatever project's strip this is, in front
  // when it was in front.
  if (app.newProjectOpen) {
    tabs.pinNewProject(app.tabs, opts.newProjectFront ?? app.view === "new-project");
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
    // A chat made by Send later is named by its scheduled message until
    // that message goes (backlog 532): tabs, title bar and list alike.
    app.sessions = nameScheduledRows(await api.listSessions(), scheduled);
  } catch {
    // sidebar refresh is best-effort
  }
}

/**
 * A New chat's row in the sidebar the moment its first turn starts
 * (backlog 211): the backend names the chat it made (`turn-chat`), and the
 * row is built from what was sent — not left to the listing at the turn's
 * end, which a slow disk (iCloud) can hold for the whole turn and more. Only
 * for the pending chat on screen; the turn's-end re-read replaces the row.
 * Exported for the tests.
 */
export function showMadeChat(id: string | null | undefined): void {
  if (!id || !app.busy || app.activeSessionId !== null) return;
  const sent = [...app.events].reverse().find((e) => e.event === "user_message");
  const row = madeChatRow(
    app.sessions,
    id,
    sent && sent.event === "user_message" ? sent.text : null,
    app.pendingMode,
    app.pendingKind,
  );
  if (row) app.sessions = [row, ...app.sessions];
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
  // New chat already the open chat, maybe behind a thread's tab (297).
  const inFront = app.activeSessionId === null && app.view === "chat";
  try {
    await api.newSession(mode, wanted);
    // The aside thread stays with the chat being left (backlog 130).
    switchAside(null);
    app.activeSessionId = null;
    clearPendingThread();
    app.events = [];
    app.pendingMode = mode ?? "normal";
    app.pendingKind = wanted;
    app.error = null;
    app.agentTurn = null;
    app.agentInit = null;
    // ~~`app.subagents = []`~~ — rows are per chat since backlog 160.
    app.suggestion = null;
    leaveNote();
    if (inFront) frontOpenChat();
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

/**
 * The pending chat's draft key while no chat is open, else null — taken
 * before a setting's call that may create the chat's log (nightshift
 * backlog 420).
 */
function pendingChatKey(): string | null {
  return app.activeSessionId === null ? newDraftKey(app.project?.id, app.pendingMode, app.pendingThread) : null;
}

/**
 * Pick up the id of a chat whose log a setting's call just created (the
 * thread, the kind, the folders, the prompt layers), the way `send` does,
 * so the sidebar and the next open agree on which chat this is — and,
 * when the call was made on the pending New chat (`pending`, from
 * `pendingChatKey`), carry what its box held over to that chat: the
 * pending chat became this one. Before backlog 420 (2026-10-27) the words
 * stayed under the pending key, so binding a draft New chat to a thread
 * showed the bound chat with an empty box and the draft back on a second
 * New chat.
 */
function adoptCreatedChat(pending: string | null): void {
  const first = app.events[0];
  if (!first || first.event !== "session_created") return;
  app.activeSessionId = first.id;
  if (pending !== null && pending !== first.id) moveDraft(pending, first.id);
}

/** The two steps of a kind switch: the log, then the reconnect that reads
 *  it back. False on a refusal, toasted. */
async function applyKind(kind: ChatKind, workspace?: string): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setChatKind(kind, workspace);
    adoptCreatedChat(pending);
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

/**
 * The open chat's research thread (nightshift backlog 271), projected
 * from the log like the folders: the latest live `thread` event, or null;
 * and, when there is no chat yet, the thread the next one will be in
 * (`app.pendingThread`, item 510), as `chatMode` falls back on its pending
 * kind, so the chip, the picker and the hand-off all see it.
 */
export function chatThread(events: SessionEvent[]): string | null {
  return threadOfEvents(events, liveFlags(events)) ?? (app.activeSessionId === null ? app.pendingThread : null);
}

/**
 * Bind the open chat to a research thread, or unbind it (null) — the same
 * two steps as the folders: the log first, then the reconnect that builds
 * the thread layer. Undoable, scoped to the chat. The binding is noted for
 * the hand-off at once, so the wrap-up and the read order follow it without
 * a reload. On the new-chat screen nothing is written (item 510): the pick
 * waits in `app.pendingThread` for the first send, and the box's words go
 * with it, as a binding has carried them since backlog 420.
 */
export async function setChatThread(slug: string | null): Promise<boolean> {
  if (app.busy || app.connecting) return false;
  const current = chatThread(app.events);
  const wanted = slug || null;
  if (wanted === current) return true;
  if (app.activeSessionId === null) {
    moveToPendingThread(wanted);
    pushUndo(chatScope(), {
      label: wanted ? `bind thread ${wanted}` : "unbind thread",
      undo: async () => moveToPendingThread(current),
      redo: async () => moveToPendingThread(wanted),
    });
    return true;
  }
  if (!(await applyThread(wanted))) return false;
  pushUndo(chatScope(), {
    label: wanted ? `bind thread ${wanted}` : "unbind thread",
    undo: async () => {
      await applyThread(current);
    },
    redo: async () => {
      await applyThread(wanted);
    },
  });
  return true;
}

/**
 * Make the New chat on screen a chat now, without sending, and return its
 * id (nightshift backlog 527: Send later from a New chat needs an id to
 * wait under). The shape of `applyThread`: a waiting thread is bound
 * first, the box's words follow the chat (`adoptCreatedChat`), and the
 * sidebar shows the row. An open chat's id comes back unchanged; null on
 * a refusal, toasted.
 */
export async function startPendingChat(): Promise<string | null> {
  if (app.activeSessionId !== null) return app.activeSessionId;
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    if (app.activeSessionId === null) {
      app.events = await api.startChat();
      adoptCreatedChat(pending);
    }
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return null;
  }
  await applyDraft();
  void refreshSessions();
  return app.activeSessionId;
}

async function applyThread(slug: string | null): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    app.events = await api.setChatThread(slug);
    adoptCreatedChat(pending);
    app.error = null;
    noteThread(app.activeSessionId, slug);
    if (slug) void refreshThreadFlags(slug);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * Move a listed chat into a thread, or out of its thread (null) — the
 * sidebar's drag and its row menu's *Move to thread ▸* / *Remove from
 * thread* (nightshift backlog 288). The open chat goes the picker's way
 * (`setChatThread`: the reconnect that loads the thread layer, undoable);
 * any other chat gets the same `thread` line on its log through the
 * backend, and its row moves at once. Only a log line is written, so a
 * failed or refused move leaves the chat where it was — never dropped.
 */
export async function moveChatToThread(id: string, slug: string | null): Promise<boolean> {
  const wanted = slug || null;
  if (id === app.activeSessionId) {
    if (chatThread(app.events) === wanted) return true;
    if (app.busy || app.connecting) {
      addToast("This chat is running a turn — move it when the turn ends");
      return false;
    }
    return setChatThread(wanted);
  }
  const row = app.sessions.find((s) => s.id === id);
  if (row && (row.thread ?? null) === wanted) return true;
  try {
    await api.setSessionThread(id, wanted);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  if (row) row.thread = wanted ?? undefined;
  noteThread(id, wanted);
  void refreshSessions();
  return true;
}

/** The first send's take of the saved hand-off (item 510): only a screen a
 *  thread's + opened; a thread picked on the chip never took one. */
let pendingFromPlus = false;
/** What a + put in each pending box, so that a later + can tell it from
 *  what he typed, and nothing but his words follows him. */
const prefilled = new Map<string, string>();

function clearPendingThread(): void {
  app.pendingThread = null;
  pendingFromPlus = false;
}

/** The New chat tab brought back: as `newSession`, and the screen's thread
 *  with it (a view keeps its state; only an explicit New chat leaves it). */
export async function backToNewChat(): Promise<void> {
  const [thread, plus] = [app.pendingThread, pendingFromPlus];
  await newSession();
  if (app.activeSessionId !== null || (app.busy && !app.parked)) return;
  app.pendingThread = thread;
  pendingFromPlus = plus;
}

/**
 * The new-chat screen's thread changed by the chip (item 510): nothing is
 * written, and the box follows the binding, unless all it holds is the
 * hand-off a + put there, which stays with its thread.
 */
function moveToPendingThread(slug: string | null): void {
  const from = pendingChatKey();
  clearPendingThread();
  app.pendingThread = slug;
  const to = pendingChatKey();
  if (!from || !to || from === to) return;
  const d = readDraft(from);
  if (d.attachments.length === 0 && d.queue.length === 0 && d.text === prefilled.get(from)) return;
  moveDraft(from, to);
}

/** A thread went to the trash (item 510): its screen closes and what was
 *  typed under its + goes to the plain New chat, never with it; an unedited
 *  hand-off went with the thread's own file. */
export function pendingThreadDeleted(slug: string): void {
  if (app.pendingThread === slug) clearPendingThread();
  const project = app.project?.id;
  for (const mode of ["normal", "incognito"] as const) {
    const from = newDraftKey(project, mode, slug);
    if (!hasDraft(from)) continue;
    if (readDraft(from).text === prefilled.get(from)) clearDraft(from);
    else moveDraft(from, newDraftKey(project, mode));
    prefilled.delete(from);
  }
}

/**
 * The binding on the log, on the chat this makes, when the new-chat screen
 * has one waiting (item 510): the one place `pendingThread` reaches the
 * disk. False with nothing waiting; throws when the log was not written, and
 * nothing has moved then. A hand-off a + showed is taken here. Every call
 * that can make the chat's log writes this first, so a setting changed on
 * the screen cannot lose the thread.
 */
async function writePendingThread(): Promise<boolean> {
  const slug = app.activeSessionId === null ? app.pendingThread : null;
  if (!slug) return false;
  const [pending, plus] = [pendingChatKey(), pendingFromPlus];
  const events = await api.setChatThread(slug);
  if (app.activeSessionId !== null || app.pendingThread !== slug) {
    throw new Error("The new chat was left before its thread was bound; nothing was sent");
  }
  app.events = events;
  adoptCreatedChat(pending);
  const id = app.activeSessionId as string | null;
  clearPendingThread();
  if (pending) prefilled.delete(pending);
  noteThread(id, slug);
  if (id) adoptChatRules(id);
  void refreshThreadFlags(slug);
  if (plus && id) await takeThreadHandoff(slug, id);
  return true;
}

let binding: Promise<boolean> | null = null;

/**
 * Before the first turn (item 510): the waiting thread on the log, then the
 * reconnect that loads its layer, since the thread must be on the chat before
 * the model's first word. False, with `app.error` saying why, when the turn
 * must not go: the caller keeps the words. Two sends at once share one bind.
 */
export function bindPendingThread(): Promise<boolean> {
  if (app.activeSessionId !== null || !app.pendingThread) return Promise.resolve(true);
  binding ??= runBind().finally(() => (binding = null));
  return binding;
}

async function runBind(): Promise<boolean> {
  // A connect in flight would swallow the one below (`applyDraft` defers),
  // and the turn would go without the thread's layer.
  if (app.connecting) {
    app.error = "Still connecting; nothing was sent. Send again in a moment";
    return false;
  }
  try {
    await writePendingThread();
  } catch (e) {
    app.error = String(e);
    return false;
  }
  await applyDraft();
  if (app.connectError || !app.connection) {
    app.error = app.connectError ?? "No engine is connected; nothing was sent";
    return false;
  }
  return true;
}

/** The bound chat's row, from what was sent (backlog 211's `showMadeChat`,
 *  in its thread): the list's re-read at the turn's end replaces it. */
function showBoundChat(slug: string, sent: string): void {
  const id = app.activeSessionId;
  const row = id ? madeChatRow(app.sessions, id, sent || null, app.pendingMode, app.pendingKind) : null;
  if (row) app.sessions = [{ ...row, thread: slug }, ...app.sessions];
}

/**
 * *New chat in this thread* (nightshift backlog 288; item 510, his report
 * 2026-11-05) — the light hand-off: exactly the plain New chat, with the
 * screen bound to `slug`. Nothing is created until he sends: `pendingThread`
 * holds the thread, the first send binds it (`bindPendingThread`) so the
 * connect loads the thread layer, and the box has its own draft
 * (`newDraftKey`), so a plain New chat's words stay under theirs and the same
 * + finds these. ~~Bound at once, its log made here~~: that left an empty
 * session in the list on every click. The chat he was in is left as it is —
 * no wrap-up turn, no upkeep (a chat bound to the thread may still be
 * writing it). While a turn runs it opens as New chat does (`peekNew`).
 */
export async function newChatInThread(slug: string): Promise<boolean> {
  if (!app.project) return false;
  await newSession();
  // Refused as New chat is: the pending chat's own first turn is on screen.
  if (app.activeSessionId !== null || (app.busy && !app.parked)) return false;
  app.pendingThread = slug;
  pendingFromPlus = true;
  // Item 464 (his report, 2026-10-28): the box holds the thread's saved
  // hand-off — the last `<handoff>` prompt a reply in it wrote — when no
  // child chat has started from it yet, else nothing. ~~`setDraftText(id,
  // threadReadOrder(slug, THEN_HIS_ASK))`~~: a canned "start this new chat"
  // text beside the model's own prompt was two sources of truth. Read, not
  // taken (item 510): the first send takes it, so a second + shows it again.
  const key = pendingChatKey();
  const handed = await peekThreadHandoff(slug);
  if (key && pendingChatKey() === key) {
    const box = boxForHandoff(readDraft(key).text, handed, prefilled.get(key) ?? null);
    if (box !== null) setDraftText(key, box);
    if (handed) prefilled.set(key, handed);
    else prefilled.delete(key);
  }
  requestComposerFocus();
  return true;
}

/** Start a thread from the project's template and bind the open chat to it. */
export async function createThread(name: string, slug: string): Promise<boolean> {
  try {
    await api.newThread(slug, name);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  return setChatThread(slug);
}

/** A dry-run upkeep of a thread, for its wrap-up's flags. Best-effort. */
export async function refreshThreadFlags(slug: string): Promise<void> {
  try {
    const up = await api.threadUpkeep(slug, false);
    noteThreadFlags(slug, up.flags);
  } catch {
    // No project open, or the thread is gone: the wrap-up goes without flags.
  }
}

/**
 * *Make this the file* for the thread layer: the chat's text spliced into
 * `thread.md`'s `## Start here`, put in the editor as a draft — never a
 * write; Save is his. The rest of the file is what is on disk now.
 */
async function promoteThreadText(text: string): Promise<void> {
  const slug = chatThread(app.events);
  if (!slug || !app.project) {
    addToast("This chat is not bound to a thread in an open project");
    return;
  }
  const name = `threads/${slug}/thread.md`;
  try {
    const file = await api.readNote("project", name);
    app.noteDrafts[noteDraftKey("project", name)] = replaceStartHere(file, text);
    app.showContext = false;
    showNote("project", name);
  } catch (e) {
    addToast(String(e));
  }
}

async function applyFolders(folders: string[]): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setChatFolders(folders);
    adoptCreatedChat(pending);
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
  return chatSelected(null) && !app.pendingThread;
}

/** Whether the new-chat screen in front is thread `slug`'s (item 510): the
 *  plain New chat is not lit then, the thread's + is. */
export function threadPlusSelected(slug: string): boolean {
  return chatSelected(null) && app.pendingThread === slug;
}

/**
 * Whether the sidebar draws chat `id`'s row selected (null: New chat) —
 * ~~whenever it is the open chat~~ (backlog 297, 2026-10-04: a thread,
 * file, aside… tab in front leaves the chat behind it open, and the row
 * stayed lit while the page shown was the thread): only when the focused
 * pane's front tab is that chat (and it is the open chat). With no tab
 * yet, the open chat.
 *
 * Item 615 (his bug, 2026-11-11: "if i create new chat it doesn't
 * hihglight that chat as if i'm on it"): a New chat's first turn runs with
 * `activeSessionId` still null — the id arrives with the turn's first event
 * and becomes the open chat only at the turn's end (`settleTurnView`) — so
 * its row, listed meanwhile, was never lit and New chat stayed lit. The
 * chat on screen is now that made chat (`screenChat`): its row lights, New
 * chat does not, while its front tab is still the new-chat one.
 */
export function chatSelected(id: string | null): boolean {
  if (screenChat() !== id) return false;
  const c = frontContent();
  return !c || (c.kind === "chat" && c.session === app.activeSessionId);
}

/**
 * The chat a New chat's first turn made, from its first event until the
 * turn's view settles (item 615). Set only while that turn is the screen's
 * (not parked); cleared at every turn's start, when it goes to the
 * background (`detach`, which makes it the open chat) and at the end of
 * `settleTurnView` (which does too).
 */
export const firstTurnChat = $state<{ chat: string | null }>({ chat: null });

/** The chat on screen for the sidebar's mark (item 615): the open chat, or
 *  while a New chat's first turn runs on screen, the chat it made. */
function screenChat(): string | null {
  if (app.activeSessionId !== null) return app.activeSessionId;
  if (app.parked) return null;
  return firstTurnChat.chat;
}

/** Whether the sidebar draws the thread `slug`'s name selected: its tab is
 *  the focused pane's front one (backlog 297). */
export function threadSelected(slug: string): boolean {
  const c = frontContent();
  return c?.kind === "thread" && c.slug === slug;
}

/** The focused pane's front tab's content, or null while it has none. */
function frontContent(): TabContent | null {
  return tabs.activeTab(tabs.focusedPane(app.tabs))?.content ?? null;
}

export function newChatLabel(): string {
  const glyph = MODE_GLYPH[app.pendingMode];
  return glyph ? `New chat ${glyph}` : "New chat";
}

/** One line on what a mode means, for the places that offer it. */
export const MODE_LINES: Record<ChatMode, string> = {
  normal: "kept, indexed, remembered",
  incognito: "kept and marked; knows nothing about you, writes nothing, unread by other chats",
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
 * (nightshift backlog 086). Since item 506 this unsent path is the
 * no-prompt line's *Continue in a new chat* and the phone's Continue;
 * the card's button is `continueWithPrompt`. The new
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
    // Item 520: the model's prompt alone when there is one (it names its own
    // reads); the read order only stands in for a missing prompt.
    const opened = await openContinuation(from, !!start);
    const first = start ? firstMessage("", start) : firstMessage(readOrder(from), null);
    if (first) setDraftText(opened, first);
    if (!start) {
      handoff.noStartPromptChat = opened;
      addToast(
        first
          ? "The wrap-up reply had no <handoff> prompt — the new chat's box holds only the read order; say what to do first."
          : "The wrap-up reply had no <handoff> prompt — the new chat's box is empty; say what to read first.",
      );
    }
    leaveNote();
  } catch (e) {
    addToast(String(e));
    return;
  }
  void refreshSessions();
}

/** The new linked chat and everything that goes with it: what `continueChat`
 *  and the card's button share. `prompted`: it starts from a prompt, so the
 *  thread's + does not hand that prompt out again. Throws what the call threw. */
async function openContinuation(from: string | null, prompted: boolean): Promise<string> {
  const thread = threadFor(from);
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
  leaveHandoff(from);
  carryReadOrder(from, res.session);
  // The research thread went on with the chat (backlog 271; the log's
  // `thread` event). Its mechanical upkeep runs now, while neither chat
  // is writing it: the wrapped one has stopped, the new one has not begun.
  noteThread(res.session, thread);
  if (thread) void applyThreadUpkeep(thread);
  // Item 464: this chat started from the thread's saved hand-off, so the
  // thread's + does not hand it out again.
  if (thread && prompted) void takeThreadHandoff(thread, res.session);
  // The chat just left is finished as far as memory is concerned (item 278).
  maybeHandoffPass();
  return res.session;
}

/** The click in flight, and the replies continued this run (`chat|index`):
 *  the listing is the durable record, this covers the moments before it is
 *  read again and a chat the listing does not hold (an ephemeral one). */
let continuing = false;
const continuedHere = $state<Record<string, true>>({});

/** Whether the button on this reply was pressed in this run of the app. */
export function continuedThisRun(chat: string, index: number): boolean {
  return continuedHere[`${chat}|${index}`] === true;
}

/**
 * *Continue with this prompt* on a reply's next-chat card (item 506): a new
 * linked chat, as `continueChat` opens it, with `firstMessage` — the read
 * order the card shows, then the prompt — sent as its first message. His
 * "automatically send" supersedes "in its box, never sent" (blockers 092, 120)
 * for this button only. Needs no wrap-up: the card is enough. A send that
 * fails, or cannot go, leaves the text in the new chat's box.
 */
export async function continueWithPrompt(from: string, index: number, prompt: string): Promise<void> {
  if (continuing) return;
  if (app.busy || app.activeSessionId !== from) {
    addToast("A turn is running — continue when it ends");
    return;
  }
  continuing = true;
  try {
    // ~~`firstMessage(readOrder(from), prompt)`~~ — item 520 (2026-11-09): two
    // prompts that repeated each other; the card's prompt is sent alone.
    const text = firstMessage("", prompt);
    let opened: string;
    try {
      opened = await openContinuation(from, true);
    } catch (e) {
      addToast(String(e));
      return;
    }
    continuedHere[`${from}|${index}`] = true;
    leaveNote();
    void refreshSessions();
    if (!app.connection || app.busy) {
      setDraftText(opened, text);
      addToast("Nothing is connected — the prompt is in the new chat's box; send it when the engine is back");
      requestComposerFocus();
      return;
    }
    await send(text);
    // send() reports a failure on app.error (see the composer's `dispatch`).
    if (app.error) {
      if (!readDraft(opened).text) setDraftText(opened, text);
      else requeueFront(opened, { id: nextQueueId(), text, attachments: [] });
    }
  } finally {
    continuing = false;
  }
}

/** The mechanical upkeep of a thread at *Continue*: a toast when it moved
 *  anything; failures are a toast, never a lost continuation. */
async function applyThreadUpkeep(slug: string): Promise<void> {
  try {
    const up = await api.threadUpkeep(slug, true);
    noteThreadFlags(slug, up.flags);
    const parts: string[] = [];
    if (up.struck_moved > 0) parts.push(`${up.struck_moved} struck line${up.struck_moved === 1 ? "" : "s"} moved to archive.md`);
    if (up.merged.length > 0) parts.push(`${up.merged.length} duplicate queue row${up.merged.length === 1 ? "" : "s"} merged`);
    if (parts.length > 0) addToast(`Thread ${slug}: ${parts.join(", ")}`);
  } catch (e) {
    addToast(`Thread upkeep for ${slug} failed: ${String(e)}`);
  }
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
  /** He stopped it while it ran off screen (A4): the sleep watch does not
   *  read a Stop as sleep's doing. The screen's turn has `stopped`. */
  stopped?: boolean;
  /** A provider (API key) turn (A4): one runs at a time, so a message in
   *  another chat queues while it runs off screen. */
  provider?: boolean;
  /** The pending chat's draft key it was sent from, when it is a New
   *  chat's first turn (backlog 375): its queue follows the chat it makes
   *  when it goes off screen. */
  pendingKey?: string | null;
  /** The context window of the connection it started on (A4 review,
   *  2026-09-30): its end off screen fills the wrap-up against this, not
   *  against whatever connection is on screen by then. */
  contextLimit?: number | null;
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
/** The "still running" asks already toasted (backlog 329), by turn and tasks. */
const stillRunningAsked = new Set<string>();

/**
 * A message he queued while the chat on screen runs a turn, sent into that
 * turn (nightshift backlog 328): the CLI takes it at the turn's next step,
 * as Claude Code does, instead of holding it for the turn's end. ~~Text only
 * — a row with files waits for the next turn as before (backlog 089).~~
 * Since backlog 339 (2026-10-11) its images and documents go too, as the
 * opening line's content blocks; only a `file` chip, or one still
 * converting, waits for the turn's end (`midTurnWire`). The row stays in
 * the queue, marked, until the turn takes it; one the turn never takes is
 * sent as the next message (`settleInjected`).
 */
export async function injectIntoTurn(key: string, q: { id: number; text: string; attachments: Attachment[] }): Promise<void> {
  // Item 536: every return that leaves the row un-handed says why
  // (`handWhy`), so its bubble and its Send now know — before, each was
  // silent and the row just read "goes when this turn ends".
  const turn = fg;
  if (!turn) return noteHand(key, q.id, "no-turn");
  if (!app.busy) return noteHand(key, q.id, "not-busy");
  if (app.parked) return noteHand(key, q.id, "parked");
  // Only into the row's own chat's turn (375 review): a caller holding a
  // stale key (a composer torn down by a chat or project switch) must not
  // hand another chat's row to the turn on screen.
  if (!turnOwnsKey(turn, key)) return noteHand(key, q.id, "other-chat");
  // The provider engine has no inbox (item 536): nothing to hand in to.
  if (turn.provider) return noteHand(key, q.id, "provider");
  // A prompt waits on him (item 522): no process runs to take a message,
  // and the turn only goes on by an answer — so the message is the answer.
  if (pendingFor(app.pendingApprovals, app.connection?.engine)) {
    await replyToPending(key, q);
    return;
  }
  const wire = midTurnWire(q.attachments);
  if (!wire) return noteHand(key, q.id, "files");
  if (!q.text.trim() && wire.images.length + wire.documents.length === 0) return noteHand(key, q.id, "empty");
  const id = crypto.randomUUID();
  // Marked first: a delivery event can come back before the call does.
  markInjected(key, q.id, { id, turn: turn.key });
  let sent = false;
  let threw = false;
  try {
    sent = await api.injectMessage(turn.key, id, q.text, wire.images, wire.documents);
  } catch {
    sent = false;
    threw = true;
  }
  if (sent) noteHand(key, q.id, null);
  if (!sent && readDraft(key).queue.find((r) => r.id === q.id)?.inject?.id === id) {
    clearInjected(key, q.id);
    noteHand(key, q.id, threw ? "error" : "no-inbox");
    // No process with a stdin runs now — a question waiting on his answer,
    // say (backlog 374): tried again when the turn's next process starts,
    // ~~and only then~~ — item 536: and on the turn's next event and every
    // `RETRY_HAND_MS` while it runs, not at its end.
    const later = injectLater.get(turn.key) ?? [];
    if (!later.some((r) => r.key === key && r.qid === q.id)) later.push({ key, qid: q.id });
    injectLater.set(turn.key, later);
    retryHandSoon(turn.key);
  }
}

/**
 * Why a row sent while a turn runs is not handed to it (item 536), by
 * `handKey(key, qid)`: which return of `injectIntoTurn` fired. `no-inbox`
 * and `error` are retried while the turn runs; the rest cannot be handed
 * in, and their Send now is Stop + send.
 */
export type HandReason = "no-turn" | "not-busy" | "parked" | "other-chat" | "provider" | "files" | "empty" | "no-inbox" | "error";
export const handWhy = $state<Record<string, HandReason>>({});
export function handKey(key: string, qid: number): string {
  return `${key}#${qid}`;
}
function noteHand(key: string, qid: number, r: HandReason | null): void {
  const k = handKey(key, qid);
  if (r === null) delete handWhy[k];
  else if (handWhy[k] !== r) handWhy[k] = r;
}
/** The reason the row is not handed in, if one was recorded (item 536). */
export function handReason(key: string, qid: number): HandReason | null {
  return handWhy[handKey(key, qid)] ?? null;
}

/** How often an un-handed row is tried again while its turn runs (536). */
export const RETRY_HAND_MS = 1500;
const handTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Try the turn's held-back rows again shortly — once per turn at a time. */
function retryHandSoon(turnKey: string): void {
  if (handTimers.has(turnKey)) return;
  handTimers.set(
    turnKey,
    setTimeout(() => {
      handTimers.delete(turnKey);
      if (fg?.key === turnKey && app.busy && !app.parked) retryInjects(turnKey);
    }, RETRY_HAND_MS),
  );
}
/** A turn event on screen (item 536): rows it could not take yet are
 *  tried again soon, rather than at the turn's end. */
export function nudgeInjects(turnKey: string): void {
  if (injectLater.has(turnKey)) retryHandSoon(turnKey);
}

/**
 * His message in place of an answer (nightshift item 522, 2026-11-09): the
 * prompt waiting in the chat on screen — the model's question, a plan, a
 * permission or browser prompt — is refused with the queued row's words as
 * the reason, so the model reads them in the call's result and the turn
 * goes on (`askReply.ts`). The row stays in the queue, marked, until the
 * turn reports it delivered; a resume that fails leaves it an ordinary
 * held message, and an answer that cannot be given puts the card back.
 * A row with files cannot ride in a reason: the call is refused saying a
 * message follows, and the row is handed to the resumed process whole.
 */
export async function replyToPending(key: string, q: { id: number; text: string; attachments: Attachment[] }): Promise<ReplyResult> {
  const turn = fg;
  if (!turn || !app.busy || app.parked || !turnOwnsKey(turn, key)) return "none";
  const req = pendingFor(app.pendingApprovals, app.connection?.engine);
  if (!req) return "none";
  if (carriesAlone(q)) {
    const id = crypto.randomUUID();
    markInjected(key, q.id, { id, turn: turn.key, reply: true });
    const ok = await resolveApproval(req.id, req.name, "deny", undefined, undefined, undefined, undefined, { text: q.text.trim(), id });
    if (!ok) {
      clearInjected(key, q.id);
      return "failed";
    }
    return "sent";
  }
  // With files: handed in at the resumed process's `init` (as 374's
  // rows). A chip no running turn can take (a file by path, one still
  // converting) leaves the row for the turn's end, which the refusal
  // brings on — the model is told a message follows and to wait for it.
  if (midTurnWire(q.attachments)) {
    const later = injectLater.get(turn.key) ?? [];
    if (!later.some((r) => r.key === key && r.qid === q.id)) later.push({ key, qid: q.id });
    injectLater.set(turn.key, later);
  }
  const ok = await resolveApproval(req.id, req.name, "deny", FOLLOWS, undefined, undefined, undefined, undefined, "replied");
  return ok ? "follows" : "failed";
}

/**
 * Whether a queued row under draft key `key` belongs to `turn`'s chat
 * (nightshift backlog 375, review 2026-10-18): the turn's chat id, or —
 * for a New chat's first turn — its pending key or the chat that key
 * became. Anything else is another chat's message.
 */
export function turnOwnsKey(turn: { chat: string | null; pendingKey?: string | null }, key: string): boolean {
  if (turn.chat !== null && turn.chat === key) return true;
  const p = turn.pendingKey;
  return p != null && (p === key || ranKey(p) === key);
}

/** The open chat's draft key, read from the app now (375). */
export function openChatKey(): string {
  return draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread);
}

/**
 * The row a background send takes from chat `key` (blocker 1467): only
 * when the ended turn owns that key (`turnOwnsKey`, 375) — its own chat's
 * queue, never the open one's. `null`: nothing goes.
 */
export function takeQueuedFor(turn: { chat: string | null; pendingKey?: string | null }, key: string): QueuedMessage | null {
  if (!turnOwnsKey(turn, key)) return null;
  return shiftQueue(key);
}

/**
 * The queued row a drain sends next (nightshift backlog 375): taken from
 * the **open** chat's queue — `send()` goes to the open chat, so the row
 * must come from the same place — never from `composerKey`, which a
 * composer torn down by a chat or project switch holds stale (Svelte
 * 5.56: a derived read after its owner is destroyed returns its last
 * value, `derived_inert`; measured 2026-10-18). An aside's key is its own
 * and stable. After a turn (`from`, the key the turn left from), only when
 * that turn was the open chat's. `null`: nothing goes.
 */
export function takeQueued(composerKey: string, aside: boolean, from?: string): QueuedMessage | null {
  const live = aside ? composerKey : openChatKey();
  if (from !== undefined && queueAfterTurn(from, live) === null) return null;
  return shiftQueue(live);
}

/**
 * Rows the running turn could not take when he queued them, by turn key
 * (backlog 374): no process with a stdin was running — the deferred
 * question's wait, before its resume (which takes messages since 374), or
 * a `/command` turn on argv. Each is tried again at the turn's next
 * `agent_init` (every CLI process, and every command in one, sends one).
 */
const injectLater = new Map<string, { key: string; qid: number }[]>();

/** Send the turn's held-back rows into it now (374); a row taken back,
 *  sent, or already handed in meanwhile is skipped. */
export function retryInjects(turnKey: string): void {
  const rows = injectLater.get(turnKey);
  if (!rows) return;
  injectLater.delete(turnKey);
  for (const { key, qid } of rows) {
    const q = readDraft(key).queue.find((r) => r.id === qid);
    if (q && !q.inject) void injectIntoTurn(key, q);
  }
}

/**
 * Send now (nightshift backlog 339): a row already sent into the running
 * turn is re-sent with the CLI's `priority: "now"`, which stops the step
 * it is in — a long Bash, say — and delivers it at once, the turn going
 * on (measured on CLI 2.1.296). Without it the row goes at the next step,
 * as before. Returns what he is told.
 */
export async function sendNowRow(key: string, qid: number, sayNotRunning = true): Promise<SendNowResult> {
  const inj = readDraft(key).queue.find((r) => r.id === qid)?.inject;
  if (!inj) return "not_running";
  if (inj.after !== undefined) return "delivered";
  if (inj.now) return "sent";
  let r: SendNowResult = "not_running";
  try {
    r = await api.sendNowInjected(inj.turn, inj.id);
  } catch {
    r = "not_running";
  }
  if (r === "sent") markSendNow(key, qid);
  // Item 536: a caller that falls back to Stop + send says so itself.
  const toast = r === "not_running" && !sayNotRunning ? null : sendNowToast(r);
  if (toast) addToast(toast);
  return r;
}

/**
 * What *Send now* on a pending row does (item 536 — his "there's
 * literally no option to send now"): `now`, Claude Code's own send now on
 * a row already handed in; `hand`, hand it in first and then that — and
 * Stop + send if the turn cannot take it; `stop`, Stop the turn (the
 * reply so far stays) and send the row at once as the next message — the
 * provider engine, a row with a file chip, any turn with no inbox;
 * `reply`, in place of the answer a prompt waits on (522); `none`, nothing
 * to do (already going, or this row is not the running turn's chat's).
 */
export type SendNowPlan = "now" | "hand" | "stop" | "reply" | "none";
export function sendNowPlan(key: string, qid: number): SendNowPlan {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q || !app.busy || app.parked) return "none";
  const inj = q.inject;
  if (inj && (inj.reply || inj.now || inj.after !== undefined)) return "none";
  const turn = fg;
  // Never another chat's turn: a Stop here would end a turn that is not
  // this row's, and the row would go nowhere sooner.
  if (!turn || !turnOwnsKey(turn, key)) return "none";
  if (pendingFor(app.pendingApprovals, app.connection?.engine)) return "reply";
  if (inj) return "now";
  if (turn.provider || !midTurnWire(q.attachments)) return "stop";
  const why = handReason(key, qid);
  return why === "provider" || why === "files" || why === "empty" ? "stop" : "hand";
}

/**
 * A Stop pressed for *Send now* (item 536): the row the stopped turn's end
 * sends at once, into its own chat (`key`), whatever the queue's hold
 * after a Stop says. Taken once, by the composer's drain
 * (`takeStopSend`); a row gone by then (taken by the turn, cancelled)
 * sends nothing — never twice.
 */
export const stopSend = $state<{ key: string | null; qid: number | null; at: number }>({ key: null, qid: null, at: 0 });
/** A forced send older than this is stale (he moved on): dropped. */
const STOP_SEND_TTL_MS = 10 * 60 * 1000;
export function stopSendFor(key: string): number | null {
  return stopSend.key === key && stopSend.qid !== null ? stopSend.qid : null;
}
/** The row to send at once in chat `key`, once the turn is over; taken
 *  (cleared) by this call. `null` while a turn runs or for another chat. */
export function takeStopSend(key: string, now = Date.now()): number | null {
  if (app.busy || stopSend.key === null || stopSend.qid === null) return null;
  if (now - stopSend.at > STOP_SEND_TTL_MS) {
    stopSend.key = null;
    stopSend.qid = null;
    return null;
  }
  if (stopSend.key !== key) return null;
  const qid = stopSend.qid;
  stopSend.key = null;
  stopSend.qid = null;
  return qid;
}
/** Row `qid` to the head of chat `key`'s queue, unsent (536); false when
 *  it is not there any more. */
export function frontQueued(key: string, qid: number): boolean {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q) return false;
  if (q.inject?.after !== undefined) return false;
  dropQueued(key, qid);
  requeueFront(key, { id: q.id, text: q.text, attachments: q.attachments });
  return true;
}

/** Stop the running turn and send row `qid` at once as the next message
 *  (item 536). `stopping` when the Stop went out. */
export async function stopAndSendRow(key: string, qid: number): Promise<"stopping" | "none"> {
  const turn = fg;
  if (!turn || !app.busy || app.parked || !turnOwnsKey(turn, key)) return "none";
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q || q.inject?.after !== undefined || q.inject?.reply) return "none";
  // First in its queue, so whatever sends next sends it; no longer tried
  // into the turn being stopped.
  if (!frontQueued(key, qid)) return "none";
  const later = injectLater.get(turn.key);
  if (later) injectLater.set(turn.key, later.filter((r) => !(r.key === key && r.qid === qid)));
  stopSend.key = key;
  stopSend.qid = qid;
  stopSend.at = Date.now();
  await cancelTurn();
  // The Stop did not go out (its toast says why): nothing is forced.
  if (!turnWasStopped() && app.busy && stopSend.qid === qid) {
    stopSend.key = null;
    stopSend.qid = null;
    return "none";
  }
  return "stopping";
}

/** *Send now* on a pending row, whichever way it can go (item 536). */
export async function sendNowAny(key: string, qid: number): Promise<SendNowResult | "stopping" | "none"> {
  const plan = sendNowPlan(key, qid);
  if (plan === "none" || plan === "reply") return "none";
  if (plan === "now") {
    const r = await sendNowRow(key, qid, false);
    return r === "not_running" ? stopAndSendRow(key, qid) : r;
  }
  if (plan === "hand") {
    const q = readDraft(key).queue.find((r) => r.id === qid);
    if (!q) return "delivered";
    await injectIntoTurn(key, q);
    const after = readDraft(key).queue.find((r) => r.id === qid);
    if (!after) return "delivered";
    if (after.inject?.reply) return "sent";
    if (after.inject) {
      const r = await sendNowRow(key, qid, false);
      return r === "not_running" ? stopAndSendRow(key, qid) : r;
    }
  }
  return stopAndSendRow(key, qid);
}
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

/** A background chat's name, for its toasts and banners. ~~"another
 *  chat" when it has no sidebar row~~ — A4: an ephemeral chat has none,
 *  nor a New chat the list has not re-read yet; its first message names
 *  it, quoted. */
function backgroundName(id: string, events?: SessionEvent[]): string {
  const b = app.background[id];
  // In another project (blocker 630): the list on screen is not its own,
  // so the name it had when it left the screen, and where it is.
  const where = b && inOtherProject(b, app.project?.id ?? null) ? ` in ${b.projectName ?? "unfiled chats"}` : "";
  const s = where ? undefined : app.sessions.find((x) => x.id === id);
  if (s) return chatName(s.title, s.first_user);
  if (b?.name) return b.name + where;
  const first = firstUserText(events ?? b?.events ?? []);
  return (first ? `“${chatName(null, first)}”` : "a chat off screen") + where;
}

/** Where a chat going off screen runs, and what its list calls it (A4). */
function whereItRuns(id: string): { project: string | null; projectName: string | null; name: string | null } {
  const s = app.sessions.find((x) => x.id === id);
  return {
    project: app.project?.id ?? null,
    projectName: app.project?.name ?? null,
    name: s ? chatName(s.title, s.first_user) : null,
  };
}

/** Whether the project can be left or switched now (blocker 630, "allow"):
 *  a running chat goes off screen and keeps its turn. The one wait is a
 *  New chat's first turn before its first event names the chat — it has
 *  no id to be kept under yet. */
export function canLeaveProject(): boolean {
  // Re-read as the first event names the chat (`fg` is not state).
  void app.liveVersion;
  if (app.parked) return fg !== null && canDetach(app.connection?.engine, fg.chat);
  return canLeaveRunning();
}

/** Open a chat running off screen, from anywhere (A4): its own project
 *  first when that is not the open one; the chat then comes back on
 *  screen, streaming, as from its tab. */
export async function openRunningChat(id: string): Promise<void> {
  const b = app.background[id];
  if (b && inOtherProject(b, app.project?.id ?? null)) {
    await useProject(b.project ?? null);
    if ((app.project?.id ?? null) !== (b.project ?? null)) return;
  }
  // Its restored tab may have brought it back already.
  if (app.background[id] || app.activeSessionId !== id) await openSession(id);
}

/**
 * Open the chat a waiting notice names, at its card (nightshift item 523):
 * a chat off screen comes back on screen (in its own project), a parked
 * turn's chat is returned to, the chat on screen leaves a note or page for
 * its transcript — then the card is scrolled into view and focused.
 */
export async function openWaiting(chat: string | null, id: string): Promise<void> {
  if (chat !== null && app.background[chat]) await openRunningChat(chat);
  // While its turn runs `openSession` only brings it forward: back from a
  // parked look-away, out of a note, or its tab to the front.
  else if (chat !== null) await openSession(chat);
  else if (app.view !== "chat") leaveNote();
  // The card is drawn once the chat's transcript is; give it a moment.
  for (let i = 0; i < 40; i++) {
    await tick();
    const card = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-ask-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: "center" });
      card.focus({ preventScroll: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A chat's name for a waiting notice (item 523). */
export function waitingChatName(chat: string | null, where: "screen" | "background" | "parked"): string {
  if (where === "background" && chat !== null) return backgroundName(chat);
  if (where === "parked") return runningChatName();
  return bannerChat();
}

/** Every chat whose turn runs now (A4), for the Running-tasks panel and
 *  the top bar's chip: the screen's (or parked) turn first, then each
 *  off screen, oldest first. `waiting` counts its unanswered prompts. */
export interface LiveChat {
  session: string | null;
  name: string;
  onScreen: boolean;
  startedAt: number | null;
  usage: Usage | null;
  waiting: number;
}
export function liveChats(): LiveChat[] {
  // (A4, blocker 630: a row's name says which project it runs in when that
  // is not the open one — `backgroundName`.)
  const started = (events: SessionEvent[]): number | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "user_message") {
        const t = Date.parse(e.at);
        return Number.isNaN(t) ? null : t;
      }
    }
    return null;
  };
  const out: LiveChat[] = [];
  if (app.busy) {
    const session = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
    const events = app.parked ? app.parked.events : app.events;
    const host = liveHost(app);
    out.push({
      session,
      name: session ? backgroundName(session, events) : "the new chat",
      onScreen: !app.parked,
      startedAt: started(events),
      usage: host.liveUsage,
      waiting: app.pendingApprovals.length,
    });
  }
  for (const b of Object.values(app.background)) {
    out.push({
      session: b.session,
      name: backgroundName(b.session, b.events),
      onScreen: false,
      startedAt: started(b.events),
      usage: b.liveUsage,
      // A budget stop the hook holds for his answer (backlog 189) waits on
      // him too.
      waiting: b.approvals.length + (b.budget?.pending_since_ms ? 1 : 0),
    });
  }
  return out;
}

/**
 * The connection's context window, when it is known to be chat `id`'s
 * (559, the review's 534-2): built for that chat, or for a choice of model
 * and engine that chat's own recorded choice equals — and no connect is
 * running. Otherwise null, so a reading keeps the window stored for the
 * chat rather than taking the previous chat's.
 */
export function connectionWindowFor(id: string | null): number | null {
  const limit = app.connection?.contextLimit ?? null;
  const built = app.connectedFor;
  if (limit === null || !built || app.connecting) return null;
  if (built.chat === id) return limit;
  const wanted = wantedChoice(chatChoice.choices, id);
  return wanted && sameChoice(wanted, built.choice) ? limit : null;
}

/** Whether a turn runs in any chat — on screen, parked or off screen
 *  (A4's gates audit): what a CLI update waits on, where `app.busy` is
 *  "the chat on screen runs". ~~Leaving the project too~~ — blocker 630
 *  ("allow"): `canLeaveProject`. */
export function turnsRunning(): boolean {
  return app.busy || app.parked !== null || Object.keys(app.background).length > 0;
}

/** Whether chat `id`'s own turn runs (A4): its sidebar row cannot be
 *  deleted while it does (the backend refuses it too). */
export function chatRuns(id: string): boolean {
  if (app.background[id] || startingIn.has(id)) return true;
  if (!app.busy) return false;
  const running = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
  return running === id;
}

/** Start times for work that records none (backlog 309). */
const runSeen = new FirstSeen();

/** Where chat `id` lives, for the running list (backlog 309): an off-screen
 *  turn's record says; the chat on screen (or parked) is the open
 *  project's; else the project it was opened in this launch. */
function homeOfChat(id: string | null): { project: string | null; where: string } {
  const named = (project: string | null, name: string | null | undefined) => ({
    project,
    where: name ?? (project === null ? "unfiled chats" : "another project"),
  });
  const b = id ? app.background[id] : undefined;
  if (b) return named(b.project ?? null, b.projectName);
  const here = id === null || id === app.activeSessionId || id === app.parked?.session;
  if (here || !id || !chatHome.has(id)) return named(app.project?.id ?? null, app.project?.name);
  const h = chatHome.get(id)!;
  return named(h.project, h.name);
}

/** A chat's name for the running list: its row's, its record's, its first
 *  message's (`backgroundName`); "the new chat" before it has an id. */
function chatLabel(id: string | null): string {
  if (!id) return "the new chat";
  const b = app.background[id];
  if (b) {
    const s = !inOtherProject(b, app.project?.id ?? null) ? app.sessions.find((x) => x.id === id) : undefined;
    if (s) return chatName(s.title, s.first_user);
    if (b.name) return b.name;
    const first = firstUserText(b.events);
    return first ? `“${chatName(null, first)}”` : "a chat off screen";
  }
  const s = app.sessions.find((x) => x.id === id);
  if (s) return chatName(s.title, s.first_user);
  if (id === app.parked?.session) return backgroundName(id, app.parked.events);
  if (id === app.activeSessionId) return backgroundName(id, app.events);
  return "a chat";
}

/**
 * Everything running now, in every project (nightshift backlogs 308 and
 * 309) — see `running.ts`. Read from the state that already says what runs,
 * so it is never out of step with it: the turn on screen or parked and each
 * off screen (a council when its seats are running), each running subagent
 * of a chat whose turn still runs (a row left `running` by a turn that has
 * ended is the CLI's and gone with it — `subagentAsk` reads them the same
 * way), each asking aside (on screen and stashed), the dream, the capture,
 * the daily pass, the Nightshift interview, and each project's live
 * Nightshift run (detached: it outlives a quit). Note edits are
 * `running.svelte.ts`'s, which adds them.
 */
export function runningWork(now: number = Date.now()): RunEntry[] {
  void app.liveVersion;
  void app.paneVersion;
  const out: RunEntry[] = [];
  const seatsRunning = (chat: string | null) =>
    app.subagents.filter((r) => r.session === chat && r.subagent_type === SEAT_TYPE && subagentRunning(r)).length;
  const turnRow = (
    session: string | null,
    segments: Segment[] | null | undefined,
    events: SessionEvent[],
    onScreen: boolean,
    waiting: boolean,
  ): void => {
    const seats = seatsRunning(session);
    const home = homeOfChat(session);
    out.push({
      id: `turn:${session ?? "new"}`,
      kind: seats > 0 ? "council" : "turn",
      ...home,
      session,
      chat: chatLabel(session),
      doing: waiting ? "waiting on you" : seats > 0 ? `${seats} seat${seats === 1 ? "" : "s"} answering` : doingOf(segments),
      startedAt: lastUserAt(events),
      onScreen,
      waiting,
      survivesQuit: false,
    });
  };
  if (app.busy) {
    const session = app.parked ? app.parked.session : (fg?.chat ?? app.activeSessionId);
    const host = liveHost(app);
    turnRow(session, host.live?.segments, app.parked ? app.parked.events : app.events, !app.parked, app.pendingApprovals.length > 0);
  }
  for (const b of Object.values(app.background)) {
    turnRow(b.session, b.live?.segments, b.events, false, b.approvals.length > 0 || !!b.budget?.pending_since_ms);
  }
  const turnOf = new Map(out.map((r) => [r.session, r]));
  for (const r of app.subagents) {
    if (!subagentRunning(r)) continue;
    const parent = turnOf.get(r.session);
    if (!parent) continue;
    const seat = r.subagent_type === SEAT_TYPE;
    const what = r.description || r.subagent_type || "agent";
    out.push({
      id: `agent:${r.tool_use_id}`,
      kind: seat ? "council seat" : "subagent",
      project: parent.project,
      where: parent.where,
      session: r.session,
      chat: parent.chat,
      doing: seat ? `${shortSeat(r.model)}${r.segments.length ? ` — ${doingOf(r.segments)}` : ""}` : `${what} — ${doingOf(r.segments)}`,
      startedAt: r.startedAt,
      onScreen: parent.onScreen,
      waiting: false,
      survivesQuit: false,
    });
  }
  const asking = (t: AsideTurn) => t.answer === null && t.error === null && !t.cancelled;
  const asideRows = (session: string | null, list: Aside[]) => {
    for (const a of list) {
      const t = a.turns.find(asking);
      if (!t) continue;
      out.push({
        id: `aside:${a.id}:${t.seq}`,
        kind: "aside",
        ...homeOfChat(session),
        session,
        chat: chatLabel(session),
        doing: quoteLine(t.question),
        startedAt: t.startedAt ?? null,
        onScreen: session === app.activeSessionId,
        waiting: false,
        survivesQuit: false,
      });
    }
  };
  asideRows(app.activeSessionId, app.asides);
  for (const [session, list] of asideStash) if (session !== app.activeSessionId) asideRows(session, list);
  const flag = (key: RunKind, running: boolean, where: string, doing: string, survivesQuit = false, project: string | null = null) => {
    const startedAt = runSeen.mark(`${key}:${project ?? ""}`, running, now);
    if (!running) return;
    out.push({
      id: `${key}:${project ?? ""}`,
      kind: key,
      project,
      where,
      session: null,
      chat: "",
      doing,
      startedAt,
      onScreen: false,
      waiting: false,
      survivesQuit,
    });
  };
  // The daily pass sets the capture and dream flags in turn; it is the row.
  flag("daily pass", app.centre.dailyRunning, "memory", "capture → dream → tidy");
  flag("dream", app.dreaming && !app.centre.dailyRunning, "memory", app.dreamActivity || "sorting the inbox into memory");
  flag("capture", app.capturing && !app.centre.dailyRunning, "memory", "reading chat logs into the inbox");
  flag("interview", !!app.nightshift.interview?.busy, "Nightshift", "the item interview is answering");
  for (const r of app.centre.rows) {
    flag("nightshift", !!r.nightshift?.live, r.name, "a shift is running — it keeps running if the app quits", true, r.id);
  }
  return sortRuns(out);
}

/** The council seat's own row type (`council.rs` `SEAT_TASK_TYPE`). */
const SEAT_TYPE = "council seat";
function shortSeat(model: string | undefined): string {
  return model ? `seat on ${model}` : "seat";
}

/** The newest message he sent in `events`, as a clock: a turn's start. */
function lastUserAt(events: SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === "user_message") {
      const t = Date.parse(e.at);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

/**
 * A click on a running row (backlog 309): its chat, in its own project,
 * at the foot of the transcript where the running turn is. A turn running
 * off screen comes back on screen streaming (`openRunningChat`); an aside's
 * chat opens with its cards. App-wide work has no chat and does nothing.
 */
export async function openRun(r: Pick<RunEntry, "session" | "project" | "onScreen">): Promise<void> {
  app.showTasks = false;
  const id = r.session;
  if (!id) return;
  // Opened at its foot: a chat never scrolled this launch opens there anyway.
  rememberScroll(id, 0, true);
  if (!r.onScreen) {
    if (app.background[id] || chatRuns(id)) {
      await openRunningChat(id);
    } else {
      if ((app.project?.id ?? null) !== r.project) {
        await useProject(r.project);
        if ((app.project?.id ?? null) !== r.project) return;
      }
      if (app.activeSessionId !== id) await openSession(id);
    }
  }
  app.toLatest++;
}

/** Whether chat `id` can be deleted now (A4's gates audit): ~~never while
 *  any turn runs~~ — any chat but a running one, on the Claude Code engine,
 *  where each chat has its own lock. ~~A provider turn, or a parked one,
 *  keeps the old rule.~~ Since A4 `browseFree()` is true on either engine,
 *  so a provider turn no longer keeps the old rule either: the backend's
 *  `forget` refuses only the chat whose lock is held (A4 review, struck
 *  2026-09-30). A parked turn still keeps it. */
export function canDeleteChat(id: string): boolean {
  if (chatRuns(id)) return false;
  return !app.busy || (browseFree() && !app.parked);
}

/**
 * What a pane draws of chat `id` (nightshift backlog 159, piece 5): its
 * live state wherever it is kept — off screen, parked, on screen — or its
 * log read for the pane. Null until that log has been read
 * (`loadPaneLog`).
 */
export function paneChat(id: string): PaneChat<Segment, ApprovalRequest> | null {
  return paneChatOf<Segment, ApprovalRequest>(app, id);
}

/** The chats the panes show now: each pane's active chat tab. */
function shownPaneChats(): Set<string> {
  const out = new Set<string>();
  for (const p of app.tabs.panes) {
    const c = tabs.activeTab(p).content;
    if (c.kind === "chat" && c.session) out.add(c.session);
  }
  return out;
}

/** Keep `events` as the pane log of chat `id` when a pane shows it, and
 *  let go of the logs no pane shows any more. */
function keepPaneLog(id: string | null, events: SessionEvent[]): void {
  const shown = shownPaneChats();
  const next = keptPaneLogs(app.paneLogs, shown);
  if (id && shown.has(id)) next[id] = events;
  app.paneLogs = next;
}

const paneReads = new Set<string>();
/**
 * Read chat `id`'s log for the pane that shows it (piece 5): through
 * `transcript` with the chat named — held in memory (an ephemeral chat
 * too) or on disk, and never waiting on a turn. A failed read keeps what
 * the pane had; an empty log draws an empty pane.
 */
export async function loadPaneLog(id: string): Promise<void> {
  if (paneReads.has(id)) return;
  paneReads.add(id);
  try {
    const events = await api.transcript(false, id);
    // An ephemeral chat let go has no log anywhere: what the pane drew
    // stays rather than going blank.
    if (events.length === 0 && app.paneLogs[id]?.length) return;
    keepPaneLog(id, events);
  } catch {
    // The pane keeps what it had; the next turn's end reads it again.
  } finally {
    paneReads.delete(id);
  }
}

/** A turn that ran off screen has ended (piece 5): the pane showing its
 *  chat keeps the record it drew, then reads the log with the reply. */
function refreshPaneLog(id: string, events: SessionEvent[]): void {
  if (!shownPaneChats().has(id)) return;
  keepPaneLog(id, events);
  void loadPaneLog(id);
}

/** Whether a chat can be opened while a turn runs without parking it —
 *  ~~the Claude Code engine's turns go to the background (A2)~~ either
 *  engine's since A4. */
export function browseFree(): boolean {
  return !!app.connection;
}

/** The provider turn running off screen, if one does (A4): the engine
 *  runs one at a time, so a message typed elsewhere meanwhile queues in
 *  its chat and sends when that turn ends. */
export function providerElsewhere(): string | null {
  for (const [id, t] of bgTurns) if (t.provider) return id;
  return null;
}
/** Its name, for the queue's toast. */
export function providerElsewhereName(): string | null {
  const id = providerElsewhere();
  return id ? backgroundName(id) : null;
}

/** Each mounted composer's drain, newest last (A4 review, 2026-09-29): a
 *  provider turn that ends off screen frees the engine, and the message
 *  queued behind it in the chat on screen goes, as its notice promised —
 *  ~~only through the continuation of the composer that sent the turn,
 *  which is another instance once a New chat's Welcome box gave way~~. */
const providerDrains: Array<() => Promise<void>> = [];
export function registerProviderDrain(fn: () => Promise<void>): () => void {
  providerDrains.push(fn);
  return () => {
    const i = providerDrains.lastIndexOf(fn);
    if (i >= 0) providerDrains.splice(i, 1);
  };
}

/** The same composers' explicit drain (item 503): a block he ran has ended
 *  and the chat on screen is idle, so its output goes now. Explicit: a Stop's
 *  hold on the queue is about what he had queued, not what he just ran. */
const runDrains: Array<() => Promise<void>> = [];
export function registerRunDrain(fn: () => Promise<void>): () => void {
  runDrains.push(fn);
  return () => {
    const i = runDrains.lastIndexOf(fn);
    if (i >= 0) runDrains.splice(i, 1);
  };
}
export async function runDrainNow(): Promise<void> {
  await runDrains.at(-1)?.();
}

/** The chat of the turn on screen, read later (item 503): a New chat's first
 *  reply has a Run before the chat has an id, and the turn learns it. */
export function turnChatRef(): () => string | null {
  const t = fg;
  return () => t?.chat ?? null;
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
  firstTurnChat.chat = null;
  // And what he queued on its New chat page goes with it (backlog 375).
  if (t.pendingKey) moveQueue(t.pendingKey, id);
  const mine = (r: ApprovalRequest) => !r.chat || r.chat === id;
  app.background[id] = {
    session: id,
    pendingMode: app.pendingMode,
    pendingKind: app.pendingKind,
    pendingFromScreen: true,
    events: app.events,
    live: app.live,
    liveUsage: app.liveUsage,
    approvals: app.pendingApprovals.filter(mine),
    // Its meter and its init line go with it (A4): the chat opened next
    // shows its own, not this one's.
    budget: app.budgetSession === id ? app.turnBudget : null,
    agentInit: app.agentInit,
    ...whereItRuns(id),
  };
  app.pendingApprovals = app.pendingApprovals.filter((r) => !mine(r));
  t.detached = true;
  bgTurns.set(id, t);
  fg = null;
  app.live = null;
  app.liveUsage = null;
  app.busy = false;
  if (app.budgetSession === id) {
    app.turnBudget = null;
    app.budgetSession = null;
  }
  app.agentInit = null;
  // The clock keeps reading its ledger off screen.
  ensureBudgetPoll();
  return true;
}

/** A parked turn whose chat has just been named goes to the background,
 *  so the chat on screen stops waiting on it (A2). */
function promoteParked(): void {
  const t = fg;
  const p = app.parked;
  if (!t || !p || !canDetach(app.connection?.engine, t.chat)) return;
  const id = t.chat as string;
  app.background[id] = {
    ...p,
    session: id,
    // `park` took them off the screen as the chat left it (559).
    pendingFromScreen: true,
    approvals: app.pendingApprovals.filter((r) => !r.chat || r.chat === id),
    budget: app.budgetSession === id ? app.turnBudget : null,
    ...whereItRuns(id),
  };
  app.pendingApprovals = app.pendingApprovals.filter((r) => r.chat && r.chat !== id);
  app.parked = null;
  // What he queued on its New chat page is its (backlog 375), not the
  // next New chat's of the project.
  if (t.pendingKey) moveQueue(t.pendingKey, id);
  t.detached = true;
  bgTurns.set(id, t);
  fg = null;
  app.busy = false;
  // The chat on screen is idle now: what he queued in it while the turn
  // was parked goes, as its toast said (375 — the turn's own end no longer
  // drains a chat that is not its own).
  void providerDrains.at(-1)?.();
  // The meter on screen is the viewed chat's now (A4).
  if (app.budgetSession === id) {
    app.turnBudget = null;
    app.budgetSession = null;
  }
  ensureBudgetPoll();
}

/** A background chat back on screen, streaming (A2); whatever turn was on
 *  screen goes to the background in its place. */
async function attach(id: string): Promise<void> {
  const b = app.background[id];
  const t = bgTurns.get(id);
  if (!b || !t) return;
  // Its own project first (blocker 630): its log, tab and list are there.
  if (inOtherProject(b, app.project?.id ?? null)) {
    await openRunningChat(id);
    return;
  }
  if (app.busy && !detach()) {
    addToast("A turn is just starting here — open that chat again in a moment");
    app.openNext = "replace";
    return;
  }
  // The chat being left, for the other pane when it shows it (piece 5).
  const leaving = app.activeSessionId;
  if (leaving && leaving !== id) keepPaneLog(leaving, app.events);
  delete app.background[id];
  bgTurns.delete(id);
  t.detached = false;
  fg = t;
  switchAside(id);
  app.activeSessionId = id;
  // Only what this chat's own screen held when it left (559, 535-5).
  if (b.pendingFromScreen) {
    app.pendingMode = b.pendingMode;
    app.pendingKind = b.pendingKind;
  }
  app.events = b.events;
  app.live = b.live;
  app.liveUsage = b.liveUsage;
  app.pendingApprovals.push(...b.approvals);
  app.busy = true;
  // Its meter and init line back with it (A4); the clock is running.
  app.budgetSession = id;
  app.turnBudget = b.budget ?? null;
  app.agentInit = b.agentInit ?? null;
  ensureBudgetPoll();
  app.liveVersion++;
  app.error = null;
  app.suggestion = null;
  leaveNote();
  await refocus(id);
}

/** A background turn's end (A2): nothing on screen changes; the chat's
 *  record is on disk (or held, for an ephemeral chat), its row refreshes,
 *  and a light toast says where the reply is. */
/** What the turn's alias resolved to (item 511), for the model menu's
 *  numbers: a Claude Code turn on an alias, with the CLI version now. */
function learnModel(t: TurnCtx, res: AgentTurnResult | null): void {
  if (!res?.model || t.choice?.engine !== "claude-code") return;
  noteResolved(t.choice.agentModel, res.model, currentCliVersion(cli.status?.installed, app.connection?.agent?.version));
}

function endBackground(t: TurnCtx, failed: string | null, res: AgentTurnResult | null): void {
  learnModel(t, res);
  const id = t.chat as string;
  const b = app.background[id];
  // Named before its record goes: an ephemeral chat is named from it (A4).
  const name = backgroundName(id, b?.events);
  // A pane showing it keeps drawing it, then reads the reply from its log
  // (piece 5) — before the record goes, so the pane never goes blank.
  if (b) refreshPaneLog(id, b.events);
  delete app.background[id];
  bgTurns.delete(id);
  clearHandBack(id);
  const used = b?.liveUsage ? b.liveUsage.input_tokens + b.liveUsage.output_tokens : null;
  const errored = failed !== null || res?.is_error === true;
  // The turn-end banner for an unfocused window (backlog 079), as the
  // screen's turn posts it — A4: a background end posted none.
  notifyEnd({
    chat: name,
    events: b?.events ?? [],
    segs: b?.live?.segments ?? [],
    usage: b?.liveUsage ?? null,
    ranIn: id,
    error: failed,
    cliError: res?.is_error === true,
  });
  addToast(backgroundEndToast(name, failed));
  for (const n of turnNotices(res?.notices ?? [], t.stopped === true)) addToast(n);
  // Its list and notes are its project's (blocker 630): re-read only when
  // that is the one open; coming back to it reads them fresh anyway.
  if (!b || !inOtherProject(b, app.project?.id ?? null)) {
    void refreshSessions();
    void refreshNotes();
    // Item 464: a thread chat's `<handoff>` prompt is kept on its thread
    // (the open project's threads only).
    if (b) noteThreadHandoff(id, b.events);
  }
  if (t.provider) {
    // A provider turn's end (A4 review, 2026-09-29) does what the
    // screen's provider end does — ~~the plan meter and the Claude Code
    // wrap-up's fill, which could queue a wrap-up message into a provider
    // chat~~ — the Dream and Capture badges follow the turn it logged.
    void refreshDreamStatus();
    void refreshCaptureStatus();
    // The engine is free: the chat on screen's queue goes (its drain waits
    // on its own turn, a hold, or another provider turn).
    void providerDrains.at(-1)?.();
  } else {
    // Item 323 review: the reading at the reply's end closes its usage
    // line now (`readPlanAtReplyEnd`; skipped while one is in flight).
    void readPlanAtReplyEnd();
    // ~~`app.connection?.contextLimit`~~ — the connection at the turn's
    // end, possibly another engine's (A4 review): the turn's own.
    noteAgentTurnEnd(id, used, t.contextLimit !== undefined ? t.contextLimit : (app.connection?.contextLimit ?? null), null, false);
  }
  // Was it sleep that ended it (backlog 101)? A4: a background turn's end
  // reached the watch not at all.
  sleepTurnEnded(errored, b?.events ?? [], id, t.stopped === true);
  // Blocker 1467 (his answer, 2026-10-18): what he queued in it goes now,
  // in its own chat, in the background — after this `finally` has settled
  // the rows the turn took or handed back.
  const ok = !errored && !(res && limitPauseFrom(res, id));
  // Paused by the usage limit off screen (543): its own entry, resumed at
  // the reset as a chat on screen is — before 543 it had no card at all.
  if (res) noteTurnLimit(id, res, b ? { id: b.project ?? null, name: b.projectName ?? null } : homeFor(id), b?.live ? liveText(b.live.segments) : null);
  queueMicrotask(() => void sendQueuedInBackground(t, b, ok));
}

/**
 * The next message queued in a chat whose turn just ended off screen,
 * sent at once in that chat, in the background (nightshift blocker 1467,
 * his answer: "it should be right away in that chat in the background")
 * — the chat he is in is untouched. The row comes through `turnOwnsKey`
 * (375): only the ended turn's own chat's queue, and the backend is told
 * that chat and its project by id (`send_agent`'s `chat`), so it runs
 * there or is refused; it never reads the focus. Not after a Stop, a
 * failure or a usage-limit pause (the queue waits, as on screen), not on
 * the provider engine (one turn at a time; its own drain), and not when
 * the chat is on screen again (the composer drains it). `true` when sent.
 */
export async function sendQueuedInBackground(
  ended: Pick<TurnCtx, "chat" | "pendingKey" | "stopped" | "provider" | "contextLimit"> & Pick<Partial<TurnCtx>, "choice">,
  was: Pick<Background<Segment, ApprovalRequest>, "pendingMode" | "pendingKind" | "project" | "projectName" | "name"> | undefined,
  ok: boolean,
): Promise<boolean> {
  const id = ended.chat;
  if (!id || !ok || ended.stopped || ended.provider) return false;
  if (app.activeSessionId === id || app.background[id] || bgTurns.has(id)) return false;
  const q = takeQueuedFor(ended, id);
  if (!q) return false;
  if (q.attachments.some((c) => c.pending || !c.data)) {
    requeueFront(id, q);
    return false;
  }
  return runInChat(id, q, was, ended);
}

/**
 * One message sent in chat `id` off screen, the chat on screen untouched:
 * `sendQueuedInBackground`'s send (blocker 1467), which a scheduled
 * message uses too (backlog 535). The backend is told the chat and its
 * project by id and runs it there or refuses. A refusal before anything
 * was sent puts the row back at the head of the chat's own queue — or,
 * with `refusedTo`, hands the reason to the caller, who keeps the words
 * (a scheduled message goes back to waiting). `true` when sent.
 */
export async function runInChat(
  id: string,
  q: QueuedMessage,
  was: Pick<Background<Segment, ApprovalRequest>, "pendingMode" | "pendingKind" | "project" | "projectName" | "name"> | undefined,
  ended: Pick<TurnCtx, "contextLimit"> & Pick<Partial<TurnCtx>, "choice">,
  refusedTo?: (why: string) => void,
): Promise<boolean> {
  const images = q.attachments.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data }));
  const documents = q.attachments
    .filter((a) => a.kind === "document")
    .map(({ media_type, name, data }) => ({ media_type, name, data }));
  const files = q.attachments.filter((a) => a.kind === "file").map(({ name, data }) => ({ name, data }));
  const project = was?.project ?? null;
  const turn: TurnCtx = { chat: id, detached: true, key: newTurnKey(), contextLimit: ended.contextLimit, pendingKey: null, choice: ended.choice };
  const mine: SessionEvent = {
    event: "user_message",
    text: q.text,
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    at: new Date().toISOString(),
    // Item 515: the files' names, so a file-only send is not an empty pill.
    ...(files.length > 0 ? { sending_files: files.map((f) => f.name) } : {}),
  };
  app.background[id] = {
    session: id,
    pendingMode: was?.pendingMode ?? "normal",
    pendingKind: was?.pendingKind ?? app.pendingKind,
    events: [mine],
    live: { segments: [] },
    liveUsage: null,
    approvals: [],
    budget: null,
    agentInit: null,
    project,
    projectName: was?.projectName ?? null,
    name: was?.name ?? null,
  };
  bgTurns.set(id, turn);
  // Its log under the message, for the tab and a pane showing it.
  void api
    .transcript(false, id)
    .then((events) => {
      const b = app.background[id];
      if (b && bgTurns.get(id) === turn) b.events = [...events, mine];
    })
    .catch(() => {});
  let failed: string | null = null;
  let res: AgentTurnResult | null = null;
  let delivered: string[] = [];
  try {
    res = await api.sendAgent(
      q.text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
      undefined,
      turn.key,
      undefined,
      files.length > 0 ? files : undefined,
      { chat: id, project },
    );
    delivered = res.delivered ?? [];
  } catch (e) {
    failed = String(e);
  }
  // Refused before anything was sent (the chat not loaded, or its project
  // closed with no agent of its own): back at the head of its own queue.
  const refused = failed !== null && /stays queued there|nothing was sent/.test(failed);
  if (refused && !refusedTo) requeueFront(id, q);
  settleInjected(turn.key, delivered);
  injectLater.delete(turn.key);
  closeRunningRows(app.subagents, id);
  if (turn.detached) {
    if (refused) {
      delete app.background[id];
      bgTurns.delete(id);
      if (refusedTo) refusedTo(failed ?? "");
      else addToast(`${was?.name ?? "A chat"}: its queued message is waiting there — ${failed}`);
    } else endBackground(turn, failed, res);
    return !refused;
  }
  // He opened it while it ran (`attach`): its end on screen, then the
  // composer's drain takes the next row of the chat open — this one.
  if (fg === turn) fg = null;
  notifyTurnEnded(failed);
  // Its reply, for the hand-off and the continue-later ask (543m review: an
  // end on screen here read none, so a turn he opened mid-way never
  // handed off or asked) — the live words, before they are cleared.
  const liveReply = app.live ? liveText(app.live.segments) : "";
  app.live = null;
  app.liveUsage = null;
  app.pendingApprovals = [];
  clearHandBack();
  app.busy = false;
  if (failed !== null && !refused) app.error = failed;
  if (refused && refusedTo) refusedTo(failed ?? "");
  await settleTurnView(null, id, null);
  const reply = liveReply || (app.activeSessionId === id ? lastReplyText(app.events) : "");
  if (res) noteTurnLimit(id, res, { id: project, name: was?.projectName ?? null }, reply || null);
  void refreshSessions();
  void readPlanAtReplyEnd();
  if (failed === null) void providerDrains.at(-1)?.();
  return !refused;
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
    else frontOpenChat();
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
  clearPendingThread();
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

/** The chat and project on screen (535f, the review's 534-1), taken
 *  before an await whose answer is "the open chat's events". */
export function viewMark(): { chat: string | null; project: string | null } {
  return { chat: app.activeSessionId, project: app.project?.id ?? null };
}

/** Whether the screen still shows the chat `mark` was taken on. */
export function sameView(mark: { chat: string | null; project: string | null }): boolean {
  return app.activeSessionId === mark.chat && (app.project?.id ?? null) === mark.project;
}

/** `call`'s events adopted as the view only while the chat it was made on
 *  is still on screen (534-1's class: rewind, edit, restore, remove and
 *  their undo/redo; the phone's unrewind): he may open another chat in
 *  the round trip, and that chat's view and size are its own. The change
 *  itself is on disk either way. `true` when adopted. */
export async function adoptOpen(call: () => Promise<SessionEvent[]>): Promise<boolean> {
  const mark = viewMark();
  const events = await call();
  if (!sameView(mark)) return false;
  app.events = events;
  return true;
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
  // A pane showing the parked chat reads its reply from its log (piece 5).
  if (parked?.session) refreshPaneLog(parked.session, parked.events);
  app.parked = null;
  // 535f (the review's 534-1): the chat on screen before the read — he
  // may click another in the round trip (busy is already false).
  const mark = viewMark();
  try {
    // The chat the turn ran in, whichever is open now (backlog 159, A1:
    // the backend's open chat follows the screen during the turn) — by
    // its id when known (A2: two turns may have run; "the latest" may be
    // the other's).
    const events = chat ? await api.transcript(false, chat) : await api.transcript(true);
    const first = events[0];
    const made = first && first.event === "session_created" ? first.id : null;
    // Left during the read: treated as browsed — its log stays on disk
    // and the chat he opened keeps its own (`openSession` aligned the
    // backend), but a New chat's draft still follows the chat it made.
    const left = !parked && !sameView(mark);
    const plan = left
      ? {
          adopt: false,
          activeSessionId: undefined,
          moveDraft: made !== null && pendingKey !== null && mark.chat === null ? ([pendingKey, made] as [string, string]) : null,
          realign: null,
        }
      : settlePlan({ parked, viewed: app.activeSessionId, made, pendingKey });
    // A New chat's agents, made before its id was known (backlog 160).
    if (made) adoptPending(app.subagents, made);
    // And the model and engine its first turn ran on (backlog 205), before
    // the view moves to it and the choice is read back.
    if (made && choice) {
      noteMade(chatChoice.choices, made, choice);
      saveChatChoices();
    }
    // And the subagent rules typed in its box (backlog 291).
    if (made) adoptChatRules(made);
    if (plan.moveDraft) moveDraft(plan.moveDraft[0], plan.moveDraft[1]);
    if (plan.adopt) app.events = events;
    if (plan.activeSessionId !== undefined) app.activeSessionId = plan.activeSessionId;
    if (plan.realign?.kind === "open") app.events = await api.openSession(plan.realign.id);
    else if (plan.realign?.kind === "new") await api.newSession(app.pendingMode, app.pendingKind);
  } catch {
    // keep the locally-built view if re-sync fails
  } finally {
    // Item 615: the open chat now names it (or he left); the stand-in goes.
    firstTurnChat.chat = null;
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
  // The chat being left, for the other pane when it shows it (piece 5).
  const leaving = app.activeSessionId;
  const leavingEvents = app.events;
  try {
    app.events = await api.openSession(id);
    // The aside thread stays with the chat being left and the opened
    // chat's comes back (backlog 130).
    switchAside(id);
    app.activeSessionId = id;
    if (leaving && leaving !== id) keepPaneLog(leaving, leavingEvents);
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
    // Backlog 297: in front as the open chat, but maybe behind a tab that
    // changes nothing global (a thread's) — its tab comes forward.
    if (inFront) frontOpenChat();
    if (inFront) app.openNext = "replace";
  } catch (e) {
    app.error = String(e);
    app.openNext = "replace";
  }
}

/** Compact the active session: earlier turns collapse into a summary. */
export async function compactSession(): Promise<void> {
  if (!app.connection || app.busy) return;
  releaseStop(stopClock);
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
  // ~~`if (app.busy) return;`~~ — A4: a running chat is refused in words,
  // another chat is deleted while a turn runs (the backend refuses only the
  // running one, since A1).
  if (!canDeleteChat(id)) {
    addToast("That chat is running a turn — delete it when the turn ends");
    return;
  }
  let full: string;
  try {
    full = await api.deleteSession(id, app.activeSessionId);
    if (id === app.activeSessionId || full === app.activeSessionId) {
      switchAside(null); // its asides stay its own (backlog 203), for the undo
      app.activeSessionId = null;
      clearPendingThread();
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
        clearPendingThread();
        app.events = [];
      }
      await refreshSessions();
    },
  });
}

/**
 * *Move to project…* (nightshift backlog 370): the chat leaves this
 * project's list for project `to`'s (null: the unfiled chats), while the
 * app runs. Refused in words while its turn runs, like a delete. Its id
 * does not change, so its draft and queued rows (keyed by the id, backlog
 * 375) go with it untouched; its chat tab goes to the other project's
 * stored workspace (`carryTabsTo`), the rest of its tabs close here.
 * No undo: the chat is no longer in this list to move back from — it is
 * moved back from the other project's list the same way.
 */
export async function moveSession(id: string, to: string | null): Promise<boolean> {
  if (!canDeleteChat(id)) {
    addToast("That chat is running a turn — move it when the turn ends");
    return false;
  }
  const carried = tabs
    .allTabs(app.tabs)
    .filter((t) => t.content.kind === "chat" && t.content.session === id)
    .map((t) => t.content);
  let full: string;
  try {
    full = await api.moveSession(id, to);
  } catch (e) {
    addToast(String(e));
    await refreshSessions();
    return false;
  }
  if (id === app.activeSessionId || full === app.activeSessionId) {
    switchAside(null);
    app.activeSessionId = null;
    clearPendingThread();
    app.events = [];
  }
  dropChatTabs(full);
  if (typeof localStorage !== "undefined") carryTabsTo(localStorage, to ?? UNFILED_TABS, carried);
  await refreshSessions();
  const where = to === null ? "No project (unfiled chats)" : (app.projects.find((p) => p.id === to)?.name ?? "the other project");
  addToast(`Moved to ${where}`);
  void refreshProjects();
  return true;
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
export async function remoteSend(
  chat: string | null,
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
  spoken = false,
): Promise<"sent" | "queued"> {
  if (chat && chat !== app.activeSessionId) {
    if (app.busy) throw new Error("the desktop is busy in another chat — held on the phone until it is free");
    await openSession(chat);
    if (chat !== app.activeSessionId) {
      throw new Error(app.error ? `the desktop could not open that chat: ${app.error}` : "the desktop could not open that chat");
    }
  }
  if (app.busy || providerElsewhere()) {
    // ~~The Mac's queue holds `Attachment`s, not the phone's `ImageInput`s:
    // a message with files or a council stays on the phone until the turn ends.~~
    // Backlog 339: into the running turn at its next step, as a typed
    // one goes — files too, as queue chips. A council, or files while the
    // engine is busy in another chat, still wait on the phone.
    const chips = chipsFromInputs(images, documents, nextAttachmentId);
    if (council !== null || (chips.length > 0 && (!app.busy || app.parked)))
      throw new Error("this chat is running a turn on the Mac — the message and its files are held on the phone until it ends");
    const key = openChatKey();
    const row = enqueueMessage(key, text, chips);
    if (app.busy && !app.parked) void injectIntoTurn(key, row);
    return "queued";
  }
  if (!app.connection) throw new Error("no engine is connected on the desktop — connect one there first");
  // The Mac's new-chat screen in a thread (item 510): bound before the phone
  // hears the message was taken, so a refusal leaves it held there.
  if (!(await bindPendingThread())) throw new Error(app.error ?? "the desktop could not bind the new chat's thread");
  // Answered before the turn, not after: `send` resolves at the turn's
  // end, and the phone is waiting to hear the message was taken. A queued
  // message (above) goes later as a typed one — spoken or not, the words
  // are kept; only the "for the ear" note is lost.
  void sendUntyped(text, images, documents, council, spoken);
  return "sent";
}

/**
 * A new chat from the phone (item 246): in `project` when it names one
 * that is not open (the window switches to it, as the project menu does),
 * then the New chat state, then the message — which creates the log, as a
 * first message typed here does. Refused, never queued, while a turn runs:
 * leaving the running chat's project mid-turn is not the phone's call.
 */
export async function remoteNewChat(project: string | null, text: string): Promise<"sent" | "queued"> {
  if (app.busy) throw new Error("the desktop is running a turn — start the new chat when it ends");
  if (project && project !== app.project?.id) {
    await useProject(project);
    if (app.project?.id !== project) throw new Error("the desktop could not open that project");
  }
  await newSession();
  if (app.activeSessionId !== null) throw new Error(app.error ? `the desktop could not start a chat: ${app.error}` : "the desktop could not start a chat");
  if (!app.connection) throw new Error("no engine is connected on the desktop — connect one there first");
  void sendUntyped(text);
  return "sent";
}

/**
 * Send a message into chat `id` of `project` now — that chat, whatever is
 * on screen (nightshift backlog 535: a scheduled message, the limit card's
 * resume). The caller has checked that no turn runs in it (`chatRuns`).
 * When it is the chat on screen the turn runs there, as a typed one would,
 * with the backend told the chat by id (`turnTarget`) so it can never land
 * in another; otherwise it runs off screen in its own chat and project
 * (`runInChat`) and the view does not change. A refusal before anything
 * was sent goes to `refused` with the reason — the caller still has the
 * words.
 */
export function sendInChat(
  id: string,
  project: { id: string | null; name: string | null },
  text: string,
  attachments: Attachment[],
  refusedTo: (why: string) => void,
): void {
  // Sent, the chat's kept spec goes (535f, 535-4); refused, it stays for
  // the retry.
  let wasRefused = false;
  const refused = (why: string) => {
    wasRefused = true;
    refusedTo(why);
  };
  const sent = () => {
    if (!wasRefused) releaseSpec(id);
  };
  // Off screen in its own chat and project, keyed (`runInChat`): also
  // where an on-screen send goes when he leaves the chat during its
  // reconnect (535f, 535-1).
  const away = () => {
    const row = app.sessions.find((x) => x.id === id);
    return runInChat(
      id,
      { id: nextQueueId(), text, attachments: attachments.map((a) => ({ ...a })) },
      {
        pendingMode: "normal",
        pendingKind: app.pendingKind,
        project: project.id,
        projectName: project.name,
        name: row && (app.project?.id ?? null) === project.id ? chatName(row.title, row.first_user) : null,
      },
      // Its own window as last read (535f, the review's 535-5), not the
      // chat on screen's connection; unknown is null, never a guess.
      { contextLimit: contextOf(id)?.limit || null },
      refused,
    );
  };
  const here = id === app.activeSessionId && (app.project?.id ?? null) === project.id;
  if (here) {
    if (!app.connection || app.busy) {
      refused(app.connection ? "its chat is busy" : "no engine is connected");
      return;
    }
    const images = attachments.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data }));
    const documents = attachments
      .filter((a) => a.kind === "document")
      .map(({ media_type, name, data }) => ({ media_type, name, data }));
    const files = attachments.filter((a) => a.kind === "file").map(({ name, data }) => ({ name, data }));
    turnTyped = false;
    turnSpoken = false;
    turnTarget = { chat: id, project: project.id };
    // 535f (535-1): the chat counts as running from this moment, and if
    // he leaves it (or a turn starts in it) during the reconnect, the
    // message goes off screen into it, or back to its caller.
    turnElsewhere = async (busyHere) => {
      if (busyHere) refused("its chat is busy");
      else await away();
    };
    void send(text, images, documents, null, files).then(() => {
      // Refused before anything was sent (the backend's two wordings):
      // the caller keeps the words; the error is not this chat's to show.
      const e = app.error;
      if (e && app.activeSessionId === id && /stays queued there|nothing was sent/.test(e)) {
        app.error = null;
        refused(e);
      }
      sent();
    });
    return;
  }
  void away().then(sent);
}

// A chat whose resume waits keeps its spec when its scheduled message
// leaves (535f, 535-4): the resume may go off screen on it.
// ~~`app.limitResumeAt !== null && app.limitPause?.session === key`~~ — one
// slot; since 543 any chat with an entry that has a time.
wantSpec((key) => resumes[key] !== undefined && resumes[key].at !== null);

/**
 * Resume a turn the usage limit paused (nightshift backlog 164): sends the
 * continue that names the subagents that died. Before the window has
 * reset it is scheduled for the reset plus a margin — never into a window
 * that is still exhausted — and `app.limitResumeAt` says so on the card;
 * a second click while it waits cancels.
 *
 * The time is kept by the backend's clock (backlog 535, `wake.rs`: the
 * `limit` wake), not only by a timer in the page — a hidden window's
 * timer stopped, and his resume went an hour late. And it goes into the
 * chat that was paused, whatever is on screen by then: there when that
 * chat is open, off screen in its own chat and project otherwise
 * (`sendInChat`; its agent spec is kept at the click). ~~else it is
 * dropped with a toast, since a turn cannot start in a chat that is not
 * open~~ — only a chat that is running another turn by then is left, with
 * a toast.
 */
/** Every chat waiting to be continued by Nightloom, by chat id (backlog
 *  543, `chatResume.ts`): a turn the limit paused, each with its own time
 *  — ~~one slot, one timer~~ — kept across a relaunch. `app.limitPause`
 *  and `app.limitResumeAt` are the open chat's entry, as the card and the
 *  phone read them (`showResume`). */
export const resumes: Record<string, ChatResume> = $state(loadResumes());
function loadResumes(): Record<string, ChatResume> {
  try {
    return readResumes(localStorage.getItem(RESUMES_KEY));
  } catch {
    return {};
  }
}
function saveResumes(): void {
  try {
    localStorage.setItem(RESUMES_KEY, writeResumes(resumes));
  } catch {
    // Storage refused: the entries hold for this launch only.
  }
}
/** The suite's reset: no entry, no timer. */
export function clearResumes(): void {
  for (const k of Object.keys(resumes)) delete resumes[k];
  resumeWent.clear();
  resuming.clear();
  handedOff.clear();
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
}
let limitTimer: ReturnType<typeof setTimeout> | null = null;
/** When each chat's last entry was sent (`limitResumeTime`'s loop guard). */
const resumeWent = new Map<string, number>();
/** The entries being checked with the backend right now: sent once. */
const resuming = new Set<string>();
/** The pending chat's key: a pause with no chat id yet. */
const NO_CHAT = "";

function resumeLog(text: string): void {
  void api.scheduleLog(`resume ${text}`).catch(() => {});
}

/** The open chat's entry on `app`, for the transcript's card. */
function showResume(): void {
  const r = resumes[app.activeSessionId ?? NO_CHAT];
  app.limitPause = r?.pause ?? null;
  app.limitResumeAt = r?.pause ? r.at : null;
}

/** After any change to the entries: the backend's clock is told the
 *  earliest time (the `limit` wake — it asks again every 15 s while that
 *  time is past and the entry still waits), the page's own timer follows,
 *  the card is redrawn and the store is written. */
function armResumes(): void {
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  const at = nextResumeAt(resumes);
  void api.armWake("limit", at).catch(() => {});
  if (at !== null) {
    // A time already past is an entry waiting on something (no engine, its
    // project closed): looked at again, not spun on.
    const wait = at - Date.now();
    limitTimer = setTimeout(
      () => {
        // The page's own clock ran it (item 535m's log line).
        void api.scheduleLog("limit timer").catch(() => {});
        void runResumes();
      },
      Math.min(wait > 0 ? wait : 15_000, 0x7fffffff),
    );
  }
  showResume();
  saveResumes();
}

/** The words of a reply still held as live segments (a turn that ended
 *  off screen or parked: its log is not re-read here). */
function liveText(segs: readonly Segment[]): string {
  return segs.map((g) => (g.kind === "text" ? g.text : "")).filter((t) => t).join("\n");
}

/** Where chat `id` lives, as far as this launch knows. */
function homeFor(id: string | null): { id: string | null; name: string | null } {
  const known = id ? chatHome.get(id) : undefined;
  return id === app.activeSessionId || !known
    ? { id: app.project?.id ?? null, name: app.project?.name ?? null }
    : { id: known.project, name: known.name };
}

/**
 * A turn in `chat` ended with `res` (backlog 543): on the usage limit, the
 * chat gets its entry — with its time set, so it goes by itself at the
 * reset (nightshift blocker 1738) and, the resumed turn making the next
 * entry the same way, at every reset after until the turn ends some other
 * way. Any other end clears a pause the chat had (164: "kept until a turn
 * runs in that chat again"). On screen or off, in any project.
 */
function noteTurnLimit(
  chat: string | null,
  res: AgentTurnResult,
  home: { id: string | null; name: string | null },
  reply: string | null = null,
): void {
  const key = chat ?? NO_CHAT;
  const p = limitPauseFrom(res, chat);
  if (!p) {
    // 543b: the reply asked to be continued later (`<continue-later>`) —
    // the chat stopped short of the limit with work left, or wants a time.
    // Its entry goes by the same clock; a newer ask replaces an older one.
    // 544: a reply that holds the next chat's prompt is a hand-off — the
    // work goes on in the linked chat, by itself when he is away.
    const prompt = chat && !res.is_error && reply ? extractStartPrompt(reply) : null;
    if (chat && prompt) void handOffUnattended(chat, prompt, home);
    const ask = chat && !res.is_error && reply && !prompt ? extractContinue(reply) : null;
    if (chat && ask) {
      resumes[key] = askedResume(chat, home, ask, app.planUsage, Date.now());
      resumeLog(`asked ${key.slice(0, 8)} at=${new Date(resumes[key].at as number).toISOString()} (${ask.at})`);
      if (app.connection?.engine === "claude-code") void api.reserveChatAgent(chat, true).catch(() => {});
      armResumes();
      return;
    }
    // ~~`resumes[key]?.why === "limit"`~~ (543m review): an ask is ended by
    // a turn that ran in the chat too — a message he sent there before its
    // time continued it, and the ask's stale "you asked to be continued"
    // must not follow hours later. The resumed turn's own entry was taken
    // at its send (`goResume`), so this never drops the entry it made.
    if (resumes[key]) {
      delete resumes[key];
      armResumes();
    }
    return;
  }
  const at = chat ? limitResumeTime(p, Date.now(), resumeWent.get(key) ?? null) : null;
  resumes[key] = { chat: key, project: home, at, why: "limit", text: resumeMessage(p), pause: p };
  resumeLog(`paused ${key.slice(0, 8)} project=${home.id ?? "unfiled"} at=${at === null ? "his click" : new Date(at).toISOString()}`);
  // Its agent spec is kept for the time, so it runs in its own project
  // whatever is open then (535).
  if (chat && at !== null && app.connection?.engine === "claude-code") void api.reserveChatAgent(chat, true).catch(() => {});
  armResumes();
}

/** The Mac's idle time, read now for the hand-off's away rule (544). */
async function readIdle(): Promise<void> {
  try {
    noteSystemIdle(await api.idleSeconds());
  } catch {
    noteSystemIdle(null);
  }
}

/** The replies already continued by Nightloom this launch (`chat|prompt`). */
const handedOff = new Set<string>();

/**
 * An unattended chat hands off by itself (backlog 544; his words: "is it
 * automatically gonna do that handoff message and then click continue in
 * the next chat"). A turn in `chat` ended with the next chat's `prompt` in
 * its reply — the wrap-up's, or one the model wrote unasked. If he is away
 * (`awayNow`: nothing typed for a minute and the window not in front or
 * the chat not open, or no input on the Mac for ten minutes) the linked
 * chat is started and the prompt sent with no click: on screen through the
 * card's own `continueWithPrompt`; off screen where the chat lives, the
 * view untouched (`continue_chat`, then the keyed send). The new chat runs
 * unattended too, so its limit pause, its ask to be continued and its own
 * hand-off all go the same way. With him present the card waits for his
 * click, as before. A chat whose mark is "never" (545) is left alone.
 */
async function handOffUnattended(chat: string, prompt: string, home: { id: string | null; name: string | null }): Promise<void> {
  if (app.connection?.engine !== "claude-code" || hasHiddenChars(prompt) || neverHandsOff(chat)) return;
  const once = `${chat}|${prompt}`;
  if (handedOff.has(once)) return;
  await readIdle();
  const onScreen = chat === app.activeSessionId && (app.project?.id ?? null) === home.id;
  if (!awayNow(onScreen)) return;
  if (handedOff.has(once) || chatRuns(chat)) return;
  handedOff.add(once);
  const text = firstMessage("", prompt);
  resumeLog(`handoff ${chat.slice(0, 8)} ${onScreen ? "on screen" : "off screen"} project=${home.id ?? "unfiled"}`);
  if (onScreen) {
    if (app.busy) {
      handedOff.delete(once);
      return;
    }
    let index = app.events.length - 1;
    while (index > 0 && app.events[index].event !== "assistant_message") index--;
    await continueWithPrompt(chat, index, prompt);
    if (app.activeSessionId !== chat) markUnattended(app.activeSessionId);
    return;
  }
  let next: string;
  try {
    next = await api.continueChat(chat, home.id);
  } catch (e) {
    handedOff.delete(once);
    resumeLog(`handoff ${chat.slice(0, 8)} not continued: ${String(e)}`);
    return;
  }
  const thread = threadFor(chat);
  leaveHandoff(chat);
  carryReadOrder(chat, next);
  noteThread(next, thread);
  noteChatProject(next, home.id);
  chatHome.set(next, { project: home.id, name: home.name });
  if (thread && (app.project?.id ?? null) === home.id) void takeThreadHandoff(thread, next);
  markUnattended(next);
  const from = app.sessions.find((x) => x.id === chat);
  addToast(`${from ? `“${chatName(from.title, from.first_user)}”` : "A chat"} handed off to a new chat while you were away — it is running there`);
  sendInChat(next, home, text, [], (why) => {
    setDraftText(next, text);
    addToast(`The hand-off's new chat could not start (${why}) — its prompt is in that chat's box`);
  });
  void refreshSessions();
}

/** The backend's `limit` wake fired (`scheduleRuntime.ts` listens), or the
 *  Mac woke: every entry whose time has come goes. */
export function limitWakeDue(): void {
  // Item 535m's diagnosis line, read against the per-chat entries (543).
  void api.scheduleLog(`limit wake-due armed=${nextResumeAt(resumes) !== null}`).catch(() => {});
  void runResumes();
}

async function runResumes(): Promise<void> {
  for (const r of dueResumes(resumes, Date.now())) await goResume(r.chat, false);
  armResumes();
}

/**
 * Send chat `key`'s entry now, into that chat, whatever is on screen:
 * there when it is the open chat, off screen in its own chat and project
 * otherwise (`sendInChat`). An entry that cannot go yet — its chat runs a
 * turn, no engine, its project closed after a relaunch — is kept with the
 * reason and asked again by the clock; `clicked` says the reason in a
 * toast too (his Resume). Its chat's log gone: the entry is dropped.
 */
async function goResume(key: string, clicked: boolean): Promise<void> {
  const r = resumes[key];
  if (!r || resuming.has(key)) return;
  // The resume's own moment, whichever clock ran it (item 535m).
  void api.scheduleLog(`limit go connected=${!!app.connection}`).catch(() => {});
  const id = key === NO_CHAT ? null : key;
  const { text, at } = r;
  const project = { id: r.project.id, name: r.project.name };
  const wait = (why: string, toast: string) => {
    if (resumes[key] && resumes[key].note !== why) {
      resumes[key].note = why;
      resumeLog(`kept ${key.slice(0, 8)} ${why}`);
      saveResumes();
    }
    if (clicked) addToast(toast);
  };
  if (id && chatRuns(id)) {
    return wait("its chat is running a turn", "The paused chat is running another turn — press Resume again when it ends.");
  }
  if (!app.connection) return wait("no engine is connected", "No engine is connected — connect one and press Resume again.");
  const sent = () => {
    delete resumes[key];
    // It runs without him from here (544): its hand-off, when it comes,
    // sends itself while he is away.
    markUnattended(id);
    resumeWent.set(key, Date.now());
    resumeLog(`sent ${key.slice(0, 8)} project=${project.id ?? "unfiled"}`);
    armResumes();
  };
  const refused = (why: string) => {
    if (!resumes[key]) resumes[key] = { ...r, project, note: why };
    resumeLog(`refused ${key.slice(0, 8)} ${why}`);
    armResumes();
    if (clicked) addToast(`The paused chat could not be resumed (${why}) — open it and press Resume.`);
  };
  if (app.activeSessionId === id && (id === null || (app.project?.id ?? null) === project.id)) {
    if (app.busy) return wait("its chat is busy", "The paused chat is not open or is busy — open it and press Resume again.");
    sent();
    if (id === null) void sendUntyped(text);
    else sendInChat(id, project, text, [], refused);
    return;
  }
  if (!id || app.connection.engine !== "claude-code") {
    return wait(
      "open this chat: the API-key engine sends only in the chat on screen",
      "The paused chat is not open or is busy — open it and press Resume again.",
    );
  }
  // Not the chat on screen: in its own chat, off screen.
  resuming.add(key);
  try {
    await api.canSendInChat(id, project.id);
  } catch (e) {
    const why = String(e);
    if (/log could not be read/.test(why)) {
      // Deleted or moved since: nothing to continue.
      delete resumes[key];
      resumeLog(`dropped ${key.slice(0, 8)} ${why}`);
      armResumes();
    } else wait(why, `The paused chat could not be resumed (${why}) — open it and press Resume.`);
    if (clicked && !resumes[key]) addToast(`The paused chat could not be resumed (${why}).`);
    return;
  } finally {
    resuming.delete(key);
  }
  const now = resumes[key];
  if (!now || now.at !== at || now.text !== text || chatRuns(id)) return;
  sent();
  sendInChat(id, project, text, [], refused);
}

/**
 * The card's button (and the phone's): Resume, or — while the chat's
 * resume waits for its time — Cancel, after which only another press
 * sends it. Pressed before the window has reset it sets the time (never
 * into a window that is still exhausted); after, it goes at once.
 */
export function resumeAfterLimit(): void {
  const p = app.limitPause;
  if (!p) return;
  const key = p.session ?? NO_CHAT;
  // A pause set on `app` alone (before 543, or by the suite) gets its entry.
  if (!resumes[key]) {
    resumes[key] = { chat: key, project: homeFor(p.session), at: null, why: "limit", text: resumeMessage(p), pause: p };
  }
  const r = resumes[key];
  if (r.at !== null) {
    r.at = null;
    delete r.note;
    armResumes();
    return;
  }
  const delay = resumeDelayMs(p);
  if (delay === 0) {
    void goResume(key, true);
    return;
  }
  r.at = Date.now() + delay;
  armResumes();
  // Its agent spec is kept for the time (it is the chat on screen now).
  if (p.session && p.session === app.activeSessionId) void api.reserveChatAgent(p.session, true).catch(() => {});
}

// The card follows the chat on screen; the entries read at launch are
// armed once the window is up.
if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      void app.activeSessionId;
      untrack(showResume);
    });
  });
  setTimeout(() => {
    if (Object.keys(resumes).length > 0) armResumes();
  }, 0);
  // 544: the Mac's idle time while any turn runs, for the hand-off's away
  // rule at a crossing mid-turn (a window left in front never loses focus).
  setInterval(() => {
    if (turnsRunning()) void readIdle();
  }, 30_000);
}

/** The chat as a banner names it (nightshift backlog 079): the open
 *  session's title, else the first message of the turn just sent. */
/** Whether a call still waits on his answer, here or in a background chat. */
function approvalWaits(id: string): boolean {
  return (
    app.pendingApprovals.some((r) => r.id === id) ||
    Object.values(app.background).some((b) => b.approvals.some((r) => r.id === id))
  );
}

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
  const ranIn = app.parked ? app.parked.session : app.activeSessionId;
  // The running chat's own state when he browsed away (A4: the parked
  // chat's reply, not the empty one of the chat on screen).
  const host = liveHost(app);
  notifyEnd({
    chat: app.parked ? (ranIn ? backgroundName(ranIn, app.parked.events) : "New chat") : bannerChat(),
    events: app.parked ? app.parked.events : app.events,
    segs: host.live?.segments ?? [],
    usage: host.liveUsage,
    ranIn,
    error,
    cliError: app.agentTurn?.is_error === true,
  });
}

/** The banner for a turn's end in any chat (A4): the screen's or one
 *  that ran off screen, from that chat's own log and live state. */
function notifyEnd(t: {
  chat: string;
  events: SessionEvent[];
  segs: Segment[];
  usage: Usage | null;
  ranIn: string | null;
  error: string | null;
  cliError: boolean;
}): void {
  const sent = [...t.events].reverse().find((e) => e.event === "user_message");
  const since = sent?.event === "user_message" ? Date.parse(sent.at) : NaN;
  // The wrap-up's own turn (backlog 079's third banner, with 193): the
  // hand-off is still `wrapping` in the chat the turn ran in — the turn's
  // end moves it on only after this. A turn the CLI ended with an error
  // wrote no hand-off worth announcing.
  const wrapUp = t.ranIn !== null && handoff.chat === t.ranIn && handoff.stage === "wrapping" && !t.cliError;
  void notifyTurnEnd({
    chat: t.chat,
    segs: t.segs,
    outTokens: t.usage?.output_tokens ?? null,
    elapsedMs: Number.isNaN(since) ? null : Date.now() - since,
    error: t.error,
    handoffFill: wrapUp ? handoff.fill : null,
  });
}

export async function send(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
  files: FileInput[] = [],
): Promise<void> {
  const target = turnTarget;
  turnTarget = null;
  const goElsewhere = turnElsewhere;
  turnElsewhere = null;
  if (!app.connection || app.busy) return;
  // Item 506: a message sent in a wrapped chat is staying in it.
  sentHere(app.activeSessionId);
  // 544: a message he typed means he is driving this chat again.
  if (turnTyped) markAttended(app.activeSessionId);
  // Send pressed: the timing line's zero (item 256).
  turnClock.sent();
  const spoken = turnSpoken;
  stopped = false;
  releaseStop(stopClock);
  // A turn the model answers is not undoable, and nothing under it is:
  // a rewind lifted from under a reply would put the model in a
  // conversation it never had (nightshift backlog 064).
  history.clear(chatScope());
  app.undoTick++;
  // The new-chat screen in a thread (item 510): the thread is on the chat,
  // its layer loaded, before the model's first turn. A failed bind sends
  // nothing; `app.error` puts the words back in the box (`dispatch`).
  const inThread = app.activeSessionId === null ? app.pendingThread : null;
  if (inThread) {
    if (!(await bindPendingThread())) return;
    showBoundChat(inThread, text);
  }
  if (app.connection.engine === "claude-code") {
    return sendAgent(text, images, documents, council, spoken, files, target, goElsewhere);
  }
  // A file for Claude Code cannot go on this engine (item 277); the
  // composer refuses before here, so this is a caller that did not ask.
  if (files.length > 0) {
    app.error = `${files.map((f) => f.name).join(", ")}: only the Claude Code engine can take a file it opens itself`;
    return;
  }
  // One provider turn at a time (A4): a turn running off screen holds the
  // engine. The composer queues before it gets here; any other caller's
  // words are queued in this chat too, never dropped.
  const elsewhere = providerElsewhereName();
  if (elsewhere) {
    enqueueMessage(openChatKey(), text, []);
    addToast(
      queuedElsewhereToast(elsewhere) +
        (images.length + documents.length > 0 ? " (without its attachments — add them again)" : ""),
    );
    return;
  }
  // The pending chat's draft key, taken now: it names the project and the
  // kind this send is making a chat in (nightshift backlog 094).
  const pendingKey = pendingChatKey();
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
  // This turn, for the background (backlog 159, A4): as the agent
  // engine's since A2 — he may open another chat while it runs, and it
  // goes off screen instead of parking once its chat has a name.
  const turn: TurnCtx = { chat: app.activeSessionId, detached: false, key: newTurnKey(), choice, provider: true, pendingKey };
  fg = turn;
  firstTurnChat.chat = null; // item 615: a new turn, no stand-in yet
  let failed: string | null = null;
  try {
    await api.send(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
      turn.key,
      spoken || undefined,
    );
  } catch (e) {
    failed = String(e);
  }
  // Off screen at its end (A4): nothing below is about the chat on screen.
  if (turn.detached) {
    endBackground(turn, failed, null);
    return;
  }
  if (fg === turn) fg = null;
  if (failed !== null) app.error = failed;
  // The banner for an unfocused window (backlog 079), before the live
  // state it reads is cleared.
  notifyTurnEnded(failed);
  app.live = null;
  // The trailing assistant message now carries the same reading.
  app.liveUsage = null;
  // The turn is over: anything still parked was answered by the backend
  // (or died with the turn), so the prompts can no longer decide anything.
  app.pendingApprovals = [];
  clearHandBack();
  app.busy = false;
  // Sessions are created lazily on first send; the id is picked up here.
  await settleTurnView(pendingKey, turn.chat, choice);
  // Item 464: a thread chat's `<handoff>` prompt is kept on its thread.
  if (!app.parked) noteThreadHandoff(app.activeSessionId, app.events);
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
  spoken = false,
  files: FileInput[] = [],
  // Backlog 535: the chat it must run in (a scheduled message's own).
  target: { chat: string; project: string | null } | null = null,
  // 535f (535-1): where it goes when that chat has left the screen.
  elsewhere: ((busyHere: boolean) => Promise<unknown>) | null = null,
): Promise<void> {
  // ~~The hand-off's wrap-up rides this message when the window has crossed
  // the chat's threshold (nightshift backlog 086); `withWrapUp` also moves
  // the stage on, so it goes exactly once.~~ Superseded 2026-09-16 (pass 2,
  // blocker 120): the wrap-up is a message of its own, sent from the
  // composer's notice or by the queue; nothing is appended here.
  app.suggestion = null;
  // 535f (535-1): this chat counts as running from here (`startingIn`).
  const startChat = target?.chat ?? app.activeSessionId;
  const mine = Symbol("starting");
  if (startChat) startingIn.set(startChat, mine);
  const started = () => {
    if (startChat && startingIn.get(startChat) === mine) startingIn.delete(startChat);
  };
  // A changed layer is taken at the first cold turn (backlog 174).
  try {
    await layersBeforeTurn();
  } catch (e) {
    started();
    throw e;
  }
  // 535f (535-1): the reconnect takes seconds on a cold chat, and he may
  // have opened another chat or project meanwhile, or a turn started:
  // a message for a named chat is drawn here only if that chat is still
  // the one on screen and idle — else it runs off screen in its own chat
  // (or goes back to its caller), and nothing here is touched.
  if (target) {
    const onScreen = app.activeSessionId === target.chat && (app.project?.id ?? null) === target.project;
    if (!onScreen || app.busy || !app.connection) {
      started();
      await elsewhere?.(onScreen);
      return;
    }
  }
  // Same as `send`: the pending chat's key at the moment of the send
  // (nightshift backlog 094).
  const pendingKey = pendingChatKey();
  app.error = null;
  app.events.push({
    event: "user_message",
    text,
    // Same omission as `send`: the backend logs no key for an empty list,
    // and the optimistic entry should project as the re-synced one will.
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    at: new Date().toISOString(),
    // Item 515: the files' names, so a file-only send is not an empty pill.
    ...(files.length > 0 ? { sending_files: files.map((f) => f.name) } : {}),
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
  // Now the window's turn; `chatRuns` reads it from `fg` (535f).
  started();
  // This turn, for the background (backlog 159, A2): he may open another
  // chat while it runs, and send there.
  const turn: TurnCtx = {
    chat: app.activeSessionId,
    detached: false,
    key: newTurnKey(),
    choice: choiceOf(app.draft),
    contextLimit: app.connection?.contextLimit ?? null,
    pendingKey,
  };
  fg = turn;
  firstTurnChat.chat = null; // item 615: a new turn, no stand-in yet
  // The budget meter (backlog 165, pass 2) follows this chat's ledger
  // while the turn runs; a chat not yet created has no directory to read.
  budgetTyped = turnTyped;
  startBudgetPoll(app.activeSessionId, turnTyped);
  let failed: string | null = null;
  // The turn's result, for the usage-limit pause of the chat it ran in (543).
  let limitRes: AgentTurnResult | null = null;
  // The uuids of what he sent mid-turn that it took (backlog 328).
  let delivered: string[] = [];
  try {
    turnClock.invoked(turn.key);
    const res = await api.sendAgent(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
      council ?? undefined,
      turn.key,
      spoken || undefined,
      files.length > 0 ? files : undefined,
      target ?? undefined,
    );
    delivered = res.delivered ?? [];
    // Off screen at its end (A2): the chat on screen is another's, and
    // nothing below is about it.
    if (turn.detached) {
      endBackground(turn, null, res);
      return;
    }
    app.agentTurn = res;
    learnModel(turn, res);
    // The turn stopped by the usage limit (backlog 164): marked paused,
    // not failed, with its Resume; any other end clears an old mark.
    // ~~`app.limitPause = limitPauseFrom(res, app.activeSessionId)`~~ — one
    // slot; since 543 the chat's own entry, made in `endForeground` once
    // the chat it ran in is known (`noteTurnLimit`).
    limitRes = res;
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
    // A Stop he pressed toasts nothing (item 441): the reply's own
    // "stopped" mark says it (`turnNotices`).
    for (const notice of turnNotices(res.notices, stopped)) addToast(notice);
  } catch (e) {
    failed = String(e);
    if (turn.detached) {
      endBackground(turn, failed, null);
      return;
    }
    app.error = failed;
  } finally {
    // What he sent into it (328): taken → in the chat; not → queued again,
    // before the queue's drain reads it.
    settleInjected(turn.key, delivered);
    injectLater.delete(turn.key);
    // The turn's process is gone (backlog 331): whatever of its subagents
    // the CLI never reported finished ran inside it, and is not running.
    closeRunningRows(app.subagents, turn.chat ?? (turn.detached ? null : app.activeSessionId));
    if (turn.chat === null) closeRunningRows(app.subagents, null);
    // The window's timing marks, if no paint sent them (item 256).
    turnClock.ended(turn.key);
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
    clearHandBack();
    app.busy = false;
    // The chat the turn ran in, and its context reading, taken before the
    // view settles: he may be looking at another chat (backlog 159), and
    // the hand-off's gauge is the running chat's, not the viewed one's.
    const ranIn = app.parked ? app.parked.session : app.activeSessionId;
    const parkedUsed = app.parked?.liveUsage
      ? app.parked.liveUsage.input_tokens + app.parked.liveUsage.output_tokens
      : null;
    const browsed = app.parked !== null;
    const parkedReply = app.parked?.live ? liveText(app.parked.live.segments) : null;
    await settleTurnView(pendingKey, turn.chat, turn.choice ?? null);
    // The turn stopped by the usage limit (backlog 164): marked paused,
    // not failed, and resumed at the reset (543); any other end clears the
    // chat's old mark. Before the composer's drain reads it.
    if (limitRes) {
      const ran = browsed ? ranIn : app.activeSessionId;
      noteTurnLimit(ran, limitRes, homeFor(ran), browsed ? parkedReply : lastReplyText(app.events));
    }
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
    // Item 323 review: the reading at the reply's end closes its usage
    // line now (`readPlanAtReplyEnd`; skipped while one is in flight).
    void readPlanAtReplyEnd();
    // The hand-off reads the gauge's pair at each turn's end (backlog 086),
    // and the log, for the start prompt in the wrap-up's own reply (pass 2).
    noteAgentTurnEnd(
      browsed ? ranIn : app.activeSessionId,
      browsed ? parkedUsed : contextUsed(),
      app.connection?.contextLimit ?? null,
      browsed ? null : app.events,
    );
    // Item 464: a thread chat's `<handoff>` prompt is kept on its thread.
    if (!browsed) noteThreadHandoff(app.activeSessionId, app.events);
    // A turn that wrote HANDOFF.md is a hand-off (item 278).
    if (!browsed && turnWroteHandoff(app.events)) maybeHandoffPass();
    // Last, once the turn is fully over: was it sleep that ended it
    // (nightshift backlog 101)? The CLI reports a mid-turn network death
    // as its `result` line with `is_error`, not as a rejected send, so
    // both count; `app.agentTurn` is this turn's when the send resolved.
    sleepTurnEnded(failed !== null || app.agentTurn?.is_error === true);
  }
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
function sleepTurnEnded(
  errored: boolean,
  events: SessionEvent[] = app.events,
  chat: string | null = app.activeSessionId,
  wasStopped: boolean = stopped,
): void {
  // A background chat's end (A4) passes its own log, id and Stop.
  const sent = [...events].reverse().find((e) => e.event === "user_message");
  const started = sent?.event === "user_message" ? Date.parse(sent.at) : NaN;
  sleepWatch.turnEnded({
    startedAtMs: Number.isNaN(started) ? Date.now() : started,
    endedAtMs: Date.now(),
    errored,
    stopped: wasStopped,
    chat,
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

/**
 * When the Stop for the turn on screen was pressed (item 466): the
 * composer's button is a pressed "Stopping…" from here until the turn has
 * ended, whichever way it was pressed (the button, ⌘., the phone). The
 * composer releases it when `busy` clears; a send releases it too.
 */
export const stopClock = $state<StopClock>({ since: null });

export async function cancelTurn(chat?: string | null): Promise<void> {
  // A named chat that is not the one on screen (backlog 159, A3: the
  // phone's Stop for the chat it shows): stop that chat's turn only; the
  // screen's turn, its queue flag and its prompts are left alone.
  const bg = chat ? backgroundTurnOf(chat) : null;
  if (bg) {
    // Marked before the call, as the screen's `stopped` (A4).
    const t = bgTurns.get(bg);
    if (t) t.stopped = true;
    // A retry line says "stopping" from here (item 441).
    if (markRetryStopping(app.background[bg]?.live?.segments)) app.paneVersion++;
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
  // The button shows it pressed from this frame (item 466).
  pressStop(stopClock, performance.now());
  // A retry line says "stopping" from here, and later tries leave it
  // (item 441: the count kept climbing after Stop).
  if (markRetryStopping(liveHost(app).live?.segments)) app.liveVersion++;
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
    releaseStop(stopClock);
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
  /** His message in place of an answer (item 522, `replyToPending`). */
  reply?: { text: string; id: string },
  /** What the hand-back line says, when the decision alone does not. */
  said?: "replied",
): Promise<boolean> {
  const i = app.pendingApprovals.findIndex((r) => r.id === id);
  if (i < 0) return false;
  const [req] = app.pendingApprovals.splice(i, 1);
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
  // The card is gone and the call's row still reads "running" until the
  // resumed process reports (item 522: ~25 s on 2026-11-09, read as a
  // freeze): a line in its place says the answer was taken.
  const deferredCall = app.connection?.engine === "claude-code";
  if (deferredCall) noteAnswered(id, req.chat ?? app.activeSessionId, said ?? handedHow(name, decision, reply !== undefined));
  try {
    await api.approveCall(id, name, decision, reason, answer, then, grant, reply);
    return true;
  } catch (e) {
    // The answer went nowhere (item 522): never a card that silently
    // left. While its turn still runs here the card comes back, to be
    // answered again; either way he is told.
    answerLanded(id);
    if (deferredCall && app.busy && !app.pendingApprovals.some((r) => r.id === id)) {
      app.pendingApprovals.splice(Math.min(i, app.pendingApprovals.length), 0, req);
    }
    addToast(`Your answer was not taken: ${String(e)}`);
    return false;
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
export function closeThinking(segments: Segment[]): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === "thinking" && !last.done) {
    last.done = true;
    if (last.at != null) {
      last.ms = Date.now() - last.at;
      delete last.at;
    }
  }
}

/**
 * Where a turn's event lands (backlog 159, A4): the chat on screen (or
 * parked), or a chat running off screen. ~~A background chat's event went
 * through the screen's code with its record swapped into `app.parked` for
 * the moment~~ — A4: one function takes the host it writes to.
 */
export interface TurnHost {
  /** The live state the stream builds: `app` or `app.parked` for the
   *  screen's running chat, the record for a background one. */
  state: { live: { segments: Segment[] } | null; liveUsage: Usage | null };
  /** The prompts it waits on; an answered one leaves this list. */
  approvals: ApprovalRequest[];
  /** Its chat, when known (a New chat's first turn: not yet). */
  chat: string | null;
  /** The background record, or null for the chat on screen. */
  bg: Background<Segment, ApprovalRequest> | null;
}

/** The screen's running chat as a host: parked or on screen. */
function screenHost(): TurnHost {
  return {
    state: liveHost(app),
    approvals: app.pendingApprovals,
    chat: fg?.chat ?? (app.parked ? app.parked.session : app.activeSessionId),
    bg: null,
  };
}

/** A chat running off screen as a host. */
function backgroundHost(bg: Background<Segment, ApprovalRequest>): TurnHost {
  return { state: bg, approvals: bg.approvals, chat: bg.session, bg };
}

/** Exported for the tests of what a turn's events do to the state: the
 *  router — which chat an event is for — then `applyTurnEventTo`. */
export function applyTurnEvent(ev: TurnEvent & { chat?: string }): void {
  // A background chat's event lands in its own state (backlog 159, A2).
  const bg = eventHost(app.background, ev.chat);
  if (bg) {
    applyTurnEventTo(backgroundHost(bg), ev);
    return;
  }
  // The turn on screen learns its chat from its first event (a New
  // chat's first turn), and a parked one can then go to the background.
  if (ev.chat && fg && fg.chat === null) {
    fg.chat = ev.chat;
    // Item 615: the sidebar marks the chat this first turn made.
    if (!app.parked && app.activeSessionId === null) firstTurnChat.chat = ev.chat;
    // The chat it made keeps the model it was made on (backlog 205).
    if (fg.choice) {
      noteMade(chatChoice.choices, ev.chat, fg.choice);
      saveChatChoices();
    }
    adoptChatRules(ev.chat);
    if (app.parked) promoteParked();
    if (fg === null) {
      const moved = eventHost(app.background, ev.chat);
      if (moved) applyTurnEventTo(backgroundHost(moved), ev);
      return;
    }
  }
  // Item 536: a row the turn could not take yet is tried again now-ish.
  if (fg) nudgeInjects(fg.key);
  applyTurnEventTo(screenHost(), ev);
}

/**
 * One turn event into one chat's state (A4): its stream, its usage, its
 * prompts, its subagent rows. What belongs to the window rather than a
 * chat — the composer's suggestion, the context window's look-up, the
 * transcript's redraw — is done for the chat on screen alone; a chat off
 * screen keeps its init line in its record for when it comes back.
 */
export function applyTurnEventTo(host: TurnHost, ev: TurnEvent & { chat?: string }): void {
  const onScreen = host.bg === null;
  const s = host.state;
  if (ev.type === "usage") {
    s.liveUsage = ev.usage;
    return;
  }
  // Item 590: the live context reading, per chat, for the column's dial.
  if (ev.type === "context_live") {
    noteContextLive(host.chat, ev);
    return;
  }
  if (ev.type === "compacted") {
    // The Compaction event itself arrives with the post-turn transcript
    // re-sync and renders there; this only makes the moment visible, matching
    // what the manual compact button reports.
    if (onScreen) {
      addToast("context compacted by the model");
      // Noted here, acted on when `send` settles: a dream that started while
      // the turn was still re-syncing would race the transcript for nothing.
      compactedThisTurn = true;
    } else {
      addToast(`context compacted by the model in ${backgroundName(host.bg!.session, host.bg!.events)}`);
    }
    if (s.live) {
      closeThinking(s.live.segments);
      s.live.segments.push({
        kind: "notice",
        text: "context compacted — earlier turns replaced by a summary",
      });
      if (onScreen) app.liveVersion++;
      else app.paneVersion++;
    }
    return;
  }
  if (ev.type === "tool_denied" || ev.type === "tool_result") {
    // The gate answered this one, whoever decided it — a prompt still on
    // screen for it (cancellation denies server-side) can no longer be used.
    const i = host.approvals.findIndex((r) => r.id === ev.tool_use_id);
    if (i >= 0) host.approvals.splice(i, 1);
  }
  // Item 633: a running command's passing text — live only, by call id, and
  // gone at its result; it never touches the message's segments.
  // Item 649: a shell call's end leaves its output's last lines as a fading remnant.
  if (passingEvent(ev, isShellForPassing)) return;
  // Item 483: notes a chat moved take their tabs and drafts along.
  followToolMoves(ev);
  // The Running-tasks rows outlive the live message (backlog 160): a
  // status or a child's event that lands after it ended still reaches its
  // row, which is the chat's and not the message's.
  if (ev.type === "subagent_status") {
    upsertSubagentRow(ev, ev.chat ?? host.chat);
    app.liveVersion++;
    return;
  }
  if (ev.type === "subagent") {
    const row = subagentRow(ev.parent_tool_use_id);
    if (row) applyToSegments(row.segments, ev.event);
  }
  if (!s.live) return;
  const segments = s.live.segments;
  switch (ev.type) {
    case "text_delta":
    case "thinking_delta":
    case "redacted_thinking":
    case "tool_call":
    case "tool_result":
    case "tool_denied":
      // His answer reached the turn (item 522): the hand-back line goes.
      if (ev.type === "tool_result" || ev.type === "tool_denied") answerLanded(ev.tool_use_id);
      // The reply is coming (items 440 + 441): the retry line goes.
      clearRetry(segments);
      applyToSegments(segments, ev);
      break;
    case "retry":
      // The CLI retrying (items 440 + 441): one line, updated in place —
      // never a toast; a Stop's line is left saying "stopping".
      if (!segments.some((g) => g.kind === "retry")) closeThinking(segments);
      applyRetry(segments, ev);
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
      // A subagent starting one of its own (backlog 329): said in the main
      // reply — who, its task, how many run — as the main agent is told.
      if (ev.event.type === "tool_call" && (ev.event.name === "Agent" || ev.event.name === "Task")) {
        const who = subagentRow(ev.parent_tool_use_id)?.description ?? "a subagent";
        const input = ev.event.input as { description?: unknown; prompt?: unknown } | null;
        const task = typeof input?.description === "string" ? input.description : typeof input?.prompt === "string" ? input.prompt.split("\n")[0] : "";
        const running = rowsOf(app.subagents, host.chat).filter((r) => subagentRunning(r)).length;
        closeThinking(segments);
        segments.push({
          kind: "notice",
          text: `subagent “${who}” started a subagent of its own${task ? `: “${task}”` : ""} — ${running + 1} running · the main agent is told`,
        });
      }
      if (!parent) break;
      parent.children ??= [];
      applyToSegments(parent.children, ev.event);
      break;
    }
    case "still_running": {
      // The main reply ended with its subagents still running (backlog
      // 329): the turn waits for them — the CLI wakes the main agent as
      // each ends — unless he stops them.
      // ~~A notice worded as a question, Stop on a toast~~ — backlog 357:
      // a status line of its own, Stop on it, each name opening the
      // Running-tasks panel on its row, turning to done or stopped as the
      // rows end (`StillRunningLine.svelte`).
      const key = onScreen ? fg?.key : undefined;
      const seg: StillRunningSegment = {
        kind: "still_running",
        tasks: [...ev.tasks],
        ids: matchTasks(ev.tasks, rowsOf(app.subagents, host.chat)),
        ...(key ? { turn: key } : {}),
      };
      closeThinking(segments);
      segments.push(seg);
      // The toast only for a chat off screen (357): on screen the line is in
      // view and carries Stop, so the toast said the same thing twice. Off
      // screen there is no line to see and no key to stop by — the toast is
      // the news, as before. One per chat per set of tasks: the main agent
      // replies again after each report, and each such reply says so too.
      if (onScreen) break;
      const seen = `${host.chat}:${ev.tasks.join("|")}`;
      if (stillRunningAsked.has(seen)) break;
      stillRunningAsked.add(seen);
      addToast(lineText(lineView(seg, app.subagents)));
      break;
    }
    case "woke": {
      // A subagent's end the main agent was never told of (backlog 406):
      // Nightloom wrote it a line of its own, and the reply says so in
      // place — Nightloom's words, not his, so a notice and not a message.
      const names = ev.agents.map((a) => `“${a}”`).join(", ");
      closeThinking(segments);
      segments.push({
        kind: "notice",
        text: `${names} finished but its report never reached the main agent — Nightloom told it to continue`,
      });
      if (!onScreen) addToast(`Nightloom woke ${backgroundName(host.bg!.session, host.bg!.events)}: ${names} finished`);
      break;
    }
    case "budget_wake": {
      // Nightloom woke the main agent for the message's usage cap (item
      // 538): its words, not his — a notice, as for `woke`.
      closeThinking(segments);
      segments.push({ kind: "notice", text: wakeNotice(ev.kind, ev.pct, ev.cap) });
      if (!onScreen) addToast(`Nightloom woke ${backgroundName(host.bg!.session, host.bg!.events)}: ${wakeNotice(ev.kind, ev.pct, ev.cap)}`);
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
      // Context page. Nothing in the transcript changes. A chat off screen
      // keeps it for when it comes back (A4).
      if (host.bg) {
        host.bg.agentInit = ev;
      } else {
        app.agentInit = ev;
        void windowFromInit(ev.model);
        // A new process or command of the turn on screen: what it could
        // not take before goes in now (backlog 374).
        if (fg) retryInjects(fg.key);
      }
      break;
    case "prompt_suggestion":
      // After the result (backlog 083): the composer's ghost line — the
      // chat on screen's composer only.
      if (onScreen) app.suggestion = ev.text;
      break;
    case "relayed": {
      // The main model passed his words on to a running subagent (backlog
      // 339): the agent's box shows it, and the reply says so in place.
      const row = ev.agent_id ? app.subagents.find((r) => r.task_id === ev.agent_id) : undefined;
      if (row && ev.agent_id)
        recordRelay(ev.agent_id, { text: ev.text, at: Date.now(), ok: ev.ok, detail: ev.detail, segAt: row.segments.length });
      closeThinking(segments);
      const first = ev.text.split("\n")[0] ?? "";
      const what = `“${first.length > 100 ? first.slice(0, 99) + "…" : first}”`;
      segments.push({
        kind: "notice",
        text: ev.ok
          ? `passed on to the subagent ${row ? `“${row.description}”` : ev.to}: ${what} — it reaches it at its next step`
          : `could not pass it on to ${ev.to}: ${ev.detail.slice(0, 160)}`,
      });
      break;
    }
    case "message_delivered": {
      // His mid-turn message reached the turn (backlog 328): ~~its queue row
      // says where~~ its queue row leaves (366), and the reply shows it in
      // place until the turn's end re-reads the log, where it is his own
      // message.
      markDelivered(ev.id);
      closeThinking(segments);
      segments.push({ kind: "notice", text: deliveredNotice(ev.after, ev.text), delivered: { text: ev.text, after: ev.after } });
      break;
    }
    default:
      // Unknown turn-event types are ignored by contract.
      break;
  }
  if (onScreen) app.liveVersion++;
  // A pane showing a chat off screen follows its stream (piece 5).
  else app.paneVersion++;
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
export function applyToSegments(segments: Segment[], ev: TurnEvent): void {
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
  "thread",
  "knowledge",
  "engine_note",
  "pacing",
  "subagents",
  "subagent_rules",
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
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setPromptLayers(off);
    // A chat whose log was just created by this call: pick up its id the way
    // `send` does, so the sidebar and the next open agree on which chat this is.
    adoptCreatedChat(pending);
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
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setPromptLayerText(layer, text);
    adoptCreatedChat(pending);
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
  if (layer === "thread") {
    void promoteThreadText(text);
    return true;
  }
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
    // Only when the draft moved on from what the last connect sent (item
    // 222): four picks held behind one connect go out as one, and a pick
    // put back as it was costs nothing. A chat switch changes the key.
    if (sentKey() !== lastSent) {
      await applyDraft();
      return;
    }
    app.applyPending = applyTimer !== null;
  }
  if (!app.connection) {
    // Item 261: a connect that failed left every chat "not connected", and
    // opening another chat never tried again — only a relaunch did. Now
    // opening another chat (or New chat) retries once for it; the chat
    // whose connect just failed is not retried in a loop (the transcript's
    // Retry is the way to try it again).
    const key = sentKey();
    if (app.connectError && key !== lastSent && key !== lastAutoRetry) {
      lastAutoRetry = key;
      await applyDraft();
    }
    return;
  }
  try {
    const { off, built, edits, built_edits, mode, built_mode, kind, built_kind, thread, built_thread } =
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
      (kind ?? "build") !== (built_kind ?? "build") ||
      // The fifth pair (backlog 271): the chat's research thread.
      (thread ?? null) !== (built_thread ?? null)
    ) {
      // A provider connect that fails leaves the built set as it was, so
      // the pairs still disagree, `connecting` flips, the effect re-runs
      // and this would reconnect again at once, forever (backlog 137,
      // review E's FE8). The one pair that just failed is not retried;
      // another chat, another set, or a rail change (which clears
      // `connectError`) tries afresh.
      const pair = JSON.stringify([
        app.activeSessionId,
        off,
        edits ?? {},
        mode ?? "normal",
        kind ?? "build",
        thread ?? null,
      ]);
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
/** The (chat, draft) a failed connect was last retried for on its own
 *  (item 261), so a retry that fails too is not repeated forever. */
let lastAutoRetry: string | null = null;

/**
 * Try the connection again after it failed (item 261): the Retry on the
 * "not connected" card. The rail's settings as they are, for the open
 * chat; a turn or a connect in flight defers it as any rail change is.
 */
export async function retryConnect(): Promise<void> {
  if (app.connecting) return;
  app.connectError = null;
  lastFailedSync = null;
  lastAutoRetry = null;
  await applyDraft();
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
 * Every Claude Code session the chat has run on, oldest first, rewound
 * ones included (item 675, 2026-11-12): a rewind starts a new CLI session
 * — a cut copy of the one before — whose running cost restarts below
 * where the chat had been, so the chat's cost is read over all of them
 * (`session_figures::read_chain`). Each id once, at its first place.
 */
export function chatAgentSessions(events: SessionEvent[]): string[] {
  const ids: string[] = [];
  for (const e of events) {
    if (e.event === "agent_session" && e.agent === "claude-code" && !ids.includes(e.id)) ids.push(e.id);
  }
  return ids;
}

/**
 * Rewind to the turn at log index `to`.
 *
 * Refused mid-turn: the running turn holds the session and would record its
 * reply after the rewind landed, stitching the turn being undone onto the
 * history it was removed from.
 */
export async function rewindTo(to: number, aim: boolean | string = false): Promise<void> {
  if (app.busy) return;
  // From the window's own transcript, the message's send time rides with
  // its place, as `sendEdit`'s does (backlog 361; wave 8b review): the
  // backend rewinds to the message meant, or refuses. The phone's index is
  // its own list's: since backlog 364 it sends the send time from that
  // list (a string here); a phone that sends none goes bare, as before.
  const meant = aim === true ? app.events[to] : undefined;
  const at = typeof aim === "string" ? aim : meant?.event === "user_message" ? meant.at : undefined;
  const call = () => (at ? api.rewind(to, at) : api.rewind(to));
  // 364 review: the phone's `to` is its own list's; what follows is read
  // where its aimed rewind lands in this window's list, and nothing is
  // offered when this list does not have that message.
  const here = typeof aim === "string" ? indexOfAim(app.events, { at: aim }, to) : to;
  // His message at `to`, read before the rewind supersedes it (backlog 247).
  const back = here === null ? null : rewoundMessage(app.events, here, nextAttachmentId);
  // What the removed turns wrote, read before the rewind supersedes them
  // (item 259): offered to be set aside, since the next run reads them.
  const written = here === null ? [] : rewoundWrites(app.events, liveFlags(app.events), here);
  // 535f (534-1): the chat's box and stack, named before the round trip.
  const key = openChatKey();
  const scope = chatScope();
  try {
    if (!(await adoptOpen(call))) {
      // He opened another chat meanwhile: the rewind is on disk in this
      // one; its message goes back in its own box, and nothing here (the
      // view, the size, the files card, the undo) is the chat now open.
      if (back) fillBox(key, back);
      return;
    }
    app.error = null;
  } catch (e) {
    app.error = String(e);
    return;
  }
  // Item 390: fewer turns, less context — the hand-off notice reads it now.
  const refill = () => noteRewound(app.activeSessionId, contextUsed(), app.connection?.contextLimit ?? null);
  refill();
  app.rewoundWrites =
    written.length > 0
      ? {
          session: app.activeSessionId,
          workspace: app.connection?.workspace ?? null,
          files: written,
          done: null,
        }
      : null;
  let swap = back ? fillBox(key, back) : null;
  // The inverse lifts the marker this call landed — and, after a redo,
  // the marker *that* call lands, which is why the index is a variable.
  let marker = lastMarker("rewind");
  const handle = pushUndo(scope, {
    label: "rewind",
    undo: async () => {
      if (!(await adoptOpen(() => api.unrewind(marker)))) return;
      refill();
      // The turn is back; its files were left alone unless he set them
      // aside, and then the card says where they went.
      if (app.rewoundWrites && app.rewoundWrites.done === null) app.rewoundWrites = null;
      // The box gets back what it held — unless he changed the message
      // since, which then stays (never-lose-work).
      if (swap && untouched(readDraft(key), swap)) {
        setDraftText(key, swap.before.text);
        setDraftAttachments(key, swap.before.attachments);
      }
    },
    redo: async () => {
      if (!(await adoptOpen(call))) return;
      refill();
      marker = lastMarker("rewind");
      if (back) swap = fillBox(key, back);
    },
  });
  undoToast(back ? "Rewound — your message is back in the box" : "Rewound to here", handle);
}

/**
 * Set aside the rewound turn's files he ticked (item 259): moved into a
 * dated folder outside the project, never deleted. The card then names
 * the folder and anything that could not move.
 */
export async function setAsideRewound(paths: string[]): Promise<void> {
  const w = app.rewoundWrites;
  if (!w || paths.length === 0) return;
  try {
    const out = await setAsideFiles(w.session, w.workspace, paths);
    const skipped = out.skipped.map((s) => `${s.path}: ${s.why}`);
    w.done = out.folder
      ? `Moved ${out.moved.length} to ${out.folder}${skipped.length ? ` · not moved: ${skipped.join("; ")}` : ""}`
      : `Nothing moved${skipped.length ? `: ${skipped.join("; ")}` : ""}`;
  } catch (e) {
    addToast(`Could not set the files aside: ${String(e)}`);
  }
}

/** Leave the rewound turn's files where they are (item 259). */
export function keepRewound(): void {
  app.rewoundWrites = null;
}

/** A rewound message into the box (backlog 247, blocker 581): what was
 *  half-typed goes to the top of the draft history, with a toast saying
 *  so; its chips stay after the message's own. */
function fillBox(key: string, back: { text: string; attachments: Attachment[] }): BoxSwap {
  const swap = swapIn(readDraft(key), back);
  if (swap.stashed) {
    recordDraft(key, swap.before.text, undefined, 1);
    addToast("Your half-typed message is in drafts, under the box");
  }
  setDraftText(key, swap.after.text);
  setDraftAttachments(key, swap.after.attachments);
  requestComposerFocus();
  return swap;
}

/** The log index of the newest event of `kind` — the marker an operation
 *  just recorded, for its inverse to name. */
function lastMarker(kind: SessionEvent["event"]): number {
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (app.events[i].event === kind) return i;
  }
  return -1;
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
  /** Called once the fork is the open chat, before the send (item 333:
   *  Retry carries the box's draft into it). */
  onForked: ((parent: string | null, fork: string) => void) | null = null,
  /** Files for the Claude Code engine (item 277) the edit box attached
   *  (item 336); the log keeps none, so a past turn never carries one. */
  files: FileInput[] = [],
): Promise<boolean> {
  if (app.busy) return false;
  // 559 (blocker 1750, default applied): the chat he edited, before the
  // fork call — he may open another chat or project in its round trip.
  const mark = viewMark();
  let fork: string;
  try {
    const parent = app.activeSessionId;
    // The message's send time rides with its place (backlog 361): the
    // backend aims the fork at the message meant, or refuses.
    const meant = app.events[index];
    const at = meant?.event === "user_message" ? meant.at : null;
    const res = await api.editMessage(index, text, "send", null, at);
    fork = res.session;
    if (!sameView(mark)) {
      // He left: his edited words go into the fork of the chat he edited,
      // off screen — never into the chat now open, never lost.
      void refreshSessions();
      sendInFork(fork, mark.project, text, images, documents, files);
      return true;
    }
    app.events = res.events;
    // The fork starts with no asides; the parent keeps its own (backlog 203).
    switchAside(res.session);
    app.activeSessionId = res.session;
    onForked?.(parent, res.session);
    app.error = null;
    app.agentTurn = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  void refreshSessions();
  // Told the fork by id (535's `turnTarget`), so a switch during the
  // send's own reconnect sends it off screen into the fork (535f).
  if (app.connection?.engine === "claude-code") {
    turnTarget = { chat: fork, project: mark.project };
    turnElsewhere = async (busyHere) => {
      if (busyHere) enqueueMessage(fork, text, editAttachments(images, documents, files));
      else sendInFork(fork, mark.project, text, images, documents, files);
    };
  }
  await send(text, images, documents, null, files);
  return true;
}
