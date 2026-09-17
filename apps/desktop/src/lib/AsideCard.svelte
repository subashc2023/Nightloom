<script lang="ts">
  import { app, askAside, asideAsking, dismissAside, endContentDrag, followUpAside, startContentDrag } from "./state.svelte";
  import { tick } from "svelte";
  import type { Aside } from "./state.svelte";
  import type { Placement } from "./asideCard";
  import { quoteLabel } from "./asideQuote";
  import { renderMarkdown } from "./markdown";
  import Icon from "./Icon.svelte";

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
   */
  let {
    aside,
    placement,
    panel = false,
    session = null,
  }: {
    aside: Aside;
    placement: Placement | null;
    panel?: boolean;
    /** The panel's chat; the floating card's is always the open one. */
    session?: string | null;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);
  let askBox = $state<HTMLTextAreaElement | null>(null);
  let askDraft = $state("");
  let followDraft = $state("");
  let copied = $state(false);

  const asking = $derived(asideAsking(aside));
  const last = $derived(aside.turns[aside.turns.length - 1] ?? null);
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  /** The chat the thread belongs to: the panel's, else the open one. */
  const owner = $derived(panel ? session : app.activeSessionId);
  const readOnly = $derived(panel && session !== app.activeSessionId);
  // A draft drags too (backlog 148, his ask on 5847cca): the card sits
  // under the passage and can cover what he is reading before a word is
  // typed; the tab and the panel draw the question box for a draft.
  const draggable = $derived(owner !== null);

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
    const q = askDraft.trim();
    if (!q || !aside.quote || !aside.draft) return;
    askDraft = "";
    void askAside(q, aside.quote);
  }
  function askKeys(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAsk();
    }
  }
  function submitFollowUp(): void {
    const q = followDraft.trim();
    if (!q || aside.draft || asking) return;
    followDraft = "";
    void followUpAside(q);
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
    if (panel) app.asidePanel = null;
    else dismissAside();
  }
  /** Escape elsewhere: ours unless another text field has it. The
   *  panel does not claim it — a panel is furniture, not a popover. */
  function windowKeys(e: KeyboardEvent): void {
    if (panel || e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && root?.contains(t)) return; // `cardKeys` had it
    const tag = (t?.tagName ?? "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    dismissAside();
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
      await navigator.clipboard.writeText(text);
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
  class:panel
  class:above={placement?.side === "above"}
  role="note"
  aria-label="aside, not part of the chat"
  bind:this={root}
  style:top={placement ? `${placement.top}px` : undefined}
  style:left={placement ? `${placement.left}px` : undefined}
  style:width={placement ? `${placement.width}px` : undefined}
  style:max-height={placement ? `${placement.maxHeight}px` : undefined}
  onkeydown={cardKeys}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="aside-card-head"
    {draggable}
    title={draggable
      ? panel
        ? "Drag onto a tab strip for a tab of its own"
        : "Drag onto a tab strip for a tab of its own, or to the window's right edge for a side panel"
      : undefined}
    ondragstart={(e) => {
      if (!draggable || owner === null) return;
      startContentDrag(e, { kind: "aside", session: owner });
    }}
    ondragend={endContentDrag}
  >
    <span class="aside-card-grip" aria-hidden="true" class:live={draggable}>⋮⋮</span>
    <span class="ns-chip mono">aside · not in the chat</span>
    {#if aside.quote}
      <span class="ns-chip mono" title="The highlighted passage, sent with the question exactly as selected">about {quoteLabel(aside.quote, "card")}</span>
    {/if}
    {#if last && last.answer !== null && last.cacheRead > 0}
      <span class="ns-chip mono">{last.cacheRead.toLocaleString()} read from cache</span>
    {/if}
    <span class="spacer"></span>
    {#if last && last.partial.trim()}
      <button
        class="ns-btn ghost small"
        title={aside.turns.length > 1 ? "Copy the thread as text" : "Copy the answer as text"}
        onclick={() => void copy()}>{copied ? "Copied" : "Copy"}</button
      >
    {/if}
    {#if !readOnly}
      <button
        class="ns-btn ghost small"
        title={(aside.draft
          ? "Close without asking"
          : asking
            ? "Stop the answer here; what has arrived stays"
            : "Dismiss the aside — the thread ends") + (panel ? "" : " (Escape)")}
        onclick={dismissAside}>×</button
      >
    {/if}
  </div>
  <div class="aside-card-body" bind:this={body} onscroll={bodyScrolled}>
    {#if aside.draft}
      <textarea
        class="aside-card-box"
        bind:this={askBox}
        bind:value={askDraft}
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
          disabled={!askDraft.trim()}
          title="Ask this about the passage, off the chat's context: no changes, recorded nowhere"
          onclick={submitAsk}
        >
          Ask aside
        </button>
        <button class="ns-btn ghost small" onclick={dismissAside}>Cancel</button>
      </div>
    {:else}
      {#each aside.turns as turn (turn.seq)}
        <div class="aside-card-q"><div class="aside-card-qtext">{turn.question}</div></div>
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
          bind:value={followDraft}
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
            disabled={!followDraft.trim()}
            title="Continue the aside: the exchanges above go with this question, off the chat's context; recorded nowhere"
            onclick={submitFollowUp}
          >
            Follow up
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>

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
    flex-wrap: wrap;
    padding: 8px 8px 6px 10px;
    border-bottom: 1px solid var(--line);
    cursor: default;
  }
  .aside-card-head .spacer {
    flex: 1;
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
  .aside-card-head[draggable="true"] {
    cursor: grab;
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
