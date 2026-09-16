<script lang="ts">
  import { relativeTime } from "./time";
  import { tick } from "svelte";
  import {
    app,
    denialReason,
    liveFlags,
    removeTurn,
    rewindTo,
    saveEdit,
    sendEdit,
  } from "./state.svelte";
  import type { Segment } from "./state.svelte";
  import {
    REMOVED_PLACEHOLDER,
    editButtons,
    editLine,
    editReduce,
    editTexts,
    elideFlags,
    isEditable,
    type EditState,
  } from "./edit";
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
   */
  type Item = Body & {
    index: number;
    superseded: boolean;
    original: string | null;
    removed: boolean;
    editable: boolean;
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
    let index = -1;
    const push = (body: Body, original: string | null = null) =>
      out.push({
        ...body,
        index,
        superseded: !live[index],
        original,
        removed: removed[index],
        editable: isEditable(app.events, index),
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
        // An edit stands in for the reply's text — the first text block
        // takes it and any further text block goes, as the core projects
        // it; a removal stands in for the text and the thinking, and
        // keeps the calls, as the core's elision does.
        const newText = removed[index] ? REMOVED_PLACEHOLDER : edited[index];
        let placed = false;
        const said: string[] = [];
        for (const b of e.blocks) {
          switch (b.type) {
            case "thinking":
              if (removed[index]) break;
              segs.push({ kind: "thinking", text: b.text, done: true });
              break;
            case "redacted_thinking":
              if (removed[index]) break;
              segs.push({ kind: "redacted" });
              break;
            case "text":
              said.push(b.text);
              if (newText != null) {
                if (!placed) segs.push({ kind: "text", text: newText });
                placed = true;
              } else {
                segs.push({ kind: "text", text: b.text });
              }
              break;
            case "tool_use": {
              const result = results.get(b.id) ?? null;
              segs.push({
                kind: "tool",
                call: {
                  id: b.id,
                  name: b.name,
                  input: b.input,
                  result,
                  denied: result?.denied ?? false,
                },
              });
              break;
            }
            default:
              // Unknown content block types are ignored by contract.
              break;
          }
        }
        if (newText != null && !placed) segs.unshift({ kind: "text", text: newText });
        push(
          {
            kind: "assistant",
            segs,
            footer: {
              model: e.model,
              usage: e.usage,
              stop_reason: e.stop_reason,
              cost: e.cost,
            },
          },
          newText != null ? said.join("") : null,
        );
      } else if (e.event === "compaction") {
        push({ kind: "compaction", summary: e.summary });
      }
      // session_created / tool_result / unknown events: not rendered.
    }
    return out;
  });

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

  // The in-place editor (nightshift backlog 062): one turn open at a time,
  // its draft, and the cache line as it read when the editor opened — a
  // fixed reading rather than a ticking one, since the sentence is advice
  // about the edit being typed, not a clock.
  let editing = $state<EditState>(null);
  let editCacheLine = $state("");
  let editorEl = $state<HTMLTextAreaElement | null>(null);
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  const controlsTitle = $derived(
    onClaudeCode
      ? "The next turn resumes a rewritten copy of Claude Code's history; the original session file is kept."
      : "",
  );

  function beginEdit(item: Item) {
    const text = item.kind === "user" ? item.text : item.kind === "assistant" ? textOf(item.segs) : "";
    editing = editReduce(editing, { type: "begin", index: item.index, text });
    editCacheLine = editLine(cacheState(app.events, Date.now()));
    void tick().then(() => {
      editorEl?.focus();
      autogrow();
    });
  }
  function textOf(segs: Segment[]): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("");
  }
  function autogrow() {
    if (!editorEl) return;
    editorEl.style.height = "auto";
    editorEl.style.height = `${Math.min(editorEl.scrollHeight, 420)}px`;
  }
  async function commitSave() {
    if (!editing || !editButtons(editing).save) return;
    if (await saveEdit(editing.index, editing.draft)) editing = editReduce(editing, { type: "done" });
  }
  async function commitSend(item: Item) {
    if (!editing || !editButtons(editing).send || item.kind !== "user") return;
    const { index, draft } = editing;
    editing = editReduce(editing, { type: "done" });
    await sendEdit(index, draft, item.images, item.documents);
  }
  function editorKeys(e: KeyboardEvent, item: Item) {
    // Enter is a newline here — an edit is usually to a long paste — and
    // the modifier sends or saves: ⌘/Ctrl-Enter saves in place, ⌘/Ctrl-
    // Shift-Enter sends into a fork, Escape cancels.
    if (e.key === "Escape") {
      e.preventDefault();
      editing = editReduce(editing, { type: "cancel" });
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

  $effect(() => {
    const key = sessionKey;
    const from = lastKey;
    lastKey = key;
    if (from === NEW_SCROLL_KEY && key !== NEW_SCROLL_KEY) {
      moveScroll(from, key);
      return;
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

  // ---- The message navigator (nightshift backlog 065) ----
  //
  // The strip's model is a projection of the log (`navigator.ts`); what
  // this owns is the geometry — where each message's anchor sits in the
  // viewport's scroll space, which one is being read, whether the view
  // scrolls at all — measured once per frame on scroll and again after
  // the events change. `data-turn` on each turn is the anchor.
  const navTicks = $derived(tickModel(app.events, liveFlags(app.events), editTexts(app.events)));
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
</script>

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
    {#each items as item, i (i)}
      {#if item.kind === "user"}
        <div
          class="user-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          data-turn={item.index}
        >
          <div class="user-key">
            <!-- Offered on both engines since 2026-09-15 (backlog 062): on
                 Claude Code each of these rewrites the CLI's history by copy
                 and the next turn resumes the copy — the title says so. -->
            {#if !item.superseded && !app.busy && editing?.index !== item.index}
              <span class="turn-tools" title={controlsTitle}>
                {#if !item.removed}
                  <button
                    class="tool-btn"
                    title="Rewind to here: this turn and everything after it stop counting. Files written by tools are not reverted."
                    onclick={() => void rewindTo(item.index)}
                  >
                    Rewind to here
                  </button>
                  {#if item.editable}
                    <button
                      class="tool-btn"
                      title="Edit this message: Save keeps it here with the new text; Send starts a fork from here."
                      onclick={() => beginEdit(item)}
                    >
                      Edit
                    </button>
                  {/if}
                  <button
                    class="tool-btn"
                    title="Remove this message from the context. It stays in the log; the context panel restores it."
                    onclick={() => void removeTurn(item.index)}
                  >
                    Remove
                  </button>
                {/if}
              </span>
            {/if}
            {#if item.original !== null && !item.removed}
              <span class="edited-mark" title="Edited; the original is below">edited</span>
            {/if}
            <span class="ns-k">You · {relativeTime(item.at)}</span>
          </div>
          {#if editing?.index === item.index}
            <div class="editor">
              <textarea
                bind:this={editorEl}
                value={editing.draft}
                oninput={(e) => {
                  editing = editReduce(editing, { type: "draft", text: (e.target as HTMLTextAreaElement).value });
                  autogrow();
                }}
                onkeydown={(e) => editorKeys(e, item)}
                aria-label="Edit this message"
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
                  onclick={() => (editing = editReduce(editing, { type: "cancel" }))}
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
              {#if item.text}<div class="user-text">{item.text}</div>{/if}
            </div>
            {#if item.original !== null}
              <details class="original">
                <summary>{item.removed ? "what was removed" : "the original"}</summary>
                <div class="original-text">{item.original}</div>
              </details>
            {/if}
          {/if}
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
          data-turn={item.index}
        >
          {#if !item.superseded && !app.busy && !item.removed && editing?.index !== item.index}
            <span class="turn-tools assistant-tools" title={controlsTitle}>
              {#if item.editable}
                <button
                  class="tool-btn"
                  title="Edit this reply in place; the original stays in the log"
                  onclick={() => beginEdit(item)}
                >
                  Edit
                </button>
              {/if}
              <button
                class="tool-btn"
                title="Remove this reply from the context. Its tool calls stay; it stays in the log."
                onclick={() => void removeTurn(item.index)}
              >
                Remove
              </button>
            </span>
          {/if}
          {#if editing?.index === item.index}
            <div class="editor">
              <textarea
                bind:this={editorEl}
                value={editing.draft}
                oninput={(e) => {
                  editing = editReduce(editing, { type: "draft", text: (e.target as HTMLTextAreaElement).value });
                  autogrow();
                }}
                onkeydown={(e) => editorKeys(e, item)}
                aria-label="Edit this reply"
              ></textarea>
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
                  onclick={() => (editing = editReduce(editing, { type: "cancel" }))}
                >
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <AssistantMessage segs={item.segs} footer={item.footer} />
            {#if item.original !== null}
              <details class="original">
                <summary>
                  {#if !item.removed}<span class="edited-mark">edited</span>{/if}
                  {item.removed ? "what was removed" : "the original"}
                </summary>
                <div class="original-text">{item.original}</div>
              </details>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
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
     engines since 2026-09-15 (backlog 062). Hidden until hovered or
     focused, as the Rewind button always was. */
  .turn-tools {
    display: inline-flex;
    gap: 6px;
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
  .tool-btn {
    background: none;
    border: 1px solid var(--line2);
    border-radius: 6px;
    color: var(--dim);
    font-family: var(--sans);
    font-size: 11.5px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .tool-btn:hover {
    color: var(--ink);
    border-color: var(--accent);
  }
  .assistant-turn {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .edited-mark {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 7px;
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
  .waiting {
    display: flex;
    align-items: center;
    min-height: 20px;
    color: var(--dim);
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
