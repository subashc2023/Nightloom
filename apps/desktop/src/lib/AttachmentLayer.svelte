<script lang="ts">
  import { app, endContentDrag, startContentDrag } from "./state.svelte";
  import { attachmentBytes, closeAttachment, opening } from "./attachments.svelte";
  import { VIEW_MARGIN, ZOOM_MS, fitRect, zoomCss, zoomTransform, type Rect } from "./attachmentView";
  import { escapeClosesPanel } from "./search";

  /**
   * The floating attachment tab (nightshift backlog 145, 2026-09-17).
   *
   * A click on an attached image or PDF in a user bubble opens it here:
   * a tab in the workspace's floating slot (`app.tabs.floating`), drawn
   * in front of the panes over a scrim, zooming up from the thumbnail it
   * was clicked on (a Web Animations run from the thumbnail's transform
   * to none, `ZOOM_MS`, ease-out; none under reduced motion). An image
   * shows fit-to-screen, and at its own size on a second click (the card
   * scrolls); a PDF shows in an `<embed>` of its bytes — the log holds
   * the base64, so nothing is fetched and no viewer outside the app is
   * launched. It closes on a click on the scrim, ×, or Escape — caught
   * here on the way down, from anywhere but another text field (backlog
   * 138's rule), so it never reaches the window where macOS leaves full
   * screen. Its head drags (pass 2): onto a strip or a pane's half the
   * tab is kept there and the layer closes.
   *
   * One floating tab at a time; the bytes are resolved from the open
   * chat's log each render, so a rewound log closes the tab rather than
   * showing a stale one.
   */
  const tab = $derived(app.tabs.floating ?? null);
  const content = $derived(tab?.content.kind === "attachment" ? tab.content : null);
  const bytes = $derived(content ? attachmentBytes(content) : null);
  const src = $derived(bytes ? `data:${bytes.media_type};base64,${bytes.data}` : null);

  let card = $state<HTMLElement | null>(null);
  /** The image at its own size (a second click), scrolling in the card. */
  let full = $state(false);
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
    full = false;
  });

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
    if (!tab || e.key !== "Escape" || e.defaultPrevented) return;
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
    onclick={(e) => {
      if (e.target === e.currentTarget) closeAttachment();
    }}
  >
    <div
      class="attach-card"
      class:full
      role="dialog"
      aria-modal="true"
      aria-label={bytes.name}
      bind:this={card}
      style:left={full ? `${VIEW_MARGIN}px` : `${rect.left}px`}
      style:top={full ? `${VIEW_MARGIN}px` : `${rect.top}px`}
      style:width={full ? `${vp.width - 2 * VIEW_MARGIN}px` : `${rect.width}px`}
      style:height={full ? `${vp.height - 2 * VIEW_MARGIN}px` : `${rect.height}px`}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="attach-head"
        draggable="true"
        title="Drag onto a tab strip to keep this as a tab, or onto a pane's half to open it beside"
        ondragstart={(e) => content && startContentDrag(e, content)}
        ondragend={endContentDrag}
      >
        <span class="attach-grip" aria-hidden="true">⋮⋮</span>
        <span class="attach-name mono" title={bytes.media_type}>{bytes.name}</span>
        <span class="ns-chip mono">{content.media === "image" ? "image" : "PDF"}</span>
        {#if content.media === "image"}
          <span class="ns-chip mono" title="The image's own size">{natural.width} × {natural.height}</span>
        {/if}
        <span class="spacer"></span>
        <button class="ns-btn ghost small" title="Close (Escape, or click outside)" onclick={closeAttachment}>×</button>
      </div>
      <div class="attach-body" class:scroll={full}>
        {#if content.media === "image"}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <img
            class="attach-img"
            class:full
            {src}
            alt={bytes.name}
            title={full ? "Click to fit the screen" : "Click for the image's own size"}
            onclick={() => (full = !full)}
          />
        {:else}
          <embed class="attach-pdf" {src} type={bytes.media_type} title={bytes.name} />
        {/if}
      </div>
    </div>
  </div>
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
    /* The fit ↔ own-size change (a second click) glides; the entrance is
       the Web Animation above, which overrides this while it runs. */
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
  .attach-body.scroll {
    display: block;
    overflow: auto;
  }
  .attach-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
  }
  .attach-img.full {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
  .attach-pdf {
    width: 100%;
    height: 100%;
    border: none;
  }
</style>
