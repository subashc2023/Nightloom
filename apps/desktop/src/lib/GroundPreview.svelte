<script lang="ts">
  // Item 632: one look of the new-chat background, looping on its Settings
  // card (Settings → Animations → New-chat background), drawn by the app's
  // own scene code. Runs only while the card is on screen; one still frame
  // under Reduce motion.
  import { fpsFor, makeScene, parseRgb, type GroundStyle, type GroundView } from "./newChatGround";
  import { reducedMotion } from "./sendMotion";

  let { look }: { look: GroundStyle } = $props();
  let box = $state<HTMLElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    const host = box;
    const c = canvas;
    if (!host || !c || look === "dots") return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const read = (v: string) => {
      c.style.color = v;
      return getComputedStyle(c).color;
    };
    const wv = host.clientWidth;
    const hv = host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(wv * dpr));
    c.height = Math.max(1, Math.round(hv * dpr));
    c.style.width = `${wv}px`;
    c.style.height = `${hv}px`;
    const view: GroundView = {
      w: wv,
      h: hv,
      dpr,
      origin: { x: wv / 2, y: hv / 2 },
      colours: {
        dot: read("var(--ground-dot-ink)") || "rgba(233, 237, 242, 0.08)",
        ink: parseRgb(read("var(--ink)"), [233, 237, 242]),
        signal: parseRgb(read("var(--signal)"), [134, 216, 247]),
        accent: parseRgb(read("var(--accent)"), [255, 180, 84]),
      },
    };
    const scene = makeScene(look, view);
    if (!scene) return;
    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.frame(ctx, t);
    };
    if (reducedMotion()) {
      draw(2600);
      return;
    }
    let raf = 0;
    let last = -Infinity;
    const gap = 1000 / fpsFor(look) - 2;
    const loop = (t: number) => {
      if (t - last >= gap) {
        last = t;
        draw(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="gp" class:still={look === "dots"} bind:this={box} aria-hidden="true">
  {#if look !== "dots"}<canvas bind:this={canvas}></canvas>{/if}
  <span class="gp-wheel"></span>
</div>

<style>
  .gp {
    position: relative;
    height: 110px;
    border-radius: var(--r1);
    overflow: hidden;
    background: var(--paper);
  }
  .gp.still {
    background-image: var(--ground-dots);
    background-size: 22px 22px;
  }
  .gp canvas {
    position: absolute;
    left: 0;
    top: 0;
  }
  /* A small stand-in for the wheel, so the look is seen behind something. */
  .gp-wheel {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 54px;
    height: 54px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: var(--paper);
    border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
    box-shadow: inset 0 0 0 5px var(--paper), inset 0 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent);
  }
</style>
