<script lang="ts">
  import { app, asideAsking, asideOf, dismissAside, followUpAside } from "./state.svelte";
  import { quoteLabel } from "./asideQuote";
  import { renderMarkdown } from "./markdown";
  import Icon from "./Icon.svelte";

  /**
   * An aside thread as a tab of its own (nightshift backlog 130 part 2,
   * 2026-09-17; blocker 194): the same thread the transcript's card
   * draws — the open chat's `app.aside`, or a stashed thread of a chat
   * that is not open — read from where it lives, never copied. While
   * this tab exists the transcript hides its card, and closing the tab
   * shows the card again; nothing enters the chat either way.
   *
   * A follow-up is offered only while the tab's chat is the open one:
   * the backend forks the *open* chat for an aside, so a follow-up from
   * another chat's tab would be answered from the wrong context. The
   * thread of a chat that is not open reads as it was, with a line
   * saying where to continue it.
   */
  let { session }: { session: string } = $props();

  const aside = $derived(asideOf(session));
  const open = $derived(session === app.activeSessionId);
  const asking = $derived(asideAsking(aside));
  const last = $derived(aside?.turns[aside.turns.length - 1] ?? null);
  const chatName = $derived.by(() => {
    const s = app.sessions.find((x) => x.id === session);
    return s?.title ?? s?.first_user ?? session.slice(0, 8);
  });

  let followDraft = $state("");
  function submitFollowUp() {
    const q = followDraft.trim();
    if (!q || !open || !aside || aside.draft || asking) return;
    followDraft = "";
    void followUpAside(q);
  }
  function followKeys(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitFollowUp();
    }
  }
</script>

<div class="aside-view" role="note" aria-label="aside, not part of the chat">
  <div class="aside-view-head">
    <span class="ns-chip mono">aside · not in the chat</span>
    <span class="ns-chip mono" title="The chat this side conversation is beside">{chatName}</span>
    {#if aside?.quote}
      <span class="ns-chip mono">about {quoteLabel(aside.quote, "card")}</span>
    {/if}
    {#if last && last.answer !== null && last.cacheRead > 0}
      <span class="ns-chip mono">{last.cacheRead.toLocaleString()} read from cache</span>
    {/if}
    <span class="spacer"></span>
    {#if open && aside}
      <button
        class="ns-btn ghost small"
        title={asking ? "Stop the answer here; what has arrived stays" : "Dismiss the aside — the thread ends"}
        onclick={dismissAside}>×</button
      >
    {/if}
  </div>
  {#if !aside}
    <p class="aside-view-hint">
      No aside on this chat. Ask one from the composer's <em>Ask aside</em>, or highlight a passage in the
      transcript.
    </p>
  {:else}
    {#if !open}
      <p class="aside-view-hint">
        This chat is not the open one — the thread reads as it was. Open the chat to follow up.
      </p>
    {/if}
    {#if aside.quote}
      <blockquote class="aside-view-quote" title="The passage he highlighted, sent with the question exactly as selected">{aside.quote.text}</blockquote>
    {/if}
    {#if aside.draft}
      <p class="aside-view-hint">A question about the passage is being typed in the chat.</p>
    {:else}
      <div class="aside-view-turns">
        {#each aside.turns as turn (turn.seq)}
          <div class="aside-view-q"><div class="aside-view-qtext">{turn.question}</div></div>
          {#if turn.partial}
            <div class="aside-view-a markdown">{@html renderMarkdown(turn.partial)}</div>
          {/if}
          {#if turn.cancelled}
            <div class="aside-view-mark">stopped here</div>
          {/if}
          {#if turn.error}
            <div class="aside-view-err">{turn.error}</div>
          {/if}
          {#if turn === asking}
            <div class="aside-view-wait" role="status" aria-label="Waiting for the answer">
              <span class="roll" aria-hidden="true"><Icon name="moon" size={16} /></span>
              <span>thinking…</span>
            </div>
          {/if}
        {/each}
      </div>
      {#if open && last && !asking}
        <textarea
          class="aside-view-box"
          bind:value={followDraft}
          rows="2"
          placeholder="Follow up in the aside… (Enter asks)"
          aria-label="A follow-up in the aside"
          onkeydown={followKeys}
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        ></textarea>
        <div class="aside-view-row">
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
  {/if}
</div>

<style>
  .aside-view {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 14px);
    color: var(--ink);
  }
  .aside-view-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .aside-view-head .spacer {
    flex: 1;
  }
  .aside-view-hint {
    margin: 0;
    color: var(--dim);
    font-size: 13px;
  }
  .aside-view-quote {
    margin: 0;
    padding: 6px 10px;
    border-left: 3px solid var(--line2);
    color: var(--ink2);
    font-size: 13px;
    white-space: pre-wrap;
  }
  .aside-view-turns {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 760px;
  }
  .aside-view-q {
    display: flex;
    justify-content: flex-end;
  }
  .aside-view-qtext {
    max-width: 80%;
    padding: 8px 12px;
    border-radius: 12px 12px 4px 12px;
    background: var(--well);
    color: var(--ink);
    white-space: pre-wrap;
  }
  .aside-view-a {
    line-height: 1.55;
  }
  .aside-view-mark,
  .aside-view-err {
    font-size: 12px;
    color: var(--dim);
  }
  .aside-view-err {
    color: var(--failed, #d66);
  }
  .aside-view-wait {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--dim);
    font-size: 13px;
  }
  .aside-view-wait .roll {
    display: inline-flex;
    animation: aside-view-roll 1.6s linear infinite;
  }
  @keyframes aside-view-roll {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .aside-view-wait .roll {
      animation: none;
    }
  }
  .aside-view-box {
    max-width: 760px;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--sheet);
    color: var(--ink);
    font: inherit;
  }
  .aside-view-row {
    display: flex;
    gap: 8px;
  }
</style>
