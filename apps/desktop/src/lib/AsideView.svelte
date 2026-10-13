<script lang="ts">
  import { tip } from "./tip";
  import { app, asideAsking, asideOf, asideTabThread } from "./state.svelte";
  import { quoteLabel } from "./asideQuote";
  import Icon from "./Icon.svelte";
  import { tick, untrack } from "svelte";
  // Backlog 283: the chat's composer and message pieces.
  import Composer from "./Composer.svelte";
  import AsideThread from "./AsideThread.svelte";
  import { asideScrollKey, recallScroll, rememberScroll, restoreTop } from "./scroll.svelte";
  import { asideLabel } from "./asides";
  import { renameAside } from "./asides.svelte";
  import { closeAsideToChat } from "./asideSidebar.svelte";
  import AsideNameEdit from "./AsideNameEdit.svelte";
  import AsideFoldPanel from "./AsideFoldPanel.svelte";
  import * as tabs from "./tabs";

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
  const open = $derived(session === app.activeSessionId);
  const asking = $derived(asideAsking(aside));
  const last = $derived(aside?.turns[aside.turns.length - 1] ?? null);
  // The tab this view is drawn in, for the Close's way back (item 266).
  const myTab = $derived(
    tabs
      .allTabs(app.tabs)
      .find(
        (t) =>
          t.content.kind === "aside" &&
          t.content.session === session &&
          (asideTabThread(t.content) ?? null) === (thread ?? null),
      )?.id ?? null,
  );
  let naming = $state(false);
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

  // ~~The tab's own box (`AsideBox`, `asideComposer`), `submitAsk` /
  // `submitFollowUp`~~ — the chat's composer since backlog 283 (`Composer`
  // with `aside`): the same box for the first question and every
  // follow-up (238's rule), now with the chat's controls; it types on a
  // chat that is not the open one and says to open it, as before.
</script>

<div class="aside-view" role="note" aria-label="aside, not part of the chat">
  <div class="aside-view-scroll" bind:this={view} onscroll={scrolled}>
    {#if aside}
      <!-- The thread's name (item 265): his, or its first question until
           he names it; a click renames it, here as in the sidebar and the
           asides list. -->
      <div class="aside-view-title">
        {#if naming}
          <AsideNameEdit
            value={aside.name ?? ""}
            placeholder={asideLabel({ ...aside, name: undefined })}
            oncommit={(v) => {
              naming = false;
              renameAside(aside, v);
            }}
            oncancel={() => (naming = false)}
          />
        {:else}
          <button class="aside-view-name" class:unnamed={!aside.name} use:tip={"Rename this aside"} onclick={() => (naming = true)}
            >{asideLabel(aside, 120)}</button
          >
        {/if}
      </div>
    {/if}
    <div class="aside-view-head">
      <span class="aside-view-of" use:tip={"An aside: answered from this chat's context, never part of it"}
        >Aside of <em>{chatName}</em></span
      >
      {#if aside?.quote}
        <span class="ns-chip mono">about {quoteLabel(aside.quote, "card")}</span>
      {/if}
      {#if last && last.answer !== null && last.cacheRead > 0}
        <span class="ns-chip mono">{last.cacheRead.toLocaleString()} read from cache</span>
      {/if}
      <span class="spacer"></span>
      {#if aside}
        <!-- Fold into thread (nightshift backlog 282). -->
        <AsideFoldPanel {aside} part="button" {open} />
      {/if}
      {#if aside}
        <!-- ~~× (only while the chat was open): "Dismiss the aside — the
             thread ends"~~ — item 266 (2026-09-29, blocker 640): Close, on
             every aside tab, moves the thread to the chat's Past list (the
             card's ×) and takes him back to the chat it came from. -->
        <button
          class="ns-btn ghost small aside-view-close"
          use:tip={asking
            ? "Stop the answer, move this aside to the chat's Past list, and go back to the chat"
            : "Close this aside — it moves to the chat's Past list, reopenable — and go back to the chat"}
          onclick={() => closeAsideToChat(session, aside, myTab)}><Icon name="x" size={12} /> Close</button
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
          <AsideThread {aside} {open} />
          <AsideFoldPanel {aside} part="panel" {open} />
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
        <!-- Since backlog 283 the chat's composer, in the aside's frame. -->
        <Composer {aside} asideChat={session} takeFocus />
      </div>
    </div>
  {/if}
</div>

<style>
  /* The tab: the thread scrolls, the composer stays at the foot (238). */
  .aside-view {
    /* The aside's face (backlog 283), as the card's: the page tinted
       toward the accent and a dashed accent rule over the composer, so a
       tab of an aside never reads as a chat now their controls match. */
    --aside-tint: color-mix(in srgb, var(--paper) 89%, var(--accent));
    --aside-edge: color-mix(in srgb, var(--accent) 50%, var(--line2));
    --aside-well: color-mix(in srgb, var(--sheet) 94%, var(--accent));
    --user-bubble-bg: color-mix(in srgb, var(--aside-tint) 86%, var(--ink));
    background: var(--aside-tint);
    box-shadow: inset 3px 0 0 var(--aside-edge);
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
    padding: 2px 24px 14px;
    border-top: 1px dashed var(--aside-edge);
    background: var(--aside-tint);
  }
  .aside-view-foot-inner {
    max-width: 760px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .aside-view-title {
    display: flex;
    min-width: 0;
  }
  .aside-view-name {
    max-width: 100%;
    padding: 2px 6px;
    margin-left: -6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: text;
  }
  .aside-view-name.unnamed {
    color: var(--ink2);
    font-weight: 500;
  }
  .aside-view-name:hover {
    background: var(--well);
  }
  .aside-view-close {
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
  /* ~~`.aside-view-q` / `-a` / `-wait`~~ — `AsideThread.svelte` since
     backlog 283; the box is the chat's composer. */
  .aside-view-of {
    font-size: 12.5px;
    color: var(--ink2, var(--dim));
  }
  .aside-view-of em {
    font-style: normal;
    font-weight: 600;
    color: var(--ink);
  }
</style>
