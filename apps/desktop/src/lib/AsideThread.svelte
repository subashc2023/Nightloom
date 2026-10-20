<script lang="ts">
  import { isImeKey } from "./imeKey";
  import { tip } from "./tip";
  import { copyText } from "./clipRing.svelte";
  import { arrive } from "./sendMotion";
  import {
    addToast,
    app,
    asideAsking,
    asideWaiting,
    askAside,
    followUpAside,
    restoreAsideTurns,
    rewindAside,
    setAsideUnsent,
    stopAside,
    type Aside,
    type AsideTurn,
    type Segment,
  } from "./state.svelte";
  import type { Attachment } from "./types";
  import AssistantMessage from "./AssistantMessage.svelte";
  import UserBubble from "./UserBubble.svelte";
  import Icon from "./Icon.svelte";
  import { scheduleAsideSave } from "./asides.svelte";
  import WaitingMoon from "./WaitingMoon.svelte";
  import { prepareRewind } from "./messageMotion";
  import { asideWait, quietLabel } from "./asideWait";

  /**
   * An aside's exchanges, drawn as the chat's turns are (nightshift backlog
   * 283, 2026-10-02): his question in the chat's bubble (`UserBubble`, the
   * transcript's own piece) with its chips, the answer as a reply
   * (`AssistantMessage`: the same markdown and math, the model above it,
   * Copy and the time under it), and under his question the chat's message
   * tools that mean something in a side thread —
   *
   * - **Copy** his words;
   * - **Edit**: the words in place, and *Ask again* replaces this exchange
   *   and every later one with the edited question (Undo, on the toast,
   *   puts the old ones back);
   * - **Rewind**: this exchange and the later ones leave the thread, and his
   *   question goes back into the aside's box, as the chat's rewind puts his
   *   message back (247); Undo on the toast.
   *
   * Not drawn, because they are the chat's: *Fork helpers from here* (a
   * checkpoint of the chat's session — an aside has none) and *Remove from
   * the context* (an aside keeps no context of its own to remove from; the
   * exchanges above travel as text, and Rewind drops them).
   *
   * One card, panel and tab draw this; their frames differ, not the turns.
   *
   * Since item 403 (2026-10-20, his "practically the same as the main
   * chat") the turn is the chat's in motion too: the reply is drawn from
   * the exchange's `segments` — thinking, calls and text, as the chat's
   * live reply holds them — so `AssistantMessage` gives it the thinking
   * block and its arrival (his Settings pick), the activity rows and the
   * working moon with `working · 41 s` from the send; the wait before the
   * first event is the chat's own `WaitingMoon`; Rewind plays the chat's
   * rewind motion (his pick, item 396). Item 404: the moon's row says when
   * the aside is queued behind the chat's turn, and a running exchange
   * silent past `ASIDE_STALL_MS` says so, with Ask again and Stop.
   */
  let { aside, open }: { aside: Aside; open: boolean } = $props();

  const asking = $derived(asideAsking(aside));
  const waiting = $derived(asideWaiting(aside));
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");

  function segsOf(t: AsideTurn): Segment[] {
    if (t.segments && t.segments.length > 0) return t.segments;
    return t.partial ? [{ kind: "text", text: t.partial }] : [];
  }

  // The clock the queued / stalled words read (item 404), ticking only
  // while an exchange runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!asking) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const wait = $derived(asking ? asideWait(asking, now) : null);

  let threadEl = $state<HTMLElement | null>(null);
  /** The box the thread scrolls in (the card's body, the tab's view): the
   *  rewind motion's window. */
  function scrollBox(el: HTMLElement | null): HTMLElement | null {
    let p = el?.parentElement ?? null;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") return p;
      p = p.parentElement;
    }
    return null;
  }
  function footerOf(t: AsideTurn) {
    if (t === asking || !t.partial.trim()) return null;
    return {
      model: t.model ?? "aside",
      usage: {
        input_tokens: t.usage?.input_tokens ?? 0,
        output_tokens: t.usage?.output_tokens ?? 0,
        ...(t.usage?.cache_read_tokens !== undefined ? { cache_read_tokens: t.usage.cache_read_tokens } : {}),
      },
      stop_reason: null,
      ...(t.at ? { at: t.at } : {}),
      bare: t.usage === undefined,
    };
  }
  const imagesOf = (t: AsideTurn) =>
    (t.attachments ?? []).filter((a) => a.kind === "image" && a.data).map(({ media_type, data }) => ({ media_type, data }));
  /** Everything else as a chip: a document, a file, an image read back
   *  without its bytes (the store keeps names only). */
  const docsOf = (t: AsideTurn) =>
    (t.attachments ?? [])
      .filter((a) => !(a.kind === "image" && a.data))
      .map(({ media_type, name, data }) => ({ media_type, name, data }));

  let copied = $state<number | null>(null);
  async function copyQuestion(i: number, text: string): Promise<void> {
    try {
      await copyText(text);
      copied = i;
      setTimeout(() => {
        if (copied === i) copied = null;
      }, 1200);
    } catch {
      // The clipboard refused; nothing to say.
    }
  }

  /** The tools wait while an answer streams: the thread is moving. */
  const locked = $derived(asking !== null);

  function rewind(i: number): void {
    const before = aside.unsent ?? "";
    // The chat's rewind motion (item 396, his pick), over this thread.
    const m = prepareRewind(scrollBox(threadEl), i, { row: `.aside-q[data-turn="${i}"]` });
    const gone = rewindAside(aside, i);
    if (gone.length === 0) {
      m?.cancel();
      return;
    }
    m?.commit();
    scheduleAsideSave();
    const after = aside.unsent ?? "";
    const n = gone.length;
    addToast(n === 1 ? "Rewound 1 exchange — the question is back in the box" : `Rewound ${n} exchanges — the question is back in the box`, {
      label: "Undo",
      run: () => {
        if (!restoreAsideTurns(aside, i, gone)) {
          addToast("Not undone — the aside has moved on since");
          return;
        }
        // The box back as it was, if he has not typed since.
        if ((aside.unsent ?? "") === after) setAsideUnsent(aside, before);
        scheduleAsideSave();
      },
    });
  }

  /** The editor (one at a time): his words for exchange `index`. */
  let editing = $state<{ index: number; text: string } | null>(null);
  function beginEdit(i: number, t: AsideTurn): void {
    editing = { index: i, text: t.question };
  }
  function editKeys(e: KeyboardEvent): void {
    // Item 322: the input method's keys (Enter committing a composition,
    // Esc cancelling one) are its own, never a send or a close.
    if (isImeKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void askEdited();
    }
  }
  /** Ask the edited question in place of exchange `index` and the later ones. */
  async function askEdited(): Promise<void> {
    const ed = editing;
    if (!ed || !open || !onClaudeCode || locked) return;
    const t = aside.turns[ed.index];
    if (!t) return;
    const words = ed.text.trim();
    if (!words && !(t.attachments ?? []).some((c) => c.data)) return;
    editing = null;
    await askInPlace(ed.index, words, "with your edit");
  }

  /**
   * A stalled exchange asked again (item 404): stopped, then the same
   * question and chips asked in its place — Undo on the notice puts the
   * stopped one back, with whatever of it had arrived.
   */
  async function askAgain(i: number): Promise<void> {
    const t = aside.turns[i];
    if (!t || !open || !onClaudeCode) return;
    stopAside(aside);
    await askInPlace(i, t.question, "");
  }

  /** Exchange `at` and the later ones replaced by `words` with its chips. */
  async function askInPlace(at: number, words: string, how: string): Promise<void> {
    const t = aside.turns[at];
    if (!t || asideAsking(aside)) return;
    const chips: Attachment[] = (t.attachments ?? []).filter((c) => c.data).map((c) => ({ ...c }));
    if (!words && chips.length === 0) return;
    const gone = rewindAside(aside, at, false);
    if (gone.length === 0) return;
    const n = gone.length;
    const what = how ? `Asked again ${how}` : "Asked again";
    addToast(n === 1 ? what : `${what} — ${n} exchanges replaced`, {
      label: "Undo",
      run: () => {
        // The new exchange out (stopped if it still runs), the old ones back.
        stopAside(aside);
        aside.turns.splice(at);
        if (!restoreAsideTurns(aside, at, gone)) addToast("Not undone — the aside has moved on since");
        scheduleAsideSave();
      },
    });
    if (aside.draft) await askAside(words, aside.quote, aside, { attachments: chips });
    else await followUpAside(words, aside, { attachments: chips });
    scheduleAsideSave();
  }
