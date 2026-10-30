<script lang="ts">
  import { tip } from "./tip";
  import { rewoundRuns } from "./rewindDraft.svelte";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  import { exactTime, relativeTimeLong } from "./time";
  import { onDestroy, tick, untrack } from "svelte";
  import {
    app,
    addToast,
    menuInterceptors,
    denialReason,
    draftAside,
    liveFlags,
    removeBlock,
    removeTurn,
    restoreBlock,
    restoreTurn,
    rewindTo,
    saveEdit,
    saveReplyEdit,
    sendEdit,
    setCheckpoint,
    openSession,
    resumeAfterLimit,
    retryConnect,
    runningChatName,
    setAsideRewound,
    keepRewound,
    loadPaneLog,
    paneChat,
    tabOpening,
    chatAgentSession,
  } from "./state.svelte";
  import type { Segment } from "./state.svelte";
  import { checkpointLine, checkpointOwner } from "./checkpoint";
  import { pauseLabel, resetLabel, resumeDelayMs } from "./limit";
  import {
    REMOVED_PLACEHOLDER,
    blockEdits,
    blockElisions,
    displayTexts,
    editButtons,
    editChanges,
    editLine,
    editorKey,
    chipPrint,
    chipsOf,
    editDirty,
    editParts,
    editReduce,
    editTexts,
    editAttachments,
    chipsChanged,
    elideFlags,
    isEditable,
    type EditState,
  } from "./edit";
  import { toolInputSummary } from "./transcriptPrefs.svelte";
  import { forkLine } from "./edit";
  import { parseSubagentBlock, placeSubagentBlock } from "./subagent";
  import { splitAdopted } from "./subagentAsk";
  import { councilOfTurn, rosterLabel } from "./council";
  import { wordDiff } from "./textdiff";
  import { continuedFlags } from "./runs";
  import { samePassage, selectionText, type AsideQuote } from "./asideQuote";
  import { pillParts, requestReply } from "./replyQuote.svelte";
  import { PREFERRED_CARD_HEIGHT, chooseSide, offsetsOf, type AsideAnchor } from "./asideCard";
  import { isMac } from "./platform";
  import { fmtShare, shareOf, turnSizes, userFigure } from "./tokens";
  import { replyUsageView } from "./replyUsage";
  import { loadReplyUsage, replyUsageOf } from "./replyUsage.svelte";
  import { cacheState } from "./cache";
  import { moveScroll, recallScroll, rememberScroll, scrollKey, NEW_SCROLL_KEY } from "./scroll.svelte";
  import { presence, watchPresence } from "./away.svelte";
  import {
    addAttachment,
    editDraftKey,
    nextAttachmentId,
    readDraft,
    removeAttachment,
    setDraftAttachments,
    stashEdit,
    takeEdit,
    updateAttachment,
  } from "./drafts.svelte";
  import { acceptFiles, conversionJobs, filesBlocked, MAX_IMAGE_BASE64, splitChips, trackPending } from "./attachFiles.svelte";
  import { placeOf, putPlace, trackPlace, type BoxPlace } from "./boxPlace";
  // Item 399: the edit box draws and pastes as the composer does.
  import BoxLayer, { layerShown } from "./BoxLayer.svelte";
  import LiveBox from "./LiveBox.svelte";
  import { LiveBoxHandle, type ComposerBox } from "./composerEditor";
  import { composerFormat } from "./composerFormat.svelte";
  import { fenced, findFences, withFenceLanguage } from "./codeDetect";
  import { pasteSteps, textPastePlan } from "./textPaste";
  import { BoxHistory, editKind, historyInput, historyKey } from "./boxHistory";
  import { attachPastedImages, fetchPasteImage, htmlImagePaste, preparePaste, rasterize } from "./pasteImages";
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
  import PasteOfferRow from "./PasteOfferRow.svelte";
  import { AttachMark, attachPastedText, convertOffer, isConvertTag, pasteAsAttachment, type ConvertTag } from "./pastedText.svelte";
  import { recordImage, recordText } from "./clipRing.svelte";
  import { markPasted } from "./dropLook.svelte";
  import EditAttachments from "./EditAttachments.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { removeAsk, removeTip, type RemoveKind } from "./removeAsk";
  // For its effect: the aside threads' keeper (backlog 137).
  import "./asides.svelte";
  import {
    JUMP_OFFSET,
    MIN_TICKS,
    activeTick,
    anchorSelector,
    animateScroll,
    cancelScroll,
    liveTick,
    replyGoing,
    scrollToLatest,
    showJumpDown,
    stepTick,
    ticks as tickModel,
  } from "./navigator";
  import type {
    ApprovalRequest,
    Attachment,
    DocumentInput,
    ImageInput,
    Usage,
  } from "./types";
  import AssistantMessage from "./AssistantMessage.svelte";
  import WaitingMoon from "./WaitingMoon.svelte";
  import UserBubble from "./UserBubble.svelte";
  import PendingBubbles from "./PendingBubbles.svelte";
  import AsideLayer from "./AsideLayer.svelte";
  import { openAttachment } from "./attachments.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import BudgetStopCard from "./BudgetStopCard.svelte";
  import { afterWrapTurn, wrapAsk } from "./budgetWrap.svelte";
  import Icon from "./Icon.svelte";
  import Navigator from "./Navigator.svelte";
  // Edits as versions (item 299): ‹ n/N › under an edited message.
  import { ensureForkInfo, openVersion, versionsOf } from "./versions.svelte";
  import { endsTurn, redoOf } from "./retry";
  import { retryReply } from "./retry.svelte";
  import { versionPlace } from "./versions";
  import { arrive, hasLaunch } from "./sendMotion";
  // Items 396 and 397: a rewind and a removal of his message play out
  // over a copy of the thread laid down just before the call.
  import { prepareDelete, prepareRewind } from "./messageMotion";
  // A Send near the foot lands at the bottom (item 313).
  import { followStep, restDistance, sendJumps } from "./sendScroll";
  // The first-paint mark of the message's timing line (item 256).
  import { hasText, turnClock } from "./turnTiming";

  interface AssistantFooter {
    model: string;
    usage: Usage;
    stop_reason: string | null;
    /** Recorded when the exchange ran; absent means unpriced, not free. */
    cost?: number;
    /** When the reply was recorded — its completion (backlog 123). */
    at: string;
  }

  type Body =
    | {
        kind: "user";
        text: string;
        images: ImageInput[];
        documents: DocumentInput[];
        at: string;
      }
    | { kind: "assistant"; segs: Segment[]; footer: AssistantFooter }
    | { kind: "compaction"; summary: string };

  /**
   * A rendered turn, plus where it sits in the log.
   *
   * `index` is what `rewind` takes, and `superseded` marks a turn a rewind
   * dropped. Since backlog 247 superseded turns are not drawn — a quiet
   * "N messages rewound" line stands in for each run (blocker 582) — and
   * the log still keeps them, so Undo brings them back.
   *
   * `original` is the text before an edit, when there was one, for the
   * `edited` mark to unfold; `removed` marks a turn an `elide` hides, drawn
   * as its placeholder, greyed, with the original a click away; `editable`
   * is whether Edit is offered at all (a reply with a tool call is
   * remove-only). All three come from `edit.ts`, which mirrors the core.
   * `originals` (backlog 105), on a reply, is per segment the block's text
   * before its edit — `null` for a block that was not edited, `""` for the
   * appended one — so the `edited` mark can draw each block's edit as a
   * diff over the current text.
   */
  type Item = Body & {
    index: number;
    superseded: boolean;
    original: string | null;
    removed: boolean;
    editable: boolean;
    originals?: (string | null)[];
  };

  /**
   * Both panes live (nightshift backlog 159, piece 5, 2026-09-30): given
   * `chat`, this transcript draws that chat in a pane that is not the open
   * chat's — its log and its live stream from wherever they are kept
   * (`paneChat`: off screen, parked, on screen, or its log read for the
   * pane), read-only. No editor, no rewind, no prompts to answer, no
   * asides, no window keys: a click in the pane opens the chat there
   * (`focusPane`), and this gives way to the open chat's transcript.
   * Without `chat` it is the open chat's, as it always was.
   */
  let { chat }: { chat?: string } = $props();
  const inPane = $derived(chat !== undefined);
  const paneView = $derived(chat !== undefined ? paneChat(chat) : null);
  /** The events drawn: the open chat's, or the pane's chat's. */
  const evs = $derived(chat !== undefined ? (paneView?.events ?? []) : app.events);
  /** The live turn drawn. */
  const liveNow = $derived(chat !== undefined ? (paneView?.live ?? null) : app.live);
  /** The prompts answered here: none in a pane (the click opens the chat). */
  const approvalsNow = $derived(chat !== undefined ? [] : app.pendingApprovals);
  /** The per-message controls are off while a turn runs, and in a pane. */
  const locked = $derived(chat !== undefined || app.busy);
  /** The chat drawn. */
  const chatId = $derived(chat !== undefined ? chat : app.activeSessionId);
  /** Its Claude Code session, where a tool result's images are read from
   *  (backlog 434): the log's, or for a first turn not yet re-synced the
   *  open chat's init line. */
  const cliSession = $derived(
    chatAgentSession(evs) ?? (chat === undefined ? (app.agentInit?.session_id ?? null) : null),
  );
  // The versions under an edited message (item 299): the forks in this
  // chat's lineage are read once each, so the arrows know where each one's
  // edited message is.
  $effect(() => {
    const id = chatId;
    const events = evs;
    void app.sessions;
    if (id) untrack(() => ensureForkInfo(id, events));
  });
  // A pane's chat whose log has not been read yet: read it — unless a tab
  // click is opening this very chat, whose log is on its way (item 454).
  $effect(() => {
    if (chat !== undefined && paneView === null && tabOpening.chat !== chat) void loadPaneLog(chat);
  });

  // Project SessionEvents into renderable items. tool_result events are
  // consumed by lookup against tool_use blocks and never rendered standalone.
  const items: Item[] = $derived.by(() => {
    const results = new Map<
      string,
      { content: string; is_error: boolean; denied: boolean }
    >();
    for (const e of evs) {
      if (e.event === "tool_result") {
        const isError = e.is_error ?? false;
        // A refused call is logged as an error result; read the refusal back
        // out so it renders as a decision rather than as a tool failure.
        const refusal = denialReason(e.content, isError);
        results.set(e.tool_use_id, {
          content: refusal ?? e.content,
          is_error: isError,
          denied: refusal !== null,
        });
      }
    }
    const out: Item[] = [];
    const live = liveFlags(evs);
    const edited = editTexts(evs);
    // Item 336: an edit's attachments stand in for the turn's own.
    const editedSets = editAttachments(evs);
    const removed = elideFlags(evs);
    const edits = blockEdits(evs);
    const gone = blockElisions(evs);
    let index = -1;
    const push = (body: Body, original: string | null = null, originals?: (string | null)[]) =>
      out.push({
        ...body,
        index,
        superseded: !live[index],
        original,
        removed: removed[index],
        editable: isEditable(evs, index),
        ...(originals ? { originals } : {}),
      });
    for (const e of evs) {
      index++;
      if (e.event === "user_message") {
        // Sessions logged before attachments existed carry neither key.
        const text = edited[index];
        push(
          {
            kind: "user",
            text: removed[index] ? REMOVED_PLACEHOLDER : (text ?? e.text),
            images: removed[index] ? [] : (editedSets[index]?.images ?? e.images ?? []),
            documents: removed[index] ? [] : (editedSets[index]?.documents ?? e.documents ?? []),
            at: e.at,
          },
          removed[index] ? (text ?? e.text) : text != null ? e.text : null,
        );
      } else if (e.event === "assistant_message") {
        const segs: Segment[] = [];
        // A whole removal stands in for the text and the thinking and
        // keeps the calls, as the core's elision does. Otherwise each
        // block says its latest edit, a block removed on its own draws
        // its placeholder (backlog 066), and every block carries its
        // index so the hover Remove and Restore can name it.
        const whole = removed[index];
        let placed = false;
        const said: string[] = [];
        const originals: (string | null)[] = [];
        e.blocks.forEach((b, block) => {
          switch (b.type) {
            case "thinking":
              if (whole) break;
              segs.push({ kind: "thinking", text: b.text, done: true });
              break;
            case "redacted_thinking":
              if (whole) break;
              segs.push({ kind: "redacted" });
              break;
            case "text": {
              // A subagent's recorded turn (backlog 075) nests under the
              // call that spawned it — in this message for a foreground
              // subagent, in an earlier one of the turn for a background
              // one — as one text segment of the narrative; it is not the
              // reply's own prose and never counts as `said`.
              // Placed in an agent's box, always (backlog 330) — never
              // the reply's prose, whose wall of `▸`/`↳` lines it was
              // when its call sat past his next message or inside
              // another subagent.
              const sub = parseSubagentBlock(b.text);
              if (sub && !whole) {
                placeSubagentBlock(sub, segs, earlierSegs(out));
                break;
              }
              said.push(b.text);
              if (whole) {
                if (!placed) segs.push({ kind: "text", text: REMOVED_PLACEHOLDER });
                placed = true;
              } else if (gone[index].has(block)) {
                segs.push({ kind: "removed_text", block, text: b.text });
              } else {
                const now = edits[index].get(block);
                segs.push({ kind: "text", text: now ?? b.text });
                originals[segs.length - 1] = now != null ? b.text : null;
              }
              break;
            }
            case "tool_use": {
              const result = results.get(b.id) ?? null;
              const call = {
                id: b.id,
                name: b.name,
                input: b.input,
                result,
                denied: result?.denied ?? false,
              };
              if (gone[index].has(block)) segs.push({ kind: "removed_tool", block, call });
              else segs.push({ kind: "tool", call, block });
              break;
            }
            default:
              // Unknown content block types are ignored by contract.
              break;
          }
        });
        const appended = edits[index].get(e.blocks.length);
        if (appended != null && !whole) {
          segs.push({ kind: "text", text: appended });
          originals[segs.length - 1] = "";
        }
        if (whole && !placed) segs.unshift({ kind: "text", text: REMOVED_PLACEHOLDER });
        push(
          {
            kind: "assistant",
            segs,
            footer: {
              model: e.model,
              usage: e.usage,
              stop_reason: e.stop_reason,
              cost: e.cost,
              at: e.at,
            },
          },
          whole || edits[index].size > 0 ? said.join("") : null,
          !whole && edits[index].size > 0 ? originals : undefined,
        );
      } else if (e.event === "compaction") {
        push({ kind: "compaction", summary: e.summary });
      }
      // session_created / tool_result / unknown events: not rendered.
    }
    return out;
  });

  // ~~`findCallIn`~~ moved to `subagent.ts` with the placing (backlog 330).
  /** The assistant messages already projected, newest first — a
   *  background subagent's block lands after its parent's message
   *  (backlog 075), past his next message too (backlog 330:
   *  ~~stopped at the first user message~~). */
  function earlierSegs(items: Item[]): Segment[][] {
    const out: Segment[][] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "assistant") out.push(it.segs);
    }
    return out;
  }

  /**
   * Prompts with no tool call to attach to — the live buffer is gone (an
   * error path) or the call streamed into a message that has already been
   * re-synced. They render standalone rather than not at all: an
   * unanswerable prompt parks the turn forever.
   */
  const stranded: ApprovalRequest[] = $derived.by(() => {
    const shown = new Set<string>();
    for (const seg of liveNow?.segments ?? []) {
      if (seg.kind === "tool") shown.add(seg.call.id);
    }
    return approvalsNow.filter((r) => !shown.has(r.id));
  });

  // What each turn added to the context (nightshift backlog 090): a
  // projection of the log's usage figures (`tokens.ts`), one entry per
  // event, null where nothing can be said; the share is against the
  // connected model's window, which the picker rows carry and the top-bar
  // gauge already scales by. Null window: the figure, no bar.
  const sizes = $derived(turnSizes(evs, liveFlags(evs)));

  // Each reply's share of the plan (item 323): the chat's lines, re-read
  // on a chat switch, when a turn ends (`busy` falls) and when the plan
  // reading changes — a turn's line is written by the next reading after
  // it, which is the next turn's first response or the chip's refresh.
  const usageChat = $derived(chat ?? app.activeSessionId);
  const usageLines = $derived(replyUsageOf(usageChat));
  $effect(() => {
    const id = usageChat;
    void app.busy;
    void app.planUsage;
    void loadReplyUsage(id);
  });
  const windowLimit = $derived(app.connection?.contextLimit ?? null);

  // Runs of replies (nightshift backlog 121): a reply that follows a reply
  // from the same model with nothing between them is drawn as a
  // continuation — no header, the gap collapsed — so a turn the CLI
  // recorded as several messages reads as one reply. Per item, in step
  // with `items`; the log and every per-message control are untouched.
  const continued = $derived(
    continuedFlags(
      items.map((it) => ({
        kind: it.kind,
        model: it.kind === "assistant" ? it.footer.model : undefined,
        superseded: it.superseded,
      })),
    ),
  );

  // Retry (item 333) rides the last reply of each turn.
  const turnEnds = $derived(endsTurn(items.map((it) => ({ kind: it.kind, superseded: it.superseded }))));
  // Redo (item 439): the same Retry, in the icon row under his last
  // message, beside Rewind — where he looked for it.
  const redo = $derived(redoOf(items, turnEnds));

  // Rewound turns are not drawn (backlog 247): one quiet line stands where
  // each run of them was (blocker 582).
  const rewound = $derived(rewoundRuns(items, continued));

  // When the live turn was sent, for its `working · 41 s` row (backlog
  // 096): both send paths push the optimistic `user_message` just before
  // `app.live`, so the newest one's `at` is the turn's start. Null when
  // nothing is live, or when the log has no such message (a turn started
  // some other way); the message then counts from its own mount.
  const liveSince: number | null = $derived.by(() => {
    if (!liveNow) return null;
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.event === "user_message") {
        const t = new Date(e.at).getTime();
        return Number.isNaN(t) ? null : t;
      }
    }
    return null;
  });

  // The clock the message feet read from (nightshift backlog 123): every
  // message ends in `37 minutes ago`, and a relative time that is computed
  // once freezes — review finding F14 caught the plan chip's age doing
  // exactly that. Half a minute is enough for a text whose finest unit is
  // a minute; the interval lives as long as the transcript does.
  let now = $state(Date.now());
  // A Wrap up pressed during a turn that no tool call carried goes as the
  // next message when the turn ends (nightshift backlog 192).
  $effect(() => {
    if (!inPane && !app.busy && wrapAsk.session) void afterWrapTurn();
  });
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // The in-place editor (nightshift backlog 062): one turn open at a time,
  // its draft, and the cache line as it read when the editor opened — a
  // fixed reading rather than a ticking one, since the sentence is advice
  // about the edit being typed, not a clock.
  let editing = $state<EditState>(null);
  let editCacheLine = $state("");
  // The edited mark's toggle (nightshift backlog 105): the turns whose edit
  // is drawn as a diff over the current text — what the edit removed struck
  // through, what it added marked — rather than as the plain text. Per
  // turn index, this screen only; a click on the mark flips it.
  let diffOpen = $state<Record<number, boolean>>({});
  // ~~`textOpen`~~ — a text attachment's fold (item 284) is the bubble's
  // own state since backlog 283 (`UserBubble.svelte`).
  // The toggle keeps the reader's place (backlog 115): the diff view is a
  // different height from the rendered text even for a one-word change —
  // struck and added spans, and the source's lines against the markdown's
  // headings and lists — so whatever is under the cursor is held there.
  // That is the mark itself, except when the view is at the foot, where
  // the message's bottom edge is held (his "the latest part of the
  // message stays at the bottom"); on a reply the mark sits under the
  // message, so the two agree there anyway.
  function toggleDiff(index: number, mark: HTMLElement | null = null): void {
    const anchor = pinned && atBottom() ? null : mark;
    void keepPlace(
      index,
      () => {
        diffOpen[index] = !diffOpen[index];
      },
      anchor,
    );
  }
  // The rewound turn's files (item 259): which he ticked to set aside.
  // Created files start ticked; edited ones and shell guesses do not, since
  // moving an edited file takes what was there before the turn with it.
  let asideTicks = $state<Record<string, boolean>>({});
  $effect(() => {
    void app.rewoundWrites;
    asideTicks = {};
  });
  const asideTicked = (path: string, how: string): boolean => asideTicks[path] ?? how === "created";
  const asidePaths = $derived(
    (app.rewoundWrites?.files ?? []).filter((f) => asideTicked(f.path, f.how)).map((f) => f.path),
  );
  const HOW_LABEL: Record<string, string> = { created: "created", edited: "edited", shell: "shell, a guess" };
  let editorEl = $state<HTMLTextAreaElement | null>(null);
  // Item 399: with the composer's format toggle on (item 276), a user
  // turn's editor is the composer's formatted box (`LiveBox`), as the
  // composer is; this is its handle, null while the textarea stands.
  let editorLive = $state<ComposerBox | null>(null);
  // A reply's editor is one textarea per text block (backlog 066); the
  // first takes the focus and each grows to its own text.
  let editorEls = $state<(HTMLTextAreaElement | null)[]>([]);
  // Backlog 355: each editor box's scroll and caret as he leaves it (the
  // user turn's box at 0, a reply's block p at p + 1), stashed with the
  // edit and put back once the editor is drawn again (`boxPlace.ts`).
  let editPlaces: (BoxPlace | null)[] = [];
  function placeBack(boxes: (BoxPlace | null)[] | undefined): void {
    editPlaces = boxes?.slice() ?? [];
    if (!boxes?.length) return;
    void tick().then(() => [editorLive ?? editorEl, ...editorEls].forEach((el, i) => putPlace(el, boxes[i])));
  }
  /** The editor boxes' places for a stash: the formatted box's read now
   *  (it has no `trackPlace`; its place is its handle's). */
  function editBoxPlaces(): (BoxPlace | null)[] {
    if (editorLive) editPlaces[0] = placeOf(editorLive);
    return editPlaces.slice();
  }
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  const controlsTitle = $derived(
    onClaudeCode
      ? "The next turn resumes a rewritten copy of Claude Code's history; the original session file is kept."
      : "",
  );
  // Rewind on this engine only edits the CLI's conversation history (backlog
  // 087): it does not touch anything a tool wrote to disk. A "code restore"
  // that would undo those file writes is wanted but not built — see 062 and
  // docs/service-agent.md "Editing the CLI's history".
  const rewindTitle = $derived(
    onClaudeCode
      ? "Rewind to here: this turn and everything after it stop counting. Conversation only — files stay as they are; git is the undo."
      : "Rewind to here: this turn and everything after it stop counting. Files written by tools are not reverted.",
  );
  // The user messages' log indexes, ascending, for the checkpoint's owner
  // (nightshift backlog 104): the exchange helpers fork from.
  const userIndexes = $derived(items.filter((it) => it.kind === "user").map((it) => it.index));

  /**
   * Keep the reader's place across a change that resizes a message
   * (nightshift backlog 122 and 115): the turn's bottom edge is measured,
   * the change made, and after the DOM has settled the viewport is moved
   * by however much that edge moved. The foot rather than the top, since
   * the controls that start these changes — the pencil, Cancel, the
   * `edited` mark — sit at the foot, and "the latest part of the message
   * stays at the bottom" was his words. Under `scrollingSelf`, so the pin
   * logic does not take the write for the user's own scroll. A turn no
   * longer on screen after the change (a fork switched the chat) is left
   * alone. The webview has no scroll anchoring of its own to do this.
   * `anchor` names another element whose bottom edge to hold instead —
   * the `edited` mark under the cursor (backlog 115).
   */
  async function keepPlace(
    index: number,
    change: () => void | Promise<void>,
    anchor: HTMLElement | null = null,
  ): Promise<void> {
    const el = anchor ?? viewport?.querySelector<HTMLElement>(`[data-turn="${index}"]`) ?? null;
    const before = el?.getBoundingClientRect().bottom ?? null;
    await change();
    await tick();
    if (before === null || !el?.isConnected || !viewport) return;
    const delta = el.getBoundingClientRect().bottom - before;
    if (Math.abs(delta) < 1) return;
    scrollingSelf = true;
    viewport.scrollTop += delta;
    requestAnimationFrame(() => (scrollingSelf = false));
  }

  // Copy on his own message (nightshift backlog 181): which turn just
  // copied, for the check mark's second, and the copy itself.
  let copiedTurn = $state<number | null>(null);
  async function copyUserText(index: number, text: string): Promise<void> {
    try {
      await copyText(text);
      copiedTurn = index;
      setTimeout(() => {
        if (copiedTurn === index) copiedTurn = null;
      }, 1200);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }
  function beginEdit(item: Item) {
    // Opening a second turn closes the first: ask before that drops a
    // changed edit (practices §7, item 336).
    if (editing && editing.index !== item.index && editDirty(editing, editChipsFor(editing))) {
      dropAsk = { what: "open", run: () => openEditor(item) };
      return;
    }
    openEditor(item);
  }
  function openEditor(item: Item) {
    editPlaces = [];
    const text = item.kind === "user" ? item.text : item.kind === "assistant" ? textOf(item.segs) : "";
    const parts =
      item.kind === "assistant"
        ? editParts(evs, item.index, (b) => `${b.name} ${toolInputSummary(b.input)}`.trim())
        : undefined;
    // Item 336: a user turn's editor opens on its own attachments as chips
    // (his report: the image vanished from the edit box). A reply's has none.
    const chips = item.kind === "user" ? chipsOf(item.images, item.documents, nextAttachmentId) : [];
    setDraftAttachments(editKey, chips);
    const chipsAt = item.kind === "user" ? chips.map(chipPrint) : undefined;
    void keepPlace(item.index, () => {
      editing = editReduce(editing, { type: "begin", index: item.index, text, parts, chipsAt });
      editCacheLine = editLine(cacheState(evs, Date.now()));
    }).then(() => {
      if (editorLive) {
        editorLive.focus();
        return;
      }
      const first = editorEl ?? editorEls.find((el) => el);
      // Not `focus()` bare: that scrolls the textarea's top edge into view,
      // which on a long message is a jump to its top (backlog 122). The
      // place was kept above; the caret needs no scroll.
      first?.focus({ preventScroll: true });
    });
  }
  function textOf(segs: Segment[]): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("");
  }
  function autogrow(el: HTMLTextAreaElement | null = null) {
    const els = el ? [el] : [editorEl, ...editorEls];
    for (const e of els) {
      if (!e) continue;
      e.style.height = "auto";
      e.style.height = `${Math.min(e.scrollHeight, 420)}px`;
    }
  }
  /**
   * The editor's textarea sized to its text the moment it mounts (backlog
   * 122). `autogrow` used to run only from `beginEdit`, so a textarea that
   * mounted any other way — an edit draft restored on switching back to
   * its chat — sat at its minimum height until the first keystroke; his
   * "the second I click back into the chat it majorly condenses the text
   * box". An action rather than an effect, since it is about the one
   * element and needs no dependency.
   */
  function grow(node: HTMLTextAreaElement) {
    autogrow(node);
  }
  /** The chips that count for `state`: a user turn's; none for a reply. */
  function editChipsFor(state: EditState) {
    return state && !state.parts ? editChips : undefined;
  }
  /** A pending "drop this edit?" question (practices §7, item 336). */
  let dropAsk = $state<{ what: "cancel" | "open"; run: () => void } | null>(null);
  // Remove asks first (item 356): the turn the trash button names, until
  // the dialog's Remove or Cancel. `key` is the chat it was asked in: the
  // service removes by index in the open chat, so a switch while the
  // dialog is open drops the question (wave 8 review) rather than
  // removing the same index from the chat switched to.
  let removing = $state<{ index: number; kind: RemoveKind; text: string; key: string } | null>(null);
  // The motions (items 396, 397): the copy goes down before the call and
  // plays once it lands; the state change itself is never held back, and a
  // refused or failed call lets the copy go on the next frame.
  async function rewindHere(index: number): Promise<void> {
    const m = prepareRewind(viewport, index);
    try {
      await rewindTo(index, true);
    } finally {
      m?.commit();
    }
  }
  async function removeHere(index: number): Promise<void> {
    const m = prepareDelete(viewport, index);
    try {
      await removeTurn(index);
    } finally {
      m?.commit();
    }
  }
  $effect(() => {
    const k = sessionKey;
    untrack(() => {
      if (removing && removing.key !== k) removing = null;
    });
  });
  function cancelEdit(): void {
    if (!editing) return;
    // A changed edit is not dropped on one key: Cancel and Escape ask.
    if (editDirty(editing, editChipsFor(editing))) {
      dropAsk = { what: "cancel", run: closeEditor };
      return;
    }
    closeEditor();
  }
  function closeEditor(): void {
    if (!editing) return;
    void keepPlace(editing.index, () => {
      editing = editReduce(editing, { type: "cancel" });
      stashEdit(sessionKey, null);
      setDraftAttachments(editKey, []);
    });
  }
  /**
   * A paste into a user turn's editor, read as the composer reads one
   * (item 399, his "if i copy in code it doesnt render it as code, neither
   * in the edit screen or even when i click send"): files become chips
   * (item 336) and pasted images land with the drop's shine (388); text
   * copied with images keeps them in place as `[image N]` and chips (382);
   * math from a web page goes in as its LaTeX (348); code goes in fenced
   * with its language, ⌘Z giving back the paste as it came (315) — the
   * plan is `textPastePlan`, the composer's own. Anything else is the
   * box's own paste. The text goes into the clipboard ring as the
   * composer's pastes do (173).
   */
  function editorPaste(e: ClipboardEvent): void {
    if (!editing || editing.parts) return;
    const box: ComposerBox | null = editorLive ?? editorEl;
    const plain = e.clipboardData?.getData("text/plain") ?? "";
    const files = Array.from(e.clipboardData?.files ?? []);
    const html = files.length === 0 ? (e.clipboardData?.getData("text/html") ?? "") : "";
    // Item 399b: ⌥⌘V's paste puts the text in as an attachment (284); a
    // clipboard holding a file is pasted as ⌘V would.
    const act = pasteAction(editAttachMark.take(), plain, files.length);
    if (act !== "box") {
      e.preventDefault();
      if (act === "attach") void attachPastedText(editKey, plain);
      else addToast("The clipboard holds no text to attach");
      return;
    }
    const firstImage = editChips.filter((a) => a.kind === "image").length + 1;
    const withImages = files.length === 0 ? htmlImagePaste(html, firstImage) : null;
    const caret = box ? Math.min(box.selectionStart, box.selectionEnd) : editing.draft.length;
    // Every text paste replaces the last one's offer (284), as in the composer.
    editConverted = null;
    if (withImages && box) {
      e.preventDefault();
      editPasteWithImages(box, withImages);
      return;
    }
    const plan = textPastePlan({ plain, html, fileCount: files.length, text: editing.draft, caret });
    if (plain) recordText("pasted", plan.kind === "math" ? plan.text : plain);
    if (plan.kind === "math" && box) {
      e.preventDefault();
      editInsert(box, plan.text);
      editOffer = longPasteOffer(plan.text, caret);
      return;
    }
    if (plan.kind === "code" && box) {
      e.preventDefault();
      editOffer = null;
      if (box instanceof LiveBoxHandle) box.pasteAsCode(plan.raw, (before, after) => fenced(plan.raw, plan.lang, before, after));
      else editPasteSteps(box as HTMLTextAreaElement, plan.raw, plan.lang);
      return;
    }
    // A long ⌘V paste: the text goes in as always (the box's own paste),
    // and the offer under the box can move it into an attachment (284).
    if (plain && files.length === 0) editOffer = longPasteOffer(plain, caret);
    if (files.length === 0) return;
    if (!plain) e.preventDefault();
    markPasted(files.filter((f) => f.type.startsWith("image/")).map((f) => f.name || "pasted image"));
    void acceptFiles(editKey, files).then((chips) => {
      for (const c of chips) if (c.kind === "image") recordImage("pasted", c);
    });
  }
  /** Text in place of the edit box's selection, one undo step, as a paste. */
  function editInsert(box: ComposerBox, text: string): void {
    if (box instanceof LiveBoxHandle) box.pasteText(text);
    else editPasteSteps(box as HTMLTextAreaElement, text, null);
  }
  /** A paste in the edit box's textarea as the composer's is: each step
   *  (`pasteSteps`) one of the box's own undo history, the last shown. */
  function editPasteSteps(box: HTMLTextAreaElement, raw: string, lang: string | null): void {
    if (!editing || editing.parts) return;
    const from = Math.min(box.selectionStart, box.selectionEnd);
    const to = Math.max(box.selectionStart, box.selectionEnd);
    const steps = pasteSteps(editing.draft, from, to, raw, lang);
    const last = steps[steps.length - 1];
    editHist.select(from, to);
    for (const st of steps) editHist.external(st.text, st.caret);
    editing = editReduce(editing, { type: "draft", text: last.text });
    void tick().then(() => {
      box.selectionStart = box.selectionEnd = last.caret;
      autogrow(box);
    });
  }

  /*
   * Item 399b (his answer to blocker 1508): the long paste's offer and
   * ⌥⌘V in the edit box, the composer's own (`pastedText.svelte.ts`,
   * `PasteOfferRow`): "Make this an attachment" under the box while it is
   * as the paste left it; one click moves the span into a chip of this
   * edit; Undo (or ⌘Z) puts it back while nothing has changed since.
   */
  let editOffer = $state<LongPaste | null>(null);
  let editConverted = $state<Converted | null>(null);
  const editAttachMark = new AttachMark();
  /** Whether the conversion's Undo still applies (a function: the edit's
   *  chips are declared further down). */
  function editUndoable(): boolean {
    return !!editing && !editing.parts && canUndo(editConverted, editing.draft, editChips.map((a) => a.id));
  }
  $effect(() => {
    const t = editing && !editing.parts ? editing.draft : null;
    untrack(() => {
      editOffer = t === null ? null : followOffer(editOffer, t);
    });
  });
  // Another turn's editor, or none: the offer and its Undo were this one's.
  // On the index alone (a derived), not on every keystroke's new state.
  const editIndex = $derived(editing && !editing.parts ? editing.index : null);
  $effect(() => {
    void editIndex;
    untrack(() => {
      editOffer = null;
      editConverted = null;
    });
  });
  async function editConvert(): Promise<void> {
    const o = editOffer;
    if (!o || !editing || editing.parts) return;
    editOffer = null;
    const at = editing.index;
    const key = editKey;
    const read = () => (editing && editing.index === at && !editing.parts ? editing.draft : null);
    const done = await convertOffer(o, key, read, (t) => attachPastedText(key, t));
    if (!done || !editing || editing.index !== at || editing.parts) return;
    // Blocker 1210: a step of the box's history that carries the chip.
    const tag: ConvertTag = { convert: true, chip: $state.snapshot(done.chip) as Attachment, before: done.before, after: done.after, caret: o.start };
    editHist.external(done.after, o.start, tag);
    editing = editReduce(editing, { type: "draft", text: done.after });
    editConverted = { before: done.before, after: done.after, chipId: done.chip.id, caret: o.start };
    void tick().then(() => editCaret(o.start));
  }
  function editUndoConvert(): boolean {
    const c = editConverted;
    editConverted = null;
    if (!editing || editing.parts || !canUndo(c, editing.draft, editChips.map((a) => a.id))) return false;
    const tag = editHist.undoTag;
    if (!editorLive && isConvertTag(tag) && tag.chip.id === c.chipId) return editStep("undo");
    const r = undoConverted(c);
    removeAttachment(editKey, c.chipId);
    editHist.external(r.text, r.caret);
    editing = editReduce(editing, { type: "draft", text: r.text });
    void tick().then(() => editCaret(r.caret));
    return true;
  }
  /** The edit box focused with its caret at `at` (either box). */
  function editCaret(at: number): void {
    const box: ComposerBox | null = editorLive ?? editorEl;
    if (!box) return;
    box.focus();
    box.selectionStart = box.selectionEnd = at;
    if (editorEl) autogrow(editorEl);
  }

  /*
   * Item 399: the edit box's undo is the composer's own history (blocker
   * 1210, `boxHistory.ts`) — WebKit's goes stale after any text the page
   * sets, and folds a scripted paste into the typing before it, so ⌘Z
   * after a code paste took his typing with it (measured). His keystrokes
   * are recorded from `beforeinput` / `input`; every other change to the
   * draft (a fence, a relabel, a marker rewritten) is seen by the effect
   * and recorded as a step of its own. Opening an editor starts afresh.
   */
  const editHist = new BoxHistory("");
  let editHistAt: number | null = null;
  let editComposing = false;
  let editNativeStepped = false;
  $effect(() => {
    const e = editing;
    const t = e && !e.parts ? e.draft : null;
    untrack(() => {
      if (!e || t === null) {
        editHistAt = null;
        return;
      }
      if (e.index !== editHistAt) {
        editHistAt = e.index;
        editHist.reset(t);
        editComposing = false;
      } else if (t !== editHist.current.text) editHist.external(t);
    });
  });
  const editSnap = (el: HTMLTextAreaElement) => ({ text: el.value, start: el.selectionStart, end: el.selectionEnd });
  function editBeforeInput(e: InputEvent): void {
    const el = e.currentTarget as HTMLTextAreaElement;
    const h = historyInput(e.inputType);
    if (h) {
      // WebKit's own undo (the Edit menu's, the context menu's): never
      // applied — its stack is the stale one — but answered from the box's.
      e.preventDefault();
      if (!editNativeStepped) {
        editNativeStepped = true;
        const mc = new MessageChannel();
        mc.port1.onmessage = () => (editNativeStepped = false);
        mc.port2.postMessage(0);
        editStep(h);
      }
      return;
    }
    editHist.before(editSnap(el));
  }
  /** One undo or redo in the edit box's textarea; false when there is none. */
  function editStep(dir: "undo" | "redo"): boolean {
    const el = editorEl;
    if (!el || !editing || editing.parts || editorLive) return false;
    // Not while an input method's marked text shows (as the composer).
    if (editComposing) return true;
    const st = dir === "undo" ? editHist.undo() : editHist.redo();
    if (!st) return true;
    // 399b: a conversion's chip goes with its undo and comes back with its
    // redo, so the pasted words are always in the box or in the chip.
    if (isConvertTag(st.tag)) {
      const t = st.tag;
      const has = editChips.some((a) => a.id === t.chip.id);
      if (dir === "undo") {
        editConverted = null;
        if (has) removeAttachment(editKey, t.chip.id);
      } else {
        if (!has) addAttachment(editKey, t.chip);
        editConverted = { before: t.before, after: t.after, chipId: t.chip.id, caret: t.caret };
      }
    }
    editing = editReduce(editing, { type: "draft", text: st.text });
    void tick().then(() => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(st.start, st.end);
      autogrow(el);
    });
    return true;
  }
  // The Edit menu's Undo while the edit box has the keyboard (macOS: the
  // menu takes ⌘Z before the box sees it), as the composer's.
  $effect(() => {
    const take = (id: string): boolean => {
      if (id !== "undo_app" && id !== "redo_app") return false;
      const box = editorLive instanceof LiveBoxHandle ? editorLive.element : editorEl;
      if (!box || !box.contains(document.activeElement)) return false;
      if (id === "undo_app" && editUndoable()) return editUndoConvert();
      return editStep(id === "undo_app" ? "undo" : "redo");
    };
    menuInterceptors.push(take);
    return () => {
      const i = menuInterceptors.indexOf(take);
      if (i >= 0) menuInterceptors.splice(i, 1);
    };
  });
  /** Item 382 in the edit box: the paste's text with its markers at the
   *  caret, then its images as chips of this edit, in marker order. */
  function editPasteWithImages(box: ComposerBox, paste: NonNullable<ReturnType<typeof htmlImagePaste>>): void {
    const chatKey = editKey;
    const at = editing?.index;
    const ready = preparePaste(paste, MAX_IMAGE_BASE64);
    const raw = normalizeNewlines(ready.text);
    const start = Math.min(box.selectionStart, box.selectionEnd);
    editInsert(box, raw);
    editOffer = longPasteOffer(raw, start);
    recordText("pasted", raw);
    markPasted(ready.images.map((i) => `image ${i.n}`));
    void attachPastedImages(ready.images, ready.failed, {
      nextId: nextAttachmentId,
      add: (chip) => addAttachment(chatKey, chip),
      update: (id, patch) => void updateAttachment(chatKey, id, patch),
      remove: (id) => removeAttachment(chatKey, id),
      chips: () => readDraft(chatKey).attachments,
      // A marker rewritten (an image that could not come) in this edit's
      // text, while this edit is the one open.
      readText: () => (editing && editing.index === at ? editing.draft : ""),
      setText: (t) => {
        if (editing && editing.index === at && !editing.parts) editing = editReduce(editing, { type: "draft", text: t });
      },
      fetch: fetchPasteImage,
      convert: rasterize,
      track: trackPending,
      record: (chip) => recordImage("pasted", chip),
      cap: MAX_IMAGE_BASE64,
      toast: (m) => addToast(m),
    });
  }
  /** Item 315 in the edit box: a block's language picked from its label —
   *  only the fence's info string changes, as one undoable edit. */
  function editRelabel(k: number, lang: string): void {
    if (!editing || editing.parts) return;
    const f = findFences(editing.draft)[k];
    const box = editorLive ?? editorEl;
    if (!f || !box) return;
    if (box instanceof LiveBoxHandle) {
      box.replaceRange(f.infoFrom, f.infoTo, lang);
      return;
    }
    const ta = box as HTMLTextAreaElement;
    const caret = ta.selectionStart;
    const shift = lang.length - (f.infoTo - f.infoFrom);
    editing = editReduce(editing, { type: "draft", text: withFenceLanguage(editing.draft, f, lang) });
    void tick().then(() => {
      const back = caret >= f.infoTo ? caret + shift : Math.min(caret, f.infoFrom);
      ta.selectionStart = ta.selectionEnd = back;
    });
  }
  function editorDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function editorDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void acceptFiles(editKey, files);
  }
  /** Wait for the edit box's office conversions, saying so; false when
   *  the editor closed or moved meanwhile. */
  async function editConversions(index: number): Promise<boolean> {
    const jobs = conversionJobs(editKey);
    if (jobs.length === 0) return true;
    const names = editChips.filter((a) => a.pending).map((a) => a.name);
    addToast(`Converting ${names.join(", ")} — the message sends when ${names.length === 1 ? "it is" : "they are"} ready`);
    await Promise.all(jobs);
    return editing?.index === index;
  }
  async function commitSave() {
    if (!editing || !editButtons(editing, editChipsFor(editing)).save) return;
    if (!editing.parts) {
      // Item 336: a converting chip is waited for; a file for Claude Code
      // has no place in a past turn (the log keeps none), so it goes by Send.
      if (!(await editConversions(editing.index)) || !editing) return;
      const files = editChips.filter((a) => a.kind === "file");
      if (files.length > 0) {
        addToast(
          `${files.map((f) => f.name).join(", ")}: a file Claude Code opens itself can go only with a new message — Send starts a fork with it, or remove it to Save`,
        );
        return;
      }
    }
    const { index, draft, parts } = editing;
    const changes = editChanges(editing);
    await keepPlace(index, async () => {
      // Item 336: a user turn's chips go with the Save when they changed —
      // the whole set, the turn's own less the removed plus the added.
      const set = !parts && chipsChanged(editing, editChips) ? splitChips($state.snapshot(editChips)) : null;
      const ok = parts
        ? await saveReplyEdit(index, changes)
        : await saveEdit(index, draft, set ? { images: set.images, documents: set.documents } : null);
      if (ok) {
        editing = editReduce(editing, { type: "done" });
        stashEdit(sessionKey, null);
        setDraftAttachments(editKey, []);
      }
    });
  }
  async function commitSend(item: Item) {
    if (!editing || !editButtons(editing, editChips).send || item.kind !== "user") return;
    const { index } = editing;
    // Item 336: the fork's first message carries the edit box's chips —
    // the turn's own, less any removed, plus any added — not the turn's
    // originals. An office file still converting is waited for first.
    if (!(await editConversions(index)) || !editing) return;
    const chips = $state.snapshot(editChips) as typeof editChips;
    if (filesBlocked(chips)) return;
    const { draft } = editing;
    const wire = splitChips(chips);
    const before = editing;
    const line = editCacheLine;
    const key = sessionKey;
    const chipsKey = editKey;
    await keepPlace(index, () => {
      editing = editReduce(editing, { type: "done" });
      stashEdit(sessionKey, null);
      setDraftAttachments(editKey, []);
    });
    const ok = await sendEdit(index, draft, wire.images, wire.documents, null, wire.files);
    // The fork refused (an error toast, or a turn started meanwhile): the
    // edit comes back — words and chips — rather than vanish on one Enter
    // (practices §7; w6-review 2026-10-11).
    if (!ok && sessionKey === key) {
      setDraftAttachments(chipsKey, chips);
      if (app.busy) stashEdit(key, { editing: before, line });
      else if (!editing) {
        editing = before;
        editCacheLine = line;
      }
    }
  }
  function editorKeys(e: KeyboardEvent, item: Item) {
    // ~~Enter is a newline here; ⌘/Ctrl-Enter saves, ⌘/Ctrl-Shift-Enter
    // sends~~ (2026-10-11, item 337): in a user turn's editor Enter sends
    // as the composer's does, Shift+Enter is a newline, and Save is its
    // button only; a reply's editor keeps Enter a newline and ⌘/Ctrl-Enter
    // to save. The mapping is `editorKey` (edit.ts), IME-safe (item 322).
    // Item 399: ⌘Z / ⌘⇧Z in a user turn's textarea step the box's own
    // history, as in the composer (the formatted box has its own).
    if (item.kind === "user") {
      // 399b: ⌥⌘V pastes the clipboard's text as an attachment (284).
      if (isPasteAsAttachmentKey(e)) {
        e.preventDefault();
        void pasteAsAttachment(editAttachMark, (t) => attachPastedText(editKey, t));
        return;
      }
      // Esc while the offer stands dismisses it (318); the paste stays.
      if (e.key === "Escape" && editOffer && editOffer.after !== null && !editComposing && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        editOffer = null;
        return;
      }
      // ⌘Z right after "Make this an attachment" puts the text back.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && editUndoable()) {
        e.preventDefault();
        editUndoConvert();
        return;
      }
    }
    const step = item.kind === "user" && !editorLive ? historyKey(e, isMac) : null;
    if (step && editStep(step)) {
      e.preventDefault();
      return;
    }
    const action = editorKey(e, item.kind !== "user");
    if (!action) return;
    e.preventDefault();
    if (action === "cancel") cancelEdit();
    else if (action === "send") void commitSend(item);
    else void commitSave();
  }
  // A turn starting closes the editor rather than leave it over a
  // transcript changing under it — but the draft is kept (backlog 137: a
  // turn from the phone, a wake's "continue", a hand-off's wrap-up used to
  // discard it), and comes back when the turn ends: the turn appends, so
  // the edited turn is where it was.
  $effect(() => {
    const busy = app.busy;
    // A pane opens no editor (piece 5): the open chat's transcript holds it.
    if (inPane) return;
    untrack(() => {
      if (busy) {
        if (editing) stashEdit(sessionKey, { editing, line: editCacheLine, boxes: editBoxPlaces() });
        editing = editReduce(editing, { type: "busy" });
      } else if (!editing) {
        const back = takeEdit(sessionKey);
        if (back) {
          editing = back.editing;
          editCacheLine = back.line;
          placeBack(back.boxes);
        }
      }
    });
  });

  let viewport = $state<HTMLDivElement | null>(null);
  // Pin to bottom until the user scrolls up; re-pin when they reach the
  // bottom again. Deliberately not $state: changes to it should not
  // re-trigger the effect.
  let pinned = true;
  // Set around our own scrollTop writes so the scroll event they raise is
  // not mistaken for the user's.
  let scrollingSelf = false;

  function atBottom(): boolean {
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 8;
  }

  // The user's intent arrives before the scroll position does: one wheel
  // tick up moves ~40px, and a "pinned unless more than 80px up" rule read
  // that as still pinned, so the next delta snapped the view back to the
  // foot — his "glitching back and forth" while trying to read a fast
  // reply from the top (2026-09-14). Any upward input unpins at once.
  // As an action rather than markup handlers: these read intent off a
  // scroll container, and the a11y lint (rightly) has no category for that.
  function scrollIntent(node: HTMLElement) {
    let touchY = 0;
    // Any upward input also ends the ⌄'s ride down (item 218).
    const up = () => {
      pinned = false;
      chasing = false;
    };
    // Item 359 (review): his own scrolling ends the rail's eased jump
    // (`animateScroll`), which would otherwise pull the view back to its
    // target every frame for up to 400 ms. ⌥↑ / ⌥↓ start a jump, so they
    // never cancel one.
    const wheel = (e: WheelEvent) => {
      cancelScroll();
      if (e.deltaY < 0) up();
    };
    const key = (e: KeyboardEvent) => {
      if (!e.altKey && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key))
        cancelScroll();
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) up();
    };
    const touchstart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const touchmove = (e: TouchEvent) => {
      cancelScroll();
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY) up();
      touchY = y;
    };
    node.addEventListener("wheel", wheel, { passive: true });
    node.addEventListener("keydown", key);
    node.addEventListener("touchstart", touchstart, { passive: true });
    node.addEventListener("touchmove", touchmove, { passive: true });
    return {
      destroy() {
        node.removeEventListener("wheel", wheel);
        node.removeEventListener("keydown", key);
        node.removeEventListener("touchstart", touchstart);
        node.removeEventListener("touchmove", touchmove);
      },
    };
  }

  function onscroll() {
    if (!scrollingSelf && !chasing) {
      // A scrollbar drag has no wheel event; it unpins here on its way up
      // and re-pins here on its way back down. Reaching the foot by any
      // means re-pins. Not while the ⌄'s smooth scroll is on its way down
      // (item 218): its own scroll events would unpin it mid-ride, and a
      // reply landing then would not be followed.
      pinned = atBottom();
    }
    scheduleScrollWork();
    // The Ask aside pill is fixed to the selection's rectangle, which a
    // scroll moves — into the viewport as well as out of it (backlog 107).
    if (asidePill || document.getSelection()?.isCollapsed === false) placePill();
  }

  $effect(() => {
    void evs.length;
    void app.liveVersion;
    void approvalsNow.length;
    // A pane follows its chat's stream off screen too (piece 5).
    if (inPane) void app.paneVersion;
    void tick().then(() => {
      // The live reply's first words are in the DOM now; the frame that
      // draws them is its first paint (item 256's timing line) — the open
      // chat's transcript's frame, not a pane's.
      if (!inPane && turnClock.waitingForPaint() && hasText(liveNow?.segments)) {
        requestAnimationFrame(() => turnClock.painted());
      }
      // Not looking (backlog 347): while the window is in the background
      // the view stays where he left it and stops following — the refocus
      // finds his place with the ⌄ showing there is more, and a later
      // delta does not snap it down. The ⌄ re-pins, as ever.
      const step = viewport ? followStep(pinned, presence.away, atBottom()) : "stay";
      if (step === "release") {
        pinned = false;
      } else if (step === "follow" && viewport) {
        scrollingSelf = true;
        viewport.scrollTop = viewport.scrollHeight;
        // The scroll event fires asynchronously; clear after it has.
        requestAnimationFrame(() => (scrollingSelf = false));
      }
      measureNav();
    });
  });
  watchPresence();

  // ---- Per-chat scroll position (nightshift backlog 065, 2026-09-15) ----
  //
  // The position and `pinned` are written to `scroll.svelte.ts` under the
  // open chat's key as the view scrolls, one write per frame at most, and
  // read back when the key changes: `pinned` at once, so the pin effect
  // above (which fires on the same switch, the event count having changed)
  // sees the switched-to chat's state and not the last chat's; the
  // position after the tick that renders the new events. A chat with no
  // entry lands at the bottom, as every chat did before today.
  //
  // The first turn of a pending chat is the one key change that is not a
  // switch: the key goes from "new" to the created id while this same
  // transcript is on screen (the composer's `blank` test mounts it on the
  // send), and the entry follows the key rather than being restored.
  const sessionKey = $derived(scrollKey(chatId));
  /** The edit box's chips (item 336): the chat's `editDraftKey` in the
   *  drafts store, where the composer's attach code puts them. */
  const editKey = $derived(editDraftKey(sessionKey));
  const editChips = $derived(readDraft(editKey).attachments);
  let lastKey: string | null = null;
  let scrollFrame = 0;

  function scheduleScrollWork() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (viewport) rememberScroll(sessionKey, viewport.scrollTop, pinned);
      measureNav();
    });
  }

  // An open editor is per chat too (nightshift backlog 122). `editing` was
  // one value for the whole transcript: a switch away left it set, so the
  // other chat's message at the same index showed the editor with this
  // chat's draft in it, and a switch back re-mounted the textarea. Now the
  // switch stashes the open edit under the chat it belongs to and restores
  // the switched-to chat's, if it has one — the draft survives the switch,
  // as it did by accident before, and stays with its chat. ~~A plain map,
  // read once per switch, like the scroll entries.~~ The map moved out of
  // this component (backlog 137, `drafts.svelte.ts`): with the tabs this
  // component unmounts on a note tab in the same pane, on the live tab
  // dragged across, and a component-local map went with it. The stash is
  // written on the switch and on unmount, and read on the switch and on
  // mount, so the draft is wherever the chat is drawn next. A cancel or a
  // save forgets the entry (`stashEdit(key, null)`); a switch with no
  // editor open leaves it, since a turn in progress may be holding it.

  $effect(() => {
    const key = sessionKey;
    const from = lastKey;
    lastKey = key;
    // Item 359 (review): a rail jump still easing in the chat just left
    // must not go on scrolling this one (its aim re-reads the anchors each
    // frame, now this chat's) and overwrite the position restored below.
    if (from !== null && from !== key) cancelScroll();
    if (from === NEW_SCROLL_KEY && key !== NEW_SCROLL_KEY) {
      moveScroll(from, key);
      return;
    }
    if (from !== key && !inPane) {
      // Untracked: this effect is about the key, and a keystroke in the
      // editor must not re-run the scroll restore below. (A pane's
      // transcript leaves the chat's stashed edit for the open one.)
      untrack(() => {
        if (from !== null && editing) stashEdit(from, { editing, line: editCacheLine, boxes: editBoxPlaces() });
        const back = takeEdit(key);
        editing = back?.editing ?? null;
        editCacheLine = back?.line ?? "";
        placeBack(back?.boxes);
      });
    }
    const entry = recallScroll(key);
    pinned = entry?.pinned ?? true;
    void tick().then(() => {
      if (!viewport) return;
      if (entry && !entry.pinned) {
        scrollingSelf = true;
        viewport.scrollTop = entry.top;
        requestAnimationFrame(() => (scrollingSelf = false));
      }
      measureNav();
    });
  });

  // Unmounted with an editor open — the pane's active tab became a note,
  // the live tab went to the other pane — the draft is stashed for the
  // next mount on this chat (backlog 137).
  onDestroy(() => {
    if (!inPane && editing && lastKey !== null)
      stashEdit(lastKey, { editing, line: editCacheLine, boxes: editBoxPlaces() });
  });

  // ---- The sent message's entrance (nightshift backlog 095, 2026-09-16) ----
  //
  // Only the turn just sent moves: a user turn appended while this
  // transcript was already showing this chat, at the moment a turn started
  // (`app.live` set in the same flush as the optimistic push — both send
  // paths do that), gets `.enter` and rises in over 180 ms. A chat opened or
  // reopened loads whole: the key changed, so the mark resets and nothing
  // cascades. The mark is an index floor rather than a flag per item so the
  // post-turn re-sync, which replaces `app.events` with the same turn at the
  // same index, keeps the element and the class and the animation does not
  // replay (the each is keyed by position). Reduced motion turns it off in
  // the CSS.
  //
  // Since backlog 194 (2026-09-25) the motion is `sendMotion.ts`'s: the
  // floor is the action's `active`, and a turn whose composer recorded a
  // launch flies in from the box with the accent thread; one with no
  // launch (the wrap-up, a phone send) keeps the 180 ms rise.
  let enterFrom = $state(Infinity);
  let enterKey: string | null = null;
  let enterLen = 0;
  // Item 313: how far above the foot the view was just before the log
  // grew — read before the DOM takes the new turn, so the distance is the
  // reader's, not the reader's plus the sent bubble's height.
  let preDistance = 0;
  let preHeight = 0;
  let preTop = 0;
  $effect.pre(() => {
    void evs.length;
    untrack(() => {
      if (!viewport) return;
      preDistance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      preHeight = viewport.clientHeight;
      preTop = viewport.scrollTop;
    });
  });
  // 313 review: a tall paste had grown the box, so the view read at Send
  // was shorter and the foot further by the box's growth — out of range
  // for a Send from half a screen up. The box shrinks back on the frame
  // after the Send (`afterSend`'s rAF, queued first); read again then, as
  // the reader's place with the box at rest. This late land skips the
  // fly-in (the bubble was below the view when `fly` measured it).
  function recheckSendJump(key: string | null): void {
    const top = preTop;
    const d = preDistance;
    const h = preHeight;
    requestAnimationFrame(() => {
      // Not while away (backlog 347): a send from the phone or a queued
      // message going out moves nothing he is not looking at.
      if (pinned || presence.away || !viewport || sessionKey !== key || viewport.scrollTop !== top) return;
      const now = viewport.clientHeight;
      if (now <= h) return;
      const r = restDistance(d, h, now);
      if (!sendJumps(r.distance, r.viewport)) return;
      pinned = true;
      jumpDown = false;
      scrollingSelf = true;
      viewport.scrollTop = viewport.scrollHeight;
      requestAnimationFrame(() => (scrollingSelf = false));
    });
  }
  $effect(() => {
    const key = sessionKey;
    const len = evs.length;
    const live = liveNow !== null;
    // A pane does not play the send's entrance (piece 5): the launch from
    // the box is the open chat's transcript's to take.
    if (inPane) return;
    if (key !== enterKey) {
      // A new chat's first send mounts this transcript (or moves its key
      // off "new") with the turn already in it; a launch from the box is
      // waiting, so that turn flies too (194 fix pass). A plain open or
      // switch has no fresh launch and loads whole, as before.
      const fresh = (enterKey === null || enterKey === NEW_SCROLL_KEY) && live && hasLaunch("chat");
      enterKey = key;
      enterFrom = fresh ? 0 : Infinity;
      enterLen = len;
      return;
    }
    if (len > enterLen && live) {
      enterFrom = enterLen;
      // Item 313: a Send from within one screen of the foot lands at the
      // bottom and follows the reply; from further up the place is kept.
      // Re-pinning is enough: the follow-the-bottom effect above, run by
      // the same `evs.length` change, lands on the foot after this flush's
      // tick — instantly, as a Send at the foot always has, so the new
      // bubble is in view when `sendMotion` measures it a frame later and
      // the fly-in plays (the ⌄'s smooth ride would leave it below the
      // view then, and `fly` skips a bubble out of view).
      if (!pinned && sendJumps(preDistance, preHeight)) {
        pinned = true;
        jumpDown = false;
      } else if (!pinned) {
        recheckSendJump(key);
      }
    }
    enterLen = len;
  });

  // ---- The reply's completion (nightshift backlog 131, 2026-09-17) ----
  //
  // A turn ends in two flushes: `app.live` is cleared at once, and the log
  // is re-synced after an IPC round trip. Between them the reply was not
  // in the DOM at all. Measured in the harness with a reader at the
  // reply's first lines (`scrollTop` 340, the reply 3,000px tall): the
  // content shrank to the viewport's height, the browser clamped
  // `scrollTop` to 0, and that clamp raised a scroll event which `onscroll`
  // read as the user reaching the foot — `pinned` went true again, and
  // the re-sync then scrolled to the bottom (3080). His "jumps either up
  // or down": the clamp up, then the pin down.
  //
  // So the reply stays drawn: the last live segments are kept as a ghost
  // — the same component instance, the same array, so nothing re-renders
  // — until the re-synced events land, and the swap from ghost to record
  // happens in one flush. Across that swap the reader's place is held by
  // whatever element sits under the viewport's top edge, found again in
  // the new DOM by its text (the recorded reply is not the live one's
  // elements: it gains the model header above and the footer below, and
  // on Claude Code may be several messages). A pinned reader is left to
  // the follow-the-bottom effect above, which lands at the foot as before.
  interface Shown {
    segments: Segment[];
    since: number | null;
  }
  let ghost = $state<Shown | null>(null);
  let ghostKey: string | null = null;
  let ghostTimer = 0;
  let lastLive: Shown | null = null;
  const shown = $derived<Shown | null>(
    liveNow ? { segments: liveNow.segments, since: liveSince } : ghost,
  );

  function dropGhost(anchored: boolean): void {
    clearTimeout(ghostTimer);
    ghostTimer = 0;
    if (!ghost) return;
    const hold = anchored && !pinned ? readingAnchor() : null;
    ghost = null;
    if (hold) void tick().then(() => holdAnchor(hold));
  }

  $effect.pre(() => {
    const live = liveNow;
    const since = liveSince;
    untrack(() => {
      if (live) {
        lastLive = { segments: live.segments, since };
        ghostKey = sessionKey;
        if (ghost) dropGhost(false);
        return;
      }
      if (!lastLive || lastLive.segments.length === 0 || ghostKey !== sessionKey) {
        lastLive = null;
        return;
      }
      ghost = lastLive;
      lastLive = null;
      // The re-sync can fail (its catch keeps the local view); the ghost
      // must not outlive that. Two seconds is past any IPC wait.
      ghostTimer = window.setTimeout(() => dropGhost(true), 2000);
    });
  });

  // The re-synced log replaces `app.events` whole (a new array, whatever
  // its length), which is the moment to swap. Before the DOM updates, so
  // the anchor is measured against the ghost and the swap is one flush.
  $effect.pre(() => {
    void evs;
    void evs.length;
    const key = sessionKey;
    untrack(() => {
      if (!ghost) return;
      dropGhost(key === ghostKey);
    });
  });

  /**
   * What he is reading: the first element with text inside the live reply
   * in the top half of the viewport — the reply is what changes shape,
   * and with its first lines under a half-visible user bubble it is the
   * lines he holds, not the bubble (measured: the model header pushed
   * them 24px with the bubble held). None of the reply there: the first
   * element with text under the top edge, whatever it is. The live reply
   * is the one `.assistant` not inside a recorded turn. By tag, the start
   * of its text, and where its top was.
   */
  function readingAnchor(): { tag: string; text: string; top: number } | null {
    if (!viewport) return null;
    const vp = viewport.getBoundingClientRect();
    const x = vp.left + vp.width / 2;
    let first: { tag: string; text: string; top: number } | null = null;
    for (let dy = 2; dy < vp.height / 2; dy += 12) {
      const el = document.elementFromPoint(x, vp.top + dy);
      if (!el || el === viewport || !viewport.contains(el)) continue;
      const text = (el.textContent ?? "").trim();
      if (!text) continue;
      const hit = { tag: el.tagName, text: text.slice(0, 160), top: el.getBoundingClientRect().top };
      if (el.closest(".assistant") && !el.closest("[data-turn]")) return hit;
      first ??= hit;
    }
    return first;
  }

  /** Move the viewport so the anchor's element is back where it was — the
   *  nearest same-tag element with the same text start, since a paragraph
   *  can be repeated. Nothing matched: the view is left alone. */
  function holdAnchor(hold: { tag: string; text: string; top: number }): void {
    if (!viewport) return;
    let best: number | null = null;
    for (const el of viewport.querySelectorAll<HTMLElement>(hold.tag)) {
      if ((el.textContent ?? "").trim().slice(0, 160) !== hold.text) continue;
      const delta = el.getBoundingClientRect().top - hold.top;
      if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
    }
    if (best === null || Math.abs(best) < 1) return;
    scrollingSelf = true;
    viewport.scrollTop += best;
    requestAnimationFrame(() => (scrollingSelf = false));
  }

  // ---- The message navigator (nightshift backlog 065) ----
  //
  // The strip's model is a projection of the log (`navigator.ts`); what
  // this owns is the geometry — where each message's anchor sits in the
  // viewport's scroll space, which one is being read, whether the view
  // scrolls at all — measured once per frame on scroll and again after
  // the events change. `data-turn` on each turn is the anchor.
  // Item 359: the reply still streaming (or its ghost) has a rib too,
  // anchored on `data-nav-live` — LibreChat's rail lists the row the
  // moment it mounts and previews "Generating" until it has words.
  const navTicks = $derived.by(() => {
    const logged = tickModel(evs, liveFlags(evs), displayTexts(evs));
    if (!shown) return logged;
    const said = shown.segments.map((s) => (s.kind === "text" ? s.text : "")).join("");
    return [...logged, liveTick(said)];
  });
  let navActive = $state<number | null>(null);
  let navScrolls = $state(false);
  // Item 359: shown from three messages whether or not the chat scrolls
  // (LibreChat's rule); before, only when it scrolled and from four.
  const showNav = $derived(navTicks.length >= MIN_TICKS);
  // The round ⌄ above the composer (item 218): lit when scrolled up past
  // `JUMP_DOWN_SHOW`, dark at the foot and while its own click is carrying
  // the view down (`chasing`, cleared at the foot or on any upward input).
  let jumpDown = $state(false);
  /** Item 304: a reply still coming here — the ⌄ shows the speaking dots. */
  const speaking = $derived(replyGoing(liveNow !== null, app.busy, inPane, app.parked !== null));
  let chasing = false;
  let chaseTimer: ReturnType<typeof setTimeout> | undefined;

  function anchorTop(index: number): number | null {
    if (!viewport) return null;
    const el = viewport.querySelector<HTMLElement>(anchorSelector(index));
    if (!el) return null;
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  }

  function measureNav() {
    if (!viewport) return;
    navScrolls = viewport.scrollHeight > viewport.clientHeight + 8;
    if (chasing && atBottom()) chasing = false;
    jumpDown = showJumpDown(viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight, chasing);
    if (navTicks.length < MIN_TICKS) {
      navActive = null;
      return;
    }
    // A chat that does not scroll is read from its first message (theirs).
    if (!navScrolls) {
      navActive = 0;
      return;
    }
    // Item 454: every anchor in one pass. `anchorTop` per tick ran a
    // selector over the whole transcript for each — quadratic in the
    // chat's length, ~190 ms per measure at 300 turns, five measures a
    // switch. The first match in document order, as `querySelector`'s.
    const found = new Map<string, HTMLElement>();
    for (const el of viewport.querySelectorAll<HTMLElement>("[data-turn], [data-nav-live]")) {
      const turn = el.getAttribute("data-turn");
      if (turn !== null && !found.has(turn)) found.set(turn, el);
      if (el.hasAttribute("data-nav-live") && !found.has("live")) found.set("live", el);
    }
    const base = viewport.getBoundingClientRect().top - viewport.scrollTop;
    const tops = navTicks.map((t) => {
      const el = found.get(t.index < 0 ? "live" : String(t.index));
      return el ? el.getBoundingClientRect().top - base : 0;
    });
    navActive = activeTick(tops, viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight);
  }

  // A resize changes whether the view scrolls and where the third line is.
  $effect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureNav());
    ro.observe(viewport);
    return () => ro.disconnect();
  });

  /** Scroll so the message sits just under the top edge; the view is no
   *  longer following the reply. Item 359: LibreChat's 400 ms ease-out
   *  cubic, re-aimed every frame, rather than the browser's smooth scroll;
   *  `instant` for a drag along the rail. */
  function jumpTo(i: number, instant = false) {
    const t = navTicks[i];
    if (!t || !viewport) return;
    const top = anchorTop(t.index);
    if (top === null) return;
    pinned = false;
    const vp = viewport;
    const aim = () => {
      const now = anchorTop(t.index);
      if (now === null) return null;
      return Math.max(0, Math.min(now - JUMP_OFFSET, vp.scrollHeight - vp.clientHeight));
    };
    if (instant) {
      cancelScroll();
      vp.scrollTop = aim() ?? vp.scrollTop;
    } else {
      animateScroll(vp, aim);
    }
    // So ⌥↑ / ⌥↓ work from here: the keys are on the viewport, and a click
    // on the strip would otherwise leave focus on the strip.
    viewport.focus({ preventScroll: true });
  }
  function toTop(instant = false) {
    if (!viewport) return;
    pinned = false;
    cancelScroll();
    viewport.scrollTo({ top: 0, behavior: instant ? "instant" : "smooth" });
    viewport.focus({ preventScroll: true });
  }
  /** The ⌄'s click (item 218; it was 065's bottom chevron on the strip):
   *  to the latest message, re-pinned so a reply still streaming is
   *  followed from there. */
  function toBottom() {
    if (!viewport) return;
    pinned = true;
    chasing = true;
    jumpDown = false;
    cancelScroll();
    scrollToLatest(viewport);
    // A smooth scroll that something else interrupts (a scrollbar grab)
    // never reaches the foot; the ride is over by then either way.
    clearTimeout(chaseTimer);
    chaseTimer = setTimeout(() => {
      chasing = false;
      measureNav();
    }, 1500);
    viewport.focus({ preventScroll: true });
  }
  /** A click on this chat's row in the running list (backlog 309): to
   *  the running turn at the foot, as the ⌄ does. The window's own
   *  transcript only (a split pane's draws `chat`); a bump from before
   *  this transcript existed is not its to answer. */
  let seenLatest = app.toLatest;
  $effect(() => {
    const n = app.toLatest;
    if (n === seenLatest) return;
    seenLatest = n;
    if (chat === undefined) untrack(() => toBottom());
  });

  // ⌥↑ / ⌥↓ step to the previous / next message. On the viewport rather
  // than the window: the composer's own ⌥↑ moves the caret by paragraph
  // and should keep doing so. (`scrollIntent` above also sees ArrowUp and
  // unpins, which is right — a step up is a step away from the foot.)
  function viewportKeys(e: KeyboardEvent) {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (navTicks.length === 0) return;
    e.preventDefault();
    const next = stepTick(navActive, e.key === "ArrowDown" ? 1 : -1, navTicks.length);
    if (next !== null) jumpTo(next);
  }

  /**
   * The "Continued from" header (the design's board 5b, backlog 086): a
   * chat the hand-off card opened carries its parent on its creation line
   * with `reason: "handoff"`; above its first turn a dashed row names the
   * earlier chat and HANDOFF.md, and opens the earlier chat on click. The
   * top bar's own mark stays; this is the transcript's copy of it, where
   * the board draws it.
   */
  const continuedFrom = $derived.by(() => {
    const session = app.sessions.find((s) => s.id === chatId) ?? null;
    if (!session?.forked_from || session.forked_from.reason !== "handoff") return null;
    const line = forkLine(session, app.sessions) ?? "from an earlier chat";
    return { id: session.forked_from.session, name: line.replace(/^from /, "") };
  });

  // ---- Ask aside about a highlighted passage (nightshift backlog 107) ----
  //
  // Select words in a reply or in one of his messages and a small pill
  // floats over the selection: *Ask aside*. ~~It opens the aside card
  // (backlog 081) at the foot as a question box with the passage quoted
  // above it~~ — since backlog 141 (2026-09-17, blocker 162 answered) it
  // marks the passage in place and opens the floating card
  // (`AsideCard.svelte`) right under it, inside this scrolled column, so
  // the view does not move and the passage is not quoted twice; what he
  // types is sent with the passage, framed as a
  // selection (`asideQuote.ts`), through the same backend — off the warm
  // cache, recorded nowhere. A passage is a selection whose both ends sit
  // in the same prose block (`.markdown` for a reply, `.user-text` for his
  // message) of the same live turn: thinking, tool results, a subagent's
  // text and anything spanning two messages get no pill. Claude Code
  // engine and an idle chat only, as the composer's own Ask aside is.
  //
  // The pill is `position: fixed` at the selection rectangle's top edge,
  // re-measured on the document's `selectionchange` and on this scroll,
  // and its mousedown is swallowed so the click does not collapse the
  // selection it is about. ⌘⇧A (Ctrl+Shift+A elsewhere) is the same click
  // from the keyboard, inert without a qualifying selection; the chord
  // was free (no KeyA in `App.svelte`'s tables, no such accelerator in
  // the native menu — grepped 2026-09-16).
  const PILL_HEIGHT = 30;
  let asidePill = $state<{ quote: AsideQuote; top: number; left: number } | null>(null);
  // ~~A turn starting, or the engine changing, takes the pill down without
  // waiting for the next selection change.~~ Since backlog 215
  // (2026-09-25) the pill also carries *Reply*, which works on any engine
  // and mid-turn (the composer queues), so the pill stays; only its Ask
  // aside half needs the Claude Code engine and an idle chat.
  const canAsk = $derived(onClaudeCode && !locked);

  // Per turn index, the message's 1-based place among the live messages
  // of its kind — "your 3rd reply" in the framing. Rewound and removed
  // messages do not count: the CLI's history no longer has them. A reply
  // is counted as drawn (backlog 121): a run of the model's messages with
  // nothing between them is one reply to him, so it is one here too.
  const ordinals = $derived.by(() => {
    const out: Record<number, number> = {};
    let user = 0;
    let assistant = 0;
    items.forEach((it, i) => {
      if (it.superseded || it.removed || it.kind === "compaction") return;
      if (it.kind === "user") out[it.index] = ++user;
      else out[it.index] = continued[i] ? assistant : ++assistant;
    });
    return out;
  });

  function proseEnd(node: Node | null): { turn: number; prose: Element; role: "assistant" | "user" } | null {
    if (!node || !viewport) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const prose = el?.closest(".markdown, .user-text") ?? null;
    if (!prose || !viewport.contains(prose)) return null;
    // Item 481: an aside card's thread has its own Reply (`AsideThread`).
    if (prose.closest(".aside-thread")) return null;
    const turnEl = prose.closest<HTMLElement>("[data-turn]");
    if (!turnEl) return null;
    const turn = Number(turnEl.dataset.turn);
    if (!Number.isFinite(turn)) return null;
    return { turn, prose, role: prose.classList.contains("user-text") ? "user" : "assistant" };
  }

  /** The selection as a passage, or null when it is not one. */
  function passageOf(
    sel: Selection | null,
  ): { quote: AsideQuote; range: Range; turn: number; prose: Element } | null {
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const a = proseEnd(sel.anchorNode);
    const b = proseEnd(sel.focusNode);
    if (!samePassage(a, b) || !a) return null;
    const item = items.find((it) => it.index === a.turn);
    if (!item || item.superseded || item.removed || item.kind === "compaction") return null;
    // Not `sel.toString()`: a rendered equation reads as its layout, and
    // the model would get that (his report, 2026-09-17); `selectionText`
    // quotes each equation as its `$…$` source instead.
    const text = selectionText(sel.getRangeAt(0));
    if (!text) return null;
    return { quote: { text, role: a.role, ordinal: ordinals[a.turn] ?? 1 }, range: sel.getRangeAt(0), turn: a.turn, prose: a.prose };
  }

  /** The prose blocks of a turn, in document order — a reply has one
   *  `.markdown` per text segment between its tool calls. */
  function proseBlocks(turn: number): Element[] {
    if (!viewport) return [];
    return Array.from(viewport.querySelectorAll(`[data-turn="${turn}"] .markdown, [data-turn="${turn}"] .user-text`));
  }

  /** Where the passage is, as the card remembers it (backlog 141): the
   *  turn, the prose block's index, character offsets into its text, and
   *  the side the card opens on — chosen once from the room around the
   *  selection, so a growing answer never flips the card over the text. */
  function anchorOf(p: { range: Range; turn: number; prose: Element }): AsideAnchor | null {
    if (!viewport) return null;
    const block = proseBlocks(p.turn).indexOf(p.prose);
    if (block < 0) return null;
    const { start, end } = offsetsOf(p.prose, p.range);
    if (end <= start) return null;
    const side = chooseSide(p.range.getBoundingClientRect(), viewport.getBoundingClientRect(), PREFERRED_CARD_HEIGHT);
    return { turn: p.turn, block, start, end, side };
  }

  function placePill() {
    // A pane offers no Ask aside or Reply (piece 5): the click opens it.
    if (!viewport || inPane) {
      asidePill = null;
      return;
    }
    const p = passageOf(document.getSelection());
    if (!p) {
      asidePill = null;
      return;
    }
    const r = p.range.getBoundingClientRect();
    const vp = viewport.getBoundingClientRect();
    // No rectangle, or one scrolled wholly out of the viewport: no pill —
    // it would float over text it is not about.
    if ((r.width === 0 && r.height === 0) || r.bottom < vp.top || r.top > vp.bottom) {
      asidePill = null;
      return;
    }
    // Above the selection, or below it when the top is off the viewport
    // (then no lower than the viewport's foot); centred on it, kept
    // inside the viewport's width.
    const above = r.top - PILL_HEIGHT - 4 >= vp.top;
    const top = above
      ? r.top - PILL_HEIGHT - 4
      : Math.max(vp.top + 4, Math.min(r.bottom + 4, vp.bottom - PILL_HEIGHT - 4));
    // 110: half the pill's width with both of its buttons (backlog 215).
    const left = Math.min(Math.max(r.left + r.width / 2, vp.left + 110), vp.right - 110);
    asidePill = { quote: p.quote, top, left };
  }

  /** The anchor for the selection the pill is over, read at the click —
   *  the selection is still live then (the pill's mousedown keeps it). */
  function anchorOfSelection(): AsideAnchor | null {
    const p = passageOf(document.getSelection());
    return p ? anchorOf(p) : null;
  }

  /** ~~A new passage's question would replace an answered thread on the
   *  card (backlog 137, blocker 201): asked about first, in the dialog's
   *  shape.~~ Struck 2026-09-23 (backlog 176): several asides are open at
   *  once, so a new passage opens a new card and replaces nothing — there
   *  is nothing to confirm. */
  function askAboutSelection(): void {
    const pill = asidePill;
    if (!pill || !canAsk) return;
    const anchor = anchorOfSelection();
    document.getSelection()?.removeAllRanges();
    asidePill = null;
    // The card opens under the passage (or above the composer); the view
    // stays where it is and the caret goes to the new card's box
    // (`AsideLayer` focuses it once placed).
    draftAside(pill.quote, anchor);
  }

  /** Reply (backlog 215): the passage to the composer as a quote at its
   *  caret (`replyQuote.svelte.ts`; the composer inserts it). */
  function replyToSelection(): void {
    const pill = asidePill;
    if (!pill) return;
    document.getSelection()?.removeAllRanges();
    asidePill = null;
    requestReply(pill.quote.text);
  }

  function asideChord(e: KeyboardEvent): void {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (inPane || !primary || !e.shiftKey || e.altKey || e.code !== "KeyA") return;
    if (!asidePill || !canAsk) return;
    e.preventDefault();
    askAboutSelection();
  }

  // ~~`submitAsideDraft`, `asideBoxKeys`, the follow-up box~~ — the
  // card's own since backlog 141 (`AsideCard.svelte`); the question and
  // follow-up boxes, Enter, Escape and the Follow up button live there.

  // ---- The floating cards' places and the passages' marks ----
  //
  // ~~The card is drawn once, at the column's end~~ — since backlog 176
  // (2026-09-23) several cards are open at once, and `AsideLayer.svelte`
  // draws them all, at the column's end as the one card was (`.inner`,
  // `position: relative`, is their frame): per card, the passage found
  // again from its anchor and marked, the card placed with `placeCard`,
  // `spreadCards` keeping one from covering another (blocker 318), the
  // composer's cards stacked above the composer (blocker 225). What it
  // needs from here: the viewport, the column, and `proseBlocks`.
  let inner = $state<HTMLDivElement | null>(null);
