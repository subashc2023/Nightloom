<script lang="ts">
  import { exactTime, relativeTimeLong } from "./time";
  import { tick, untrack } from "svelte";
  import {
    app,
    askAside,
    denialReason,
    dismissAside,
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
    openSession,
  } from "./state.svelte";
  import type { Segment, ToolCallView } from "./state.svelte";
  import {
    REMOVED_PLACEHOLDER,
    blockEdits,
    blockElisions,
    displayTexts,
    editButtons,
    editChanges,
    editLine,
    editParts,
    editReduce,
    editTexts,
    elideFlags,
    isEditable,
    type EditState,
  } from "./edit";
  import { toolInputSummary } from "./transcriptPrefs.svelte";
  import { forkLine } from "./edit";
  import { parseSubagentBlock } from "./subagent";
  import { wordDiff } from "./textdiff";
  import { continuedFlags } from "./runs";
  import { quoteLabel, samePassage, type AsideQuote } from "./asideQuote";
  import { isMac } from "./platform";
  import { fmtShare, fmtTokens, shareOf, sizeTitle, turnSizes } from "./tokens";
  import { cacheState } from "./cache";
  import { moveScroll, recallScroll, rememberScroll, scrollKey, NEW_SCROLL_KEY } from "./scroll.svelte";
  import { JUMP_OFFSET, MIN_TICKS, activeTick, stepTick, ticks as tickModel } from "./navigator";
  import type {
    ApprovalRequest,
    DocumentInput,
    ImageInput,
    Usage,
  } from "./types";
  import AssistantMessage from "./AssistantMessage.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import Icon from "./Icon.svelte";
  import Navigator from "./Navigator.svelte";

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
   * dropped. Superseded turns stay on screen, dimmed: the log keeps them so
   * you can see what you undid, and hiding them would make a rewind
   * indistinguishable from a delete.
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

  // Project SessionEvents into renderable items. tool_result events are
  // consumed by lookup against tool_use blocks and never rendered standalone.
  const items: Item[] = $derived.by(() => {
    const results = new Map<
      string,
      { content: string; is_error: boolean; denied: boolean }
    >();
    for (const e of app.events) {
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
    const live = liveFlags(app.events);
    const edited = editTexts(app.events);
    const removed = elideFlags(app.events);
    const edits = blockEdits(app.events);
    const gone = blockElisions(app.events);
    let index = -1;
    const push = (body: Body, original: string | null = null, originals?: (string | null)[]) =>
      out.push({
        ...body,
        index,
        superseded: !live[index],
        original,
        removed: removed[index],
        editable: isEditable(app.events, index),
        ...(originals ? { originals } : {}),
      });
    for (const e of app.events) {
      index++;
      if (e.event === "user_message") {
        // Sessions logged before attachments existed carry neither key.
        const text = edited[index];
        push(
          {
            kind: "user",
            text: removed[index] ? REMOVED_PLACEHOLDER : (text ?? e.text),
            images: removed[index] ? [] : (e.images ?? []),
            documents: removed[index] ? [] : (e.documents ?? []),
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
              const sub = parseSubagentBlock(b.text);
              if (sub && !whole) {
                const parent = findCallIn(segs, sub.parent) ?? findCallBack(out, sub.parent);
                if (parent) {
                  parent.children ??= [];
                  parent.children.push({ kind: "text", text: sub.body });
                  break;
                }
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

  /** The tool call with `id` in `segs`, at any depth. */
  function findCallIn(segs: Segment[], id: string): ToolCallView | null {
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      if (seg.kind !== "tool" && seg.kind !== "removed_tool") continue;
      if (seg.call.id === id) return seg.call;
      if (seg.call.children) {
        const inner = findCallIn(seg.call.children, id);
        if (inner) return inner;
      }
    }
    return null;
  }
  /** The same, searching back through the assistant messages already
   *  projected — a background subagent's block lands after its parent's
   *  message (backlog 075). */
  function findCallBack(items: Item[], id: string): ToolCallView | null {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") return null;
      if (it.kind === "assistant") {
        const call = findCallIn(it.segs, id);
        if (call) return call;
      }
    }
    return null;
  }

  /**
   * Prompts with no tool call to attach to — the live buffer is gone (an
   * error path) or the call streamed into a message that has already been
   * re-synced. They render standalone rather than not at all: an
   * unanswerable prompt parks the turn forever.
   */
  const stranded: ApprovalRequest[] = $derived.by(() => {
    const shown = new Set<string>();
    for (const seg of app.live?.segments ?? []) {
      if (seg.kind === "tool") shown.add(seg.call.id);
    }
    return app.pendingApprovals.filter((r) => !shown.has(r.id));
  });

  // What each turn added to the context (nightshift backlog 090): a
  // projection of the log's usage figures (`tokens.ts`), one entry per
  // event, null where nothing can be said; the share is against the
  // connected model's window, which the picker rows carry and the top-bar
  // gauge already scales by. Null window: the figure, no bar.
  const sizes = $derived(turnSizes(app.events, liveFlags(app.events)));
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

  // When the live turn was sent, for its `working · 41 s` row (backlog
  // 096): both send paths push the optimistic `user_message` just before
  // `app.live`, so the newest one's `at` is the turn's start. Null when
  // nothing is live, or when the log has no such message (a turn started
  // some other way); the message then counts from its own mount.
  const liveSince: number | null = $derived.by(() => {
    if (!app.live) return null;
    for (let i = app.events.length - 1; i >= 0; i--) {
      const e = app.events[i];
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
  let editorEl = $state<HTMLTextAreaElement | null>(null);
  // A reply's editor is one textarea per text block (backlog 066); the
  // first takes the focus and each grows to its own text.
  let editorEls = $state<(HTMLTextAreaElement | null)[]>([]);
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

  function beginEdit(item: Item) {
    const text = item.kind === "user" ? item.text : item.kind === "assistant" ? textOf(item.segs) : "";
    const parts =
      item.kind === "assistant"
        ? editParts(app.events, item.index, (b) => `${b.name} ${toolInputSummary(b.input)}`.trim())
        : undefined;
    void keepPlace(item.index, () => {
      editing = editReduce(editing, { type: "begin", index: item.index, text, parts });
      editCacheLine = editLine(cacheState(app.events, Date.now()));
    }).then(() => {
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
  function cancelEdit(): void {
    if (!editing) return;
    void keepPlace(editing.index, () => {
      editing = editReduce(editing, { type: "cancel" });
    });
  }
  async function commitSave() {
    if (!editing || !editButtons(editing).save) return;
    const { index, draft, parts } = editing;
    const changes = editChanges(editing);
    await keepPlace(index, async () => {
      const ok = parts ? await saveReplyEdit(index, changes) : await saveEdit(index, draft);
      if (ok) editing = editReduce(editing, { type: "done" });
    });
  }
  async function commitSend(item: Item) {
    if (!editing || !editButtons(editing).send || item.kind !== "user") return;
    const { index, draft } = editing;
    await keepPlace(index, () => {
      editing = editReduce(editing, { type: "done" });
    });
    await sendEdit(index, draft, item.images, item.documents);
  }
  function editorKeys(e: KeyboardEvent, item: Item) {
    // Enter is a newline here — an edit is usually to a long paste — and
    // the modifier sends or saves: ⌘/Ctrl-Enter saves in place, ⌘/Ctrl-
    // Shift-Enter sends into a fork, Escape cancels.
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) void commitSend(item);
      else void commitSave();
    }
  }
  $effect(() => {
    if (app.busy) editing = editReduce(editing, { type: "busy" });
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
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0) pinned = false;
    };
    const key = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) pinned = false;
    };
    const touchstart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const touchmove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY) pinned = false;
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
    if (!scrollingSelf) {
      // A scrollbar drag has no wheel event; it unpins here on its way up
      // and re-pins here on its way back down. Reaching the foot by any
      // means re-pins.
      pinned = atBottom();
    }
    scheduleScrollWork();
    // The Ask aside pill is fixed to the selection's rectangle, which a
    // scroll moves — into the viewport as well as out of it (backlog 107).
    if (asidePill || document.getSelection()?.isCollapsed === false) placePill();
  }

  $effect(() => {
    void app.events.length;
    void app.liveVersion;
    void app.pendingApprovals.length;
    void tick().then(() => {
      if (pinned && viewport) {
        scrollingSelf = true;
        viewport.scrollTop = viewport.scrollHeight;
        // The scroll event fires asynchronously; clear after it has.
        requestAnimationFrame(() => (scrollingSelf = false));
      }
      measureNav();
    });
  });

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
  const sessionKey = $derived(scrollKey(app.activeSessionId));
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
  // as it did by accident before, and stays with its chat. A plain map,
  // read once per switch, like the scroll entries.
  const editStash = new Map<string, { editing: EditState; line: string }>();

  $effect(() => {
    const key = sessionKey;
    const from = lastKey;
    lastKey = key;
    if (from === NEW_SCROLL_KEY && key !== NEW_SCROLL_KEY) {
      moveScroll(from, key);
      return;
    }
    if (from !== null && from !== key) {
      // Untracked: this effect is about the key, and a keystroke in the
      // editor must not re-run the scroll restore below.
      untrack(() => {
        if (editing) editStash.set(from, { editing, line: editCacheLine });
        else editStash.delete(from);
        const back = editStash.get(key) ?? null;
        editing = back?.editing ?? null;
        editCacheLine = back?.line ?? "";
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
  let enterFrom = $state(Infinity);
  let enterKey: string | null = null;
  let enterLen = 0;
  $effect(() => {
    const key = sessionKey;
    const len = app.events.length;
    const live = app.live !== null;
    if (key !== enterKey) {
      enterKey = key;
      enterFrom = Infinity;
      enterLen = len;
      return;
    }
    if (len > enterLen && live) enterFrom = enterLen;
    enterLen = len;
  });

  // ---- The message navigator (nightshift backlog 065) ----
  //
  // The strip's model is a projection of the log (`navigator.ts`); what
  // this owns is the geometry — where each message's anchor sits in the
  // viewport's scroll space, which one is being read, whether the view
  // scrolls at all — measured once per frame on scroll and again after
  // the events change. `data-turn` on each turn is the anchor.
  const navTicks = $derived(tickModel(app.events, liveFlags(app.events), displayTexts(app.events)));
  let navActive = $state<number | null>(null);
  let navScrolls = $state(false);
  const showNav = $derived(navScrolls && navTicks.length >= MIN_TICKS);

  function anchorTop(index: number): number | null {
    if (!viewport) return null;
    const el = viewport.querySelector<HTMLElement>(`[data-turn="${index}"]`);
    if (!el) return null;
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  }

  function measureNav() {
    if (!viewport) return;
    navScrolls = viewport.scrollHeight > viewport.clientHeight + 8;
    if (!navScrolls || navTicks.length < MIN_TICKS) {
      navActive = null;
      return;
    }
    const tops = navTicks.map((t) => anchorTop(t.index) ?? 0);
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
   *  longer following the reply. */
  function jumpTo(i: number) {
    const t = navTicks[i];
    if (!t || !viewport) return;
    const top = anchorTop(t.index);
    if (top === null) return;
    pinned = false;
    viewport.scrollTo({ top: Math.max(0, top - JUMP_OFFSET), behavior: "smooth" });
    // So ⌥↑ / ⌥↓ work from here: the keys are on the viewport, and a click
    // on the strip would otherwise leave focus on the strip.
    viewport.focus({ preventScroll: true });
  }
  function toTop() {
    if (!viewport) return;
    pinned = false;
    viewport.scrollTo({ top: 0, behavior: "smooth" });
    viewport.focus({ preventScroll: true });
  }
  function toBottom() {
    if (!viewport) return;
    pinned = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    viewport.focus({ preventScroll: true });
  }

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
    const session = app.sessions.find((s) => s.id === app.activeSessionId) ?? null;
    if (!session?.forked_from || session.forked_from.reason !== "handoff") return null;
    const line = forkLine(session, app.sessions) ?? "from an earlier chat";
    return { id: session.forked_from.session, name: line.replace(/^from /, "") };
  });

  // ---- Ask aside about a highlighted passage (nightshift backlog 107) ----
  //
  // Select words in a reply or in one of his messages and a small pill
  // floats over the selection: *Ask aside*. It opens the aside card
  // (backlog 081) at the foot as a question box with the passage quoted
  // above it; what he types is sent with the passage, framed as a
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
  let asideBox = $state<HTMLTextAreaElement | null>(null);
  let asideDraft = $state("");
  // A turn starting, or the engine changing, takes the pill down without
  // waiting for the next selection change.
  $effect(() => {
    if (app.busy || !onClaudeCode) asidePill = null;
  });

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
    const turnEl = prose.closest<HTMLElement>("[data-turn]");
    if (!turnEl) return null;
    const turn = Number(turnEl.dataset.turn);
    if (!Number.isFinite(turn)) return null;
    return { turn, prose, role: prose.classList.contains("user-text") ? "user" : "assistant" };
  }

  /** The selection as a passage, or null when it is not one. */
  function passageOf(sel: Selection | null): { quote: AsideQuote; range: Range } | null {
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const a = proseEnd(sel.anchorNode);
    const b = proseEnd(sel.focusNode);
    if (!samePassage(a, b) || !a) return null;
    const item = items.find((it) => it.index === a.turn);
    if (!item || item.superseded || item.removed || item.kind === "compaction") return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    return { quote: { text, role: a.role, ordinal: ordinals[a.turn] ?? 1 }, range: sel.getRangeAt(0) };
  }

  function placePill() {
    if (!viewport || !onClaudeCode || app.busy) {
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
    const left = Math.min(Math.max(r.left + r.width / 2, vp.left + 70), vp.right - 70);
    asidePill = { quote: p.quote, top, left };
  }

  async function askAboutSelection(): Promise<void> {
    const pill = asidePill;
    if (!pill) return;
    draftAside(pill.quote);
    asideDraft = "";
    document.getSelection()?.removeAllRanges();
    asidePill = null;
    await tick();
    // The card is at the foot; bring it up and put the caret in its box.
    toBottom();
    asideBox?.focus({ preventScroll: true });
  }

  function asideChord(e: KeyboardEvent): void {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (!primary || !e.shiftKey || e.altKey || e.code !== "KeyA") return;
    if (!asidePill) return;
    e.preventDefault();
    void askAboutSelection();
  }

  function submitAsideDraft(): void {
    const q = asideDraft.trim();
    const quote = app.aside?.quote ?? null;
    if (!q || !quote || !app.aside?.draft) return;
    asideDraft = "";
    void askAside(q, quote);
  }

  function asideBoxKeys(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAsideDraft();
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismissAside();
    }
  }
</script>

<svelte:document onselectionchange={placePill} />
<svelte:window onkeydown={asideChord} />

<!-- The viewport takes ⌥↑ / ⌥↓ (backlog 065); it is a scroll region, not
     a control, and the lint has no role for that. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="transcript"
  bind:this={viewport}
  {onscroll}
  use:scrollIntent
  tabindex="-1"
  onkeydown={viewportKeys}
>
  <div class="inner">
    {#if continuedFrom}
      <div class="continued">
        <span class="continued-ic"><Icon name="branch" size={14} /></span>
        <span>Continued from <span class="continued-t">“{continuedFrom.name}”</span> · <span class="mono">HANDOFF.md</span></span>
        <span class="spacer"></span>
        <button class="continued-open" onclick={() => void openSession(continuedFrom.id)}>open the earlier chat</button>
      </div>
    {/if}
    {#each items as item, i (i)}
      {#if item.kind === "user"}
        <div
          class="user-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          class:enter={item.index >= enterFrom}
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
                title={diffOpen[item.index] ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                onclick={(e) => toggleDiff(item.index, e.currentTarget)}>edited</button
              >
            {/if}
            <!-- The time moved to the foot (backlog 123): one place is
                 enough, and his ask was the foot. -->
            <span class="ns-k">You</span>
            <!-- The turn's own size (backlog 090): what it added to the
                 context, and its share of the window with the gauge's bar
                 once it is worth a bar. Nothing where the log cannot say. -->
            {#if sizes[item.index]}
              {@const size = sizes[item.index]!}
              {@const share = shareOf(size.tokens, windowLimit)}
              <span class="turn-size" title={sizeTitle(size, "user", windowLimit)}>
                {fmtTokens(size.tokens)}
                {#if fmtShare(share)}
                  <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
                  <span class="share-pct">{fmtShare(share)}</span>
                {/if}
              </span>
            {/if}
          </div>
          {#if editing?.index === item.index}
            <div class="editor">
              <textarea
                bind:this={editorEl}
                use:grow
                value={editing.draft}
                oninput={(e) => {
                  editing = editReduce(editing, { type: "draft", text: (e.target as HTMLTextAreaElement).value });
                  autogrow();
                }}
                onkeydown={(e) => editorKeys(e, item)}
                aria-label="Edit this message"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
              ></textarea>
              <div class="editor-line">{editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(editing).send}
                  title="Start a fork from here with this text as its next message; this chat stays as it is"
                  onclick={() => void commitSend(item)}
                >
                  Send
                </button>
                <button
                  class="ns-btn ghost small"
                  disabled={!editButtons(editing).save}
                  title="Keep this chat, with this message reworded from here on"
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
            <div class="user-bubble">
              {#if item.images.length > 0}
                <div class="user-images">
                  {#each item.images as img, j (j)}
                    <img
                      class="user-image"
                      src={`data:${img.media_type};base64,${img.data}`}
                      alt="attachment"
                    />
                  {/each}
                </div>
              {/if}
              {#if item.documents.length > 0}
                <div class="user-files">
                  {#each item.documents as doc, j (j)}
                    <span class="user-file" title={doc.media_type}>
                      <span class="user-file-ext">PDF</span>
                      {doc.name}
                    </span>
                  {/each}
                </div>
              {/if}
              {#if diffOpen[item.index] && item.original !== null && !item.removed}
                <!-- The edit as a diff over the current text (backlog 105):
                     the bubble's own face, the code diff view's colours. -->
                <div class="user-text textdiff">
                  {#each wordDiff(item.original, item.text) as op, k (k)}
                    {#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}
                  {/each}
                </div>
              {:else if item.text}<div class="user-text">{item.text}</div>{/if}
            </div>
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
            {#if !item.superseded && !app.busy && editing?.index !== item.index}
              <!-- Offered on both engines since 2026-09-15 (backlog 062): on
                   Claude Code each of these rewrites the CLI's history by copy
                   and the next turn resumes the copy — the title says so.
                   Icons, with the full sentence on hover and for a reader. -->
              <span class="turn-tools" title={controlsTitle}>
                {#if item.removed}
                  <!-- Restore on the placeholder itself (backlog 066): the
                       same restore an undo of the removal runs. -->
                  <button
                    class="tool-btn"
                    title="Restore to the context"
                    aria-label="Restore to the context"
                    onclick={() => void restoreTurn(item.index)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                {:else}
                  <button
                    class="tool-btn"
                    title={rewindTitle}
                    aria-label="Rewind to here"
                    onclick={() => void rewindTo(item.index)}
                  >
                    <Icon name="revert" size={14} />
                  </button>
                  {#if item.editable}
                    <button
                      class="tool-btn"
                      title="Edit this message: Save keeps it here with the new text; Send starts a fork from here."
                      aria-label="Edit this message"
                      onclick={() => beginEdit(item)}
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                  {/if}
                  <button
                    class="tool-btn"
                    title="Remove this message from the context. It stays in the log; the context panel restores it."
                    aria-label="Remove this message from the context"
                    onclick={() => void removeTurn(item.index)}
                  >
                    <Icon name="minus" size={14} />
                  </button>
                {/if}
              </span>
            {/if}
            <span class="when" title={exactTime(item.at)}>{relativeTimeLong(item.at, now)}</span>
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
                  <div class="editor-marker" title="A tool call stays where it is; remove it from its own hover">{part.label}</div>
                {/if}
              {/each}
              <div class="editor-line">{editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(editing).save}
                  title="Keep this chat, with this reply reworded from here on"
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
            {@const editable = !item.superseded && !app.busy && !item.removed}
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
              onremoveturn={editable ? () => void removeTurn(item.index) : null}
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
                  title={diffOpen[item.index] ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                  onclick={(e) => toggleDiff(item.index, e.currentTarget)}>edited</button
                >
              </div>
            {/if}
          {/if}
          {#if !item.superseded && !app.busy && item.removed}
            <span class="turn-tools assistant-tools" title={controlsTitle}>
              <button
                class="tool-btn"
                title="Restore to the context"
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
         the CLI's files. Drawn at the foot, dashed, so it never reads as
         a turn; its × is the only way it leaves, short of a chat switch.
         About a passage (backlog 107): the highlighted text sits above the
         question as a quote, and a card opened from a selection is first
         the question box itself — the quote, a one-line box, Ask aside. -->
    {#if app.aside}
      <div class="aside" role="note" aria-label="aside, not part of the chat">
        <div class="aside-head">
          <span class="ns-chip mono">aside · not in the chat</span>
          {#if app.aside.quote}
            <span class="ns-chip mono">about {quoteLabel(app.aside.quote, "card")}</span>
          {/if}
          {#if app.aside.answer !== null && app.aside.cacheRead > 0}
            <span class="ns-chip mono">{app.aside.cacheRead.toLocaleString()} read from cache</span>
          {/if}
          <span class="spacer"></span>
          <button class="ns-btn ghost small" title={app.aside.draft ? "Close without asking" : "Dismiss the aside"} onclick={dismissAside}>×</button>
        </div>
        {#if app.aside.quote}
          <blockquote class="aside-quote" title="The passage you highlighted, sent with the question exactly as selected">{app.aside.quote.text}</blockquote>
        {/if}
        {#if app.aside.draft}
          <textarea
            class="aside-box"
            bind:this={asideBox}
            bind:value={asideDraft}
            rows="1"
            placeholder="Ask about this passage… (Enter asks, Escape closes)"
            aria-label="Your question about the highlighted passage"
            onkeydown={asideBoxKeys}
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          ></textarea>
          <div class="aside-row">
            <button
              class="ns-btn small"
              disabled={!asideDraft.trim()}
              title="Ask this about the passage, off the chat's context: no changes, recorded nowhere"
              onclick={submitAsideDraft}
            >
              Ask aside
            </button>
            <button class="ns-btn ghost small" onclick={dismissAside}>Cancel</button>
          </div>
        {:else}
          <div class="aside-q">{app.aside.question}</div>
          {#if app.aside.error}
            <div class="aside-err">{app.aside.error}</div>
          {:else if app.aside.answer === null}
            <div class="aside-wait">asking…</div>
          {:else}
            <pre class="aside-a">{app.aside.answer}</pre>
          {/if}
        {/if}
      </div>
    {/if}
    {#if app.live}
      {#if app.live.segments.length === 0}
        <!-- Between send and the first streamed event there is nothing to
             render, and a blank row read as "nothing happened" (his words,
             backlog 049). So something moves: the moon rolls a short way
             and back until the first delta or tool call replaces it; with
             the OS asked for less motion it is three still dots. It says
             nothing about progress, because it can see none. -->
        <div class="waiting" role="status" aria-label="Waiting for the reply">
          <span class="roll" aria-hidden="true"><Icon name="moon" size={16} /></span>
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      {:else}
        <AssistantMessage
          segs={app.live.segments}
          streaming
          since={liveSince}
          approvals={app.pendingApprovals}
        />
      {/if}
    {/if}
    {#each stranded as req (req.id)}
      <ApprovalPrompt {req} />
    {/each}
    {#if app.error}
      <div class="error-banner">{app.error}</div>
    {/if}
  </div>
</div>
{#if showNav}
  <Navigator ticks={navTicks} active={navActive} onjump={jumpTo} ontop={toTop} onbottom={toBottom} />
{/if}
<!-- The Ask aside pill over a selection (backlog 107). Its mousedown is
     swallowed so the click keeps the selection it is about. -->
{#if asidePill}
  <button
    class="ns-btn small aside-pill"
    style:top="{asidePill.top}px"
    style:left="{asidePill.left}px"
    title="Ask aside about the highlighted passage: a side question on this text, answered from the chat's context, recorded nowhere"
    onmousedown={(e) => e.preventDefault()}
    onclick={() => void askAboutSelection()}
  >
    Ask aside <kbd class="aside-key">{isMac ? "⌘⇧A" : "Ctrl+Shift+A"}</kbd>
  </button>
{/if}

<style>
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
  .when {
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
  .removed .user-bubble,
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
  .editor textarea {
    width: 100%;
    background: var(--sheet);
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
  .user-bubble {
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px 10px 2px 10px;
    padding: 12px 16px;
    max-width: 560px;
    /* The reply's face, one size down: the two sides of a conversation in
       one type, with the question a little quieter than the answer. */
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 1px);
    line-height: 1.5;
  }
  /* pre-wrap sits on the text, not the bubble: with it on the bubble the
     markup's own newlines around the image strip would render as blank lines. */
  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .user-images:last-child {
    margin-bottom: 0;
  }
  .user-image {
    max-width: 12rem;
    max-height: 12rem;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: block;
  }
  /* Nothing to render of a PDF, so the turn shows what was attached rather
     than nothing at all — a caption asking about a file the transcript does
     not mention reads as a question about nothing. */
  .user-files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .user-files:last-child {
    margin-bottom: 0;
  }
  .user-file {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.8rem;
    word-break: break-all;
  }
  .user-file-ext {
    font-size: 0.62rem;
    letter-spacing: 0.05em;
    color: var(--dim);
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
  /* The aside card (backlog 081): dashed, dim, outside the turns. */
  .aside {
    margin: 8px 0;
    padding: 8px 10px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    color: var(--dim);
    font-size: 0.85rem;
  }
  .aside-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .aside-head .spacer {
    flex: 1;
  }
  .aside-q {
    margin-top: 6px;
    color: var(--ink);
    white-space: pre-wrap;
  }
  .aside-a {
    margin: 6px 0 0;
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
  }
  .aside-wait {
    margin-top: 6px;
    font-style: italic;
  }
  .aside-err {
    margin-top: 6px;
    color: var(--error);
  }
  /* About a passage (backlog 107): the quote, the draft's box and row,
     and the pill that floats over the selection. */
  .aside-quote {
    margin: 6px 0 0;
    padding: 4px 10px;
    border-left: 3px solid var(--line2);
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9em;
    overflow-y: auto;
  }
  .aside-box {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--sheet);
    color: var(--ink);
    font: inherit;
    resize: none;
  }
  .aside-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .aside-pill {
    position: fixed;
    transform: translateX(-50%);
    z-index: 10;
    padding: 5px 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
  }
  .aside-key {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--dim);
  }
  .waiting {
    display: flex;
    align-items: center;
    min-height: 20px;
    color: var(--dim);
    /* A beat after the bubble (backlog 095); `backwards` keeps it unseen
       through the delay, and leaves no fill behind to fight `.superseded`. */
    animation: enter 180ms ease-out 90ms backwards;
  }
  /* The sent message's entrance (backlog 095): opacity and a 6px rise,
     nothing that moves the layout. `ease-out`, since the app has no easing
     token to reuse. Only the turn just sent carries `.enter` (see the
     effect above); a chat opened whole does not cascade. */
  .user-turn.enter {
    animation: enter 180ms ease-out backwards;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .user-turn.enter,
    .waiting {
      animation: none;
    }
  }
  .roll {
    display: inline-flex;
    animation: roll 1.5s ease-in-out infinite alternate;
  }
  /* Two feet, not the width of the pane: a roll that crosses the transcript
     competes with the reply it is waiting for. */
  @keyframes roll {
    from {
      transform: translateX(0) rotate(0deg);
    }
    to {
      transform: translateX(32px) rotate(360deg);
    }
  }
  .dots {
    display: none;
    gap: 5px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .roll {
      display: none;
    }
    .dots {
      display: inline-flex;
    }
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
