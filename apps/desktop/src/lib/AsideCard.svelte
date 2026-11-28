<script lang="ts">
  import { chatLabel } from "./chatLabel";
  import { tip } from "./tip";
  import { renderReply } from "./markdown";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  import {
    app,
    asideAsking,
    asideWaiting,
    dropContent,
    requestDismissAside,
    endContentDrag,
    startContentDrag,
    unfoldAside,
  } from "./state.svelte";
  import type { TabContent } from "./tabs";
  import { outcome, startMove } from "./floatingMove";
  import { cardPosition, landMoved, placeMoved } from "./asideMove";
  import { expandAside, minimizeAside } from "./state/asides.svelte";
  import { foldMotion } from "./foldMotion";
  import { asideLabel } from "./asides";
  import type { Zone } from "./floatingMove";
  import { tick } from "svelte";
  import { asideCardScrollKey } from "./scroll.svelte";
  import type { Aside } from "./state.svelte";
  import { footCardMax, type Placement } from "./asideCard";
  import MoveZone from "./MoveZone.svelte";
  import AsideFoldPanel from "./AsideFoldPanel.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { COPIED_MS } from "./copyIcon";
  // Backlog 283: the chat's composer and the chat's message pieces.
  import Composer from "./Composer.svelte";
  import StartCards from "./StartCards.svelte";
  import { isHome } from "./home";
  // Item 674: the thread is the chat's transcript; Classic's too since item
  // 856 (it kept `AsideThread` until then, blocker 1989).
  import AsideTranscript from "./AsideTranscript.svelte";
  import { fmtTokens } from "./tokens";
  // Item 886: the chat's running sign, given this aside.
  import ChatRunSign from "./ChatRunSign.svelte";
  import { firstFit, onOneLine } from "./fold";

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
   * nudge of a few pixels included — ~~fixed to the window~~ (struck
   * 2026-11-16, item 734: fixed, it stopped scrolling with the chat) kept
   * in the chat column beside its passage and scrolling with the text as
   * an unmoved card does (`asideMove.ts`), the passage still marked. While
   * the pointer holds it, it is drawn over the window so a zone can light. Only near a tab strip (a tab of its own), the window's
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
    footCount = 1,
    footRoom = 0,
    frame = null,
    viewport = null,
    passageTop = null,
    frameWidth = 0,
  }: {
    aside: Aside;
    placement: Placement | null;
    panel?: boolean;
    /** The panel's chat; the floating card's is always the open one. */
    session?: string | null;
    /** The card an Escape from elsewhere in the window closes (176). */
    front?: boolean;
    /** Several composer cards (176): ~~this one's `bottom` in the sticky
     *  stack above the composer — the heights of the cards below it —~~
     *  (struck 2026-11-27, item 1035: the cards are in the column's flow,
     *  not stuck, so the `footBottom` prop is gone) how many share the
     *  stack's room. */
    footCount?: number;
    /** Item 1008: the transcript viewport's height, the room a composer
     *  card grows into (`footCardMax`); 0 while unmeasured. */
    footRoom?: number;
    /** Item 734: the chat column the card is drawn in (the transcript's
     *  `inner`) and its scrolled viewport; a drop is kept in the column's
     *  px. Null for the panel's card, which does not move. */
    frame?: HTMLElement | null;
    viewport?: HTMLElement | null;
    /** The passage's top in the column's px (null: none, or not found),
     *  and the column's width, as `AsideLayer` measured them. */
    passageTop?: number | null;
    frameWidth?: number;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  // ~~`askBox` / `followBox`, `AsideBox` and its room~~ — the card's box
  // is the chat's composer since backlog 283 (`Composer` with `aside`),
  // pinned at the card's foot under the thread; its text, chips and held
  // messages are kept in the drafts store under the thread's key.
  let copied = $state(false);

  const asking = $derived(asideAsking(aside));
  /** Another aside is answering first (blocker 317): one at a time. */
  const waiting = $derived(asideWaiting(aside));
  const folded = $derived(!panel && aside.folded === true);
  /** Item 735: minimized to one line (never in the panel). */
  const minimized = $derived(!panel && aside.minimized === true);
  /** Item 1008: a composer card's cap — the viewport's room, not `50vh`. */
  const footMax = $derived(placement === null && !panel ? footCardMax(footRoom, footCount) : null);
  /** Item 755: minimize and expand with the short fold motion (foldMotion.ts), the hand-off card's too. */
  function minimizeMoving(): void {
    void foldMotion(root, async () => {
      minimizeAside(aside);
      await tick();
    });
  }
  function expandMoving(): void {
    void foldMotion(root, async () => {
      expandAside(aside);
      await tick();
    });
  }
  const miniLabel = $derived(asideLabel(aside, 40));
  const last = $derived(aside.turns[aside.turns.length - 1] ?? null);
  /** The chat the thread belongs to: the panel's, else the open one. */
  const owner = $derived(panel ? session : app.activeSessionId);
  const readOnly = $derived(panel && session !== app.activeSessionId);
  /** "Aside of ‹chat›" (backlog 283): the head names the chat it hangs off,
   *  so the card never reads as the chat itself. */
  const chatName = $derived.by(() => {
    if (!owner) return "this chat";
    const s = app.sessions.find((x) => x.id === owner);
    return chatLabel(s, "this chat");
  });
  /*
   * Item 833 (his shots, 2026-11-17): a narrow card's head ran its copy
   * and × past the card's right edge — one row, nothing shrinking but
   * "Aside of", which drew as "A.". The head now folds by measurement
   * (`fold.ts`, as the composer's row): 1 the cache chip's word ("222k",
   * the count's tooltip has the rest); 2 Fold into thread to its mark
   * (its tooltip and label keep the words); 3 "Aside of ‹chat›" out, once
   * it cannot show ~5em; 4 the floor — the head wraps rather than spill.
   */
  const HEAD_FOLD_MAX = 4;
  /** "Aside of ‹chat›" is kept only while it shows at least this much (px). */
  const OF_MIN = 64;
  let headEl = $state<HTMLElement | null>(null);
  let headFold = $state("0");
  function refoldHead(): void {
    const head = headEl;
    if (!head) return;
    const items = () => [...head.children].filter((e) => !e.classList.contains("spacer"));
    headFold = String(
      firstFit((level) => {
        head.dataset.fold = String(level);
        const r = head.getBoundingClientRect();
        const padRight = parseFloat(getComputedStyle(head).paddingRight) || 0;
        if (!onOneLine(items().map((e) => e.getBoundingClientRect()), r.right - padRight)) return false;
        const of = head.querySelector<HTMLElement>(".aside-card-of");
        return !of || of.offsetWidth === 0 || of.clientWidth >= Math.min(of.scrollWidth, OF_MIN);
      }, HEAD_FOLD_MAX),
    );
  }
  $effect(() => {
    const head = headEl;
    // What the head holds; each read registers the dependency.
    void [aside.name, chatName, folded, asking, last?.cacheRead, last?.partial.trim() !== "", readOnly, panel, aside.moved, app.project];
    refoldHead();
    if (!head || typeof ResizeObserver === "undefined") return;
    // The head and each thing in it: a chip that grows once its font loads
    // changes no head size, and a fold read before it was stale (measured:
    // "Aside of" left at 1 px in a 380 px card).
    const ro = new ResizeObserver(() => refoldHead());
    ro.observe(head);
    for (const c of head.children) ro.observe(c);
    void document.fonts?.ready.then(() => refoldHead());
    return () => ro.disconnect();
  });
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
  // Item 734: where a moved card is drawn, in the column's px (null while
  // its passage cannot be found — it goes home until it can).
  const moved = $derived(
    panel || !aside.moved
      ? null
      : placeMoved(aside.moved, frameWidth > 0 ? frameWidth : aside.moved.width, passageTop),
  );
  const pos = $derived(dragPos ?? moved);
  /** Item 1035: the card's `position`, from one pure rule (`cardPosition`)
   *  — never sticky, fixed only while held, so it scrolls with the text. */
  const position = $derived(
    cardPosition({ panel, holding: dragPos !== null, placed: placement !== null, moved: moved !== null }),
  );
  /** Whatever may change the card's room, so the box measures again. */

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
      // Item 734: kept in the chat column's px, so it scrolls with the text.
      const f = frame?.getBoundingClientRect();
      if (!f) return;
      const v = viewport?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      a.moved = landMoved(
        p,
        width,
        { left: f.left, top: f.top, width: f.width, height: f.height },
        { top: v.top, bottom: v.bottom },
        a.anchor ? passageTop : null,
      );
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

  // ~~The body's own follow, kept place, foot-hold and send jump (468, 502,
  // 233)~~ — Classic's `AsideThread` scroller's; since item 856 Classic draws
  // the thread through its transcript too, which does all four.
  /** The transcript puts the caret here once the card is placed. */
  export function focusBox(): void {
    const box = root?.querySelector<HTMLElement>(".composer textarea, .composer [contenteditable='true']");
    box?.focus({ preventScroll: true });
  }

  /** The card's own element, for the transcript to measure. */
  export function element(): HTMLElement | null {
    return root;
  }

  /** Escape inside the card: closed here, and stopped here. In the
   *  panel it is the way back, not the end of the thread. */
  function cardKeys(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // Item 853: an Escape the card's box already took (the slash menu, the
    // ghost, the maths bar, the clip ring, an offer) closes only that, as
    // in the chat's box — never the card too; nor one an input method
    // takes to cancel a composition.
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    // Item 674: a question the thread's transcript is asking (drop this
    // edit?) takes the Escape itself — it must never close the card with
    // a half-typed edit in it.
    if (root?.querySelector('[role="dialog"][aria-modal="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    // Item 735: a minimized line is not closed by Escape (nothing on it
    // says it would); the key still never reaches the window.
    if (minimized) return;
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
      setTimeout(() => (copied = false), COPIED_MS);
    } catch {
      // The clipboard refused; nothing to say.
    }
  }
</script>

<svelte:window onkeydown={windowKeys} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- Item 362 (review): a file dropped on the card outside its own box is
     refused, never handed to the chat's composer beneath it. -->
<div
  class="aside-card"
  data-drop-none
  class:floating={placement !== null}
  class:foot={placement === null && !panel}
  class:folded
  class:minimized
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
  style:width={minimized ? undefined : moved ? `${moved.width}px` : placement ? `${placement.width}px` : undefined}
  style:max-height={minimized
    ? undefined
    : dragPos
    ? `min(${placement ? `${placement.maxHeight}px` : "50vh"}, calc(100vh - ${dragPos.top + 8}px))`
    : moved
      ? placement
        ? `${placement.maxHeight}px`
        : "50vh"
      : placement
      ? `${placement.maxHeight}px`
      : !panel && footMax !== null
        ? `${footMax}px`
        : !panel && footCount > 1
          ? `max(200px, calc(60vh / ${footCount}))`
          : undefined}
  style:position={position}
  onkeydown={cardKeys}
>
  {#if minimized}
  <!-- Item 735 (blocker 2008): minimized, the card is this one line — its
       first words, and a dot when an answer landed since. A click opens it
       where it is; its line still moves by pointer (a move is not a click,
       `startMove` swallows it). -->
  <div
    class="aside-mini"
    class:movable
    role="button"
    tabindex="0"
    aria-label={`Aside: ${miniLabel}${aside.newReply ? " — new reply" : ""}. Open it`}
    use:tip={aside.newReply ? "A new reply landed — click to open the aside" : "Click to open the aside"}
    onpointerdown={headDown}
    onmousedown={headMouseDown}
    onclick={() => expandMoving()}
    onkeydown={(e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      expandMoving();
    }}
  >
    <span class="aside-mini-tag" aria-hidden="true">aside</span>
    <span class="aside-mini-label">{miniLabel}</span>
    {#if asking}
      <span class="aside-mini-state mono">{waiting ? "waiting" : "asking…"}</span>
    {/if}
    {#if aside.newReply}
      <span class="aside-mini-dot" aria-hidden="true"></span>
    {/if}
  </div>
  {:else}
  <!-- The strip's click is a pointer convenience; the keyboard has the
       *open* button a folded head carries. -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="aside-card-head"
    class:movable
    bind:this={headEl}
    data-fold={headFold}
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
    {#if aside.name}
      <!-- Its name (item 265), where he gave it one. -->
      <span class="ns-chip aside-card-name" use:tip={"This aside's name — rename it from the sidebar, the asides list or its tab"}>{aside.name}</span>
    {/if}
    <span class="aside-card-of" use:tip={"An aside: answered from this chat's context, never part of it"}
      >Aside of <em>{chatName}</em></span
    >
    <!-- Item 886: while it asks, the head says so as a chat's bar does —
         the same sign (Running · clock), folded or open; a question queued
         behind the chat's turn keeps its "waiting" chip. -->
    {#if asking && !waiting}
      <ChatRunSign {aside} session={owner} />
    {:else if folded && asking}
      <span class="ns-chip mono">waiting</span>
    {/if}
    <!-- ~~"about ‹passage›"~~ — not in the head since backlog 283: under
         its passage the passage is marked right above, and the panel
         quotes it at the top of the thread; the head's room goes to
         "Aside of ‹chat›". -->
    {#if last && last.answer !== null && last.cacheRead > 0}
      <!-- Short (backlog 358): the long "188,342 read from cache" lost the
           head's room and drew as "1…"; the full count is its tip. -->
      <span class="ns-chip mono aside-cache" use:tip={`${last.cacheRead.toLocaleString()} tokens read from cache`}
        >{fmtTokens(last.cacheRead)}<span class="head-word">{" "}cached</span></span
      >
    {/if}
    <span class="spacer"></span>
    {#if folded}
      <button class="ns-btn ghost small" use:tip={"Open this card again (the oldest other open card folds)"} onclick={() => unfoldAside(aside)}
        >open</button
      >
    {/if}
    {#if !panel}
      <!-- Item 735: minimize to one line, in place. -->
      <button
        class="ns-btn ghost small aside-card-min"
        aria-label="Minimize the aside"
        use:tip={"Minimize to one line — click it to open again"}
        onclick={() => minimizeMoving()}>–</button
      >
    {/if}
    {#if moved}
      <button
        class="ns-btn ghost small"
        use:tip={aside.anchor ? "Put the card back under its passage" : "Put the card back above the composer"}
        onclick={goHome}>back</button
      >
    {/if}
    {#if !folded}
      <!-- Fold into thread (nightshift backlog 282). -->
      <AsideFoldPanel {aside} part="button" open={!readOnly} />
    {/if}
    {#if last && last.partial.trim()}
      <CopyButton
        {copied}
        label={aside.turns.length > 1 ? "Copy the thread as text" : "Copy the answer as text"}
        onclick={() => void copy()}
      />
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
  {#if !aside.draft || panel}
    <!-- Item 674 (blocker 1990): the chat's own transcript in the card's
         room — the same turns, tools, folds and reading place as the tab
         and the chat; no ground and no rail in this frame. Classic too
         since item 856 (TranscriptClassic shares the logic). -->
    {#snippet quoted()}
      {#if aside.quote && panel}
        <!-- The passage it hangs off (283): under its passage the card
             needs none; in the side panel it is far from it. -->
        <blockquote class="aside-card-quote">{@html renderReply(aside.quote.text)}</blockquote>
      {/if}
    {/snippet}
    <div class="aside-card-body shared">
      {#key aside.uid ?? aside.id}
        <AsideTranscript
          {aside}
          open={!readOnly}
          {owner}
          frame="compact"
          scrollKey={asideCardScrollKey(owner ?? "", aside.id)}
          lead={quoted}
        />
      {/key}
    </div>
  {/if}
  <!-- The chat's composer (backlog 283), at the card's foot: the first
       question of a draft, every follow-up, chips, the model and effort
       pickers; in another chat's panel it types and its line says to open
       the chat (238's rule for the tab). -->
  <!-- Item 763 H5 (asides mirror the main chat): Home's Start cards over an aside's box too. -->
  {#if isHome(app.project)}<div class="aside-start-cards"><StartCards /></div>{/if}
  <div class="aside-card-foot" class:draft={aside.draft && !panel}>
    <Composer {aside} asideChat={owner} compact={!panel} />
  </div>
  {/if}
  {/if}
</div>

{#if zone}<MoveZone {zone} />{/if}

<style>
  /* The card: the sheet's face, raised over the transcript, dashed as the
     foot card was so it never reads as a turn. */
  .aside-card {
    /* The aside's own face (backlog 283, his "they should look visibly
       different"): the sheet tinted toward the accent, a dashed accent
       edge — the chat is never tinted, so the two never read alike even
       now the controls inside are the same. The composer and the thread
       inside read these. */
    --aside-tint: color-mix(in srgb, var(--sheet) 89%, var(--accent));
    --aside-edge: color-mix(in srgb, var(--accent) 50%, var(--line2));
    --aside-well: color-mix(in srgb, var(--well, var(--sheet)) 94%, var(--accent));
    --user-bubble-bg: color-mix(in srgb, var(--aside-tint) 86%, var(--ink));
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px dashed var(--aside-edge);
    border-radius: 10px;
    background: var(--aside-tint);
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
    /* The panel keeps the aside's tint (283): beside the chat, it must
       not read as a second chat. */
    background: var(--aside-tint);
  }
  /* Above the composer (blocker 225): the column's last child, ~~stuck to
     the viewport's foot, so it stays while he scrolls up to read~~ (struck
     2026-11-27, item 1035: "this fuckin aside is stuck on my screen") — in
     the column's flow at the chat's foot, so it scrolls with the text;
     several sit one under another (`cardPosition`, set inline too). */
  .aside-card.foot {
    position: relative;
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
  /* Minimized (item 735): one line in its place — the card's own frame
     around a row of its first words; Classic draws it plain, Jarvis as a
     pill (below). */
  .aside-card.minimized {
    width: max-content;
    max-width: min(340px, 100%);
    max-height: none;
    overflow: hidden;
  }
  .aside-card.foot.minimized {
    width: max-content;
  }
  .aside-mini {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 4px 10px;
    font-size: 12px;
    line-height: 18px;
    color: var(--ink);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  .aside-mini:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .aside-mini-tag {
    flex-shrink: 0;
    color: var(--dim);
    font-size: 11px;
  }
  .aside-mini-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aside-mini-state {
    flex-shrink: 0;
    color: var(--dim);
    font-size: 11px;
  }
  .aside-mini-dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
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
  /* Item 833: the head's fold levels (`refoldHead`). */
  .aside-card-head:not([data-fold="0"]) .head-word {
    display: none;
  }
  .aside-card-head:is([data-fold="2"], [data-fold="3"], [data-fold="4"]) :global(.fold-btn-word) {
    display: none;
  }
  .aside-card-head:is([data-fold="3"], [data-fold="4"]) .aside-card-of {
    display: none;
  }
  /* The floor: wrap rather than run past the card's edge (191's one row
     holds down to the narrowest card the levels above can fit). */
  .aside-card-head[data-fold="4"] {
    flex-wrap: wrap;
    row-gap: 4px;
    /* What wraps (×, Copy) keeps the right edge, where the hand looks. */
    justify-content: flex-end;
  }
  .aside-card-name {
    font-weight: 600;
    max-width: 11em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
  .aside-card-head > .ns-btn,
  .aside-card-head > .aside-cache {
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
  /* Moved (backlog 156): ~~fixed to the window, out of the column's flow,
     over the panes and their strips~~ (struck 2026-11-16, item 734) — in
     the column, placed in its px as an unmoved card is, so it scrolls with
     the text; over the window only while the pointer holds it. */
  .aside-card.moved {
    position: absolute;
    bottom: auto;
    z-index: 15;
    animation: none;
  }
  .aside-card.moved.holding {
    position: fixed;
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
  /* Item 674: the shared transcript scrolls itself; this is its frame
     (positioned for its ⌄), sized by the thread up to the card's room. */
  .aside-card-body.shared {
    position: relative;
    padding: 0;
    gap: 0;
    overflow: hidden;
    flex: 0 1 auto;
  }
  .aside-card-body.shared :global(.transcript.compact) {
    flex: 0 1 auto;
  }
  .aside-card.panel .aside-card-body.shared,
  .aside-card.panel .aside-card-body.shared :global(.transcript.compact) {
    flex: 1 1 auto;
  }
  /* ~~`.aside-card-q` / `-a` / `-wait` / `-row`~~ — the thread is
     `AsideThread.svelte` and the box the chat's composer since backlog 283. */
  /* The foot: the composer pinned under the thread, never scrolled away. */
  .aside-card-foot {
    flex: none;
    padding: 0 10px 8px;
    border-top: 1px dashed var(--aside-edge);
  }
  .aside-card-foot.draft {
    border-top: none;
  }
  /* The composer's line under the box (backlog 358): one line, cut with an
     ellipsis. Its "Answers from ‹chat›" names an untitled chat by its whole
     first prompt — once the answer completed it replaced the short
     "Answering —" line, grew to fifteen lines, and the pinned foot took the
     card's room from the answer, which shrank to a line. The chat's name
     inside it is cut short too, so a line that keeps a button (not the open
     chat) still shows the button. The format chip never gives way. */
  .aside-card :global(.composer.aside .aside-line) {
    /* Its text is its basis, shrunk to the row: a 0 basis split the row
       with the spacer and cut the chat's name whole. */
    flex: 1 1 auto;
    min-width: 0;
    /* ~~white-space: nowrap; overflow: hidden; text-overflow: ellipsis~~
       (struck 2026-11-18, item 833: in a narrow card it read "nothing …",
       his shots). It wraps now — its own row once the chips do not fit
       beside it, a second line under ~330 px; the chat's name inside stays
       capped (the em below), so 358's fifteen lines cannot come back. */
    white-space: normal;
  }
  .aside-card :global(.composer.aside .aside-line em) {
    display: inline-block;
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .aside-card :global(.composer.aside .bottom-toggle) {
    flex-shrink: 0;
  }
  .aside-card-of {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--ink2, var(--dim));
  }
  /* In the side panel the panel's own title row already reads "Aside ·
     ‹chat›", and the head's chips leave this ~10 px: it drew as "A…" at
     every zoom (item 360). The chips get the room. */
  .aside-card.panel .aside-card-of {
    display: none;
  }
  .aside-card-of em {
    font-style: normal;
    font-weight: 600;
    color: var(--ink);
  }
  .aside-card-quote {
    margin: 0;
    padding: 4px 0 4px 10px;
    border-left: 3px solid var(--accent);
    color: var(--dim);
    font-size: 12.5px;
    max-height: 7.5em;
    overflow: auto;
  }
  .aside-card-quote :global(p) {
    margin: 0;
  }

  /* Item 567 (Filament IV stage 10): the aside keeps its own face (283:
     the tint and the dashed accent edge, so it never reads as the chat),
     in Filament IV's measures — the card's 8 px corner, a lighter shadow,
     the head on a panel band. ("Aside of" as a mono capital label was
     tried and dropped: its width cut the chat's name to four letters.)
     Filament IV only (item 542's
     gate); Classic keeps the rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .aside-card {
    border-radius: var(--r2);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-card.panel {
    border-radius: 0;
    box-shadow: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-card-head {
    background: color-mix(in srgb, var(--aside-tint) 70%, var(--paper));
    border-radius: var(--r2) var(--r2) 0 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-card.panel .aside-card-head {
    border-radius: 0;
  }
  /* Item 735, Jarvis: the minimized line is a pill — the aside's tint and
     dashed edge, its tag in small mono capitals, the dot lit. */
  :global(:where(:root:not([data-layout="classic"]))) .aside-card.minimized {
    border-radius: 999px;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-mini {
    padding: 5px 12px 5px 10px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-mini-tag {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-mini-dot {
    box-shadow: 0 0 6px var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside-card.folded .aside-card-head {
    border-radius: var(--r2);
    border-bottom: none;
  }
  /* Item 763 H5: Home's Start cards in an aside — at most a third of the card, scrolling inside. */
  .aside-start-cards {
    flex: 0 1 auto;
    min-height: 0;
    max-height: 34vh;
    overflow-y: auto;
    padding: 0 10px;
  }
</style>
