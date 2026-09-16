<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { app, addToast, askAside, send, cancelTurn, continueChat, contextUsed, turnWasStopped } from "./state.svelte";
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
  import {
    addAttachment,
    clearDraft,
    draftKey,
    dropQueued,
    enqueueMessage,
    nextAttachmentId,
    readDraft,
    removeAttachment,
    setDraftAttachments,
    setDraftText,
    shiftQueue,
    takeBackQueued,
  } from "./drafts.svelte";
  import type { Attachment } from "./types";

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
   * keeps the other 60% however long the draft; the handle on the top edge
   * sets it by hand, and the setting is kept per machine. The floating
   * composer on the new-chat page has no transcript to balance against and
   * keeps a fixed cap.
   */
  const FLOATING_MAX = 200; // ~8 rows
  const CAP_FRACTION = 0.4;
  const CAP_MIN = 72;
  const CAP_KEY = "nightloom.composer.max";

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
    return Math.max(CAP_MIN, capPx ?? auto);
  }

  /**
   * The handle. Dragging up raises the cap and the box grows into it as far
   * as the draft needs; dragging down lowers it and the box scrolls sooner.
   * Double-click returns to the 40% rule.
   */
  function handleDown(e: PointerEvent) {
    if (e.button !== 0 || !ta) return;
    e.preventDefault();
    const startY = e.clientY;
    const startCap = maxHeight();
    const limit = Math.round(columnHeight() * 0.85);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => {
      const next = Math.min(limit, Math.max(CAP_MIN, startCap + (startY - ev.clientY)));
      capPx = next;
      autogrow();
    };
    const up = () => {
      dragging = false;
      saveCap(capPx);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function handleReset() {
    capPx = null;
    saveCap(null);
    autogrow();
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
    ta.style.maxHeight = max + "px";
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
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
        const where = cap === MAX_AGENT_DOCUMENT_BASE64 ? " on Claude Code" : "";
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
  async function dispatch(typed: string, chips: Attachment[], wrapUp = false): Promise<void> {
    const chat = app.activeSessionId;
    const { images, documents } = split(chips);
    await send(typed.trim(), images, documents);
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
      if (!readDraft(key).text) setDraftText(key, typed);
      setDraftAttachments(key, chips.concat(readDraft(key).attachments));
      return;
    }
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

  /** Hold what is in the box for the next turn (the turn is running). */
  function enqueue(): void {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    enqueueMessage(key, text, attachments.slice());
    clearDraft(key);
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

  /** The first line of a held message, for its row. */
  function firstLine(t: string): string {
    const line = t.split("\n").find((l) => l.trim()) ?? "";
    return line.length > 120 ? line.slice(0, 117) + "…" : line;
  }
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
      title={capPx === null ? "Drag to set how tall the message box may grow (double-click: automatic, 40% of the column)" : `Message box may grow to ${capPx}px — double-click for automatic`}
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
          <span class="queue-text" title={q.text}>{#if handoffHere && q.id === handoff.queuedId}<span class="ns-chip mono" title="Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. × takes it back.">wrap-up · queued while you were away</span> {/if}{firstLine(q.text) || "(no text)"}{#if q.attachments.length > 0} <span class="ns-chip mono">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>{/if}</span>
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
        title="What Wrap up now sends. Edits are kept for this chat only; the default is in Settings → Claude Code."
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
      <span class="ns-chip mono keys">{app.busy ? "↵ queue" : "↵ to send"} · ⇧↵ newline</span>
      <span class="spacer"></span>
      {#if app.busy}
        <button
          class="ns-btn ghost small"
          title="Hold this message; it goes when the turn ends"
          onclick={enqueue}
          disabled={!text.trim() && attachments.length === 0}>Queue</button
        >
        <button class="ns-btn danger small" onclick={() => void cancelTurn()}>Stop</button>
      {:else}
        {#if app.connection?.engine === "claude-code"}
          <!-- Ask aside (nightshift backlog 081): the typed question goes
               to the chat's context off its warm cache and is recorded
               nowhere — the CLI's /btw. Text only; attachments are a turn's. -->
          <button
            class="ns-btn ghost small"
            title="Ask this of the chat without adding it to the chat: answered from what is already in context, no changes, recorded nowhere (Claude Code's /btw)"
            disabled={!text.trim() || attachments.length > 0}
            onclick={() => void submitAside()}
          >
            Ask aside
          </button>
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

<style>
  .composer {
    position: relative;
    background: var(--paper);
    padding: 12px 20px 22px;
  }
  /* The drag handle sits on the top edge, over the border. */
  .handle {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 9px;
    cursor: row-resize;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2;
  }
  .handle::after {
    content: "";
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    transition: background 0.12s;
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
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .keys {
    font-size: 11px;
    padding: 2px 8px;
  }
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
