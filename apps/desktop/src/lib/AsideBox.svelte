<script lang="ts">
  import ResizeHandle from "./ResizeHandle.svelte";
  import { dragHeight, growHeight, linesHeight, loadBoxHeight, overflows, saveBoxHeight } from "./boxGrow";

  /**
   * An aside's question box (nightshift backlog 226, 2026-09-26), the card's
   * and the tab's: it grows with its text up to four lines, then scrolls —
   * his "you should be able to see maybe three or four lines max before it
   * becomes scrollable" — shows a scroll bar only when the text overflows,
   * and never scrolls sideways (long lines wrap). The main composer's
   * drag-to-resize, the same handle and pointer code (`ResizeHandle`,
   * `boxGrow.ts`): a dragged height is the box's height, text and all,
   * remembered on this machine (`nightloom.aside.height`) the way the
   * composer remembers its own; a double-click on the handle goes back to
   * growing with the text.
   *
   * The text is the thread's (`aside.unsent`, backlog 228); the owner
   * passes it in and takes each keystroke.
   */
  let {
    value,
    oninput,
    onkeydown,
    placeholder,
    label,
    edge = "bottom",
    variant = "card",
    box = $bindable(null),
    room = null,
    roomKey = "",
    ongrow = null,
  }: {
    value: string;
    oninput: (e: Event) => void;
    onkeydown: (e: KeyboardEvent) => void;
    placeholder: string;
    label: string;
    /** Which edge takes the drag: the bottom under a passage and in a tab
     *  (the box grows down), the top on a card stuck above the composer
     *  (it grows up, as the composer does). */
    edge?: "top" | "bottom";
    variant?: "card" | "view";
    box?: HTMLTextAreaElement | null;
    /** The card's limit on the box (backlog 233): what its height cap
     *  leaves once the head, the padding and everything under the box —
     *  the Ask aside and Cancel row — are paid for; `null` is no limit
     *  (the tab, or a card with room to spare). Read on every grow step. */
    room?: ((min: number) => number | null) | null;
    /** Changes when the card's room may have (its placement, a move, the
     *  number of cards stacked), so the box is measured again. */
    roomKey?: string;
    /** Told after each grow step, so the card can keep the box's foot —
     *  and the buttons under it — in view (backlog 233). */
    ongrow?: (() => void) | null;
  } = $props();

  const HEIGHT_KEY = "nightloom.aside.height";
  /** Four lines, then it scrolls (his decision in backlog 226). */
  const GROW_LINES = 4;
  /** A box dragged no shorter than one line, no taller than half the window. */
  const MIN_LINES = 1;

  let setPx = $state<number | null>(loadBoxHeight(HEIGHT_KEY, 1));
  let dragging = $state(false);

  function metrics(ta: HTMLTextAreaElement): { line: number; chrome: number; border: number } {
    const cs = getComputedStyle(ta);
    const px = (v: string) => parseFloat(v) || 0;
    const line = px(cs.lineHeight) || px(cs.fontSize) * 1.4 || 20;
    const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return { line, chrome: px(cs.paddingTop) + px(cs.paddingBottom) + border, border };
  }

  /** Size the box to its text (or to the dragged height), and let it scroll
   *  only when the text does not fit. */
  function grow(): void {
    const ta = box;
    if (!ta) return;
    const m = metrics(ta);
    ta.style.height = "auto";
    // `scrollHeight` is the text plus the padding; the box is border-box.
    const need = ta.scrollHeight + m.border;
    const floor = setPx ?? linesHeight(m.line, MIN_LINES, m.chrome);
    const cap = setPx ?? linesHeight(m.line, GROW_LINES, m.chrome);
    let h = growHeight(need, floor, cap);
    // Never taller than the card leaves room for (backlog 233): the text
    // scrolls inside the box and the buttons under it stay in view.
    const limit = room?.(linesHeight(m.line, MIN_LINES, m.chrome)) ?? null;
    if (limit !== null) h = Math.min(h, limit);
    ta.style.height = h + "px";
    ta.style.overflowY = overflows(need, h) ? "auto" : "hidden";
    ongrow?.();
  }

  function down(e: PointerEvent): void {
    const ta = box;
    if (!ta) return;
    const m = metrics(ta);
    const min = linesHeight(m.line, MIN_LINES, m.chrome);
    dragging = true;
    dragHeight(
      e,
      ta.offsetHeight,
      edge,
      (h) => {
        setPx = Math.round(Math.min(window.innerHeight * 0.5, Math.max(min, h)));
        grow();
      },
      () => {
        dragging = false;
        saveBoxHeight(HEIGHT_KEY, setPx);
      },
    );
  }

  function reset(): void {
    setPx = null;
    saveBoxHeight(HEIGHT_KEY, null);
    grow();
  }

  // Every change of text is measured once it is in the box — an effect
  // runs after the DOM is updated, so at once; and again a frame later,
  // for a box whose fonts or width settle after it mounts.
  $effect(() => {
    void value;
    void setPx;
    void roomKey;
    grow();
    requestAnimationFrame(grow);
  });
  // A narrower or wider box wraps differently (a moved card, a resized
  // window): measured again on a change of width only, so setting the
  // height does not feed back into itself.
  $effect(() => {
    const ta = box;
    if (!ta || typeof ResizeObserver === "undefined") return;
    let width = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth === width) return;
      width = ta.clientWidth;
      grow();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  });
</script>

<svelte:window onresize={grow} />

<div class="aside-box-wrap" class:view={variant === "view"}>
  <textarea
    class="aside-box"
    class:view={variant === "view"}
    bind:this={box}
    {value}
    {oninput}
    {onkeydown}
    rows="1"
    {placeholder}
    aria-label={label}
    autocorrect="off"
    autocapitalize="off"
    spellcheck="false"
  ></textarea>
  <ResizeHandle
    {edge}
    {dragging}
    inset={10}
    label="Aside box height"
    value={setPx ?? undefined}
    hint={setPx === null
      ? "Drag to resize · double-click to reset"
      : `Drag to resize · double-click to reset — ${setPx}px on this machine`}
    ondown={down}
    onreset={reset}
  />
</div>

<style>
  .aside-box-wrap {
    position: relative;
    /* Never shrink below its height (nightshift backlog 179, 2026-09-22):
       in a scrolling flex column a scroll container's minimum height is 0,
       and a long answer squashed the box to a sliver. */
    flex-shrink: 0;
    width: 100%;
  }
  .aside-box-wrap.view {
    max-width: 760px;
  }
  .aside-box {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: 7px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--well);
    color: var(--ink);
    font: inherit;
    line-height: 1.4;
    /* No bar until the text overflows (`grow` sets `overflow-y`), and
       none sideways ever: long lines wrap (backlog 226; the composer's
       rule of 2026-09-16, backlog 170). */
    overflow-y: hidden;
    overflow-x: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .aside-box.view {
    padding: 8px 10px;
    background: var(--sheet);
  }
  .aside-box:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