</script>

<div class="aside-thread" bind:this={threadEl}>
  {#each aside.turns as turn, i (turn.seq)}
    <div class="aside-q" data-turn={i} use:arrive={{ channel: "aside", bubble: ".user-bubble" }}>
      {#if editing?.index === i}
        <div class="aside-editor">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            value={editing.text}
            oninput={(e) => editing && (editing.text = (e.currentTarget as HTMLTextAreaElement).value)}
            onkeydown={editKeys}
            rows="3"
            autofocus
            aria-label="Edit this question"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          ></textarea>
          <div class="aside-editor-row">
            <button
              class="ns-btn small"
              disabled={!open || !onClaudeCode || locked || !editing.text.trim()}
              use:tip={open
                ? "Ask this instead: this exchange and the later ones are replaced (Undo on the notice puts them back)"
                : "Open the chat to ask — an aside answers from its context"}
              onclick={() => void askEdited()}>Ask again</button
            >
            <button class="ns-btn ghost small" onclick={() => (editing = null)}>Cancel</button>
          </div>
        </div>
      {:else}
        <UserBubble images={imagesOf(turn)} documents={docsOf(turn)} text={turn.question} />
      {/if}
      {#if editing?.index !== i}
        <div class="aside-q-foot">
          {#if turn.question}
            <button
              class="tool-btn"
              use:tip={copied === i ? "Copied" : "Copy this question"}
              aria-label={copied === i ? "Copied" : "Copy this question"}
              onclick={() => void copyQuestion(i, turn.question)}
            >
              <Icon name={copied === i ? "check" : "copy"} size={13} />
            </button>
          {/if}
          {#if !locked}
            <button
              class="tool-btn"
              use:tip={"Rewind to here: this exchange and the later ones leave the aside, and the question goes back into its box (Undo on the notice)"}
              aria-label="Rewind to here"
              onclick={() => rewind(i)}
            >
              <Icon name="revert" size={13} />
            </button>
            <button
              class="tool-btn"
              use:tip={"Edit this question and ask it again in place of this exchange and the later ones"}
              aria-label="Edit this question"
              onclick={() => beginEdit(i, turn)}
            >
              <Icon name="pencil" size={13} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
    {@const segs = segsOf(turn)}
    {#if segs.length > 0}
      <div class="aside-a">
        <!-- Item 403: the chat's live reply, from the same segments: the
             thinking block's arrival, the activity rows, the working moon
             counting from the send. -->
        <AssistantMessage
          {segs}
          streaming={turn === asking}
          since={turn === asking ? (turn.startedAt ?? null) : null}
          footer={footerOf(turn)}
        />
      </div>
    {:else if turn === asking}
      <!-- The chat's own wait (backlog 049), the one piece since 403. -->
      <WaitingMoon label="Waiting for the answer">
        {#if waiting}
          <!-- Blocker 317: one aside answers at a time; this one is next. -->
          waiting — one aside answers at a time
        {:else if wait?.kind === "queued"}
          <!-- Item 404: the chat's own turn holds the agent. -->
          waiting for the chat's turn to end — the aside runs after it
        {/if}
      </WaitingMoon>
    {/if}
    {#if turn === asking && wait?.kind === "stalled" && !waiting}
      <!-- Item 404: silence past ASIDE_STALL_MS is said, with a way on. -->
      <div class="aside-stalled" role="status">
        <span>Nothing has come back for {quietLabel(wait.quietMs)} — Claude Code may be stuck.</span>
        <span class="aside-stalled-row">
          <button
            class="ns-btn small"
            disabled={!open || !onClaudeCode}
            use:tip={"Stop this exchange and ask the same question again (Undo on the notice puts this one back)"}
            onclick={() => void askAgain(i)}>Ask again</button
          >
          <button class="ns-btn ghost small" onclick={() => stopAside(aside)}>Stop</button>
        </span>
      </div>
    {/if}
    {#if turn.cancelled}
      <div class="aside-mark">stopped here</div>
    {/if}
    {#if turn.error}
      <div class="aside-err">{turn.error}</div>
    {/if}
  {/each}
</div>

<style>
  .aside-thread {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    /* His bubble keeps to most of the column, as in the chat. */
    --user-bubble-max: min(560px, 88%);
  }
  .aside-q {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }
  .aside-q :global(.user-bubble) {
    padding: 8px 14px;
    border-radius: 14px;
  }
  .aside-q-foot {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .aside-q:hover .aside-q-foot,
  .aside-q:focus-within .aside-q-foot {
    opacity: 1;
  }
  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--dim);
    cursor: pointer;
  }
  .tool-btn:hover {
    color: var(--ink);
    background: var(--hover, color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .aside-a {
    min-width: 0;
  }
  .aside-editor {
    width: min(560px, 100%);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .aside-editor textarea {
    box-sizing: border-box;
    width: 100%;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--well);
    color: var(--ink);
    font: inherit;
    line-height: 1.45;
  }
  .aside-editor textarea:focus {
    outline: none;
  }
  .aside-editor-row {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .aside-stalled {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--dim);
    font-size: 12.5px;
  }
  .aside-stalled-row {
    display: flex;
    gap: 6px;
  }
  .aside-mark {
    color: var(--dim);
    font-size: 12px;
    font-style: italic;
  }
  .aside-err {
    color: var(--danger, #d66);
    font-size: 12.5px;
  }
</style>
