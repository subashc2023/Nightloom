<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import {
    DRAG_THRESHOLD,
    JUMP_EPS,
    MAG_INFLUENCE,
    RIB_END,
    RIB_GAP,
    RIB_ROW,
    TOOLTIP_OPEN_DELAY,
    columnFollow,
    inViewRange,
    magnified,
    magnifyFalloff,
    nextTarget,
    prevTarget,
    previewText,
    ribBox,
    ribDims,
    snapPx,
    snapScroll,
    type Tick,
  } from "./navigator";

  /**
   * The message navigator (nightshift backlog 065, 2026-09-15; since item
   * 359, 2026-10-15, a port of LibreChat's — blocker 1444, his "maybe jus
   * use the librechat one"). LibreChat's `MessageNav.tsx`
   * (github.com/danny-avila/LibreChat, `client/src/components/Chat/
   * Messages/`, main as read 2026-10-15; MIT License, Copyright (c) 2026
   * LibreChat — the full notice is in `navigator.ts`), rewritten for
   * Svelte and this app's tokens:
   *
   *   ⌃            step to the previous message (greyed when none)
   *   ·            origin dot — the top of the chat
   *   ━ ━ ━ …      one rib per message, 6 px rows 6 px apart, in a column
   *                that scrolls on its own and keeps the on-screen ribs
   *                in its middle
   *   ·            terminus dot — the foot of the chat (re-pins)
   *   ⌄            step to the next message
   *
   * Ribs are 12×3 at rest, 21×3 for the one being read, and swell to 39×6
   * under the pointer along a cosine bell 50 px tall. Tones: at rest
   * `--dim` at 40 % (full while the rail is hovered or focused), on screen
   * `--ink2`, the one being read or pointed at `--ink`. One preview card,
   * 8 px left of the column, opens after 60 ms and then follows. A press
   * that moves 4 px scrubs. One tab stop; ↑ ↓ Home End walk the ribs; ⌥⇧M
   * focuses the rail. ⌥↑ / ⌥↓ on the transcript still step (ours).
   *
   * Dropped from ours because they changed the look (359's spec): amber
   * reply ticks, width by length, the "YOU / REPLY" header on the bubble.
   *
   * Geometry is snapped to device pixels (`snapPx`; `devicePixelRatio`
   * includes page zoom in WebKit), so every rib is equally thick at 90, 100
   * and 125 %.
   *
   * `Transcript.svelte` owns which tick is being read (`active`) and the
   * scrolling; this reads the viewport to draw the in-view band, the
   * chevrons' targets and its own column's follow.
   */
  let {
    ticks,
    active,
    viewport,
    onjump,
    ontop,
    onend,
  }: {
    ticks: Tick[];
    /** Index into `ticks` of the message being read, or null. */
    active: number | null;
    viewport: HTMLElement | null;
    /** Scroll to tick i: eased, or at once for a drag. */
    onjump: (i: number, instant?: boolean) => void;
    ontop: (instant?: boolean) => void;
    onend: (instant?: boolean) => void;
  } = $props();

  type Key = number | "start" | "end";

  let nav = $state<HTMLElement | null>(null);
  let col = $state<HTMLDivElement | null>(null);
  let dpr = $state(typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  let range = $state<[number, number] | null>(null);
  let canUp = $state(false);
  let canDown = $state(false);
  let scrolls = $state(false);
  let atFoot = $state(false);
  let atTop = $state(true);
  let navTop = $state<number | null>(null);
  let navRight = $state(8);
  /** The rib the pointer or keyboard is previewing. */
  let hoverKey = $state<Key | null>(null);
  /** The rib the keyboard last landed on (the roving tab stop). */
  let focusedRib = $state<number | null>(null);
  let tip = $state<{ key: Key; top: number } | null>(null);

  let tops: number[] = [];
  let pointerY: number | null = null;
  let magRaf = 0;
  let tickRaf = 0;
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let tipShown = false;
  let tipTop = 0;
  let interacting = false;
  let dragging = false;
  let suppressClick = false;
  let dragCleanup: (() => void) | null = null;
  const reduce =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const px = (n: number) => snapPx(n, dpr);
  const endBox = $derived(ribBox(RIB_END.baseW, RIB_END.baseH, RIB_ROW, dpr));
  /** The terminus is the one being read at the foot of a chat that
   *  scrolls (theirs); otherwise `active` is. */
  const footCurrent = $derived(scrolls && atFoot);
  const current = $derived(footCurrent ? null : active);
  const roving = $derived(
    focusedRib !== null && focusedRib < ticks.length
      ? focusedRib
      : footCurrent
        ? ticks.length - 1
        : (active ?? 0),
  );

  function inView(i: number): boolean {
    return range !== null && i >= range[0] && i <= range[1];
  }

  // ---- Reading the viewport (their scroll-spy `tick`) ----

  function measure() {
    tickRaf = 0;
    if (!viewport) return;
    dpr = devicePixelRatio || 1;
    const vr = viewport.getBoundingClientRect();
    const st = viewport.scrollTop;
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const bottoms: number[] = [];
    // Item 482: every anchor in one pass, as Transcript's `measureNav` (item
    // 454). `anchor(i)` per tick ran a selector over the whole transcript
    // for each — quadratic in the chat's length, on every scroll frame. The
    // first match in document order, as `querySelector`'s.
    const found = new Map<string, HTMLElement>();
    for (const el of viewport.querySelectorAll<HTMLElement>("[data-turn], [data-nav-live]")) {
      const turn = el.getAttribute("data-turn");
      if (turn !== null && !found.has(turn)) found.set(turn, el);
      if (el.hasAttribute("data-nav-live") && !found.has("live")) found.set("live", el);
    }
    tops = ticks.map((t) => {
      const el = found.get(t.index < 0 ? "live" : String(t.index)) ?? null;
      if (!el) {
        bottoms.push(Infinity);
        return Infinity;
      }
      const r = el.getBoundingClientRect();
      const top = r.top - vr.top + st;
      bottoms.push(top + r.height);
      return top;
    });
    scrolls = max > 0;
    atFoot = scrolls && st >= max - JUMP_EPS;
    atTop = st <= JUMP_EPS;
    canUp = prevTarget(tops, st, max) !== null;
    canDown = nextTarget(tops, st, max) !== null;
    range = inViewRange(tops, bottoms, st, viewport.clientHeight);
    place();
    follow();
  }
  function schedule() {
    if (!tickRaf) tickRaf = requestAnimationFrame(measure);
  }

  /** Vertically centred in the transcript's area, 8 px from its right
   *  edge, on whole device pixels (their `top-1/2 -translate-y-1/2
   *  right-2`, without the half pixel a translate can leave). */
  function place() {
    if (!nav) return;
    const parent = nav.offsetParent as HTMLElement | null;
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const want = (parent.clientHeight - nav.offsetHeight) / 2;
    navTop = Math.round((pr.top + want) * dpr) / dpr - pr.top;
    const rightEdge = pr.left + parent.clientWidth - 8;
    navRight = pr.left + parent.clientWidth - Math.round(rightEdge * dpr) / dpr;
  }

  /** Their column follow: hold still under an active gesture; at the foot,
   *  pin to its own foot; else centre the on-screen ribs. */
  function follow() {
    if (!col || interacting) return;
    const kids = col.children;
    const target = columnFollow(
      range,
      ticks.length,
      atFoot,
      (i) => (kids[i] as HTMLElement | undefined)?.offsetTop ?? 0,
      (i) => {
        const k = kids[i] as HTMLElement | undefined;
        return k ? k.offsetTop + k.offsetHeight : 0;
      },
      col.clientHeight,
      col.scrollHeight,
    );
    if (target !== null) col.scrollTop = snapScroll(target, dpr, col.scrollHeight - col.clientHeight);
  }

  $effect(() => {
    const v = viewport;
    if (!v) return;
    void ticks;
    v.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(v);
    if (v.firstElementChild) ro?.observe(v.firstElementChild);
    if (nav) ro?.observe(nav);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      v.removeEventListener("scroll", schedule);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  });
  // The rib being read changes its rest width; re-read after it does.
  $effect(() => {
    void current;
    void ticks.length;
    schedule();
  });

  // ---- The magnifier and the preview ----

  function ribEls(): HTMLElement[] {
    return col ? Array.from(col.querySelectorAll<HTMLElement>("[data-rib]")) : [];
  }

  function nearest(clientY: number): { i: number; d: number; centre: number } | null {
    if (!col) return null;
    const cr = col.getBoundingClientRect();
    const y = clientY - cr.top + col.scrollTop;
    let best: { i: number; d: number; centre: number } | null = null;
    const ribs = ribEls();
    for (let i = 0; i < ribs.length; i++) {
      const b = ribs[i];
      const c = b.offsetTop + b.offsetHeight / 2;
      const d = Math.abs(y - c);
      if (!best || d < best.d) best = { i, d, centre: c };
    }
    return best;
  }

  function applyMagnify() {
    magRaf = 0;
    if (!col || pointerY === null) return;
    const cr = col.getBoundingClientRect();
    const y = pointerY - cr.top + col.scrollTop;
    if (!reduce?.matches) {
      ribEls().forEach((b, i) => {
        const line = b.firstElementChild as HTMLElement | null;
        if (!line) return;
        const t = magnifyFalloff(Math.abs(y - (b.offsetTop + b.offsetHeight / 2)), MAG_INFLUENCE);
        const s = magnified(ribDims(false, i === current), t);
        const box = ribBox(s.w, s.h, RIB_ROW, dpr);
        line.style.transition = "none";
        line.style.width = `${box.w}px`;
        line.style.height = `${box.h}px`;
        line.style.marginTop = `${box.top}px`;
      });
    }
    const n = nearest(pointerY);
    if (n && n.d <= MAG_INFLUENCE && !dragging && nav) {
      const top = cr.top - nav.getBoundingClientRect().top - col.scrollTop + n.centre;
      showTip(n.i, top);
    } else {
      clearTip();
    }
  }

  /** Back to the resting sizes, eased over 140 ms (theirs). */
  function resetMagnify() {
    ribEls().forEach((b, i) => {
      const line = b.firstElementChild as HTMLElement | null;
      if (!line) return;
      const d = ribDims(false, i === current);
      const box = ribBox(d.baseW, d.baseH, RIB_ROW, dpr);
      line.style.transition = "width 140ms ease-out, height 140ms ease-out, margin-top 140ms ease-out";
      line.style.width = `${box.w}px`;
      line.style.height = `${box.h}px`;
      line.style.marginTop = `${box.top}px`;
    });
  }

  function showTip(key: Key, top: number) {
    tipTop = top;
    if (tip && tipShown) tip = { key, top };
    if (hoverKey === key) return;
    hoverKey = key;
    if (tipShown) {
      tip = { key, top };
      return;
    }
    if (tipTimer) return;
    tipTimer = setTimeout(() => {
      tipTimer = undefined;
      tipShown = true;
      if (hoverKey !== null) tip = { key: hoverKey, top: tipTop };
    }, TOOLTIP_OPEN_DELAY);
  }
  function clearTip() {
    clearTimeout(tipTimer);
    tipTimer = undefined;
    hoverKey = null;
    tipShown = false;
    tip = null;
  }

  function tipText(key: Key): string {
    if (key === "start") return "Scroll to top";
    if (key === "end") return "Scroll to bottom";
    const t = ticks[key];
    return t ? previewText(t) : "";
  }

  function pointermove(e: PointerEvent) {
    interacting = true;
    pointerY = e.clientY;
    if (!magRaf) magRaf = requestAnimationFrame(applyMagnify);
  }
  function pointerleave() {
    pointerY = null;
    if (!dragging) interacting = false;
    cancelAnimationFrame(magRaf);
    magRaf = 0;
    resetMagnify();
    clearTip();
  }
  function colScroll() {
    if (pointerY !== null && !magRaf) magRaf = requestAnimationFrame(applyMagnify);
  }

  function endTip(e: Event, key: "start" | "end") {
    if (!nav) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showTip(key, r.top + r.height / 2 - nav.getBoundingClientRect().top);
  }

  // ---- Choosing, scrubbing, keys ----

  function select(key: Key) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (key === "start") ontop();
    else if (key === "end") onend();
    else onjump(key);
  }
  function colClick() {
    if (typeof hoverKey === "number") select(hoverKey);
  }

  function scrub(clientY: number) {
    if (!col) return;
    const r = col.getBoundingClientRect();
    if (clientY >= r.bottom) return onend(true);
    if (clientY <= r.top) return ontop(true);
    const n = nearest(clientY);
    if (n) onjump(n.i, true);
  }

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragCleanup?.();
    suppressClick = false;
    interacting = true;
    const id = e.pointerId;
    const startY = e.clientY;
    let moved = false;
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", finish);
      dragCleanup = null;
      dragging = false;
      if (pointerY === null) interacting = false;
      if (moved) {
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
      }
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if ((ev.buttons & 1) === 0) return finish();
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        dragging = true;
        clearTip();
      }
      scrub(ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === id) finish();
    };
    dragCleanup = finish;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    window.addEventListener("blur", finish);
  }

  function colFocus(e: FocusEvent) {
    const b = e.target as HTMLElement;
    const i = Number(b.dataset?.rib);
    if (!Number.isInteger(i)) return;
    focusedRib = i;
    interacting = true;
    const r = b.getBoundingClientRect();
    pointerY = r.top + r.height / 2;
    if (!magRaf) magRaf = requestAnimationFrame(applyMagnify);
  }
  function colBlur(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (col && next && col.contains(next)) return;
    focusedRib = null;
    pointerleave();
  }
  function colKeys(e: KeyboardEvent) {
    const k = e.key;
    if (k !== "ArrowUp" && k !== "ArrowDown" && k !== "Home" && k !== "End") return;
    const ribs = ribEls();
    if (ribs.length === 0) return;
    const at = ribs.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (k === "End") next = ribs.length - 1;
    else if (k === "ArrowUp") next = at <= 0 ? 0 : at - 1;
    else if (k === "ArrowDown") next = at < 0 ? 0 : Math.min(ribs.length - 1, at + 1);
    e.preventDefault();
    e.stopPropagation();
    ribs[next].focus();
  }

  /** ⌥⇧M focuses the rail (theirs). */
  function globalKeys(e: KeyboardEvent) {
    if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (e.code !== "KeyM" && e.key.toLowerCase() !== "m") return;
    const target =
      nav?.querySelector<HTMLElement>('[aria-current="true"]') ??
      nav?.querySelector<HTMLElement>("[data-rib]");
    if (!target) return;
    target.focus();
    e.preventDefault();
  }
  $effect(() => {
    window.addEventListener("keydown", globalKeys);
    return () => window.removeEventListener("keydown", globalKeys);
  });

  function prev() {
    if (!viewport) return;
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const i = prevTarget(tops, viewport.scrollTop, max);
    if (i === null) ontop();
    else onjump(i);
  }
  function next() {
    if (!viewport) return;
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const i = nextTarget(tops, viewport.scrollTop, max);
    if (i !== null) onjump(i);
  }

  onDestroy(() => {
    dragCleanup?.();
    cancelAnimationFrame(magRaf);
    cancelAnimationFrame(tickRaf);
    clearTimeout(tipTimer);
  });

  function label(t: Tick): string {
    const said = previewText(t).slice(0, 30);
    return t.role === "user" ? `Go to your message: ${said}` : `Go to the reply: ${said}`;
  }
