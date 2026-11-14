import { noteContextLive } from "./liveContext.svelte";
import { passingEvent } from "./bashOutput.svelte";
import { isShellCall as isShellForPassing } from "./agentCommands";
import { tick, untrack } from "svelte";
import { noteThreadHandoff, takeThreadHandoff } from "./threadHandoff.svelte";
import { switchSameToChoose } from "./subagentSwitch";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { wakeNotice } from "./capWake";
import {
  carryReadOrder,
  firstMessage,
  handoff,
  lastReplyText,
  markAttended,
  noteAgentTurnEnd,
  noteThread,
  noteThreadFlags,
  leaveHandoff,
  readOrder,
  sentHere,
  threadFor,
} from "./handoff.svelte";
import {
  enqueueMessage,
  markDelivered,
  moveQueue,
  nextQueueId,
  requeueFront,
  type QueuedMessage,
  settleInjected,
  readDraft,
  setDraftText,
} from "./drafts.svelte";
import { releaseSpec, scheduled, wantSpec } from "./scheduled.svelte";
import { contextOf } from "./chatContext.svelte";
import { nameScheduledRows } from "./schedule";
import { requestComposerFocus } from "./rewindDraft.svelte";
import {
  defaultDraft,
  loadLastConnection,
  loadPrefs,
  loadPrompts,
  sanitizeThinking,
  saveLastConnection,
  type CatalogPrefs,
  type Engine,
  type SavedPrompt,
} from "./catalog";
import {
  choiceOf,
  noteMade,
  type ChatChoice,
} from "./chatChoice";
import { madeChatRow } from "./afterWrite";
import { runLaunch } from "./launch.svelte";
import { chatName, notifyNeedsYou, postHeldNeedsYou } from "./notify";
import { onAway, watchPresence } from "./away.svelte";
import { RESUME_TEXT, SleepWatch, loadSleepPrefs, pushPowerPrefs, type Woke } from "./sleep";
import { type CouncilRequest } from "./council";
import { limitPauseFrom, type LimitPause } from "./limit";
import {
  backgroundEndToast,
  canDetach,
  eventHost,
  inOtherProject,
  liveHost,
  queuedElsewhereToast,
  type Background,
  type Parked,
} from "./browse";
import * as tabs from "./tabs";
import { deliveredNotice } from "./midTurn";
import { answerLanded, clearHandBack, handedHow, noteAnswered } from "./handBack.svelte";
import { recordRelay } from "./relay.svelte";
import { closeRunningRows, rowsOf } from "./subagentRows";
import { lineText, lineView, matchTasks, type StillRunningSegment } from "./stillRunning";
import { applyRetry, clearRetry, markRetryStopping, turnNotices, type RetrySegment } from "./retryLine";
import { pressStop, releaseStop, type StopClock } from "./stopState";
import { cli, startCliClock } from "./cliUpdate.svelte";
import { noteResolved } from "./modelSeen.svelte";
import { currentCliVersion } from "./modelSeen";
import { loadLayerPrefs } from "./promptVersions";
import type { TabContent, Workspace } from "./tabs";
import {
  emptyNewProjectDraft,
  loadNewProject,
  type SavedNewProject,
} from "./tabsStore";
import { turnClock } from "./turnTiming";
import {
  turnWroteHandoff,
} from "./autoPass";
import {
  loadDailyPrefs,
  loadDismissed,
  loadLastDaily,
  loadSeenStamp,
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
  ProposalEntry,
  ProposalScope,
  ProviderInfo,
  SearchBackendInfo,
  SearchResult,
  SearchScope,
  SessionEvent,
  SessionMeta,
  TurnBudget,
  Checkpoint,
  TurnEvent,
  Usage,
} from "./types";
import { asidesOf, asideStash, switchAside, findAsideTurn, asideTurnEvent, asidePhase, asideAsking, asideInTab, asideTabThread, asideReads, asideOf, askAside, ATTACHMENTS_ONLY, unfoldAside, asideWaiting, asideWire, followUpAside, rewindAside, restoreAsideTurns, councilFor, setCouncilFor, draftAside, dismissAside, stopAside, settleAsideSegments, setAsideUnsent, asideHasDraft, requestDismissAside, answerAsideDiscard, onAsideClosed, reopenAside, type AsideTurn, type Aside, type AsideAsk } from "./state/asides.svelte";
import { showNightshift, syncNightshiftProject, refreshNightshiftRow, loadNightshiftReview, refreshNightshiftReview, selectShift, refreshNightshift, selectNightshiftProject, loadMornings, openMorning, morningIsRead, markMorningRead, loadShifts, latestShift, loadShiftLog, showDiff, loadBlockers, selectBlocker, loadItems, selectItem, newItem, startInterview, sendInterview, loadInterview, cancelInterview, writeInterviewItem, deleteItem, saveItem, reorderItems, synthPlan, writeAndLaunch, scheduleLaunch, cancelLaunch, loadPendingLaunch, loadUsage, clockOf, loadNotes, openNote, answerBlocker, revertPreview, revertShift, loadNightshiftMorning, enableNightshift } from "./state/nightshift.svelte";
import { showNote, showGraph, leaveNote, currentModelId, followToolMoves, reviewProposal, noteDraftKey, closeNote, openModelInstructions, CHAT_INSTRUCTIONS_FILE, openChatInstructions, saveNote, deleteNote, moveNoteTo, followNoteMove, onNoteMove, movedNoteName, newNoteFolder, deleteNoteFolder, mirrorDraft, stageProposal, acceptProposal, unstageProposal, dismissProposal } from "./state/notes.svelte";
import { reflectTabs, frontOpenChat, tabOpening, showContentOf, newTab, closeTab, stepTab, splitActiveTab, dropNoteTabs, flushTabs, shownContent, openContent, dropContent, focusPane, moveTab, splitTab, registerTerminalHooks, flushNewProject, startContentDrag, endContentDrag, droppedContent } from "./state/tabs.svelte";
import { history, chatScope, undo, redo, inTextField, editAttachments, sendInFork, contextUsed, undoLabel, redoLabel, syncUndoMenu, saveEdit, removeTurn, restoreTurn, removeBlock, restoreBlock, saveReplyEdit, editContextItems, renameSession, sessionCost, roundCost, cacheHitRate } from "./state/edits.svelte";
import { refreshDreamStatus, refreshCaptureStatus, maybeAutoDream, maybeHandoffPass, refreshCentre, maybeDailyPass, startDailyClock, passTargetFor, runCapture, saveMemoryFromChat, stopCapture, runDream, stopDream, centreCount, dismissNotice, openNotice, revertDreamFile, revertApplied, openInstructions, setDailyPrefs, runDailyPass, type AutoPassKind } from "./state/passes.svelte";
import { refreshPlanUsage, readPlanAtReplyEnd, planUsageFromTurn, readTurnBudget, readCheckpoint, startBudgetPoll, ensureBudgetPoll, startPlanUsageClock, PLAN_USAGE_LIVE_EVERY_MS, TURN_BUDGET_EVERY_MS, setCheckpoint } from "./state/usage.svelte";
import { refreshProjects, refreshNotes, refreshKnowledge, refreshProjectsFolder, useProject, openProjectFolder, showNewProject, importFromClaude, restoreTabs, refreshProposals, useProjectsFolder, useKnowledgeDir, offerPracticesClaudeMd, closeNewProject, discardNewProject, pickNewProjectFolder, resolveNewProjectPath, createNewProject, renameProject, forgetProject, revealFolder, tabsOwner } from "./state/projects.svelte";
import { layersBeforeTurn, refreshLayerVersions, updateLayerNow, chooseLayerVersion, setAutoLayers, promptLayersOff, sameLayers, setPromptLayer, promptLayerEdits, sameEdits, setPromptLayerText, promoteLayerText, syncPromptLayers, retryConnect } from "./state/layers.svelte";
import { subagentRow, upsertSubagentRow, subagentRunning, findCall, applyToSegments, openChatSubagents, latestSubagents, subagentsOfTurn, denialReason, currentTodos } from "./state/segments.svelte";
import { resumes, showResume, armResumes, liveText, homeFor, noteTurnLimit, readIdle, approvalWaits, bannerChat, notifyTurnEnded, notifyEnd, clearResumes, limitWakeDue, resumeAfterLimit } from "./state/resumes.svelte";
import { pendingChatKey, clearPendingThread, bindPendingThread, showBoundChat, defaultKind, firstTurnChat, chatMode, chatKind, bornKind, declaredKind, kindSwitchCost, switchChatKind, kindWorkspace, adoptCreatedChat, chatFolders, setChatFolders, chatThread, setChatThread, startPendingChat, moveChatToThread, backToNewChat, pendingThreadDeleted, writePendingThread, newChatInThread, createThread, refreshThreadFlags, promoteThreadText, setProjectFolders, kindLabel, KIND_LINES, newChatSelected, threadPlusSelected, chatSelected, threadSelected, newChatLabel, MODE_LINES, MODE_GLYPH } from "./state/threads.svelte";
import { usable, autoConnect, chatChoice, saveChatChoices, adoptChatRules, windowFromInit, applyDraft, useEngine, subagentRules, RULES_DEBOUNCE_MS, setOpenChatRules, useDefaultRules, setDefaultRules, sendHeld, APPLY_DEBOUNCE_MS, applyTimer, scheduleApply, lastSent, sentKey, restoreChatChoice, applyAgentDraft, filesChangedGen, filesSeenGen, projectFilesChanged, closePrompts, usePrompt, storePrompt, deletePrompt, refreshProviders, refreshSearchBackends, fetchModels, setPrefs } from "./state/connection.svelte";
import { bgTurns, backgroundTurnOf, backgroundName, whereItRuns, openRunningChat, turnsRunning, canDeleteChat, keepPaneLog, refreshPaneLog, providerElsewhere, providerElsewhereName, providerDrains, canLeaveProject, openWaiting, waitingChatName, liveChats, connectionWindowFor, chatRuns, runningWork, openRun, paneChat, loadPaneLog, browseFree, registerProviderDrain, registerRunDrain, runDrainNow, turnChatRef, canLeaveRunning, type LiveChat } from "./state/running.svelte";
import { stillRunningAsked, injectIntoTurn, nudgeInjects, openChatKey, takeQueuedFor, injectLater, retryInjects, handWhy, handKey, handReason, RETRY_HAND_MS, replyToPending, turnOwnsKey, takeQueued, sendNowRow, sendNowPlan, stopSend, stopSendFor, takeStopSend, frontQueued, stopAndSendRow, sendNowAny, type HandReason, type SendNowPlan } from "./state/queue.svelte";
import { peekNew, viewMark, sameView, adoptOpen, settleTurnView, openSession, compactSession, deleteSession, moveSession, remoteSend, remoteNewChat } from "./state/sessions.svelte";
import { loadLastProject, saveLastProject, loadDreamPrefs, loadPalette, loadLayout, viewport, loadReadPages, DREAM_ENGINE, DREAM_PREFS_VERSION, parseDreamPrefs, saveDreamPrefs, PALETTES, applyPalette, setPalette, SIDEBAR_MIN, SIDEBAR_MAX, toggleSidebar, sidebarColumn, SIDEBAR_SHARE, fitSidebar, sidebarShown, setSidebarWidth, paneWidth, setPaneWidth, READ_KEY, type Palette, type DreamPrefs, type Layout } from "./state/prefs.svelte";
import { runMenuCommand, menuInterceptors, providerPills, switchProvider, toggleEngine, pickerModels, switchModel, switchModelAt, loadContextLimits } from "./state/menu.svelte";
import { rewindTo, setAsideRewound, keepRewound } from "./state/rewind.svelte";
import { addToast, TOAST_MS, ACTION_TOAST_MS, dismissToast, runToastAction } from "./state/toasts.svelte";
import { inViewLane } from "./viewLane";
export { TOAST_MS, ACTION_TOAST_MS, addToast, dismissToast, runToastAction };
export { rewindTo, setAsideRewound, keepRewound };
export { menuInterceptors, runMenuCommand, providerPills, switchProvider, toggleEngine, pickerModels, switchModel, switchModelAt, loadContextLimits };
export { saveLastProject, DREAM_ENGINE, DREAM_PREFS_VERSION, parseDreamPrefs, saveDreamPrefs, PALETTES, applyPalette, setPalette, SIDEBAR_MIN, SIDEBAR_MAX, toggleSidebar, sidebarColumn, SIDEBAR_SHARE, fitSidebar, sidebarShown, setSidebarWidth, paneWidth, setPaneWidth, READ_KEY };
export type { DreamPrefs, Palette, Layout };
export { viewMark, sameView, adoptOpen, openSession, compactSession, deleteSession, moveSession, remoteSend, remoteNewChat };
export { injectIntoTurn, handWhy, handKey, handReason, RETRY_HAND_MS, nudgeInjects, replyToPending, turnOwnsKey, openChatKey, takeQueuedFor, takeQueued, retryInjects, sendNowRow, sendNowPlan, stopSend, stopSendFor, takeStopSend, frontQueued, stopAndSendRow, sendNowAny };
export type { HandReason, SendNowPlan };
export { bgTurns, backgroundTurnOf, backgroundName, canLeaveProject, openRunningChat, openWaiting, waitingChatName, liveChats, connectionWindowFor, turnsRunning, chatRuns, runningWork, openRun, canDeleteChat, paneChat, loadPaneLog, browseFree, providerElsewhere, providerElsewhereName, registerProviderDrain, registerRunDrain, runDrainNow, turnChatRef, canLeaveRunning };
export type { LiveChat };
export { usable, chatChoice, subagentRules, RULES_DEBOUNCE_MS, setOpenChatRules, useDefaultRules, setDefaultRules, adoptChatRules, windowFromInit, sendHeld, APPLY_DEBOUNCE_MS, applyTimer, scheduleApply, lastSent, sentKey, restoreChatChoice, applyDraft, applyAgentDraft, filesChangedGen, filesSeenGen, projectFilesChanged, useEngine, closePrompts, usePrompt, storePrompt, deletePrompt, refreshProviders, refreshSearchBackends, fetchModels, setPrefs };
export { chatMode, chatKind, bornKind, declaredKind, kindSwitchCost, switchChatKind, kindWorkspace, pendingChatKey, adoptCreatedChat, chatFolders, setChatFolders, chatThread, setChatThread, startPendingChat, moveChatToThread, clearPendingThread, backToNewChat, pendingThreadDeleted, writePendingThread, bindPendingThread, newChatInThread, createThread, refreshThreadFlags, promoteThreadText, setProjectFolders, defaultKind, kindLabel, KIND_LINES, newChatSelected, threadPlusSelected, chatSelected, firstTurnChat, threadSelected, newChatLabel, MODE_LINES, MODE_GLYPH };
export { resumes, clearResumes, limitWakeDue, resumeAfterLimit };
export { openChatSubagents, latestSubagents, subagentRunning, subagentsOfTurn, applyToSegments, denialReason, currentTodos };
export { refreshLayerVersions, updateLayerNow, chooseLayerVersion, setAutoLayers, promptLayersOff, sameLayers, setPromptLayer, promptLayerEdits, sameEdits, setPromptLayerText, promoteLayerText, syncPromptLayers, retryConnect };
export { refreshProjects, refreshNotes, refreshProposals, refreshKnowledge, refreshProjectsFolder, useProjectsFolder, useKnowledgeDir, useProject, openProjectFolder, offerPracticesClaudeMd, showNewProject, closeNewProject, discardNewProject, pickNewProjectFolder, resolveNewProjectPath, createNewProject, importFromClaude, renameProject, forgetProject, revealFolder, tabsOwner, restoreTabs };
export { refreshPlanUsage, readPlanAtReplyEnd, planUsageFromTurn, PLAN_USAGE_LIVE_EVERY_MS, TURN_BUDGET_EVERY_MS, readTurnBudget, readCheckpoint, setCheckpoint };
export { refreshDreamStatus, refreshCaptureStatus, passTargetFor, runCapture, saveMemoryFromChat, stopCapture, runDream, maybeHandoffPass, stopDream, refreshCentre, centreCount, dismissNotice, openNotice, revertDreamFile, revertApplied, openInstructions, setDailyPrefs, runDailyPass, maybeDailyPass };
export type { AutoPassKind };
export { history, chatScope, undoLabel, redoLabel, undo, redo, inTextField, syncUndoMenu, saveEdit, removeTurn, restoreTurn, removeBlock, restoreBlock, saveReplyEdit, editContextItems, renameSession, contextUsed, sessionCost, roundCost, cacheHitRate };
export { shownContent, reflectTabs, tabOpening, openContent, dropContent, focusPane, newTab, closeTab, stepTab, moveTab, splitTab, splitActiveTab, dropNoteTabs, registerTerminalHooks, flushNewProject, flushTabs, startContentDrag, endContentDrag, droppedContent };
export { showNote, showGraph, closeNote, leaveNote, currentModelId, openModelInstructions, CHAT_INSTRUCTIONS_FILE, openChatInstructions, saveNote, deleteNote, moveNoteTo, followNoteMove, onNoteMove, movedNoteName, followToolMoves, newNoteFolder, deleteNoteFolder, reviewProposal, mirrorDraft, noteDraftKey, stageProposal, acceptProposal, unstageProposal, dismissProposal };
export { showNightshift, refreshNightshift, syncNightshiftProject, selectNightshiftProject, loadNightshiftReview, loadMornings, openMorning, morningIsRead, markMorningRead, loadShifts, latestShift, selectShift, loadShiftLog, showDiff, loadBlockers, selectBlocker, loadItems, selectItem, newItem, startInterview, sendInterview, loadInterview, cancelInterview, writeInterviewItem, deleteItem, saveItem, reorderItems, synthPlan, writeAndLaunch, scheduleLaunch, cancelLaunch, loadPendingLaunch, loadUsage, clockOf, loadNotes, openNote, answerBlocker, revertPreview, revertShift, loadNightshiftMorning, enableNightshift };
export { asideAsking, asideInTab, asideTabThread, asideReads, asidesOf, asideOf, askAside, ATTACHMENTS_ONLY, unfoldAside, asideWaiting, asideWire, followUpAside, rewindAside, restoreAsideTurns, asideStash, councilFor, setCouncilFor, switchAside, draftAside, dismissAside, stopAside, asideTurnEvent, asidePhase, settleAsideSegments, setAsideUnsent, asideHasDraft, requestDismissAside, answerAsideDiscard, onAsideClosed, reopenAside };
export type { AsideTurn, Aside, AsideAsk };
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    viewport.w = window.innerWidth;
  });
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
/** He is here (backlog 189): this running chat is the one open, in a
 *  focused window. The hook holds a call past the stop line for his
 *  answer only then, or within five minutes of his message. */
