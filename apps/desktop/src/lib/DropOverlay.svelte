<script lang="ts">
  /**
   * Item 362 — what the window draws while files are dragged and as they
   * land (his mix, blocker 1445; the look is described in `dropLook.ts`).
   * Mounted once by the chat's composer: the veil over the chat and the
   * dashed zone above the box while a file is held over the chat or the
   * box; at the drop, the dragged files shrinking into the box and a
   * ripple from the drop point. Everything here is drawn in a layer of its
   * own on `body`, under the pointer's notice (`pointer-events: none`), so
   * the drag's target stays the chat or the box beneath it.
   */
  import { onMount } from "svelte";
  import { LAND_MS, RIPPLE_FROM, RIPPLE_TO, ZONE_LINE, veilClip, zoneRect, zoneTitle, type Rect } from "./dropLook";
  import { drop, endLanding, registerChatDrop, watchDrops, type Landing } from "./dropLook.svelte";
  import { prefersReducedMotion } from "./chipFade";

  let { root, accept }: { root: () => HTMLElement | null; accept: (files: File[]) => void } = $props();

  const card = () => root()?.querySelector(".card") ?? null;

  onMount(() => {
    const unwatch = watchDrops();
    const unregister = registerChatDrop({ accept: (f) => accept(f), card });
    return () => {
      unregister();
      unwatch();
    };
  });

  /** Moves the layer to `body`, out of any transformed ancestor. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  type Geo = { veil: Rect; clip: string | null; zone: Rect | null };
  let geo = $state<Geo | null>(null);
  const shown = $derived(drop.kind === "chat" || drop.kind === "main");
  let reduced = $state(false);

  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // Measured when the veil comes up (the layout does not move while a
  // file is held), and again if the window is resized meanwhile.
  $effect(() => {
    if (!shown) {
      geo = null;
      return;
    }
    const measure = () => {
      const chat = document.querySelector("[data-drop-chat]");
      const box = root();
      const c = card();
      if (!chat || !box || !c) {
        geo = null;
        return;
      }
      const veil = rectOf(chat);
      const comp = rectOf(box);
      geo = { veil, clip: veilClip(veil, comp), zone: zoneRect(veil, rectOf(c), comp.top) };
    };
    reduced = prefersReducedMotion();
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  /** The landing: the files shrink toward the box and fade; the ripple
   *  spreads from the drop point. Removed when done. */
  function land(node: HTMLElement, l: Landing) {
    const urls: string[] = [];
    for (const img of node.querySelectorAll<HTMLImageElement>("img[data-i]")) {
      const t = l.tiles[Number(img.dataset.i)];
      if (t?.kind === "image") {
        const u = URL.createObjectURL(t.file);
        urls.push(u);
        img.src = u;
      }
    }
    const ghost = node.querySelector<HTMLElement>(".ghost");
    const ripple = node.querySelector<HTMLElement>(".ripple");
    const ease = "cubic-bezier(0.33, 1, 0.68, 1)";
    const dx = l.toX - l.x;
    const dy = l.toY - l.y;
    // The shrink eases out; the fade is even, so the files stay readable
    // while they shrink (pick362's A at t=0.3: half size, two-thirds on).
    ghost?.animate(
      [
        { transform: "translate(-30%, -30%) scale(1)" },
        { transform: `translate(calc(${dx}px - 30%), calc(${dy}px - 30%)) scale(0.3)` },
      ],
      { duration: LAND_MS, easing: ease, fill: "forwards" },
    );
    ghost?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LAND_MS, easing: "linear", fill: "forwards" });
    const done = ripple?.animate(
      [
        { width: `${RIPPLE_FROM}px`, height: `${RIPPLE_FROM}px`, opacity: 0.55 },
        { width: `${RIPPLE_TO}px`, height: `${RIPPLE_TO}px`, opacity: 0 },
      ],
      { duration: LAND_MS, easing: ease, fill: "forwards" },
    );
    const end = () => endLanding(l.id);
    if (done) done.onfinish = end;
    else setTimeout(end, LAND_MS);
    return { destroy: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
  }
</script>

