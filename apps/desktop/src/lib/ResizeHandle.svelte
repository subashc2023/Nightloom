<script lang="ts">
  import { tip } from "./tip";

  /**
   * The drag strip on a text box's edge (backlog 111's handle, moved out
   * of `Composer.svelte` for backlog 226 so the aside boxes have the same
   * one). The grip mark is the sidebar's (`Grip.svelte`, laid flat): a
   * short bar, accent on hover; the hover also draws a line the width of
   * the edge, so the place to drag is findable. The owner does the
   * resizing (`dragHeight` in `boxGrow.ts`); this is the strip.
   */
  let {
    edge = "top",
    dragging = false,
    label,
    hint,
    value = undefined,
    inset = 20,
    ondown,
    onreset,
  }: {
    /** The box edge the strip sits on. */
    edge?: "top" | "bottom";
    dragging?: boolean;
    label: string;
    /** The tooltip, through `use:tip` (never a `title=`, tip.test.ts). */
    hint: string;
    value?: number;
    /** How far in from each side the hover line starts, in px. */
    inset?: number;
    ondown: (e: PointerEvent) => void;
    onreset: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="handle"
  class:bottom={edge === "bottom"}
  class:dragging
  role="separator"
  aria-orientation="horizontal"
  aria-label={label}
  aria-valuenow={value}
  style:--inset={`${inset}px`}
  use:tip={hint}
  onpointerdown={(e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ondown(e);
  }}
  ondblclick={onreset}
></div>

<style>
  .handle {
    position: absolute;
    top: -6px;
    left: 0;
    right: 0;
    height: 13px;
    cursor: row-resize;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2;
  }
  .handle.bottom {
    top: auto;
    bottom: -6px;
  }
  .handle::before {
    content: "";
    position: absolute;
    left: var(--inset);
    right: var(--inset);
    top: 6px;
    height: 1px;
    background: transparent;
    transition: background 0.12s;
  }
  .handle::after {
    content: "";
    position: relative;
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    transition: background 0.12s;
  }
  .handle:hover::before,
  .handle.dragging::before {
    background: var(--accent);
  }
  .handle:hover::after,
  .handle.dragging::after {
    background: var(--accent);
  }
</style>
