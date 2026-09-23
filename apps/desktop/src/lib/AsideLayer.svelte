<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { app, asideInTab } from "./state.svelte";
  import type { Aside } from "./state.svelte";
  import AsideCard from "./AsideCard.svelte";
  import {
    CARD_GAP,
    PREFERRED_CARD_HEIGHT,
    markRange,
    placeCard,
    rangeFromOffsets,
    spreadCards,
    type AsideAnchor,
    type CardBox,
    type Placement,
  } from "./asideCard";

  /**
   * The open chat's aside cards, several at once (nightshift backlog 176,
   * 2026-09-23 — his "multiple asides at once"). What `Transcript.svelte`
   * did for its one card (backlog 141), done per card: each thread's
   * passage is found again from its anchor and marked, and its card is
   * placed under (or over) it with `placeCard`; then `spreadCards` pushes
   * a card that would cover another down below it (blocker 318). A card
   * with no passage — a composer aside, or a passage that cannot be found
   * again (blocker 225) — sits above the composer; several of those stack
   * there, the newest nearest the composer, each `sticky` at the height
   * of the ones under it.
   *
   * Drawn as the transcript's scrolled column's last child, as the one
   * card was; the column (`inner`, `position: relative`) is the frame the
   * placements are in. A card showing in a tab or the side panel is not
   * drawn here, but the panel's passage stays marked — the panel is
   * about it. Re-measured after every render that can move the text
   * (`version`, the log) and on any size change of the column, the
   * viewport or a card.
   */
  let {
    viewport,
    inner,
    proseBlocks,
    version = 0,
  }: {
    viewport: HTMLElement | null;
    inner: HTMLElement | null;
    /** The prose blocks of a turn, in document order — the transcript's. */
    proseBlocks: (turn: number) => Element[];
    /** Anything whose change can move the text (the items' count). */
    version?: unknown;
  } = $props();

  const session = $derived(app.activeSessionId);
  /** The cards drawn here: every open thread not in a tab or the panel. */
  const shown = $derived(app.asides.filter((a) => !asideInTab(session, a.id)));
  /** The thread the side panel shows beside this chat, if any. */
  const besideId = $derived.by(() => {
    if (session === null || app.asidePanel !== session) return null;
    return app.asidePanelThread ?? app.asides[app.asides.length - 1]?.id ?? null;
  });
  /** The newest open card claims a stray Escape (one Escape, one card). */
  const frontId = $derived([...shown].reverse().find((a) => !a.folded)?.id ?? null);

  let cards = $state<Record<number, AsideCard | null>>({});
  let placements = $state<Record<number, Placement | null>>({});
  /** Each composer card's `bottom` in the stack above the composer. */
  let footBottoms = $state<Record<number, number>>({});
  const footIds = $derived(shown.filter((a) => !placements[a.id]).map((a) => a.id));

  interface Mark {
    range: Range;
    key: string;
    undo: () => void;
  }
  const marks = new Map<number, Mark>();

  const keyOf = (a: AsideAnchor) => `${a.turn}:${a.block}:${a.start}:${a.end}`;

  function unmark(id: number): void {
    marks.get(id)?.undo();
    marks.delete(id);
  }
  function unmarkAll(): void {
    for (const id of [...marks.keys()]) unmark(id);
  }

  /** The thread's passage, marked; null when it cannot be found again. */
  function markOf(a: Aside): Mark | null {
    const anchor = a.anchor;
    if (!anchor) return null;
    const key = keyOf(anchor);
    const had = marks.get(a.id);
    // Redone only when the range is not the one marked — a re-render
    // replaced the text (a removed text node collapses the range onto the
    // parent that stayed, so `collapsed` is the tell), or the anchor moved.
    if (had && had.key === key && !had.range.collapsed && had.range.startContainer.isConnected) return had;
    unmark(a.id);
    const prose = proseBlocks(anchor.turn)[anchor.block] ?? null;
    const range = prose ? rangeFromOffsets(prose, anchor.start, anchor.end) : null;
    if (!range) return null;
    const m = { range, key, undo: markRange(range) };
    marks.set(a.id, m);
    return m;
  }

  /** Measure and place every card; called after the DOM is current. */
  async function place(): Promise<void> {
    await tick();
    const vp = viewport;
    const host = inner;
    if (!vp || !host) {
      unmarkAll();
      placements = {};
      return;
    }
    const shownIds = new Set(shown.map((a) => a.id));
    const wanted = new Set<number>();
    const next: Record<number, Placement | null> = {};
    for (const a of shown) next[a.id] = null;
    const boxes: CardBox[] = [];
    const spread: number[] = [];
    const hostRect = host.getBoundingClientRect();
    // The composer's cards take the viewport's foot: a floating card is
    // given the room above them, so it scrolls inside rather than running
    // under the stack (measured from the last pass; a card whose place is
    // not known yet counts as none).
    let footHeight = 0;
    for (const a of shown) {
      if (placements[a.id] || !(a.id in placements)) continue;
      footHeight += (cards[a.id]?.element()?.offsetHeight ?? 0) + CARD_GAP;
    }
    const whole = vp.getBoundingClientRect();
    const vpRect = { top: whole.top, left: whole.left, right: whole.right, bottom: whole.bottom - footHeight };
    for (const a of app.asides) {
      const onCard = shownIds.has(a.id);
      if (!onCard && a.id !== besideId) continue;
      const m = markOf(a);
      if (!m || !a.anchor) continue;
      wanted.add(a.id);
      if (!onCard) continue; // marked for the panel; no card here
      const height = cards[a.id]?.element()?.offsetHeight ?? PREFERRED_CARD_HEIGHT;
      const p = placeCard(m.range.getBoundingClientRect(), hostRect, vpRect, height, a.anchor.side);
      next[a.id] = p;
      // A card he moved stays exactly where he put it (backlog 156).
      if (!a.moved) {
        boxes.push({ top: p.top, left: p.left, width: p.width, height });
        spread.push(a.id);
      }
    }
    for (const id of [...marks.keys()]) if (!wanted.has(id)) unmark(id);
    const tops = spreadCards(boxes);
    spread.forEach((id, i) => {
      const p = next[id];
      if (p) next[id] = { ...p, top: tops[i]! };
    });
    placements = next;
    // The composer cards: the newest nearest the composer, each one's
    // `bottom` the heights of those under it.
    await tick();
    const foot = shown.filter((a) => !next[a.id]);
    const bottoms: Record<number, number> = {};
    let below = 8;
    for (let i = foot.length - 1; i >= 0; i--) {
      const id = foot[i]!.id;
      bottoms[id] = below;
      below += (cards[id]?.element()?.offsetHeight ?? 0) + CARD_GAP;
    }
    footBottoms = bottoms;
    // A draft just opened: its box takes the caret once it is placed.
    const f = app.asideFocus;
    if (f !== null && cards[f]) {
      cards[f]?.focusBox();
      app.asideFocus = null;
    }
  }

  // What can move a passage or change a card: the threads (their
  // presence, anchors, drafts, folds, moves), a tab or the panel taking
  // one, and the log (the re-sync at a turn's end replaces every reply's
  // DOM).
  $effect(() => {
    for (const a of app.asides) {
      void a.anchor;
      void a.draft;
      void a.folded;
      void a.moved;
    }
    void shown;
    void besideId;
    void app.events;
    void version;
    void app.asideFocus;
    untrack(() => void place());
  });
  // A card that grows (an answer streaming in), a column that changes
  // shape or a viewport that does re-measures.
  $effect(() => {
    const host = inner;
    const vp = viewport;
    if (!host || !vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => untrack(() => void place()));
    ro.observe(host);
    ro.observe(vp);
    for (const a of shown) {
      const el = cards[a.id]?.element();
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  });
  onDestroy(unmarkAll);
</script>

{#each shown as a (a.id)}
  <AsideCard
    bind:this={cards[a.id]}
    aside={a}
    placement={placements[a.id] ?? null}
    front={a.id === frontId}
    footBottom={footIds.length > 1 ? (footBottoms[a.id] ?? null) : null}
    footCount={footIds.length}
  />
{/each}
