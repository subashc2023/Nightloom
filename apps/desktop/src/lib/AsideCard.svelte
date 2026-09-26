<script lang="ts">
  import { tip } from "./tip";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  import { arrive, launch } from "./sendMotion";
  import {
    app,
    askAside,
    asideAsking,
    asideWaiting,
    dropContent,
    requestDismissAside,
    setAsideUnsent,
    endContentDrag,
    followUpAside,
    startContentDrag,
    unfoldAside,
  } from "./state.svelte";
  import type { TabContent } from "./tabs";
  import { outcome, startMove } from "./floatingMove";
  import type { Zone } from "./floatingMove";
  import { tick } from "svelte";
  import type { Aside } from "./state.svelte";
  import type { Placement } from "./asideCard";
  import { quoteLabel } from "./asideQuote";
  import { renderMarkdown } from "./markdown";
  import Icon from "./Icon.svelte";
  import MoveZone from "./MoveZone.svelte";

  /**
   * The floating aside card (nightshift backlog 141, 2026-09-17; blocker
   * 162 answered — "popover at the selection, and the answer there too").
   *
   * One card, two homes. About a passage, it floats right under the
   * highlighted text (`placement`, measured by the transcript), inside
   * the scrolled column so it moves with the message; the passage is not
   * quoted again — it is marked in the transcript, right above. From the
   * composer (no passage, blocker 225), or when the passage cannot be
   * found again, it sits pinned above the composer at the column's foot.
   * Either way it is the question box first (a draft), then his question
   * in a bubble, the answer streaming in under the moon (backlog 128),
   * the follow-ups (backlog 130), Copy, ×, and a handle to drag it out —
   * onto a tab strip for a tab of its own (backlog 130 part 2), or to the
   * window's right edge for a side panel (141 pass 2).
   *
   * Escape closes it, and is caught here: from inside the card always;
   * from anywhere else in the window unless another text field has the
   * focus (backlog 138's rule — an Escape must never reach the window,
   * where macOS leaves full screen). × is the one way the thread ends:
   * mid-stream it stops the answer and keeps what arrived (the next ×
   * dismisses), as the foot card's × did. Nothing sent to the model
   * changed; `askAside` and `followUpAside` are the same calls.
   *
   * A third home (141 pass 2): the **side panel** at the window's right
   * edge, where the card is drawn static and full-height (`panel`), its
   * chrome the panel's. There it may show another chat's thread
   * (`session`): read-only then, with the line an aside tab uses — the
   * backend forks the *open* chat, so a follow-up from another chat's
   * panel would be answered from the wrong context. Escape in the panel
   * puts the card back rather than ending the thread.
   *
   * Moving it (backlog 156, 2026-09-22 — his "move it around the screen
   * freely"): the floating card's head moves the card by pointer
   * (`floatingMove.ts`), anywhere, and it stays where it is let go — a
   * nudge of a few pixels included — fixed to the window, the passage
   * still marked. Only near a tab strip (a tab of its own), the window's
   * right edge (the side panel) or its left edge (beside) does a zone
   * light, and a release there does what the old drop did. Escape during
   * a move puts it back where the move began; *back* in the head, or a
   * double-click on the head, sends a moved card home under its passage.
   * The panel's card keeps the native drag onto a strip.
   *
   * Several at once (backlog 176, 2026-09-23): each card is one thread
   * (`aside`, with its `id`), and every action here — ask, follow up, ×,
   * move, drag out — is that thread's, never "the" aside. The descriptor
   * a drag makes names the thread, so two aside tabs show two threads.
   * Only the `front` card claims an Escape pressed elsewhere in the
   * window, so one Escape closes one card. A `folded` card (blocker 318)
   * is its head row alone; a click on it opens it again.
   */
  let {
    aside,
    placement,
    panel = false,
    session = null,
    front = true,
    footBottom = null,
    footCount = 1,
  }: {
    aside: Aside;
    placement: Placement | null;
    panel?: boolean;
    /** The panel's chat; the floating card's is always the open one. */
    session?: string | null;
    /** The card an Escape from elsewhere in the window closes (176). */
    front?: boolean;
    /** Several composer cards (176): this one's `bottom` in the sticky
     *  stack above the composer — the heights of the cards below it —
     *  and how many share the stack's room. */
    footBottom?: number | null;
    footCount?: number;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);
  let askBox = $state<HTMLTextAreaElement | null>(null);
  let followBox = $state<HTMLTextAreaElement | null>(null);
  // ~~`askDraft` / `followDraft`, the card's own `$state`~~ — lost on an
  // unmount and on quit (backlog 228, 2026-09-26). The text lives on the
  // thread (`aside.unsent`), which the aside store writes; the two boxes
  // never show at once, so one field serves both.
  const unsent = $derived(aside.unsent ?? "");
  function typed(e: Event): void {
    setAsideUnsent(aside, (e.currentTarget as HTMLTextAreaElement).value);
  }
  let copied = $state(false);

  const asking = $derived(asideAsking(aside));
  /** Another aside is answering first (blocker 317): one at a time. */
  const waiting = $derived(asideWaiting(aside));
  const folded = $derived(!panel && aside.folded === true);
  const last = $derived(aside.turns[aside.turns.length - 1] ?? null);
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  /** The chat the thread belongs to: the panel's, else the open one. */
  const owner = $derived(panel ? session : app.activeSessionId);
  const readOnly = $derived(panel && session !== app.activeSessionId);
  // A draft drags too (backlog 148, his ask on 5847cca): the card sits
  // under the passage and can cover what he is reading before a word is
  // typed; the tab and the panel draw the question box for a draft.
  const draggable = $derived(owner !== null);
  /** The floating card (under a passage or above the composer) moves by
   *  pointer; the panel's card is furniture and keeps the native drag. */
  const movable = $derived(draggable && !panel);

  /** Where the card is while the pointer holds it; `aside.moved` once let
   *  go. The zone the pointer is over, lit while it is. */
  let dragPos = $state<{ left: number; top: number } | null>(null);
  let zone = $state<Zone | null>(null);
  const moved = $derived(panel ? null : (aside.moved ?? null));
  const pos = $derived(dragPos ?? moved);

  function headDown(e: PointerEvent): void {
    if (!movable || !root || folded) return;
    if ((e.target as HTMLElement | null)?.closest("button, a, input, textarea")) return;
    const r = root.getBoundingClientRect();
    const width = r.width;
    startMove(e, {
      origin: { left: r.left, top: r.top },
      size: { width: r.width, height: r.height },
      edges: { left: "beside", right: "panel" },
      onMove(p, z) {
        dragPos = p;
        zone = z;
      },
      onDrop(p, z) {
        dragPos = null;
        zone = null;
        land(p, z, width);
      },
      onCancel() {
        // Back to where the move began: `aside.moved` was not touched.
        dragPos = null;
        zone = null;
      },
    });
  }
  /** Keep the page's selection and the box's focus when the head is
   *  grabbed; the buttons in it still take their clicks. */
  function headMouseDown(e: MouseEvent): void {
    if (!movable) return;
    if ((e.target as HTMLElement | null)?.closest("button, a, input, textarea")) return;
    e.preventDefault();
  }
  function land(p: { left: number; top: number }, z: Zone | null, width: number): void {
    const session = owner;
    // This card's thread (backlog 176) — ~~`app.aside`~~, which is only
    // the front one when several are open.
    const a = aside;
    if (!session) return;
    const o = outcome(z);
    if (o.kind === "stay") {
      a.moved = { left: p.left, top: p.top, width };
      return;
    }
    // Snapped: the card's next home is under its passage again.
    a.moved = null;
    if (o.kind === "panel") {
      app.asidePanel = session;
      app.asidePanelThread = a.id;
    } else if (o.kind === "tab") void dropContent(descriptor(session), { pane: o.pane, index: o.index });
    else void dropContent(descriptor(session), { pane: o.pane, side: o.side });
  }
  /** The tab descriptor for this thread (backlog 176): the chat and the
   *  thread's id, so a second aside tab shows a second thread. */
  function descriptor(session: string): TabContent {
    return { kind: "aside", session, thread: aside.id } as TabContent;
  }
  /** Home: under the passage, or above the composer for a composer aside. */
  function goHome(): void {
    aside.moved = null;
  }

  // The body follows the answer as the transcript follows a reply: a card
  // taller than its room scrolls inside, and the newest text — the
  // streaming answer, then the follow-up box — is what he is reading.
  // Released the moment he scrolls up in it, held again at the foot.
  let bodyPinned = true;
  function bodyScrolled(): void {
    if (!body) return;
    bodyPinned = body.scrollHeight - body.scrollTop - body.clientHeight < 4;
  }
  $effect(() => {
    void last?.partial;
    void last?.answer;
    void aside.turns.length;
    void asking;
    const el = body;
    if (!el || !bodyPinned) return;
    tick().then(() => {
      if (bodyPinned) el.scrollTop = el.scrollHeight;
    });
  });

  /** The transcript puts the caret here once the card is placed. */
  export function focusBox(): void {
    askBox?.focus({ preventScroll: true });
  }

  /** The card's own element, for the transcript to measure. */
  export function element(): HTMLElement | null {
    return root;
  }

  function submitAsk(): void {
    const q = unsent.trim();
    if (!q || !aside.quote || !aside.draft) return;
    // Off the Claude Code engine the ask does nothing; the text stays (228).
    if (app.connection?.engine !== "claude-code") return;
    launch("aside", askBox);
    setAsideUnsent(aside, "");
    void askAside(q, aside.quote, aside);
  }
  function askKeys(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAsk();
    }
  }
  function submitFollowUp(): void {
    const q = unsent.trim();
    if (!q || aside.draft || asking) return;
    // Off the Claude Code engine the ask does nothing; the text stays (228).
    if (app.connection?.engine !== "claude-code") return;
    launch("aside", followBox);
    setAsideUnsent(aside, "");
    void followUpAside(q, aside);
  }
  function followKeys(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitFollowUp();
    }
  }

  /** Escape inside the card: closed here, and stopped here. In the
   *  panel it is the way back, not the end of the thread. */
  function cardKeys(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // The discard question is up (backlog 228): Escape answers it "keep".
    if (app.asideDiscard !== null) {
      app.asideDiscard = null;
      return;
    }
    if (panel) {
      app.asidePanel = null;
      app.asidePanelThread = null;
    } else requestDismissAside(aside);
  }
  /** Escape elsewhere: ours unless another text field has it. The
   *  panel does not claim it — a panel is furniture, not a popover. */
  function windowKeys(e: KeyboardEvent): void {
    if (panel || !front || e.key !== "Escape" || e.defaultPrevented) return;
    // The discard question is up (backlog 228): its own Escape closes it.
    if (app.asideDiscard !== null) return;
    const t = e.target as HTMLElement | null;
    if (t && root?.contains(t)) return; // `cardKeys` had it
    const tag = (t?.tagName ?? "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    requestDismissAside(aside);
  }

  /** The last answer as its markdown source; the thread when there are
   *  several exchanges, each question over its answer. */
  async function copy(): Promise<void> {
    const text =
      aside.turns.length > 1
        ? aside.turns.map((t) => `> ${t.question}\n\n${t.partial}`).join("\n\n")
        : (last?.partial ?? "");
    if (!text.trim()) return;
    try {
      await copyText(text);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // The clipboard refused; nothing to say.
    }
  }
</script>

<svelte:window onkeydown={windowKeys} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="aside-card"
  class:floating={placement !== null}
  class:foot={placement === null && !panel}
  class:folded
  class:panel
  class:above={placement?.side === "above"}
  class:moved={pos !== null}
  class:holding={dragPos !== null}
  class:over-zone={zone !== null}
  role="note"
  aria-label="aside, not part of the chat"
  bind:this={root}
  style:top={pos ? `${pos.top}px` : placement ? `${placement.top}px` : undefined}
  style:left={pos ? `${pos.left}px` : placement ? `${placement.left}px` : undefined}
  style:width={moved ? `${moved.width}px` : placement ? `${placement.width}px` : undefined}
  style:max-height={pos
    ? `min(${placement ? `${placement.maxHeight}px` : "50vh"}, calc(100vh - ${pos.top + 8}px))`
    : placement
      ? `${placement.maxHeight}px`
      : !panel && footCount > 1
        ? `max(120px, calc(60vh / ${footCount}))`
        : undefined}
  style:bottom={!pos && !placement && !panel && footBottom !== null ? `${footBottom}px` : undefined}
  onkeydown={cardKeys}
>
  <!-- The strip's click is a pointer convenience; the keyboard has the
       *open* button a folded head carries. -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="aside-card-head"
    class:movable
    draggable={draggable && panel}
    use:tip={draggable
      ? panel
        ? "Drag onto a tab strip for a tab of its own"
        : "Drag to move it anywhere — near a tab strip it opens as a tab, at the window's right edge as a side panel, at the left edge beside. Double-click to put it back"
      : undefined}
    ondragstart={(e) => {
      if (!draggable || !panel || owner === null) return;
      startContentDrag(e, descriptor(owner));
    }}
    ondragend={endContentDrag}
    onpointerdown={headDown}
    onmousedown={headMouseDown}
    onclick={(e) => {
      // A folded card's strip opens it (blocker 318); its × still closes.
      if (!folded || (e.target as HTMLElement | null)?.closest("button")) return;
      unfoldAside(aside);
    }}
    ondblclick={(e) => {
      if (!moved || (e.target as HTMLElement | null)?.closest("button")) return;
      goHome();
    }}
  >
    <span class="aside-card-grip" aria-hidden="true" class:live={draggable}>⋮⋮</span>
    <span class="ns-chip mono">aside · not in the chat</span>
    {#if folded && asking}
      <span class="ns-chip mono">{waiting ? "waiting" : "asking…"}</span>
    {/if}
    {#if aside.quote}
      <span class="ns-chip mono" use:tip={"The highlighted passage, sent with the question exactly as selected"}>about {quoteLabel(aside.quote, "card")}</span>
    {/if}
    {#if last && last.answer !== null && last.cacheRead > 0}
      <span class="ns-chip mono">{last.cacheRead.toLocaleString()} read from cache</span>
    {/if}
    <span class="spacer"></span>
    {#if folded}
      <button class="ns-btn ghost small" use:tip={"Open this card again (the oldest other open card folds)"} onclick={() => unfoldAside(aside)}
        >open</button
      >
    {/if}
    {#if moved}
      <button
        class="ns-btn ghost small"
        use:tip={aside.anchor ? "Put the card back under its passage" : "Put the card back above the composer"}
        onclick={goHome}>back</button
      >
    {/if}
    {#if last && last.partial.trim()}
      <button
        class="ns-btn ghost small"
        use:tip={aside.turns.length > 1 ? "Copy the thread as text" : "Copy the answer as text"}
        onclick={() => void copy()}>{copied ? "Copied" : "Copy"}</button
      >
    {/if}
    {#if !readOnly}
      <button
        class="ns-btn ghost small"
        use:tip={(aside.draft
          ? "Close without asking"
          : asking
            ? "Stop the answer here; what has arrived stays"
            : "Dismiss the aside — the thread ends") + (panel ? "" : " (Escape)")}
        onclick={() => requestDismissAside(aside)}>×</button
      >
    {/if}
  </div>
  {#if !folded}
  <div class="aside-card-body" bind:this={body} onscroll={bodyScrolled}>
    {#if aside.draft}
      <textarea
        class="aside-card-box"
        bind:this={askBox}
        value={unsent}
        oninput={typed}
        rows="1"
        placeholder={aside.quote ? "Ask about the passage… (Enter asks)" : "Ask aside… (Enter asks)"}
        aria-label="Your question about the highlighted passage"
        onkeydown={askKeys}
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
      ></textarea>
      <div class="aside-card-row">
        <button
          class="ns-btn small"
          disabled={!unsent.trim()}
          use:tip={"Ask this about the passage, off the chat's context: no changes, recorded nowhere"}
          onclick={submitAsk}
        >
          Ask aside
        </button>
        <button class="ns-btn ghost small" onclick={() => requestDismissAside(aside)}>Cancel</button>
      </div>
    {:else}
      {#each aside.turns as turn (turn.seq)}
        <div class="aside-card-q" use:arrive={{ channel: "aside", bubble: ".aside-card-qtext" }}><div class="aside-card-qtext">{turn.question}</div></div>
        {#if turn.partial}
          <div class="aside-card-a markdown">{@html renderMarkdown(turn.partial)}</div>
        {/if}
        {#if turn.cancelled}
          <div class="aside-card-mark">stopped here</div>
        {/if}
        {#if turn.error}
          <div class="aside-card-err">{turn.error}</div>
        {/if}
        {#if turn === asking}
          <!-- The same moon a turn waits with (backlog 049): where the
               answer will be, and under the text while it arrives. -->
          <div class="aside-card-wait" role="status" aria-label="Waiting for the answer">
            <span class="roll" aria-hidden="true"><Icon name="moon" size={16} /></span>
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            {#if waiting}
              <!-- Blocker 317: one aside answers at a time; this one is
                   next in line, not stuck. -->
              <span class="aside-card-queued">waiting — one aside answers at a time</span>
            {/if}
          </div>
        {/if}
      {/each}
      {#if readOnly}
        <div class="aside-card-mark">
          This chat is not the open one — the thread reads as it was. Open the chat to follow up.
        </div>
      {:else if last && !asking && !onClaudeCode}
        <div class="aside-card-mark">Follow up on the Claude Code engine</div>
      {:else if last && !asking}
        <textarea
          class="aside-card-box"
          bind:this={followBox}
          value={unsent}
        oninput={typed}
          rows="1"
          placeholder="Follow up in the aside… (Enter asks)"
          aria-label="A follow-up in the aside"
          onkeydown={followKeys}
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        ></textarea>
        <div class="aside-card-row">
          <button
            class="ns-btn small"
            disabled={!unsent.trim()}
            use:tip={"Continue the aside: the exchanges above go with this question, off the chat's context; recorded nowhere"}
            onclick={submitFollowUp}
          >
            Follow up
          </button>
        </div>
      {/if}
    {/if}
  </div>
  {/if}
</div>

{#if zone}<MoveZone {zone} />{/if}

<style>
  /* The card: the sheet's face, raised over the transcript, dashed as the
     foot card was so it never reads as a turn. */
  .aside-card {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    background: var(--sheet);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 14px);
    color: var(--ink);
    z-index: 5;
    animation: aside-card-in 150ms ease-out;
  }
  .aside-card.floating {
    position: absolute;
  }
  /* In the side panel (141 pass 2): static, the column's full height, the
     panel's frame is the chrome — no shadow, no entrance. */
  .aside-card.panel {
    position: static;
    flex: 1;
    min-height: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
    animation: none;
    background: transparent;
  }
  /* Above the composer (blocker 225): the column's last child, stuck to
     the viewport's foot, so it stays while he scrolls up to read. */
  .aside-card.foot {
    position: sticky;
    bottom: 8px;
    align-self: flex-end;
    width: min(440px, 100%);
    max-height: 50vh;
  }
  /* Folded (blocker 318): the head row alone, a strip that opens on a
     click. */
  .aside-card.folded {
    max-height: none;
  }
  .aside-card.folded .aside-card-head {
    border-bottom: none;
    cursor: pointer;
  }
  .aside-card-queued {
    font-size: 12px;
  }
  @keyframes aside-card-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .aside-card {
      animation: none;
    }
  }
  .aside-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    /* One row, always (nightshift backlog 191): a moved card adds *back*,
       and wrapping pushed × onto a line of its own. The chips give way
       with an ellipsis; the grip and the buttons never shrink. */
    flex-wrap: nowrap;
    min-width: 0;
    padding: 8px 8px 6px 10px;
    border-bottom: 1px solid var(--line);
    cursor: default;
  }
  .aside-card-head .spacer {
    flex: 1;
  }
  .aside-card-head > .ns-chip {
    display: block;
    min-width: 0;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aside-card-head > .aside-card-grip,
  .aside-card-head > .ns-btn {
    flex-shrink: 0;
  }
  .aside-card-grip {
    color: var(--dim);
    font-size: 12px;
    letter-spacing: -2px;
    opacity: 0.4;
  }
  .aside-card-grip.live {
    opacity: 1;
    cursor: grab;
  }
  .aside-card-head[draggable="true"],
  .aside-card-head.movable {
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  /* Moved (backlog 156): fixed to the window, out of the column's flow,
     over the panes and their strips. */
  .aside-card.moved {
    position: fixed;
    bottom: auto;
    z-index: 15;
    animation: none;
  }
  .aside-card.holding {
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4);
  }
  .aside-card.holding .aside-card-head {
    cursor: grabbing;
  }
  /* Over a zone the card thins, so the lit zone under it reads. */
  .aside-card.over-zone {
    opacity: 0.72;
  }
  .aside-card-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    overflow-y: auto;
    min-height: 0;
  }
  .aside-card-q {
    display: flex;
    justify-content: flex-end;
  }
  .aside-card-qtext {
    max-width: 85%;
    padding: 7px 11px;
    border-radius: 12px 12px 4px 12px;
    background: var(--well);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .aside-card-a {
    line-height: 1.55;
  }
  .aside-card-mark,
  .aside-card-err {
    font-size: 12px;
    color: var(--dim);
  }
  .aside-card-err {
    color: var(--failed, #d66);
  }
  .aside-card-wait {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--dim);
    height: 22px;
  }
  .aside-card-wait .roll {
    display: inline-flex;
    animation: aside-card-roll 1.6s linear infinite;
  }
  .aside-card-wait .dots {
    display: none;
  }
  @keyframes aside-card-roll {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .aside-card-wait .roll {
      display: none;
    }
    .aside-card-wait .dots {
      display: inline-flex;
      gap: 4px;
    }
    .aside-card-wait .dots i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--dim);
    }
  }
  .aside-card-box {
    /* Never shrink below its rows (nightshift backlog 179, 2026-09-22): a
       textarea is a scroll container, so in a scrolling flex column its
       minimum height is 0 and a long answer squashed it to a sliver. */
    flex-shrink: 0;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: 7px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--well);
    color: var(--ink);
    font: inherit;
    line-height: 1.4;
  }
  .aside-card-box:focus {
    outline: none;
    border-color: var(--accent);
  }
  .aside-card-row {
    display: flex;
    gap: 8px;
  }
</style>
