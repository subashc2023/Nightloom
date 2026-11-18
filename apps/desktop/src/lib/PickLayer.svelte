<script lang="ts">
  /**
   * Pick mode's layer (nightshift item 797): over the whole window while
   * `pick.active`, a crosshair; the element under the pointer outlined
   * with its component and size; a click adds it as a chip to the box pick
   * mode was started from (`pick.svelte.ts`) and pick mode stays on, so
   * several picks collect. Escape, Done, or the Pick button again leaves.
   * Nothing under the layer gets the click, the hover or the key: the page
   * does not change while he points at it.
   */
  import { componentsOf, pickTarget } from "./pick";
  import { pick, stopPick, takeBrowserPick, takePick } from "./pick.svelte";
  import { frames } from "./claudeBrowser.svelte";

  let layer = $state<HTMLDivElement | null>(null);
  let bar = $state<HTMLDivElement | null>(null);
  let hover = $state<{ x: number; y: number; w: number; h: number; line: string } | null>(null);
  let target: Element | null = null;

  /** The page's element under the point, past the layer's own marks. */
  function under(x: number, y: number): Element | null {
    const stack = document.elementsFromPoint(x, y);
    // Claude's browser picture wins over anything drawn on top of it (the
    // tab's own marks): a click there means the page.
    const at = stack.findIndex((el) => el instanceof HTMLElement && el.dataset.pickBrowser !== undefined);
    if (at >= 0) {
      const shot = stack[at];
      const tab = shot.parentElement;
      // Only the tab's own marks may lie over it — not a menu or a dialog.
      const over = stack.slice(0, at).filter((el) => !layer?.contains(el) && !bar?.contains(el));
      if (over.every((el) => tab?.contains(el))) return shot;
    }
    for (const el of stack) {
      if (layer?.contains(el) || bar?.contains(el)) continue;
      if (el === document.documentElement || el === document.body) return null;
      return pickTarget(el);
    }
    return null;
  }

  function onmove(e: PointerEvent) {
    const el = under(e.clientX, e.clientY);
    target = el;
    if (!el) {
      hover = null;
      return;
    }
    const shot = browserPicture(el);
    if (shot) {
      // Over Claude's browser: the page is picked, not the picture.
      const r = shot.getBoundingClientRect();
      hover = { x: r.left, y: r.top, w: r.width, h: r.height, line: "Claude's browser · click what you mean in the page" };
      return;
    }
    const r = el.getBoundingClientRect();
    const who = componentsOf(el)[0];
    hover = {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      line: `${who ? `${who} · ` : ""}${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`,
    };
  }

  /** Claude's browser picture `el` is (in), or null. */
  function browserPicture(el: Element): HTMLElement | null {
    return el.closest<HTMLElement>("[data-pick-browser]");
  }

  function onclick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = under(e.clientX, e.clientY) ?? target;
    if (!el) return;
    const shot = browserPicture(el);
    if (shot) {
      const session = shot.dataset.pickBrowser ?? "";
      const pw = Number(shot.dataset.pageW) || 1280;
      const ph = Number(shot.dataset.pageH) || 800;
      const r = shot.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || !session) return;
      const x = Math.min(pw - 1, Math.max(0, ((e.clientX - r.left) / r.width) * pw));
      const y = Math.min(ph - 1, Math.max(0, ((e.clientY - r.top) / r.height) * ph));
      const f = frames[session];
      void takeBrowserPick(session, x, y, f ? { src: f.src, w: f.w } : null, pw);
      return;
    }
    void takePick(el);
  }

  $effect(() => {
    if (!pick.active) {
      hover = null;
      target = null;
      return;
    }
    // Escape leaves pick mode and goes nowhere else (not to a dialog, a
    // box, the aside under it); every other key is held back too.
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") stopPick();
    };
    // The window losing focus leaves it: he went to another app.
    const blur = () => stopPick();
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  });
</script>

{#if pick.active}
  <!-- The layer is pointer-only: Escape and every other key are taken by
       the window-level listener above, so the div needs no key handler. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="presentation"
    class="pick-layer"
    class:shooting={pick.shooting}
    bind:this={layer}
    onpointermove={onmove}
    onpointerleave={() => (hover = null)}
    {onclick}
    oncontextmenu={(e) => e.preventDefault()}
    onwheel={(e) => e.preventDefault()}
  >
    {#if hover && !pick.shooting}
      <div class="pick-box" style="left:{hover.x}px;top:{hover.y}px;width:{hover.w}px;height:{hover.h}px"></div>
      <div
        class="pick-tag mono"
        style="left:{Math.max(4, hover.x)}px;top:{hover.y > 26 ? hover.y - 22 : hover.y + hover.h + 4}px"
      >
        {hover.line}
      </div>
    {/if}
  </div>
  <div class="pick-bar" class:shooting={pick.shooting} bind:this={bar} role="status">
    <span class="pick-dot" aria-hidden="true"></span>
    <span>Pick mode — click what you mean; each click adds a chip to the message box</span>
    {#if pick.made > 0}<span class="pick-made mono">{pick.made} picked</span>{/if}
    <button class="ns-btn small" onclick={() => stopPick()}>Done <kbd class="mono">Esc</kbd></button>
  </div>
{/if}

<style>
  .pick-layer {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    cursor: crosshair;
  }
  .pick-box {
    position: fixed;
    pointer-events: none;
    outline: 2px solid var(--accent, #6cf);
    outline-offset: -1px;
    background: color-mix(in srgb, var(--accent, #6cf) 14%, transparent);
    border-radius: 2px;
  }
  .pick-tag {
    position: fixed;
    pointer-events: none;
    font-size: 11px;
    line-height: 18px;
    padding: 0 6px;
    border-radius: 3px;
    background: var(--accent, #6cf);
    color: var(--on-accent, #000);
    white-space: nowrap;
  }
  .pick-bar {
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483001;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 12px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--text, #ddd);
    background: var(--raised, var(--panel, #111));
    border: 1px solid var(--accent, #6cf);
    box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
    max-width: calc(100vw - 24px);
    box-sizing: border-box;
  }
  .pick-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent, #6cf);
  }
  .pick-made {
    color: var(--muted, #999);
    white-space: nowrap;
  }
  .pick-bar kbd {
    font-size: 10px;
    opacity: 0.7;
    margin-left: 4px;
  }
  /* Hidden while the window's picture is taken, so the crop is the page. */
  .shooting,
  .pick-layer.shooting {
    visibility: hidden;
  }
</style>
