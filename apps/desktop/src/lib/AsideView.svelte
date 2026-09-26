<script lang="ts">
  import { tip } from "./tip";
  import { app, asideAsking, asideOf, asideWaiting, askAside, followUpAside, openContent, requestDismissAside, setAsideUnsent } from "./state.svelte";
  import { quoteLabel } from "./asideQuote";
  import { renderMarkdown } from "./markdown";
  import { arrive, launch } from "./sendMotion";
  import Icon from "./Icon.svelte";
  import AsideBox from "./AsideBox.svelte";
  import { tick, untrack } from "svelte";
  import { scheduleAsideSave } from "./asides.svelte";
  import { asideComposer } from "./asideComposer";
  import { asideScrollKey, recallScroll, rememberScroll, restoreTop } from "./scroll.svelte";

  /**
   * An aside thread as a tab of its own (nightshift backlog 130 part 2,
   * 2026-09-17; blocker 194): the same thread the transcript's card
   * draws — the open chat's `app.aside`, or a stashed thread of a chat
   * that is not open — read from where it lives, never copied. While
   * this tab exists the transcript hides its card, and closing the tab
   * shows the card again; nothing enters the chat either way.
   *
   * A follow-up is ~~offered~~ sent only while the tab's chat is the open
   * one: the backend forks the *open* chat for an aside, so a follow-up
   * from another chat's tab would be answered from the wrong context.
   * ~~The thread of a chat that is not open reads as it was, with a line
   * saying where to continue it.~~ Since backlog 238 (2026-09-26) the
   * composer at the foot is there regardless — he can type — and its line
   * says to open the chat, with a button that does; only Send waits.
   *
   * Several threads per chat since backlog 176 (2026-09-23): the tab
   * names its `thread`, so two aside tabs show two threads; a tab made
   * without one shows the chat's front (newest) thread, as before. Every
   * action is this thread's.
   */
  let { session, thread = null }: { session: string; thread?: number | null } = $props();

  const aside = $derived(asideOf(session, thread));
  const waiting = $derived(asideWaiting(aside));
  const open = $derived(session === app.activeSessionId);
  const asking = $derived(asideAsking(aside));
  const last = $derived(aside?.turns[aside.turns.length - 1] ?? null);
  const chatName = $derived.by(() => {
    const s = app.sessions.find((x) => x.id === session);
    return s?.title ?? s?.first_user ?? session.slice(0, 8);
  });

  // Where he was in the thread (nightshift backlog 237, 2026-09-26): the
  // tab unmounts when another tab takes its pane, and came back at the
  // top. The place is kept per thread in 065's scroll map, written as he
  // scrolls and put back when the view mounts or shows another thread.
  let view = $state<HTMLDivElement | null>(null);
  const viewKey = $derived(aside ? asideScrollKey(session, aside.id) : null);
  function scrolled() {
    if (!view || !viewKey) return;
    rememberScroll(viewKey, view.scrollTop, view.scrollHeight - view.scrollTop - view.clientHeight < 4);
  }
  $effect(() => {
    const key = viewKey;
    const el = view;
    if (!key || !el) return;
    untrack(() => {
      void tick().then(() => {
        const top = restoreTop(recallScroll(key), el.scrollHeight, el.clientHeight);
        if (top !== null) el.scrollTop = top;
      });
    });
  });

  // A draft dragged into the tab before anything was asked (backlog 148):
  // the box is here, the send is the card's own `askAside`, which reads the
  // open chat's aside — so it asks only while this tab's chat is the open one.
  // ~~`askDraft` / `followDraft` here~~ — the thread's own `unsent` since
  // backlog 228, shared with its card and written with the thread.
  const unsent = $derived(aside?.unsent ?? "");
  function typed(e: Event) {
    if (!aside) return;
    setAsideUnsent(aside, (e.currentTarget as HTMLTextAreaElement).value);
    // A stashed thread (its chat not the open one) is not watched by the
    // keeper's effect; tell it (backlog 238, 228's rule).
    if (!open) scheduleAsideSave();
  }
  // One box since backlog 238: the tab's composer, for the first question
  // and every follow-up.
  let box = $state<HTMLTextAreaElement | null>(null);
  const composer = $derived(
    asideComposer(aside, { open, asking: !!asking, claudeCode: app.connection?.engine === "claude-code", text: unsent }),
  );
  function send() {
    if (aside?.draft) submitAsk();
    else submitFollowUp();
  }
  function sendKeys(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
  function submitAsk() {
    const q = unsent.trim();
    if (!q || !open || !aside || !aside.draft) return;
    // Off the Claude Code engine the ask does nothing; the text stays (228).
    if (app.connection?.engine !== "claude-code") return;
    launch("aside", box);
    setAsideUnsent(aside, "");
    void askAside(q, aside.quote, aside);
  }

  function submitFollowUp() {
    const q = unsent.trim();
    if (!q || !open || !aside || aside.draft || asking) return;
    // Off the Claude Code engine the ask does nothing; the text stays (228).
    if (app.connection?.engine !== "claude-code") return;
    launch("aside", box);
    setAsideUnsent(aside, "");
    void followUpAside(q, aside);
  }
</script>

<div class="aside-view" role="note" aria-label="aside, not part of the chat">
  <div class="aside-view-scroll" bind:this={view} onscroll={scrolled}>
    <div class="aside-view-head">
      <span class="ns-chip mono">aside · not in the chat</span>
      <span class="ns-chip mono" use:tip={"The chat this side conversation is beside"}>{chatName}</span>
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
          use:tip={asking ? "Stop the answer here; what has arrived stays" : "Dismiss the aside — the thread ends"}
          onclick={() => requestDismissAside(aside)}>×</button
        >
      {/if}
    </div>
    {#if !aside}
      <p class="aside-view-hint">
        No aside on this chat. Ask one from the composer's <em>Ask aside</em>, or highlight a passage in the
        transcript.
      </p>
    {:else}
      {#if aside.quote}
        <blockquote class="aside-view-quote" use:tip={"The passage he highlighted, sent with the question exactly as selected"}>{aside.quote.text}</blockquote>
      {/if}
      {#if !aside.draft}
        <div class="aside-view-turns">
          {#each aside.turns as turn (turn.seq)}
            <div class="aside-view-q" use:arrive={{ channel: "aside", bubble: ".aside-view-qtext" }}><div class="aside-view-qtext">{turn.question}</div></div>
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
                <span>{waiting ? "waiting — one aside answers at a time" : "thinking…"}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
  {#if aside}
    <!-- The tab's composer (nightshift backlog 238, 2026-09-26, his words:
         "a similar text box at the bottom of the screen with the send
         button for the aside"): fixed under the thread, always there — on
         first open, between exchanges, while an answer streams, and on a
         chat that is not the open one — where the Follow-up box used to
         sit at the thread's end, drawn only while this tab's chat was the
         open one and no answer ran. The text is the thread's own `unsent`
         (228), so it survives a tab switch and a relaunch; only Send takes
         it. -->
    <div class="aside-view-foot">
      <div class="aside-view-foot-inner">
        <AsideBox
          bind:box
          variant="view"
          edge="top"
          value={unsent}
          oninput={typed}
          onkeydown={sendKeys}
          placeholder={aside.draft
            ? aside.quote
              ? "Ask about the passage… (Enter sends)"
              : "Ask aside… (Enter sends)"
            : "Follow up in the aside… (Enter sends)"}
          label={aside.draft ? "Your question about the highlighted passage" : "A follow-up in the aside"}
        />
        <div class="aside-view-foot-row">
          {#if composer.note === "not-open"}
            <span class="aside-view-foot-note"
              >An aside answers from its chat's context, so it sends only while <em>{chatName}</em> is the open chat.</span
            >
            <button class="ns-btn ghost small" onclick={() => void openContent({ kind: "chat", session }, "new")}
              >Open the chat</button
            >
          {:else if composer.note === "answering"}
            <span class="aside-view-foot-note">Sends when this answer ends.</span>
          {:else if composer.note === "engine"}
            <span class="aside-view-foot-note">Asides run on the Claude Code engine.</span>
          {:else if composer.note === "ready"}
            <!-- Backlog 240: the bar keeps a line once the chat is open (after
                 Open the chat), instead of dropping to a bare Send. -->
            <span class="aside-view-foot-note"
              >Answers from <em>{chatName}</em>'s context; nothing here enters the chat.</span
            >
          {/if}
          <span class="spacer"></span>
          <button
            class="ns-btn accent small aside-view-send"
            disabled={!composer.canSend}
            use:tip={aside.draft
              ? "Ask this about the passage, off the chat's context: no changes, recorded nowhere"
              : "Continue the aside: the exchanges above go with this question, off the chat's context; recorded nowhere"}
            onclick={send}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* The tab: the thread scrolls, the composer stays at the foot (238). */
  .aside-view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 14px);
    color: var(--ink);
  }
  .aside-view-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .aside-view-foot {
    flex: none;
    padding: 10px 24px 14px;
    border-top: 1px solid var(--line);
    background: var(--paper);
  }
  .aside-view-foot-inner {
    max-width: 760px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .aside-view-foot-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
  }
  .aside-view-foot-row .spacer {
    flex: 1;
  }
  .aside-view-foot-note {
    color: var(--dim);
    font-size: 12px;
  }
  .aside-view-send {
    padding: 4px 16px;
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
  /* The question box is `AsideBox.svelte` since backlog 226 (it keeps
     backlog 170's no-sideways-scroll rule). ~~`.aside-view-row`, the Ask
     aside / Follow up row~~ — the foot's row since backlog 238. */
</style>
