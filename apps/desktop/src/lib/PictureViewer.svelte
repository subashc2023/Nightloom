<script lang="ts">
  // A picture full size over the whole window (item 885; was each caller's own
  // overlay — the reply picture strip 820/875 on the Mac and the phone, and a
  // tool result's images 434). A click ON the picture zooms in on that spot and
  // a second click goes back to fit; a pinch zooms around the fingers; zoomed, a
  // drag or a two-finger scroll pans. Only a click outside the picture, Esc or
  // Close leaves. The zoom is `zoomable` (pictureZoomAction.ts); each opening
  // starts at fit.
  import type { Snippet } from "svelte";
  import { zoomable } from "./pictureZoomAction";
  import { keyCloses } from "./pictureZoom";
  // Item 879: a transparent picture with dark ink sits on white paper.
  import { paperIfDarkInk } from "./rasterBacking";

  let {
    src,
    alt,
    label,
    svg = false,
    onclose,
    actions,
  }: {
    src: string;
    alt: string;
    /** The line under the picture (its name); the how-to follows it. */
    label?: string;
    /** An SVG: drawn on white paper, as in the strip. */
    svg?: boolean;
    onclose: () => void;
    /** Buttons beside Close (the Mac's "Open as a tab"). */
    actions?: Snippet;
  } = $props();

  // Drawn on <body>: a row's entrance animation leaves a transform on an
  // ancestor, and a fixed layer inside a transform is fixed to it.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  function onkey(e: KeyboardEvent): void {
    if (keyCloses(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onkey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="pv-over" use:portal role="dialog" aria-modal="true" aria-label={label ? `${label}, full size` : "Picture, full size"} tabindex="-1" onclick={onclose}>
  <div class="pv-stage" data-picture-viewer use:zoomable={{ onoutside: onclose }}>
    <img class:svg {src} {alt} draggable="false" use:paperIfDarkInk />
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pv-hint">
    <span>{label ? `${label} · ` : ""}Click the picture to zoom, pinch to zoom · click outside or Esc to close</span>
    {@render actions?.()}
    <button
      class="ns-btn small"
      onclick={(e) => {
        e.stopPropagation();
        onclose();
      }}>Close</button
    >
  </div>
</div>

<style>
  .pv-over {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, black 78%, transparent);
  }
  .pv-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    margin: 30px 40px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .pv-stage img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
  }
  .pv-stage img.svg {
    background: #fff;
  }
  .pv-hint {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 16px 14px;
    font-size: 0.75rem;
    color: rgb(255 255 255 / 0.75);
  }
</style>
