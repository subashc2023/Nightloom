<script lang="ts">
  /**
   * The `?` beside a control: its explanation, shown on hover or focus rather
   * than printed under it. Swaraag's call for the model popover (nightshift
   * blocker 031, 2026-09-13): "less text is better". The text is what used to
   * be the control's `title=`, so nothing is explained less — it is explained
   * on demand. A button rather than a span so the keyboard reaches it.
   */
  import { portal } from "./portal";
  import { HINT_CLOSED, hintOpen, hintStep, type HintEvent } from "./hintState";

  let { text, side = "left" }: { text: string; side?: "left" | "right" } = $props();
  // Item 638: hover and focus show it while they last; a click pins it
  // (it used to toggle, so a click on a hovered `?` shut it).
  let hs = $state(HINT_CLOSED);
  const open = $derived(hintOpen(hs));
  const step = (e: HintEvent) => (hs = hintStep(hs, e));
  const id = `hint-${Math.random().toString(36).slice(2, 8)}`;

  // Placed against the window, not the `?` (nightshift backlog 180,
  // 2026-09-22): drawn `absolute` beside its `?`, a tip whose `?` sat at a
  // row's left end (Subagent limits) spilled past the Model · Tasks card and
  // was sliced by the card's `overflow: hidden`. Now `fixed` at the `?`'s
  // rectangle, on the asked side when it fits and the other when it does
  // not, kept inside the window; nothing an ancestor clips can reach it.
  const TIP_W = 220;
  const GAP = 7;
  const MARGIN = 8;
  let btn = $state<HTMLElement | null>(null);
  let tipEl = $state<HTMLElement | null>(null);
  let pos = $state({ top: 0, left: 0 });
  function place(): void {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const leftOf = r.left - GAP - TIP_W;
    const rightOf = r.right + GAP;
    const roomLeft = leftOf >= MARGIN;
    const roomRight = rightOf + TIP_W <= vw - MARGIN;
    let left = side === "right" ? (roomRight || !roomLeft ? rightOf : leftOf) : roomLeft || !roomRight ? leftOf : rightOf;
    left = Math.max(MARGIN, Math.min(left, vw - TIP_W - MARGIN));
    const h = tipEl?.offsetHeight ?? 0;
    const top = Math.max(MARGIN, Math.min(r.top - 8, vh - h - MARGIN));
    pos = { top, left };
  }
  $effect(() => {
    if (!open) return;
    place();
    // Once more after the tip has laid out, for its height.
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });
  // A pinned tip closes on a press anywhere else or Escape.
  $effect(() => {
    if (!hs.pinned) return;
    const down = (e: PointerEvent) => {
      if (btn && !btn.contains(e.target as Node)) step("outside");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") step("escape");
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  });
  function onFocus(): void {
    // Keyboard focus only (as `use:tip`): a mouse press that focuses the
    // button is the click's business.
    let keyboard = true;
    try {
      keyboard = btn?.matches(":focus-visible") ?? true;
    } catch {
      /* no :focus-visible: every focus shows it */
    }
    if (keyboard) step("focus");
  }
</script>

<span class="hint">
  <button
    type="button"
    class="q"
    class:open
    bind:this={btn}
    aria-label="What this does"
    aria-describedby={open ? id : undefined}
    onmouseenter={() => step("enter")}
    onmouseleave={() => step("leave")}
    onfocus={onFocus}
    onblur={() => step("blur")}
    onkeydown={(e) => {
      if (e.key === "Escape" && open) step("escape");
    }}
    onclick={(e) => {
      e.preventDefault();
      step("click");
    }}
  >
    ?
  </button>
  {#if open}
    <!-- Item 638: on `document.body`. Inside the Model · Tasks card a
         `fixed` tip was placed against the card, not the window — the
         card's Filament glass (`backdrop-filter`, item 620) makes it the
         containing block — and its `overflow: hidden` cut the tip off. -->
    <span class="tip" role="tooltip" {id} bind:this={tipEl} use:portal style="top: {pos.top}px; left: {pos.left}px"
      >{text}</span
    >
  {/if}
</span>

<style>
  .hint {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .q {
    width: 15px;
    height: 15px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--dim);
    font-size: 10px;
    line-height: 1;
    font-family: var(--sans);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: help;
  }
  .q:hover,
  .q.open {
    border-color: var(--accent);
    color: var(--accent);
  }
  .q:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .tip {
    /* ~~absolute, right: 22px, top: -8px~~ — fixed, placed in the script
       (backlog 180). */
    position: fixed;
    width: 220px;
    box-sizing: border-box;
    padding: 7px 9px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    font-size: 11px;
    color: var(--ink2);
    line-height: 1.4;
    text-align: left;
    white-space: pre-line;
    /* Above the Model · Tasks card (80); under the toasts (100). */
    z-index: 90;
    pointer-events: none;
  }
</style>
