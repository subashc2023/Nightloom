<script lang="ts">
  import { scrimClose } from "./scrimClose";
  import { tip } from "./tip";
  import { app, dropContent } from "./state.svelte";
  import { outcome, startMove } from "./floatingMove";
  import type { Zone } from "./floatingMove";
  import MoveZone from "./MoveZone.svelte";
  import { attachmentBytes, closeAttachment, opening } from "./attachments.svelte";
  import { ZOOM_MS, fitRect, zoomCss, zoomTransform, type Rect } from "./attachmentView";
  import { escapeClosesPanel } from "./search";
  // Item 879: a transparent PNG/GIF/WebP with dark ink sits on white paper, readable on the dark looks.
  import { paperIfDarkInk } from "./rasterBacking";
  // Item 885: a click on the picture zooms in at that spot (again: back to fit), a pinch zooms, a drag pans.
  import { zoomable } from "./pictureZoomAction";

  /**
   * The floating attachment tab (nightshift backlog 145, 2026-09-17).
   *
   * A click on an attached image or PDF in a user bubble opens it here:
   * a tab in the workspace's floating slot (`app.tabs.floating`), drawn
   * in front of the panes over a scrim, zooming up from the thumbnail it
   * was clicked on (a Web Animations run from the thumbnail's transform
   * to none, `ZOOM_MS`, ease-out; none under reduced motion). An image
   * shows fit-to-screen; ~~at its own size on a second click (the card
   * scrolls)~~ since item 885 (2026-11-19) a click on it zooms in at that
   * spot, a second click goes back to fit, a pinch zooms, a drag pans
   * (`zoomable`, as the other full-size viewers); a PDF shows in an `<embed>` of its bytes — the log holds
   * the base64, so nothing is fetched and no viewer outside the app is
   * launched. It closes on a click on the scrim, ×, or Escape — caught
   * here on the way down, from anywhere but another text field (backlog
   * 138's rule), so it never reaches the window where macOS leaves full
   * screen. ~~Its head drags (pass 2): onto a strip or a pane's half the
   * tab is kept there and the layer closes.~~ Its head moves the card by
   * pointer since backlog 156 (the aside card's `floatingMove.ts`): it
   * stays where it is let go; near a tab strip it is kept there as a tab,
   * at the panes' left or right edge it opens beside (what a pane's half
   * did), and the layer closes. Escape during a move puts it back.
   *
   * One floating tab at a time; the bytes are resolved from the open
   * chat's log each render, so a rewound log closes the tab rather than
   * showing a stale one.
   */
  const tab = $derived(app.tabs.floating ?? null);
  const content = $derived(tab?.content.kind === "attachment" ? tab.content : null);
  const bytes = $derived(content ? attachmentBytes(content) : null);
  const src = $derived(bytes ? `data:${bytes.media_type}${bytes.media_type.startsWith("text/") ? ";charset=utf-8" : ""};base64,${bytes.data}` : null);

  let card = $state<HTMLElement | null>(null);
  function viewportRect(): Rect {
    return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  }
  let vp = $state<Rect>(viewportRect());
  function measure(): void {
    vp = viewportRect();
  }
  // Measured again at each opening, before the entrance reads the card.
  $effect(() => {
    if (tab) measure();
  });
  /** A PDF has no natural size to fit; a page-ish default. */
  const PDF_SIZE = { width: 960, height: 1240 };
  const natural = $derived(content?.media === "image" ? (opening.natural ?? { width: 800, height: 600 }) : PDF_SIZE);
  /** The head row's height, added so the image under it fits whole. */
  const HEAD_H = 34;
  const rect = $derived(fitRect({ width: natural.width, height: natural.height + HEAD_H }, vp));

  // A tab with no bytes behind it (a rewound log, another chat brought
  // forward) closes; the card is nothing without them.
  $effect(() => {
    if (tab && content && !bytes) closeAttachment();
  });
  $effect(() => {
    void tab;
    at = null;
  });

  /** Where he moved the card (backlog 156); null at its fitted spot. Reset
   *  with each opening. `holding` while the pointer has it. */
  let at = $state<{ left: number; top: number } | null>(null);
  let holding = $state(false);
  let zone = $state<Zone | null>(null);
  function headDown(e: PointerEvent): void {
    const c = content;
    if (!card || !c) return;
    // Item 467: a chip not yet sent stays a card — a tab would outlive it.
    if (c.draft) return;
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    const r = card.getBoundingClientRect();
    const before = at;
    startMove(e, {
      origin: { left: r.left, top: r.top },
      size: { width: r.width, height: r.height },
      edges: { left: "beside", right: "beside" },
      onMove(p, z) {
        holding = true;
        at = p;
        zone = z;
      },
      onDrop(p, z) {
        holding = false;
        zone = null;
        const o = outcome(z);
        if (o.kind === "stay") {
          at = p;
          return;
        }
        at = before;
        if (o.kind === "tab") void dropContent(c, { pane: o.pane, index: o.index });
        else if (o.kind === "beside") void dropContent(c, { pane: o.pane, side: o.side });
      },
      onCancel() {
        holding = false;
        zone = null;
        at = before;
      },
    });
  }

  /** The entrance: from the thumbnail's rect to the card's, once. */
  $effect(() => {
    const el = card;
    const from = opening.from;
    if (!el || !from) return;
    opening.from = null;
    if (typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = zoomTransform(from, el.getBoundingClientRect());
    el.animate([{ transform: zoomCss(t), opacity: 0.3 }, { transform: "none", opacity: 1 }], {
      duration: ZOOM_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  });

  /** Escape on the way down: ours from anywhere but a text field. */
  function windowKeys(e: KeyboardEvent): void {
    // Mid-move, Escape is the move's (it puts the card back), not a close.
    if (!tab || holding || e.key !== "Escape" || e.defaultPrevented) return;
    if (!escapeClosesPanel(e.target as { tagName?: string; isContentEditable?: boolean } | null, null)) return;
    e.preventDefault();
    e.stopPropagation();
    closeAttachment();
  }
</script>

<svelte:window onkeydowncapture={windowKeys} onresize={measure} />

{#if tab && content && bytes && src}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="attach-scrim"
    role="presentation"
    use:scrimClose={closeAttachment}
  >
    <div
      class="attach-card"
      class:holding
      role="dialog"
      aria-modal="true"
      aria-label={bytes.name}
      bind:this={card}
      style:left={at ? `${at.left}px` : `${rect.left}px`}
      style:top={at ? `${at.top}px` : `${rect.top}px`}
      style:width={`${rect.width}px`}
      style:height={`${rect.height}px`}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="attach-head"
        use:tip={"Drag to move it — near a tab strip it is kept there as a tab, at the left or right edge it opens beside"}
        onpointerdown={headDown}
        onmousedown={(e) => {
          if (!(e.target as HTMLElement | null)?.closest("button")) e.preventDefault();
        }}
      >
        <span class="attach-grip" aria-hidden="true">⋮⋮</span>
        <span class="attach-name mono" use:tip={bytes.media_type}>{bytes.name}</span>
        <span class="ns-chip mono">{content.media === "image" ? "image" : "PDF"}</span>
        {#if content.media === "image"}
          <span class="ns-chip mono" use:tip={"The image's own size"}>{natural.width} × {natural.height}</span>
        {/if}
        <span class="spacer"></span>
        <button class="ns-btn ghost small" use:tip={"Close (Escape, or click outside)"} onclick={closeAttachment}>×</button>
      </div>
      {#if content.media === "image"}
        <div class="attach-body" data-picture-viewer use:zoomable>
          <img class="attach-img" {src} use:paperIfDarkInk alt={bytes.name} draggable="false" use:tip={"Click to zoom in there (again to fit) · pinch to zoom · drag to move"} />
        </div>
      {:else}
        <div class="attach-body">
          <embed class="attach-pdf" {src} type={bytes.media_type} title={bytes.name} />
        </div>
      {/if}
    </div>
  </div>
  {#if zone}<MoveZone {zone} z={40} />{/if}
{/if}

<style>
  .attach-scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 35;
  }
  .attach-card {
    position: absolute;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--sheet);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    transform-origin: 0 0;
    /* A move glides; the entrance is the Web Animation above, which
       overrides this while it runs. (Item 885: the own-size change it was
       for is now a zoom inside the card.) */
    transition:
      left 160ms ease-out,
      top 160ms ease-out,
      width 160ms ease-out,
      height 160ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .attach-card {
      transition: none;
    }
  }
  /* Under the pointer (backlog 156): no glide, or it trails the hand. */
  .attach-card.holding {
    transition: none;
    cursor: grabbing;
  }
  .attach-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 6px 0 10px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--dim);
    cursor: grab;
    flex: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .attach-head .spacer {
    flex: 1;
  }
  .attach-grip {
    letter-spacing: -2px;
    opacity: 0.7;
  }
  .attach-name {
    color: var(--ink);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .attach-body {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--well);
    overflow: hidden;
  }
  .attach-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
  }
  .attach-pdf {
    width: 100%;
    height: 100%;
    border: none;
  }
</style>