<div class="drop-layer" use:portal aria-hidden="true">
  {#if shown && geo}
    <div
      class="veil"
      class:still={reduced}
      style:left="{geo.veil.left}px"
      style:top="{geo.veil.top}px"
      style:width="{geo.veil.width}px"
      style:height="{geo.veil.height}px"
      style:clip-path={geo.clip}
    ></div>
    {#if geo.zone}
      <div
        class="zone"
        class:on={drop.kind === "main"}
        style:left="{geo.zone.left}px"
        style:top="{geo.zone.top}px"
        style:width="{geo.zone.width}px"
        style:height="{geo.zone.height}px"
      >
        <svg class="ic" viewBox="0 0 24 24" width="22" height="22"
          ><path
            d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          /></svg
        >
        <b>{zoneTitle(drop.kind === "main" ? "main" : "chat")}</b>
        <span>{ZONE_LINE}</span>
      </div>
    {/if}
  {/if}
  {#each drop.landings as l (l.id)}
    <div class="landing" style:left="{l.x}px" style:top="{l.y}px" use:land={l}>
      <span class="ripple"></span>
      <div class="ghost">
        {#each l.tiles as t, i (i)}
          <span class="g" class:doc={t.kind === "doc"} style:--i={i}
            >{#if t.kind === "image"}<img data-i={i} alt="" />{:else}{t.ext}{/if}</span
          >
        {/each}
        {#if l.tiles.length + l.more > 1}<span class="count">{l.tiles.length + l.more}</span>{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  /* The layer is the viewport; what is in it is placed in window
     coordinates by `absolute` (a fixed element inside a fixed layer did not
     paint in WebKit's snapshot, 2026-10-15). */
  .drop-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 40;
  }
  .veil {
    position: absolute;
    background: color-mix(in srgb, var(--paper) 72%, transparent);
    backdrop-filter: blur(2px);
    animation: drop-fade 140ms ease-out;
  }
  .zone {
    position: absolute;
    box-sizing: border-box;
    border: 2px dashed var(--line2);
    border-radius: 16px;
    background: color-mix(in srgb, var(--sheet) 80%, transparent);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--ink2);
    font-size: 12.5px;
    overflow: hidden;
    animation: drop-fade 140ms ease-out;
    transition:
      border-color 120ms,
      background-color 120ms,
      box-shadow 120ms;
  }
  .zone b {
    font-size: 17px;
    color: var(--ink);
    font-weight: 500;
  }
  .zone .ic {
    color: var(--dim);
  }
  .zone.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 85%, transparent);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .zone.on b,
  .zone.on .ic {
    color: var(--accent-ink);
  }
  .landing {
    position: absolute;
    width: 0;
    height: 0;
  }
  .ripple {
    position: absolute;
    left: 0;
    top: 0;
    width: 40px;
    height: 40px;
    opacity: 0;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 2px solid var(--accent);
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%);
  }
  .ghost {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
  }
  .g {
    position: absolute;
    left: calc(var(--i) * 7px);
    top: calc(var(--i) * -6px);
    width: 58px;
    height: 58px;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    font: 600 11px var(--mono);
    color: var(--ink2);
    background: var(--well);
    border: 1px solid var(--line2);
    transform: rotate(calc((var(--i) - 1) * 5deg));
    z-index: calc(3 - var(--i));
  }
  .g.doc {
    width: 46px;
  }
  .g img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .count {
    position: absolute;
    left: 50px;
    top: -16px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 9px;
    background: var(--accent);
    color: var(--paper);
    font: 600 11px/18px var(--sans);
    text-align: center;
  }
  /* Reduced motion: the veil and the zone appear and go without fading. */
  .veil.still,
  .veil.still ~ .zone {
    animation: none;
  }
  @keyframes drop-fade {
    from {
      opacity: 0;
    }
  }
  /* A message's edit box held over (B's first frame): the box's edge is
     accent already, so the held state adds the ring and the tint. */
  :global(.editor[data-drop-box].drop-over textarea) {
    background: color-mix(in srgb, var(--accent-soft) 60%, var(--sheet));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
</style>
