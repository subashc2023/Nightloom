<script lang="ts">
  import { tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import ResizeHandle from "./ResizeHandle.svelte";
  import { dragHeight, growHeight, loadBoxHeight, saveBoxHeight } from "./boxGrow";
  import { sentSinceDrag } from "./composerSize";
  import {
    app,
    addToast,
    applyDraft,
    cacheHitRate,
    cancelTurn,
    continueChat,
    runningChatName,
    providerElsewhereName,
    registerProviderDrain,
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
  import { effortDefaultLabel } from "./effortDefaults";
  import { cacheLine, cacheState, nextTickMs, remainingText } from "./cache";
  import { HIDDEN_THINKING_TITLE, thinkingToggleDead } from "./activity";
  import { toggleTranscriptPref, transcript } from "./transcriptPrefs.svelte";
  import { composerFormat, toggleComposerFormat } from "./composerFormat.svelte";
  import { LiveBoxHandle, boxElement, type ComposerBox } from "./composerEditor";
  import LiveBox from "./LiveBox.svelte";
  import { isMac } from "./platform";
  import {
    RE_ASK,
    abortWrapUp,
    awayNow,
    beginWrapUp,
    clearMessage,
    clearReadOrder,
    handoff,
    hasOwnMessage,
    hasOwnReadOrder,
    hasOwnThreshold,
    message,
    noteActivity,
    noteFill,
    queueHold,
    readOrder,
    reconsider,
    setMessage,
    setReadOrder,
    setThreshold,
    stayHere,
    threadFor,
    threshold,
    noteThread,
  } from "./handoff.svelte";
  import ThreadPicker from "./ThreadPicker.svelte";
  import { chatThread, refreshThreadFlags } from "./state.svelte";
  import { draftEstimate, draftEstimateTitle, draftExact, draftExactTitle, EXACT_TOKENS_FROM, fmtTokens } from "./tokens";
  import { exactCounter, type ExactResult } from "./draftCount";
  import { countDraftTokens, officeConverter, pasteIntoFocus, prepareOfficeAttachment } from "./api";
  import KeepButton from "./KeepButton.svelte";
  import { keepKey } from "./keep";
  import { menuInterceptors } from "./state.svelte";
  import {
    canUndo,
    followOffer,
    isPasteAsAttachmentKey,
    longPasteOffer,
    normalizeNewlines,
    pastedFile,
    pastedLabel,
    pastedName,
    pasteAction,
    undoConverted,
    withoutSpan,
    type Converted,
    type LongPaste,
  } from "./pasteAttach";
  import {
    badgeOf,
    convertedLabel,
    convertingLabel,
    decide,
    extOf,
    imageType,
    looksLikeText,
    MAX_OFFICE_BYTES,
    notebookText,
    OFFICE_EXTS,
    routeOf,
  } from "./attachKinds";
  import { sendTip, tip } from "./tip";
  import { floatMenu } from "./floatMenu";
  import { ghostFor } from "./suggestions.svelte";
  import { queuedElsewhereToast } from "./browse";
  import {
    addAttachment,
    clearDraft,
    draftKey,
    draftSelection,
    dropQueued,
    enqueueMessage,
    historyFor,
    nextAttachmentId,
    nextQueueId,
    readDraft,
    removeAttachment,
    requeueFront,
    restoreDraft,
    setDraftAttachments,
    setDraftSelection,
    setDraftText,
    shiftQueue,
    takeBackQueued,
    updateAttachment,
    NEW_DRAFT_PREFIX,
  } from "./drafts.svelte";
  import type { Attachment } from "./types";
  // Scheduled send (backlog 224): the ▾ beside Send and the chip above.
  import ScheduleMenu from "./ScheduleMenu.svelte";
  import ScheduledChip from "./ScheduledChip.svelte";
  import { registerScheduleDrain } from "./scheduleRuntime";
  import CouncilPopover from "./CouncilPopover.svelte";
  import ClipPanel from "./ClipPanel.svelte";
  import { clips, recordImage, recordText } from "./clipRing.svelte";
  import type { CouncilPrefs } from "./council";
  import { foldToFit } from "./fold";
  import { Marks, chipMotion, prefersReducedMotion } from "./chipFade";
  import { codePasteLanguage, fenced, findFences, layerLines, withFenceLanguage } from "./codeDetect";
  import { LANGUAGES } from "./codeHighlight";
  import { launch } from "./sendMotion";
  import { composerConnectHint, launch as launchState } from "./launch.svelte";
  import { hasQuoteLine, insertQuote, mirrorLines, replyRequest, takeReply } from "./replyQuote.svelte";
  import { composerFocus } from "./rewindDraft.svelte";
  import { CaretKeeper, mayAutoFocus } from "./composerCaret";
  import { chatBoxCount, chatBoxMounted, composerSummon } from "./composerSummon.svelte";
  import { requestWrapUp } from "./wrapAsides.svelte";
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
  import { asideDraftKey } from "./asides";
  import { composerShows } from "./asideControls";
  import { scheduleAsideSave } from "./asides.svelte";
  import { prewarmer, wantsWarm } from "./prewarm";

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
  const key = $derived(aside ? asideDraftKey(aside) : draftKey(app.activeSessionId, app.project?.id, app.pendingMode));
  const draft = $derived(readDraft(key));
  const text = $derived(draft.text);

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
  // Item 256: the next message's process starts while he types, so Send
  // finds the CLI, his hooks and the MCP servers already done.
  $effect(() => {
    if (wantsWarm({ engine: app.connection?.engine, busy: app.busy, aside: !!aside, text })) prewarmer.poke();
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
   * textarea's client box and scrolled with it (`syncMirror`).
   */
  let mirror = $state<HTMLDivElement | null>(null);
  function syncMirror() {
    if (!mirror || !ta) return;
    mirror.style.width = ta.clientWidth + "px";
    mirror.style.height = ta.clientHeight + "px";
    mirror.scrollTop = ta.scrollTop;
    // Item 315: each code block's label rides on its opening fence line,
    // hidden while that line is scrolled out of the box.
    const tops: (number | null)[] = [];
    for (const el of mirror.querySelectorAll<HTMLElement>("[data-fence]")) {
      const top = el.offsetTop - mirror.scrollTop;
      tops[Number(el.dataset.fence)] = top >= 0 && top < mirror.clientHeight - 4 ? top : null;
    }
    fenceTops = tops;
  }
  let fenceTops = $state<(number | null)[]>([]);
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
    floorPx = loadHeight(key);
  });

  /**
   * Since backlog 254 a send turns the dragged height into a ceiling:
   * the box goes back to one line, and typing grows it up to his size
   * (`maxHeight` keeps the floor in the cap). A drag makes it a floor again.
   */
  function afterSend(k: string): void {
    sentSinceDrag.sent(k);
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
    ta.style.height = "auto";
    const need = ta.scrollHeight;
    ta.style.height = was;
    return need;
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
    // The pointer half is `boxGrow.ts`'s since backlog 226 (the aside
    // boxes drag with it too); the handle is on the top edge.
    dragHeight(e, ta.offsetHeight, "top", setHeight, () => {
      dragging = false;
      persistHeight();
    });
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

  // Anthropic rejects a base64 image over ~10 MB and a PDF over ~32 MB, and
  // nothing checks either before the wire, so the refusal has to happen here.
  // base64 inflates by 4/3, and the caps apply to the encoded payload.
  const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
  const MAX_DOCUMENT_BASE64 = 32 * 1024 * 1024;
  // Lower on the Claude Code engine, and not because the CLI refuses: it
  // accepts the whole document on stdin and then, somewhere between it and
  // the model, drops one over ~23 MiB encoded — exit 0, no error line, and
  // a reply that asks which document you meant. Measured on 2.1.263: 22.7 MiB
  // reached the model, 24.0 MiB did not. 20 MiB leaves a margin under the
  // last size that worked, and a named refusal here is the only place that
  // failure can be made loud. Images near their own cap went through.
  const MAX_AGENT_DOCUMENT_BASE64 = 20 * 1024 * 1024;
  const encodedLimit = (n: number) => Math.floor((n / 4) * 3);

  function autogrow() {
    if (!ta) return;
    const max = maxHeight();
    // The floor (backlog 111) is the docked box's; the floating one keeps
    // sizing to its text.
    const min = floating ? 0 : Math.min(max, sentSinceDrag.floor(key, floorPx) ?? 0);
    ta.style.maxHeight = max + "px";
    ta.style.height = "auto";
    ta.style.height = growHeight(ta.scrollHeight, min, max) + "px";
    syncMirror();
  }

  // A resized window moves the 40% line.
  $effect(() => {
    const onresize = () => autogrow();
    window.addEventListener("resize", onresize);
    return () => window.removeEventListener("resize", onresize);
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
  const slashOpen = $derived(
    slashNames.length > 0 && /^\/[A-Za-z0-9_-]*$/.test(text) && !slashDismissed,
  );
  const slashMatches = $derived.by(() => {
    if (!slashOpen) return [];
    const q = text.slice(1).toLowerCase();
    return slashNames.filter((s) => s.name.toLowerCase().startsWith(q)).slice(0, 12);
  });
  $effect(() => {
    // A fresh box (no leading slash) re-arms the picker; typing resets the row.
    void text;
    if (!/^\//.test(text)) slashDismissed = false;
    slashIndex = 0;
  });
  function pickSlash(name: string): void {
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
   * now. Once its turn ends the bar offers *Continue in a new chat · Stay
   * here* (asked, not automatic — blocker 092, answered by 120). Only for
   * the chat the state is about, and only on the Claude Code engine, which
   * is the one that fills.
   */
  const handoffHere = $derived(
    composerShows("handoff", !!aside) &&
      app.connection?.engine === "claude-code" &&
      handoff.chat === app.activeSessionId &&
      handoff.chat !== null,
  );
  const handoffPct = $derived(Math.round(handoff.fill * 100));
  const handoffThresholdPct = $derived(Math.round(threshold(app.activeSessionId) * 100));
  const handoffDefaultPct = $derived(Math.round(threshold(null) * 100));
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
  /** The wrap-up this chat would send: its own edit, else its thread's, else the Settings default. */
  const wrapUpText = $derived(message(app.activeSessionId));
  /** The read order this chat's continuation opens with (backlog 193). */
  const readOrderText = $derived(readOrder(app.activeSessionId));
  /** The wrap-up Nightloom queued while he was away is still in the queue. */
  const wrapUpQueued = $derived(handoff.queuedId !== 0 && queue.some((q) => q.id === handoff.queuedId));

  /** **Wrap up now**: the message as it stands, as a turn of its own. */
  async function sendWrapUpNow(): Promise<void> {
    if (app.busy || !app.connection || !wrapUpText.trim()) return;
    noteActivity();
    const chat = app.activeSessionId;
    // Item 285: with open asides, their picker first; each ticked aside's
    // summary rides in (log.md for a bound chat, the message otherwise).
    const text = wrapUpText;
    await requestWrapUp(chat, async (extra) => {
      if (app.busy || !app.connection || app.activeSessionId !== chat) {
        addToast("The wrap-up did not go — the chat was busy or no longer open; press Wrap up now again");
        return;
      }
      beginWrapUp(chat);
      await dispatch(extra ? `${text}\n\n${extra}` : text, [], true);
    });
  }

  /** The per-chat mark on the notice: raising it above the fill puts the notice away. */
  function setChatThreshold(v: string): void {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    setThreshold(app.activeSessionId, Math.min(100, Math.max(1, Math.round(n))) / 100);
    reconsider(app.activeSessionId);
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
      addAttachment(key, { id: nextAttachmentId(), kind: "image", name: c.name, media_type: c.media_type, data: c.data });
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
    // Reply is to the chat (283): an aside's box must not take the quote.
    if (aside) return;
    const passage = untrack(() => takeReply());
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
    if (aside || seq === focusSeen) return;
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
  }
  $effect.pre(() => {
    const k = key;
    untrack(() => {
      if (shownKey !== null && shownKey !== k) {
        valueBefore = ta?.value ?? null;
        keeper.record(shownKey, ta, readDraft(shownKey).text);
      }
    });
  });
  $effect(() => {
    const k = key;
    untrack(() => {
      if (shownKey === k) return;
      shownKey = k;
      keeper.arrive(k);
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
      });
    });
  });
  // ⌘L (backlog 290): the chat's box — or an aside tab's, when no chat
  // box is drawn; never a floating aside card's.
  $effect(() => (aside ? undefined : untrack(() => chatBoxMounted())));
  let summonSeen = untrack(() => composerSummon.seq);
  $effect(() => {
    const seq = composerSummon.seq;
    if (seq === summonSeen) return;
    summonSeen = seq;
    if (aside && (!wantsFocus || untrack(() => chatBoxCount()) > 0)) return;
    untrack(() => {
      if (!ta) return;
      const box = boxElement(ta);
      const had = !!box && !!document.activeElement && box.contains(document.activeElement);
      keeper.focus(key, ta, had, true);
      autogrow();
    });
  });

  const quoted = $derived(hasQuoteLine(text));
  // Item 315: fenced code drawn coloured in the same layer as quotes.
  const fences = $derived(findFences(text));
  const codeLayer = $derived(fences.length > 0 ? layerLines(text) : []);
  const layered = $derived(quoted || fences.length > 0);
  // The layer follows the box: its size (a drag, the 40% line, a resized
  // window) and its text (the scroll after a keystroke) — item 223.
  $effect(() => {
    const box = boxElement(ta);
    if (!box || !mirror) return;
    void text;
    const ro = new ResizeObserver(() => syncMirror());
    ro.observe(box);
    void tick().then(syncMirror);
    return () => ro.disconnect();
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
    // Item 315: ⌘Z right after a code paste takes the fence off.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && codeUndoable) {
      e.preventDefault();
      undoCodeWrap();
      return;
    }
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
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        slashDismissed = true;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" && !text && queue.length > 0) {
      // The CLI's rule: Up in an empty input takes the newest held
      // message back. With text in the box, Up is the caret's.
      e.preventDefault();
      takeBack();
    }
  }

  function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const comma = url.indexOf(",");
        // The backend stores raw base64 and builds its own data URLs.
        resolve(comma >= 0 ? url.slice(comma + 1) : url);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function describe(file: File): string {
    return (
      file.name ||
      (file.type.startsWith("image/") ? "pasted image" : "pasted file")
    );
  }


  // The cap for one attachment on the engine the rail is on right now.
  // Checked at attach rather than at send because that is when the file is
  // in hand and the toast can name it; a chip that would fail later is a
  // promise the send would have to break.
  function capFor(kind: "image" | "document"): number {
    if (kind === "image") return MAX_IMAGE_BASE64;
    return app.connection?.engine === "claude-code"
      ? MAX_AGENT_DOCUMENT_BASE64
      : MAX_DOCUMENT_BASE64;
  }

  const engineNow = (): "claude-code" | "api" =>
    app.connection?.engine === "claude-code" ? "claude-code" : "api";

  function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** Whether LibreOffice is installed, asked once a window (item 277). */
  let converter: Promise<boolean> | null = null;
  const hasConverter = () => (converter ??= officeConverter().catch(() => false));

  /** Office conversions in flight, by chip id: Send waits on these. */
  const converting = new Map<number, Promise<void>>();

  /**
   * An office file: a chip at once, saying what is happening, and the
   * conversion behind it. A PDF over the engine's cap goes again as its
   * text, with a toast saying so; a chip removed meanwhile stays removed.
   */
  async function attachOffice(chatKey: string, file: File): Promise<Attachment | null> {
    if (file.size > MAX_OFFICE_BYTES) {
      addToast(`${describe(file)} is too large to convert — the limit is ${MAX_OFFICE_BYTES / 1024 / 1024} MB`);
      return null;
    }
    const canPdf = await hasConverter();
    if (!canPdf && !OFFICE_EXTS[extOf(file.name)]) {
      addToast(
        `${describe(file)}: a .${extOf(file.name)} file needs LibreOffice to read — install it (brew install --cask libreoffice), or save it as .pptx/.docx/.xlsx or PDF`,
      );
      return null;
    }
    const chip: Attachment = {
      id: nextAttachmentId(),
      kind: "document",
      name: describe(file),
      media_type: "application/pdf",
      data: "",
      label: convertingLabel(file.name, canPdf),
      pending: true,
    };
    addAttachment(chatKey, chip);
    const job = (async () => {
      try {
        const data = await readBase64(file);
        let out = await prepareOfficeAttachment(chip.name, data);
        if (out.note) addToast(`${chip.name}: ${out.note} — sending its text instead`);
        const cap = capFor("document");
        if (out.via === "pdf" && out.data.length > cap) {
          addToast(
            `${chip.name} became a ${Math.round(out.data.length / 1024 / 1024)} MB PDF once encoded — over the ${cap / 1024 / 1024} MB limit${cap === MAX_AGENT_DOCUMENT_BASE64 ? " on the subscription engine" : ""}; sending its text instead (no pictures)`,
          );
          out = await prepareOfficeAttachment(chip.name, data, true);
        }
        updateAttachment(chatKey, chip.id, {
          media_type: out.media_type,
          data: out.data,
          label: convertedLabel(chip.name, out.via, out.count),
          pending: false,
        });
      } catch (e) {
        removeAttachment(chatKey, chip.id);
        addToast(`${chip.name}: ${String(e)}`);
      } finally {
        converting.delete(chip.id);
      }
    })();
    converting.set(chip.id, job);
    return chip;
  }

  /** Wait for this box's conversions, if any; `false` if a send should not
   *  go (another wait is already running). */
  let waitingForConversion = $state(false);
  async function conversionsDone(chatKey: string): Promise<boolean> {
    const ids = readDraft(chatKey).attachments.filter((a) => a.pending).map((a) => a.id);
    const jobs = ids.map((id) => converting.get(id)).filter((j): j is Promise<void> => !!j);
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
    const added: Attachment[] = [];
    // Under the key of the moment the file was dropped: a read can
    // outlive a chat switch, and the chip belongs where it was pasted.
    const chatKey = key;
    for (const file of files) {
      const route = routeOf(file.name, file.type);
      if (route === "office") {
        const chip = await attachOffice(chatKey, file);
        if (chip) added.push(chip);
        continue;
      }
      if (route === "image" || route === "pdf") {
        const kind = route === "image" ? "image" : "document";
        const cap = capFor(kind);
        if (file.size > encodedLimit(cap)) {
          // Named engine when the cap is the engine's, so a file that was
          // fine on the API path yesterday reads as a different limit and
          // not a broken one.
          const where = cap === MAX_AGENT_DOCUMENT_BASE64 ? " on the subscription engine" : "";
          addToast(
            `${describe(file)} is too large — the limit${where} is ${cap / 1024 / 1024} MB once base64-encoded (about ${Math.round(encodedLimit(cap) / 1024 / 1024)} MB of file)`,
          );
          continue;
        }
        try {
          const data = await readBase64(file);
          const chip: Attachment = {
            id: nextAttachmentId(),
            kind,
            name: describe(file),
            media_type: route === "image" ? imageType(file.name, file.type) : "application/pdf",
            data,
          };
          addAttachment(chatKey, chip);
          added.push(chip);
        } catch (e) {
          addToast(`${describe(file)}: ${String(e)}`);
        }
        continue;
      }
      // Text, or bytes that may be: read them and look.
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const isText = looksLikeText(bytes);
        const d = decide(describe(file), file.size, isText, engineNow());
        if (d.as === "refuse") {
          addToast(d.why);
          continue;
        }
        let chip: Attachment;
        if (d.as === "text") {
          const notebook = extOf(file.name) === "ipynb";
          const data = notebook
            ? bytesToBase64(new TextEncoder().encode(notebookText(new TextDecoder().decode(bytes))))
            : bytesToBase64(bytes);
          chip = {
            id: nextAttachmentId(),
            kind: "document",
            name: describe(file),
            media_type: "text/plain",
            data,
            label: notebook ? "notebook → text" : "text",
          };
        } else {
          chip = {
            id: nextAttachmentId(),
            kind: "file",
            name: describe(file),
            media_type: file.type || "application/octet-stream",
            data: bytesToBase64(bytes),
            label: "file for Claude Code",
          };
        }
        addAttachment(chatKey, chip);
        added.push(chip);
      } catch (e) {
        addToast(`${describe(file)}: ${String(e)}`);
      }
    }
    return added;
  }

  function onpaste(e: ClipboardEvent) {
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    // Into the in-app clipboard ring (backlog 173): the text, and below
    // each image the paste attached.
    if (pastedText) recordText("pasted", pastedText);
    const files = Array.from(e.clipboardData?.files ?? []);
    // Item 284: ⌥⌘V's paste puts the text in as an attachment. A clipboard
    // holding a file (an image) is pasted as ⌘V would.
    const act = pasteAction(takeAttachMark(), pastedText, files.length);
    if (act !== "box") {
      e.preventDefault();
      if (act === "attach") void attachPastedText(pastedText);
      else addToast("The clipboard holds no text to attach");
      return;
    }
    // Item 315: code goes in as a fenced block with its language. A long
    // paste is left to the attachment offer below (codePasteLanguage).
    if (pastedText && files.length === 0 && ta) {
      const at = Math.min(ta.selectionStart, ta.selectionEnd);
      const lang = codePasteLanguage(pastedText, text, at);
      if (lang) {
        e.preventDefault();
        pasteAsCode(normalizeNewlines(pastedText), lang);
        offer = null;
        converted = null;
        return;
      }
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
    void accept(files).then((chips) => {
      for (const c of chips) if (c.kind === "image") recordImage("pasted", c);
    });
  }

  /*
   * Item 315: a code paste goes in fenced. ⌘Z right after gives back the
   * paste as it came (no fence); the formatted box does it with its own
   * history (two steps), the textarea through `codeWrap` — WebKit merges
   * scripted edits with his typing into one undo step, so the textarea's
   * own undo cannot be trusted with it. The pasted characters are not
   * touched; the fence adds lines round them.
   */
  let codeWrap = $state<{ raw: string; wrapped: string; caret: number } | null>(null);
  const codeUndoable = $derived(codeWrap !== null && codeWrap.wrapped === text);
  function pasteAsCode(raw: string, lang: string): void {
    if (!ta) return;
    if (ta instanceof LiveBoxHandle) {
      ta.pasteAsCode(raw, (before, after) => fenced(raw, lang, before, after));
      return;
    }
    const from = Math.min(ta.selectionStart, ta.selectionEnd);
    const to = Math.max(ta.selectionStart, ta.selectionEnd);
    const before = text.slice(0, from);
    const after = text.slice(to);
    const block = fenced(raw, lang, before, after);
    const wrapped = before + block + after;
    codeWrap = { raw: before + raw + after, wrapped, caret: from + raw.length };
    setDraftText(key, wrapped);
    void tick().then(() => {
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = from + block.length;
      autogrow();
    });
  }
  function undoCodeWrap(): boolean {
    const w = codeWrap;
    codeWrap = null;
    if (!w || w.wrapped !== text) return false;
    setDraftText(key, w.raw);
    void tick().then(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = w.caret;
      autogrow();
    });
    return true;
  }
  $effect(() => {
    void key;
    codeWrap = null;
  });
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
  let attachMark = 0;
  const ATTACH_MARK_MS = 1500;
  function takeAttachMark(): boolean {
    const on = attachMark > 0 && performance.now() - attachMark < ATTACH_MARK_MS;
    attachMark = 0;
    return on;
  }
  async function pasteAsAttachment(): Promise<void> {
    attachMark = performance.now();
    let asked = false;
    try {
      asked = await pasteIntoFocus();
    } catch {
      asked = false;
    }
    if (asked) return;
    attachMark = 0;
    try {
      const t = await navigator.clipboard.readText();
      if (t) await attachPastedText(t);
      else addToast("The clipboard holds no text to attach");
    } catch (e) {
      addToast(`Could not read the clipboard: ${String(e)}`);
    }
  }

  /*
   * Item 312: a chip made from text fades in; Undo fades it out. The marks
   * are one-shot and never saved, so a chip that mounts because the chat
   * changed, or an image or file, appears as before. The transitions are
   * `|global` because the first chip also creates the chip row around it.
   */
  const fadeInNames = new Marks<string>();
  const fadeOutIds = new Marks<number>();
  function chipIn(_node: Element, a: Attachment) {
    return chipMotion(fadeInNames.take(a.name), prefersReducedMotion());
  }
  function chipOut(_node: Element, a: Attachment) {
    return chipMotion(fadeOutIds.take(a.id), prefersReducedMotion());
  }

  /** Pasted text as a chip, by item 277's text route (`accept`): named
   *  "Pasted text", its words on the chip, kept with the draft. */
  async function attachPastedText(raw: string): Promise<Attachment | null> {
    const body = normalizeNewlines(raw);
    const chatKey = key;
    const name = pastedName(readDraft(chatKey).attachments.map((a) => a.name));
    // Item 312: this chip came from text, so it fades in.
    fadeInNames.mark(name);
    const [chip] = await accept([pastedFile(body, name)]);
    if (!chip) {
      fadeInNames.unmark(name);
      return null;
    }
    updateAttachment(chatKey, chip.id, {
      pasted: true,
      ...(chip.kind === "document" ? { label: pastedLabel(body) } : {}),
    });
    return chip;
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
    if (withoutSpan(readDraft(chatKey).text, o) === null) return;
    const chip = await attachPastedText(o.pasted);
    // Refused (too long for this engine): the toast said why; the text stays.
    if (!chip) return;
    const now = readDraft(chatKey).text;
    const after = withoutSpan(now, o);
    if (after === null) {
      // Typed into meanwhile: the text stays where he is working.
      removeAttachment(chatKey, chip.id);
      return;
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

  function undoConvert(): boolean {
    const c = converted;
    converted = null;
    if (!canUndo(c, text, attachments.map((a) => a.id))) return false;
    const r = undoConverted(c);
    fadeOutIds.mark(c.chipId);
    removeAttachment(key, c.chipId);
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
      if (id !== "undo_app" || !(undoable || codeUndoable)) return false;
      const box = boxElement(ta);
      if (!box || !box.contains(document.activeElement)) return false;
      return undoable ? undoConvert() : undoCodeWrap();
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
    const a = attachments.find((x) => x.id === id);
    removeAttachment(chatKey, id);
    // Pasted text has no file to drop again (item 284): × says so and
    // offers it back.
    if (a?.pasted) {
      const copy = $state.snapshot(a) as Attachment;
      addToast(`Removed ${copy.name}`, { label: "Undo", run: () => addAttachment(chatKey, copy) });
    }
  }

  /** The wire shape of a set of chips. A chip still converting carries
   *  nothing yet; the send paths wait for it first (`conversionsDone`). */
  function split(chips: Attachment[]) {
    return {
      images: chips.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data })),
      documents: chips
        .filter((a) => a.kind === "document" && !a.pending)
        .map(({ media_type, name, data }) => ({ media_type, name, data })),
      files: chips.filter((a) => a.kind === "file").map(({ name, data }) => ({ name, data })),
    };
  }

  /** A file for Claude Code in the box while the rail is on the API
   *  engine (switched after it was attached): say so and keep it. */
  function filesBlocked(chips: Attachment[]): boolean {
    if (app.connection?.engine === "claude-code") return false;
    const files = chips.filter((a) => a.kind === "file");
    if (files.length === 0) return false;
    addToast(
      `${files.map((f) => f.name).join(", ")}: only the Claude Code engine can take ${files.length === 1 ? "a file" : "files"} it opens itself — switch engines, or remove ${files.length === 1 ? "it" : "them"}`,
    );
    return true;
  }

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
    // chat now open (the pending chat's first turn may have made the chat
    // before failing, and `key` has followed it), the text only if nothing
    // new was typed meanwhile. A wrap-up that failed goes back to its
    // notice rather than into the box.
    if (app.error) {
      if (wrapUp) {
        abortWrapUp(chat);
        return;
      }
      if (!readDraft(key).text) {
        setDraftText(key, typed);
        setDraftAttachments(key, chips.concat(readDraft(key).attachments));
      } else if (typed || chips.length > 0) {
        // The box holds new words: the failed message goes back to the
        // head of the queue rather than nowhere (backlog 158).
        requeueFront(key, { id: nextQueueId(), text: typed, attachments: chips });
      }
      return;
    }
    // A turn the usage limit paused (backlog 164): the queue waits for
    // the Resume rather than sending the next message into the same
    // exhausted window.
    if (app.limitPause) return;
    await drain();
  }

  /** Why the queue is waiting rather than sending itself, if it is. */
  const hold = $derived(aside ? null : queueHold(handoffHere ? handoff.stage : "idle", turnWasStopped()));

  /**
   * Send the oldest held message as the next turn, if there is one. At a
   * turn's end the queue holds when `queueHold` says so; *Send next* is
   * the explicit choice and goes regardless.
   */
  async function drain(explicit = false): Promise<void> {
    if (aside) return asideDrain();
    // A provider turn off screen holds the engine (backlog 159, A4).
    if (app.busy || !app.connection || providerElsewhereName()) return;
    if (!explicit && hold) return;
    // The held row is where this message leaves from (backlog 194).
    const head = queue[0];
    if (head) launch("chat", document.querySelector(`.queue-row[data-queue-id="${head.id}"] .queue-text`));
    const q = shiftQueue(key);
    if (!q) return;
    // The row Nightloom queued while he was away is the wrap-up going.
    const wrapUp = handoffHere && q.id === handoff.queuedId;
    if (wrapUp) beginWrapUp(app.activeSessionId);
    await dispatch(q.text, q.attachments, wrapUp);
  }

  // Scheduled send (backlog 224): a due message joins this chat's queue
  // and goes through `drain`, which gives the words back on a failure.
  // Untracked: the first tick reads the store, which is not this effect's.
  // The chat's composer only (283): an aside's queue waits for its answer.
  $effect(() => untrack(() => (aside ? undefined : registerScheduleDrain(() => drain()))));
  // And when a provider turn off screen ends (A4 review): the message
  // queued behind it here goes, as its notice said.
  $effect(() => untrack(() => (aside ? undefined : registerProviderDrain(() => drain()))));
  /** Why nothing can be scheduled from this box, if nothing can. */
  const scheduleBlocked = $derived(
    key.startsWith(NEW_DRAFT_PREFIX)
      ? "send a first message first — a new chat has no id to wait under"
      : attachments.length > 0
        ? "attachments cannot be scheduled yet; text only"
        : null,
  );
  function scheduled(): void {
    clearDraft(key);
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
    if (!t && attachments.length === 0) return;
    // A held message carries finished chips only (item 277).
    if (!(await conversionsDone(key))) return;
    enqueueMessage(key, readDraft(key).text, readDraft(key).attachments.slice());
    clearDraft(key);
    if (aside) {
      afterSend(key);
      return;
    }
    if (app.parked) addToast(queuedElsewhereToast(runningChatName()));
    else if (!app.busy) {
      const elsewhere = providerElsewhereName();
      if (elsewhere) addToast(queuedElsewhereToast(elsewhere));
    }
    afterSend(key);
  }

  function takeBack(id?: number): void {
    takeBackQueued(key, id);
    requestAnimationFrame(autogrow);
    ta?.focus();
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
    // The words fly from the box into the aside's card (backlog 194).
    launch("aside", boxElement(ta));
    clearDraft(key);
    afterSend(key);
    await askAside(t, null, null, { attachments: chips });
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
    if (head) launch("aside", document.querySelector(`.queue-row[data-queue-id="${head.id}"] .queue-text`));
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

  async function submit() {
    if (aside) return asideSubmit();
    const t = text.trim();
    const empty = !t && attachments.length === 0;
    if (empty || !app.connection) return;
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
    if (sendKey !== key || !app.connection || app.busy) return;
    if (filesBlocked(attachments)) return;
    const pending = attachments.slice();
    const typed = text;
    // Where the words were, for the send motion (backlog 194): measured
    // before the box clears.
    launch("chat", boxElement(ta));
    clearDraft(key);
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
  let councilBtn = $state<HTMLElement | null>(null);
  let councilWrap = $state<HTMLElement | null>(null);
  async function submitCouncil(prefs: CouncilPrefs) {
    councilOpen = false;
    const t = text.trim();
    if ((!t && attachments.length === 0) || !app.connection || app.busy || sendHeld()) return;
    const sendKey = key;
    if (!(await conversionsDone(sendKey))) return;
    if (sendKey !== key || !app.connection || app.busy) return;
    if (filesBlocked(attachments)) return;
    noteActivity();
    const pending = attachments.slice();
    const typed = text;
    recordText("sent", typed);
    launch("chat", boxElement(ta));
    clearDraft(key);
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
  const effortDefaultText = $derived(effortDefaultLabel("claude-code", app.draft.agentModel));
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

  interface MenuRow {
    id: string;
    label: string;
    /** The dim clause after the label. */
    detail?: string;
    /** The chord that does the same from anywhere, as a key cap. */
    cap?: string | null;
    on?: boolean;
    run: () => void;
  }
  const modelRows = $derived.by((): MenuRow[] => {
    const rows: MenuRow[] = [];
    if (agentMode) {
      const cur = app.draft.agentModel.trim();
      rows.push({ id: "default", label: "default", detail: "whatever the CLI defaults to", on: cur === "", run: () => void switchModel("") });
      for (const a of AGENT_PILLS) {
        rows.push({
          id: a,
          label: a,
          detail: a === cur ? "current · the CLI resolves it" : undefined,
          cap: agentKey(a),
          on: cur === a,
          run: () => void switchModel(a),
        });
      }
      // A full id typed into the rail's field: named here, changed there.
      const other = cur !== "" && !AGENT_PILLS.includes(cur);
      rows.push({ id: "other", label: other ? cur : "other…", detail: other ? "a full id — the rail's field" : "a full id, typed in the rail", on: other, run: openRail });
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
  const chatModelName = $derived(app.draft.agentModel.trim() || "default");
  const chatEffortName = $derived(app.draft.agentEffort || `default · ${effortDefaultText}`);
  const asideModelLabel = $derived(aside?.model ? aside.model : `chat's · ${chatModelName}`);
  const asideEffortLabel = $derived(
    aside && aside.effort != null ? aside.effort || "default" : `chat's · ${chatEffortName}`,
  );
  const asideModelTitle = $derived(
    `This aside's model — the chat's (${chatModelName}) unless picked here. Another model cannot read the chat's prompt cache, so its first answer reads the whole context fresh.`,
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
    for (const m of AGENT_PILLS) {
      rows.push({
        id: m,
        label: m,
        detail: m === chatModelName ? "the chat's model, picked for this aside" : "its own model — no cache from the chat",
        on: cur === m,
        run: () => pickAside("model", m),
      });
    }
    if (cur !== null && !AGENT_PILLS.includes(cur)) rows.push({ id: cur, label: cur, on: true, run: () => {} });
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
      ? "Message…"
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
  function whenLabel(at: string): string {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return "earlier";
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  let menu = $state<"model" | "effort" | "history" | null>(null);
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
          : [],
  );
  function menuButton(): HTMLElement | null {
    return menu === "model" ? modelBtn : menu === "effort" ? effortBtn : menu === "history" ? historyBtn : null;
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
  const cache = $derived(floating ? null : cacheState(app.events, now));
  $effect(() => {
    if (floating) return;
    const warmUntil = cacheState(app.events, Date.now())?.warmUntil ?? null;
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
  const cacheShareTitle = "Share of the last request's prompt served from cache.";
  const cacheTitle = $derived.by(() => {
    if (!cache) return "";
    const engine = app.connection?.engine === "claude-code" ? "claude-code" : "api";
    if (!cache.warm) {
      return "The last turn's prompt cache has expired, so the next turn re-reads the whole history either way and editing it now costs nothing extra.";
    }
    const what = `Time left on the last turn's prompt cache (${cache.ttl}), counted from when its request was sent: until it expires an edit to the history re-writes the cache, and after it the next turn pays for the whole history whether or not you edited it.`;
    return engine === "claude-code"
      ? `${what} On this engine you are on the subscription, so "free" means an edit costs no more usage than an unedited turn would — whether cache reads are discounted against the plan's limit is not documented.`
      : what;
  });
</script>

<div
  bind:this={root}
  class="composer"
  class:floating
  class:aside={aside !== null}
  class:compact
  class:dropping={dragDepth > 0}
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
      hint={floorPx === null && capPx === null
        ? "Drag to resize · double-click to reset (⌥⌘↑ / ⌥⌘↓ by a line)"
        : `Drag to resize · double-click to reset — ${floorPx === null ? "automatic" : `${floorPx}px`} for this chat${capPx === null ? "" : `, grows to ${capPx}px`}`}
      ondown={handleDown}
      onreset={handleReset}
    />
  {/if}
  {#if composerShows("schedule", !!aside)}
    <ScheduledChip {key} onedit={scheduleEdited} />
  {/if}
  {#if queue.length > 0}
    <div class="queue" role="list" aria-label="queued messages">
      <div class="queue-head">
        <span class="ns-chip mono">queued · {aside ? (asideBusy ? "sent when this answer ends" : asideBlock === "not-open" ? "waiting — open the chat to send" : "waiting") : app.busy ? "sent when this turn ends" : hold === "stopped" ? "waiting — the turn was stopped" : hold === "wrapped" ? "waiting — HANDOFF.md is written; continue in a new chat, or Send next here" : "waiting"}</span>
        {#if !busy}
          <button class="ns-btn ghost small" disabled={!app.connection || asideBlock !== null} onclick={() => void drain(true)}>Send next</button>
        {/if}
      </div>
      {#each queue as q, i (q.id)}
        <div class="queue-row" role="listitem" data-queue-id={q.id}>
          <span class="queue-n mono">{i + 1}</span>
          <span class="queue-text" use:tip={q.text} data-find-text={q.text}>{#if handoffHere && q.id === handoff.queuedId}<span class="ns-chip mono" use:tip={"Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. × takes it back."}>wrap-up · queued while you were away</span> {/if}{firstLine(q.text) || "(no text)"}{#if q.attachments.length > 0} <span class="ns-chip mono">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>{/if}</span>
          <button class="ns-btn ghost small" use:tip={"Back into the message box"} onclick={() => takeBack(q.id)}>take back</button>
          <button class="remove" use:tip={"drop this message"} aria-label="drop queued message {i + 1}" onclick={() => dropQueued(key, q.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if attachments.length > 0}
    <div class="attachments">
      {#each attachments as a (a.id)}
        <div class="attachment" in:chipIn|global={a} out:chipOut|global={a}>
          <div class="attachment-face">
            {#if a.kind === "image"}
              <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
            {:else}
              <span
                class="file"
                class:pending={a.pending}
                use:tip={a.label ? `${a.name} — ${a.pending ? "converting; Send waits for it" : a.label}` : a.name}
              >
                <span class="file-ext">{a.pending ? extOf(a.name).toUpperCase() : badgeOf(a)}</span>
                <span class="file-name">{a.name}</span>
                {#if a.label}<span class="file-label">{a.label}</span>{/if}
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
          />
        </div>
      {/each}
    </div>
  {/if}
  {#if handoffHere && handoff.stage === "due"}
    <!-- The notice (backlog 086 pass 2, blocker 120): the board's hand-off
         card — accent rule, a heading with the fill, one line of what
         happens, the two things he can change for this chat, the actions.
         Nothing goes by itself while it is on screen. -->
    <div class="handoff" role="status" aria-label="Hand-off notice">
      <div class="handoff-head">
        <strong>Context {handoffPct}% — past this chat's {handoffThresholdPct}% hand-off mark</strong>
        <span class="spacer"></span>
        <span class="mono handoff-fill">{fmtTokens(handoff.used)} of {fmtTokens(handoff.limit)} · {handoffPct}%</span>
      </div>
      <p class="handoff-d">
        {#if wrapUpQueued}
          The wrap-up below is in the queue — put there while you were away — and goes when this turn ends;
          its × takes it back.
        {:else}
          <strong>Wrap up now</strong> sends the message below as a turn of its own: the model finishes what is
          half-done, {#if threadHandoff}updates the thread's files{:else}writes <code>HANDOFF.md</code>{/if}, and
          ends with a start prompt for the new chat. Or raise this chat's mark and keep going. Nothing is sent by
          itself while this notice is open.
        {/if}
      </p>
      <ThreadPicker />
      <label class="handoff-row">
        <span>Hand off this chat at</span>
        <input
          type="number"
          min="1"
          max="100"
          step="1"
          value={handoffThresholdPct}
          aria-label="This chat's hand-off threshold, percent of the context window"
          onchange={(e) => setChatThreshold((e.currentTarget as HTMLInputElement).value)}
        />
        <span>% of the window{hasOwnThreshold(app.activeSessionId) ? ` (the default is ${handoffDefaultPct}%)` : " (the default)"}</span>
      </label>
      <textarea
        class="handoff-msg"
        rows="5"
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
      <div class="handoff-acts">
        {#if !wrapUpQueued}
          <button class="ns-btn accent small" disabled={app.busy || !wrapUpText.trim()} onclick={() => void sendWrapUpNow()}>Wrap up now</button>
        {/if}
        <button class="ns-btn ghost small" use:tip={`No wrap-up; asked again past ${reAskPct}%`} onclick={stayHere}>Stay here</button>
        {#if hasOwnMessage(app.activeSessionId)}
          <button class="ns-btn ghost small" use:tip={"Back to the Settings default for this chat"} onclick={() => clearMessage(app.activeSessionId)}>Reset the message</button>
        {/if}
        <span class="handoff-keys mono">stay past {reAskPct}% and the wrap-up is asked again</span>
      </div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapping"}
    <div class="handoff" role="status">
      <div class="handoff-head"><span>Wrapping up — the model is finishing what is half-done, {#if threadHandoff}updating the thread's files{:else}writing <code>HANDOFF.md</code>{/if}, and ending with the start prompt for the new chat.</span></div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapped"}
    <div class="handoff" role="status" aria-label="Hand-off done">
      <div class="handoff-head">
        <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={15} /></span>
        <strong>{threadHandoff ? "Thread updated" : "HANDOFF.md written"}</strong>
        <span class="spacer"></span>
        <span class="mono handoff-fill">{fmtTokens(handoff.used)} of {fmtTokens(handoff.limit)} · {handoffPct}%</span>
      </div>
      <p class="handoff-d">
        Check the reply above. <strong>Continue in a new chat</strong> opens a linked chat in the same folder with
        {#if handoff.startPrompt}{readOrderText.trim() ? "the read order below and then " : ""}the model's start prompt
          in the box, not sent{:else if readOrderText.trim()}the read order below in the box, not sent — the reply had no
          <code>start-prompt</code> block, so add what to do first{:else}an empty box — the reply had no
          <code>start-prompt</code> block, so say what to read first{/if}. This chat stays readable.
        {#if threadHandoff}The new chat opens on the same thread.{/if}
      </p>
      <ThreadPicker compact />
      <!-- The read order (backlog 193): the fixed text above the model's
           start prompt in the new chat's box; this chat's own copy, the
           default in Settings → Subscription. -->
      <textarea
        class="handoff-msg"
        rows="4"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        aria-label="The read order the new chat opens with, for this chat"
        placeholder="No read order — the new chat opens with the model's start prompt alone"
        use:tip={"Put above the model's start prompt in the new chat's box. Edits are kept for this chat and the chats that continue it; the default is in Settings → Subscription."}
        value={readOrderText}
        oninput={(e) => {
          noteActivity();
          setReadOrder(app.activeSessionId, (e.currentTarget as HTMLTextAreaElement).value);
        }}
      ></textarea>
      <div class="handoff-acts">
        <button class="ns-btn accent small" disabled={app.busy} onclick={() => void continueChat()}>Continue in a new chat</button>
        {#if hasOwnReadOrder(app.activeSessionId)}
          <button class="ns-btn ghost small" use:tip={"Back to the Settings default for this chat"} onclick={() => clearReadOrder(app.activeSessionId)}>Reset the read order</button>
        {/if}
        <button class="ns-btn ghost small" use:tip={`Keep going here; asked again past ${reAskPct}%`} onclick={stayHere}>Stay here</button>
        <span class="handoff-keys mono">stay past {reAskPct}% and the wrap-up is asked again</span>
      </div>
    </div>
  {/if}
  {#if clipOpen}
    <ClipPanel entries={clips.ring} index={clipIndex} onpick={pickClip} />
  {/if}
  {#if slashOpen}
    <div class="slash" role="listbox" aria-label="Skills and slash commands">
      {#if slashMatches.length === 0}
        <div class="slash-row dim">No skill or command starts with “{text.slice(1)}” — ↵ sends the text as typed</div>
      {:else}
        {#each slashMatches as m, i (m.name)}
          <button
            type="button"
            role="option"
            class="slash-row"
            class:on={i === slashIndex}
            aria-selected={i === slashIndex}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => pickSlash(m.name)}
          >
            <span class="mono">/{m.name}</span>
            <span class="dim">{m.kind}</span>
          </button>
        {/each}
        <div class="slash-row dim">↑↓ move · ↵ or Tab insert · Esc close · the CLI runs a skill named in the message</div>
      {/if}
    </div>
  {/if}
  <div class="card">
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
      onmousedown={() => (pointerDown = true)}
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
    {#if composerFormat.on}
      <!-- Item 276: the same draft with its formatting drawn in place —
           math typeset, bold / italic / headings styled, the source back
           under the cursor. The text, the keys and the draft are the
           textarea's; only the drawing differs. -->
      <LiveBox
        bind:handle={ta}
        value={text}
        onchange={(v) => setDraftText(key, v)}
        placeholder={app.connection ? boxPlaceholder : ""}
        disabled={!app.connection}
        {floating}
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
           bubble draws them. An empty line holds a zero-width space so it
           keeps its height, as the textarea's does. Item 315: a fenced
           block's lines on a code ground, the body coloured, the same
           characters in the same font so nothing moves. -->
      <div class="ta-mirror" aria-hidden="true" bind:this={mirror}>{#each mirrorLines(text) as l, i (i)}{@const c = codeLayer[i]}{#if c && c.kind === "body"}<div class="ml code">{#each c.segs as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}{#if c.segs.length === 0}{"\u200b"}{/if}</div>{:else if c}<div class="ml code fence" data-fence={c.kind === "open" ? c.fence : undefined}>{l.marker}{l.rest || "\u200b"}</div>{:else}<div class="ml" class:q={l.quote}>{#if l.quote}<span class="qm">{l.marker}</span>{l.rest}{:else}{l.rest || "\u200b"}{/if}</div>{/if}{/each}</div>
      {#each fences as f, k (k)}
        {#if fenceTops[k] != null}
          <!-- Item 315: the block's language; a pick rewrites only the
               fence's info string. -->
          <select
            class="code-lang mono"
            style:top="{fenceTops[k]}px"
            aria-label="Code block language"
            use:tip={"The block's language — the fence's ```name"}
            value={f.lang ?? f.info}
            onmousedown={(e) => e.stopPropagation()}
            onchange={(e) => relabel(k, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#if !f.lang}<option value={f.info}>{f.info || "code"}</option>{/if}
            {#each LANGUAGES as lg (lg.id)}<option value={lg.id}>{lg.label}</option>{/each}
          </select>
        {/if}
      {/each}
    {/if}
    <textarea
      bind:this={ta}
      class:quoted={layered}
      bind:value={() => text, (v) => setDraftText(key, v)}
      onscroll={syncMirror}
      rows="1"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder={app.connection ? boxPlaceholder : ""}
      disabled={!app.connection}
      oninput={() => {
        // A keystroke is presence, for the hand-off's away rule (backlog 086).
        noteActivity();
        autogrow();
      }}
      {onpaste}
      {onkeydown}
      onblur={() => (clipOpen = false)}
    ></textarea>
    {/if}
    </div>
    {#if offer && offer.after !== null}
      <!-- Item 284: a long ⌘V paste, offered as an attachment. -->
      <div class="paste-offer" role="status">
        <span class="mono dim">long paste · {pastedLabel(offer.pasted)}</span>
        <button
          class="ns-btn ghost small"
          use:tip={"Move the pasted text out of the box into an attachment — Undo puts it back. ⌥⌘V pastes as an attachment from the start."}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => void convertLongPaste()}>Make this an attachment</button
        >
      </div>
    {:else if undoable}
      <div class="paste-offer" role="status">
        <span class="mono dim">moved into an attachment</span>
        <button
          class="ns-btn ghost small"
          use:tip={"Put the text back in the box (⌘Z)"}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => undoConvert()}>Undo</button
        >
      </div>
    {/if}
    <div class="row" bind:this={rowEl} data-fold={rowFold}>
      <input
        bind:this={picker}
        type="file"
        accept="*/*"
        multiple
        hidden
        onchange={onpick}
      />
      <button
        class="ns-btn ghost small attach"
        use:tip={"Attach images or PDFs"}
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
          <span class="pick-name">{aside ? asideModelLabel : modelLabel}</span>
          <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
        </button>
        {#if menu === "model"}
          {@render pickMenu(aside ? "This aside's model" : "Model", aside ? "the chat's unless picked here" : agentMode ? "an alias the CLI resolves" : `${models.length} in the picker · Settings picks which`)}
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
            ? "This aside's effort (--effort) — the chat's unless picked here; kept on this aside"
            : agentMode
              ? "Effort (--effort) — how hard the model thinks per turn; default sends no flag and leaves it to the model. Kept on this chat."
              : `Thinking — ${thinkingSup.note}`}
          onclick={() => openMenu("effort")}
        >
          <span class="pick-k">{agentMode ? "effort" : "thinking"}</span>
          <span class="pick-name">{aside ? asideEffortLabel : agentMode ? effortLabel : thinkingLabel}</span>
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
          {/if}
        </span>
      {/if}
      <span class="spacer"></span>
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
          disabled={!text.trim() && attachments.length === 0}>Queue</button
        >
        {#if aside}
          <button class="ns-btn danger small act" use:tip={"Stop this answer; what has arrived stays"} onclick={() => aside && stopAside(aside)}>Stop</button>
        {:else}
          <button class="ns-btn danger small act" use:tip={app.parked ? `Stop the turn running in ${runningChatName()}` : "Stop this turn"} onclick={() => void cancelTurn()}>Stop</button>
        {/if}
      {:else if aside}
        <!-- The aside's Send (backlog 283): no schedule ▾, no council. -->
        <button
          class="ns-btn accent send act"
          use:tip={asideSendTip}
          onclick={() => void submit()}
          disabled={!app.connection || asideBlock !== null || (!text.trim() && attachments.length === 0)}
        >
          Send
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
            class="ns-btn ghost small act"
            use:tip={"Ask this of the chat without adding it to the chat: answered from what is already in context, no changes, recorded nowhere (Claude Code's /btw)"}
            disabled={!text.trim() && attachments.length === 0}
            onclick={() => void submitAside()}
          >
            <span class="fold-word">Ask aside</span><span class="short-word">Aside</span>
          </button>
        {/if}
        {#if app.connection?.engine === "claude-code"}
          <!-- The council (nightshift backlog 149): the popover's roster
               and mode for this turn, then Send to the council. -->
          <span class="council-wrap act" bind:this={councilWrap}>
            <button
              class="ns-btn ghost small"
              class:on={councilOpen}
              bind:this={councilBtn}
              use:tip={"Send this message to a council: several models answer it independently, then this chat's model chairs their answers"}
              aria-haspopup="dialog"
              aria-expanded={councilOpen}
              aria-label="Council"
              onclick={() => (councilOpen = !councilOpen)}
            >
              <!-- Item 289: its icon alone at fold 3 and past. -->
              <span class="council-ico" aria-hidden="true"><Icon name="agent" size={13} /></span><span class="council-word">Council</span>
            </button>
            {#if councilOpen}
              <CouncilPopover
                anchor={councilBtn}
                disabled={!app.connection || sendHeld() || (!text.trim() && attachments.length === 0)}
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
            class="ns-btn accent send act"
            use:tip={sendTip(!!app.connection, !text.trim() && attachments.length === 0, sendHeld()) +
              (shown && Number(rowFold) >= 2 ? ` · ${shown.long}` : "")}
            onclick={() => void submit()}
            disabled={!app.connection || sendHeld() || (!text.trim() && attachments.length === 0)}
          >
            Send
          </button><ScheduleMenu {key} {text} blocked={scheduleBlocked} onscheduled={scheduled} />
        </span>
      {/if}
    </div>
  </div>
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
          Answers from <em>{asideChatName}</em>'s context; nothing here enters the chat.
        {/if}
      </span>
      <span class="spacer"></span>
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
    </div>
  {:else if !floating}
    <!-- The bottom row (backlog 112, board 10's C): the two transcript
         toggles (backlog 052) and the cache chip (063), under the box,
         right-aligned as drawn. A click on any single block still
         overrides its toggle; flipping the toggle clears those clicks.
         Remembered across relaunch; thinking off and tools on is how the
         transcript read before them. -->
    <div class="bottom-row">
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
      {#if cached != null || cache}
        <div
          class="ns-chip mono bottom-cache"
          class:cold={cache ? !cache.warm : false}
          use:tip={cache
            ? `${cacheShareTitle} ${cacheTitle}`
            : `${cacheShareTitle} No timer for this chat: its last turn was made before the cache lifetime was recorded (2026-09-15); the next turn will show one.`}
        >
          {#if cached != null}{Math.round(cached * 100)}% cached{:else}cache{/if}{#if cache}
            <span class="bottom-cache-when" aria-label={cacheLine(cache)}>· {remainingText(cache.remainingMs) ?? "cold"}</span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if !app.connection}
    <!-- "connecting…" while the launch connect runs, as the top bar says;
         the failure wording only once it is true (item 230). -->
    <div class="hint">
      {composerConnectHint({
        connected: false,
        connecting: app.connecting,
        launchConnectSettled: launchState.connectSettled,
      })}
    </div>
  {:else if dragDepth > 0}
    <div class="hint">drop images or PDFs to attach</div>
  {:else if !aside && handoff.noStartPromptChat !== null && handoff.noStartPromptChat === app.activeSessionId && !text}
    <!-- The continued chat whose box was left empty (backlog 086 pass 2):
         the note lives here, under the box, until he types. -->
    <div class="hint">continued from the earlier chat — its wrap-up reply had no start-prompt block, so the box is empty; say which files to read first (HANDOFF.md is in the project)</div>
  {/if}
</div>

<!-- The menu over a picker button (backlog 112): a head, the rows with
     the current one lit and each chord as a key cap, the rail's row last.
     Drawn from `menuRows`, so the model and effort menus are one piece
     of markup and one set of keys. -->
{#snippet pickMenu(head: string, sub: string)}
  <div
    class="pick-menu"
    role="menu"
    tabindex="-1"
    aria-label={head}
    bind:this={menuEl}
    use:floatMenu={{ anchor: menuButton() }}
    onkeydown={onMenuKey}
  >
    <div class="pick-head"><span>{head}</span><span class="pick-sub">{sub}</span></div>
    {#each menuRows as r (r.id)}
      {#if r.id === "rail"}<div class="pick-sep"></div>{/if}
      <button
        type="button"
        class="pick-row"
        class:on={r.on}
        role="menuitemradio"
        aria-checked={r.on ?? false}
        tabindex="-1"
        onclick={() => runRow(r)}
      >
        <span class="pick-row-label">{r.label}</span>
        {#if r.detail}<span class="pick-row-detail">{r.detail}</span>{/if}
        {#if r.cap}<span class="pick-row-cap"><Kbd keys={r.cap} /></span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

<style>
  /* The council button's frame (backlog 149): the popover hangs off it. */
  .council-wrap {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .council-wrap .ns-btn.on {
    color: var(--accent-ink);
  }
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
  .pick-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--ink2);
    white-space: nowrap;
    cursor: pointer;
    max-width: 240px;
    min-width: 0;
  }
  .pick-btn:hover:not(:disabled),
  .pick-btn.open {
    background: var(--well);
    color: var(--ink);
    border-color: var(--line2);
  }
  .pick-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pick-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--done);
    flex: none;
  }
  .pick-dot.unknown {
    background: var(--dim);
  }
  .pick-k {
    color: var(--dim);
  }
  .pick-name {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .pick-chev {
    display: inline-flex;
    color: var(--dim);
    flex: none;
  }
  .pick-chev :global(svg) {
    width: 11px;
    height: 11px;
  }
  /* Placed by `use:floatMenu` (backlog 210): portalled to `body` and fixed
     by the button's rectangle, so the Welcome page's scrolling column can
     no longer cut it off; its top, left and max-height are set inline. */
  .pick-menu {
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
  .pick-head {
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
  .pick-sub {
    text-transform: none;
    letter-spacing: 0;
    font-size: 11px;
  }
  .pick-row {
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
  .pick-row:hover,
  .pick-row:focus-visible {
    background: var(--well);
    outline: none;
  }
  .pick-row.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .pick-row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
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
  .bottom-toggle {
    cursor: pointer;
    font-family: var(--sans);
    color: var(--dim);
    gap: 5px;
  }
  .bottom-mark {
    font-size: 11px;
    opacity: 0.55;
  }
  .bottom-toggle.on {
    color: var(--ink);
  }
  .bottom-toggle.on .bottom-mark {
    color: var(--accent);
    opacity: 1;
  }
  .bottom-toggle:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .bottom-toggle:disabled,
  .bottom-toggle:disabled:hover {
    cursor: default;
    opacity: 0.5;
    border-color: transparent;
    color: var(--dim);
  }
  .bottom-cache {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
  }
  /* Only the timer half dims when cold; the share is still a fact. */
  .bottom-cache.cold .bottom-cache-when {
    color: var(--dim);
  }

  .composer {
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
  .composer.dropping .card {
    border-color: var(--accent);
  }
  /* In an aside (backlog 283): the chat's composer inside the aside's
     frame — no panel fill of its own, the card on the aside's tint with a
     dashed edge, so the box he types in never reads as the chat's. */
  .composer.aside {
    background: transparent;
    padding: 8px 0 0;
  }
  .composer.aside .card,
  .composer.aside .attachments,
  .composer.aside .queue,
  .composer.aside .bottom-row {
    max-width: none;
  }
  .composer.aside .card {
    border-style: dashed;
    background: var(--aside-well, var(--sheet));
    padding: 8px 10px;
    gap: 6px;
  }
  .composer.aside .card:focus-within {
    border-style: solid;
  }
  .composer.aside .bottom-row {
    margin-top: 5px;
    justify-content: space-between;
    flex-wrap: nowrap;
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
  /* Item 284: the long paste's offer, a slim line under the box. */
  .paste-offer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 2px 10px 4px;
    font-size: 12px;
  }
  /* The queue tray: joined to the top of the card, dashed so it reads as
     "not sent yet" (backlog 089). Plain rows; the real design is the
     Fable board's. */
  .queue {
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
  .attachments {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
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
  .file {
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
  .card {
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
  .row:is([data-fold="2"], [data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .draft-tokens {
    display: none;
  }
  .council-ico {
    display: none;
  }
  .row:is([data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .fold-word,
  .row:is([data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .council-word {
    display: none;
  }
  .row:is([data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .short-word {
    display: inline;
  }
  .row:is([data-fold="3"], [data-fold="4"], [data-fold="5"], [data-fold="6"]) .council-ico {
    display: inline-flex;
  }
  .row:is([data-fold="4"]) .pick-name {
    max-width: 72px;
  }
  .row:is([data-fold="5"], [data-fold="6"]) .pick-name {
    max-width: 48px;
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
  textarea {
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
  .ta-mirror {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 0;
    overflow: hidden;
    box-sizing: border-box;
    padding: 2px 0 2px 10px;
    font-size: 15px;
    font-family: inherit;
    line-height: 1.5;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    pointer-events: none;
  }
  .composer.floating .ta-mirror {
    font-size: 15.5px;
  }
  /* A quote line: the bubble's `.user-quote` look (bar, muted text), the
     bar in the gutter; the `> ` marker dimmed further but kept, so the
     characters and the caret stay where the textarea has them. */
  .ml.q {
    margin-left: -10px;
    padding-left: 10px;
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--dim);
  }
  .qm {
    opacity: 0.45;
  }
  /* Item 315: a fenced block in the box — a code ground under its lines
     (out into the gutter, as a quote's bar), the fence lines dimmed. The
     font stays the textarea's: the layer must match its glyphs. */
  .ml.code {
    margin-left: -10px;
    padding-left: 10px;
    background: var(--well);
  }
  .ml.fence {
    color: var(--dim);
  }
  .code-lang {
    position: absolute;
    right: 8px;
    z-index: 2;
    height: 1.35rem;
    margin-top: 0.1rem;
    padding: 0 0.3rem;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--sheet);
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .code-lang:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  textarea:focus {
    outline: none;
  }
  textarea:disabled {
    opacity: 0.5;
  }
  .send {
    padding: 6px 16px;
  }
  /* Send's split (backlog 224): the ▾ carries the right-hand corners. */
  .send-split {
    display: inline-flex;
    align-items: stretch;
  }
  .send-split .send {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
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
  .handoff {
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
  .handoff-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12.5px;
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
  .handoff-row input:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* The message: the composer's own field face, so it reads as the one
     thing here that is typed into. */
  .handoff-msg {
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

  /* The `/` picker (backlog 077): a plain list joined to the card's top. */
  .slash {
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
</style>
