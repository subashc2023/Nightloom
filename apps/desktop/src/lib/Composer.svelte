<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import {
    app,
    addToast,
    applyDraft,
    askAside,
    cacheHitRate,
    cancelTurn,
    continueChat,
    runningChatName,
    contextUsed,
    pickerModels,
    send,
    switchModel,
    switchModelAt,
    turnWasStopped,
  } from "./state.svelte";
  import { AGENT_MODELS, MODEL_KEYS, thinkingSupport } from "./catalog";
  import { effortDefaultLabel } from "./effortDefaults";
  import { cacheLine, cacheState, nextTickMs, remainingText } from "./cache";
  import { HIDDEN_THINKING_TITLE, thinkingToggleDead } from "./activity";
  import { toggleTranscriptPref, transcript } from "./transcriptPrefs.svelte";
  import { isMac } from "./platform";
  import {
    RE_ASK,
    abortWrapUp,
    awayNow,
    beginWrapUp,
    handoff,
    hasOwnMessage,
    hasOwnThreshold,
    message,
    noteActivity,
    noteFill,
    queueHold,
    reconsider,
    setMessage,
    setThreshold,
    stayHere,
    threshold,
  } from "./handoff.svelte";
  import { fmtTokens } from "./tokens";
  import { ghostFor } from "./suggestions.svelte";
  import { queuedElsewhereToast } from "./browse";
  import {
    addAttachment,
    clearDraft,
    draftKey,
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
    setDraftText,
    shiftQueue,
    takeBackQueued,
  } from "./drafts.svelte";
  import type { Attachment } from "./types";
  import CouncilPopover from "./CouncilPopover.svelte";
  import type { CouncilPrefs } from "./council";

  /**
   * `floating` drops the docked chrome (top border, panel fill) for the
   * new-chat page, where the composer sits in the middle of the pane rather
   * than at the bottom of a transcript. One component either way: a second
   * composer would be a second place to fix a paste bug.
   */
  let { floating = false }: { floating?: boolean } = $props();

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
  const key = $derived(draftKey(app.activeSessionId, app.project?.id, app.pendingMode));
  const draft = $derived(readDraft(key));
  const text = $derived(draft.text);
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
  let ta = $state<HTMLTextAreaElement | null>(null);
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
  const CAP_FRACTION = 0.4;
  const CAP_MIN = 72;
  const CAP_KEY = "nightloom.composer.max";
  const HEIGHT_KEY = "nightloom.composer.height.";
  /** No shorter than one line of text plus the box's own padding. */
  const FLOOR_MIN = 26;

  function loadHeight(k: string): number | null {
    try {
      const raw = localStorage.getItem(HEIGHT_KEY + k);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= FLOOR_MIN ? n : null;
    } catch {
      return null;
    }
  }
  function saveHeight(k: string, n: number | null): void {
    try {
      if (n === null) localStorage.removeItem(HEIGHT_KEY + k);
      else localStorage.setItem(HEIGHT_KEY + k, String(Math.round(n)));
    } catch {
      // best-effort
    }
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
    if (e.button !== 0 || !ta) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.offsetHeight;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => {
      setHeight(startH + (startY - ev.clientY));
    };
    const up = () => {
      dragging = false;
      persistHeight();
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function handleReset() {
    floorPx = null;
    capPx = null;
    persistHeight();
    autogrow();
  }

  /** One line of the box's text, for ⌥⌘↑ / ⌥⌘↓. */
  function lineHeight(): number {
    const lh = ta ? parseFloat(getComputedStyle(ta).lineHeight) : NaN;
    return Number.isFinite(lh) && lh > 0 ? lh : 22;
  }

  /** Grow or shrink the box by a line from the keyboard (backlog 111). */
  function stepHeight(dir: 1 | -1) {
    if (!ta || floating) return;
    setHeight(ta.offsetHeight + dir * lineHeight());
    persistHeight();
  }

  // The four image types every provider we speak to accepts.
  const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // PDF is the only document type every vendor that takes documents at all
  // agrees on. A .txt or .md needs no envelope — paste it, or point the file
  // tools at it — so widening this would buy a second path to the same place.
  const DOCUMENTS = ["application/pdf"];

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
    const min = floating ? 0 : Math.min(max, floorPx ?? 0);
    ta.style.maxHeight = max + "px";
    ta.style.height = "auto";
    ta.style.height = Math.max(min, Math.min(ta.scrollHeight, max)) + "px";
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
    app.connection?.engine === "claude-code" && handoff.chat === app.activeSessionId && handoff.chat !== null,
  );
  const handoffPct = $derived(Math.round(handoff.fill * 100));
  const handoffThresholdPct = $derived(Math.round(threshold(app.activeSessionId) * 100));
  const handoffDefaultPct = $derived(Math.round(threshold(null) * 100));
  const reAskPct = Math.round(RE_ASK * 100);
  /** The wrap-up this chat would send: its own edit, else the Settings default. */
  const wrapUpText = $derived(message(app.activeSessionId));
  /** The wrap-up Nightloom queued while he was away is still in the queue. */
  const wrapUpQueued = $derived(handoff.queuedId !== 0 && queue.some((q) => q.id === handoff.queuedId));

  /** **Wrap up now**: the message as it stands, as a turn of its own. */
  async function sendWrapUpNow(): Promise<void> {
    if (app.busy || !app.connection || !wrapUpText.trim()) return;
    noteActivity();
    const chat = app.activeSessionId;
    beginWrapUp(chat);
    await dispatch(wrapUpText, [], true);
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
    if (!app.busy || app.connection?.engine !== "claude-code" || !app.activeSessionId) return;
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
  const ghost = $derived(ghostFor(app.suggestion, text));
  function acceptGhost(): void {
    if (!ghost) return;
    setDraftText(key, ghost);
    app.suggestion = null;
    ta?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
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

  function kindOf(type: string): "image" | "document" | null {
    if (IMAGES.includes(type)) return "image";
    if (DOCUMENTS.includes(type)) return "document";
    return null;
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

  async function accept(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      const kind = kindOf(file.type);
      if (!kind) {
        addToast(
          `${describe(file)}: ${file.type || "unknown type"} not supported — png, jpeg, webp, gif or pdf only`,
        );
        continue;
      }
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
        // Under the key of the moment the file was dropped: a read can
        // outlive a chat switch, and the chip belongs where it was pasted.
        addAttachment(key, {
          id: nextAttachmentId(),
          kind,
          name: describe(file),
          media_type: file.type,
          data,
        });
      } catch (e) {
        addToast(`${describe(file)}: ${String(e)}`);
      }
    }
  }

  function onpaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    // Only swallow the paste when it carries no text of its own; some sources
    // put a screenshot and its caption on the clipboard together.
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    void accept(files);
  }

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
    removeAttachment(key, id);
  }

  /** The wire shape of a set of chips. */
  function split(chips: Attachment[]) {
    return {
      images: chips.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data })),
      documents: chips
        .filter((a) => a.kind === "document")
        .map(({ media_type, name, data }) => ({ media_type, name, data })),
    };
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
    const { images, documents } = split(chips);
    await send(
      typed.trim(),
      images,
      documents,
      council ? { seats: council.seats, mode: council.mode, areas: [] } : null,
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
  const hold = $derived(queueHold(handoffHere ? handoff.stage : "idle", turnWasStopped()));

  /**
   * Send the oldest held message as the next turn, if there is one. At a
   * turn's end the queue holds when `queueHold` says so; *Send next* is
   * the explicit choice and goes regardless.
   */
  async function drain(explicit = false): Promise<void> {
    if (app.busy || !app.connection) return;
    if (!explicit && hold) return;
    const q = shiftQueue(key);
    if (!q) return;
    // The row Nightloom queued while he was away is the wrap-up going.
    const wrapUp = handoffHere && q.id === handoff.queuedId;
    if (wrapUp) beginWrapUp(app.activeSessionId);
    await dispatch(q.text, q.attachments, wrapUp);
  }

  /** Hold what is in the box for the next turn (the turn is running). In
   *  a chat that is not the running one (backlog 159), the toast says
   *  where the turn is; the message goes here when it ends. */
  function enqueue(): void {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    enqueueMessage(key, text, attachments.slice());
    clearDraft(key);
    if (app.parked) addToast(queuedElsewhereToast(runningChatName()));
    requestAnimationFrame(autogrow);
  }

  function takeBack(id?: number): void {
    takeBackQueued(key, id);
    requestAnimationFrame(autogrow);
    ta?.focus();
  }

  async function submitAside() {
    const t = text.trim();
    if (!t || attachments.length > 0 || app.busy) return;
    clearDraft(key);
    requestAnimationFrame(autogrow);
    await askAside(t);
  }

  async function submit() {
    const t = text.trim();
    const empty = !t && attachments.length === 0;
    if (empty || !app.connection) return;
    // A send is presence, for the hand-off's away rule.
    noteActivity();
    if (app.busy) {
      enqueue();
      return;
    }
    const pending = attachments.slice();
    const typed = text;
    clearDraft(key);
    requestAnimationFrame(autogrow);
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
    if ((!t && attachments.length === 0) || !app.connection || app.busy) return;
    noteActivity();
    const pending = attachments.slice();
    const typed = text;
    clearDraft(key);
    requestAnimationFrame(autogrow);
    await dispatch(typed, pending, false, prefs);
  }
  function onCouncilDocClick(e: MouseEvent) {
    const t = e.target as Node;
    if (councilWrap?.contains(t)) return;
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
  const agentMode = $derived(app.draft.engine === "claude-code");
  const locked = $derived(app.busy || app.connecting);
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  const AGENT_PILLS = AGENT_MODELS.filter(Boolean);
  /** The same list `switchModelAt` counts, so row n's cap is ⌘⇧n. */
  const models = $derived(pickerModels());
  function agentKey(alias: string): string | null {
    const k = MODEL_KEYS.find((m) => m.alias === alias);
    return k ? `${mod}${shift}${k.key}` : null;
  }
  /** What the button names: the connection's model (the alias, or
   *  `default` for the CLI's own), else the draft's while not connected. */
  const modelLabel = $derived(
    app.connection?.model || (agentMode ? app.draft.agentModel.trim() || "default" : app.draft.model.trim() || "model"),
  );
  const modelTitle = $derived.by(() => {
    const ran = app.agentTurn?.model ? ` — last turn ran ${app.agentTurn.model}` : "";
    return agentMode
      ? `Model — ${mod}${shift}F / O / S / H pick an alias from anywhere; ${mod}M opens the rail${ran}`
      : `Model — ${mod}${shift}1…9 pick from the picker anywhere; ${mod}M opens the rail`;
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

  let menu = $state<"model" | "effort" | "history" | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let modelBtn = $state<HTMLElement | null>(null);
  let effortBtn = $state<HTMLElement | null>(null);
  let historyBtn = $state<HTMLElement | null>(null);
  const menuRows = $derived(
    menu === "model" ? modelRows : menu === "effort" ? effortRows : menu === "history" ? historyRows : [],
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
      closeMenu(null);
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
  class="composer"
  class:floating
  class:dropping={dragDepth > 0}
  role="group"
  aria-label="message composer"
  {ondragenter}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  {#if !floating}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="handle"
      class:dragging
      role="separator"
      aria-orientation="horizontal"
      aria-label="Composer height"
      aria-valuenow={floorPx ?? undefined}
      title={floorPx === null && capPx === null
        ? "Drag to resize · double-click to reset (⌥⌘↑ / ⌥⌘↓ by a line)"
        : `Drag to resize · double-click to reset — ${floorPx === null ? "automatic" : `${floorPx}px`} for this chat${capPx === null ? "" : `, grows to ${capPx}px`}`}
      onpointerdown={handleDown}
      ondblclick={handleReset}
    ></div>
  {/if}
  {#if queue.length > 0}
    <div class="queue" role="list" aria-label="queued messages">
      <div class="queue-head">
        <span class="ns-chip mono">queued · {app.busy ? "sent when this turn ends" : hold === "stopped" ? "waiting — the turn was stopped" : hold === "wrapped" ? "waiting — HANDOFF.md is written; continue in a new chat, or Send next here" : "waiting"}</span>
        {#if !app.busy}
          <button class="ns-btn ghost small" disabled={!app.connection} onclick={() => void drain(true)}>Send next</button>
        {/if}
      </div>
      {#each queue as q, i (q.id)}
        <div class="queue-row" role="listitem">
          <span class="queue-n mono">{i + 1}</span>
          <span class="queue-text" title={q.text} data-find-text={q.text}>{#if handoffHere && q.id === handoff.queuedId}<span class="ns-chip mono" title="Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. × takes it back.">wrap-up · queued while you were away</span> {/if}{firstLine(q.text) || "(no text)"}{#if q.attachments.length > 0} <span class="ns-chip mono">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>{/if}</span>
          <button class="ns-btn ghost small" title="Back into the message box" onclick={() => takeBack(q.id)}>take back</button>
          <button class="remove" title="drop this message" aria-label="drop queued message {i + 1}" onclick={() => dropQueued(key, q.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if attachments.length > 0}
    <div class="attachments">
      {#each attachments as a (a.id)}
        <div class="attachment">
          {#if a.kind === "image"}
            <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
          {:else}
            <span class="file" title={a.name}>
              <span class="file-ext">PDF</span>
              <span class="file-name">{a.name}</span>
            </span>
          {/if}
          <button
            class="remove"
            title="remove {a.name}"
            aria-label="remove {a.name}"
            onclick={() => remove(a.id)}>×</button
          >
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
          half-done, writes <code>HANDOFF.md</code>, and ends with a start prompt for the new chat. Or raise this
          chat's mark and keep going. Nothing is sent by itself while this notice is open.
        {/if}
      </p>
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
        title="What Wrap up now sends. Edits are kept for this chat only; the default is in Settings → Subscription."
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
        <button class="ns-btn ghost small" title="No wrap-up; asked again past {reAskPct}%" onclick={stayHere}>Stay here</button>
        {#if hasOwnMessage(app.activeSessionId)}
          <button class="ns-btn ghost small" title="Back to the Settings default for this chat" onclick={() => setMessage(app.activeSessionId, "")}>Reset the message</button>
        {/if}
        <span class="handoff-keys mono">stay past {reAskPct}% and the wrap-up is asked again</span>
      </div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapping"}
    <div class="handoff" role="status">
      <div class="handoff-head"><span>Wrapping up — the model is finishing what is half-done, writing <code>HANDOFF.md</code>, and ending with the start prompt for the new chat.</span></div>
    </div>
  {:else if handoffHere && handoff.stage === "wrapped"}
    <div class="handoff" role="status" aria-label="Hand-off done">
      <div class="handoff-head">
        <span class="handoff-mark" aria-hidden="true"><Icon name="branch" size={15} /></span>
        <strong>HANDOFF.md written</strong>
        <span class="spacer"></span>
        <span class="mono handoff-fill">{fmtTokens(handoff.used)} of {fmtTokens(handoff.limit)} · {handoffPct}%</span>
      </div>
      <p class="handoff-d">
        Check the reply above. <strong>Continue in a new chat</strong> opens a linked chat in the same folder with
        {#if handoff.startPrompt}the model's start prompt in the box, not sent{:else}an empty box — the reply had no
          <code>start-prompt</code> block, so say what to read first{/if}. This chat stays readable.
      </p>
      <div class="handoff-acts">
        <button class="ns-btn accent small" disabled={app.busy} onclick={() => void continueChat()}>Continue in a new chat</button>
        <button class="ns-btn ghost small" title="Keep going here; asked again past {reAskPct}%" onclick={stayHere}>Stay here</button>
        <span class="handoff-keys mono">stay past {reAskPct}% and the wrap-up is asked again</span>
      </div>
    </div>
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
        title="The CLI's predicted next prompt — Tab or click puts it in the box, Esc drops it"
        onmousedown={(e) => e.preventDefault()}
        onclick={acceptGhost}
      >
        <span class="ghost-text">{ghost}</span>
        <span class="ghost-key">Tab</span>
      </button>
    {/if}
    <textarea
      bind:this={ta}
      bind:value={() => text, (v) => setDraftText(key, v)}
      rows="1"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder={app.connection ? "Message…" : ""}
      disabled={!app.connection}
      oninput={() => {
        // A keystroke is presence, for the hand-off's away rule (backlog 086).
        noteActivity();
        autogrow();
      }}
      {onpaste}
      {onkeydown}
    ></textarea>
    <div class="row">
      <input
        bind:this={picker}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onchange={onpick}
      />
      <button class="ns-btn ghost small" disabled={!app.connection} onclick={() => picker?.click()}>
        <Icon name="plus" />Attach
      </button>
      <!-- The model and effort buttons (backlog 112, board 10's A): each
           opens its menu above; the top bar's chip no longer names the
           model (blocker 141). Disabled while a turn runs or a connect is
           in flight, as the rail's pills are. -->
      <span class="pick-wrap">
        <button
          class="pick-btn"
          class:open={menu === "model"}
          bind:this={modelBtn}
          disabled={locked || !app.connection}
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          title={modelTitle}
          onclick={() => openMenu("model")}
        >
          <span class="pick-dot" class:unknown={!app.connection}></span>
          <span class="pick-name">{modelLabel}</span>
          <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
        </button>
        {#if menu === "model"}
          {@render pickMenu("Model", agentMode ? "an alias the CLI resolves" : `${models.length} in the picker · Settings picks which`)}
        {/if}
      </span>
      <span class="pick-wrap">
        <button
          class="pick-btn"
          class:open={menu === "effort"}
          bind:this={effortBtn}
          disabled={locked || !app.connection}
          aria-haspopup="menu"
          aria-expanded={menu === "effort"}
          title={agentMode
            ? "Effort (--effort) — how hard the model thinks per turn; default sends no flag and leaves it to the model. Kept on this chat."
            : `Thinking — ${thinkingSup.note}`}
          onclick={() => openMenu("effort")}
        >
          <span class="pick-k">{agentMode ? "effort" : "thinking"}</span>
          <span class="pick-name">{agentMode ? effortLabel : thinkingLabel}</span>
          <span class="pick-chev" aria-hidden="true"><Icon name="chev" size={11} /></span>
        </button>
        {#if menu === "effort"}
          {@render pickMenu(agentMode ? "Effort" : "Thinking", agentMode ? "--effort · kept on this chat" : "kept on this chat")}
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
            title="Earlier drafts of this box — the last ten texts that were sent, queued, or replaced by a paste. Click one to put it back."
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
      {#if app.busy}
        <button
          class="ns-btn ghost small"
          title="Hold this message; it goes when the turn ends"
          onclick={enqueue}
          disabled={!text.trim() && attachments.length === 0}>Queue</button
        >
        <button class="ns-btn danger small" title={app.parked ? `Stop the turn running in ${runningChatName()}` : "Stop this turn"} onclick={() => void cancelTurn()}>Stop</button>
      {:else}
        {#if app.connection?.engine === "claude-code" && app.events.length > 0}
          <!-- Ask aside (nightshift backlog 081): the typed question goes
               to the chat's context off its warm cache and is recorded
               nowhere — the CLI's /btw. Text only; attachments are a turn's.
               Not before the first turn: an empty chat has no context to
               ask (the Welcome screen showed it — his report, 2026-09-17). -->
          <button
            class="ns-btn ghost small"
            title="Ask this of the chat without adding it to the chat: answered from what is already in context, no changes, recorded nowhere (Claude Code's /btw)"
            disabled={!text.trim() || attachments.length > 0}
            onclick={() => void submitAside()}
          >
            Ask aside
          </button>
        {/if}
        {#if app.connection?.engine === "claude-code"}
          <!-- The council (nightshift backlog 149): the popover's roster
               and mode for this turn, then Send to the council. -->
          <span class="council-wrap" bind:this={councilWrap}>
            <button
              class="ns-btn ghost small"
              class:on={councilOpen}
              bind:this={councilBtn}
              title="Send this message to a council: several models answer it independently, then this chat's model chairs their answers"
              aria-haspopup="dialog"
              aria-expanded={councilOpen}
              onclick={() => (councilOpen = !councilOpen)}
            >
              Council
            </button>
            {#if councilOpen}
              <CouncilPopover
                disabled={!app.connection || (!text.trim() && attachments.length === 0)}
                onsend={(p) => void submitCouncil(p)}
                onclose={() => {
                  councilOpen = false;
                  councilBtn?.focus();
                }}
              />
            {/if}
          </span>
        {/if}
        <button
          class="ns-btn accent send"
          onclick={() => void submit()}
          disabled={!app.connection || (!text.trim() && attachments.length === 0)}
        >
          Send
        </button>
      {/if}
    </div>
  </div>
  {#if !floating}
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
        title={thinkingDead
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
        title={transcript.tools
          ? `Tool calls shown in full — click to fold each to one line (${shiftKey}B)`
          : `Tool calls folded to one line each — click to show them in full (${shiftKey}B)`}
        onclick={() => toggleTranscriptPref("tool")}
      >
        <span class="bottom-mark" aria-hidden="true">⚒</span>tools
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
          title={cache
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
    <div class="hint">connect a provider to start</div>
  {:else if dragDepth > 0}
    <div class="hint">drop images or PDFs to attach</div>
  {:else if handoff.noStartPromptChat !== null && handoff.noStartPromptChat === app.activeSessionId && !text}
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
  <div class="pick-menu" role="menu" tabindex="-1" aria-label={head} bind:this={menuEl} onkeydown={onMenuKey}>
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
  .pick-menu {
    position: absolute;
    z-index: 70;
    bottom: calc(100% + 8px);
    left: 0;
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
  /* The drag handle sits on the top edge, over the border. The grip mark
     is the sidebar's (`Grip.svelte`, laid flat): a short bar, accent on
     hover; since backlog 111 the hover also draws a line the width of the
     edge, so the place to drag is findable, and the strip is taller. */
  .handle {
    position: absolute;
    top: -6px;
    left: 0;
    right: 0;
    height: 13px;
    cursor: row-resize;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2;
  }
  .handle::before {
    content: "";
    position: absolute;
    left: 20px;
    right: 20px;
    top: 6px;
    height: 1px;
    background: transparent;
    transition: background 0.12s;
  }
  .handle::after {
    content: "";
    position: relative;
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    transition: background 0.12s;
  }
  .handle:hover::before,
  .handle.dragging::before {
    background: var(--accent);
  }
  .handle:hover::after,
  .handle.dragging::after {
    background: var(--accent);
  }
  .composer.floating {
    background: transparent;
    border-top: none;
    padding: 0;
    width: 100%;
  }
  .composer.dropping .card {
    border-color: var(--accent);
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
    container-type: inline-size;
  }
  .spacer {
    flex: 1;
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
  textarea:focus {
    outline: none;
  }
  textarea:disabled {
    opacity: 0.5;
  }
  .send {
    padding: 6px 16px;
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
