<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  import { tick, untrack } from "svelte";
  import { MODEL_OTHER } from "./railEvents";
  import { clockText } from "./schedule";
  import Icon from "./Icon.svelte";
  import { isImeKey } from "./imeKey";
  import Kbd from "./Kbd.svelte";
  import ResizeHandle from "./ResizeHandle.svelte";
  import { caretAtEnd, dragHeight, growHeight, loadBoxHeight, measureHeld, overflows, saveBoxHeight } from "./boxGrow";
  import { sentSinceDrag } from "./composerSize";
  import {
    app,
    addToast,
    applyDraft,
    cacheHitRate,
    cancelTurn,
    stopClock,
    continueChat,
    runningChatName,
    providerElsewhereName,
    registerProviderDrain,
    registerRunDrain,
    contextUsed,
    pickerModels,
    send,
    sendHeld,
    switchModel,
    switchModelAt,
    turnWasStopped,
  } from "./state.svelte";
  import { MODEL_KEYS, modelChipLabel, thinkingSupport } from "./catalog";
  import { modelList } from "./modelList.svelte";
  import { modelSeen } from "./modelSeen.svelte";
  import { aliasView, currentCliVersion, displayName, familyRows, newestModels, otherOnRows } from "./modelSeen";
  import { cli } from "./cliUpdate.svelte";
  import { effortDefaultLabel, effortModel } from "./effortDefaults";
  import {
    cacheBuiltWith,
    cacheLine,
    canRestore,
    kindAtCache,
    restoreEngine,
    cacheLoss,
    cacheLossLine,
    cacheState,
    nextTickMs,
    remainingText,
    restoreCacheSettings,
    ASIDE_COLD_TIP,
    asideSinceCold,
    coldEitherWay,
    chipFace,
    ownModelCache,
    newestReplySentAt,
    sideCacheFor,
    stoppedUnsure,
  } from "./cache";
  import { asideFigures } from "./asideFigures";
  import { cacheEstimate, lastReply, ratesFromPrice } from "./cacheCost";
  import { lossTipText } from "./shortTip";
  import { cacheRatesOf, loadCacheRates } from "./cacheRates.svelte";
  import { layerChangeSinceCache, modelIdFor, modelSwitchPending, nextSendModel, pendingChangeCost, switchDetail } from "./changeCost";
  import { handedOffOff, holdPress, holdTail, isKeeping, isOn, switchLabel, switchTitle, touchedUntil } from "./keepWarm";
  import { holdKeepWarm, keepWarm, loadKeepWarm, setKeepWarm } from "./keepWarm.svelte";
  import KeepWarmHold from "./KeepWarmHold.svelte";
  import { HIDDEN_THINKING_TITLE, thinkingToggleDead } from "./activity";
  import { toggleTranscriptPref, transcript } from "./transcriptPrefs.svelte";
  import { composerFormat, toggleComposerFormat } from "./composerFormat.svelte";
  import { hasTable } from "./mdTable";
  import { LiveBoxHandle, boxElement, type ComposerBox } from "./composerEditor";
  import { applyToField, codeBlockEdit, type BlockEdit } from "./codeBlockKeys";
  import LiveBox from "./LiveBox.svelte";
  // Item 800: saved message prompts with blanks, offered after a `/`.
  import { insertAt, matching, nextBlank, slashToken, type MessagePrompt } from "./savedPrompts";
  import { insertEdit, insertLabel, insertMatches, insertToken, type BoxInsert } from "./boxInserts";
  import { filledBody, loadSaved, saved } from "./savedPromptsStore.svelte";
  import { watchSelection } from "./selectionMemory";
  import { isMac } from "./platform";
  import { boxHistoryFor, editKind, historyInput, historyKey } from "./boxHistory";
  import TypedMathBar from "./TypedMathBar.svelte";
  import MathText from "./MathText.svelte";
  import { renderReply } from "./markdown";
  import { applyTypedMath, findTypedMath, rebaseTypedMath, wrapTypedMath, type TypedMathSpan } from "./typedMath";
  import { clearDenied, deniedFor, denyTypedMath, typedMathPrefs } from "./typedMathPrefs.svelte";
  import {
    RE_ASK,
    abortWrapUp,
    awayNow,
    beginWrapUp,
    clearMessage,
    handoff,
    hasOwnMessage,
    hasOwnThreshold,
    message,
    noteActivity,
    noteFill,
    noteShown,
    queueHold,
    reconsider,
    setMessage,
    setThreshold,
    stayHere,
    reopenHandoff,
    threadFor,
    threshold,
    noteThread,
    mark,
    cap,
    codeProbePaths,
    codeProjectFor,
    writesHandoffFile,
    noteCodeProject,
    neverHandsOff,
  } from "./handoff.svelte";
  import { armAwayCheck } from "./state/resumes.svelte";
  import { cardSize, dragCard, fold, noteStay, setCardSize, steppedMark, typedMark, unfold, type CardSize } from "./handoffFold.svelte";
  // Item 705 (option A, Console): the themed selects, and the next chat's model.
  import HudSelect from "./HudSelect.svelte";
  import { nextModelLabel, nextModelMenu, nextModelRows, setNextModel } from "./nextChatModel.svelte";
  // Item 768: wrap up while warm; one chip on return to a cold big chat.
  import { chipCosts, coldButtons, coldChipShows, coldTip, coldTitle, contextOf, sentToast, warmDetail, warmTitle, warmWrapAct } from "./warmWrap";
  import { actedOn, keepCold, keptCold, markActed, warmWrap } from "./warmWrap.svelte";
  // Item 618b: the row's look (Settings → Appearance → Composer row), stamped on the root; rules in src/composerRow.css.
  import { composerRow } from "./composerRow.svelte";
  // Item 644: the box takes the chat's model family (Opus Copper, Fable Lilac glass, others today's).
  import { composerModelId, modelFamily } from "./modelFamily";
  import { cacheFrame, cacheLook } from "./cacheLook.svelte";
  import ThreadPicker from "./ThreadPicker.svelte";
  import HandoffGoal from "./HandoffGoal.svelte";
  import { chatThread, refreshThreadFlags, injectIntoTurn, sendNowRow, openChatKey, takeQueued, takeStopSend, frontQueued, stopSendFor } from "./state.svelte";
  import { injectChip, queueHeadLabel } from "./midTurn";
  import { rowsOf } from "./subagentRows";
  import { draftEstimate, draftEstimateTitle, draftExact, draftExactTitle, EXACT_TOKENS_FROM, fmtTokens } from "./tokens";
  import { exactCounter, type ExactResult } from "./draftCount";
  import { countDraftTokens, namedFiles, pasteIntoFocus, takeBackInjected } from "./api";
  import KeepButton from "./KeepButton.svelte";
  import { keepKey } from "./keep";
  import { keepStateOf, revealKept } from "./keep.svelte";
  import { menuInterceptors, asideReads, asidesOf } from "./state.svelte";
  import { declaredKind, useEngine } from "./state.svelte";
  import { openSession } from "./state.svelte";
  import { handoffChildren } from "./chatList";
  import { bubbledRows, cancelPending, registerSendHeld } from "./pendingBubble.svelte";
  import WaitAct from "./WaitAct.svelte";
  import {
    canUndo,
    followOffer,
    isPasteAsAttachmentKey,
    longPasteOffer,
    normalizeNewlines,
    pasteAction,
    undoConverted,
    type Converted,
    type LongPaste,
  } from "./pasteAttach";
  import { badgeOf, convertingWords, extOf, routeLabel, type Engine } from "./attachKinds";
  import PdfRouteSwitch from "./PdfRouteSwitch.svelte";
  import { draftImageContent, openAttachment } from "./attachments.svelte";
  import { sendTip, tip } from "./tip";
  import { armStop, stopChordLabel, stopChordTarget } from "./stopButton";
  import { stopPref } from "./stopShape.svelte";
  import { releaseStop, slowDueIn, slowStopLine, stopPhase } from "./stopState";
  import { acceptFiles, conversionJobs, filesBlocked, MAX_IMAGE_BASE64, splitChips, stepChips, trackPending } from "./attachFiles.svelte";
  import { clock, tickWhile } from "./convertClock.svelte";
  import { floatMenu } from "./floatMenu";
  import { ghostFor } from "./suggestions.svelte";
  import { queuedElsewhereToast } from "./browse";
  import {
    addAttachment,
    bumpDraft,
    clearDraft,
    draftKey,
    draftSelection,
    clearInjected,
    enqueueMessage,
    historyFor,
    nextAttachmentId,
    nextQueueId,
    readDraft,
    removeAttachment,
    requeueFront,
    restoreDraft,
    setDraftAttachments,
    restoreComments,
    setDraftSelection,
    setDraftScroll,
    draftScroll,
    setDraftText,
    shiftQueue,
    forgetMove,
    ranKey,
    takeBackQueued,
    updateAttachment,
    removeComment,
    setCommentNote,
  } from "./drafts.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { chipLabel, commentsMessage, shownQuote, commentLabel, commentWhere, type PassageComment } from "./passageComments";
  import { draftSendTokens } from "./draftCost";
  import { sendWithComments, sentComments } from "./sentComments";
  import { commentRequest, takeCommentFocus } from "./commentRequest.svelte";
  import type { Attachment } from "./types";
  import { isChipTag } from "./chipSteps";
  // Scheduled send (backlog 224): the ▾ beside Send and the chip above.
  import ScheduleMenu from "./ScheduleMenu.svelte";
  import FilamentMark from "./FilamentMark.svelte";
  import ScheduledChip from "./ScheduledChip.svelte";
  import { scheduledFor } from "./scheduled.svelte";
  import { hasNoTurns } from "./waitingChat";
  import PreviewChip from "./PreviewChip.svelte";
  import ClaudeBrowserChip from "./ClaudeBrowserChip.svelte";
  import { asideBrowserSession } from "./claudeBrowser";
  import TurnCapChip from "./TurnCapChip.svelte";
  // Item 542: under the Classic layout, 1d4ca17's browser strip.
  import ClaudeBrowserChipClassic from "./ClaudeBrowserChipClassic.svelte";
  import { classic } from "./layout.svelte";
  const BrowserChip = $derived(classic() ? ClaudeBrowserChipClassic : ClaudeBrowserChip);
  import { registerScheduleDrain } from "./scheduleRuntime";
  import CouncilPopover from "./CouncilPopover.svelte";
  import ClipPanel from "./ClipPanel.svelte";
  import { clips, recordImage, recordText } from "./clipRing.svelte";
  import type { CouncilPrefs } from "./council";
  import { foldToFit } from "./fold";
  import { Marks, chipMotion, prefersReducedMotion } from "./chipFade";
  import DropOverlay from "./DropOverlay.svelte";
  import { chipDropIn, rowDropOpen } from "./dropLook";
  import { dropPending, markPasted, takeDropped } from "./dropLook.svelte";
  import { fenced, findFences, withFenceLanguage } from "./codeDetect";
  import BoxLayer, { layerShown } from "./BoxLayer.svelte";
  import PasteOfferRow from "./PasteOfferRow.svelte";
  import {
    AttachMark,
    attachPastedText as sharedAttachPastedText,
    convertOffer,
    isConvertTag,
    pasteAsAttachment as sharedPasteAsAttachment,
    type ConvertTag,
  } from "./pastedText.svelte";
  import { pasteSteps, textPastePlan } from "./textPaste";
  import { attachPastedImages, fetchPasteImage, htmlImagePaste, lostImagesNote, preparePaste, rasterize, type ImagePaste } from "./pasteImages";
  import { launch, QUEUED_CHANNEL } from "./sendMotion";
  import { composerConnectHint, launch as launchState } from "./launch.svelte";
  import { insertQuote, replyRequest, takeReply } from "./replyQuote.svelte";
  // Item 694: the passage highlighted before he came to the box.
  import { boxAsideArgs, dropHeld, dropHeldOnPaste, heldChip, heldFor, heldLabel } from "./heldPassage.svelte";
  import { quoteLabel } from "./asideQuote";
  import { composerFocus, dismissRewoundOffer, rewoundOffer, takeOffered } from "./rewindDraft.svelte";
  import { CaretKeeper, clampSel, mayAutoFocus } from "./composerCaret";
  import { ScrollHold } from "./boxPlace";
  import { FocusThroughLock, boxLocked } from "./boxLock";
  import { boxMounted, chatBoxMounted, composerSummon, isSummonTarget } from "./composerSummon.svelte";
  import { registerPasteHandler, type PasteRequest } from "./pasteToCompose";
  import { handOffBlock, handOffNow, isHandoffCommand } from "./manualHandoff.svelte";
  // Item 966: the app's slash commands, one table for every box.
  import { commandKind, commandMatches, newKind, NEW_KINDS_HINT, parseCommand, pickRow, typedInFull } from "./appCommands";
  // Item 967: the second batch's actions, each its control's own function.
  import { runBatch2, type BoxActions } from "./appCommands967";
  import { newNoteOrOpen } from "./newNoteOrOpen";
  import { atTime, resetTime } from "./schedule";
  import { canMakeMain } from "./versions";
  import { makeMainChat, versions } from "./versions.svelte";
  import { newShell, openAgentTab, terminalCwd } from "./terminal.svelte";
  import { canLeaveProject, councilFor, saveMemoryFromChat, setCheckpoint, useProject } from "./state.svelte";
  import { rewindAsideWithUndo } from "./asideRewind.svelte";
  import { renameAside } from "./asides.svelte";
  import { liveFlags, renameSession, rewindTo, runMenuCommand, toggleSidebar } from "./state.svelte";
  // Backlog 283: the same composer in an aside.
  import {
    asideAsking,
    asideWaiting,
    askAside,
    followUpAside,
    openContent,
    stopAside,
    type Aside,
  } from "./state.svelte";
  import { asideDraftKey, asideLabel } from "./asides";
  import { composerShows } from "./asideControls";
  import { pickText } from "./pick";
  import { scheduleAsideSave } from "./asides.svelte";
  import {
    prewarmAfterTurn,
    prewarmer,
    turnEnded,
    wantsWarm,
    wantsWarmAtTurnEnd,
    type TurnView,
  } from "./prewarm";

  /**
   * `floating` drops the docked chrome (top border, panel fill) for the
   * new-chat page, where the composer sits in the middle of the pane rather
   * than at the bottom of a transcript. One component either way: a second
   * composer would be a second place to fix a paste bug.
   */
  let {
    floating = false,
    aside = null,
    asideChat = null,
    compact = false,
    takeFocus = undefined,
  }: {
    floating?: boolean;
    /**
     * An aside's thread (nightshift backlog 283, 2026-10-02 — his "why the
     * functionality … is so much more limited"): the same composer, every
     * control the chat's has that means something in an aside — attach,
     * paste as an attachment, the model and effort pickers (the aside's
     * own, defaulting to the chat's), earlier drafts, the slash list, the
     * ⌘⇧V ring, the format toggle, the queue — sending into the thread
     * instead of the chat. Its text, chips and held messages live in the
     * drafts store under the thread's key (`asideDraftKey`), so they are
     * kept as a chat's are; `aside.unsent` mirrors the text. What is the
     * chat's alone is not drawn: the hand-off notice, the schedule ▾, the
     * council, Ask aside, the CLI's predicted prompt, the thinking / tools
     * toggles and the cache chip.
     */
    aside?: Aside | null;
    /** The chat the thread belongs to; null is the open one. */
    asideChat?: string | null;
    /** The floating card: a shorter box, so the card keeps its thread. */
    compact?: boolean;
    /**
     * Take the focus when a chat arrives (backlog 290): the chat's box and
     * an aside tab's, not a floating aside card's — that one sits beside
     * the chat and would pull the focus off its box.
     */
    takeFocus?: boolean;
  } = $props();

  /**
   * The draft is the open chat's, not the box's (nightshift backlog 065,
   * 2026-09-15): `drafts.svelte.ts` keeps one per chat id — the pending
   * chat's key, `new:<project>:<kind>`, while no chat is open (backlog 094,
   * 2026-09-16: one literal "new" was one slot across every project) — and
   * this component binds to the entry for the current key. A chat or
   * project switch changes the key and the box follows; the pending chat's
   * entry moves to the chat its first message creates (the one line in
   * `send`). Sending clears the entry, and nothing else does.
   */
  const key = $derived(aside ? asideDraftKey(aside) : draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread));
  /** The pick chip whose contents are open under the strip (item 797). */
  let pickShown = $state<number | null>(null);
  /*
   * Item 694: the passage he highlighted before clicking into the box (the
   * transcript holds it as the selection gives way to the box,
   * `heldPassage.svelte.ts`). Shown as a chip and taken by Ask aside only
   * while the box's Ask aside is offered: the chat's box, the Claude Code
   * engine, a chat with a turn in it.
   */
  // The line under the box when there is no connection (items 230, 873): the failure only; "connecting…" is the top bar's.
  const connectHint = $derived(app.connection ? null : composerConnectHint({ connected: false, connecting: app.connecting, launchConnectSettled: launchState.connectSettled }));
  const held = $derived(!aside && app.connection?.engine === "claude-code" && app.events.length > 0 ? heldFor(key) : null);
  // Never carried to another chat: switching chat (or the box going) drops it.
  $effect(() => {
    if (aside) return;
    const k = key;
    return () => dropHeld(k);
  });
  // The chat's turn starting drops it: the turn did not take it.
  $effect(() => {
    if (aside || !app.busy) return;
    untrack(() => dropHeld(key));
  });
  const draft = $derived(readDraft(key));
  const text = $derived(draft.text);
  // Item 814: the chip only once he has written here, and a paste drops the passage (`onpaste`).
  const heldShown = $derived(heldChip(held, text));
  /*
   * Item 754: comments on passages — chips over the chat's box, each a
   * passage he highlighted and his words about it (`passageComments.ts`).
   * Part of the draft, so they outlive a switch, a reload and a quit;
   * Send (and Queue, and the council) sends them with the box's text as
   * one message. The aside's box has none.
   */
  const comments = $derived<PassageComment[]>(aside ? [] : (draft.comments ?? []));
  /** Nothing to send: no words, no chip, no comment. */
  const boxEmpty = $derived(!text.trim() && draft.attachments.length === 0 && comments.length === 0);
  /** The chip whose comment line is open (view state). */
  let openComment = $state<number | null>(null);
  const openC = $derived(comments.find((c) => c.id === openComment) ?? null);
  let commentTa = $state<HTMLTextAreaElement | null>(null);
  const DROP_DIALOG = { title: "Discard this comment?" } as const;
  /** The chip × asked about; its confirm is showing while set. */
  let dropAsk = $state<PassageComment | null>(null);
  $effect(() => {
    void commentRequest.id;
    if (aside) return;
    const id = untrack(() => takeCommentFocus(key));
    if (!id) return;
    openComment = id;
    void tick().then(() => commentTa?.focus());
  });
  function closeComment(): void {
    openComment = null;
    ta?.focus();
  }
  function confirmDropComment(): void {
    const c = dropAsk;
    dropAsk = null;
    if (!c) return;
    if (openComment === c.id) openComment = null;
    removeComment(key, c.id);
  }

  /*
   * The aside's composer (backlog 283). Its words were the thread's
   * `unsent` before (228); a thread typed into before this build has
   * them there and nothing under its key, so they move in once. From then
   * the drafts entry is the box's, and `unsent` follows it — the aside
   * store's keep rule, the Discard question and the lists read it.
   */
  $effect(() => {
    const a = aside;
    const k = key;
    if (!a) return;
    untrack(() => {
      const u = a.unsent ?? "";
      if (u.trim() && !readDraft(k).text) setDraftText(k, u);
    });
  });
  $effect(() => {
    const a = aside;
    const t = text;
    if (!a) return;
    untrack(() => {
      if ((a.unsent ?? "") === t) return;
      a.unsent = t;
      // A stashed chat's thread is not watched by the keeper's effect.
      scheduleAsideSave();
    });
  });
  /** The aside's chat: the one named, else the open one. */
  const asideOwner = $derived(aside ? (asideChat ?? app.activeSessionId) : null);
  /** The thread is the open chat's — an aside answers from the open
   *  chat's context, so only then does Send ask. */
  const asideOpen = $derived(!!aside && asideOwner === app.activeSessionId && app.asides.includes(aside));
  const asideOnEngine = $derived(app.connection?.engine === "claude-code");
  /** An answer is coming in this thread: Send queues, Stop stops it. */
  const asideBusy = $derived(!!aside && asideAsking(aside) !== null);
  /** What blocks an aside's Send, if anything; the text stays. */
  const asideBlock = $derived<"not-open" | "engine" | null>(
    !aside ? null : !asideOnEngine ? "engine" : !asideOpen ? "not-open" : null,
  );
  const asideChatName = $derived.by(() => {
    if (!asideOwner) return "the chat";
    const s = app.sessions.find((x) => x.id === asideOwner);
    return s?.title ?? s?.first_user ?? "this chat";
  });
  /** The chat's turn or this thread's answer: what Queue / Stop are about. */
  const busy = $derived(aside ? asideBusy : app.busy);
  // Item 466: the chat's Stop, pressed, until its turn has ended. `stopNow`
  // moves once, at the slow mark, for the quiet line; the clock is let go
  // of when the turn ends however it ends.
  let stopNow = $state(0);
  const stopState = $derived(aside ? "idle" : stopPhase(app.busy, stopClock, stopNow));
  const stopPressed = $derived(stopState === "stopping" || stopState === "slow");
  $effect(() => {
    const due = slowDueIn(stopClock, performance.now());
    if (due === null || !app.busy) return;
    const t = setTimeout(() => (stopNow = performance.now()), due + 16);
    return () => clearTimeout(t);
  });
  $effect(() => {
    if (!app.busy && stopClock.since !== null) releaseStop(stopClock);
  });
  // Item 256: the next message's process starts while he types, so Send
  // finds the CLI, his hooks and the MCP servers already done.
  $effect(() => {
    if (wantsWarm({ engine: app.connection?.engine, busy: app.busy, aside: !!aside, text })) prewarmer.poke();
  });
  // Blocker 1240: and the moment the open chat's turn ends, so a message
  // pasted or dictated and sent at once still finds it started.
  let lastTurn: TurnView = { busy: false, chat: null };
  $effect(() => {
    const now: TurnView = { busy: app.busy, chat: app.activeSessionId };
    const prev = lastTurn;
    lastTurn = now;
    if (!turnEnded(prev, now)) return;
    const draft = untrack(() => text);
    if (wantsWarmAtTurnEnd({ engine: app.connection?.engine, aside: !!aside, text: draft })) {
      void prewarmAfterTurn();
    }
  });
  /**
   * The draft's live token estimate (nightshift backlog 155): characters ÷ 4,
   * shown beside Send from ~50 tokens up. Debounced so a fast typist or a
   * dictation burst recounts once per pause, not per keystroke; a cleared
   * box (a send, a chat switch) clears it at once.
   */
  let estimate = $state<ReturnType<typeof draftEstimate>>(null);
  $effect(() => {
    const t = text;
    if (!t) {
      estimate = null;
      return;
    }
    const id = setTimeout(() => (estimate = draftEstimate(t)), 120);
    return () => clearTimeout(id);
  });
  /**
   * The exact count (backlog 155, second half): on the provider engine, a
   * draft past ~500 tokens is counted by the provider once it has been still
   * for a moment — never per keystroke. Shown only while it is the count of
   * the text in the box; any edit falls back to the estimate until the next
   * pause. The Claude Code engine has no counter and keeps the estimate.
   */
  let exact = $state<ExactResult | null>(null);
  const counter = exactCounter(countDraftTokens, (r) => (exact = r));
  $effect(() => {
    counter.update(text ?? "", {
      engine: app.connection?.engine,
      provider: app.connection?.provider,
      model: app.connection?.model,
    });
  });
  $effect(() => () => counter.dispose());
  /** The figure beside Send and its hover: exact when counted, else the estimate. */
  const shown = $derived.by(() => {
    if (!estimate) return null;
    if (exact && exact.text === text && exact.tokens !== null)
      return { ...draftExact(exact.tokens), title: draftExactTitle(exact.tokens, exact.model) };
    let why: string | undefined;
    if (app.connection?.engine === "claude-code")
      why = "The Claude Code engine has no count endpoint, so it stays an estimate.";
    else if (estimate.tokens < EXACT_TOKENS_FROM)
      why = `From ~${EXACT_TOKENS_FROM} tokens it is counted exactly after you pause.`;
    else if (exact && exact.text === text && exact.tokens === null)
      why = "This provider's count was not available, so it stays an estimate.";
    else why = "Counting exactly once you pause.";
    return { ...estimate, title: draftEstimateTitle(estimate.tokens, why) };
  });
  const attachments = $derived(draft.attachments);
  /**
   * Item 904 (blocker 2283): what this box's draft adds to the next send —
   * its text with its passage comments, and its attachments — in tokens, for
   * every next-send figure this box shows (the chip, the cold banner's Keep,
   * the "cache will be lost" bar, the model menu's switch price). The same
   * box in an aside prices the aside's draft. Debounced with the estimate
   * beside Send, so typing recounts once per pause.
   */
  // The chips apart from the text, so a keystroke never re-reads an image's header.
  const chipTokens = $derived(draftSendTokens("", attachments, app.connection?.engine === "claude-code" ? "claude-code" : "api"));
  const draftTokens = $derived.by(() => {
    const t = estimate ? text : "";
    return chipTokens + draftSendTokens(comments.length > 0 ? commentsMessage(comments, t) : t, [], "api");
  });
  // Item 868: "converting slides · 1:12" ticks while a chip converts.
  tickWhile(() => attachments.some((a) => a.pending && !!a.converting));
  /**
   * Messages held while a turn runs (nightshift backlog 089, 2026-09-16).
   * ↵ during a turn queues instead of doing nothing; the tray above the box
   * lists the queue; when the turn ends the oldest goes as the next turn
   * (`dispatch` → `drain`) — unless the turn was one he stopped, or ~~the
   * hand-off's wrap-up is due~~ the hand-off's own turn just ended
   * (HANDOFF.md written; pass 2 of backlog 086), in which case the queue
   * waits for *Send next* (`queueHold`; the whole-project review of
   * 2026-09-16, F11 and F12: before that a Stop sent the next message at
   * once, and a message queued as the window filled left with the wrap-up
   * under it, unasked — F11's case is gone since the wrap-up became a
   * message of its own, one the hand-off itself puts in this queue when
   * the mark is crossed while he is away).
   * ~~a Stop ends the turn like any other end, so the queue is why he
   * stopped or he takes it back~~ (2026-09-16). Each row can be taken
   * back into the box or dropped; ↑ in an empty box takes the newest back,
   * as the CLI does. Held in the draft store, so it is per chat, follows
   * the pending chat into the one it makes, and survives a relaunch. The
   * engine is not consulted: `send` is one path for both. What Nightloom
   * cannot do is hand a message to the *running* turn between tool calls
   * the way the CLI does — that needs the long-lived process of blocker
   * 062, and this is the half that needs nothing from it.
   */
  const queue = $derived(draft.queue);
  /* Item 465 (merge patch note from agent E): the rows the transcript
   * already draws as pending bubbles (`PendingBubbles`, main chat only)
   * are left out of the queue box, so each mid-turn row shows in one place.
   * Item 548: under Filament IV the transcript draws the held ones too
   * (`bubbledRows`), so the main chat's box keeps no rows of its own. */
  // Item 674's follow-up: an aside's held messages are bubbles in its
  // transcript under Filament, as the chat's are; Classic keeps the rows.
  const bubbledIds = $derived(new Set(aside ? (classic() ? [] : queue.map((q) => q.id)) : bubbledRows(queue, app.busy && !app.parked, !classic(), app.busy && !!app.parked).map((q) => q.id)));
  /** Item 548: which tray rows he opened past their first line (this launch). */
  let rowOpen = $state<Record<number, true>>({});
  const boxQueue = $derived(queue.filter((q) => !bubbledIds.has(q.id)));
  /*
   * The box he types in: the textarea, or — with the format toggle on
   * (item 276) — the formatted editor's `LiveBoxHandle`, which answers the
   * same calls (caret, focus, size), so everything below drives either.
   */
  let ta = $state<ComposerBox | null>(null);
  /*
   * The quote styled in place (item 223, his pick "A": not a card). While
   * the draft has a `> ` line, a layer behind the textarea draws the whole
   * draft — quote lines with the bubble's bar and muted text — and the
   * textarea's own glyphs go transparent over it, its caret and selection
   * kept. It is still the textarea he types in: cursor, selection, IME,
   * undo, paste and auto-grow are the textarea's. The layer holds the same
   * characters with the same font, padding and wrapping, sized to the
   * textarea's client box and scrolled with it — `BoxLayer.svelte`, shared
   * with the edit box of one of his messages since item 399.
   */
  // Drag events fire per element, so a boolean flickers as the pointer crosses
  // children; count enters against leaves instead.
  let dragDepth = $state(0);

  /**
   * How tall the box may grow before it scrolls inside itself (item 039 in
   * the nightshift repo). Unset, it is 40% of the column, so the transcript
   * keeps the other 60% however long the draft; ~~the handle on the top edge
   * sets it by hand~~ the setting is kept per machine. The floating
   * composer on the new-chat page has no transcript to balance against and
   * keeps a fixed cap.
   *
   * Since 2026-09-16 (nightshift backlog 111) the handle sets the box's
   * *height*, not its cap: "there isn't a way of making the text box
   * bigger while I'm in a chat" — with a short draft the box was sized to
   * its text and a drag on the cap changed nothing he could see. Dragged
   * to a height, the box is that tall with an empty draft (a floor,
   * `floorPx`, kept per chat under `nightloom.composer.height.<key>`);
   * text still grows it past the floor up to the cap, which is raised to
   * reach the floor where it must be. A drag *down* below what the draft
   * needs still lowers the cap, as it did — so the drag puts the edge
   * where the pointer is either way, and only typing moves it after.
   * Double-click clears both. ⌥⌘↑ / ⌥⌘↓ in the box do the same by a line.
   */
  const FLOATING_MAX = 200; // ~8 rows
  /** The aside card's box (283): ~5 rows, then it scrolls inside. */
  const ASIDE_CARD_MAX = 120;
  const CAP_FRACTION = 0.4;
  const CAP_MIN = 72;
  const CAP_KEY = "nightloom.composer.max";
  const HEIGHT_KEY = "nightloom.composer.height.";
  /** No shorter than one line of text plus the box's own padding. */
  const FLOOR_MIN = 26;

  // Read and written through `boxGrow.ts` since backlog 226, which the
  // aside boxes share.
  function loadHeight(k: string): number | null {
    return loadBoxHeight(HEIGHT_KEY + k, FLOOR_MIN);
  }
  function saveHeight(k: string, n: number | null): void {
    saveBoxHeight(HEIGHT_KEY + k, n);
  }

  /** The height set by hand for the open chat, or null for auto-grow alone. */
  let floorPx = $state<number | null>(null);
  // The chat's own floor comes in with its draft. A height set on the
  // pending chat's key stays on that key (the next new chat in the
  // project finds it) rather than following the draft to the chat its
  // first message creates: the move lives in `state.svelte.ts`.
  $effect(() => {
    const k = key;
    floorPx = loadHeight(k);
    // Item 849: leaving the chat (a switch, a hand-off, the box closing)
    // ends the drag's hold, as a send does — back, the empty box is one
    // line, and typing still grows it up to the dragged height.
    return () => sentSinceDrag.left(k);
  });

  /**
   * Since backlog 254 a send turns the dragged height into a ceiling:
   * the box goes back to one line, and typing grows it up to his size
   * (`maxHeight` keeps the floor in the cap). A drag makes it a floor again.
   */
  function afterSend(k: string): void {
    sentSinceDrag.sent(k);
    if (lostPaste?.key === k) lostPaste = null;
    requestAnimationFrame(autogrow);
  }

  function loadCap(): number | null {
    try {
      const raw = localStorage.getItem(CAP_KEY);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= CAP_MIN ? n : null;
    } catch {
      return null;
    }
  }
  function saveCap(n: number | null): void {
    try {
      if (n === null) localStorage.removeItem(CAP_KEY);
      else localStorage.setItem(CAP_KEY, String(Math.round(n)));
    } catch {
      // best-effort
    }
  }

  /** The cap set by hand, or null for the 40% rule. */
  let capPx = $state<number | null>(loadCap());
  let dragging = $state(false);

  /** The column the composer shares with the transcript. */
  function columnHeight(): number {
    const col = ta?.closest(".main") as HTMLElement | null;
    return col?.clientHeight ?? window.innerHeight;
  }

  function maxHeight(): number {
    if (floating) return FLOATING_MAX;
    // The aside card (283): a few lines, so the thread above keeps the card.
    if (compact) return Math.min(300, Math.max(CAP_MIN, floorPx ?? ASIDE_CARD_MAX));
    const auto = Math.round(columnHeight() * CAP_FRACTION);
    // The cap never sits under the floor: a box dragged to 300px is 300px.
    return Math.max(CAP_MIN, capPx ?? auto, floorPx ?? 0);
  }

  /** The height the draft alone asks for — `autogrow` before the clamp. */
  function textHeight(): number {
    if (!ta) return 0;
    const was = ta.style.height;
    // Item 469: measured with the composer's height held, so the chat
    // above is not given the room for a moment (its scroll was clamped).
    return measureHeld(ta, root, () => was);
  }

  /** The tallest the box may be dragged: most of the column, never all. */
  function dragLimit(): number {
    return Math.round(columnHeight() * 0.85);
  }

  /**
   * Put the box's edge at `px` (backlog 111): the floor for this chat,
   * and — where the draft needs more than that — the cap too, which is
   * what the drag did before (039) and is still how a long draft is made
   * to scroll sooner. Saved on the pointer's release, not per move.
   */
  function setHeight(px: number) {
    const next = Math.min(dragLimit(), Math.max(FLOOR_MIN, Math.round(px)));
    floorPx = next;
    sentSinceDrag.sized(key);
    const need = textHeight();
    // Only a draft of two lines or more lowers the cap: an empty box is a
    // hair taller than the smallest floor, and must not cap every chat at
    // three lines because this one was dragged shut.
    if (need > next && need >= 2 * lineHeight()) capPx = Math.max(CAP_MIN, next);
    // A cap left under the new edge by an earlier drag down would stop
    // the text growing the box past it; back to the 40% rule instead.
    else if (capPx !== null && capPx < next) capPx = null;
    autogrow();
  }

  function persistHeight() {
    saveHeight(key, floorPx);
    saveCap(capPx);
  }

  /**
   * The handle. ~~Dragging up raises the cap and the box grows into it as far
   * as the draft needs; dragging down lowers it and the box scrolls sooner.~~
   * Since backlog 111 the drag moves the box's edge itself, from where it
   * is now: up makes the box taller whatever the draft, down shorter (the
   * draft scrolls inside). Double-click returns to automatic — the 40%
   * rule and the box sized to its text.
   */
  function handleDown(e: PointerEvent) {
    if (!ta) return;
    dragging = true;
    // Item 705 (option A, Console): with the hand-off card up, the one grip
    // sizes the card first — down to compact, then to its one line — and the
    // box only with what is left of the drag; up grows the card back first.
    const chat = app.activeSessionId;
    const start: CardSize | null = handoffCardUp ? cardSize(chat, "due") : null;
    const startH = ta.offsetHeight;
    let boxMoved = start === null;
    // The pointer half is `boxGrow.ts`'s since backlog 226 (the aside
    // boxes drag with it too); the handle is on the top edge.
    dragHeight(
      e,
      startH,
      "top",
      (h) => {
        if (start === null) return setHeight(h);
        const r = dragCard(start, startH - h);
        if (r.size !== cardSize(chat, "due")) setCardSize(chat, "due", r.size);
        if (r.rest !== 0 || boxMoved) {
          boxMoved = true;
          setHeight(startH - r.rest);
        }
      },
      () => {
        dragging = false;
        if (boxMoved) persistHeight();
      },
    );
  }

  function handleReset() {
    floorPx = null;
    capPx = null;
    sentSinceDrag.sized(key);
    persistHeight();
    autogrow();
  }

  /** One line of the box's text, for ⌥⌘↑ / ⌥⌘↓. */
  function lineHeight(): number {
    const el = boxElement(ta);
    const lh = el ? parseFloat(getComputedStyle(el).lineHeight) : NaN;
    return Number.isFinite(lh) && lh > 0 ? lh : 22;
  }

  /*
   * The format toggle (item 276): the box swaps between the textarea and
   * the formatted editor with the same draft, the caret where it was.
   */
  let formatCaret = $state<number | null>(null);
  function flipFormat(): void {
    formatCaret = ta ? ta.selectionEnd : null;
    toggleComposerFormat();
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      if (formatCaret !== null) ta.selectionStart = ta.selectionEnd = Math.min(formatCaret, ta.value.length);
      autogrow();
    });
  }

  /** Grow or shrink the box by a line from the keyboard (backlog 111). */
  function stepHeight(dir: 1 | -1) {
    if (!ta || floating) return;
    setHeight(ta.offsetHeight + dir * lineHeight());
    persistHeight();
  }

  // ~~The four image types … PDF is the only document type every vendor
  // agrees on; a .txt or .md needs no envelope, so widening this would buy
  // a second path to the same place.~~ Widened 2026-10-01 (nightshift item
  // 277, his ask): a class .pptx said "not supported" here and went
  // straight into claude.ai. The routes are `attachKinds.ts`; images and
  // PDFs go as before, text as text, office files as a PDF or their text,
  // anything else as a file for the Claude Code engine.

  // The caps moved to `attachFiles.svelte.ts` with the attach code (item 336).

  function autogrow() {
    if (!ta) return;
    const max = maxHeight();
    // The floor (backlog 111) is the docked box's; the floating one keeps
    // sizing to its text.
    const min = floating ? 0 : Math.min(max, sentSinceDrag.floor(key, floorPx) ?? 0);
    ta.style.maxHeight = max + "px";
    // Item 827: the formatted box's scroller measured with no bar (`settleScroller`).
    const scroller = ta instanceof LiveBoxHandle ? ta.scroller : null;
    const scrolled = scroller?.scrollTop ?? 0;
    if (scroller) scroller.style.overflowY = "hidden";
    // Item 469: the measure holds the composer's height (`measureHeld`),
    // so a key typed in a full box no longer scrolls the chat up.
    measureHeld(ta, root, (need) => growHeight(need, min, max) + "px");
    // Backlog 360: a pixel of rounding is not overflow (as the aside boxes).
    ta.style.overflowY = overflows(ta.scrollHeight, ta.clientHeight) ? "auto" : "hidden";
    settleScroller(scroller, scrolled);
    // Backlog 355: a switched-to draft's place, once its height is right.
    putScrollBack();
    // Item 469: a caret at the very end of a full box is at its foot. WebKit
    // left a caret on an empty last line one line under the edge (23 px).
    // Not while 355 holds a switched-to draft's place.
    if (
      ta instanceof HTMLTextAreaElement &&
      document.activeElement === ta &&
      !scrollHold.holds(key, performance.now()) &&
      caretAtEnd(ta.selectionStart, ta.selectionEnd, ta.value.length)
    )
      ta.scrollTop = ta.scrollHeight;
  }

  /*
   * Item 827 (his bug): the formatted box scrolls inside CodeMirror's
   * scroller, which backlog 360's rule in `autogrow` never reached. The
   * scroller kept `overflow-y: auto`, so at his 99% zoom a box sized to its
   * text (heights in whole pixels, its lines in fractions) overflowed by
   * under a pixel and showed the 10px bar; the text rewrapped round the bar,
   * a word at the edge dropped to a line scrolled out of view with the
   * caret, and the next measure took the bar away again — every few keys.
   * `autogrow` measures the scroller with no bar; here it gets one only for
   * a real overflow, and its place in the text is kept across the measure.
   */
  function settleScroller(scroller: HTMLElement | null, scrolled: number): void {
    if (!scroller) return;
    scroller.style.overflowY = overflows(scroller.scrollHeight, scroller.clientHeight) ? "auto" : "hidden";
    if (scroller.scrollTop !== scrolled) scroller.scrollTop = scrolled;
  }

  // A resized window moves the 40% line.
  $effect(() => {
    const onresize = () => autogrow();
    window.addEventListener("resize", onresize);
    // Item 849: and the window coming back to the front re-measures — a
    // hand-off made while he was away ran with the window behind others,
    // where WebKit holds animation frames, so the box is measured afresh
    // when he can see it rather than left at whatever it last read.
    const onback = () => {
      if (document.visibilityState === "visible") requestAnimationFrame(autogrow);
    };
    window.addEventListener("focus", onback);
    document.addEventListener("visibilitychange", onback);
    return () => {
      window.removeEventListener("resize", onresize);
      window.removeEventListener("focus", onback);
      document.removeEventListener("visibilitychange", onback);
    };
  });

  // A switched-to draft is a different height; the box is measured once
  // the new text is in it.
  $effect(() => {
    void key;
    void text;
    requestAnimationFrame(autogrow);
  });

  /*
   * The `/` picker (nightshift backlog 077, 2026-09-16): on the Claude
   * Code engine a message that starts with `/` opens a list over the
   * skills and slash commands the CLI reported at the chat's latest turn
   * (`app.agentInit`), filtered by what follows the slash; ↑↓ move, ↵ or
   * Tab insert `/name ` and close, Esc closes. The CLI runs a skill named
   * in the prompt, so the picker only inserts text — nothing runs until
   * Send. Nothing before the chat's first turn (the list is the CLI's, and
   * it has not reported yet) and nothing on the other engine.
   */
  const slashNames = $derived.by(() => {
    if (app.connection?.engine !== "claude-code" || !app.agentInit) return [];
    const skills = app.agentInit.skills;
    const rest = app.agentInit.slash_commands.filter((c) => !skills.includes(c));
    return [...skills.map((n) => ({ name: n, kind: "skill" })), ...rest.map((n) => ({ name: n, kind: "command" }))];
  });
  let slashDismissed = $state(false);
  let slashIndex = $state(0);
  /** Item 998: ↑/↓ moved the menu's row since the last keystroke (a pick, not the typed name). */
  let slashMoved = $state(false);
  /*
   * Item 800: saved message prompts join the list — on either engine and
   * before the first turn, since they are only text — wherever a `/word`
   * ends the box (its start, a line's start, or after a space), and come
   * first. Picking one puts its body in place of the `/word`, with
   * {clipboard}, {date} and {selection} filled and the first blank left
   * selected; Tab then steps through the blanks (⇧Tab back).
   */
  void loadSaved();
  watchSelection();
  const savedToken = $derived(saved.list.length ? slashToken(text, text.length) : null);
  const savedMatches = $derived(savedToken ? matching(saved.list, savedToken.query) : []);
  const wholeSlash = $derived(slashNames.length > 0 && /^\/[A-Za-z0-9_-]*$/.test(text));
  /*
   * Item 890 (his "like a /table or something"): the box's own inserts —
   * /table, /math, /code, /quote, /list, /numbered (`boxInserts.ts`) — in
   * the same list, on either engine, wherever a `/word` ends at the caret
   * (the box's start, a line's start, or after a space; never inside
   * `and/or` or a path). After the saved prompts, before the CLI's names;
   * a name both have shows both rows, each saying what it is.
   */
  /** null: not read yet (the end of the box); -1: a selection, no token. */
  let caretAt = $state<number | null>(null);
  const insTok = $derived(caretAt === -1 ? null : insertToken(text, caretAt === null || caretAt > text.length ? text.length : caretAt));
  /** Esc on a token keeps the list closed for that token (its start, and the text before it). */
  let insDismissed = $state<string | null>(null);
  const insSig = $derived(insTok ? `${insTok.start}:${text.slice(0, insTok.start)}` : null);
  $effect(() => {
    if (insSig === null && insDismissed !== null) untrack(() => (insDismissed = null));
  });
  const insMatches = $derived(insSig !== null && insSig === insDismissed ? [] : insertMatches(insTok));
  /*
   * Item 915: `/handoff` — the main chat's own command (not an aside's: an
   * aside has no hand-off), listed on either engine, before the CLI's names.
   * Sent alone it runs the hand-off-now path instead of going as text.
   * ~~Written here by hand~~ — item 966: every app command comes from one
   * table (`appCommands.ts`), each row `app · …`, the aside's box listing
   * those an aside has; a Claude Code name the app also has shows the app's
   * row alone (`taken` below).
   */
  const ownMatches = $derived(
    commandMatches(text, aside ? "aside" : "chat").map((c) => ({ name: c.name, kind: commandKind(c), args: c.args })),
  );
  const slashOpen = $derived((wholeSlash || savedMatches.length > 0 || insMatches.length > 0 || ownMatches.length > 0) && !slashDismissed);
  const slashMatches = $derived.by(() => {
    if (!slashOpen) return [];
    const none = { prompt: null as MessagePrompt | null, insert: null as BoxInsert | null, own: false, args: "" };
    const mine = savedMatches.map((p) => ({ name: p.name, kind: "saved prompt", ...none, prompt: p as MessagePrompt | null }));
    const ours = insMatches.map((i) => ({ name: i.name, kind: insertLabel(i, insTok), ...none, insert: i as BoxInsert | null }));
    const cmd = ownMatches.map((c) => ({ ...c, ...none, own: true }));
    if (!wholeSlash) return [...mine, ...ours, ...cmd];
    const q = text.slice(1).toLowerCase();
    const taken = new Set([...mine, ...cmd].map((m) => m.name.toLowerCase()));
    const theirs = slashNames
      .filter((s) => s.name.toLowerCase().startsWith(q) && !taken.has(s.name.toLowerCase()))
      .map((s) => ({ ...s, ...none }));
    // ~~.slice(0, 12)~~ — item 966: nine app rows and six inserts on a bare
    // `/` left Claude Code's own names no room; the list scrolls (16rem).
    // ~~.slice(0, 24)~~ — item 967: 23 app rows now; 48 keeps room for
    // Claude Code's names under them.
    return [...mine, ...ours, ...cmd, ...theirs].slice(0, 48);
  });
  /** Put an insert in place of its token, one undo step; a table goes in
   *  through the grid editor (the box a table is drawn in), its first cell
   *  focused, so ⌘Z takes the whole table back out. */
  async function pickInsert(ins: BoxInsert): Promise<void> {
    const tok = insTok;
    if (!tok || !ta) return;
    const ed = insertEdit(text, tok, ins);
    slashDismissed = true;
    if (ed.tableAt !== undefined && !(ta instanceof LiveBoxHandle)) {
      formatCaret = tok.end;
      gridKey = key;
      await tick();
    }
    if (ta instanceof LiveBoxHandle) {
      ta.insertBlock(ed);
      autogrow();
      return;
    }
    ta.focus();
    applyBoxEdit(ed);
  }
  const savedShown = $derived(slashMatches.some((m) => m.prompt));
  const insertShown = $derived(slashMatches.some((m) => m.insert));
  /** A saved prompt went in and its blanks are Tab's until the box empties. */
  let blanksLive = $state(false);
  $effect(() => {
    if (!text) blanksLive = false;
  });
  /** Select `[start, end]` in whichever box is showing. */
  function selectIn(start: number, end: number): void {
    if (!ta) return;
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = end;
  }
  async function pickSaved(p: MessagePrompt): Promise<void> {
    const token = savedToken;
    if (!token) return;
    const before = text;
    const body = await filledBody(p);
    // He typed on while the clipboard was read: the token moved; leave it.
    if (text !== before) return;
    const put = insertAt(text, token, body);
    setDraftText(key, put.text);
    slashDismissed = true;
    blanksLive = nextBlank(put.text, 0, 0) !== null;
    await tick();
    selectIn(put.select.start, put.select.end);
    autogrow();
  }
  $effect(() => {
    // A fresh box (no leading slash) re-arms the picker; typing resets the row.
    void text;
    if (!/^\//.test(text)) slashDismissed = false;
    slashIndex = 0;
    slashMoved = false;
  });
  function pickSlash(name: string, prompt: MessagePrompt | null = null, insert: BoxInsert | null = null): void {
    if (insert) {
      void pickInsert(insert);
      return;
    }
    if (prompt) {
      void pickSaved(prompt);
      return;
    }
    setDraftText(key, `/${name} `);
    slashDismissed = true;
    ta?.focus();
  }

  /*
   * The context-full hand-off (nightshift backlog 086; pass 2 per blocker
   * 120), said where the next message is typed. Past the chat's mark the
   * notice shows the fill, a field that raises the mark for this chat, the
   * wrap-up message editable for this chat, **Wrap up now** and **Stay
   * here**; ~~the wrap-up rides the next message~~ — it is its own message
   * now. ~~Once its turn ends the bar offers *Continue in a new chat · Stay
   * here*~~ — item 506: the reply's next-chat card carries the way on; the
   * composer speaks only when the reply wrote no prompt. Only for
   * the chat the state is about, and only on the Claude Code engine, which
   * is the one that fills.
   */
  // Item 702 (his ask, 2026-11-15): a chat already handed off says so here,
  // on its own page, instead of a red "past hand-off" on its sidebar row.
  const handedNext = $derived(
    !aside && app.activeSessionId ? handoffChildren(app.sessions ?? []).get(app.activeSessionId) ?? null : null,
  );
  const handoffHere = $derived(
    composerShows("handoff", !!aside) &&
      app.connection?.engine === "claude-code" &&
      handoff.chat === app.activeSessionId &&
      handoff.chat !== null,
  );
  const handoffPct = $derived(Math.round(handoff.fill * 100));
  // Backlog 383: after *Stay here* the card can come back before the re-ask mark.
  // Under handoffHere's own conditions too (review 2026-10-18): on an
  // engine that shows no card, the button would reopen nothing.
  const handoffStayed = $derived(handoffHere && !aside && handoff.stage === "idle" && handoff.dismissedAt > 0);
  // Backlog 436: the mark the notice is compared to — the chat's own
  // percent, else the Settings percent or the 300k cap, whichever is first.
  const handoffThresholdPct = $derived(Math.round(mark(app.activeSessionId, handoff.limit) * 100));
  /** The mark in tokens, for the heading; 0 with no window known. */
  const handoffMarkTokens = $derived(handoff.limit ? Math.round(mark(app.activeSessionId, handoff.limit) * handoff.limit) : 0);
  /** The default's rule in words, for the field's note. */
  const handoffDefaultRule = $derived(
    cap() > 0 ? `${Math.round(threshold(null) * 100)}% or ${fmtTokens(cap())}, whichever comes first` : `${Math.round(threshold(null) * 100)}%`,
  );
  const reAskPct = Math.round(RE_ASK * 100);
  /*
   * The research thread (nightshift backlog 271): the open chat's binding,
   * read from its log, is noted for the hand-off so the wrap-up and the
   * read order follow it; when the notice comes up, a dry-run upkeep puts
   * the thread's flags into the wrap-up.
   */
  const boundThread = $derived(chatThread(app.events));
  // The chat's composer only (283): an aside's has no hand-off.
  $effect(() => {
    if (aside) return;
    const [chat, slug] = [app.activeSessionId, boundThread];
    untrack(() => noteThread(chat, slug));
  });
  $effect(() => {
    if (aside) return;
    if (handoff.stage === "due" && boundThread) untrack(() => void refreshThreadFlags(boundThread));
  });
  /** Whether the hand-off writes the thread's files rather than HANDOFF.md. */
  const threadHandoff = $derived(threadFor(app.activeSessionId) !== null);
  /*
   * Backlog 431 (blocker 1567): whether the chat's project is a code
   * project — a HANDOFF.md or a backlog/ at its top — so a thread chat's
   * wrap-up also writes a STATE section and commits. Probed when the chat
   * or the project changes, and again when the notice comes up (the first
   * wrap-up may have made HANDOFF.md since). Best-effort: no answer is
   * "not a code project", today's thread wrap-up.
   */
  const projectRoot = $derived(app.project?.root ?? null);
  function probeCodeProject(chat: string | null, root: string | null): void {
    if (!chat) return;
    if (!root) {
      noteCodeProject(chat, false);
      return;
    }
    namedFiles(codeProbePaths(root)).then(
      (found) => noteCodeProject(chat, found.some((f) => f !== null)),
      () => noteCodeProject(chat, false),
    );
  }
  $effect(() => {
    if (aside) return;
    const [chat, root] = [app.activeSessionId, projectRoot];
    untrack(() => probeCodeProject(chat, root));
  });
  $effect(() => {
    if (aside) return;
    if (handoff.stage === "due") untrack(() => probeCodeProject(app.activeSessionId, projectRoot));
  });
  /** A thread chat in a code project also writes HANDOFF.md (blocker 1568). */
  const threadAndHandoff = $derived(threadHandoff && codeProjectFor(app.activeSessionId));
  /** Item 1007: the project keeps a HANDOFF.md or a backlog/, so the built-in wrap-up writes one; elsewhere it names neither.
   *  ~~codeProjectFor~~ — item 1025: every chat's wrap-up writes one now but a thread chat in a project that keeps none. */
  const codeHere = $derived(writesHandoffFile(app.activeSessionId));
  /** The wrap-up this chat would send: its own edit, else its thread's, else the Settings default. */
  const wrapUpText = $derived(message(app.activeSessionId));
  /** The read order this chat's continuation opens with (backlog 193). */
  /** The wrap-up Nightloom queued while he was away is still in the queue. */
  const wrapUpQueued = $derived(handoff.queuedId !== 0 && queue.some((q) => q.id === handoff.queuedId));
  // Item 705 (option A, Console): the notice is up, and at which of its three sizes.
  const handoffCardUp = $derived(!handedNext && handoffHere && handoff.stage === "due" && !busy);
  // Item 912: while the card is up, a check every minute whether he has
  // left the Mac — the turn's end was the only moment it was asked.
  $effect(() => {
    if (aside) return;
    void handoffCardUp;
    untrack(() => armAwayCheck());
  });
  const handoffSize = $derived(cardSize(app.activeSessionId, "due"));
  const nextLabel = $derived(nextModelLabel(app.activeSessionId));
  /** The − / + of the mark's stepper: by 5, to the nearest 5. */
  function stepMark(dir: 1 | -1): void {
    setChatThreshold(String(steppedMark(handoffThresholdPct, dir)));
  }

  /** **Wrap up now**: the message as it stands, as a turn of its own.
   *  Item 915: the path is `manualHandoff.svelte.ts`'s, shared with the
   *  right panel's *Hand off now* and `/handoff`; only the send is ours. */
  async function sendWrapUpNow(from: Element | null = null): Promise<void> {
    wrapSending = from !== null;
    try {
      await handOffNow((t) => dispatch(t, [], true), from);
    } finally {
      wrapSending = false;
    }
  }
  /** Item 926: Wrap up now's Send look — the edge trace from the click
   *  until the wrap-up's turn starts (Send's item 606), the scan on hover
   *  and the charge on the press (`.fil-go`, composerControls.css). */
  let wrapSending = $state(false);
  $effect(() => {
    if (app.busy) wrapSending = false;
  });

  /** The per-chat mark on the notice: raising it above the fill puts the notice away. */
  function setChatThreshold(v: string): void {
    // Item 705 review: an emptied box is no number (`Number("")` is 0, which
    // set the mark to 1%); it changes nothing.
    const pct = typedMark(v);
    if (pct === null) return;
    setThreshold(app.activeSessionId, pct / 100);
    reconsider(app.activeSessionId);
  }
  /** Item 705 review: the typed mark, then the box shows the mark as kept —
   *  a value clamped (150 → 100), rounded or refused (empty) would otherwise
   *  stay typed in the box while the mark is something else. */
  function typeMark(input: HTMLInputElement): void {
    setChatThreshold(input.value);
    input.value = String(handoffThresholdPct);
  }

  /*
   * The fill is read mid-turn too — the CLI reports usage after each of
   * its own requests within a turn — so a crossing while he is away can
   * put the wrap-up in the queue while the turn still runs, where it
   * shows with its × and goes when the turn ends. The turn's end reads it
   * again from `state.svelte.ts`.
   */
  $effect(() => {
    if (aside || !app.busy || app.connection?.engine !== "claude-code" || !app.activeSessionId) return;
    const used = contextUsed();
    const limit = app.connection?.contextLimit ?? null;
    if (used == null || !limit) return;
    const chat = app.activeSessionId;
    // Untracked: the reading writes the stage it also reads.
    untrack(() => noteFill(chat, used, limit, awayNow()));
  });
  /*
   * Item 914: the open chat, idle, takes its card back from whichever chat
   * the last reading was about (another chat's turn end, or none since a
   * relaunch). Read from the log; never queues, never lowers the stage.
   */
  $effect(() => {
    if (aside || app.busy || app.connection?.engine !== "claude-code" || !app.activeSessionId) return;
    if (handoff.chat === app.activeSessionId) return;
    const chat = app.activeSessionId;
    const used = contextUsed();
    const limit = app.connection?.contextLimit ?? null;
    const events = app.events;
    untrack(() => noteShown(chat, used, limit, events));
  });

  /*
   * The ghost line (nightshift backlog 083): the CLI's predicted next
   * prompt, dimmed in the empty box; Tab puts it in the box, Esc drops
   * it, typing hides it. Never sent on its own.
   */
  // The chat's predicted next prompt; not an aside's (283).
  const ghost = $derived(composerShows("ghost", !!aside) ? ghostFor(app.suggestion, text) : null);
  function acceptGhost(): void {
    if (!ghost) return;
    setDraftText(key, ghost);
    app.suggestion = null;
    ta?.focus();
  }

  /*
   * Item 456: maths typed as text (`s^2`, "s squared") offered back as
   * LaTeX in a bar above the box, after a typing pause. Never applied
   * unasked: "Use maths" or Tab wraps the formulas as `$…$` in one undo
   * step, × or Esc declines and that text is not offered again in this
   * draft (`typedMathPrefs.svelte.ts`). The rules: `typedMath.ts`.
   */
  const MATH_PAUSE_MS = 600;
  /** Item 687: a paste this long is not scanned for typed maths. */
  const PASTE_NO_MATH = 200;
  let mathSpans = $state<TypedMathSpan[]>([]);
  let mathTimer: ReturnType<typeof setTimeout> | null = null;
  let mathKey = untrack(() => key);
  /** Item 687: the text the offers' offsets are into, so an edit moves them. */
  let mathPrev = "";
  $effect(() => {
    const t = text;
    const k = key;
    const on = typedMathPrefs.on;
    untrack(() => scheduleMath(t, k, on));
  });
  $effect(() => () => {
    if (mathTimer) clearTimeout(mathTimer);
  });
  /** Per keystroke: drop offers whose text moved, restart the pause. */
  function scheduleMath(t: string, k: string, on: boolean): void {
    if (mathTimer) clearTimeout(mathTimer);
    mathTimer = null;
    if (k !== mathKey) {
      mathKey = k;
      mathSpans = [];
    }
    if (!on || !t) {
      if (mathSpans.length) mathSpans = [];
      // A sent or emptied draft is a new draft: what was declined may be offered again.
      if (!t) clearDenied(k);
      return;
    }
    // Item 687: moved with the edit, not dropped — typing above a formula
    // no longer hides the bar until the pause (the page jumped per key).
    if (mathSpans.length) {
      const moved = rebaseTypedMath(mathPrev, t, mathSpans);
      if (moved !== mathSpans) mathSpans = moved;
    }
    mathPrev = t;
    mathTimer = setTimeout(findMathNow, MATH_PAUSE_MS);
  }
  function findMathNow(): void {
    mathTimer = null;
    // Not under an open input-method composition: its text is not his yet.
    if (composing) {
      mathTimer = setTimeout(findMathNow, MATH_PAUSE_MS);
      return;
    }
    const d = deniedFor(key);
    mathPrev = text;
    mathSpans = findTypedMath(text).filter((s) => !d.has(s.src));
  }
  /** Wrap `one` (or every offered formula) as `$…$` (`$$…$$` for a whole line): one undo step. */
  function acceptMath(one: TypedMathSpan | null): void {
    if (!ta) return;
    const t = text;
    const offered = one ? [one] : mathSpans;
    // Found again on the text as it stands, so the offsets are current.
    // Item 490: one chip stands for every occurrence of its formula, so
    // accepting it wraps them all (keeping one already keeps them all).
    const chosen = findTypedMath(t).filter((s) => offered.some((o) => o.src === s.src && o.tex === s.tex));
    if (chosen.length === 0) {
      mathSpans = [];
      return;
    }
    let next: string;
    if (ta instanceof LiveBoxHandle) {
      ta.replaceRanges(chosen.map((s) => ({ from: s.from, to: s.to, insert: wrapTypedMath(s) })));
      next = ta.value;
    } else {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const r = applyTypedMath(t, chosen, end);
      next = r.text;
      hist.select(start, end);
      hist.external(r.text, r.caret);
      setDraftText(key, r.text);
      void tick().then(() => {
        if (!(ta instanceof HTMLTextAreaElement)) return;
        ta.selectionStart = ta.selectionEnd = r.caret;
        autogrow();
      });
    }
    const d = deniedFor(key);
    mathPrev = next;
    mathSpans = findTypedMath(next).filter((s) => !d.has(s.src));
    ta.focus();
  }
  /** Keep `one` (or every offered formula) as typed, for this draft. */
  function denyMath(one: TypedMathSpan | null): void {
    const srcs = (one ? [one] : mathSpans).map((s) => s.src);
    denyTypedMath(key, srcs);
    mathSpans = mathSpans.filter((s) => !srcs.includes(s.src));
    ta?.focus();
  }

  /*
   * The in-app clipboard history (nightshift backlog 173): ⌘⇧V (Ctrl+Shift+V
   * elsewhere) opens the ring over the box — what was copied, pasted or
   * sent in Nightloom, newest first (`clipRing.svelte.ts`). ↑↓ move, ↵ or a
   * click pastes — a text at the caret, an image as a chip again — and Esc
   * or a second ⌘⇧V closes. Picking is not a use: the ring's order stays.
   */
  let clipOpen = $state(false);
  let clipIndex = $state(0);
  $effect(() => {
    void key;
    clipOpen = false;
  });
  function pickClip(i: number): void {
    const c = clips.ring[i];
    clipOpen = false;
    if (!c) return;
    if (c.kind === "image") {
      const chip: Attachment = { id: nextAttachmentId(), kind: "image", name: c.name, media_type: c.media_type, data: c.data };
      addAttachment(key, chip);
      markAttached(key, [chip]);
      ta?.focus();
      return;
    }
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? start;
    setDraftText(key, text.slice(0, start) + c.text + text.slice(end));
    const caret = start + c.text.length;
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = caret;
      autogrow();
    });
  }

  /*
   * Reply to a highlighted passage (nightshift backlog 215): the
   * transcript's pill asks (`requestReply`), and the passage goes in here
   * as a `> ` quote block at the caret, the caret on the line after it
   * (`insertQuote`). It is text in the draft, not a chip, so it sits
   * where he placed it, stacks with others and is kept like any draft.
   */
  $effect(() => {
    void replyRequest.seq;
    // ~~Reply is to the chat (283): an aside's box must not take the quote.~~
    // Item 481 (2026-10-29): a Reply in an aside's thread is for that
    // aside's box; each box takes only the quotes meant for it.
    const passage = untrack(() => takeReply(aside ? key : null));
    if (passage === null) return;
    untrack(() => {
      const start = ta?.selectionStart ?? text.length;
      const end = ta?.selectionEnd ?? start;
      const r = insertQuote(text, start, end, passage);
      setDraftText(key, r.text);
      void tick().then(() => {
        if (!ta) return;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = r.caret;
        autogrow();
      });
    });
  });

  // A rewind put his message back in the box (backlog 247): the caret
  // goes to its end, ready to change and send again.
  // Only a request made while mounted: a box opened later must not jump.
  let focusSeen = untrack(() => composerFocus.seq);
  $effect(() => {
    const seq = composerFocus.seq;
    // Item 674's follow-up: a request naming a box goes to that box (an
    // aside's bubble's Edit); one naming none to the chat's, as before.
    const wanted = composerFocus.key;
    if (seq === focusSeen || (wanted === undefined ? !!aside : wanted !== key)) return;
    focusSeen = seq;
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      autogrow();
    });
  });

  /*
   * The caret, per draft key, and the focus when a chat arrives (nightshift
   * backlog 290; the logic is `composerCaret.ts`). The caret is kept in the
   * drafts store beside the text as he moves it, and once more just before
   * the key changes (`$effect.pre` runs while the box still shows the old
   * draft). A key arriving — this box mounting, a chat switch, a new chat,
   * Ctrl+Tab, Continue — puts its caret back and takes the focus, unless
   * another field, a modal, a menu or the find bar has it.
   */
  let root = $state<HTMLDivElement | null>(null);
  /** The chat's box and an aside tab's take the focus; a floating card's does not. */
  const wantsFocus = $derived(takeFocus ?? aside === null);
  const keeper = new CaretKeeper({ get: draftSelection, set: setDraftSelection });
  let shownKey: string | null = null;
  /** The box's text just before the key changed. */
  let valueBefore: string | null = null;
  /** A pointer press inside the box just now: its focus is the click's. */
  let pointerDown = false;
  function recordCaret(): void {
    keeper.record(key, ta, text);
    // Item 890: the caret the slash inserts' token ends at (none for a selection).
    caretAt = ta && ta.selectionStart === ta.selectionEnd ? ta.selectionEnd : -1;
  }
  /*
   * Backlog 355: a draft taller than its box keeps its scroll place. The
   * box's scrollTop is kept in the drafts store beside the caret
   * (`Draft.scroll`) as it scrolls, and once more just before the key
   * changes; a key arriving holds its place (`ScrollHold`) until the box
   * has settled — put back after every re-measure (`autogrow`), the
   * browser's own scrolls meanwhile not recorded. With nothing kept (a
   * draft from before this), the kept caret is scrolled into view instead.
   */
  const scrollHold = new ScrollHold(1500);
  function recordScroll(): void {
    if (!ta || ta.value !== text || scrollHold.holds(key, performance.now())) return;
    setDraftScroll(key, ta.scrollTop);
  }
  function putScrollBack(): void {
    if (!ta || !scrollHold.holds(key, performance.now())) return;
    const top = draftScroll(key);
    if (top !== null) {
      ta.scrollTop = top;
      return;
    }
    const sel = clampSel(draftSelection(key), ta.value.length);
    if (!sel) return;
    if (ta instanceof LiveBoxHandle) ta.revealAt(sel.end);
    else if (sel.end === ta.value.length) ta.scrollTop = ta.scrollHeight;
  }
  $effect.pre(() => {
    const k = key;
    untrack(() => {
      if (shownKey !== null && shownKey !== k) {
        valueBefore = ta?.value ?? null;
        keeper.record(shownKey, ta, readDraft(shownKey).text);
        if (ta && ta.value === readDraft(shownKey).text && !scrollHold.holds(shownKey, performance.now()))
          setDraftScroll(shownKey, ta.scrollTop);
      }
    });
  });
  $effect(() => {
    const k = key;
    untrack(() => {
      if (shownKey === k) return;
      shownKey = k;
      keeper.arrive(k);
      scrollHold.start(k, performance.now());
      void tick().then(() => {
        if (key !== k || !ta || typeof document === "undefined") return;
        const box = boxElement(ta);
        const had = !!box && !!document.activeElement && box.contains(document.activeElement);
        // Typing on through the switch (the first send's draft moving to
        // the chat it made): the caret is his already.
        if (had && valueBefore !== null && valueBefore === ta.value) keeper.settle(k);
        valueBefore = null;
        if (had || (wantsFocus && !ta.closest("[inert]") && mayAutoFocus(document as never, root))) {
          keeper.focus(k, ta, had, false);
          autogrow();
        }
        putScrollBack();
      });
    });
  });
  // ⌘L (backlog 290): ~~the chat's box — or an aside tab's, when no chat
  // box is drawn; never a floating aside card's~~ — item 853: the box
  // meant, as typing picks it (`composerTarget`): a card he is in or last
  // pressed on, else the focused pane's box (an aside tab's in front), else
  // the chat's. Every box mounted keeps the window's type-to-focus, Enter
  // and ⌘V listeners on, an aside's too.
  $effect(() => untrack(() => (aside ? boxMounted() : chatBoxMounted())));
  let summonSeen = untrack(() => composerSummon.seq);
  $effect(() => {
    const seq = composerSummon.seq;
    if (seq === summonSeen) return;
    summonSeen = seq;
    if (!untrack(() => isSummonTarget(root))) return;
    untrack(() => {
      if (!ta) return;
      const box = boxElement(ta);
      const had = !!box && !!document.activeElement && box.contains(document.activeElement);
      keeper.focus(key, ta, had, true);
      autogrow();
    });
  });

  /*
   * Backlog 365: the box locks only with no connection and none coming —
   * a connect in flight (a chat switch to the other engine's chat) leaves
   * it typeable, Send waiting (`sendHeld`). A lock still takes the focus
   * from a textarea in WebKit, silently, and the unlock does not give it
   * back: the box takes it back here with the kept caret, when the focus is
   * still nowhere (`boxLock.ts`).
   */
  const boxIsLocked = $derived(boxLocked(!!app.connection, app.connecting));
  // Item 456: the typed-maths bar shows only when no other offer owns the keys.
  const mathShown = $derived(
    typedMathPrefs.on && mathSpans.length > 0 && !slashOpen && !ghost && !boxIsLocked && !clipOpen,
  );
  const lockFocus = new FocusThroughLock();
  let wasLocked = untrack(() => boxIsLocked);
  $effect.pre(() => {
    const l = boxIsLocked;
    untrack(() => {
      if (!l || wasLocked || typeof document === "undefined") return;
      const box = boxElement(ta);
      lockFocus.locking(!!box && !!document.activeElement && box.contains(document.activeElement));
    });
  });
  $effect(() => {
    const l = boxIsLocked;
    untrack(() => {
      const was = wasLocked;
      wasLocked = l;
      if (l || !was || !ta || typeof document === "undefined") return;
      const a = document.activeElement;
      if (lockFocus.unlocked(!a || a === document.body || a === document.documentElement)) {
        keeper.focus(key, ta, false, true);
        autogrow();
      }
    });
  });

  /*
   * ⌘V with nothing to type in (backlog 351, `pasteToCompose.ts`): the
   * chat's box takes the focus with its kept caret, as ⌘L gives it, and the
   * paste is then the box's own — AppKit's `paste:` into the focused box
   * (the same call as ⌥⌘V), so `onpaste` sees a real paste event. A paste
   * event that reached the window with nothing to paste into is handed to
   * `onpaste` during its dispatch; plain text, which `onpaste` leaves to the
   * browser, goes in at the caret as one paste.
   */
  // Item 853: every box, an aside's too — `pasteToCompose.ts` asks the one meant.
  $effect(() => {
    const el = root;
    if (!el) return;
    return registerPasteHandler(el, pasteFromOutside);
  });
  function pasteFromOutside(req: PasteRequest): void {
    if (!ta) return;
    const box = boxElement(ta);
    const had = !!box && !!document.activeElement && box.contains(document.activeElement);
    keeper.focus(key, ta, had, true);
    scrollHold.release();
    if ("event" in req) {
      const e = req.event;
      onpaste(e);
      if (e.defaultPrevented) return;
      const t = e.clipboardData?.getData("text/plain") ?? "";
      if (!t) return;
      e.preventDefault();
      pasteMath(normalizeNewlines(t));
      return;
    }
    if (req.kind === "attach") {
      clipOpen = false;
      void pasteAsAttachment();
      return;
    }
    void pasteByKey();
  }
  async function pasteByKey(): Promise<void> {
    let asked = false;
    try {
      asked = await pasteIntoFocus();
    } catch {
      asked = false;
    }
    if (asked) return;
    // Off the Mac (no `paste:` to send): the clipboard's text, read here,
    // goes in as a plain paste would, with the long-paste offer.
    try {
      const t = await navigator.clipboard.readText();
      if (!t || !ta) return;
      const at = Math.min(ta.selectionStart, ta.selectionEnd);
      pasteMath(normalizeNewlines(t));
      offer = longPasteOffer(t, at);
      converted = null;
    } catch (e) {
      addToast(`Could not read the clipboard: ${String(e)}`);
    }
  }

  // Item 223 / 315: quote lines and fenced code drawn in a layer behind
  // the textarea (`BoxLayer`), while the draft has either.
  const layered = $derived(layerShown(text));
  /*
   * Item 689 (blocker 1993, his "I think grid makes more sense no?"): a
   * Markdown table in the box is drawn as a grid of cells to type in. The
   * grid is the formatted box's (`tableGrid.ts`), so with the Format switch
   * off the box is that editor drawing only the grid, quotes and code — the
   * text round them plain — while the draft holds a table, and stays it for
   * this chat once it came on (`gridKey`), so ⌘Z after deleting the table
   * still has the box's history. The text is the Markdown either way.
   */
  let gridKey = $state<string | null>(null);
  const gridBox = $derived(!composerFormat.on && (gridKey === key || hasTable(text)));
  $effect(() => {
    const k = key;
    untrack(() => {
      if (gridKey !== null && gridKey !== k) gridKey = null;
    });
  });
  $effect(() => {
    if (gridBox && gridKey !== key) untrack(() => (gridKey = key));
  });

  function onkeydown(e: KeyboardEvent) {
    // ⌥⌘V: paste the clipboard's text as an attachment (item 284).
    if (isPasteAsAttachmentKey(e)) {
      e.preventDefault();
      clipOpen = false;
      void pasteAsAttachment();
      return;
    }
    // ⌘Z right after "Make this an attachment" puts the text back (off the
    // Mac; there the Edit menu's Undo arrives through `menuInterceptors`).
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && undoable) {
      e.preventDefault();
      undoConvert();
      return;
    }
    // Blocker 1210: ⌘Z, ⌘⇧Z and ⌘Y in the box are the box's own history,
    // never WebKit's (see `boxHistory.ts`). Stopped here so the window's
    // ⌘⇧Z (`App.svelte`) does not redo a second time.
    const step = boxHistoryKey(e);
    if (step && boxStep(step)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Item 322: a key the input method holds (Enter committing Japanese or
    // Chinese entry, the accent popup) is the input method's — never a
    // send, a menu pick or a dismissal. The Enter after the commit sends.
    if (isImeKey(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.code === "KeyV" || e.key.toLowerCase() === "v")) {
      e.preventDefault();
      clipOpen = !clipOpen;
      clipIndex = 0;
      return;
    }
    if (clipOpen) {
      const n = clips.ring.length;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clipOpen = false;
        return;
      }
      if (n > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        clipIndex = (clipIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (n > 0) pickClip(clipIndex);
        else clipOpen = false;
        return;
      }
      // Anything else types as usual and closes the list.
      clipOpen = false;
    }
    // Item 648: inside a ``` block the keys are a code editor's — Enter a
    // new line at the indentation (not a send; ⌘Enter sends), Tab /
    // Shift+Tab indent, brackets close (`codeBlockKeys.ts`). Before the
    // maths offer's Tab: inside a block Tab indents. Outside a block
    // `codeBlockEdit` takes nothing and every key below is as it was.
    if (ta && !boxIsLocked) {
      const ed = codeBlockEdit(ta.value, ta.selectionStart, ta.selectionEnd, e);
      if (ed) {
        e.preventDefault();
        applyBoxEdit(ed);
        return;
      }
    }
    // ⌥⌘↑ / ⌥⌘↓ (⌥Ctrl elsewhere) make the box a line taller or shorter
    // (backlog 111) — the keyboard's version of the handle. Before the
    // picker's own arrows, which are the bare keys. Free: `App.svelte`'s
    // handler steps aside for every ⌥ chord, the transcript's ⌥↑ / ⌥↓ have
    // no ⌘, and blocker 035's set names neither.
    if (e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepHeight(e.key === "ArrowUp" ? 1 : -1);
      return;
    }
    // Item 456: Tab takes the typed-maths offer, Esc declines it. Tab is
    // free here: the ghost line shows only in an empty box and the slash
    // list only on a leading "/", and the bar hides for both.
    if (mathShown && e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      acceptMath(null);
      return;
    }
    if (mathShown && e.key === "Escape" && !composing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      denyMath(null);
      return;
    }
    if (ghost && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (ghost && e.key === "Escape") {
      e.preventDefault();
      app.suggestion = null;
      return;
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        slashMoved = true;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        slashMoved = true;
        return;
      }
      // Item 890: never while an input method is composing (its Enter is the IME's).
      const imeKey = composing || e.isComposing || e.keyCode === 229;
      // Item 998: a command's name typed in full (`/model`, `/keepwarm`) runs
      // on this one Return, as Send would run it — unless ↑/↓ moved to
      // another row, which Return then picks (blocker 2293). Tab still
      // completes. Stopped here so no window key handler (⌘P's list, which
      // `/project` opens in this same keydown) takes the Return as its own.
      const full = !imeKey && e.key === "Enter" && !e.shiftKey ? typedInFull(text, aside ? "aside" : "chat") : null;
      const sel = slashMatches[slashIndex];
      if (full && (!slashMoved || (sel?.own && sel.name === full.name))) {
        e.preventDefault();
        e.stopPropagation();
        slashDismissed = true;
        void submit();
        return;
      }
      if (!imeKey && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex].name, slashMatches[slashIndex].prompt, slashMatches[slashIndex].insert);
        return;
      }
      if (!imeKey && e.key === "Escape") {
        e.preventDefault();
        slashDismissed = true;
        insDismissed = insSig;
        return;
      }
    }
    // Item 800: a saved prompt's blanks — Tab selects the next, ⇧Tab the
    // one before; with none left Tab is the box's own again.
    if (blanksLive && e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && ta) {
      const b = nextBlank(ta.value, ta.selectionStart, ta.selectionEnd, e.shiftKey);
      if (b) {
        e.preventDefault();
        selectIn(b.start, b.end);
        return;
      }
      blanksLive = false;
    }
    // Item 318: Esc while the long-paste offer is up dismisses it; the
    // paste stays in the box as text.
    // Not an Esc the input method takes to cancel a composition (review).
    if (e.key === "Escape" && offer && offer.after !== null && !composing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      dismissOffer();
      return;
    }
    // Item 694: Esc in an empty box drops the held passage; the aside
    // chord (⌘⇧A, the pill's) asks about it from the box.
    if (held && e.key === "Escape" && !text && !composing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      dropHeld(key);
      return;
    }
    if (held && (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyA") {
      e.preventDefault();
      e.stopPropagation();
      if (text.trim() || attachments.length > 0) void submitAside();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Item 997: the Return that runs an app command is the box's alone.
      // `/project` opens ⌘P's list inside this keydown; the list's own
      // window handler then took this same Return as "open the first
      // project" (Home, its Morning-scan chat) — or, from Home, nothing.
      if (parseCommand(text, aside ? "aside" : "chat")) e.stopPropagation();
      void submit();
    } else if (e.key === "ArrowUp" && !text && queue.length > 0) {
      // The CLI's rule: Up in an empty input takes the newest held
      // message back. With text in the box, Up is the caret's.
      e.preventDefault();
      void takeBack();
    }
  }

  // The file-to-chip code (readBase64 … accept's body, the conversions in
  // flight) moved unchanged to `attachFiles.svelte.ts` (item 336), so that
  // a message's edit box attaches exactly as this box does.

  /** Wait for this box's conversions, if any; `false` if a send should not
   *  go (another wait is already running). */
  let waitingForConversion = $state(false);
  async function conversionsDone(chatKey: string): Promise<boolean> {
    const jobs = conversionJobs(chatKey);
    if (jobs.length === 0) return true;
    if (waitingForConversion) return false;
    waitingForConversion = true;
    const names = readDraft(chatKey).attachments.filter((a) => a.pending).map((a) => a.name);
    addToast(`Converting ${names.join(", ")} — the message sends when ${names.length === 1 ? "it is" : "they are"} ready`);
    try {
      await Promise.all(jobs);
    } finally {
      waitingForConversion = false;
    }
    return true;
  }

  /** Attach what can be attached; the chips made, for the paste to record. */
  async function accept(files: Iterable<File>): Promise<Attachment[]> {
    // Under the key of the moment the file was dropped: a read can
    // outlive a chat switch, and the chip belongs where it was pasted.
    const chatKey = key;
    const chips = await acceptFiles(chatKey, files);
    markAttached(chatKey, chips);
    return chips;
  }

  /*
   * Item 458: attaching and removing a chip are steps of the box's history
   * (`chipSteps.ts`), so ⌘Z takes back an attach or a remove and ⌘⇧Z
   * redoes it, in order with the text's steps (456's maths accept and
   * 284's conversion among them). Only in the box the chip landed in, and
   * only while that chat is the open one: its history is the one ⌘Z walks.
   */
  function markAttached(chatKey: string, chips: Attachment[]): void {
    if (chatKey !== key) return;
    for (const c of chips) {
      const i = attachments.findIndex((a) => a.id === c.id);
      if (i >= 0) hist.mark({ chipStep: "add", chip: $state.snapshot(attachments[i]) as Attachment, index: i });
    }
  }

  function onpaste(e: ClipboardEvent) {
    // Item 814: a paste never brings the passage chip with it.
    if (held) dropHeldOnPaste(key);
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    const files = Array.from(e.clipboardData?.files ?? []);
    // Item 348: math copied from a web page (KaTeX, MathJax) comes as its
    // LaTeX in `$…$`, read from the clipboard's HTML; null for any other
    // paste, which goes on below unchanged.
    const html = files.length === 0 ? (e.clipboardData?.getData("text/html") ?? "") : "";
    // Item 382: text copied with images in it — the images' places marked
    // `[image N]` in the text, each image a chip (pasteImages.ts). N counts
    // on from the images already in the box: the model sees a turn's images
    // in chip order, after its text.
    const asAttachment = takeAttachMark();
    const firstImage = readDraft(key).attachments.filter((a) => a.kind === "image").length + 1;
    const withImages = files.length === 0 && !asAttachment ? htmlImagePaste(html, firstImage) : null;
    // Item 399: math and code read by the one plan the edit box shares.
    const caret = Math.min(ta?.selectionStart ?? text.length, ta?.selectionEnd ?? text.length);
    const plan = withImages ? null : textPastePlan({ plain: pastedText, html, fileCount: files.length, text, caret });
    const math = plan?.kind === "math" ? plan.text : null;
    // Into the in-app clipboard ring (backlog 173): the text, and below
    // each image the paste attached.
    if (pastedText && !(withImages && ta)) recordText("pasted", math ?? pastedText);
    // Item 284: ⌥⌘V's paste puts the text in as an attachment. A clipboard
    // holding a file (an image) is pasted as ⌘V would.
    const act = pasteAction(asAttachment, pastedText, files.length);
    if (act !== "box") {
      e.preventDefault();
      if (act === "attach") void attachPastedText(pastedText);
      else addToast("The clipboard holds no text to attach");
      return;
    }
    if (withImages && ta) {
      e.preventDefault();
      pasteWithImages(withImages);
      return;
    }
    if (math !== null && ta && !(ta instanceof LiveBoxHandle) && hasTable(math)) {
      // Item 689: a table pasted into the plain box — the box becomes the
      // grid box first, then the paste goes into it, so ⌘Z takes it back.
      e.preventDefault();
      const from = Math.min(ta.selectionStart, ta.selectionEnd);
      const to = Math.max(ta.selectionStart, ta.selectionEnd);
      const chatKey = key;
      gridKey = key;
      formatCaret = from;
      void tick().then(() => {
        if (!(ta instanceof LiveBoxHandle) || key !== chatKey) return;
        ta.focus();
        ta.selectionStart = from;
        ta.selectionEnd = to;
        pasteMath(math);
        offer = longPasteOffer(math, from);
        converted = null;
      });
      return;
    }
    if (math !== null && ta) {
      e.preventDefault();
      const at = Math.min(ta.selectionStart, ta.selectionEnd);
      pasteMath(math);
      offer = longPasteOffer(math, at);
      converted = null;
      return;
    }
    // Item 315: code goes in as a fenced block with its language. A long
    // paste is left to the attachment offer below (codePasteLanguage).
    if (plan?.kind === "code" && ta) {
      e.preventDefault();
      pasteAsCode(plan.raw, plan.lang);
      offer = null;
      converted = null;
      return;
    }
    // A long ⌘V paste: the text goes in as always, and an offer under the
    // box can move it into an attachment.
    if (pastedText && files.length === 0) {
      const at = Math.min(ta?.selectionStart ?? text.length, ta?.selectionEnd ?? text.length);
      offer = longPasteOffer(pastedText, at);
      converted = null;
    }
    if (files.length === 0) return;
    // Only swallow the paste when it carries no text of its own; some sources
    // put a screenshot and its caption on the clipboard together.
    if (!pastedText) e.preventDefault();
    // Item 388: a pasted image lands with the drop's ending, not at once
    // (names as `attachFiles`' describe gives them).
    markPasted(files.filter((f) => f.type.startsWith("image/")).map((f) => f.name || "pasted image"));
    void accept(files).then((chips) => {
      for (const c of chips) if (c.kind === "image") recordImage("pasted", c);
    });
  }

  /** Item 382: the paste's text with its markers at the caret (as a math
   *  paste goes in), then its images as chips in marker order, under the
   *  key of the moment of the paste. */
  /** Item 687: the paste's lost images, said under the chips until he
   *  closes it, sends, or empties the box (a toast alone was missed). */
  let lostPaste = $state<{ key: string; text: string } | null>(null);
  $effect(() => {
    if (lostPaste && lostPaste.key === key && !text) untrack(() => (lostPaste = null));
  });
  function pasteWithImages(paste: ImagePaste): void {
    const chatKey = key;
    const ready = preparePaste(paste, MAX_IMAGE_BASE64);
    const at = Math.min(ta?.selectionStart ?? text.length, ta?.selectionEnd ?? text.length);
    const raw = normalizeNewlines(ready.text);
    pasteMath(raw);
    recordText("pasted", raw);
    offer = longPasteOffer(raw, at);
    converted = null;
    // Item 388: the paste's image chips land as dropped ones do.
    markPasted(ready.images.map((i) => `image ${i.n}`));
    void attachPastedImages(ready.images, ready.failed, {
      nextId: nextAttachmentId,
      add: (chip) => addAttachment(chatKey, chip),
      update: (id, patch) => void updateAttachment(chatKey, id, patch),
      remove: (id) => removeAttachment(chatKey, id),
      chips: () => readDraft(chatKey).attachments,
      readText: () => readDraft(chatKey).text,
      setText: (t) => setDraftText(chatKey, t),
      fetch: fetchPasteImage,
      convert: rasterize,
      track: trackPending,
      record: (chip) => recordImage("pasted", chip),
      cap: MAX_IMAGE_BASE64,
      toast: (m) => addToast(m),
      lostNote: (n, total, whys) => (lostPaste = { key: chatKey, text: lostImagesNote(n, total, whys) }),
    }, ready.whys);
  }

  /** Item 648: a code-block key's edit, in either box. The textarea's is a
   *  step of the box's own history (blocker 1210), set at once so the next
   *  keystroke lands after it; the formatted box's is CodeMirror's typing. */
  function applyBoxEdit(ed: BlockEdit): void {
    if (!ta) return;
    if (ta instanceof LiveBoxHandle) {
      ta.applyEdit(ed);
      return;
    }
    const el = ta as HTMLTextAreaElement;
    hist.select(el.selectionStart, el.selectionEnd);
    const next = applyToField(el, ed);
    if (hist.external(next, ed.head)) setDraftText(key, next);
    else hist.select(el.selectionStart, el.selectionEnd);
    noteActivity();
    autogrow();
  }

  /** Item 348: the converted math paste in place of the selection, one
   *  undo step, as a plain paste would be. */
  function pasteMath(raw: string): void {
    if (!ta) return;
    // Item 687 (his bug, 2026-11-13): the bar is for maths he types. A long
    // paste (a homework page's MIPS code: `$t0`, `i=0`) filled it with five
    // rows of offers; its spans are not offered in this draft.
    if (raw.length >= PASTE_NO_MATH) denyTypedMath(key, findTypedMath(raw).map((s) => s.src));
    if (ta instanceof LiveBoxHandle) {
      ta.pasteText(raw);
      return;
    }
    const from = Math.min(ta.selectionStart, ta.selectionEnd);
    const to = Math.max(ta.selectionStart, ta.selectionEnd);
    const next = text.slice(0, from) + raw + text.slice(to);
    hist.select(from, to);
    hist.external(next, from + raw.length);
    setDraftText(key, next);
    void tick().then(() => {
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = from + raw.length;
      autogrow();
    });
  }

  /*
   * Item 315: a code paste goes in fenced. ⌘Z right after gives back the
   * paste as it came (no fence); the formatted box does it with its own
   * history (two steps), the textarea with the box's history (blocker
   * 1210, `boxHistory.ts`): two steps, the paste as it came and then the
   * fence. The pasted characters are not touched; the fence adds lines
   * round them.
   */
  function pasteAsCode(raw: string, lang: string): void {
    if (!ta) return;
    if (ta instanceof LiveBoxHandle) {
      ta.pasteAsCode(raw, (before, after) => fenced(raw, lang, before, after));
      return;
    }
    const from = Math.min(ta.selectionStart, ta.selectionEnd);
    const to = Math.max(ta.selectionStart, ta.selectionEnd);
    // Item 399: the steps the edit box takes too (`pasteSteps`).
    const steps = pasteSteps(text, from, to, raw, lang);
    const last = steps[steps.length - 1];
    hist.select(from, to);
    for (const st of steps) hist.external(st.text, st.caret);
    setDraftText(key, last.text);
    void tick().then(() => {
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = last.caret;
      autogrow();
    });
  }

  /*
   * Blocker 1210: the textarea's undo history is the box's own
   * (`boxHistory.ts`), because WebKit's goes stale after any edit the page
   * makes by setting the text and then redoes text he typed long ago. His
   * keystrokes are recorded from `beforeinput` / `input`; every other
   * change to the draft (a chat switch, a send, a fence, a quote, a clip)
   * is seen here and recorded as a step of its own, or starts a fresh
   * history for a new chat or after a send.
   */
  // Item 886: the history is the draft's (`boxHistoryFor`), so it outlives a
  // tab switch (this box unmounts) and a chat switch (its key changes) —
  // the chat's box and an aside's alike. ~~`new BoxHistory(text)` per box,
  // `hist.reset(t)` on a new key~~.
  let hist = boxHistoryFor(untrack(() => key), untrack(() => text));
  let histKey = untrack(() => key);
  $effect(() => {
    const k = key;
    const t = text;
    untrack(() => {
      if (k !== histKey) {
        histKey = k;
        hist = boxHistoryFor(k, t);
        composing = false;
      } else if (t !== hist.current.text) {
        if (t === "") hist.reset("");
        else hist.external(t);
      }
    });
  });

  function boxSnap(el: HTMLTextAreaElement) {
    return { text: el.value, start: el.selectionStart, end: el.selectionEnd };
  }

  function onboxbeforeinput(e: InputEvent): void {
    if (!(ta instanceof HTMLTextAreaElement)) return;
    const h = historyInput(e.inputType);
    if (h) {
      // WebKit's own undo (the context menu's, a key the composer did not
      // see): never applied — its stack is the stale one — but answered
      // from the box's history. One native command can fire several of
      // these in one task; only the first steps.
      e.preventDefault();
      if (!nativeStepped) {
        nativeStepped = true;
        const mc = new MessageChannel();
        mc.port1.onmessage = () => (nativeStepped = false);
        mc.port2.postMessage(0);
        boxStep(h);
      }
      return;
    }
    hist.before(boxSnap(ta));
  }
  let nativeStepped = false;
  /** An input method's composition is open in the box (marked text). */
  let composing = false;

  // 284's conversion step: `ConvertTag` / `isConvertTag` (pastedText.svelte.ts).

  function onboxinput(e: Event): void {
    if (!(ta instanceof HTMLTextAreaElement)) return;
    hist.input(editKind((e as InputEvent).inputType ?? ""), boxSnap(ta));
  }

  /** The box's undo / redo key, or null: ⌘Z, ⌘⇧Z and ⌘Y (Ctrl off the
   *  Mac). */
  function boxHistoryKey(e: KeyboardEvent): "undo" | "redo" | null {
    return historyKey(e, isMac);
  }

  /** One undo or redo in the textarea. False when the box is the
   *  formatted editor, whose own history answers. */
  function boxStep(dir: "undo" | "redo"): boolean {
    if (!(ta instanceof HTMLTextAreaElement)) return false;
    // Review (2026-10-06): not while marked text is showing — setting the
    // box under the input method would drop his words or put the commit
    // in the wrong place. The key is swallowed; WebKit does the same.
    if (composing) return true;
    const s = dir === "undo" ? hist.undo() : hist.redo();
    if (!s) return true;
    // 284's conversion: the chip goes with its undo and comes back with
    // its redo, so the pasted words are always in the box or in the chip.
    if (isConvertTag(s.tag)) {
      const t = s.tag;
      const has = attachments.some((a) => a.id === t.chip.id);
      if (dir === "undo") {
        converted = null;
        if (has) {
          fadeOutIds.mark(t.chip.id);
          removeAttachment(key, t.chip.id);
        }
      } else {
        if (!has) addAttachment(key, t.chip);
        converted = { before: t.before, after: t.after, chipId: t.chip.id, caret: t.caret };
      }
    }
    // Item 458: an attach or a remove, undone or redone.
    if (isChipTag(s.tag)) {
      // Leaves at once, as a chip's × takes it: no fade to wait out. A
      // conversion that ended while the chip was out lands on it now
      // (review fix); a split deck's parts move with part 1 (item 868).
      setDraftAttachments(key, stepChips(s.tag, dir, $state.snapshot(attachments) as Attachment[]));
    }
    setDraftText(key, s.text);
    void tick().then(() => {
      if (!(ta instanceof HTMLTextAreaElement)) return;
      ta.focus();
      ta.setSelectionRange(s.start, s.end);
      autogrow();
    });
    return true;
  }
  /** The block's label changed: only the fence's info string is rewritten. */
  function relabel(k: number, lang: string): void {
    const f = findFences(text)[k];
    if (!f || !ta) return;
    if (ta instanceof LiveBoxHandle) {
      ta.replaceRange(f.infoFrom, f.infoTo, lang);
      return;
    }
    const caret = ta.selectionStart;
    const shift = lang.length - (f.infoTo - f.infoFrom);
    setDraftText(key, withFenceLanguage(text, f, lang));
    void tick().then(() => {
      if (!ta) return;
      const back = caret >= f.infoTo ? caret + shift : Math.min(caret, f.infoFrom);
      ta.selectionStart = ta.selectionEnd = back;
    });
  }

  /*
   * Paste as an attachment (nightshift item 284; blocker 941's default,
   * 942's key). ⌥⌘V marks the next paste and asks the backend for one —
   * Edit ▸ Paste's own `paste:` — so `onpaste` gets the clipboard as a ⌘V
   * would and makes its text a chip. Off the Mac the clipboard is read
   * here instead.
   */
  // Shared with the edit box since item 399b (`pastedText.svelte.ts`).
  const attachMark = new AttachMark();
  function takeAttachMark(): boolean {
    return attachMark.take();
  }
  function pasteAsAttachment(): Promise<void> {
    return sharedPasteAsAttachment(attachMark, attachPastedText);
  }

  /*
   * Item 312: a chip made from text fades in; Undo fades it out. The marks
   * are one-shot and never saved, so a chip that mounts because the chat
   * changed, or an image or file, appears as before. The transitions are
   * `|global` because the first chip also creates the chip row around it.
   */
  const fadeInNames = new Marks<string>();
  const fadeOutIds = new Marks<number>();
  function chipIn(node: Element, a: Attachment) {
    // Item 362: a dropped file's chip opens the row and scales in (A).
    const dropped = takeDropped(a.name);
    if (dropped !== null) return chipDropIn(dropped, node.getBoundingClientRect().width, prefersReducedMotion());
    return chipMotion(fadeInNames.take(a.name), prefersReducedMotion());
  }
  /** Item 362: the row the first dropped chip makes opens to its height. */
  function rowIn(node: Element) {
    if (!dropPending()) return { duration: 0 };
    return rowDropOpen(node.getBoundingClientRect().height, prefersReducedMotion());
  }
  function chipOut(_node: Element, a: Attachment) {
    return chipMotion(fadeOutIds.take(a.id), prefersReducedMotion());
  }

  /** Pasted text as a chip, by item 277's text route (`accept`): named
   *  "Pasted text", its words on the chip, kept with the draft. */
  function attachPastedText(raw: string): Promise<Attachment | null> {
    // Item 312: this chip came from text, so it fades in.
    return sharedAttachPastedText(key, raw, {
      named: (name) => fadeInNames.mark(name),
      failed: (name) => fadeInNames.unmark(name),
    });
  }

  /*
   * The long ⌘V paste's offer (item 284): "Make this an attachment" under
   * the box while the box is as the paste left it; any edit, a send or a
   * chat switch drops it. One click moves the span into a chip; "Undo"
   * (or ⌘Z in the box) puts it back while nothing has changed since.
   */
  let offer = $state<LongPaste | null>(null);
  let converted = $state<Converted | null>(null);
  const undoable = $derived(canUndo(converted, text, attachments.map((a) => a.id)));
  $effect(() => {
    const t = text;
    untrack(() => {
      offer = followOffer(offer, t);
    });
  });
  $effect(() => {
    void key;
    offer = null;
    converted = null;
  });

  async function convertLongPaste(): Promise<void> {
    const o = offer;
    if (!o) return;
    offer = null;
    const chatKey = key;
    // Refused (too long for this engine), or typed into meanwhile: the
    // text stays where he is working (`convertOffer`, shared with 399b).
    const done = await convertOffer(o, chatKey, () => readDraft(chatKey).text, attachPastedText);
    if (!done) return;
    const { chip, before: now, after } = done;
    // Blocker 1210: a step of the box's history that carries the chip, so
    // ⌘Z takes the chip away with the text and ⌘⇧Z brings both back.
    if (chatKey === key) {
      const tag: ConvertTag = { convert: true, chip: $state.snapshot(chip) as Attachment, before: now, after, caret: o.start };
      hist.external(after, o.start, tag);
    }
    setDraftText(chatKey, after);
    if (chatKey !== key) return;
    converted = { before: now, after, chipId: chip.id, caret: o.start };
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = o.start;
      autogrow();
    });
  }

  /** Item 318: the offer's × (or Esc): the paste stays in the box as
   *  text, and this paste is not offered again — the offer only comes
   *  from a paste, never from an undo or redo. */
  function dismissOffer(): void {
    offer = null;
  }

  function undoConvert(): boolean {
    const c = converted;
    converted = null;
    if (!canUndo(c, text, attachments.map((a) => a.id))) return false;
    // Blocker 1210: the conversion is the box's last step — undo it there,
    // so ⌘⇧Z can bring it back.
    const tag = hist.undoTag;
    if (isConvertTag(tag) && tag.chip.id === c.chipId) return boxStep("undo");
    const r = undoConverted(c);
    fadeOutIds.mark(c.chipId);
    removeAttachment(key, c.chipId);
    hist.external(r.text, r.caret);
    setDraftText(key, r.text);
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = r.caret;
      autogrow();
    });
    return true;
  }

  // The Edit menu's Undo while the box has the keyboard and a conversion
  // can be undone (macOS: the menu takes ⌘Z before the box sees it).
  $effect(() => {
    const take = (id: string): boolean => {
      if (id !== "undo_app" && id !== "redo_app") return false;
      const box = boxElement(ta);
      if (!box || !box.contains(document.activeElement)) return false;
      if (id === "undo_app" && undoable) return undoConvert();
      // Blocker 1210: the textarea's own history, not `execCommand`.
      return boxStep(id === "undo_app" ? "undo" : "redo");
    };
    menuInterceptors.push(take);
    return () => {
      const i = menuInterceptors.indexOf(take);
      if (i >= 0) menuInterceptors.splice(i, 1);
    };
  });

  // ⌘. in an aside's box (item 398, blocker 1506): the thread's Stop, as
  // its button — its answer if one is coming, else nothing, never the
  // chat's turn behind it. A chat's box needs no hook: `runMenuCommand`
  // stops the chat's turn.
  $effect(() => {
    const thread = aside;
    if (!thread) return;
    const take = (id: string): boolean => {
      if (id !== "stop_turn") return false;
      // Item 853: ~~only with its box focused~~ — also when this box is the
      // one meant (an aside tab in front, a card he last pressed on), as
      // the chat's ⌘. stops its turn from anywhere in the chat.
      const asideFocused = !!root && (root.contains(document.activeElement) || isSummonTarget(root));
      if (!asideFocused) return false;
      if (stopChordTarget({ asideFocused, asideBusy, turnBusy: app.busy }) === "aside") stopAside(thread);
      return true;
    };
    menuInterceptors.push(take);
    return () => {
      const i = menuInterceptors.indexOf(take);
      if (i >= 0) menuInterceptors.splice(i, 1);
    };
  });

  function ondragenter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
  }

  function ondragover(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function ondragleave() {
    if (dragDepth > 0) dragDepth--;
  }

  function ondrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    void accept(files);
  }

  // The Attach button: a hidden picker feeding the same `accept` the paste
  // and drop paths use. Same media types the drop accepts.
  let picker = $state<HTMLInputElement | null>(null);
  function onpick(): void {
    const files = Array.from(picker?.files ?? []);
    if (picker) picker.value = "";
    if (files.length > 0) void accept(files);
  }

  function remove(id: number) {
    const chatKey = key;
    const at = attachments.findIndex((x) => x.id === id);
    const a = attachments[at];
    removeAttachment(chatKey, id);
    // Item 458: ⌘Z puts it back where it sat.
    if (a) hist.mark({ chipStep: "remove", chip: $state.snapshot(a) as Attachment, index: at });
    // Pasted text has no file to drop again (item 284): × says so and
    // offers it back.
    if (a?.pasted) {
      const copy = $state.snapshot(a) as Attachment;
      addToast(`Removed ${copy.name}`, { label: "Undo", run: () => addAttachment(chatKey, copy) });
    }
  }

  /** The wire shape of a set of chips (`splitChips`); a file for Claude
   *  Code on the API engine stops a send (`filesBlocked`). Both moved to
   *  `attachFiles.svelte.ts` (item 336). */
  const split = splitChips;

  /**
   * One turn, from words and chips already out of the box. After it, the
   * oldest held message goes next (backlog 089) — unless the turn failed,
   * in which case the words come back and the queue waits for *Send next*,
   * since a second send would most likely fail the same way and bury the
   * error.
   */
  async function dispatch(
    typed: string,
    chips: Attachment[],
    wrapUp = false,
    council: CouncilPrefs | null = null,
  ): Promise<void> {
    const chat = app.activeSessionId;
    // The chat this turn is for, by draft key (backlog 375): its failed
    // words and its queue go back to it, never to the chat open when it
    // ends.
    const from = liveKey();
    forgetMove(from);
    const { images, documents, files } = split(chips);
    await send(
      typed.trim(),
      images,
      documents,
      council ? { seats: council.seats, mode: council.mode, areas: [] } : null,
      files,
    );
    // send() reports failures on app.error instead of throwing, and a turn
    // that never reached the model should not cost the user its attachments
    // — or, since 2026-09-15, its words. Both go back under the key of the
    // ~~chat now open~~ chat the turn was for (backlog 375: the chat now
    // open may be another project's; the pending chat's first turn may
    // have made the chat before failing, which `ranKey` follows), the text
    // only if nothing new was typed meanwhile. A wrap-up that failed goes
    // back to its notice rather than into the box.
    if (app.error) {
      if (wrapUp) {
        abortWrapUp(chat);
        return;
      }
      const back = ranKey(from);
      if (!readDraft(back).text) {
        // Item 892: words sent with comments come back as his text and the chips.
        const sc = sentComments(typed);
        setDraftText(back, sc ? sc.typed : typed);
        setDraftAttachments(back, chips.concat(readDraft(back).attachments));
        if (sc) restoreComments(back, sc.comments);
      } else if (typed || chips.length > 0) {
        // The box holds new words: the failed message goes back to the
        // head of the queue rather than nowhere (backlog 158).
        requeueFront(back, { id: nextQueueId(), text: typed, attachments: chips });
      }
      return;
    }
    // A turn the usage limit paused (backlog 164): the queue waits for
    // the Resume rather than sending the next message into the same
    // exhausted window.
    if (app.limitPause) return;
    await drain(false, from);
  }

  /** The open chat's draft key, read now — not `key`, which a composer
   *  torn down by a view change (the New chat page has its own) may hold
   *  from before (backlog 375). */
  function liveKey(): string {
    return aside ? key : openChatKey();
  }

  /** Why the queue is waiting rather than sending itself, if it is. */
  const hold = $derived(aside ? null : queueHold(handoffHere ? handoff.stage : "idle", turnWasStopped()));
  /** The main queue's head: one state at a time (backlog 366 + 374). */
  const mainHead = $derived(
    queueHeadLabel({
      busy: app.busy,
      hold,
      rows: queue,
      subagents: rowsOf(app.subagents, app.activeSessionId).filter((r) => r.status === "running").length,
    }),
  );

  /**
   * Send the oldest held message as the next turn, if there is one. At a
   * turn's end the queue holds when `queueHold` says so; *Send next* is
   * the explicit choice and goes regardless.
   */
  async function drain(explicit = false, from?: string): Promise<void> {
    if (aside) return asideDrain();
    // A provider turn off screen holds the engine (backlog 159, A4).
    if (app.busy || !app.connection || providerElsewhereName()) return;
    // A forced send is on its way and its turn has not started yet (item
    // 536): no second drain sends the next row beside it.
    if (forcing) return;
    // His *Send now* stopped the turn (item 536): that row goes now, at
    // the head of this chat's own queue, whatever the hold after a Stop
    // says — taken once, so it goes once.
    const forced = takeStopSend(liveKey());
    if (forced !== null) {
      if (!frontQueued(liveKey(), forced)) return;
      explicit = true;
      from = undefined;
    }
    if (!explicit && hold) return;
    // Only the open chat's own queue, and after a turn only when that turn
    // was this chat's (backlog 375): a message never leaves for a chat it
    // was not queued in.
    // `takeQueued` (state.svelte.ts) is where that rule lives and is tested.
    const q = takeQueued(key, aside !== null, from);
    if (!q) return;
    // Free again once its turn has started (the effect below) or the
    // send has come back without one.
    if (forced !== null) forcing = true;
    // The held row is where this message leaves from (backlog 194); its
    // element is still in the DOM until the next flush.
    // Item 547: under Filament IV a held row is his bubble in the transcript,
    // and it flies from there.
    launch(
      "chat",
      document.querySelector(`.queue-row[data-queue-id="${q.id}"] .queue-text`) ??
        (classic() ? null : document.querySelector(`.midturn[data-queue-id="${q.id}"] .user-bubble`)),
    );
    // The row Nightloom queued while he was away is the wrap-up going.
    const wrapUp = handoffHere && q.id === handoff.queuedId;
    if (wrapUp) beginWrapUp(app.activeSessionId);
    try {
      await dispatch(q.text, q.attachments, wrapUp);
    } finally {
      if (forced !== null) forcing = false;
    }
  }

  /** A forced send (536) taken and not yet started as a turn. */
  let forcing = false;
  $effect(() => {
    if (app.busy) forcing = false;
  });
  // The stopped turn is over and his *Send now* row waits (item 536): send
  // it — the turn's own end usually drains first; this covers a turn this
  // composer did not start (a background chat brought back, the phone).
  $effect(() => {
    if (aside || app.busy) return;
    if (stopSendFor(key) === null) return;
    untrack(() => void drain());
  });

  // Scheduled send (backlog 224): a due message joins this chat's queue
  // and goes through `drain`, which gives the words back on a failure.
  // Untracked: the first tick reads the store, which is not this effect's.
  // The chat's composer only (283): an aside's queue waits for its answer.
  $effect(() => untrack(() => (aside ? undefined : registerScheduleDrain(() => drain()))));
  // And when a provider turn off screen ends (A4 review): the message
  // queued behind it here goes, as its notice said.
  $effect(() => untrack(() => (aside ? undefined : registerProviderDrain(() => drain()))));
  // And a block he ran has ended (item 503): its output goes as the next turn.
  $effect(() => untrack(() => (aside ? undefined : registerRunDrain(() => drain(true)))));
  // Item 548: *Send now* on a held bubble in the transcript is *Send next*
  // for that row — to the head of the queue, then the same drain.
  $effect(() =>
    untrack(() =>
      aside
        ? undefined
        : registerSendHeld(async (qid) => {
            if (frontQueued(liveKey(), qid)) await drain(true);
          }),
    ),
  );
  /** Why nothing can be scheduled from this box, if nothing can. */
  // A New chat is made at the pick (backlog 527), and the box's files and
  // images go with the message (backlog 531): only a chip still converting
  // (no bytes yet) blocks.
  const scheduleBlocked = $derived(
    attachments.some((a) => a.pending) ? "a file is still being prepared — Send later opens when it is ready" : null,
  );
  /** The waiting page above holds the scheduled message as its card
   *  (backlog 532), so the row over the box would say it twice. */
  const onWaitingPage = $derived(
    !aside &&
      !floating &&
      app.activeSessionId !== null &&
      key === app.activeSessionId &&
      scheduledFor(key) !== null &&
      hasNoTurns(app.events, !!app.live),
  );
  function scheduled(to: string): void {
    clearDraft(to);
    requestAnimationFrame(autogrow);
  }
  function scheduleEdited(): void {
    requestAnimationFrame(autogrow);
    ta?.focus();
  }

  /** Hold what is in the box for the next turn (the turn is running). In
   *  a chat that is not the running one (backlog 159), the toast says
   *  where the turn is; the message goes here when it ends. */
  async function enqueue(): Promise<void> {
    const t = text.trim();
    if (!t && attachments.length === 0 && comments.length === 0) return;
    // A held message carries finished chips only (item 277).
    if (!(await conversionsDone(key))) return;
    // Item 754: the comments go with it, as one message.
    const held = enqueueMessage(key, sendWithComments(readDraft(key).comments, readDraft(key).text), readDraft(key).attachments.slice());
    // Item 924: a message sent mid-reply flies from the box into its
    // waiting bubble, as a plain send flies into its turn (backlog 194);
    // measured before the box clears. No bubble takes it (Classic's tray
    // rows) → the launch goes stale unseen.
    launch(QUEUED_CHANNEL, boxElement(ta));
    clearDraft(key, true);
    if (aside) {
      afterSend(key);
      return;
    }
    // Into the running turn, at its next step (backlog 328); the row stays
    // until the turn takes it, and goes as the next message if it never does.
    if (app.busy && !app.parked) void injectIntoTurn(key, held);
    if (app.parked) addToast(queuedElsewhereToast(runningChatName()));
    else if (!app.busy) {
      const elsewhere = providerElsewhereName();
      if (elsewhere) addToast(queuedElsewhereToast(elsewhere));
    }
    afterSend(key);
  }

  /** A row sent into the running turn is asked back from the CLI first
   *  (backlog 328): it comes back only if the turn has not taken it. */
  async function unsend(id: number | undefined): Promise<boolean> {
    const q = id === undefined ? queue[queue.length - 1] : queue.find((r) => r.id === id);
    const inj = q?.inject;
    if (!q || !inj) return true;
    if (inj.after !== undefined) {
      addToast(`already reached the turn ${inj.after}`);
      return false;
    }
    let r: "cancelled" | "delivered" = "cancelled";
    try {
      r = await takeBackInjected(inj.turn, inj.id);
    } catch {
      r = "delivered";
    }
    if (r === "delivered") {
      addToast("already reached the turn");
      return false;
    }
    clearInjected(key, q.id);
    return true;
  }

  async function takeBack(id?: number): Promise<void> {
    if (!(await unsend(id))) return;
    takeBackQueued(key, id);
    requestAnimationFrame(autogrow);
    ta?.focus();
  }

  /** Item 925: the row's × is the bubble's Cancel — at once, its words to
   *  the box's history, and an Undo in the toast (before, the × dropped it
   *  with neither). */
  async function dropRow(id: number): Promise<void> {
    await cancelPending(key, id);
  }

  async function submitAside() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || app.busy) return;
    // The chips go with it since backlog 283: an aside takes what a turn
    // takes (images, documents, files), drawn in its bubble.
    const sendKey = key;
    if (!(await conversionsDone(sendKey))) return;
    if (sendKey !== key || app.busy) return;
    const chips = attachments.map((c) => $state.snapshot(c) as Attachment);
    // Item 694: about the passage the box holds, anchored to it, as the
    // pill's Ask aside would ask; none held, about nothing, as before.
    // Merge round U review (item 814): only a passage whose chip shows — an aside sent with files
    // alone from a box he has not written in was about a passage he could not see; it is dropped.
    const { quote, anchor } = heldShown ? boxAsideArgs(sendKey) : { quote: null, anchor: null };
    if (held && !heldShown) dropHeld(sendKey);
    // The words fly from the box into the aside's card (backlog 194).
    launch("aside", boxElement(ta));
    clearDraft(key);
    afterSend(key);
    await askAside(t, quote, null, { attachments: chips, anchor });
  }

  /*
   * The aside's send (backlog 283): the first question of a draft thread
   * (`askAside`, in place) or a follow-up (`followUpAside`), with the
   * box's chips. While the thread answers, ↵ holds the message in its
   * queue, which goes when the answer ends (`asideDrain`). Off the open
   * chat or the Claude Code engine nothing goes and the box keeps all.
   */
  async function asideSubmit(): Promise<void> {
    const a = aside;
    if (!a) return;
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    if (asideBlock) return;
    recordText("sent", text);
    if (asideBusy) {
      await enqueue();
      return;
    }
    const sendKey = key;
    if (!(await conversionsDone(sendKey))) return;
    if (sendKey !== key || asideBusy || asideBlock) return;
    const pending = attachments.map((c) => $state.snapshot(c) as Attachment);
    const typed = text;
    launch("aside", boxElement(ta));
    clearDraft(key);
    afterSend(key);
    await asideDispatch(a, typed, pending);
  }
  async function asideDispatch(a: Aside, typed: string, chips: Attachment[]): Promise<void> {
    if (a.draft) await askAside(typed, a.quote, a, { attachments: chips });
    else await followUpAside(typed, a, { attachments: chips });
    await asideDrain();
  }
  /** The thread's oldest held message, once its answer has ended. */
  async function asideDrain(): Promise<void> {
    const a = aside;
    if (!a || asideBusy || asideBlock) return;
    const head = queue[0];
    if (head)
      launch(
        "aside",
        document.querySelector(`.queue-row[data-queue-id="${head.id}"] .queue-text`) ??
          document.querySelector(`.midturn[data-queue-id="${head.id}"] .user-bubble`),
      );
    const q = shiftQueue(key);
    if (!q) return;
    await asideDispatch(a, q.text, q.attachments);
  }
  // An answer that ends while a message is held sends the next (283).
  let wasBusy = untrack(() => asideBusy);
  $effect(() => {
    const now = asideBusy;
    const before = wasBusy;
    wasBusy = now;
    if (aside && before && !now) untrack(() => void asideDrain());
  });

  /**
   * Item 606: Send's Filament "sending" look — from the click until the
   * turn starts (Stop takes Send's place then) or the send gives up, e.g.
   * while an office file converts.
   */
  let sending = $state(false);
  $effect(() => {
    if (busy) sending = false;
  });
  /** Send's hover plus, at fold 2+, the token estimate. sendTip returns
   *  { text, keys }; adding a string to it showed "[object Object]" (his
   *  report, 2026-11-11). */
  function withEstimate(t: { text: string; keys?: string }): { text: string; keys?: string } {
    return shown && Number(rowFold) >= 5 ? { ...t, text: `${t.text} · ${shown.long}` } : t;
  }
  /*
   * Item 966 (916's item A): the app's slash commands, typed alone and sent
   * (`parseCommand`), each running what its control already runs — the
   * model and effort menus' own rows, the aside button's ask, the message
   * menu's Rewind, ⌘⇧C, ⌘N's kinds, the search panel. True when the box
   * held one, which then never goes as text. A command that cannot run now
   * says why in a toast and leaves the box as typed.
   */
  async function runTypedCommand(): Promise<boolean> {
    const typed = parseCommand(text, aside ? "aside" : "chat");
    if (!typed) return false;
    const { cmd, arg } = typed;
    // Files or comments in the box: it is a message about them, not a command
    // — except /aside, which asks with the box's chips as its button does,
    // and /schedule and /council (item 967), which send them as theirs do.
    if (!["aside", "schedule", "council"].includes(cmd.name) && (attachments.length > 0 || comments.length > 0)) return false;
    const clear = () => setDraftText(key, "");
    // Item 967: the second batch (`appCommands967.ts`).
    if (await runBatch2(typed, boxActions(clear))) return true;
    switch (cmd.name) {
      case "handoff": {
        // Item 915: `/handoff` alone is the hand-off-now path, not text to send.
        if (!isHandoffCommand(text)) return false;
        const block = handOffBlock();
        if (block) {
          addToast(block);
          return true;
        }
        // Item 926: the words fly from the box, as Send's do.
        const box = boxElement(ta);
        clear();
        await sendWrapUpNow(box);
        return true;
      }
      case "aside": {
        if (!arg) addToast("Type the question after /aside");
        else if (app.connection?.engine !== "claude-code") addToast("Asides run on the Claude Code engine");
        else if (app.events.length === 0) addToast("Ask aside once the chat has a reply — an empty chat has no context to ask");
        else if (app.busy) addToast("A reply is running — ask aside when it ends");
        else {
          // The question alone in the box, then the aside button's own path.
          setDraftText(key, arg);
          await tick();
          await submitAside();
        }
        return true;
      }
      case "model": {
        if (!arg) {
          clear();
          openMenu("model");
          return true;
        }
        const rows = (aside ? asideModelRows : modelRows).filter((r) => !["rail", "other", "none"].includes(r.id));
        const row = pickRow(arg, rows);
        if (row) {
          clear();
          row.run();
          addToast(aside ? `This aside's model: ${row.label}` : `Model: ${row.label}`);
        } else if (agentMode && /^claude-[a-z0-9.-]+$/i.test(arg)) {
          clear();
          if (aside) pickAside("model", arg);
          else void switchModel(arg);
          addToast(aside ? `This aside's model: ${arg}` : `Model: ${arg}`);
        } else addToast(`No model “${arg}” — try ${rows.map((r) => r.label).join(", ")}`);
        return true;
      }
      case "effort": {
        if (!arg) {
          clear();
          openMenu("effort");
          return true;
        }
        const rows = aside ? asideEffortRows : effortRows;
        const row = pickRow(arg, rows);
        const word = agentMode ? "Effort" : "Thinking";
        if (row) {
          clear();
          row.run();
          addToast(aside ? `This aside's effort: ${row.label}` : `${word}: ${row.label}`);
        } else addToast(`No ${word.toLowerCase()} “${arg}” — try ${rows.map((r) => r.label).join(", ")}`);
        return true;
      }
      case "rename": {
        if (!arg) {
          addToast(aside ? "Type the aside's new name after /rename" : "Type the chat's new name after /rename");
          return true;
        }
        if (aside) {
          renameAside(aside, arg);
          clear();
          addToast(`Aside renamed “${arg}”`);
          return true;
        }
        const id = app.activeSessionId;
        if (!id) addToast("Nothing to rename yet — a chat is kept once its first message is sent");
        else if (app.busy) addToast("A reply is running — rename when it ends");
        else {
          clear();
          await renameSession(id, arg);
        }
        return true;
      }
      case "rewind": {
        if (aside) {
          const last = aside.turns.length - 1;
          if (asideAsking(aside)) addToast("The aside is answering — rewind when it ends");
          else if (last < 0) addToast("Nothing to rewind in this aside");
          else {
            clear();
            rewindAsideWithUndo(aside, last);
          }
          return true;
        }
        if (app.busy) {
          addToast("A reply is running — rewind when it ends");
          return true;
        }
        const live = liveFlags(app.events);
        let at = -1;
        for (let i = app.events.length - 1; i >= 0; i--) {
          if (app.events[i].event === "user_message" && live[i]) {
            at = i;
            break;
          }
        }
        if (at < 0) addToast("Nothing to rewind");
        else {
          // The box empties first: the rewound message comes back into it.
          clear();
          await rewindTo(at, true);
        }
        return true;
      }
      case "context": {
        if (!app.connection) {
          addToast("No engine connected");
          return true;
        }
        clear();
        if (!app.showContext) runMenuCommand("context");
        return true;
      }
      case "new": {
        const kind = newKind(arg);
        if (!kind) {
          addToast(NEW_KINDS_HINT);
          return true;
        }
        clear();
        runMenuCommand(kind === "default" ? "new_chat" : kind === "build" ? "new_build" : kind === "chat" ? "new_talk" : `new_${kind}`);
        return true;
      }
      case "search": {
        clear();
        if (app.layout.sidebarCollapsed) toggleSidebar();
        if (arg) app.search.query = arg;
        app.search.open = true;
        return true;
      }
    }
    return false;
  }

  /** Item 967: what the second batch's commands run, from this box. */
  function boxActions(clear: () => void): BoxActions {
    return {
      aside: !!aside,
      toast: (m) => addToast(m),
      clear,
      engine: () => app.connection?.engine ?? null,
      busy: () => app.busy,
      sessionId: () => app.activeSessionId,
      lastLiveUser: () => {
        const live = liveFlags(app.events);
        for (let i = app.events.length - 1; i >= 0; i--) if (app.events[i].event === "user_message" && live[i]) return i;
        return -1;
      },
      setCheckpoint: (i) => setCheckpoint(i),
      scheduleBlocked: () => scheduleBlocked ?? (scheduledFor(key) !== null ? "this chat already has a scheduled message — Edit or Cancel it first" : null),
      scheduleTime: (kind, hhmm) =>
        kind === "five_hour"
          ? resetTime(app.planUsage?.five_hour_resets_at, Date.now())
          : kind === "seven_day"
            ? resetTime(app.planUsage?.seven_day_resets_at, Date.now())
            : (atTime(hhmm, Date.now())?.at ?? null),
      schedule: async (words, kind, at) => (scheduleMenu ? scheduleMenu.scheduleWords(words, kind, at) : false),
      openCouncil: () => (councilOpen = true),
      sendCouncil: async (words) => {
        // The message alone in the box, then the popover's own send with
        // this chat's roster (the one the popover opens with).
        setDraftText(key, words);
        await tick();
        await submitCouncil(councilFor(app.activeSessionId));
      },
      keepWarmChat: () => kwChat,
      keepWarmOn: () => isOn(kw),
      setKeepWarm: (mode) => flipKeepWarm(mode),
      transcriptOn: (w) => (w === "thinking" ? transcript.thinking : transcript.tools),
      thinkingDead: () => thinkingDead,
      toggleTranscript: (w) => toggleTranscriptPref(w),
      capturing: () => app.capturing,
      saveMemory: (id) => saveMemoryFromChat(id),
      projects: () => app.projects,
      currentProject: () => app.project?.id ?? null,
      canLeaveProject: () => canLeaveProject(),
      useProject: async (id) => void (await useProject(id)),
      // Item 997: opens the list, never toggles it shut (⌘P's menu id toggles).
      openProjects: () => void (app.overlay !== "projects" && runMenuCommand("projects")),
      noteScope: () => (app.project ? "project" : app.knowledge ? "knowledge" : null),
      newNote: (scope, name) => newNoteOrOpen(scope, name),
      terminalCwd: () => terminalCwd(),
      // Item 996: always a NEW shell, in front and focused — ~~the top bar's
      // button (`openTerminalFromBar`)~~, which only shows a hidden or
      // collapsed dock (its Agent commands tab in front) and makes no shell.
      openTerminal: async () => void (await newShell()),
      openAgentTab: async (id) => void openAgentTab(id),
      canMakeMain: (id) => canMakeMain(app.sessions, versions.map, id),
      makeMain: (id) => makeMainChat(id),
      menu: (id) => runMenuCommand(id),
    };
  }

  async function submit() {
    // Item 966: an app command typed alone runs instead of going as text.
    if (await runTypedCommand()) return;
    if (aside) return asideSubmit();
    sending = true;
    try {
      await submitNow();
    } finally {
      sending = false;
    }
  }
  async function submitNow() {
    const t = text.trim();
    const empty = !t && attachments.length === 0 && comments.length === 0;
    if (empty || !app.connection) return;
    // Item 694: a plain turn does not take the held passage; Send drops it.
    dropHeld(key);
    // A send is presence, for the hand-off's away rule.
    noteActivity();
    // What he sent — or queued behind the running turn — is in the ⌘⇧V
    // list too (blocker 282's default).
    recordText("sent", text);
    // Or a provider turn off screen (A4): one runs at a time.
    if (app.busy || providerElsewhereName()) {
      await enqueue();
      return;
    }
    // Not on the old settings while the rail's new ones connect (item
    // 222); the text stays in the box.
    if (sendHeld()) return;
    // An office file still converting (item 277): Send waits for it, and
    // says so; the box keeps everything meanwhile.
    const sendKey = key;
    if (!(await conversionsDone(sendKey))) return;
    // Against the open chat read now, not `key` (375 review): a composer
    // torn down by a switch during the wait holds its old key, and its
    // box's words would go to the chat open now.
    if (sendKey !== key || sendKey !== liveKey() || !app.connection || app.busy) return;
    if (filesBlocked(attachments)) return;
    const pending = attachments.slice();
    // Item 754: each comment's passage quoted with his words, then the box's.
    const typed = sendWithComments(comments, text);
    // Where the words were, for the send motion (backlog 194): measured
    // before the box clears.
    launch("chat", boxElement(ta));
    clearDraft(key, true);
    afterSend(key);
    await dispatch(typed, pending);
  }

  /**
   * The council (nightshift backlog 149, blocker 243): the popover's
   * *Send to the council* sends what is in the box as a council turn —
   * the seats it names run first, the chat's model chairs. Text and
   * attachments as a plain send; not while a turn runs (the queue holds
   * plain messages only).
   */
  let councilOpen = $state(false);
  /** Item 967: Send's ▾, whose pick `/schedule` runs. */
  let scheduleMenu = $state<ReturnType<typeof ScheduleMenu> | null>(null);
  let councilBtn = $state<HTMLElement | null>(null);
  let councilWrap = $state<HTMLElement | null>(null);
  async function submitCouncil(prefs: CouncilPrefs) {
    councilOpen = false;
    const t = text.trim();
    if ((!t && attachments.length === 0 && comments.length === 0) || !app.connection || app.busy || sendHeld()) return;
    const sendKey = key;
    if (!(await conversionsDone(sendKey))) return;
    if (sendKey !== key || sendKey !== liveKey() || !app.connection || app.busy) return;
    if (filesBlocked(attachments)) return;
    noteActivity();
    const pending = attachments.slice();
    const typed = sendWithComments(comments, text);
    recordText("sent", typed);
    launch("chat", boxElement(ta));
    clearDraft(key, true);
    afterSend(key);
    await dispatch(typed, pending, false, prefs);
  }
  function onCouncilDocClick(e: MouseEvent) {
    const t = e.target as Node;
    // The popover lives under `body` since backlog 210, outside the wrap.
    if (councilWrap?.contains(t) || (t instanceof Element && t.closest(".council-menu"))) return;
    councilOpen = false;
  }
  $effect(() => {
    if (!councilOpen) return;
    document.addEventListener("mousedown", onCouncilDocClick, true);
    return () => document.removeEventListener("mousedown", onCouncilDocClick, true);
  });
  $effect(() => {
    void key;
    councilOpen = false;
  });

  /** The first line of a held message, for its row. */
  function firstLine(t: string): string {
    const line = t.split("\n").find((l) => l.trim()) ?? "";
    return line.length > 120 ? line.slice(0, 117) + "…" : line;
  }

  /*
   * The model and effort pickers, in the box (nightshift backlog 112, his
   * pick of board 10's direction A, 2026-09-16): two small buttons beside
   * Attach, each opening a menu above itself — the Claude app's idiom of
   * the model under the text. The top bar's chip names the kind and the
   * engine only since blocker 141; the model's name lives here.
   *
   * Both buttons read and write `app.draft`, the same fields the rail's
   * pills are bound to, and call the same `applyDraft` — so the rail's
   * copies and these cannot disagree; there is one record. The model rows
   * go through `switchModel` / `switchModelAt`, which are what ⌘⇧S/O/F/H
   * and ⌘⇧1…9 already run, so a click and its key do the same thing. On
   * the subscription engine the second button is Effort (backlog 076's
   * segment, with backlog 100's `default · high`); on the provider engine
   * it is the rail's Thinking segment, since that engine has no `--effort`
   * and the chip's `thinking …` tail is gone from the top bar.
   */
  // An aside runs on Claude Code only (081), so its pickers are always
  // the subscription engine's model and effort.
  const agentMode = $derived(!!aside || app.draft.engine === "claude-code");
  /** The engine a chip's route is decided for at Send (item 491): the
   *  connection's, as `splitChips` reads it; an aside is always Claude Code. */
  const chipEngine = $derived<Engine>(aside || app.connection?.engine === "claude-code" ? "claude-code" : "api");
  const locked = $derived(app.busy || app.connecting);
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  // Item 272: the list Settings edits (`model-list.json`), not a constant.
  const AGENT_PILLS = $derived(modelList.models);
  /** The same list `switchModelAt` counts, so row n's cap is ⌘⇧n. */
  const models = $derived(pickerModels());
  function agentKey(alias: string): string | null {
    const k = MODEL_KEYS.find((m) => m.alias === alias);
    return k ? `${mod}${shift}${k.key}` : null;
  }
  /** What the button names: ~~the connection's model (the alias, or
   *  `default` for the CLI's own), else the draft's while not connected~~ —
   *  on Claude Code the alias picked, never the id a turn's end resolved
   *  (backlog 204, 2026-09-25; `modelChipLabel`). */
  const modelLabel = $derived(
    modelChipLabel({
      agentMode,
      agentModel: app.draft.agentModel,
      model: app.draft.model,
      connected: app.connection?.model,
    }),
  );
  const modelTitle = $derived.by(() => {
    const ran = app.agentTurn?.model ? ` — last turn ran ${app.agentTurn.model}` : "";
    // Backlog 214: open during a turn, and says when a pick lands.
    const next = locked ? " — a pick now applies from the next turn" : "";
    return agentMode
      ? `Model — ${mod}${shift}F / O / S / H pick an alias from anywhere; ${mod}M opens the rail${ran}${next}`
      : `Model — ${mod}${shift}1…9 pick from the picker anywhere; ${mod}M opens the rail${next}`;
  });
  /** The CLI's effort levels (backlog 076), *default* (no flag) first. */
  const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
  // Item 666: an alias reads the row of the model the CLI last ran it as on this CLI version
  // (`modelSeen`, item 511); before the first turn on it, the table's newest-first rule.
  const effortDefaultText = $derived(
    effortDefaultLabel(
      "claude-code",
      effortModel(
        app.draft.agentModel,
        modelSeen.byAlias,
        currentCliVersion(cli.status?.installed, app.connection?.agent?.version),
      ),
    ),
  );
  const effortLabel = $derived(app.draft.agentEffort || `default · ${effortDefaultText}`);
  function pickEffort(e: string) {
    if (e === app.draft.agentEffort) return;
    app.draft.agentEffort = e;
    void applyDraft();
  }
  const thinkingSup = $derived(thinkingSupport(app.draft.provider, app.draft.model));
  /** `effort: low` → `low`, `budget…` → `budget`: the rail's short form. */
  function seg(label: string): string {
    return label.replace(/^effort:\s*/, "").replace(/…$/, "");
  }
  const thinkingLabel = $derived(
    seg(thinkingSup.choices.find((c) => c.value === app.draft.thinkingMode)?.label ?? app.draft.thinkingMode),
  );
  function pickThinking(v: string) {
    if (v === app.draft.thinkingMode) return;
    app.draft.thinkingMode = v;
    void applyDraft();
  }
  /** The rail, on its Model section — the menus' last row, and *other…*. */
  function openRail() {
    app.showContext = false;
    app.railScrollTo = "model";
    app.showRail = true;
  }
  /** *other…* (item 513, his report): the rail opens with its Id field
   *  shown and focused, not only the Model section. */
  function openRailOther() {
    openRail();
    window.dispatchEvent(new CustomEvent(MODEL_OTHER));
  }

  interface MenuRow {
    id: string;
    label: string;
    /** The dim clause after the label. */
    detail?: string;
    /** The chord that does the same from anywhere, as a key cap. */
    cap?: string | null;
    on?: boolean;
    /** The hover's text. */
    title?: string;
    /** A thin rule above the row. */
    sep?: boolean;
    run: () => void;
  }
  /*
   * The numbers behind the aliases (item 511): what each one resolved to on
   * the CLI now, learned from turns (`modelSeen`), and each family's newest
   * model by full id — the API's list when Settings already fetched it on a
   * key, else the table shipped here; no call is made for the menu.
   */
  const cliNow = $derived(currentCliVersion(cli.status?.installed, app.connection?.agent?.version));
  const newestIds = $derived(newestModels(app.modelLists["anthropic"]));
  function aliasRow(a: string, cur: string): { detail: string; title: string } {
    const v = aliasView(modelSeen.byAlias, a, cliNow);
    const newest = v.current && newestIds.includes(v.current.id) ? ` — the newest ${displayName(v.current.id).split(" ")[0]}` : "";
    const current = a === cur ? " · current" : "";
    return { detail: `${v.detail}${current}`, title: `${v.title}${newest}` };
  }
  /** Item 777: a row's price for switching to it while the cache is warm —
   *  the menu says it before he picks (`switchDetail`); "" on the cache's
   *  own model, a cold cache or no reply. */
  function switchPrice(pick: string): string {
    if (!onClaudeCode || !chatCache) return "";
    const id = modelIdFor(pick, modelSeen.byAlias);
    // Item 959: a row whose model an aside wrote the chat on is warm, cold chat or not.
    const side = !aside && kwChat && id ? sideCacheFor(asidesOf(kwChat), id, newestReplySentAt(app.events), now) : null;
    if (!chatCache.warm && !side) return "";
    if (id) void loadCacheRates(id);
    return switchDetail(lastReply(app.events)?.usage ?? null, lastReply(app.events)?.model ?? null, id, cacheRatesOf(id), chatCache.warm, !!side, draftTokens);
  }
  /** The price ahead of a row's detail (`· claude-opus-5-5 · …`). */
  const withPrice = (price: string, detail: string): string => {
    if (!price) return detail;
    const rest = detail.replace(/^·\s*/, "").trim();
    return rest ? `· ${price} · ${rest}` : `· ${price}`;
  };
  const modelRows = $derived.by((): MenuRow[] => {
    const rows: MenuRow[] = [];
    if (agentMode) {
      const cur = app.draft.agentModel.trim();
      // ~~"whatever the CLI defaults to" / "current · the CLI resolves it"~~
      // — item 511: the model each resolved to on this CLI, or not yet.
      const dv = aliasRow("", cur);
      rows.push({ id: "default", label: "default", detail: withPrice(switchPrice(""), dv.detail), title: dv.title, on: cur === "", run: () => void switchModel("") });
      // ~~One row per alias (`fable · Fable 5.1`), then each family's newest
      // by full id unless an alias already shows it (511)~~ — item 518: one
      // row per family, `Fable 5.2`, picking the full id, the alias noted
      // when it lags; the alias's own row only while the chat is on it.
      const full = familyRows(AGENT_PILLS, newestIds, modelSeen.byAlias, cliNow, cur);
      let firstNewest = true;
      for (const f of full) {
        const sep = f.kind === "newest" && firstNewest;
        if (f.kind === "newest") firstNewest = false;
        rows.push({ id: f.key, label: f.label, detail: withPrice(switchPrice(f.pick), f.detail), title: f.title, cap: f.capAlias ? agentKey(f.capAlias) : null, on: f.on, sep, run: () => void switchModel(f.pick) });
      }
      // A full id typed into the rail's field: named here, changed there.
      // ~~`!AGENT_PILLS.includes(cur)`~~ — and no newest row names it (511);
      // no row at all is on (518).
      const other = otherOnRows(cur, full);
      rows.push({ id: "other", label: other ? cur : "other…", detail: other ? "a full id — the rail's field" : "a full id, typed in the rail", on: other, run: openRailOther });
    } else {
      models.forEach((m, i) =>
        rows.push({
          id: m,
          label: m,
          cap: i < 9 ? `${mod}${shift}${i + 1}` : null,
          on: m === app.draft.model,
          run: () => void switchModelAt(i + 1),
        }),
      );
      if (models.length === 0) rows.push({ id: "none", label: "no models in the picker", detail: "type an id in the rail", run: openRail });
    }
    rows.push({ id: "rail", label: "Model and tasks…", detail: "the rail", cap: `${mod}M`, run: openRail });
    return rows;
  });
  const effortRows = $derived.by((): MenuRow[] =>
    agentMode
      ? EFFORTS.map((e) => ({
          id: e || "default",
          label: e || "default",
          detail: e
            ? `--effort ${e}`
            : effortDefaultText === "?"
              ? "no flag · the model's own, which the docs do not name for this model"
              : `· ${effortDefaultText} — no flag, the model's own`,
          on: e === app.draft.agentEffort,
          run: () => pickEffort(e),
        }))
      : thinkingSup.choices.map((c) => ({
          id: c.value,
          label: seg(c.label),
          detail: c.value === "budget" ? `${app.draft.budget} tokens — the amount is set in the rail` : undefined,
          on: c.value === app.draft.thinkingMode,
          run: () => pickThinking(c.value),
        })),
  );

  /*
   * The aside's own pickers (backlog 283): the chat's model and effort
   * unless he picks one for this aside — the first row, "the chat's", is
   * the default and puts it back. Kept on the thread (`aside.model`,
   * `aside.effort`, written with it), sent with each question
   * (`asideWire`); the chat's own pick is untouched. Another model than
   * the chat's cannot read the chat's prompt cache, so its first answer
   * pays to read the whole context: the row says so.
   */
  // Item 657 (his "idk why its like this w the full slug"): ~~the raw id,
  // `chat's · claude-opus-5-5`~~ — the model's name, `Opus 5.5`, as the
  // chat's own button reads (`modelChipLabel`); an alias stays as it is.
  const chatModelName = $derived(app.draft.agentModel.trim() ? displayName(app.draft.agentModel) : "default");
  // Item 705: the *Next chat* pick's rows, one per family as the model menu
  // draws them; the main box is their one writer, the reply's card reads them.
  $effect(() => {
    if (aside || !agentMode) return;
    const fams = familyRows(AGENT_PILLS, newestIds, modelSeen.byAlias, cliNow, "").map((f) => ({
      key: f.key,
      pick: f.pick,
      label: f.label,
      detail: f.detail.replace(/ · current.*$/, "").replace(/^·\s*/, ""),
    }));
    nextModelMenu.chatName = chatModelName;
    nextModelMenu.families = fams;
  });
  const chatEffortName = $derived(app.draft.agentEffort || `default · ${effortDefaultText}`);
  const asideModelLabel = $derived(aside?.model ? displayName(aside.model) : `chat's · ${chatModelName}`);
  // Item 644: the family of the model this box sends to, live with the pickers (the chip's choice).
  const family = $derived(
    modelFamily(
      composerModelId({
        agentMode,
        agentModel: app.draft.agentModel,
        model: app.draft.model,
        connected: app.connection?.model,
        asideModel: aside?.model ?? null,
      }),
    ),
  );
  const asideEffortLabel = $derived(
    aside && aside.effort != null ? aside.effort || "default" : `chat's · ${chatEffortName}`,
  );
  // Item 833 (his shots, 2026-11-17: both pickers read "chat's …" in a
  // narrow aside card): the pickers' compact form, the value alone —
  // `Opus 5.5`, `medium` — drawn from fold level 4 instead of cutting the
  // long label at 72 / 48 px. The long label leads each tooltip.
  const asideModelShort = $derived(aside?.model ? displayName(aside.model) : chatModelName);
  const asideEffortShort = $derived(
    aside && aside.effort != null
      ? aside.effort || "default"
      : app.draft.agentEffort || (effortDefaultText === "?" ? "default" : effortDefaultText),
  );
  const asideModelTitle = $derived(
    `This aside's model: ${asideModelLabel} — the chat's (${chatModelName}) unless picked here. Another model cannot read the chat's prompt cache, so its first answer reads the whole context fresh.`,
  );
  function pickAside(field: "model" | "effort", v: string | null): void {
    const a = aside;
    if (!a) return;
    if (v === null) delete a[field];
    else a[field] = v;
    scheduleAsideSave();
  }
  const asideModelRows = $derived.by((): MenuRow[] => {
    const cur = aside?.model ?? null;
    const rows: MenuRow[] = [
      { id: "chat", label: "the chat's", detail: `${chatModelName} · reads the chat's cache`, on: cur === null, run: () => pickAside("model", null) },
    ];
    // ~~One row per alias, its number after it (511)~~ — item 518: one row
    // per family, as the chat's own menu; the row the chat's model is on
    // says so.
    const chatRow = familyRows(AGENT_PILLS, newestIds, modelSeen.byAlias, cliNow, app.draft.agentModel).find((f) => f.on)?.key;
    const fams = familyRows(AGENT_PILLS, newestIds, modelSeen.byAlias, cliNow, cur ?? "");
    for (const f of fams) {
      rows.push({
        id: f.key,
        label: f.label,
        title: f.title,
        detail: `${f.detail.replace(/ · current.*$/, "")} · ${f.key === chatRow ? "the chat's model, picked for this aside" : "its own model — no cache from the chat"}`,
        on: cur !== null && f.on,
        run: () => pickAside("model", f.pick),
      });
    }
    if (cur !== null && otherOnRows(cur, fams)) rows.push({ id: cur, label: cur, on: true, run: () => {} });
    return rows;
  });
  const asideEffortRows = $derived.by((): MenuRow[] => {
    const cur = aside?.effort ?? null;
    return [
      { id: "chat", label: "the chat's", detail: chatEffortName, on: cur === null, run: () => pickAside("effort", null) },
      ...EFFORTS.map((e) => ({
        id: e || "default",
        label: e || "default",
        detail: e ? `--effort ${e}` : "no flag, the model's own",
        on: cur === e,
        run: () => pickAside("effort", e),
      })),
    ];
  });
  const boxPlaceholder = $derived(
    !aside
      ? // The new-chat page's box (`floating`, Welcome) under Filament IV
        // asks the mockup's question (f4-new.png, item 570); Classic keeps
        // its words.
        floating && !classic()
        ? "What are we making?"
        : "Message…"
      : aside.draft
        ? aside.quote
          ? "Ask about the passage… (↵ asks)"
          : "Ask aside… (↵ asks)"
        : "Follow up in the aside… (↵ asks)",
  );
  const asideSendTip = $derived(
    asideBlock === "not-open"
      ? `Sends only while ${asideChatName} is the open chat — an aside answers from its context`
      : asideBlock === "engine"
        ? "Asides run on the Claude Code engine"
        : aside?.draft
          ? "Ask this off the chat's context: no changes to the chat, recorded nowhere"
          : "Continue the aside: the exchanges above go with this question, off the chat's context; recorded nowhere",
  );

  /**
   * One menu open at a time. It closes on a pick, on ⎋ (focus back on its
   * button), on Tab, and on a click anywhere else — the top bar's rule for
   * its popover. ↑↓ move through the rows, ↵ or Space pick the focused one
   * (the rows are buttons, so the keys are the browser's). Opening puts
   * the focus on the current row, so the keyboard lands where the pick is.
   */
  /**
   * The draft history (nightshift backlog 158): the last ten texts that
   * left this box — sent, queued, or replaced by a paste — newest first,
   * each a row of its first line and when; a click puts it back in front
   * of whatever is typed. Kept per composer key in `drafts.svelte.ts`.
   */
  const history = $derived(historyFor(key));
  const historyRows = $derived.by((): MenuRow[] =>
    history.map((s, i) => ({
      id: `${s.at}:${i}`,
      label: firstLine(s.text) || "(no first line)",
      detail: `${whenLabel(s.at)} · ${s.text.length.toLocaleString()} chars`,
      run: () => {
        restoreDraft(key, i);
        requestAnimationFrame(autogrow);
      },
    })),
  );
  /**
   * Item 724: the rewound message, offered alone just above the drafts
   * button when a rewind found his draft in the box — the drafts list's
   * own look, with one row. A click swaps it in (his text to the drafts);
   * a click anywhere else, or another menu, closes it; the drafts button
   * still lists it with the rest.
   */
  const offerRows = $derived.by((): MenuRow[] =>
    rewoundOffer.key === key && rewoundOffer.text
      ? [
          {
            id: `rewound:${rewoundOffer.seq}`,
            label: firstLine(rewoundOffer.text) || "(no first line)",
            detail: `rewound · ${rewoundOffer.text.length.toLocaleString()} chars`,
            title: "Put the rewound message in the box — what you typed goes to drafts",
            run: takeRewound,
          },
        ]
      : [],
  );
  function takeRewound(): void {
    const t = rewoundOffer.text;
    dismissRewoundOffer(key);
    const swap = takeOffered(readDraft(key).text, t);
    if (swap.toDrafts) bumpDraft(key, swap.toDrafts);
    setDraftText(key, swap.box);
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      autogrow();
    });
  }
  // A new offer for this box opens it, without taking the focus from the
  // box he is typing in. Only an offer made while mounted.
  let offerSeen = untrack(() => rewoundOffer.seq);
  $effect(() => {
    const seq = rewoundOffer.seq;
    if (seq === offerSeen) return;
    offerSeen = seq;
    if (rewoundOffer.key !== key) return;
    void tick().then(() => {
      if (rewoundOffer.key === key && historyBtn) menu = "rewound";
    });
  });
  // The popover gone any way (a click elsewhere, another menu, a chat
  // switch): the offer goes with it — the message stays in the drafts.
  let offerShown = false;
  $effect(() => {
    const on = menu === "rewound";
    if (offerShown && !on) untrack(() => dismissRewoundOffer());
    offerShown = on;
  });
  function whenLabel(at: string): string {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return "earlier";
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = clockText(t); // 12-hour whatever the locale (item 611b; was "02:05 PM" / "14:05")
    return sameDay ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
  }

  /**
   * The toolbar row's folds, by measurement (nightshift backlog 190, with
   * 183's `fold.ts`): his screenshot of the project home, 2026-09-22 —
   * Send alone on a second row under Attach · model · effort · Council.
   * Send stays on row one; the other controls shed first. Level 1: the
   * pickers' key words ("effort", "thinking", "drafts"). Level 2: Attach
   * to its icon, Ask aside to "Aside". Level 3: the model's and effort's
   * values ellipsize at 72 px. Level 4, the floor: the pickers give row
   * one to the actions (Ask aside, Council, Send / Queue, Stop) and take a
   * row of their own beneath, folded as at level 3. Every shed word is in its button's title.
   */
  // Item 289 (2026-10-02): ~~4~~ 6 levels. Levels 1–3 saved almost nothing
  // once the model and effort names were short, so the row hit the floor
  // (two rows) at ~580 px on the new-chat page. Now, in order: 1 the
  // pickers' key words; 2 the draft's token estimate (its figure is in
  // Send's hover); 3 Attach to its icon, Ask aside to "Aside", Council to
  // its icon; 4 the pickers' values at 72 px; 5 at 48 px; 6 the floor —
  // pickers on row one at the left, the actions on row two at the right,
  // both rows the same height.
  // 2026-11-19 (his "why does it not say how many tokens are in my msg anymore"): the token
  // estimate now folds last before the floor (level 5); Attach/Ask aside/Council shrink at 2.
  const ROW_FOLD_MAX = 6;
  let rowEl = $state<HTMLElement | null>(null);
  let rowFold = $state("0");
  function refoldRow(): void {
    const row = rowEl;
    if (!row) return;
    rowFold = String(
      foldToFit(row, () => [...row.children].filter((e) => !e.classList.contains("spacer")), ROW_FOLD_MAX),
    );
  }
  $effect(() => {
    const row = rowEl;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refoldRow());
    ro.observe(row);
    return () => ro.disconnect();
  });
  $effect(() => {
    // What the row holds; each read registers the dependency.
    void [
      modelLabel,
      effortLabel,
      thinkingLabel,
      // Item 833: an aside's pickers read these.
      asideModelLabel,
      asideEffortLabel,
      agentMode,
      history.length,
      app.busy,
      busy,
      app.parked,
      app.connection?.engine,
      app.events.length > 0,
      estimate !== null,
      shown?.long,
    ];
    refoldRow();
  });

  let menu = $state<"model" | "effort" | "history" | "rewound" | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let modelBtn = $state<HTMLElement | null>(null);
  let effortBtn = $state<HTMLElement | null>(null);
  let historyBtn = $state<HTMLElement | null>(null);
  const menuRows = $derived(
    menu === "model"
      ? aside
        ? asideModelRows
        : modelRows
      : menu === "effort"
        ? aside
          ? asideEffortRows
          : effortRows
        : menu === "history"
          ? historyRows
          : menu === "rewound"
            ? offerRows
            : [],
  );
  function menuButton(): HTMLElement | null {
    return menu === "model" ? modelBtn : menu === "effort" ? effortBtn : menu === "history" || menu === "rewound" ? historyBtn : null;
  }
  function openMenu(which: "model" | "effort" | "history") {
    menu = menu === which ? null : which;
    if (!menu) return;
    requestAnimationFrame(() => {
      const rows = menuEl?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [];
      const i = Math.max(0, menuRows.findIndex((r) => r.on));
      rows[i]?.focus();
    });
  }
  function closeMenu(back: "button" | "box" | null) {
    const btn = menuButton();
    menu = null;
    if (back === "button") btn?.focus();
    else if (back === "box") ta?.focus();
  }
  function runRow(r: MenuRow) {
    closeMenu("box");
    r.run();
  }
  function onMenuKey(e: KeyboardEvent) {
    const rows = Array.from(menuEl?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = rows.length;
      if (n === 0) return;
      const next = e.key === "ArrowDown" ? (at + 1) % n : (at - 1 + n) % n;
      rows[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      rows[e.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
      // Picked here rather than left to the button's own key-to-click,
      // so the row goes on keydown on every platform and the ↵ never
      // reaches the box under the menu.
      e.preventDefault();
      rows[at].click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu("button");
    } else if (e.key === "Tab") {
      // The menu lives at the end of `body` since backlog 210, so Tab from
      // it would leave the composer: it goes from the button instead, as
      // it did when the menu sat beside it (Shift+Tab lands on the button).
      if (e.shiftKey) e.preventDefault();
      closeMenu("button");
    }
  }
  function onMenuDocClick(e: MouseEvent) {
    const t = e.target as Node;
    if (menuEl?.contains(t) || menuButton()?.contains(t)) return;
    menu = null;
  }
  $effect(() => {
    if (!menu) return;
    document.addEventListener("mousedown", onMenuDocClick, true);
    return () => document.removeEventListener("mousedown", onMenuDocClick, true);
  });
  // A chat or engine switch under an open menu closes it: the rows it
  // drew were the old one's.
  $effect(() => {
    void key;
    void agentMode;
    menu = null;
  });

  /*
   * The bottom row (backlog 112, direction C): thinking · tools · cache
   * under the box, moved whole from the top bar. The two are the
   * transcript toggles of backlog 052 — every thinking block open or a
   * pill, every tool call the full block or one line — with their ⌘⇧T /
   * ⌘⇧B, which `App.svelte` still binds; the chip is the cache's share and
   * backlog 063's timer. Docked only: the floating box has no transcript
   * to fold and no turn to have cached.
   */
  const shiftKey = isMac ? "⌘⇧" : "Ctrl+Shift+";
  // What a prior turn's thinking costs (nightshift backlog 066, measured
  // 2026-09-16 on his account, CLI 2.1.263): on Haiku 4.5 the thinking of
  // an earlier turn is sent and billed with every later request; on Opus 5
  // one turn could not separate it (nightshift blocker 079). There is no
  // thinking editor; this is the one place the transcript says what the
  // folded block costs.
  const THINKING_COST_NOTE =
    ". A prior turn's thinking is still sent and billed on later turns (measured on Haiku 4.5 via Claude Code; unverified on Opus 5).";
  // The chip reads disabled when the toggle has nothing to open (nightshift
  // backlog 097, 2026-09-16): every recorded thinking block is empty, or
  // nothing has thought yet and the Claude Code engine is on a model that
  // omits its thinking. ⌘⇧T and the palette row gate on the same function.
  const thinkingDead = $derived(thinkingToggleDead(app.events, app.connection));

  const cached = $derived(cacheHitRate());
  /**
   * The prompt-cache timer (nightshift backlog 063, 2026-09-15): when the
   * last turn's cache entry expires, read off the log — each turn records
   * when its request was sent and the lifetime of the cache it left, on
   * both engines — so reopening a chat shows the countdown it had. The
   * clock is a chain of timeouts aligned to when the text would change
   * (once a minute, once a second under two minutes; `nextTickMs`), so it
   * wakes as rarely as the display allows and never shows a value a
   * second stale. The toast on the crossing to cold is the top bar's
   * still, whichever view is up — this chain only draws.
   */
  let now = $state(Date.now());
  /*
   * Keep-warm (backlog 582): the open chat's switch, beside the timer it
   * extends. A ping's read restarts the cache's hour, so the timer counts
   * from the later of the reply and the last ping.
   */
  // Item 786: an aside's box keeps its chat's cache — the same switch and
  // chip, read off the chat it forks — while that chat is the open one
  // (an aside of another chat cannot send, and its log is not loaded).
  const kwChat = $derived(floating ? null : aside ? (asideOpen ? asideOwner : null) : app.activeSessionId);
  const kw = $derived(kwChat ? (keepWarm.byChat[kwChat] ?? null) : null);
  $effect(() => {
    if (kwChat) void loadKeepWarm(kwChat);
  });
  async function flipKeepWarm(mode: "on" | "once" | "off") {
    if (!kwChat) return;
    const refused = await setKeepWarm(kwChat, mode);
    if (refused) addToast(`Keep warm: ${refused}`);
  }
  // Item 643: right-click or hold the switch → 6 h / 12 h / 24 h for this chat.
  let kwButton: HTMLElement | null = $state(null);
  let kwHoldOpen = $state(false);
  async function holdFor(hours: number) {
    kwHoldOpen = false;
    if (!kwChat) return;
    const refused = await holdKeepWarm(kwChat, hours);
    if (refused) addToast(`Keep warm: ${refused}`);
  }
  /** Item 786: an aside on another model than the chat's reads none of the
   *  chat's cache; its own answers write and read that model's. */
  const asideOwnModel = $derived(!!aside?.model && displayName(aside.model) !== chatModelName);
  const chatCache = $derived(
    floating || (aside && !kwChat)
      ? null
      : aside && asideOwnModel
        ? ownModelCache(aside.turns, now)
        : cacheState(app.events, now, touchedUntil(kw), asideReads(kwChat, lastReply(app.events)?.model)),
  );
  /** Item 959: the chat's own composer with a switch to another model
   *  pending, where an aside on that model wrote the chat's prefix there
   *  (`sideCacheFor`): the next send reads it, so the chip shows that
   *  entry — warm, its hour — and the switch is priced as a read. */
  const sideCache = $derived(
    !aside && !floating && kwChat && chatCache && app.connection?.engine === "claude-code" && modelSwitchPending(app.events, app.draft.agentModel, modelSeen.byAlias)
      ? sideCacheFor(asidesOf(kwChat), modelIdFor(app.draft.agentModel, modelSeen.byAlias), newestReplySentAt(app.events), now)
      : null,
  );
  /** The cache the next send meets: the side entry above, else the chat's. */
  const cache = $derived(sideCache ?? chatCache);
  /** Item 786: the chat's own turn stopped before its reply was logged —
   *  a cold reading is unknown until the next send. */
  const cacheUnsure = $derived(!aside && !!cache && !cache.warm && stoppedUnsure(app.events, app.busy));
  const face = $derived(chipFace(cache, cacheUnsure));
  /** Item 786: the share an aside's newest answer read, for its chip. */
  const asideHit = $derived(aside ? asideFigures(aside, now).cacheHit : null);
  /**
   * Item 699: what the next send costs at API prices — the history read
   * back while warm, all of it written once cold — at the newest reply's
   * model's rates (Claude Code: `usage-rates.json` or the ping fit; the
   * API engine: the connection's price). Null with no rates: no figure.
   */
  const lastModel = $derived(floating || !cache ? null : (lastReply(app.events)?.model ?? null));
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  $effect(() => {
    if (lastModel && onClaudeCode) void loadCacheRates(lastModel);
  });
  // Item 777: at the rates of the model the next send goes to (`targetRates`,
  // below) — a cold chip with a model switch pending prices the new model,
  // and says the change itself costs nothing extra.
  const nextEst = $derived.by(() => {
    if (!cache) return null;
    // Item 902: a pending model switch writes everything, warm or not.
    const est = cacheEstimate(app.events, targetRates, cache.warm && !modelSwitch, draftTokens);
    if (!est || cache.warm || !coldPending) return est;
    // Item 933: cold already, so nothing is lost — `cold either way ≈ $X`.
    return { ...est, line: coldEitherWay(est.line) };
  });
  /** Item 596: the same state drawn on the box's frame (`cacheLook.css`). */
  const frame = $derived(cacheFrame(cache));
  /*
   * Item 768: the chat's own composer only (not an aside's, not the new-chat
   * page's), on the engine whose hand-off this is. The figures are the
   * cache chip's rates (item 699) on the newest reply's usage.
   */
  const wwChat = $derived(!aside && !floating && onClaudeCode ? app.activeSessionId : null);
  const wwUsage = $derived(wwChat ? (lastReply(app.events)?.usage ?? null) : null);
  const wwContext = $derived(contextOf(wwUsage));
  // Item 902: at the rates of the model the next send goes to (the
  // composer's pick), never the last reply's — a switch re-prices both
  // buttons, and a model without rates shows no figure.
  const wwCosts = $derived.by(() => (wwUsage ? chipCosts(wwUsage, targetRates, modelSwitch, draftTokens) : null));
  const wwHandingOff = $derived(!!handedNext || (handoffHere && (handoff.stage === "wrapping" || handoff.stage === "wrapped")));
  const wwBusy = $derived(busy || queue.length > 0);
  /** The warm moment: `offer`, `do` or null; `now` ticks each minute while warm. */
  const warmAct = $derived(
    wwChat && cache && !actedOn(wwChat, cache.warmUntil)
      ? warmWrapAct({
          mode: warmWrap.mode,
          minTokens: warmWrap.minTokens,
          context: wwContext,
          warmUntil: cache.warmUntil,
          now,
          keeping: isKeeping(kw, now),
          busy: wwBusy,
          // Past the mark the hand-off notice is up and carries Wrap up now itself.
          handingOff: wwHandingOff || (handoffHere && handoff.stage === "due"),
          // A "never" mark or a *Stay here* in this chat: offered, never sent.
          never: neverHandsOff(wwChat) || (handoffHere && handoff.dismissedAt > 0),
          away: untrack(() => awayNow(true, now)),
        })
      : null,
  );
  /** Sent at most once per cache end: the mark is set before the send. */
  $effect(() => {
    if (warmAct !== "do" || !wwChat || !cache) return;
    const [chat, until] = [wwChat, cache.warmUntil];
    untrack(() => {
      markActed(chat, until);
      // Under the mark the stage stays idle; the reply's next-chat card
      // (item 506) reads the reply, not the stage, so the way on is the same.
      addToast(sentToast(wwCosts));
      void sendWrapUpNow();
    });
  });
  const coldChip = $derived(
    !!wwChat &&
      !!cache &&
      coldChipShows({
        minTokens: warmWrap.minTokens,
        context: wwContext,
        warm: cache.warm,
        busy: wwBusy,
        handingOff: wwHandingOff,
        noticeUp: handoffHere && handoff.stage === "due",
        kept: keptCold(wwChat, cache.warmUntil),
      }),
  );
  const coldWords = $derived(coldButtons(wwCosts));
  $effect(() => {
    if (floating) return;
    const chatUntil = cacheState(app.events, Date.now(), touchedUntil(kw), asideReads(kwChat, lastReply(app.events)?.model))?.warmUntil ?? null;
    // Item 959: an aside's entry on the picked model ticks the chip too (not through `now`, which this sets).
    const sideUntil =
      !aside && kwChat && app.connection?.engine === "claude-code" && modelSwitchPending(app.events, app.draft.agentModel, modelSeen.byAlias)
        ? (sideCacheFor(asidesOf(kwChat), modelIdFor(app.draft.agentModel, modelSeen.byAlias), newestReplySentAt(app.events), Date.now())?.warmUntil ?? null)
        : null;
    const warmUntil = chatUntil == null ? sideUntil : sideUntil == null ? chatUntil : Math.max(chatUntil, sideUntil);
    if (warmUntil == null) return;
    now = Date.now();
    let id: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const t = Date.now();
      now = t;
      const wait = nextTickMs(warmUntil - t);
      if (wait == null) return;
      id = setTimeout(tick, wait);
    };
    const first = nextTickMs(warmUntil - Date.now());
    if (first != null) id = setTimeout(tick, first);
    return () => {
      if (id != null) clearTimeout(id);
    };
  });
  /**
   * Backlog 408 (2026-10-24): what the warm cache was built with, and the
   * rail's pending settings that would lose it — only the changes measured
   * to (`cacheLoss`). While any stands, the chip says so and a click puts
   * them back; offered only while the cache is warm, since a cold cache
   * has nothing left to lose.
   */
  // Item 786: an aside's box warns of none: the rail's pending settings are
  // the chat's next turn's, not the aside's (its model shows on its chip).
  const cacheBuilt = $derived(floating || aside ? null : cacheBuiltWith(app.events));
  // Item 601: and what the next turn carries beside the draft — the
  // chat's declared kind then and now, and the API engine's resolved model.
  const cacheChanges = $derived(
    cacheBuilt && cache?.warm
      ? cacheLoss(cacheBuilt.key, app.draft, {
          kind: declaredKind(app.events),
          builtKind: kindAtCache(app.events),
          apiModel: app.connection && app.connection.engine !== "claude-code" ? app.connection.model : undefined,
          // Item 959: the model switch onto an aside's warm entry loses nothing.
        }).filter((c) => !(sideCache && c.what === "model"))
      : [],
  );
  /*
   * Item 777: what the pending change costs on the next send, with it
   * against without it (`changePrice`). The model it goes to: on Claude
   * Code a draft model other than the cache's, by its own rates (an alias
   * by what it last resolved to; unknown → tokens, no figure); on the API
   * engine the connection, which already carries the picked model's price.
   * A prompt-layer change logged since the cache's reply (notes, practices,
   * memory, a layer's own text) is priced from the system block on.
   */
  const targetModel = $derived(cache ? nextSendModel(app.events, aside?.model || app.draft.agentModel, modelSeen.byAlias) : null);
  /** Item 902: the next send goes to another model than built the cache. */
  const modelSwitch = $derived(
    // An aside on its own model prices its own cache (item 786), not the chat's.
    !!cache && !floating && onClaudeCode && !(aside && asideOwnModel) && !sideCache && modelSwitchPending(app.events, aside?.model || app.draft.agentModel, modelSeen.byAlias),
  );
  /** Item 902: the banner's "<model> has no cache of it". */
  const switchName = $derived(modelSwitch ? displayName(aside?.model || app.draft.agentModel) || "the new model" : null);
  $effect(() => {
    if (targetModel && onClaudeCode) void loadCacheRates(targetModel);
  });
  const targetRates = $derived(onClaudeCode ? cacheRatesOf(targetModel) : ratesFromPrice(app.connection?.price));
  const layerChange = $derived(cacheBuilt ? layerChangeSinceCache(app.events) : null);
  /** A change pending on a cold cache: costs nothing extra (the chip says so). */
  const coldPending = $derived(
    !!cacheBuilt &&
      !!cache &&
      !cache.warm &&
      (!!layerChange ||
        cacheLoss(cacheBuilt.key, app.draft, {
          kind: declaredKind(app.events),
          builtKind: kindAtCache(app.events),
          apiModel: app.connection && app.connection.engine !== "claude-code" ? app.connection.model : undefined,
        }).length > 0),
  );
  // One rule with the rail's *Next send* row (`pendingChangeCost`).
  const changeCost = $derived(
    cache?.warm
      ? pendingChangeCost({
          events: app.events,
          draft: app.draft,
          connection: app.connection,
          seen: modelSeen.byAlias,
          warm: true,
          rates: (m) => {
            if (m && onClaudeCode) void loadCacheRates(m);
            return cacheRatesOf(m);
          },
          sideWarm: !!sideCache,
          draftTokens,
        })
      : null,
  );
  /** The bar's words: the draft changes, then a logged layer change. */
  const lossWords = $derived([...cacheChanges.map((c) => c.text), ...(layerChange ? [layerChange.text] : [])]);
  /** The bar's tooltip, two short lines (776's rule) with 777's with-change
   *  price: `<changes> changed · next ≈ $X (vs $Y warm)` / the click clause. */
  const lossTip = $derived.by(() => {
    if (!cache || !cacheBuilt) return "";
    // Post-install 16c8e01: the price first, then what the click actually
    // does (shortTip.ts `lossClick`): a layer change is the Context page's,
    // so with one pending the click never promises to undo it. The bar's
    // face names the change and the chip the time left.
    return lossTipText({
      changes: cacheChanges,
      layer: !!layerChange,
      cachedTokens: cacheBuilt.cachedTokens,
      priceLine: changeCost?.line ?? null,
      resendUsd: nextEst?.cold ?? null,
    });
  });
  function restoreCache() {
    if (!cacheBuilt || cacheChanges.length === 0 || !canRestore(cacheChanges)) return;
    const engine = restoreEngine(cacheBuilt.key, cacheChanges);
    restoreCacheSettings(cacheBuilt.key, cacheChanges, app.draft);
    // An engine switch back reconnects through `useEngine` (it drops the
    // other engine's connection first); everything else through the draft.
    if (engine === "claude-code" || engine === "provider") void useEngine(engine);
    else void applyDraft();
  }
  /**
   * The chip's tooltip, at most two short lines, numbers first (item 776,
   * his "dude this is the biggest yapfest ever i thought we talked about
   * this wtf"): `95% from cache · warm for 31 min more`, then the estimate's
   * line. ~~What the share means, the 1-hour rule, the subscription "free"
   * caveat~~ (cut 2026-11-16).
   */
  const cacheTitle = $derived.by(() => {
    const hit = aside ? asideHit : cached;
    const share = hit != null ? `${Math.round(hit * 100)}% from cache` : null;
    if (!cache) return `${share ?? "Cache"} · no timer: this chat's last turn predates cache timing`;
    // Item 786: what a stop or an aside left, in the chip's two lines.
    if (face === "unknown") return `Unknown until the next send (a stopped turn)\n${nextEst?.title ?? "Cold, the next send writes it again"}`;
    if (!cache.warm && aside && asideOwnModel) return `Own model · no cache from the chat\n${nextEst?.title ?? "The next answer writes it"}`;
    // Item 933: every aside's reads (no chat model) — one on another model kept its own copy.
    if (!cache.warm && !aside && asideSinceCold(cache, asideReads(kwChat))) return `${ASIDE_COLD_TIP}\n${nextEst?.title ?? "The next send writes it again"}`;
    if (!cache.warm) return nextEst?.title ?? "Cache cold · the next send writes it again";
    const left = remainingText(cache.remainingMs);
    // Item 959: the entry an aside on the picked model wrote.
    if (cache.sideModel) return `Warm on ${displayName(cache.sideModel)} for ${left} more · an aside on it wrote this chat\n${nextEst?.title ?? ""}`.trim();
    const refreshed = !aside && cache.asideShare != null ? " (an aside refreshed it)" : "";
    const first = share ? `${share} · warm for ${left} more${refreshed}` : `Cache warm for ${left} more${refreshed}`;
    return nextEst ? `${first}\n${nextEst.title}` : first;
  });
</script>

<div
  bind:this={root}
  class="composer"
  class:floating
  class:aside={aside !== null}
  class:compact
  class:dropping={dragDepth > 0}
  class:hc-grip={handoffCardUp}
  data-drop-box={aside ? "aside" : "main"}
  data-drop-for={aside ? key : undefined}
  data-composer-row={composerRow.value}
  data-model-family={family}
  role="group"
  aria-label={aside ? "aside composer" : "message composer"}
  {ondragenter}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  {#if !floating}
    <ResizeHandle
      edge="top"
      {dragging}
      label="Composer height"
      value={floorPx ?? undefined}
      hint={handoffCardUp
        ? "Drag down to shrink the hand-off card (compact, then one line), then the box · up to grow them · double-click resets the box"
        : floorPx === null && capPx === null
        ? "Drag to resize · double-click to reset (⌥⌘↑ / ⌥⌘↓ by a line)"
        : `Drag to resize · double-click to reset — ${floorPx === null ? "automatic" : `${floorPx}px`} for this chat${capPx === null ? "" : `, grows to ${capPx}px`}`}
      ondown={handleDown}
      onreset={handleReset}
    />
  {/if}
  {#if !aside && app.activeSessionId}
    <!-- The chat's preview (item 430): its dev server, up between messages. -->
    <PreviewChip chat={app.activeSessionId} />
    <!-- Claude's browser (item 508): offered once it is live; opens only on his click. -->
    <BrowserChip chat={app.activeSessionId} />
    <!-- The message's usage cap (item 538): only while it runs under one. -->
    <TurnCapChip plain={classic()} />
  {:else if aside && app.activeSessionId}
    <!-- Item 919: the aside's own browser, a tab of its own in the pane. -->
    <BrowserChip chat={asideBrowserSession(app.activeSessionId, aside.uid ?? String(aside.id))} name={asideLabel(aside)} />
  {/if}
  <!-- Item 548: under Filament IV the scheduled message is drawn in the
       transcript as his message (ScheduledBubble); Classic keeps the row. -->
  {#if composerShows("schedule", !!aside) && !onWaitingPage && classic()}
    <ScheduledChip {key} onedit={scheduleEdited} />
  {/if}
  {#if boxQueue.length > 0}
    <div class="queue" role="list" aria-label="queued messages">
      <div class="queue-head">
        <span class="ns-chip mono" data-queue-head>{aside ? `queued · ${asideBusy ? "sent when this answer ends" : asideBlock === "not-open" ? "waiting — open the chat to send" : "waiting"}` : mainHead}</span>
        {#if !busy}
          <button class="ns-btn ghost small" disabled={!app.connection || asideBlock !== null} onclick={() => void drain(true)}>Send next</button>
        {/if}
      </div>
      {#each boxQueue as q, i (q.id)}
        {#if classic()}
        <div class="queue-row" role="listitem" data-queue-id={q.id}>
          <span class="queue-n mono">{i + 1}</span>
          <span class="queue-text" use:tip={q.text} data-find-text={q.text}>{#if handoffHere && q.id === handoff.queuedId}<span class="ns-chip mono" use:tip={"Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. × takes it back."}>wrap-up · queued while you were away</span> {/if}<MathText text={firstLine(q.text) || "(no text)"} />{#if q.attachments.length > 0} <span class="ns-chip mono">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>{/if}</span>
          {#if q.inject}{@const chip = injectChip(q.inject)}<span class="ns-chip mono" data-inject={chip.state} use:tip={chip.tip}>{chip.label}</span>{/if}
          {#if q.inject && q.inject.after === undefined && !q.inject.now}
            <button class="ns-btn ghost small" data-send-now use:tip={"Interrupt and send: stop what Claude is doing (a long answer, a long command) and give it this message at once — as Claude Code's own send now does. The reply so far stays and the turn goes on. Left alone, the message slips in at Claude's next gap."} onclick={() => void sendNowRow(key, q.id)}>interrupt and send</button>
          {/if}
          {#if q.inject?.after === undefined}
            <button class="ns-btn ghost small" use:tip={"Back into the message box"} onclick={() => void takeBack(q.id)}>take back</button>
            <button class="remove" use:tip={"drop this message"} aria-label="drop queued message {i + 1}" onclick={() => void dropRow(q.id)}>×</button>
          {/if}
        </div>
        {:else}
          <!-- Items 548 + 549 (Filament IV): the whole text opens in the row
               ("more"), never as a hover tip across the window; the actions
               are icons with their names as tips. -->
          {@const long = q.text.trim().includes("\n") || q.text.trim().length > 120}
          <div class="queue-row fil" class:open={rowOpen[q.id]} role="listitem" data-queue-id={q.id}>
            <span class="queue-n mono">{i + 1}</span>
            <span class="queue-text" data-find-text={q.text}
              >{#if handoffHere && q.id === handoff.queuedId}<span class="ns-chip mono" use:tip={"Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. × takes it back."}>wrap-up · queued while you were away</span>
              {/if}{#if rowOpen[q.id]}<span class="queue-whole"><MathText text={q.text} /></span>{:else}<MathText text={firstLine(q.text) || "(no text)"} />{/if}{#if q.attachments.length > 0}
                <span class="ns-chip mono">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>{/if}</span
            >
            {#if long}
              <button class="ns-link queue-more" type="button" aria-expanded={!!rowOpen[q.id]} onclick={() => (rowOpen[q.id] ? delete rowOpen[q.id] : (rowOpen[q.id] = true))}
                >{rowOpen[q.id] ? "less" : "more"}</button
              >
            {/if}
            {#if q.inject}{@const chip = injectChip(q.inject)}<span class="ns-chip mono" data-inject={chip.state} use:tip={chip.tip}>{chip.label}</span>{/if}
            <span class="queue-acts">
              {#if q.inject && q.inject.after === undefined && !q.inject.now}
                <WaitAct icon="stop" label="Interrupt and send" hint="stop what Claude is doing (a long answer, a long command) and give it this message at once — as Claude Code's own send now does; the reply so far stays and the turn goes on. Left alone, the message slips in at Claude's next gap" data-send-now="" onclick={() => void sendNowRow(key, q.id)} />
              {/if}
              {#if q.inject?.after === undefined}
                <WaitAct icon="pencil" label="Take back" hint="back into the message box" onclick={() => void takeBack(q.id)} />
                <WaitAct icon="x" label="Drop queued message {i + 1}" hint="do not send it (Undo in the toast brings it back)" onclick={() => void dropRow(q.id)} />
              {/if}
            </span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
  <!-- Item 362: the veil and zone while a file is held over the chat,
       and the landing at the drop; drawn on `body`. Item 674's follow-up:
       an aside's box too, for a file held over its thread. -->
  <DropOverlay root={() => root} accept={(files) => void accept(files)} region={aside ? key : ""} />
  {#if attachments.length > 0}
    <div class="attachments" in:rowIn>
      {#each attachments as a (a.id)}
        <div class="attachment" in:chipIn|global={a} out:chipOut|global={a}>
          <div class="attachment-face">
            {#if a.kind === "image"}
              <!-- Item 467: the thumbnail opens the image in front, as a
                   sent one does (UserBubble's), zooming from here. -->
              <button
                class="image-open"
                class:picked={!!a.pick}
                use:tip={a.pick ? `${a.label ?? "picked element"} — click to see what it holds` : "Open in front"}
                aria-label={a.pick ? `show picked element ${a.name}` : `open ${a.name}`}
                aria-expanded={a.pick ? pickShown === a.id : undefined}
                onclick={(e) => {
                  if (a.pick) {
                    pickShown = pickShown === a.id ? null : a.id;
                    return;
                  }
                  const el = e.currentTarget.querySelector("img");
                  openAttachment(
                    draftImageContent(key, a.id, a.name),
                    e.currentTarget.getBoundingClientRect(),
                    el && el.naturalWidth > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : null,
                  );
                }}
              >
                <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
                {#if a.pick}<span class="pick-mark mono" aria-hidden="true">PICK</span>{/if}
              </button>
            {:else}
              {@const kept = keepStateOf(keepKey(a.name, a.data)).phase === "kept"}
              <!-- Item 459: a kept file's chip opens Notes at that file. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <span
                class="file"
                class:pending={a.pending}
                class:long={!!routeLabel(a, chipEngine)}
                class:kept
                role={kept ? "button" : undefined}
                tabindex={kept ? 0 : undefined}
                use:tip={kept
                  ? `${a.name} — kept in this project: click to show it in Notes`
                  : a.label
                    ? `${a.name} — ${a.pending ? "converting; Send waits for it" : a.label}`
                    : a.name}
                onclick={() => kept && revealKept(keepKey(a.name, a.data))}
                onkeydown={(e) => {
                  if (kept && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    revealKept(keepKey(a.name, a.data));
                  }
                }}
              >
                <span class="file-ext">{a.pending ? extOf(a.name).toUpperCase() : badgeOf(a)}</span>
                <span class="file-name">{a.name}</span>
                <!-- Item 491: a long PDF's route stands in for the label
                     (its pages are in both; the label stays in the tip). -->
                {#if a.pending && a.converting}<span class="file-label">{convertingWords(a.name, a.converting.to, clock.now - a.converting.since)}</span>
                {:else if a.label && !routeLabel(a, chipEngine)}<span class="file-label">{a.label}</span>{/if}
                <PdfRouteSwitch chip={a} draftKey={key} engine={chipEngine} />
              </span>
            {/if}
            <button
              class="remove"
              use:tip={`remove ${a.name}`}
              aria-label="remove {a.name}"
              onclick={() => remove(a.id)}>×</button
            >
          </div>
          <!-- Item 306: keep what the model is sent (an office file's PDF)
               in the project's files; absent in a chat with no project. -->
          <KeepButton
            keyStr={keepKey(a.name, a.data)}
            name={a.name}
            mediaType={a.media_type}
            from={{ data: a.data }}
            pending={!!a.pending}
            source={a.source_sha256}
          />
        </div>
      {/each}
    </div>
    <!-- Item 797: a pick chip opened — the crop and every word the model
         is sent about it. -->
    {@const shown = attachments.find((x) => x.id === pickShown && x.pick)}
    {#if shown?.pick}
      <div class="pick-detail" role="region" aria-label="picked element">
        {#if shown.kind === "image"}
          <button
            class="image-open"
            use:tip={"Open in front"}
            aria-label="open {shown.name}"
            onclick={(e) => {
              const el = e.currentTarget.querySelector("img");
              openAttachment(
                draftImageContent(key, shown.id, shown.name),
                e.currentTarget.getBoundingClientRect(),
                el && el.naturalWidth > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : null,
              );
            }}><img class="pick-crop" src={`data:${shown.media_type};base64,${shown.data}`} alt={shown.name} /></button
          >
        {/if}
        <pre class="pick-words mono">{pickText(shown.pick, null)}</pre>
        <button class="lost-paste-x" aria-label="close" use:tip={"Close"} onclick={() => (pickShown = null)}>×</button>
      </div>
    {/if}
  {/if}
  {#if lostPaste && lostPaste.key === key}
    <div class="lost-paste" role="status">
      <span class="lost-paste-text">{lostPaste.text}</span>
      <button type="button" class="lost-paste-x" aria-label="Close this note" onclick={() => (lostPaste = null)}>×</button>
    </div>
  {/if}
  <!-- Item 702: the notice waits for the turn to be idle, never mid-turn or mid-send. -->
  {#if warmAct === "offer" && cache}
    <!-- Item 768: the cache is about to lapse on a big idle chat; the wrap-up is cheapest now. -->
    <div class="handoff handoff-min warm-wrap" role="status" aria-label="Wrap up while the cache is warm">
      <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={13} /></span>
      <strong class="handoff-min-title">{warmTitle(cache.remainingMs, wwContext, switchName)}</strong>
      <span class="mono handoff-fill" use:tip={coldTip(wwCosts, targetRates)}>{warmDetail(wwCosts)}</span>
      <span class="spacer"></span>
      <button class="ns-btn accent small fil-go" class:sending={wrapSending} disabled={app.busy || !wrapUpText.trim()} use:tip={"Send the wrap-up now, while the cache is warm"} onclick={(e) => { markActed(wwChat, cache?.warmUntil ?? null); void sendWrapUpNow(e.currentTarget); }}><span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span>Wrap up now</button>
      <button class="ns-btn ghost small" use:tip={"Not this hour; the cold chip offers it again"} onclick={() => markActed(wwChat, cache?.warmUntil ?? null)}>Not now</button>
    </div>
  {:else if coldChip && cache}
    <!-- Item 768: back on a cold big chat — one chip, both prices, before he types. Never compacts. -->
    <div class="handoff handoff-min cold-return" role="status" aria-label="Cache cold — hand off or keep">
      <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={13} /></span>
      <strong class="handoff-min-title" use:tip={coldTip(wwCosts, targetRates)}>{coldTitle(wwContext, switchName)}</strong>
      <span class="spacer"></span>
      <button class="ns-btn accent small fil-go" class:sending={wrapSending} disabled={app.busy || !wrapUpText.trim()} use:tip={"Send the wrap-up; the next chat starts small"} onclick={(e) => void sendWrapUpNow(e.currentTarget)}><span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span>{coldWords.handoff}</button>
      <button class="ns-btn ghost small" use:tip={"Go on here; hidden until the next reply"} onclick={() => keepCold(wwChat, cache?.warmUntil ?? null)}>{coldWords.keep}</button>
    </div>
  {/if}
  {#if handedNext}
    <div class="handoff handoff-min" role="status" aria-label="This chat was handed off">
      <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={13} /></span>
      <strong class="handoff-min-title">Handed off — this chat continues in “{handedNext.title ?? handedNext.first_user ?? "the next chat"}”</strong>
      <span class="spacer"></span>
      <button class="ns-btn accent small" onclick={() => void openSession(handedNext.id)}>Open it</button>
    </div>
  {/if}
  {#if handoffCardUp && handoffSize === "mini"}
    <!-- Item 702 (his ask, 2026-11-15): a click anywhere on the bar expands it, not just Expand; its buttons keep their own clicks.
         Item 705 (option A, Console): the one line — kicker, title, the fill gauge, Wrap up now, ▴. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div class="handoff handoff-min handoff-min-open hc hc-mini" role="status" aria-label="Hand-off notice, minimized — click to expand" onclick={(e) => { if (!(e.target as HTMLElement).closest("button")) unfold(app.activeSessionId); }}>
      <span class="hc-kicker">Hand-off</span>
      <strong class="handoff-min-title hc-title">Context {handoffPct}%, past the {handoffThresholdPct}%{handoffMarkTokens ? ` (${fmtTokens(handoffMarkTokens)})` : ""} mark</strong>
      <span class="hc-gauge hc-gauge-mini" aria-hidden="true"><i style:width={`${Math.min(100, handoffPct)}%`}></i><b style:left={`${Math.min(100, handoffThresholdPct)}%`}></b></span>
      <span class="mono handoff-fill">{fmtTokens(handoff.used)} of {fmtTokens(handoff.limit)}</span>
      <span class="spacer"></span>
      {#if !wrapUpQueued}<button class="ns-btn accent small hc-go fil-go" class:sending={wrapSending} disabled={app.busy || !wrapUpText.trim()} onclick={(e) => void sendWrapUpNow(e.currentTarget)}><span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span>Wrap up now</button>{/if}
      <button class="hc-ico" aria-label="Expand" use:tip={"Show the whole card again"} onclick={() => unfold(app.activeSessionId)}>▴</button>
    </div>
  {:else if handoffCardUp}
    <!-- The notice (backlog 086 pass 2, blocker 120): the board's hand-off
         card — accent rule, a heading with the fill, one line of what
         happens, the two things he can change for this chat, the actions.
         Nothing goes by itself while it is on screen.
         Item 705 (option A, Console — his pick, blocker 2167): a kicker and
         title over a fill gauge, every control on one row (thread, the mark's
         stepper, the next chat's model), the message, the goal, the buttons.
         Compact (the grip dragged down once) hides the explanation and the
         goal and folds the message to two lines; nothing is dropped. -->
    {@const full = handoffSize === "full"}
    <div class="handoff hc" class:hc-compact={!full} role="status" aria-label="Hand-off notice">
      <div class="hc-head">
        <span class="hc-kicker">Hand-off</span>
        <strong class="hc-title">Context {handoffPct}%, past this chat's {handoffThresholdPct}%{handoffMarkTokens ? ` (${fmtTokens(handoffMarkTokens)})` : ""} mark</strong>
        <span class="hc-x">
          {#if !full}<button class="hc-ico" aria-label="Show the whole card" use:tip={"The whole card: the explanation, the goal, the full message"} onclick={() => setCardSize(app.activeSessionId, "due", "full")}>▾</button>{/if}
          <button class="hc-ico" aria-label="Minimize" use:tip={"Fold this card to one line above the box (or drag the grip down)"} onclick={() => fold(app.activeSessionId, "due")}>–</button>
        </span>
      </div>
      <div class="hc-body">
        {#if full}
          <div class="hc-meter">
            <span class="hc-gauge" aria-hidden="true"><i style:width={`${Math.min(100, handoffPct)}%`}></i><b style:left={`${Math.min(100, handoffThresholdPct)}%`}></b></span>
            <span class="mono handoff-fill hc-gnum"><em>{fmtTokens(handoff.used)}</em> of {fmtTokens(handoff.limit)} · {handoffPct}%</span>
          </div>
          <p class="handoff-d">
            {#if wrapUpQueued}
              The wrap-up below is in the queue — put there while you were away — and goes when this turn ends;
              its × takes it back.
            {:else}
              <strong>Wrap up now</strong> sends the message below as its own turn. The model finishes what is
              half-done, {#if threadAndHandoff}updates the thread's files and <code>HANDOFF.md</code>, commits{:else if threadHandoff}updates the thread's files{:else if codeHere}writes <code>HANDOFF.md</code>, commits{:else}commits what it changed (in a git folder){/if}, and
              ends with the next chat's prompt. Or raise this chat's mark and keep going. Nothing is sent while this is open.
            {/if}
          </p>
        {/if}
        <div class="hc-fields">
          <ThreadPicker menu />
          {#if full}<span class="hc-sep" aria-hidden="true"></span><span class="hc-lbl">Hand off at</span>{/if}
          <span class="hc-step" role="group" aria-label="This chat's hand-off mark" use:tip={`% of the window${hasOwnThreshold(app.activeSessionId) ? ` (the default is ${handoffDefaultRule})` : ` (the default: ${handoffDefaultRule})`}`}>
            <button type="button" aria-label="Lower the mark by 5%" onclick={() => stepMark(-1)}>−</button>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={handoffThresholdPct}
              aria-label="This chat's hand-off threshold, percent of the context window"
              onchange={(e) => typeMark(e.currentTarget as HTMLInputElement)}
            /><small aria-hidden="true">%</small>
            <button type="button" aria-label="Raise the mark by 5%" onclick={() => stepMark(1)}>+</button>
          </span>
          {#if full}<span class="hc-sep" aria-hidden="true"></span>{/if}
          {#if agentMode}
            <HudSelect
              kicker={full ? "Next chat" : "Next"}
              value={nextLabel.name}
              note={full && nextLabel.isDefault ? "this chat's" : ""}
              head="The next chat's model"
              label="The model the next chat starts on"
              hint={"The model the next chat opens on — this chat's unless picked here; the next-chat card shows the same pick"}
              rows={nextModelRows(app.activeSessionId)}
              onpick={(id) => setNextModel(app.activeSessionId, id)}
            />
          {/if}
          {#if !full}
            <span class="hc-fill-row">
              <span class="hc-gauge hc-gauge-row" aria-hidden="true"><i style:width={`${Math.min(100, handoffPct)}%`}></i><b style:left={`${Math.min(100, handoffThresholdPct)}%`}></b></span>
              <span class="mono handoff-fill hc-gnum"><em>{fmtTokens(handoff.used)}</em> / {fmtTokens(handoff.limit)}</span>
            </span>
          {/if}
        </div>
        <textarea
          class="handoff-msg"
          class:hc-clip={!full}
          rows={full ? 4 : 2}
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="The wrap-up message for this chat"
          use:tip={"What Wrap up now sends. Edits are kept for this chat only; the default is in Settings → Subscription."}
          value={wrapUpText}
          oninput={(e) => {
            noteActivity();
            setMessage(app.activeSessionId, (e.currentTarget as HTMLTextAreaElement).value);
          }}
        ></textarea>
        <!-- Item 747: the goal for the next chat, and what Nightloom adds under the message. -->
        {#if full}<HandoffGoal chat={app.activeSessionId} />{/if}
        <div class="handoff-acts">
          {#if !wrapUpQueued}
            <button class="ns-btn accent hc-go fil-go" class:small={!full} class:sending={wrapSending} disabled={app.busy || !wrapUpText.trim()} onclick={(e) => void sendWrapUpNow(e.currentTarget)}><span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span>Wrap up now</button>
          {/if}
          <button class="ns-btn ghost small" use:tip={`No wrap-up; asked again past ${reAskPct}%`} onclick={() => { noteStay(app.activeSessionId); stayHere(); }}>Stay here</button>
          {#if hasOwnMessage(app.activeSessionId)}
            <button class="ns-btn ghost small" use:tip={"Back to the Settings default for this chat"} onclick={() => clearMessage(app.activeSessionId)}>Reset the message</button>
          {/if}
          <span class="handoff-keys mono">{full ? `stay past ${reAskPct}% and it asks again` : "click the text to edit it"}</span>
        </div>
      </div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapping"}
    <div class="handoff" role="status">
      <div class="handoff-head"><span>Wrapping up — the model is finishing what is half-done, {#if threadAndHandoff}updating the thread's files and <code>HANDOFF.md</code>, committing{:else if threadHandoff}updating the thread's files{:else if codeHere}writing <code>HANDOFF.md</code>, committing{:else}committing what it changed (in a git folder){/if}, and ending with the start prompt for the new chat.</span></div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapped" && !handoff.startPrompt}
    <!-- Item 506 (blocker 1660): the reply's next-chat card is the hand-off;
         a wrap-up that wrote no prompt has no card to carry the button, so
         this one line is the way on. ~~The wrapped card and its folded form:
         a second text and a second Continue beside the reply's.~~ -->
    <div class="handoff handoff-min" role="status" aria-label="The wrap-up wrote no next-chat prompt">
      <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={13} /></span>
      <strong class="handoff-min-title">The wrap-up wrote no next-chat prompt</strong>
      <span class="spacer"></span>
      <button class="ns-btn accent small" disabled={app.busy} use:tip={app.busy ? "A turn is running — continue when it ends" : "Open a linked chat with the read order in its box, not sent"} onclick={() => void continueChat()}>Continue in a new chat</button>
      <button class="ns-btn ghost small" use:tip={`Keep going here; asked again past ${reAskPct}%`} onclick={() => { noteStay(app.activeSessionId); stayHere(); }}>Dismiss</button>
    </div>
  {/if}
  {#if clipOpen}
    <ClipPanel entries={clips.ring} index={clipIndex} onpick={pickClip} />
  {/if}
  {#if slashOpen}
    <div class="slash hud-m" role="listbox" aria-label={savedShown ? "Saved prompts, inserts, skills and slash commands" : insertShown ? "Inserts, skills and slash commands" : "Skills and slash commands"} in:hudIn|global out:hudOut|global>
      {#if slashMatches.length === 0}
        <div class="slash-row dim">No skill or command starts with “{text.slice(1)}” — ↵ sends the text as typed</div>
      {:else}
        {#each slashMatches as m, i (m.kind + "\u0000" + m.name)}
          <button
            type="button"
            role="option"
            class="slash-row"
            class:on={i === slashIndex}
            aria-selected={i === slashIndex}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => pickSlash(m.name, m.prompt, m.insert)}
          >
            <span class="mono">/{m.name}{#if m.args}<span class="dim"> {m.args}</span>{/if}</span>
            <span class="dim">{m.kind}</span>
          </button>
        {/each}
        {#if savedShown}
          <div class="slash-row dim">↑↓ move · ↵ or Tab insert · Esc close · a saved prompt's blanks: Tab to the next</div>
        {:else if insertShown && !wholeSlash}
          <div class="slash-row dim">↑↓ move · ↵ or Tab insert · Esc close, the text stays as typed</div>
        {:else}
          <div class="slash-row dim">↑↓ move · ↵ or Tab insert · Esc close · the CLI runs a skill named in the message</div>
        {/if}
      {/if}
    </div>
  {/if}
  {#if mathShown}
    <TypedMathBar spans={mathSpans} onaccept={acceptMath} ondeny={denyMath} />
  {/if}
  {#if comments.length > 0}
    <!-- Item 754: his comments on passages; each chip opens its comment
         line, × asks first, Send sends them all with the box's words. -->
    <div class="comments-wrap" class:plain={classic()} data-passage-comments>
      <div class="comment-chips">
        <span class="comment-k">{comments.length === 1 ? "1 comment" : `${comments.length} comments`}</span>
        <!-- Item 881: the chips wrap in a column of their own, so a second row lines up under the first chip, not under the label. -->
        <span class="comment-list">
        {#each comments as c (c.id)}
          <span class="comment-chip" class:open={openComment === c.id} data-comment={c.id}>
            <button
              type="button"
              class="comment-open"
              aria-expanded={openComment === c.id}
              use:tip={`A comment on a passage from ${commentWhere(c)} — click to ${openComment === c.id ? "close" : "write or change"} it. Send sends every comment with what is in the box, as one message.`}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => {
                if (openComment === c.id) closeComment();
                else {
                  openComment = c.id;
                  void tick().then(() => commentTa?.focus());
                }
              }}
            >
              {#if !classic()}<Icon name="pencil" size={11} />{/if}
              <!-- Item 880: the passage's maths typeset (a diff stays as written). -->
              <span class="comment-q chip-math">“{#if c.source === "diff"}{chipLabel(c)}{:else}<MathText text={chipLabel(c, undefined, { math: true })} />{/if}”</span>
              {#if c.note.trim()}<span class="comment-n">{commentLabel(c.note, 28)}</span>{/if}
            </button>
            <button
              type="button"
              class="held-x"
              aria-label="Discard this comment"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => (dropAsk = c)}><Icon name="x" size={11} /></button
            >
          </span>
        {/each}
        </span>
      </div>
      {#if openC}
        {@const oc = openC}
        <div class="comment-edit">
          <!-- Item 880: the passage as the reply drew it (its maths typeset); a diff as its lines. -->
          {#if oc.source === "diff"}
            <div class="comment-quote" use:tip={`From ${commentWhere(oc)}`}>{shownQuote(oc)}</div>
          {:else}
            <div class="comment-quote rendered markdown" use:tip={`From ${commentWhere(oc)}`}>{@html renderReply(oc.quote)}</div>
          {/if}
          <textarea
            bind:this={commentTa}
            data-undo-key={`comment:${key}:${oc.id}`}
            class="comment-ta"
            rows="2"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Your comment on this passage — ↵ done, ⇧↵ new line"
            value={oc.note}
            oninput={(e) => setCommentNote(key, oc.id, e.currentTarget.value)}
            onkeydown={(e) => {
              if ((e.key === "Enter" && !e.shiftKey && !e.isComposing) || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeComment();
              }
            }}
          ></textarea>
        </div>
      {/if}
    </div>
  {/if}
  {#if dropAsk}
    <!-- The dialog's own title prop, spread (tip.test bars title= here). -->
    <ConfirmDialog
      {...DROP_DIALOG}
      lead="The passage and what you wrote about it leave the box. Your other comments and the box's words stay."
      facts={[
        ["passage", `“${chipLabel(dropAsk, 60)}”`],
        ["comment", dropAsk.note.trim() ? commentLabel(dropAsk.note, 60) : "(none written)"],
      ]}
      confirmLabel="Discard"
      onconfirm={confirmDropComment}
      onclose={() => (dropAsk = null)}
    />
  {/if}
  {#if heldShown}
    <!-- Item 694: the passage his Ask aside is about; × drops it. -->
    <div class="held-wrap" class:plain={classic()} data-held-passage>
      <span
        class="held-chip"
        use:tip={`Ask aside asks about this passage from ${quoteLabel(heldShown.quote, "card")}, as the selection's Ask aside does. Send does not take it; × or Esc in an empty box drops it.`}
      >
        {#if !classic()}<FilamentMark kind="aside" />{/if}
        <span class="held-k">About:</span>
        <span class="held-q chip-math">“<MathText text={heldLabel(heldShown.quote, undefined, { math: true })} />”</span>
        <button
          type="button"
          class="held-x"
          aria-label="Do not ask about this passage"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => dropHeld(key)}><Icon name="x" size={11} /></button
        >
      </span>
    </div>
  {/if}
  <div class="card" data-cache={frame?.cache} data-cache-look={frame ? cacheLook.value : undefined} data-cache-losing={frame && cacheBuilt && cacheChanges.length > 0 ? "" : undefined} style={frame?.style}>
    <!-- No autocorrect, capitalisation or spell-marking on a message to a
         model: macOS was rewriting his words as he typed (2026-09-16). -->
    {#if ghost}
      <!-- Over the textarea's first line; the box is empty when it shows. -->
      <button
        type="button"
        class="ghost-line"
        use:tip={"The CLI's predicted next prompt — Tab or click puts it in the box, Esc drops it"}
        onmousedown={(e) => e.preventDefault()}
        onclick={acceptGhost}
      >
        <span class="ghost-text">{ghost}</span>
        <span class="ghost-key">Tab</span>
      </button>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="ta-wrap"
      onkeyup={recordCaret}
      onmouseup={() => {
        recordCaret();
        pointerDown = false;
      }}
      onmousedown={() => {
        pointerDown = true;
        scrollHold.release();
      }}
      onkeydowncapture={() => scrollHold.release()}
      onbeforeinputcapture={() => scrollHold.release()}
      onwheel={() => scrollHold.release()}
      onscrollcapture={recordScroll}
      onselect={recordCaret}
      oninput={recordCaret}
      onfocusin={() => {
        if (ta) keeper.focusIn(key, ta, pointerDown);
        recordCaret();
      }}
      onfocusout={() => {
        recordCaret();
        pointerDown = false;
      }}
    >
    {#if composerFormat.on || gridBox}
      <!-- Item 276: the same draft with its formatting drawn in place —
           math typeset, bold / italic / headings styled, the source back
           under the cursor. The text, the keys and the draft are the
           textarea's; only the drawing differs. -->
      <LiveBox
        bind:handle={ta}
        value={text}
        historyKey={key}
        onchange={(v) => setDraftText(key, v)}
        placeholder={app.connection ? boxPlaceholder : ""}
        disabled={boxIsLocked}
        {floating}
        drawing={composerFormat.on ? "all" : "plain"}
        initialCaret={formatCaret}
        oninput={() => {
          noteActivity();
          autogrow();
        }}
        {onpaste}
        {onkeydown}
        onblur={() => (clipOpen = false)}
        onresize={autogrow}
      />
    {:else}
    {#if layered}
      <!-- Item 223: the draft drawn behind the textarea, quote lines as the
           bubble draws them; item 315: a fenced block on a code ground, its
           language picker on the fence. Shared with the edit box (399). -->
      <BoxLayer {text} box={ta instanceof HTMLTextAreaElement ? ta : null} onrelabel={relabel} />
    {/if}
    <!-- data-own-undo: its history is `hist`'s, not fieldUndo.ts's (item 421). -->
    <textarea
      bind:this={ta}
      data-own-undo
      class:quoted={layered}
      bind:value={() => text, (v) => setDraftText(key, v)}
      rows="1"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder={app.connection ? boxPlaceholder : ""}
      disabled={boxIsLocked}
      oninput={(e) => {
        // Blocker 1210: his edit, into the box's own undo history.
        onboxinput(e);
        // A keystroke is presence, for the hand-off's away rule (backlog 086).
        noteActivity();
        autogrow();
      }}
      onbeforeinput={onboxbeforeinput}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => {
        composing = false;
        hist.close();
      }}
      {onpaste}
      {onkeydown}
      onblur={() => (clipOpen = false)}
    ></textarea>
    {/if}
    </div>
    <!-- Item 284's offer; shared with the edit box since item 399b. -->
    <PasteOfferRow {offer} {undoable} onconvert={() => void convertLongPaste()} ondismiss={dismissOffer} onundo={() => undoConvert()} />
    <div class="row" bind:this={rowEl} data-fold={rowFold}>
      <input
        bind:this={picker}
        type="file"
        accept="*/*"
        multiple
        hidden
        onchange={onpick}
      />
      <!-- Item 607 (his "remove the word attach on the button so that it's
           just like the plus icon thing"): under Filament the plus alone,
           named by its tooltip and label; Classic keeps its word. -->
      <button
        class="ns-btn ghost small attach"
        aria-label="Attach files"
        use:tip={"Attach files"}
        disabled={!app.connection}
        onclick={() => picker?.click()}
      >
        <Icon name="plus" /><span class="fold-word">Attach</span>
      </button>
      <!-- The model and effort buttons (backlog 112, board 10's A): each
           opens its menu above; the top bar's chip no longer names the
           model (blocker 141). ~~Disabled while a turn runs or a connect
           is in flight, as the rail's pills are~~ — open then too since
           backlog 214: a pick waits for the turn and applies to the next
           (`applyDraft` defers it); the tip says so while one runs. -->
      <span class="pick-wrap">
        <button
          class="pick-btn"
          class:open={menu === "model"}
          bind:this={modelBtn}
          disabled={!app.connection}
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          use:tip={aside ? asideModelTitle : modelTitle}
          onclick={() => openMenu("model")}
        >
          <span class="pick-dot" class:unknown={!app.connection}></span>
          {#if aside}
            <!-- Item 833: the long label, else (fold 4 on) the value alone. -->
            <span class="pick-name has-short"><span class="pick-long">{asideModelLabel}</span><span class="pick-short">{asideModelShort}</span></span>
          {:else}
            <span class="pick-name">{modelLabel}</span>
          {/if}
          <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
        </button>
        {#if menu === "model"}
          {@render pickMenu(aside ? "This aside's model" : "Model", aside ? "the chat's unless picked here" : agentMode ? "one row per family, its newest" : `${models.length} in the picker · Settings picks which`)}
        {/if}
      </span>
      <span class="pick-wrap">
        <button
          class="pick-btn"
          class:open={menu === "effort"}
          bind:this={effortBtn}
          disabled={!app.connection}
          aria-haspopup="menu"
          aria-expanded={menu === "effort"}
          use:tip={aside
            ? `This aside's effort (--effort): ${asideEffortLabel} — the chat's unless picked here; kept on this aside`
            : agentMode
              ? "Effort (--effort) — how hard the model thinks per turn; default sends no flag and leaves it to the model. Kept on this chat."
              : `Thinking — ${thinkingSup.note}`}
          onclick={() => openMenu("effort")}
        >
          <span class="pick-k">{agentMode ? "effort" : "thinking"}</span>
          {#if aside}
            <span class="pick-name has-short"><span class="pick-long">{asideEffortLabel}</span><span class="pick-short">{asideEffortShort}</span></span>
          {:else}
            <span class="pick-name">{agentMode ? effortLabel : thinkingLabel}</span>
          {/if}
          <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
        </button>
        {#if menu === "effort"}
          {@render pickMenu(aside ? "This aside's effort" : agentMode ? "Effort" : "Thinking", aside ? "--effort · kept on this aside" : agentMode ? "--effort · kept on this chat" : "kept on this chat")}
        {/if}
      </span>
      <!-- Earlier drafts (nightshift backlog 158): the ring of texts that
           left this box. Shown only once there is one; never locked, since
           a lost draft is wanted most while a turn runs. -->
      {#if history.length > 0}
        <span class="pick-wrap">
          <button
            class="pick-btn"
            class:open={menu === "history"}
            bind:this={historyBtn}
            aria-haspopup="menu"
            aria-expanded={menu === "history"}
            use:tip={"Earlier drafts of this box — the last ten texts that were sent, queued, or replaced by a paste. Click one to put it back."}
            onclick={() => openMenu("history")}
          >
            <span class="pick-k">drafts</span>
            <span class="pick-name">{history.length}</span>
            <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
          </button>
          {#if menu === "history"}
            {@render pickMenu("Earlier drafts", "newest first · a click puts one back in the box")}
          {:else if menu === "rewound" && offerRows.length > 0}
            <!-- Item 724: the rewound message alone, the drafts list's look. -->
            {@render pickMenu("Rewound message", "a click swaps it into the box")}
          {/if}
        </span>
      {/if}
      <span class="spacer"></span>
      {#if stopPressed && (stopState === "slow" || stopPref.shape !== "labelled")}
        <!-- Item 466: a Stop with no room for the word (all but the
             labelled shape) has it here; past 3 s, why it is still waiting. -->
        <span class="stop-why" role="status" use:tip={stopState === "slow" ? `Stopping… ${slowStopLine(app.connection?.engine)}. The reply so far and your draft stay.` : "Stopping…"}
          >Stopping…{#if stopState === "slow"}<span class="stop-why-more">{" "}{slowStopLine(app.connection?.engine)}</span>{/if}</span
        >
      {/if}
      {#if handoffStayed}
        <button
          class="ns-btn ghost small act"
          use:tip={`Bring back the hand-off notice now; it asks by itself again past ${reAskPct}%`}
          onclick={() => reopenHandoff()}
        ><Icon name="branch" size={12} /> Hand off</button>
      {/if}
      {#if shown}
        <span class="draft-tokens mono act" data-fold-step="tokens" use:tip={shown.title}
          ><span class="fold-word">{shown.long}</span><span class="short-word">{shown.short}</span></span
        >
      {/if}
      {#if busy}
        <button
          class="ns-btn ghost small act"
          use:tip={aside ? "Hold this message; it goes when this answer ends" : "Hold this message; it goes when the turn ends"}
          onclick={enqueue}
          disabled={boxEmpty}>Queue</button
        >
        <!-- Item 411: its shape is his pick in Settings → Appearance (square
             unless he picks another); `wide` is item 398's, below.
             Item 398: Stop is an icon button in Send's place at Send's size —
             a filled square over an invisible "Send" that sizes it, so the
             row keeps its height when a turn starts. Armed after 400 ms, so
             a double-click on Send cannot stop the turn it started. -->
        {#if aside}
          <button class="ns-btn danger send stop act shape-{stopPref.shape}" aria-label="Stop" use:armStop use:tip={`Stop this answer; what has arrived stays (${stopChordLabel(isMac)})`} onclick={() => aside && stopAside(aside)}
            ><span class="stop-size" aria-hidden="true">Send</span><span class="stop-ico" aria-hidden="true"><Icon name="stop" size={stopPref.shape === "wide" ? 16 : 12} />{#if stopPref.shape === "labelled"}<span class="stop-word">Stop</span>{/if}</span></button
          >
        {:else}
          <!-- Item 466: pressed, it stays pressed — deflated, dimmed, a
               spinner for the square — until the turn has ended, and a
               second click asks nothing again. -->
          <button class="ns-btn danger send stop act shape-{stopPref.shape}" class:stopping={stopPressed} aria-label={stopPressed ? "Stopping…" : "Stop"} aria-disabled={stopPressed} use:armStop use:tip={stopPressed ? "Stopping… — the turn ends when Claude has stopped; the reply so far and your draft stay" : `${app.parked ? `Stop the turn running in ${runningChatName()}` : "Stop this turn"} (${stopChordLabel(isMac)})`} onclick={() => { if (!stopPressed) void cancelTurn(); }}
            ><span class="stop-size" aria-hidden="true">Send</span><span class="stop-ico" aria-hidden="true">{#if stopPressed}<span class="stop-spin"></span>{:else}<Icon name="stop" size={stopPref.shape === "wide" ? 16 : 12} />{/if}{#if stopPref.shape === "labelled"}<span class="stop-word">{stopPressed ? "Stopping…" : "Stop"}</span>{/if}</span></button
          >
        {/if}
      {:else if aside}
        <!-- The aside's Send (backlog 283): no schedule ▾, no council. -->
        <button
          class="ns-btn accent send act fil-btn fil-send"
          use:tip={asideSendTip}
          onclick={() => void submit()}
          disabled={!app.connection || asideBlock !== null || boxEmpty}
        >
          <span class="fil-scan" aria-hidden="true"></span><FilamentMark kind="send" />Send
        </button>
      {:else}
        {#if app.connection?.engine === "claude-code" && app.events.length > 0}
          <!-- Ask aside (nightshift backlog 081): the typed question goes
               to the chat's context off its warm cache and is recorded
               nowhere — the CLI's /btw. ~~Text only; attachments are a
               turn's~~ — with the box's chips since backlog 283.
               Not before the first turn: an empty chat has no context to
               ask (the Welcome screen showed it — his report, 2026-09-17). -->
          <button
            class="ns-btn ghost small act fil-btn fil-ghost"
            use:tip={"Ask this of the chat without adding it to the chat: answered from what is already in context, no changes, recorded nowhere (Claude Code's /btw)"}
            disabled={boxEmpty}
            onclick={() => void submitAside()}
          >
            <FilamentMark kind="aside" /><span class="fold-word">Ask aside</span><span class="short-word">Aside</span>
          </button>
        {/if}
        {#if app.connection?.engine === "claude-code"}
          <!-- The council (nightshift backlog 149): the popover's roster
               and mode for this turn, then Send to the council. -->
          <span class="council-wrap act" bind:this={councilWrap}>
            <button
              class="ns-btn ghost small fil-btn fil-ghost"
              class:on={councilOpen}
              bind:this={councilBtn}
              use:tip={"Send this message to a council: several models answer it independently, then this chat's model chairs their answers"}
              aria-haspopup="dialog"
              aria-expanded={councilOpen}
              aria-label="Council"
              onclick={() => (councilOpen = !councilOpen)}
            >
              <!-- Item 289: its icon alone at fold 3 and past. -->
              <FilamentMark kind="council" /><span class="council-ico" aria-hidden="true"><Icon name="agent" size={13} /></span><span class="council-word">Council</span>
            </button>
            {#if councilOpen}
              <CouncilPopover
                anchor={councilBtn}
                disabled={!app.connection || sendHeld() || boxEmpty}
                onsend={(p) => void submitCouncil(p)}
                onclose={() => {
                  councilOpen = false;
                  councilBtn?.focus();
                }}
              />
            {/if}
          </span>
        {/if}
        <!-- Send and its ▾ (backlog 224): a split button, the sidebar's
             New chat ▾ shape; the ▾ schedules the message instead. -->
        <span class="send-split act">
          <button
            class="ns-btn accent send act fil-btn fil-send"
            use:tip={withEstimate(sendTip(!!app.connection, boxEmpty, sendHeld()))}
            onclick={() => void submit()}
            class:sending
            disabled={!app.connection || sendHeld() || boxEmpty}
          >
            <span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span><FilamentMark kind="send" />Send
          </button><ScheduleMenu {key} {text} {attachments} blocked={scheduleBlocked} onscheduled={scheduled} bind:this={scheduleMenu} />
        </span>
      {/if}
    </div>
  </div>
  <!-- The two transcript toggles (backlog 052), one snippet since item 605:
       the chat's bottom row and an aside's draw the same pair, as an
       aside's answer has thinking and tool rows since item 403. -->
  {#snippet transcriptToggles()}
      <button
        class="ns-chip bottom-toggle"
        class:on={transcript.thinking}
        aria-pressed={transcript.thinking}
        disabled={thinkingDead}
        use:tip={thinkingDead
          ? HIDDEN_THINKING_TITLE + " The toggle has nothing to open in this chat."
          : (transcript.thinking
              ? `Thinking shown in every reply — click to fold it to a pill (${shiftKey}T)`
              : `Thinking folded to a pill — click to show it in every reply (${shiftKey}T)`) +
            THINKING_COST_NOTE}
        onclick={() => toggleTranscriptPref("thinking")}
      >
        <span class="bottom-mark" aria-hidden="true">✦</span>thinking
      </button>
      <button
        class="ns-chip bottom-toggle"
        class:on={transcript.tools}
        aria-pressed={transcript.tools}
        use:tip={transcript.tools
          ? `Tool calls shown in full — click to fold each to one line (${shiftKey}B)`
          : `Tool calls folded to one line each — click to show them in full (${shiftKey}B)`}
        onclick={() => toggleTranscriptPref("tool")}
      >
        <span class="bottom-mark" aria-hidden="true">⚒</span>tools
      </button>
  {/snippet}
  <!-- Item 786 (his "we have none of the cash information on this"): the
       keep-warm switch and the cache chip, one snippet drawn in the chat's
       row and an aside's — an aside reads the chat's cache (item 732), so
       its box shows the same chip, timed by the same reads. -->
  {#snippet cacheChips()}
    <!-- Item 728: a chat whose hand-off switched it off says so, cache or not. -->
    {#if kwChat && !(aside && asideOwnModel) && ((isOn(kw) && kw?.chosen !== false) || cache?.ttl === "1h" || handedOffOff(kw))}
      <button
        class="ns-chip bottom-toggle keep-warm"
        class:on={isOn(kw)}
        class:keeping={isKeeping(kw, now)}
        aria-pressed={isOn(kw)}
        aria-haspopup="menu"
        bind:this={kwButton}
        use:tip={switchTitle(kw, now, cache?.warm ? nextEst?.cold : null)}
        use:holdPress={() => (kwHoldOpen = true)}
        onclick={() => void flipKeepWarm(isOn(kw) ? "off" : "on")}
      >
        <span class="bottom-mark" aria-hidden="true">♨</span>{switchLabel(kw, now)}{#if holdTail(kw)}<span class="keep-warm-hold">{holdTail(kw)}</span>{/if}
      </button>
      {#if kwHoldOpen && kwButton}<KeepWarmHold anchor={kwButton} status={kw} onpick={(h) => void holdFor(h)} onclose={() => (kwHoldOpen = false)} />{/if}
    {/if}
    {#if cache && cacheBuilt && cache.warm && (cacheChanges.length > 0 || layerChange)}
      <!-- Backlog 408: a pending change would lose the warm cache; the
           click puts every changed setting back. Item 777: priced, with
           it against without it; a logged layer change is named too (the
           Context page puts it back, not this click). -->
      <button
        class="ns-chip mono bottom-cache losing"
        use:tip={lossTip}
        onclick={restoreCache}
      >
        <span class="losing-what">{cacheChanges.length > 0 && !layerChange ? cacheLossLine(cacheChanges) : `cache will be lost · ${lossWords.join(", ")}`}</span>{#if changeCost}{@const vs = changeCost.line.indexOf(" (vs")}<span class="bottom-cache-next"><span class="next-sep">&nbsp;·&nbsp;</span>{vs < 0 ? changeCost.line : changeCost.line.slice(0, vs)}{#if vs >= 0}<span class="cost-vs">{changeCost.line.slice(vs)}</span>{/if}</span>{/if}{#if canRestore(cacheChanges)}<span class="bottom-cache-when restore-part">&nbsp;· <span class="restore-word">restore</span></span>{/if}
      </button>
    {:else if (aside ? asideHit : cached) != null || cache}
      <div
        class="ns-chip mono bottom-cache"
        class:cold={cache ? !cache.warm : false}
        class:unknown={face === "unknown"}
        use:tip={cacheTitle}
      >
        <!-- Item 776: cold reads `cache cold · next ≈ $1.65`; warm puts both prices on the face. -->
        <!-- Item 786: `unknown` after a stop that logged no reply; an aside on its own model says so. -->
        <!-- Item 833 (merge round W): every part carries its separator in front (`.cache-sep`); a wrapped line's "·" is clipped (CSS below). -->
        <span class="cache-flow"><span class="cache-lines"
            >{#if face === "unknown"}<span class="cache-part"><span class="cache-sep" aria-hidden="true"></span>cache <span class="bottom-cache-when" aria-label="cache unknown until the next send">unknown</span></span>{:else if cache && !cache.warm}<span class="cache-part"><span class="cache-sep" aria-hidden="true"></span>{#if aside && asideOwnModel}own model{:else}cache{/if} <span class="bottom-cache-when" aria-label={cacheLine(cache)}>cold</span></span>{:else}{@const hit = aside ? asideHit : cached}<span class="cache-part"><span class="cache-sep" aria-hidden="true"></span>{#if hit != null}{Math.round(hit * 100)}%<span class="bottom-cache-word">{" cached"}</span>{:else}cache{/if}</span>{#if cache}<span class="cache-part bottom-cache-when" aria-label={cacheLine(cache)}><span class="cache-sep">·</span>{remainingText(cache.remainingMs)}</span>{/if}{/if}{#if cache && nextEst}<span class="bottom-cache-next"
                >{#each nextEst.line.split(" · ") as part}<span class="cache-part next-part"><span class="cache-sep">·</span>{part}</span>{/each}</span
              >{/if}</span
          ></span>
      </div>
    {/if}
  {/snippet}
  {#if aside}
    <!-- The aside's bottom row (backlog 283): its line — where it answers
         from, or why Send waits — and the format toggle, the one bottom
         chip that is about the box rather than the chat's transcript. -->
    <div class="bottom-row aside-row">
      <span class="aside-line" role="status">
        {#if asideBlock === "not-open"}
          Sends only while <em>{asideChatName}</em> is the open chat — an aside answers from its context.
          <button class="ns-btn ghost small" onclick={() => asideOwner && void openContent({ kind: "chat", session: asideOwner }, "new")}>Open the chat</button>
        {:else if asideBlock === "engine"}
          Asides run on the Claude Code engine; the box keeps what is typed.
        {:else if asideBusy}
          {aside && asideWaiting(aside) ? "Waiting — one aside answers at a time; ↵ holds the next message." : "Answering — ↵ holds the next message for when it ends."}
        {:else}
          Answers from this chat's context; nothing here enters the chat.
        {/if}
      </span>
      <span class="spacer"></span>
      <!-- Item 605: the transcript toggles, before the format chip as in the
           chat's row — Filament only: Classic keeps 1d4ca17's aside row. -->
      {#if !classic()}{@render transcriptToggles()}{/if}
      <button
        class="ns-chip bottom-toggle"
        class:on={composerFormat.on}
        aria-pressed={composerFormat.on}
        use:tip={composerFormat.on
          ? "Formatting drawn in the box — $…$ math, **bold**, *italic*, # headings; the message sent is the text as typed. Click for the plain box"
          : "Plain box — click to draw $…$ math, **bold**, *italic* and # headings in place as you type"}
        onclick={flipFormat}
      >
        <span class="bottom-mark" aria-hidden="true">∑</span>format
      </button>
      {@render cacheChips()}
    </div>
  {:else if !floating}
    <!-- The bottom row (backlog 112, board 10's C): the two transcript
         toggles (backlog 052) and the cache chip (063), under the box,
         right-aligned as drawn. A click on any single block still
         overrides its toggle; flipping the toggle clears those clicks.
         Remembered across relaunch; thinking off and tools on is how the
         transcript read before them. -->
    <div class="bottom-row">
      {@render transcriptToggles()}
      <!-- Item 276: formatting drawn in the box. Off is the plain box; the
           message sent is the text as typed either way. -->
      <button
        class="ns-chip bottom-toggle"
        class:on={composerFormat.on}
        aria-pressed={composerFormat.on}
        use:tip={composerFormat.on
          ? "Formatting drawn in the box — $…$ math, **bold**, *italic*, # headings; the source shows where the cursor is, and the message sent is the text as typed. Click for the plain box"
          : "Plain box — click to draw $…$ math, **bold**, *italic* and # headings in place as you type; the message sent stays the text as typed"}
        onclick={flipFormat}
      >
        <span class="bottom-mark" aria-hidden="true">∑</span>format
      </button>
      <!-- One chip for the cache (his ask, 2026-09-16): the share of the
           last request served from it, then the timer from backlog 063 —
           how long it stays warm, or `cold`. A chat whose last turn
           predates the timer's fields shows the share alone, and the
           title says why. Nothing before the first turn. -->
      <!-- Keep-warm (backlog 582; item 608): the chat's switch beside its
           cache timer, on by default (Settings → Subscription → Keeping
           caches warm). Shown once the chat has a 1-hour cache to keep, or
           whenever he switched it on himself — a chat on only by the
           default shows it only with a 1-hour cache, so a 5-minute engine
           never reads "on". The one-tap "until I'm back" chip is gone
           (blocker 1844): with the default on, the switch covers it. A chat
           already in that mode reads "On until your next message" and ends
           at his send as before. -->
      {@render cacheChips()}
    </div>
  {/if}
  {#if connectHint}
    <!-- ~~"connecting…" while the launch connect runs, as the top bar says~~
         — item 873: the top bar says it alone; the failure wording only once
         it is true (item 230). -->
    <div class="hint">{connectHint}</div>
  {:else if dragDepth > 0}
    <div class="hint">drop images or PDFs to attach</div>
  {:else if !aside && handoff.noStartPromptChat !== null && handoff.noStartPromptChat === app.activeSessionId && !text}
    <!-- The continued chat whose box was left empty (backlog 086 pass 2):
         the note lives here, under the box, until he types. -->
    <div class="hint">continued from the earlier chat — its wrap-up reply had no &lt;handoff&gt; prompt, so the box is empty; say which files to read first{#if codeHere} (HANDOFF.md is in the project){/if}</div>
  {/if}
</div>

<!-- The menu over a picker button (backlog 112): a head, the rows with
     the current one lit and each chord as a key cap, the rail's row last.
     Drawn from `menuRows`, so the model and effort menus are one piece
     of markup and one set of keys. -->
{#snippet pickMenu(head: string, sub: string)}
  <div
    class="pick-menu hud-m"
    role="menu"
    tabindex="-1"
    aria-label={head}
    bind:this={menuEl}
    use:floatMenu={{ anchor: menuButton() }}
    in:hudIn|global={{ anchor: menuButton() }}
    out:hudOut|global
    onkeydown={onMenuKey}
  >
    <div class="pick-head"><span>{head}</span><span class="pick-sub">{sub}</span></div>
    {#each menuRows as r (r.id)}
      {#if r.id === "rail" || r.sep}<div class="pick-sep"></div>{/if}
      <button
        type="button"
        class="pick-row"
        use:tip={r.title}
        class:on={r.on}
        role="menuitemradio"
        aria-checked={r.on ?? false}
        tabindex="-1"
        onclick={() => runRow(r)}
      >
        <span class="pick-row-label">{r.label}</span>
        {#if r.detail}<span class="pick-row-detail">{classic() ? r.detail : r.detail.replace(/^·\s*/, "")}</span>{/if}
        {#if r.cap}<span class="pick-row-cap"><Kbd keys={r.cap} /></span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

<style>
  /* The Classic layout (item 542): every rule item 525 changed is written
     twice, in place — the Filament IV rule behind
     `:global(:where(:root:not([data-layout="classic"])))`, then 1d4ca17's,
     verbatim, behind `:global(:where([data-layout="classic"]))`. `:where()`
     weighs nothing, so neither changes the other's cascade (app.css has the
     same gate). */
  /* Item 716: the council button's frame — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  /* The in-box pickers (backlog 112, board 10's A): small text buttons
     beside Attach, a menu above each. `.pick-wrap` is the menu's frame. */
  .pick-wrap {
    position: relative;
    display: inline-flex;
    /* Never the thing that gives way: on the Welcome screen's narrower
       composer the row squeezed these to a dot and "effort d.." while the
       key hint kept its width (his report, 2026-09-17). The hint yields
       instead, below. */
    flex: none;
  }
  /* Item 716: the model / effort / drafts pickers — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  /* Placed by `use:floatMenu` (backlog 210): portalled to `body` and fixed
     by the button's rectangle, so the Welcome page's scrolling column can
     no longer cut it off; its top, left and max-height are set inline. */
  :global(:where(:root:not([data-layout="classic"]))) .pick-menu {
    position: fixed;
    z-index: 80;
    min-width: 230px;
    max-width: 360px;
    max-height: 60vh;
    overflow-y: auto;
    /* A menu is a card in front, with a real shadow under it. */
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--sans);
  }
  :global(:where([data-layout="classic"])) .pick-menu {
    position: fixed;
    z-index: 80;
    min-width: 230px;
    max-width: 360px;
    max-height: 60vh;
    overflow-y: auto;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--sans);
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-head {
    font-family: var(--mono);
    font-weight: 500;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
    padding: 5px 8px 3px;
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: nowrap;
  }
  :global(:where([data-layout="classic"])) .pick-head {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 5px 8px 3px;
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: nowrap;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-sub {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    font-size: 10.5px;
    color: var(--dim);
  }
  :global(:where([data-layout="classic"])) .pick-sub {
    text-transform: none;
    letter-spacing: 0;
    font-size: 11px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--r1);
    border: none;
    background: transparent;
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--ink2);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    min-width: 0;
  }
  :global(:where([data-layout="classic"])) .pick-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--ink);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    min-width: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row:hover,
:global(:where(:root:not([data-layout="classic"]))) .pick-row:focus-visible {
    background: var(--well);
    color: var(--ink);
    outline: none;
  }
  :global(:where([data-layout="classic"])) .pick-row:hover,
:global(:where([data-layout="classic"])) .pick-row:focus-visible {
    background: var(--well);
    outline: none;
  }
  /* The chosen row is the control fill, never the accent block (the accent
     block means "the main action"). */
  :global(:where(:root:not([data-layout="classic"]))) .pick-row.on {
    background: var(--well2);
    color: var(--ink);
    font-weight: 500;
  }
  :global(:where([data-layout="classic"])) .pick-row.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  /* The name never shrinks; the grey detail ellipsizes first (backlog 530). */
  .pick-row-label {
    flex: none;
  }
  .pick-row-detail {
    font-size: 11px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .pick-row-cap {
    margin-left: auto;
    padding-left: 16px;
    display: inline-flex;
    flex: none;
  }
  .pick-sep {
    height: 1px;
    background: var(--line);
    margin: 4px 2px;
  }
  /* Filament IV stage 6 (item 570, f4-menus.png): the head is a ruled
     group title (the sub after the rule), a row with a detail is two
     lines — the name, the grey detail under it — with its key cap at the
     right, and the chosen row carries the accent tick. Menus rise in. */
  :global(:where(:root:not([data-layout="classic"]))) .pick-head {
    align-items: center;
    padding: 6px 8px 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-head::after {
    content: "";
    order: 1;
    flex: 1 1 12px;
    min-width: 12px;
    height: 1px;
    background: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-sub {
    order: 2;
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    column-gap: 10px;
    row-gap: 1px;
    padding: 6px 10px;
    font-size: 13px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row-label {
    grid-column: 1;
    grid-row: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row-detail {
    grid-column: 1;
    grid-row: 2;
    font-size: 11.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row-cap {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    margin: 0;
    padding-left: 12px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row::after {
    content: "";
    grid-column: 3;
    grid-row: 1 / span 2;
    align-self: center;
    width: 12px;
    font-size: 12px;
    color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row.on {
    background: var(--well);
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row.on::after {
    content: "✓";
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-row-cap :global(.kbd) {
    border: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    height: auto;
    color: var(--dim);
    font-size: 10.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick-sep {
    background: var(--line2);
    margin: 4px 4px;
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .pick-menu {
      animation: menu-rise 90ms ease-out;
    }
  }
  @keyframes menu-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  /* The bottom row (backlog 112, board 10's C): the card's width, the
     chips on the right. The toggles are the top bar's, styled as they
     were there: off is the dimmed chip, on the accent mark. */
  .bottom-row {
    max-width: 760px;
    margin: 8px auto 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    /* Wraps, never clips (2026-09-18, the same screenshots). */
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Item 716: the bottom row's switches — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  /* Keep-warm (582): the label is a clock time or a reason, never
     capitalised like the one-word toggles. */
  .bottom-toggle.keep-warm {
    text-transform: none;
    font-variant-numeric: tabular-nums;
    /* Item 728: a reason longer than a narrow row ("off — chat handed
       off" at 390 wide) wraps inside the chip, never runs off its left. */
    max-width: 100%;
    white-space: normal;
    text-align: left;
  }
  /* Item 643: a held chat says so on the switch ("· 24 h"). */
  .keep-warm-hold {
    margin-left: 4px;
    color: var(--dim);
  }
  .bottom-cache {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
    /* Item 833 (his shots: "100% cached · 55 min · next ≈ $0.05 · cold ≈
       $1.78" ran past an aside card's right edge): never wider than its
       row; past that it wraps, only at a " · " — the share, the timer and
       each price stay whole. */
    max-width: 100%;
    flex-wrap: wrap;
  }
  .next-part {
    white-space: nowrap;
  }
  /* Item 833, merge round W (his call: a wrapped line must not start with
     "·"). Each part brings its separator in front at one fixed width — the
     first part a blank one — and the lines are shifted left by that width
     inside a clip, so every line's first separator falls outside it. The
     separator keeps its width wherever it is, so the clip never changes
     where the lines break (hiding it by script would: the part would then
     fit back on the line above). */
  .bottom-cache {
    --cache-sep: calc(6px + 2ch);
  }
  .cache-flow {
    display: block;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  .cache-lines {
    display: flex;
    flex-wrap: wrap;
    margin-left: calc(-1 * var(--cache-sep));
  }
  .cache-part {
    white-space: nowrap;
  }
  .cache-sep {
    display: inline-block;
    box-sizing: border-box;
    width: var(--cache-sep);
    padding-left: 6px;
  }
  /* The prices are parts of the same lines (the losing bar's own
     `.bottom-cache-next` is not inside `.cache-lines`). */
  .cache-lines > .bottom-cache-next {
    display: contents;
  }
  /* Backlog 408: the warning reads in the accent, and is a button. */
  .bottom-cache.losing {
    display: inline-flex;
    /* Post-install 16c8e01: each part brings its own "&nbsp;· "; the chip's
       6 px flex gap doubled the space before every "·" (measured in WebKit). */
    gap: 0;
    min-width: 0;
    max-width: 100%;
    color: var(--accent);
    border-color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
    flex-wrap: nowrap;
  }
  .losing-what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bottom-cache.losing .bottom-cache-when {
    flex: none;
    color: var(--accent);
  }
  .restore-word {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  /* Only the timer half dims when cold; the share is still a fact. */
  .bottom-cache.cold .bottom-cache-when {
    color: var(--dim);
  }
  /* Item 699: the next send's price, quieter than the timer; dropped on a
     phone-width window, where the row has no room (the tooltip keeps it). */
  .bottom-cache-next {
    margin-left: 4px;
    color: var(--dim);
    /* ~~nowrap~~ (item 833): its parts are nowrap (`.next-part`), so it wraps
       between "next ≈ …" and "cold ≈ …" when the chip has to. */
    white-space: normal;
  }
  /* Item 777: on the "cache will be lost" bar the price is the point — it
     never shrinks, and the words ahead of it give way first, phone width too. */
  .bottom-cache.losing .bottom-cache-next {
    flex: none;
    color: inherit;
    /* Item 833: the plain chip's wrap is not this bar's — it cuts its words. */
    white-space: nowrap;
    /* Post-install 16c8e01: the separator span carries its own spaces
       (a trailing plain space was dropped, so the face read "off  ·next"). */
    margin-left: 0;
  }
  @media (max-width: 560px) {
    .bottom-cache-next,
    .cache-lines > .bottom-cache-next {
      display: none;
    }
    .bottom-cache.losing .bottom-cache-next {
      display: inline;
    }
    /* Phone width: the price alone (the click still restores; the tooltip
       has the rest). */
    .bottom-cache.losing .cost-vs,
    .bottom-cache.losing .next-sep,
    .bottom-cache.losing .restore-part,
    .bottom-cache.losing .losing-what {
      display: none;
    }
  }

  :global(:where(:root:not([data-layout="classic"]))) .composer {
    position: relative;
    /* The lit level's dot ground goes on under the box (item 525), from
       the top so it meets the transcript's, which is anchored to its foot. */
    /* Item 680: the chat's dots, matching the transcript's above it. */
    background: var(--chat-dots, none) left top / 24px 24px var(--paper);
    padding: 12px 20px 22px;
  }
  :global(:where([data-layout="classic"])) .composer {
    position: relative;
    background: var(--paper);
    padding: 12px 20px 22px;
  }
  /* The drag handle sits on the top edge, over the border: `ResizeHandle`
     since backlog 226, which the aside boxes share. */
  .composer.floating {
    background: transparent;
    border-top: none;
    padding: 0;
    width: 100%;
  }
  /* Held over the box (item 362, B's first frame): the edge turns accent
     with a soft ring, so it reads apart from the focused box's edge. */
  .composer.dropping .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  /* In an aside (backlog 283): the chat's composer inside the aside's
     frame — no panel fill of its own, the card on the aside's tint with a
     dashed edge, so the box he types in never reads as the chat's. */
  .composer.aside {
    background: transparent;
    padding: 8px 0 0;
  }
  /* An aside's box is the aside's, not the object in front: no shadow, no
     brackets. */
  :global(:where(:root:not([data-layout="classic"]))) .composer.aside .card {
    box-shadow: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .composer.aside .card::before {
    display: none;
  }
  .composer.aside .card,
  .composer.aside .attachments,
  .composer.aside .queue,
  .composer.aside .bottom-row {
    max-width: none;
  }
  .composer.aside .card {
    /* Item 470: a rendered quote in the box sits on the card's own ground. */
    --q-ground: var(--aside-well, var(--sheet));
    border-style: dashed;
    background: var(--aside-well, var(--sheet));
  }
  /* ~~Every aside's card 8 px × 10 px, gap 6, its row 5 px under it~~ —
     item 886 (his "the main chat text box seems to sit slightly higher than
     the aside textbox … the spacing is like slightly different"): an aside
     tab's and the side panel's box take the chat's padding, gap and row
     gap; only a floating card in the chat (`compact`) keeps the tight ones. */
  .composer.aside.compact .card {
    padding: 8px 10px;
    gap: 6px;
  }
  .composer.aside.compact .bottom-row {
    margin-top: 5px;
  }
  /* Item 886: the chat's row is taller than an aside's — its Send carries
     the ▾ (Send later), which an aside has not — so the aside's text sat
     lower by the difference (5.8 px Jarvis, 3.9 px Classic, measured at
     1440×900 in the 886 harness). The row keeps the chat's height. */
  :global(:where(:root:not([data-layout="classic"]))) .composer.aside:not(.compact) .row {
    min-height: 33.8px;
  }
  :global(:where([data-layout="classic"])) .composer.aside:not(.compact) .row {
    min-height: 36.8px;
  }
  .composer.aside .card:focus-within {
    border-style: solid;
  }
  .composer.aside .bottom-row {
    /* ~~space-between~~ (item 833): wrapped, it spread the chips of each
       later line apart (Format alone at the left in his shots); the line
       grows and the spacer pushes, so flex-end reads as the chat's row. */
    justify-content: flex-end;
    /* Item 786: the cache chips joined the row; it wraps, never clips. */
    flex-wrap: wrap;
  }
  .aside-line {
    min-width: 0;
    color: var(--dim);
    font-size: 11.5px;
    line-height: 1.35;
  }
  .aside-line .ns-btn {
    margin-left: 4px;
  }
  .composer.aside.compact textarea {
    font-size: inherit;
  }
  .composer.floating.dropping {
    background: transparent;
  }
  .composer.floating .card,
  .composer.floating .attachments,
  .composer.floating .hint {
    max-width: none;
  }
  .composer.floating textarea {
    font-size: 15.5px;
  }
  /* The offer's look moved to `PasteOfferRow.svelte` with it (item 399b). */
  /* The queue tray: joined to the top of the card, dashed so it reads as
     "not sent yet" (backlog 089). Plain rows; the real design is the
     Fable board's. */
  :global(:where(:root:not([data-layout="classic"]))) .queue {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    border: 1px dashed var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
    padding: 0.4rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 13px;
  }
  :global(:where([data-layout="classic"])) .queue {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 13px;
  }
  .queue-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .queue-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .queue-n {
    color: var(--dim);
    flex: none;
  }
  .queue-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queue-row .remove {
    position: static;
    flex: none;
  }
  /* Item 548: a tray row opened by "more" shows its whole text, wrapped. */
  .queue-row.fil.open {
    align-items: flex-start;
  }
  .queue-row.fil.open .queue-text {
    white-space: normal;
  }
  .queue-whole {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .queue-more {
    flex: none;
    font-size: 12px;
    color: var(--dim);
  }
  .queue-acts {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .attachments {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .lost-paste {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    font-size: 13px;
    line-height: 1.4;
  }
  .lost-paste-text {
    flex: 1;
  }
  .lost-paste-x {
    background: none;
    border: 0;
    color: var(--dim);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 0.15rem;
  }
  .lost-paste-x:hover {
    color: var(--fg);
  }
  .attachment {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
  }
  /* The chip and its × (item 306 put Keep under them, so the × keeps to
     the chip's corner rather than the column's). */
  .attachment-face {
    position: relative;
    line-height: 0;
    /* Item 362: the accent ring a dropped chip arrives with (`chipDropIn`). */
    border-radius: 8px;
    box-shadow: var(--drop-ring, none);
  }
  .image-open {
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
    display: block;
    border-radius: 8px;
  }
  /* Item 797: a pick chip's mark, and its opened contents. */
  .image-open.picked {
    position: relative;
    cursor: pointer;
  }
  .pick-mark {
    position: absolute;
    left: 3px;
    bottom: 3px;
    font-size: 8.5px;
    line-height: 12px;
    padding: 0 3px;
    border-radius: 3px;
    background: var(--accent);
    color: var(--on-accent, #000);
    letter-spacing: 0.04em;
  }
  .pick-detail {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--well, transparent);
  }

  .pick-crop {
    width: auto;
    height: auto;
    max-width: 220px;
    max-height: 140px;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: 6px;
    display: block;
  }
  .pick-words {
    flex: 1;
    margin: 0;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }
  .image-open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .attachment img {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: block;
  }
  /* A document has no thumbnail to show, so the chip carries its name — the
     one thing that tells three attachments apart. */
  :global(:where(:root:not([data-layout="classic"]))) .file {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.2rem;
    width: 7rem;
    height: 4rem;
    padding: 0 0.5rem;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--raised);
    line-height: 1.2;
  }
  :global(:where([data-layout="classic"])) .file {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.2rem;
    width: 7rem;
    height: 4rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    line-height: 1.2;
  }
  /* Item 491: a long PDF's chip carries its route and the switch. */
  .file.long {
    width: 9.5rem;
    height: auto;
    min-height: 4rem;
    padding-block: 0.35rem;
  }
  /* Item 459: a kept file's chip is a way to it in Notes. */
  .file.kept {
    cursor: pointer;
  }
  .file.kept:hover,
  .file.kept:focus-visible {
    border-color: var(--accent);
  }
  .file-ext {
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .file-name {
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* What will happen to it (item 277): "slides → PDF · 12 pages". */
  .file-label {
    font-size: 0.62rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file.pending .file-label {
    animation: file-converting 1.2s ease-in-out infinite;
  }
  @keyframes file-converting {
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .file.pending .file-label {
      animation: none;
    }
  }
  .remove {
    position: absolute;
    top: -0.35rem;
    right: -0.35rem;
    width: 1.15rem;
    height: 1.15rem;
    padding: 0;
    background: var(--panel);
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
  }
  .remove:hover {
    color: var(--failed);
    border-color: var(--failed);
  }
  /* The mock-up's composer card: the text on top, the toolbar under it. */
  :global(:where(:root:not([data-layout="classic"]))) .card {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* The one object in front of the transcript (Filament IV, item 525):
       the raised fill, the control edge, one plain dark shadow under it. */
    padding: 13px 14px 12px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    transition: border-color 0.12s;
  }
  :global(:where([data-layout="classic"])) .card {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    transition: border-color 0.12s;
  }
  .card:focus-within {
    border-color: var(--accent);
  }
  /* The lit level's brackets: four corner marks 6px outside the box, in the
     accent (`--bracket`; transparent in calm and the classic palettes).
     Eight 12 × 1.5px strokes drawn as backgrounds: nothing to lay out,
     nothing that takes the pointer. */
  :global(:where(:root:not([data-layout="classic"]))) .card::before {
    content: "";
    position: absolute;
    inset: -7px;
    pointer-events: none;
    --tk: var(--bracket, transparent);
    background:
      linear-gradient(var(--tk), var(--tk)) 0 0 / 12px 1.5px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 0 0 / 1.5px 12px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 100% 0 / 12px 1.5px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 100% 0 / 1.5px 12px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 0 100% / 12px 1.5px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 0 100% / 1.5px 12px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 100% 100% / 12px 1.5px no-repeat,
      linear-gradient(var(--tk), var(--tk)) 100% 100% / 1.5px 12px no-repeat;
  }
  /* Item 716: the row's ghost buttons — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  .row {
    display: flex;
    align-items: center;
    /* Wraps rather than clips (his screenshots at ⌘+ zoom, 2026-09-18:
       "Ask a…" cut at the window's edge): what does not fit — Ask aside,
       Council, Send — drops to a second line. */
    flex-wrap: wrap;
    gap: 6px 8px;
    /* ~~container-type: inline-size~~ — no rule queried it, and under
       WebKit page zoom a container query reads width × zoom (backlog 183);
       the row folds by measurement (`refoldRow`, 190). */
  }
  .short-word {
    display: none;
  }
  /* The fold levels (item 289: six, the floor last). */
  .row:not([data-fold="0"]) .pick-k {
    display: none;
  }
  .row:is([data-fold="5"], [data-fold="6"]) .draft-tokens {
    display: none;
  }
  /* Item 716: Council's icon and the Attach square — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  .row:is([data-fold="2"], [data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .fold-word,
  .row:is([data-fold="2"], [data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .council-word {
    display: none;
  }
  .row:is([data-fold="2"], [data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .short-word {
    display: inline;
  }
  .row:is([data-fold="2"], [data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .council-ico {
    display: inline-flex;
  }
  .row:is([data-fold="4"]) .pick-name {
    max-width: 72px;
  }
  .row:is([data-fold="5"], [data-fold="6"]) .pick-name {
    max-width: 48px;
  }
  /* Item 833: an aside's pickers have a compact form — the value alone
     ("Opus 5.5", not "chat's · Opus 5.5") — so from level 4 they swap to
     it whole rather than cut "chat's · …" to "chat's …". */
  .pick-short {
    display: none;
  }
  .row:is([data-fold="4"], [data-fold="5"], [data-fold="6"]) .pick-name.has-short {
    max-width: none;
  }
  .row:is([data-fold="4"], [data-fold="5"], [data-fold="6"]) .has-short .pick-long {
    display: none;
  }
  .row:is([data-fold="4"], [data-fold="5"], [data-fold="6"]) .has-short .pick-short {
    display: inline;
  }
  /* The floor: the pickers keep row one at the left; a zero-height break
     (the row's ::after, a full-width flex item) sends the actions to row
     two, right-aligned by the spacer — read left to right, top to bottom,
     as on one row. Both rows are the buttons' height. */
  .row[data-fold="6"] > .act {
    order: 2;
  }
  .row[data-fold="6"] > .spacer {
    order: 2;
  }
  .row[data-fold="6"]::after {
    content: "";
    order: 1;
    flex-basis: 100%;
    height: 0;
  }
  .row[data-fold="6"] > * {
    min-height: 28px;
  }
  .spacer {
    flex: 1;
  }
  /* The draft's token estimate (backlog 155): dim, small, beside Send. */
  .draft-tokens {
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    cursor: default;
  }
  /* ~~The key hint (↵ to send · ⇧↵ newline)~~ — deleted 2026-09-22 on his
     word (nightshift backlog 177): it pushed Council and Send onto a second
     line; the Queue button says Enter queues during a turn. */
  :global(:where(:root:not([data-layout="classic"]))) textarea {
    width: 100%;
    background: transparent;
    color: var(--ink);
    caret-color: var(--accent);
    border: none;
    padding: 2px 0;
    font-size: 15px;
    font-family: inherit;
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    /* A message wraps; a sliver of horizontal overflow was drawing a full
       10px scrollbar thumb across the box (his screenshot, 2026-09-16). */
    overflow-x: hidden;
    box-sizing: border-box;
  }
  :global(:where([data-layout="classic"])) textarea {
    width: 100%;
    background: transparent;
    color: var(--ink);
    border: none;
    padding: 2px 0;
    font-size: 15px;
    font-family: inherit;
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    /* A message wraps; a sliver of horizontal overflow was drawing a full
       10px scrollbar thumb across the box (his screenshot, 2026-09-16). */
    overflow-x: hidden;
    box-sizing: border-box;
  }
  textarea::placeholder {
    color: var(--dim);
  }
  /* Item 223: the textarea and the layer behind it share one box. A 10px
     gutter left of the text holds the quote bar; the wrap's negative margin
     keeps the text where it always was, so nothing moves when a quote
     appears or goes. */
  .ta-wrap {
    position: relative;
    margin-left: -10px;
    width: calc(100% + 10px);
  }
  .ta-wrap textarea {
    position: relative;
    z-index: 1;
    display: block;
    padding-left: 10px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  textarea.quoted {
    color: transparent;
    caret-color: var(--ink);
  }
  /* The layer's own look (`.ta-mirror`, quote and code lines, the language
     picker) moved to `BoxLayer.svelte` with it (item 399). */
  textarea:focus {
    outline: none;
  }
  textarea:disabled {
    opacity: 0.5;
  }
  /* Item 716: Send's size — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  /* Item 716 part 4: the Stop in Send's place (its shapes, its pressed state, the spinner) — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  .stop-why {
    font-size: 11.5px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    /* A basis of 0: it takes the room the row has and ellipsizes in it,
       never pushing Queue and Stop onto a line of their own. */
    flex: 1 1 0;
    text-align: right;
  }
  /* Item 716: Send's split and the Jarvis Send / Ask aside / Council — moved, verbatim and re-rooted on `.composer`, to src/composerControls.css. */
  .hint {
    max-width: 760px;
    margin: 0.4rem auto 0;
    color: var(--dim);
    font-size: 0.75rem;
  }
  /* The ghost line (backlog 083): the textarea's own face, dimmed, laid
     over its first line; the card is the positioning frame. */
  .card {
    position: relative;
  }
  /* Item 754: comments on passages — a row of chips over the box (the
     held chip's pill), and the open one's comment line under them. */
  .comments-wrap {
    max-width: 760px;
    margin: 0 auto 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .comment-chips {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  /* Item 881: the chips' own wrapping column beside the label. */
  .comment-list {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .comment-k {
    font: 10.5px var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
    flex: none;
  }
  .comment-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
    padding: 2px 4px 2px 9px;
    background: var(--raised);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line2));
    border-radius: 999px;
    font-size: 12px;
    color: var(--ink2);
    white-space: nowrap;
  }
  .comment-chip.open {
    border-color: var(--accent);
  }
  .comment-open {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    cursor: pointer;
  }
  .comment-open:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
    border-radius: 999px;
  }
  .comment-open :global(.ns-ico) {
    color: var(--accent);
    flex: none;
  }
  .comment-q {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
  }
  .comment-n {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--dim);
  }
  .comment-n::before {
    content: "— ";
  }
  .comment-edit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-left: 2px solid var(--accent);
    border-radius: var(--r1, 6px);
  }
  .comment-quote {
    font-size: 12px;
    color: var(--ink2);
    white-space: pre-wrap;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  /* Item 880: the passage rendered as the reply drew it — its maths
     typeset — in the quote's small size, about three lines tall. */
  .comment-quote.rendered {
    display: block;
    white-space: normal;
    max-height: 6.2em;
    line-height: 1.45;
  }
  .comment-quote.rendered :global(p) {
    margin: 0.25em 0;
  }
  .comment-quote.rendered :global(.katex-display) {
    margin: 0.2em 0;
    padding: 0.1em 0;
    text-align: left;
  }
  .comment-quote.rendered :global(.katex-display > .katex) {
    text-align: left;
  }
  /* Item 880: a chip's formula at the chip's own size, on its one line. */
  .chip-math :global(.user-math .katex) {
    font-size: 1em;
  }
  .comment-ta {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    min-height: 2.6em;
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink);
    white-space: pre-wrap;
    field-sizing: content;
    max-height: 9em;
    overflow-y: auto;
  }
  .comment-ta::placeholder {
    color: var(--dim);
  }
  .plain .comment-chip {
    border-color: var(--line2);
    border-radius: var(--r1, 4px);
    background: transparent;
  }
  .plain .comment-chip.open {
    border-color: var(--ink2);
  }
  .plain .comment-edit {
    border-left-color: var(--line2);
    background: transparent;
  }
  /* Item 694: the held passage's chip, above the box — the cap chip's
     pill (TurnCapChip), the passage in the accent's tint under Jarvis;
     Classic's flat chip. */
  .held-wrap {
    max-width: 760px;
    margin: 0 auto 8px;
    display: flex;
  }
  .held-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 100%;
    padding: 3px 4px 3px 9px;
    background: var(--raised);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line2));
    border-radius: 999px;
    font-size: 12px;
    color: var(--ink2);
    white-space: nowrap;
  }
  .held-chip :global(.fil-svg) {
    color: var(--accent);
  }
  .held-k {
    font: 10.5px var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
    flex: none;
  }
  .held-q {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
  }
  .held-x {
    all: unset;
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    color: var(--dim);
    cursor: pointer;
  }
  .held-x:hover {
    color: var(--ink);
    background: var(--well);
  }
  .held-x:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }
  .plain .held-chip {
    border-color: var(--line2);
    border-radius: var(--r1, 4px);
    background: transparent;
  }
  .ghost-line {
    position: absolute;
    left: 14px;
    right: 14px;
    top: 12px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    background: transparent;
    border: none;
    text-align: left;
    font-size: 15px;
    line-height: 1.5;
    font-family: inherit;
    color: var(--dim);
    cursor: pointer;
    pointer-events: auto;
    z-index: 1;
    overflow: hidden;
    white-space: nowrap;
  }
  .ghost-text {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .ghost-key {
    font-family: var(--mono);
    font-size: 11px;
    border: 1px solid var(--line2);
    border-radius: 4px;
    padding: 0 4px;
    flex-shrink: 0;
  }

  /* The hand-off notice (backlog 086; pass 2 follows the board's card:
     accent rule, a heading with the fill at the right, one line, the
     fields, the actions with the key strip). ~~one ruled row above the
     box~~ — the row is now the heading. */
  :global(:where(:root:not([data-layout="classic"]))) .handoff {
    max-width: 760px;
    margin: 0 auto 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--accent);
    border-radius: var(--r2);
    background: var(--raised);
    font-size: 13px;
    color: var(--ink2);
  }
  :global(:where([data-layout="classic"])) .handoff {
    max-width: 760px;
    margin: 0 auto 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--sheet);
    font-size: 13px;
    color: var(--ink2);
  }
  /* Backlog 383: the card folded to one line. */
  .handoff.handoff-min {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 13px;
    white-space: nowrap;
  }
  .handoff-min-title {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  /* Review 2026-10-18: at a 700 pt window the title read "HA…"; the fill
     (repeated in the due title, secondary on the wrapped one) gives up its
     room first and is gone on a narrow line, so the title keeps what fits. */
  .handoff.handoff-min {
    container-type: inline-size;
  }
  .handoff-min .handoff-fill {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1000 auto;
  }
  @container (max-width: 560px) {
    .handoff-min .handoff-fill {
      display: none;
    }
  }
  .handoff-min .ns-btn {
    flex: none;
  }
  .handoff-min .handoff-mark {
    flex: none;
  }
  .handoff-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 14px;
    color: var(--ink);
    line-height: 1.4;
  }
  /* The board's branch mark on the done card (Handoff.dc.html). */
  .handoff-mark {
    display: inline-flex;
    color: var(--accent);
  }
  .handoff-fill {
    font-size: 11.5px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .handoff-d {
    margin: 0;
    font-size: 12.5px;
    color: var(--dim);
    line-height: 1.45;
  }
  .handoff code {
    font-family: var(--mono);
    font-size: 12px;
  }
  /* ~~`.handoff-row` and its number box~~ — item 705: the mark is the card's stepper (`.hc-step`). */
  /* The message: the composer's own field face, so it reads as the one
     thing here that is typed into. */
  :global(:where(:root:not([data-layout="classic"]))) .handoff-msg {
    width: 100%;
    background: var(--term);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    padding: 6px 8px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.45;
    resize: vertical;
  }
  :global(:where([data-layout="classic"])) .handoff-msg {
    width: 100%;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.45;
    resize: vertical;
  }
  .handoff-msg:focus {
    outline: none;
    border-color: var(--accent);
  }
  .handoff-acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .handoff-keys {
    margin-left: auto;
    font-size: 11px;
    color: var(--dim);
  }

  /* Item 705 (option A, Console — his pick, blocker 2167; the mockup is
     nightshift-code notes/runner-design/705-options-2026-11-18/): a kicker
     and title, a fill gauge with the mark as a tick, one row of controls,
     the message, the buttons. Layout here for both layouts; the look in
     Jarvis is the glass in the hand-off's amber, in Classic the sheet as
     before (Classic is a backup). */
  .handoff.hc {
    position: relative;
    padding: 0;
    gap: 0;
    box-sizing: border-box;
  }
  .hc-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 0;
    min-width: 0;
  }
  .hc-kicker {
    flex: none;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent-ink, var(--accent));
  }
  .hc-title {
    color: var(--ink);
    font-size: 14px;
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hc-x {
    margin-left: auto;
    display: flex;
    gap: 4px;
    flex: none;
  }
  .hc-ico {
    width: 24px;
    height: 24px;
    flex: none;
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--r1, 6px);
    background: none;
    color: var(--dim);
    font: 13px var(--mono);
    cursor: pointer;
  }
  .hc-ico:hover,
  .hc-ico:focus-visible {
    background: var(--well, var(--paper));
    color: var(--ink);
    outline: none;
  }
  .hc-body {
    padding: 10px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hc-compact .hc-body {
    gap: 8px;
  }
  .hc-meter {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hc-gauge {
    position: relative;
    display: block;
    height: 4px;
    flex: 1;
    min-width: 40px;
    border-radius: 3px;
    background: var(--well, var(--line));
  }
  .hc-gauge > i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--accent);
  }
  .hc-gauge > b {
    position: absolute;
    top: -3px;
    width: 2px;
    height: 10px;
    margin-left: -1px;
    border-radius: 1px;
    background: var(--ink);
  }
  /* Compact: the gauge and its number go together at the row's right, and wrap as one. */
  .hc-fill-row {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: none;
    white-space: nowrap;
  }
  /* A width, not only a basis: an empty span's basis does not count in the
     group's own width (WebKit measured the group 101 px for 171 px of parts). */
  .hc-gauge-row {
    flex: none;
    width: 110px;
  }
  .hc-gauge-mini {
    flex: none;
    width: 90px;
  }
  .hc-gnum {
    white-space: nowrap;
  }
  .hc-gnum em {
    font-style: normal;
    color: var(--accent-ink, var(--accent));
  }
  .hc-fields {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .hc-sep {
    width: 1px;
    height: 18px;
    margin: 0 2px;
    background: var(--line2);
  }
  .hc-lbl {
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    white-space: nowrap;
  }
  /* The mark's stepper: − value% +, mono; the value is typed in too. */
  .hc-step {
    display: inline-flex;
    align-items: stretch;
    height: 28px;
    box-sizing: border-box;
    border: 1px solid var(--line2);
    overflow: hidden;
  }
  .hc-step > button {
    width: 26px;
    padding: 0;
    border: none;
    color: var(--ink2);
    font: 14px var(--mono);
    cursor: pointer;
  }
  .hc-step > button:first-child {
    border-right: 1px solid var(--line2);
  }
  .hc-step > button:last-child {
    border-left: 1px solid var(--line2);
  }
  .hc-step > button:hover {
    color: var(--ink);
  }
  .hc-step > input {
    width: 2.6em;
    padding: 0 0 0 6px;
    border: none;
    background: none;
    color: var(--ink);
    font: 500 12.5px var(--mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .hc-step > input::-webkit-inner-spin-button,
  .hc-step > input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .hc-step > input:focus {
    outline: none;
  }
  .hc-step > small {
    display: flex;
    align-items: center;
    padding: 0 6px 0 1px;
    color: var(--dim);
    font: 12px var(--mono);
  }
  .hc-step:focus-within {
    border-color: var(--accent);
  }
  .hc .handoff-msg {
    box-sizing: border-box;
    padding: 8px 10px;
    line-height: 1.5;
  }
  /* Compact: the message folds to two lines and fades; a click edits it in full. */
  .hc .handoff-msg.hc-clip {
    resize: none;
    -webkit-mask-image: linear-gradient(180deg, #000 55%, transparent);
    mask-image: linear-gradient(180deg, #000 55%, transparent);
  }
  .hc .handoff-msg.hc-clip:focus {
    -webkit-mask-image: none;
    mask-image: none;
    min-height: 7.5em;
  }
  /* The one line. */
  .handoff.hc.hc-mini {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 12px;
  }
  .hc-mini .hc-title {
    font-size: 13px;
  }
  @container (max-width: 560px) {
    .hc-mini .hc-gauge-mini {
      display: none;
    }
  }
  :global(:where(:root:not([data-layout="classic"]))) .handoff.hc {
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line2));
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, var(--raised)), var(--raised) 60%);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--accent) 30%, transparent),
      0 10px 30px rgba(0, 0, 0, 0.35);
    margin-bottom: 8px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .hc-gauge > i {
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), var(--accent));
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .hc-step {
    border-radius: var(--r1);
    background: var(--term);
  }
  :global(:where(:root:not([data-layout="classic"]))) .hc-step > button {
    background: var(--well);
  }
  :global(:where(:root:not([data-layout="classic"]))) .hc .ns-btn.accent.hc-go {
    background: var(--term);
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--line2));
    color: var(--accent-ink);
    box-shadow: inset 0 0 10px color-mix(in srgb, var(--accent) 14%, transparent), var(--glow-main);
  }
  :global(:where(:root:not([data-layout="classic"]))) .handoff-msg:focus,
  :global(:where(:root:not([data-layout="classic"]))) .hc .handoff-msg:focus {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line2));
  }
  /* The grip, lit while the card is up: it sizes the card first. */
  :global(:where(:root:not([data-layout="classic"]))) .composer.hc-grip > :global(.handle)::after {
    width: 46px;
    background: color-mix(in srgb, var(--accent) 50%, var(--line2));
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  :global(:where([data-layout="classic"])) .hc-step {
    border-radius: 6px;
    background: var(--paper);
  }
  :global(:where([data-layout="classic"])) .hc-step > button {
    background: var(--sheet);
  }
  :global(:where([data-layout="classic"])) .composer.hc-grip > :global(.handle)::after {
    background: var(--accent);
  }

  /* The `/` picker (backlog 077): a plain list joined to the card's top. */
  :global(:where(:root:not([data-layout="classic"]))) .slash {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line2);
    border-bottom: none;
    border-radius: var(--r2) var(--r2) 0 0;
    background: var(--raised);
    max-height: 16rem;
    overflow-y: auto;
  }
  :global(:where([data-layout="classic"])) .slash {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    background: var(--sheet);
    max-height: 16rem;
    overflow-y: auto;
  }
  .slash-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 5px 10px;
    font-size: 12.5px;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--ink);
    font-family: var(--sans);
    cursor: pointer;
  }
  .slash-row.on {
    background: var(--well);
  }
  .slash-row .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .slash-row .dim,
  .slash-row.dim {
    color: var(--dim);
    cursor: default;
    font-size: 11.5px;
  }
  /* Filament IV stage 6 (item 570): the picked row on the control fill
     with the accent rule at its left; the key line under a rule, in mono. */
  :global(:where(:root:not([data-layout="classic"]))) .slash {
    padding: 4px;
    gap: 1px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .slash-row {
    border-radius: var(--r1);
    padding: 6px 10px;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .slash-row:hover:not(.dim) {
    background: var(--well);
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .slash-row.on {
    background: var(--well);
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .slash-row.dim:last-child:not(:first-child) {
    border-top: 1px solid var(--line);
    border-radius: 0;
    margin-top: 3px;
    font-family: var(--mono);
    font-size: 10.5px;
  }

  /* Item 702: the whole folded bar expands on click (both layouts). */
  .handoff-min-open { cursor: pointer; }
</style>