</script>

<svelte:document onselectionchange={placePill} />
<svelte:window onkeydown={asideChord} />
{#if removing}
  <!-- Item 356: Remove asks first, and the undo toast still follows it. -->
  {@const ask = removeAsk(removing.kind, removing.text, onClaudeCode)}
  <ConfirmDialog
    title={ask.title}
    lead={ask.lead}
    facts={ask.facts}
    confirmLabel={ask.confirmLabel}
    onconfirm={() => {
      const asked = removing;
      removing = null;
      if (asked && asked.key === sessionKey) void removeHere(asked.index);
    }}
    onclose={() => (removing = null)}
  />
{/if}
{#if dropAsk}
  <!-- Practices §7 (item 336): a changed edit — words or chips — is not
       dropped on one key or one click elsewhere; Keep editing is the default. -->
  <ConfirmDialog
    title="Discard this edit?"
    lead={dropAsk.what === "open"
      ? "Another message's editor is open with changes; opening this one drops them."
      : "The changed text and attachments in the edit box are dropped; the message stays as it was."}
    confirmLabel="Discard edit"
    onconfirm={() => {
      const run = dropAsk?.run;
      dropAsk = null;
      run?.();
    }}
    onclose={() => {
      dropAsk = null;
      void tick().then(() => (editorLive ? editorLive.focus() : editorEl?.focus({ preventScroll: true })));
    }}
  />
{/if}

<!-- The viewport takes ⌥↑ / ⌥↓ (backlog 065); it is a scroll region, not
     a control, and the lint has no role for that. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="transcript"
  bind:this={viewport}
  data-drop-chat={inPane ? undefined : ""}
  {onscroll}
  use:scrollIntent
  tabindex="-1"
  onkeydown={viewportKeys}
>
  <div class="inner" bind:this={inner}>
    {#if continuedFrom}
      <div class="continued">
        <span class="continued-ic"><Icon name="branch" size={14} /></span>
        <span>Continued from <span class="continued-t">“{continuedFrom.name}”</span> · <span class="mono">HANDOFF.md</span></span>
        <span class="spacer"></span>
        <button class="continued-open" onclick={() => void openSession(continuedFrom.id)}>open the earlier chat</button>
      </div>
    {/if}
    {#each items as item, i (i)}
      {#if item.superseded}
        {#if rewound[i] !== null}
          <div
            class="rewound"
            use:tip={"Rewound — not part of the conversation any more. Undo (or ⌘Z) brings it back while nothing newer is on the stack."}
          >
            {rewound[i] === 1 ? "1 message rewound" : `${rewound[i]} messages rewound`}
          </div>
        {/if}
      {:else if item.kind === "user"}
        <div
          class="user-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          use:arrive={{ channel: "chat", active: item.index >= enterFrom, bubble: ".user-bubble", riseWithout: true }}
          data-turn={item.index}
        >
          <div class="user-key">
            <!-- The tools sit under the bubble (his 2026-09-15 evening
                 review: "these buttons should be below, and should be
                 icons"); see `.turn-tools` below. -->
            {#if item.original !== null && !item.removed}
              <button
                class="edited-mark"
                class:on={!!diffOpen[item.index]}
                type="button"
                aria-pressed={!!diffOpen[item.index]}
                use:tip={diffOpen[item.index] ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                onclick={(e) => toggleDiff(item.index, e.currentTarget)}>edited</button
              >
            {/if}
            <!-- The time moved to the foot (backlog 123): one place is
                 enough, and his ask was the foot. -->
            <span class="ns-k">You</span>
            <!-- The turn's own size (backlog 090) moved to the foot on
                 2026-09-27 (backlog 245): under his message, as a reply's
                 figure is under the reply. -->
          </div>
          {#if editing?.index === item.index}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="editor" data-drop-box="edit" ondragover={editorDragOver} ondrop={editorDrop}>
              <!-- Item 399: the composer's box, drawn as the composer draws
                   it — with the format toggle on, its formatted box; off,
                   the textarea with quote and code lines drawn in a layer
                   behind it (BoxLayer). -->
              {#if composerFormat.on}
                <div class="edit-live">
                  <LiveBox
                    bind:handle={editorLive}
                    value={editing.draft}
                    label="Edit this message"
                    onchange={(v) => {
                      if (editing && !editing.parts) editing = editReduce(editing, { type: "draft", text: v });
                    }}
                    oninput={() => (editPlaces[0] = placeOf(editorLive))}
                    onkeydown={(e) => editorKeys(e, item)}
                    onpaste={editorPaste}
                  />
                </div>
              {:else}
                <div class="edit-wrap">
                  {#if layerShown(editing.draft)}
                    <BoxLayer text={editing.draft} box={editorEl} onrelabel={editRelabel} />
                  {/if}
                  <!-- data-own-undo: its history is editHist's (item 421, fieldUndo.ts). -->
                  <textarea
                    bind:this={editorEl}
                    data-own-undo
                    class:layered={layerShown(editing.draft)}
                    use:grow
                    use:trackPlace={(pl) => (editPlaces[0] = pl)}
                    value={editing.draft}
                    oninput={(e) => {
                      const el = e.target as HTMLTextAreaElement;
                      editHist.input(editKind((e as unknown as InputEvent).inputType ?? ""), editSnap(el));
                      editing = editReduce(editing, { type: "draft", text: el.value });
                      autogrow();
                    }}
                    onbeforeinput={editBeforeInput}
                    oncompositionstart={() => (editComposing = true)}
                    oncompositionend={() => {
                      editComposing = false;
                      editHist.close();
                    }}
                    onkeydown={(e) => editorKeys(e, item)}
                    onpaste={editorPaste}
                    aria-label="Edit this message"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  ></textarea>
                </div>
              {/if}
              <!-- Item 399b: the composer's long-paste offer. -->
              <PasteOfferRow
                offer={editOffer}
                undoable={editUndoable()}
                onconvert={() => void editConvert()}
                ondismiss={() => (editOffer = null)}
                onundo={() => editUndoConvert()}
              />
              <!-- Item 336: the turn's attachments as chips, × to remove,
                   Attach (and paste, drop) to add. -->
              <EditAttachments key={editKey} />
              <div class="editor-line">{editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(editing, editChips).send}
                  use:tip={"Start a fork from here with this text as its next message; this chat stays as it is"}
                  onclick={() => void commitSend(item)}
                >
                  Send
                </button>
                <button
                  class="ns-btn ghost small"
                  disabled={!editButtons(editing, editChips).save}
                  use:tip={"Keep this chat, with this message reworded from here on"}
                  onclick={() => void commitSave()}
                >
                  Save
                </button>
                <button
                  class="ns-btn ghost small"
                  onclick={cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <!-- The bubble is `UserBubble` since backlog 283 — an aside's
                 questions are drawn by the same piece. The address of an
                 attachment is the event's index and its own; the bytes
                 stay in the log. -->
            {@const adoptedMsg = splitAdopted(item.text)}
            {@const diffShown = !!diffOpen[item.index] && item.original !== null && !item.removed}
            <UserBubble
              images={item.images}
              documents={item.documents}
              text={item.text}
              custom={diffShown || !!adoptedMsg.carried}
              onopenimage={(j, rect, size) => {
                if (!app.activeSessionId) return;
                openAttachment(
                  { kind: "attachment", session: app.activeSessionId, turn: item.index, index: j, media: "image", name: "image" },
                  rect,
                  size,
                );
              }}
              onopendoc={(j, rect) => {
                if (!app.activeSessionId) return;
                const doc = item.documents[j];
                if (!doc) return;
                openAttachment(
                  { kind: "attachment", session: app.activeSessionId, turn: item.index, index: j, media: "document", name: doc.name },
                  rect,
                );
              }}
            >
              {#snippet body()}
                {#if diffShown && item.original !== null}
                  <!-- The edit as a diff over the current text (backlog 105):
                       the bubble's own face, the code diff view's colours. -->
                  <div class="user-text textdiff">
                    {#each wordDiff(item.original, item.text) as op, k (k)}
                      {#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}
                    {/each}
                  </div>
                {:else if adoptedMsg.carried}
                  <!-- An adopted agent's run (backlog 157): what this chat
                       was given, folded; his question below it. -->
                  <details class="adopted-carry">
                    <summary>Carried from agent “{adoptedMsg.agent ?? "subagent"}” — its task and run, which this chat answers from</summary>
                    <pre>{adoptedMsg.carried}</pre>
                  </details>
                  {#if adoptedMsg.said}<div class="user-text">{adoptedMsg.said}</div>{/if}
                {/if}
              {/snippet}
              {#snippet extra()}
                {#if !item.removed}
                  {@const council = councilOfTurn(evs, item.index)}
                  {#if council}
                    <!-- The council chip (nightshift backlog 149): this
                         message went to the seats the reply's record names. -->
                    <span
                      class="ns-chip mono council-chip"
                      use:tip={`Sent to a council of ${council.seats.length}: ${rosterLabel(council.seats)} · ${council.mode} pass`}
                      >council · {council.seats.length}</span
                    >
                  {/if}
                {/if}
              {/snippet}
            </UserBubble>
            {#if item.original !== null && item.removed}
              <details class="original">
                <summary>what was removed</summary>
                <div class="original-text">{item.original}</div>
              </details>
            {/if}
          {/if}
          <!-- The foot (backlog 123): the hover tools, then when the message
               was sent, in words, the exact moment on hover. The time is
               always drawn; the tools only when the turn can be acted on. -->
          <div class="turn-foot">
            {#if chatId && editing?.index !== item.index}
              {@const vlist = versionsOf(chatId, item.index)}
              {@const vplace = versionPlace(vlist, chatId)}
              {#if vlist && vplace}
                <!-- The versions of this message (item 299): ‹ n/N ›, the
                     original first; an arrow opens that version's chat in
                     this tab. Always drawn, not only on hover. -->
                <span class="versions" role="group" aria-label="Versions of this message">
                  <button
                    class="ver-btn"
                    disabled={vplace.n <= 1 || inPane}
                    aria-label="Previous version"
                    use:tip={"Open the previous version of this message"}
                    onclick={() => openVersion(vlist[vplace.n - 2])}>‹</button
                  >
                  <span class="ver-count">{vplace.n}/{vplace.total}</span>
                  <button
                    class="ver-btn"
                    disabled={vplace.n >= vplace.total || inPane}
                    aria-label="Next version"
                    use:tip={"Open the next version of this message"}
                    onclick={() => openVersion(vlist[vplace.n])}>›</button
                  >
                </span>
              {/if}
            {/if}
            {#if item.text && editing?.index !== item.index}
              <!-- Copy his own message (nightshift backlog 181, 2026-09-22):
                   the text exactly as he typed it, never the rendered or
                   diffed face. Shown during a turn and on a superseded or
                   removed message too — copying changes nothing. -->
              <span class="turn-tools">
                <button
                  class="tool-btn"
                  class:copied={copiedTurn === item.index}
                  use:tip={copiedTurn === item.index ? "Copied" : "Copy this message"}
                  aria-label={copiedTurn === item.index ? "Copied" : "Copy this message"}
                  onclick={() => void copyUserText(item.index, item.text)}
                >
                  <Icon name={copiedTurn === item.index ? "check" : "copy"} size={14} />
                </button>
              </span>
            {/if}
            {#if !item.superseded && !locked && editing?.index !== item.index}
              <!-- Offered on both engines since 2026-09-15 (backlog 062): on
                   Claude Code each of these rewrites the CLI's history by copy
                   and the next turn resumes the copy — the title says so.
                   Icons, with the full sentence on hover and for a reader. -->
              <span class="turn-tools" use:tip={controlsTitle}>
                {#if item.removed}
                  <!-- Restore on the placeholder itself (backlog 066): the
                       same restore an undo of the removal runs. -->
                  <button
                    class="tool-btn"
                    use:tip={"Restore to the context"}
                    aria-label="Restore to the context"
                    onclick={() => void restoreTurn(item.index)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                {:else}
                  <button
                    class="tool-btn"
                    use:tip={rewindTitle}
                    aria-label="Rewind to here"
                    onclick={() => void rewindHere(item.index)}
                  >
                    <Icon name="revert" size={14} />
                  </button>
                  {#if redo && redo.prompt === item.index && app.activeSessionId}
                    <!-- Redo (item 439): Claude answers this message again,
                         no retyping — the Retry under the reply (item 333),
                         here beside Rewind. The old reply stays a version
                         away; a half-typed draft follows him. -->
                    <button
                      class="tool-btn"
                      use:tip={"Redo: Claude answers this message again, without retyping it. The old reply stays — ‹ › under your message flips between the two."}
                      aria-label="Redo the reply to this message"
                      onclick={() => void retryReply(redo.reply)}
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  {/if}
                  {#if item.editable}
                    <button
                      class="tool-btn"
                      use:tip={"Edit this message: Save keeps it here with the new text; Send starts a fork from here."}
                      aria-label="Edit this message"
                      onclick={() => beginEdit(item)}
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                  {/if}
                  <!-- A delete look, apart from Edit's pencil (item 356). -->
                  <button
                    class="tool-btn danger"
                    use:tip={removeTip("message")}
                    aria-label="Remove this message from the chat history"
                    onclick={() => (removing = { index: item.index, kind: "message", text: item.text, key: sessionKey })}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                  {#if app.connection?.engine === "claude-code" && checkpointOwner(userIndexes, app.checkpoint) !== item.index}
                    <!-- "Fork from here" (nightshift backlog 104, pass 3):
                         helpers fork from the end of this exchange — this
                         message and its reply — instead of the first one. -->
                    <button
                      class="tool-btn"
                      use:tip={"Fork helpers from here: a long-research helper starts with the chat up to the end of this exchange, at cache-read cost, and none of the later turns."}
                      aria-label="Fork helpers from here"
                      onclick={() => void setCheckpoint(item.index)}
                    >
                      <Icon name="branch" size={14} />
                    </button>
                  {/if}
                {/if}
              </span>
            {/if}
            {#if !inPane && app.checkpoint && checkpointOwner(userIndexes, app.checkpoint) === item.index}
              <!-- The checkpoint's marker (backlog 104): on the exchange
                   helpers fork from, always drawn, not only on hover. -->
              <span class="checkpoint-mark" use:tip={checkpointLine(app.checkpoint, true)}>
                <Icon name="branch" size={12} />
                {checkpointLine(app.checkpoint, false)}
              </span>
            {/if}
            {#if editing?.index !== item.index && !item.superseded && !item.removed}
              <!-- His message's figure (backlog 245), in the reply footer's
                   mono 11px beside the time: the log's exact figure with
                   its share of the window (backlog 090), or the text's
                   estimate, marked ~, where the log cannot say. -->
              {@const fig = userFigure(sizes[item.index], item.text, windowLimit)}
              {#if fig}
                {@const share = fig.exact ? shareOf(fig.tokens, windowLimit) : null}
                <span class="turn-size" use:tip={fig.title}>
                  {fig.label}
                  {#if fmtShare(share)}
                    <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
                    <span class="share-pct">{fmtShare(share)}</span>
                  {/if}
                </span>
              {/if}
            {/if}
            <span class="when" use:tip={exactTime(item.at)}>{relativeTimeLong(item.at, now)}</span>
          </div>
        </div>
      {:else if item.kind === "compaction"}
        <details class="compaction" class:superseded={item.superseded}>
          <summary>conversation compacted — earlier turns replaced by a summary</summary>
          <div class="compaction-body">{item.summary}</div>
        </details>
      {:else}
        <div
          class="assistant-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          class:run-cont={continued[i]}
          data-turn={item.index}
        >
          {#if editing?.index === item.index}
            <!-- The reply's text blocks as textareas in order, each tool
                 call between them a fixed marker (backlog 066): the text
                 around a call is edited, the call is not. A block's text
                 deleted entirely removes that block on Save. -->
            <div class="editor">
              {#each editing.parts ?? [] as part, p (part.block)}
                {#if part.kind === "text"}
                  <textarea
                    bind:this={editorEls[p]}
                    use:grow
                    use:trackPlace={(pl) => (editPlaces[p + 1] = pl)}
                    value={part.draft}
                    oninput={(e) => {
                      const el = e.target as HTMLTextAreaElement;
                      editing = editReduce(editing, { type: "draft", text: el.value, block: part.block });
                      autogrow(el);
                    }}
                    onkeydown={(e) => editorKeys(e, item)}
                    aria-label="Edit this part of the reply"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  ></textarea>
                {:else}
                  <div class="editor-marker" use:tip={"A tool call stays where it is; remove it from its own hover"}>{part.label}</div>
                {/if}
              {/each}
              <div class="editor-line">{editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(editing).save}
                  use:tip={"Keep this chat, with this reply reworded from here on"}
                  onclick={() => void commitSave()}
                >
                  Save
                </button>
                <button
                  class="ns-btn ghost small"
                  onclick={cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            {@const editable = !item.superseded && !locked && !item.removed}
            <!-- The reply's own Edit and Remove ride its footer row since
                 backlog 121 (they were a row of their own below); Restore
                 for a removed reply stays a row under the placeholder. -->
            <AssistantMessage
              segs={item.segs}
              footer={item.footer}
              size={sizes[item.index]}
              limit={windowLimit}
              {controlsTitle}
              onremove={editable ? (block) => void removeBlock(item.index, block) : null}
              onrestore={editable ? (block) => void restoreBlock(item.index, block) : null}
              originals={item.originals ?? null}
              diff={!!diffOpen[item.index]}
              clock={now}
              headed={!continued[i]}
              onedit={editable && item.editable ? () => beginEdit(item) : null}
              onremoveturn={editable
                ? () => (removing = { index: item.index, kind: "reply", text: textOf(item.segs), key: sessionKey })
                : null}
              planUsage={replyUsageView(usageLines.get(item.index))}
              onretry={editable && turnEnds[i] && app.activeSessionId ? () => void retryReply(item.index) : null}
              {cliSession}
            />
            {#if item.original !== null && item.removed}
              <details class="original">
                <summary>what was removed</summary>
                <div class="original-text">{item.original}</div>
              </details>
            {:else if item.original !== null}
              <div class="edited-row">
                <button
                  class="edited-mark"
                  class:on={!!diffOpen[item.index]}
                  type="button"
                  aria-pressed={!!diffOpen[item.index]}
                  use:tip={diffOpen[item.index] ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                  onclick={(e) => toggleDiff(item.index, e.currentTarget)}>edited</button
                >
              </div>
            {/if}
          {/if}
          {#if !item.superseded && !locked && item.removed}
            <span class="turn-tools assistant-tools" use:tip={controlsTitle}>
              <button
                class="tool-btn"
                use:tip={"Restore to the context"}
                aria-label="Restore to the context"
                onclick={() => void restoreTurn(item.index)}
              >
                <Icon name="refresh" size={14} />
              </button>
            </span>
          {/if}
        </div>
      {/if}
    {/each}
    <!-- The aside (nightshift backlog 081): a side question answered off the
         chat's warm cache and recorded nowhere — not in this log, not in
         the CLI's files. ~~Drawn at the foot, dashed, so it never reads as
         a turn~~ — since backlog 141 (2026-09-17) it is the floating card
         at the column's end below (`AsideCard.svelte`), placed under the
         marked passage, or pinned above the composer when there is no
         passage (blocker 225); its × is the only way it leaves, short of a
         chat switch. ~~About a passage (backlog 107): the highlighted text
         sits above the question as a quote~~ — the passage is marked in
         the transcript instead and not quoted again. Since backlog 128 the
         card reads as a turn does: his question in his bubble's face, the
         moon while nothing has arrived, the answer streaming in under it
         in the reply's face; × mid-stream stops it and keeps what had
         arrived, marked. The card hides while the thread is showing in a
         tab of its own (`asideInTab`, backlog 130 part 2), and its head
         row drags — onto a strip or a pane's half — to make that tab. The
         thread never moves. -->
    <!-- ~~The replace confirm (blocker 201)~~ — struck 2026-09-23,
         backlog 176: a new passage opens a new card beside the others. -->
    <!-- `shown` is the live turn, or its ghost for the moment between the
         turn's end and the re-synced log (backlog 131), so the reply never
         leaves the DOM under a reader. -->
    {#if shown}
      <!-- Item 359: the live reply's anchor for its rib on the rail. One
           flex item, as the reply alone was; nothing styles it. -->
      <div data-nav-live>
      {#if shown.segments.length === 0}
        <!-- Between send and the first streamed event there is nothing to
             render, and a blank row read as "nothing happened" (his words,
             backlog 049). So something moves: the moon rolls a short way
             and back until the first delta or tool call replaces it; with
             the OS asked for less motion it is three still dots. It says
             nothing about progress, because it can see none. -->
        <!-- Since item 403 the one piece the chat and its asides wait with. -->
        <WaitingMoon />
      {:else}
        <AssistantMessage
          segs={shown.segments}
          streaming
          since={shown.since}
          approvals={approvalsNow}
          {cliSession}
        />
      {/if}
      </div>
    {/if}
    <!-- Item 465: messages he sent while this turn runs, not yet taken —
         greyed bubbles with Send now / Let it arrive / Edit / Cancel. -->
    {#if !inPane}<PendingBubbles />{/if}
    {#each stranded as req (req.id)}
      <ApprovalPrompt {req} />
    {/each}
    <!-- A call held at the 85% stop line for his answer (nightshift
         backlog 189): ~~only in the chat the turn runs in~~ — since 192 in
         the chat on screen whichever it is, naming the running chat when
         that is another (review 2026-09-23 finding 3), while it runs. -->
    {#if !inPane && app.busy && app.budgetSession && app.turnBudget?.pending_since_ms}
      <BudgetStopCard
        session={app.budgetSession}
        elsewhere={app.parked && app.activeSessionId !== app.budgetSession ? runningChatName() : null}
      />
    {/if}
    {#if !inPane && app.error}
      <div class="error-banner">{app.error}</div>
    {/if}
    <!-- The files the rewound turns wrote (item 259): the next run would
         read them as real. Ticked ones move to a dated folder outside the
         project, never deleted; Keep leaves them all. -->
    {#if !inPane && app.rewoundWrites && app.rewoundWrites.session === app.activeSessionId}
      {@const rw = app.rewoundWrites}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">rewound turn wrote {rw.files.length === 1 ? "1 file" : `${rw.files.length} files`}</span>
          <span class="limit-sub">still on disk — the next run reads them as real</span>
        </div>
        {#if rw.done === null}
          <div class="aside-files">
            {#each rw.files as f (f.path)}
              <label class="aside-file">
                <input
                  type="checkbox"
                  checked={asideTicked(f.path, f.how)}
                  onchange={(e) => (asideTicks[f.path] = (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="mono">{f.path}</span>
                <span class="limit-sub">{HOW_LABEL[f.how] ?? f.how}</span>
              </label>
            {/each}
          </div>
          <div class="limit-actions">
            <button
              class="ns-btn accent small"
              disabled={asidePaths.length === 0}
              use:tip={"Move the ticked files to a dated folder outside the project (~/.nightloom/rewound); nothing is deleted"}
              onclick={() => void setAsideRewound(asidePaths)}
            >Set aside {asidePaths.length === 1 ? "1 file" : `${asidePaths.length} files`}</button>
            <button class="ns-btn ghost small" onclick={keepRewound}>Keep them</button>
          </div>
        {:else}
          <div class="limit-text">{rw.done}</div>
          <div class="limit-actions">
            <button class="ns-btn ghost small" onclick={keepRewound}>Done</button>
          </div>
        {/if}
      </div>
    {/if}
    <!-- Not connected, and why (item 261): a failed connect used to leave
         every chat saying "not connected" with nothing to press but a
         relaunch. One Retry connects again with the rail as it is. -->
    {#if !inPane && !app.connection && app.connectError && !app.connecting}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">not connected</span>
        </div>
        <div class="limit-text">{app.connectError}</div>
        <div class="limit-actions">
          <button class="ns-btn accent small" use:tip={"Connect again with the rail's settings"} onclick={() => void retryConnect()}>Retry</button>
        </div>
      </div>
    {/if}
    <!-- A turn paused by the usage limit (nightshift backlog 164): not
         failed — the mark says when the window opens, and one Resume
         continues the turn then (scheduled if pressed early, never into
         an exhausted window), naming the subagents that died so they are
         resumed rather than relaunched. -->
    {#if !inPane && app.limitPause && app.limitPause.session === app.activeSessionId && !app.busy}
      {@const pause = app.limitPause}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">{pauseLabel(pause)}</span>
          {#if pause.agents.length > 0}
            <span class="limit-sub" use:tip={pause.agents.map((a) => a.description || a.agent_id || a.tool_use_id).join(" · ")}>{pause.agents.length === 1 ? "one subagent" : `${pause.agents.length} subagents`} stopped before returning · resumed, not relaunched</span>
          {/if}
        </div>
        <div class="limit-text">{pause.text}</div>
        <div class="limit-actions">
          {#if app.limitResumeAt !== null}
            <span class="limit-sub">will resume at {resetLabel({ resetsAtMs: app.limitResumeAt })}</span>
            <button class="ns-btn ghost small" onclick={resumeAfterLimit}>Cancel</button>
          {:else}
            <button class="ns-btn accent small" disabled={!app.connection} use:tip={resumeDelayMs(pause) === 0 ? "Continue the turn now" : `Continue the turn when the window resets, at ${resetLabel(pause)}`} onclick={resumeAfterLimit}>
              {resumeDelayMs(pause) === 0 ? "Resume" : `Resume at ${resetLabel(pause)}`}
            </button>
          {/if}
        </div>
      </div>
    {/if}
    <!-- The floating aside cards (backlog 141; several since 176): the
         column's last children, absolute under their passages, stuck
         above the composer when there is none. -->
    {#if !inPane}
      <AsideLayer {viewport} {inner} {proseBlocks} version={items.length} />
    {/if}
  </div>
</div>
{#if showNav}
  <Navigator
    ticks={navTicks}
    active={navActive}
    {viewport}
    onjump={jumpTo}
    ontop={toTop}
    onend={(instant) => {
      // The rail's terminus: the foot, re-pinned, as the ⌄ above the
      // composer does; a drag past the rail's end lands there at once.
      if (instant && viewport) {
        cancelScroll();
        pinned = true;
        viewport.scrollTop = viewport.scrollHeight;
        return;
      }
      toBottom();
    }}
  />
{/if}
<!-- The jump to the latest message (item 218): round, centred just above
     the composer where the Claude app keeps it, faded in only when the
     view is scrolled up. It replaces the strip's small bottom chevron.
     While a reply is still coming (item 304) it shows three dots throbbing
     out of step, like a voice, which gather into the ⌄ on hover or focus
     and settle into it when the reply ends; still dots with less motion. -->
<button
  class="jump-down"
  class:shown={jumpDown}
  class:speaking
  use:tip={speaking ? "The reply is still coming — jump to it and follow along" : "Jump to the latest message — and follow the reply again"}
  aria-label={speaking ? "Jump to the latest message; the reply is still coming" : "Jump to the latest message"}
  aria-hidden={!jumpDown}
  tabindex={jumpDown ? 0 : -1}
  onclick={toBottom}
>
  <span class="jd-dots" aria-hidden="true"><i><b></b></i><i><b></b></i><i><b></b></i></span>
  <!-- A chevron drawn for this button: the shared `chev` spans 6 of its 20
       units and read as a speck at this size. -->
  <svg class="ns-ico jd-arrow" viewBox="0 0 20 20" aria-hidden="true" style:width="18px" style:height="18px"
    ><path d="m5 7.5 5 5 5-5" /></svg
  >
</button>
<!-- The Ask aside pill over a selection (backlog 107), with Reply beside
     it since backlog 215. Mousedown is swallowed on both so the click
     keeps the selection it is about. -->
{#if asidePill}
  <!-- One outline since item 223 (his ask: "part of the same view"),
       a thin divider between the two; Reply alone when asking aside is
       not offered (`pillParts`). -->
  <div class="aside-pill" style:top="{asidePill.top}px" style:left="{asidePill.left}px">
    {#each pillParts(canAsk) as part (part)}
      {#if part === "ask"}
        <button
          class="pill-btn"
          use:tip={"Ask aside about the highlighted passage: a side question on this text, answered from the chat's context, recorded nowhere"}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => void askAboutSelection()}
        >
          Ask aside <kbd class="aside-key">{isMac ? "⌘⇧A" : "Ctrl+Shift+A"}</kbd>
        </button>
      {:else if part === "divider"}
        <span class="pill-div" aria-hidden="true"></span>
      {:else}
        <button
          class="pill-btn"
          use:tip={"Reply: quote the highlighted passage in your message, at the cursor, and keep typing after it"}
          onmousedown={(e) => e.preventDefault()}
          onclick={replyToSelection}
        >
          Reply
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* Positioned by the parent's `.content` (the transcript's area, the
     composer right under it): centred on it, a little above its foot. */
  .jump-down {
    position: absolute;
    left: 50%;
    bottom: 14px;
    z-index: 5;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--ink2);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 6px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
  }
  .jump-down.shown {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0);
  }
  .jump-down:hover {
    color: var(--ink);
    background: var(--well);
  }
  /* Item 304: the speaking dots and the ⌄ share the button; one gives way
     to the other. On hover or focus the outer dots slide in and shrink
     while the ⌄ grows from their middle, so the dots read as becoming it. */
  .jd-arrow {
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  .jd-dots {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--accent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .jd-dots i {
    display: block;
    transition: transform 0.2s ease;
  }
  .jd-dots b {
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  /* At rest (and with less motion) the middle one is smaller, as in the
     Claude app's. */
  .jd-dots i:nth-child(2) b {
    transform: scale(0.7);
  }
  .jump-down.speaking .jd-dots {
    opacity: 1;
  }
  .jump-down.speaking .jd-arrow {
    opacity: 0;
    transform: translateY(-4px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots,
  .jump-down.speaking:focus-visible .jd-dots {
    opacity: 0;
  }
  .jump-down.speaking:hover .jd-dots i:first-child,
  .jump-down.speaking:focus-visible .jd-dots i:first-child {
    transform: translateX(8px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots i:last-child,
  .jump-down.speaking:focus-visible .jd-dots i:last-child {
    transform: translateX(-8px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots i:nth-child(2),
  .jump-down.speaking:focus-visible .jd-dots i:nth-child(2) {
    transform: translateY(4px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-arrow,
  .jump-down.speaking:focus-visible .jd-arrow {
    opacity: 1;
    transform: none;
  }
  /* The throb: each dot swells and shrinks on its own beat (three lengths,
     three offsets), so the three never line up into a wave the way typing
     dots do — it reads as a voice's level, not as text. Only while shown. */
  .jump-down.shown.speaking .jd-dots b {
    animation: jd-throb 0.84s ease-in-out infinite;
  }
  .jump-down.shown.speaking .jd-dots i:nth-child(2) b {
    animation-duration: 0.62s;
    animation-delay: -0.31s;
  }
  .jump-down.shown.speaking .jd-dots i:nth-child(3) b {
    animation-duration: 1.06s;
    animation-delay: -0.7s;
  }
  @keyframes jd-throb {
    0%,
    100% {
      transform: scale(0.55);
      opacity: 0.7;
    }
    50% {
      transform: scale(1.25);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .jump-down.shown.speaking .jd-dots b {
      animation: none;
    }
    .jd-arrow,
    .jd-dots,
    .jd-dots i {
      transition: none;
    }
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 28px 20px 20px;
    /* A message the keys or the strip jump to is not the one that stole
       the outline; the viewport is focused only so ⌥↑ / ⌥↓ reach it. */
    outline: none;
  }
  .inner {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 26px;
    /* Item 478: the turns' column, for a bubble drawn inside a reply (his
       mid-turn message) to reach the column's right edge, where his own
       messages sit. */
    container: turns / inline-size;
    /* The floating aside card (backlog 141) is placed in this frame. */
    position: relative;
  }
  /* The board's continued-from row: dashed, the branch mark, the earlier
     chat's name in the ink, a link to open it. */
  .continued {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    font-size: 13px;
    color: var(--ink2);
    background: color-mix(in srgb, var(--sheet) 50%, transparent);
  }
  .continued-ic {
    color: var(--dim);
    display: inline-flex;
  }
  .continued-t {
    color: var(--ink);
  }
  .continued .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .continued .spacer {
    flex: 1;
  }
  .continued-open {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12.5px;
    color: var(--accent-ink);
    cursor: pointer;
  }
  .continued-open:hover {
    text-decoration: underline;
  }
  .user-turn {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .user-key {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Dropped by a rewind: still shown, because the log still holds it and a
     hidden turn would make a rewind look like a delete. */
  .superseded {
    opacity: 0.38;
    filter: saturate(0.4);
  }
  /* Where rewound turns were (backlog 247, blocker 582): out of the way —
     small, faint, a hairline either side; the turns themselves are not
     drawn, so .superseded above no longer shows in the thread. */
  .rewound {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0;
    font-size: 11px;
    color: var(--dim);
    opacity: 0.55;
    user-select: none;
  }
  .rewound::before,
  .rewound::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--line2);
    opacity: 0.6;
  }
  /* The hover controls on a turn — Rewind, Edit, Remove — shown on both
     engines since 2026-09-15 (backlog 062). Under the bubble as a row of
     icons, the sentence on hover (his review that evening: "below, and
     icons"). Hidden until the turn is hovered or a control is focused; the
     row keeps its height so the transcript does not shift on hover. */
  .turn-tools {
    display: inline-flex;
    gap: 2px;
    height: 22px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .user-turn:hover .turn-tools,
  .assistant-turn:hover .turn-tools,
  .turn-tools:focus-within {
    opacity: 1;
  }
  .assistant-tools {
    align-self: flex-start;
  }
  /* The user message's foot (backlog 123): the hover tools and the time on
     one 22px row under the bubble's corner, so the transcript does not
     shift on hover. The time in the footer's dim 11px, the interface face. */
  .turn-foot {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 22px;
  }
  /* The versions of an edited message (item 299): ‹ n/N ›, the foot's
     dim 11px, the arrows the size of a tool button's glyph. */
  .versions {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .ver-btn {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 20px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .ver-btn:hover:not(:disabled),
  .ver-btn:focus-visible {
    color: var(--ink);
    border-color: var(--line2);
  }
  .ver-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .ver-count {
    min-width: 22px;
    text-align: center;
  }
  .when {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    cursor: default;
  }
  /* The checkpoint's marker (backlog 104): the foot's dim 11px, with the
     branch glyph, on the exchange helpers fork from. */
  .checkpoint-mark {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    cursor: default;
  }
  .tool-btn {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--dim);
    padding: 0;
    cursor: pointer;
  }
  .tool-btn:hover,
  .tool-btn:focus-visible {
    color: var(--ink);
    border-color: var(--line2);
  }
  /* Remove (item 356): red on hover, so it never reads as Edit. */
  .tool-btn.danger:hover,
  .tool-btn.danger:focus-visible {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 45%, transparent);
  }
  .assistant-turn {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* A continuation of the reply before it (backlog 121; `.continued` is
     the "Continued from" row above): pulled up through the list's 26px gap
     to the activity block's own 6px, so a run reads as one reply. */
  .assistant-turn.run-cont {
    margin-top: -20px;
  }
  .edited-mark {
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.5;
    color: var(--dim);
    background: transparent;
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 7px;
    cursor: pointer;
  }
  .edited-mark:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .edited-mark.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .edited-mark:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .edited-row {
    display: flex;
    max-width: 640px;
    padding: 2px 0 0;
  }
  /* The edit as a diff (backlog 105): the code diff view's colours on the
     message's own text, removed spans struck through. */
  .textdiff del {
    background: var(--del-bg);
    color: var(--del-fg);
    text-decoration: line-through;
    text-decoration-color: var(--del-fg);
    border-radius: 3px;
  }
  .textdiff ins {
    background: var(--add-bg);
    color: var(--add-fg);
    text-decoration: none;
    border-radius: 3px;
  }
  /* The turn's size (backlog 090), in the gauge's mono figure style, and
     the gauge's own 56px bar scaled to the turn's share of the window. */
  .turn-size {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .share-bar {
    display: inline-block;
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .share-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .share-pct {
    color: var(--dim);
  }
  /* Removed from the context: the placeholder, greyed like a superseded
     turn, with the original a click away. */
  .removed :global(.user-bubble),
  .removed :global(.assistant) {
    opacity: 0.45;
    font-style: italic;
  }
  .original {
    font-size: 0.78rem;
    color: var(--dim);
    max-width: 560px;
  }
  .original summary {
    cursor: pointer;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .original-text {
    margin-top: 0.3rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.6;
  }
  /* The in-place editor: the message's own width and face, the cache line
     from backlog 063 above the buttons. */
  .editor {
    width: 100%;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .assistant-turn .editor {
    max-width: 640px;
  }
  /* Item 399: the box's face is its wrap's, so the layer behind the
     textarea (BoxLayer) shows through it; the textarea's glyphs go
     transparent over the layer while it is drawn, its caret kept. */
  .edit-wrap {
    position: relative;
    background: var(--sheet);
    border-radius: 10px;
  }
  .edit-wrap textarea {
    position: relative;
    z-index: 1;
    display: block;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .edit-wrap textarea.layered {
    color: transparent;
    caret-color: var(--ink);
  }
  .edit-live {
    background: var(--sheet);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 8px 14px 6px 4px;
  }
  .edit-live :global(.cm-editor) {
    max-height: 420px;
    min-height: 3.2em;
    font-family: var(--transcript-font, var(--sans));
  }
  .editor textarea {
    width: 100%;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 14px;
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 1px);
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    min-height: 3.2em;
  }
  .editor textarea:focus {
    outline: none;
  }
  .editor-line {
    font-family: var(--sans);
    font-size: 11.5px;
    color: var(--dim);
  }
  /* A tool call inside the reply editor (backlog 066): greyed, in the
     tool line's face, not a field. */
  .editor-marker {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
    opacity: 0.7;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.3rem 0.6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor-row {
    display: flex;
    gap: 6px;
  }
  .council-chip {
    display: inline-block;
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--dim);
  }
  /* The bubble's own rules moved to `UserBubble.svelte` (backlog 283);
     the words drawn here (an edit's diff, an adopted run's) keep these. */
  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .adopted-carry {
    margin-bottom: 0.4rem;
    font-size: 12.5px;
  }
  .adopted-carry summary {
    cursor: pointer;
    opacity: 0.8;
  }
  .adopted-carry pre {
    margin: 0.4rem 0 0;
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .compaction {
    font-size: 0.78rem;
    color: var(--dim);
  }
  .compaction summary {
    cursor: pointer;
    text-align: center;
    list-style: none;
  }
  .compaction summary::before,
  .compaction summary::after {
    content: "—— ";
  }
  .compaction summary::after {
    content: " ——";
  }
  .compaction[open] summary {
    margin-bottom: 0.5rem;
  }
  .compaction-body {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* ~~The aside card (backlog 081): dashed, dim, outside the turns~~ — its
     rules moved to `AsideCard.svelte` with the card (backlog 141,
     2026-09-17). What stays here is the passage's mark: the CSS Custom
     Highlight API's pseudo-element, and the `<mark>` fallback for a
     webview without it — the accent at low alpha, not a literal yellow
     on a dark sheet. */
  :global(::highlight(aside-passage)) {
    background-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
  }
  :global(mark.aside-passage) {
    background-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  /* The pill is two buttons since backlog 215: Ask aside and Reply —
     one outline since item 223, a thin divider between them, no gap. */
  .aside-pill {
    position: fixed;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: stretch;
    gap: 0;
    white-space: nowrap;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--sheet);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--ink);
    font-size: 11.5px;
    font-family: var(--sans);
    line-height: 1.3;
    cursor: pointer;
  }
  .pill-btn:hover {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .pill-div {
    width: 1px;
    align-self: stretch;
    margin: 5px 0;
    background: var(--line2);
  }
  .aside-key {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--dim);
  }
  /* The waiting moon's styles moved to `WaitingMoon.svelte` with it
     (item 403), so an aside waits with the same one. */
  /* The limit card (backlog 164): a pause, drawn like a notice and not
     like the error banner above it. */
  .limit-card {
    border: 1px dashed var(--line);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .limit-head,
  .limit-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .limit-sub {
    color: var(--muted);
  }
  .limit-text {
    color: var(--muted);
    white-space: pre-wrap;
  }
  .aside-files {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .aside-file {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    word-break: break-all;
  }
  .error-banner {
    color: var(--failed);
    background: var(--failed-soft);
    border: 1px solid var(--failed);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