</script>

<nav
  class="nav"
  bind:this={nav}
  aria-label="Messages"
  aria-keyshortcuts="Shift+Alt+M"
  style:top={navTop === null ? "50%" : `${navTop}px`}
  style:transform={navTop === null ? "translateY(-50%)" : null}
  style:right="{navRight}px"
  style:gap="{px(RIB_GAP)}px"
  style:--row="{px(RIB_ROW)}px"
  style:padding="{px(8)}px {px(6)}px"
>
  <button class="chev" onclick={prev} disabled={!canUp} aria-label="Previous message">
    <span class="up"><Icon name="chev" size={16} /></span>
  </button>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="end" onpointerdown={pointerdown} onpointerenter={(e) => endTip(e, "start")} onpointerleave={clearTip}>
    <button
      class="rib"
      class:inview={atTop}
      class:emph={hoverKey === "start"}
      onclick={() => select("start")}
      onfocus={(e) => endTip(e, "start")}
      onblur={clearTip}
      aria-label="Scroll to top"
    >
      <span class="line dot" style:width="{endBox.w}px" style:height="{endBox.h}px" style:margin-top="{endBox.top}px"
      ></span>
    </button>
  </div>

  <!-- The column takes the pointer and the keys for all its ribs (theirs:
       one hit test, one tab stop); each rib is still a button. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="col"
    bind:this={col}
    style:gap="{px(RIB_GAP)}px"
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerleave={pointerleave}
    onfocusin={colFocus}
    onfocusout={colBlur}
    onclick={colClick}
    onkeydown={colKeys}
    onscroll={colScroll}
  >
    {#each ticks as t, i (t.index)}
      {@const d = ribDims(false, i === current)}
      {@const box = ribBox(d.baseW, d.baseH, RIB_ROW, dpr)}
      <button
        class="rib"
        class:inview={inView(i)}
        class:emph={i === current || hoverKey === i}
        data-rib={i}
        tabindex={i === roving ? 0 : -1}
        aria-label={label(t)}
        aria-current={i === current ? "true" : undefined}
        onclick={(e) => {
          e.stopPropagation();
          select(i);
        }}
      >
        <span class="line" style:width="{box.w}px" style:height="{box.h}px" style:margin-top="{box.top}px"></span>
      </button>
    {/each}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="end" onpointerdown={pointerdown} onpointerenter={(e) => endTip(e, "end")} onpointerleave={clearTip}>
    <button
      class="rib"
      class:inview={atFoot || !scrolls}
      class:emph={footCurrent || hoverKey === "end"}
      onclick={() => select("end")}
      onfocus={(e) => endTip(e, "end")}
      onblur={clearTip}
      aria-label="Scroll to bottom"
      aria-current={footCurrent ? "true" : undefined}
    >
      <span class="line dot" style:width="{endBox.w}px" style:height="{endBox.h}px" style:margin-top="{endBox.top}px"
      ></span>
    </button>
  </div>

  <button class="chev" onclick={next} disabled={!canDown} aria-label="Next message">
    <Icon name="chev" size={16} />
  </button>

  {#if tip && tipText(tip.key) !== ""}
    <div class="tip" role="tooltip" style:top="{tip.top}px">
      <p>{tipText(tip.key)}</p>
    </div>
  {/if}
</nav>

<style>
  /* Their `absolute top-1/2 right-2 max-h-[min(24rem,calc(100%-2rem))]
     flex-col items-end gap-1.5 px-1.5 py-2`; top and right are set in
     whole device pixels by `place()`. Positioned by the parent's
     `.content`, the transcript's area. */
  .nav {
    position: absolute;
    z-index: 4;
    max-height: min(384px, calc(100% - 32px));
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    box-sizing: border-box;
  }
  /* Their chevron: 16 px, `p-0.5 -mr-1 rounded-md`, tertiary at 40 %;
     secondary while the rail is hovered, primary on itself, 30 % when
     there is nowhere to go. */
  .chev {
    flex: none;
    margin-right: -4px;
    padding: 2px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--dim);
    opacity: 0.4;
    cursor: pointer;
    display: flex;
    transition:
      color 0.3s,
      opacity 0.3s;
  }
  .nav:hover .chev,
  .nav:focus-within .chev {
    color: var(--ink2);
    opacity: 1;
  }
  .nav:hover .chev:hover:not(:disabled) {
    color: var(--ink);
  }
  .nav:hover .chev:disabled,
  .nav:focus-within .chev:disabled {
    opacity: 0.3;
  }
  .chev:disabled {
    cursor: default;
  }
  .up {
    display: inline-flex;
    transform: rotate(180deg);
  }
  .end,
  .col {
    width: 56px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .end {
    flex: none;
  }
  .col {
    position: relative;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .col::-webkit-scrollbar {
    display: none;
  }
  /* A rib: a full-width row (its hit target), the line at its right. */
  .rib {
    flex: none;
    width: 100%;
    height: var(--row);
    padding: 0;
    border: none;
    background: none;
    border-radius: 2px;
    display: flex;
    /* The line's top is set in device pixels (`ribBox`), not centred. */
    align-items: flex-start;
    justify-content: flex-end;
    cursor: pointer;
    color: var(--dim);
    opacity: 0.4;
    transition: opacity 0.3s;
  }
  .nav:hover .rib,
  .nav:focus-within .rib {
    opacity: 1;
  }
  .rib.inview {
    color: var(--ink2);
    opacity: 1;
  }
  .rib.emph {
    color: var(--ink);
    opacity: 1;
  }
  .rib:focus-visible,
  .chev:focus-visible {
    outline: 2px solid var(--line2);
    outline-offset: 0;
  }
  .line {
    display: block;
    flex: none;
    border-radius: 999px;
    background: currentColor;
  }
  /* Their `mr-[0.28125rem]`: the dots sit 4.5 px in from the right. */
  .line.dot {
    margin-right: 4.5px;
  }
  /* Their preview: 8 px left of the column, `rounded-xl border
     border-border-light bg-surface-secondary text-text-secondary px-3 py-2
     shadow-lg max-w-[17.5rem]`, three lines of `text-xs`. */
  .tip {
    position: absolute;
    right: calc(100% + 2px);
    transform: translateY(-50%);
    width: max-content;
    max-width: 280px;
    padding: 8px 12px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    box-shadow:
      0 10px 15px -3px rgba(0, 0, 0, 0.25),
      0 4px 6px -4px rgba(0, 0, 0, 0.25);
    color: var(--ink2);
    pointer-events: none;
    z-index: 5;
  }
  .tip p {
    margin: 0;
    font-family: var(--sans);
    font-size: 12px;
    line-height: 16px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
</style>