export function notePresence(session: string, input: boolean): void {
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
/** Item 691: the edited message `sendEdit` draws in the fork the moment it
 *  opens — at `at`, the fork's last event — so the chat is never blank
 *  while the send is still on its way to its own push (Claude Code's
 *  `layersBeforeTurn` may reconnect a cold chat first: seconds). A fork of
 *  "before message 1" has no message at all, and App.svelte drew the new
 *  chat page for that gap. The send's push takes it (`pushSent`); a send
 *  that never pushed has it taken back by `sendEdit`. */
let editEcho: { chat: string; at: number; text: string } | null = null;
/** True when the open chat's last event is still the echo `echo`. */
function echoStands(echo: { chat: string; at: number; text: string }): boolean {
  const there = app.events[echo.at];
  return (
    echo.chat === app.activeSessionId &&
    echo.at === app.events.length - 1 &&
    there?.event === "user_message" &&
    there.text === echo.text
  );
}
/** Draw the message a send is starting: in the echo's place when it is
 *  this send's own (same chat, still last, same words), else at the end. */
function pushSent(message: SessionEvent & { event: "user_message" }): void {
  const echo = editEcho;
  editEcho = null;
  if (echo !== null && message.text === echo.text && echoStands(echo)) {
    app.events[echo.at] = message;
    return;
  }
  app.events.push(message);
}
/** The chats a turn is starting in on screen (535f, 535-1): from the top
 *  of `sendAgent` — which `sendInChat`'s on-screen path reaches with no
 *  await between — until the turn is the window's (`app.busy`) or has
 *  gone elsewhere. `chatRuns` counts them, so a second sender (the limit
 *  resume and a tick at the same reset) waits instead of starting a turn
 *  beside it during the first one's reconnect. Keyed by a token per send,
 *  so a late end never clears a newer send's mark. */
export const startingIn = new Map<string, symbol>();
/** `send` for a message he did not type here (the phone, a resume) —
 *  with the phone's photos, documents or council when it sent them
 *  (item 246, 1B's patch note 1), so such a turn is not his typed input. */
export async function sendUntyped(
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
  // In the view's lane (item 686): a chat's open asked for earlier — a
  // closed tab's neighbour, reading its log from disk — lands first, never
  // over this New chat, here or in the backend.
  const moved = await inViewLane(async () => {
    // A turn started while it waited: the running chat's New chat path.
    if (app.busy) return true;
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
    return false;
  });
  if (moved) await newSession(mode, kind);
}

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
export function park(): void {
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
export async function unpark(): Promise<void> {
  // In the view's lane (item 686): an open asked for earlier lands first.
  await inViewLane(async () => {
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
  });
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
export interface TurnCtx {
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
export let fg: TurnCtx | null = null;

/**
 * The turn on screen to the background (backlog 159, A2): its view kept
 * under its chat's id, the window idle for the chat he opens next. False
 * when it cannot go (`canDetach`): the caller parks it instead.
 */
export function detach(): boolean {
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
export function promoteParked(): void {
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
export async function attach(id: string): Promise<void> {
  const b = app.background[id];
  const t = bgTurns.get(id);
  if (!b || !t) return;
  // Its own project first (blocker 630): its log, tab and list are there.
  if (inOtherProject(b, app.project?.id ?? null)) {
    await openRunningChat(id);
    return;
  }
  // In the view's lane (item 686): an open asked for earlier lands first,
  // never over this chat; what is read is read again when its turn comes.
  const moved = await inViewLane(async () => {
    const b = app.background[id];
    const t = bgTurns.get(id);
    // Its turn ended while it waited: an ordinary open, out of the lane.
    if (!b || !t) return true;
    if (inOtherProject(b, app.project?.id ?? null)) return true;
    if (app.busy && !detach()) {
      addToast("A turn is just starting here — open that chat again in a moment");
      app.openNext = "replace";
      return false;
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
    return false;
  });
  // Ended, or in another project now: opened as any chat is.
  if (moved) {
    if (app.background[id]) await attach(id);
    else await openSession(id);
  }
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
  pushSent({
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
  pushSent({
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
    // Item 691: the fork opens with the edited message already in its
    // place — as the send will draw it — so the chat stays drawn (a fork of
    // "before message 1" is otherwise blank, the new chat page, until the
    // send's own push after its reconnect). The send takes it (`pushSent`).
    app.events = [
      ...res.events,
      {
        event: "user_message",
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(documents.length > 0 ? { documents } : {}),
        at: new Date().toISOString(),
        ...(files.length > 0 ? { sending_files: files.map((f) => f.name) } : {}),
      },
    ];
    editEcho = { chat: res.session, at: res.events.length, text };
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
  const echo = editEcho;
  try {
    await send(text, images, documents, null, files);
  } finally {
    // A send that never pushed (its guard, a failed layer step, the words
    // queued or sent off screen): the echo is not a message the model got,
    // so it goes — the words are wherever that path put them.
    if (echo !== null && editEcho === echo) {
      editEcho = null;
      if (echoStands(echo)) app.events.splice(echo.at, 1);
    }
  }
  return true;
}
