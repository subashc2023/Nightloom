<script lang="ts">
  /**
   * A drag handle between two panes. Reports the pane's new width while the
   * pointer moves; the parent owns the width and the clamp. `edge` says which
   * side of the grip the resized pane is on — dragging right grows a pane on
   * the left and shrinks one on the right.
   */
  let {
    width,
    min = 160,
    max = 720,
    edge = "left",
    axis = "x",
    onchange,
  }: {
    width: number;
    min?: number;
    max?: number;
    /** `x`: `edge` is left/right of the grip. `y`: the grip lies flat and
     *  `edge` reads as top/bottom — `left` is the pane above it, `right` the
     *  pane below (the Backlog screen's interview dock). */
    edge?: "left" | "right";
    axis?: "x" | "y";
    onchange: (px: number) => void;
  } = $props();

  let dragging = $state(false);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = axis === "x" ? e.clientX : e.clientY;
    const startW = width;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => {
      const dx = (axis === "x" ? ev.clientX : ev.clientY) - startX;
      const raw = edge === "left" ? startW + dx : startW - dx;
      onchange(Math.min(max, Math.max(min, raw)));
    };
    const up = () => {
      dragging = false;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="grip"
  class:dragging
  class:flat={axis === "y"}
  role="separator"
  aria-orientation={axis === "x" ? "vertical" : "horizontal"}
  aria-valuenow={width}
  aria-valuemin={min}
  aria-valuemax={max}
  onpointerdown={down}
></div>

<style>
  .grip {
    width: 7px;
    margin: 0 -3px;
    cursor: col-resize;
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    touch-action: none;
    user-select: none;
  }
  .grip::after {
    content: "";
    width: 3px;
    height: 36px;
    border-radius: 2px;
    background: var(--line2);
    transition: background 0.12s;
  }
  .grip:hover::after,
  .grip.dragging::after {
    background: var(--accent);
  }
  .grip.flat {
    width: auto;
    height: 7px;
    margin: -3px 0;
    cursor: row-resize;
  }
  .grip.flat::after {
    width: 36px;
    height: 3px;
  }
</style>
