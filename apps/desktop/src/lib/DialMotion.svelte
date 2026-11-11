<script lang="ts">
  /**
   * Item 581: the new-chat dial's motion — one canvas under the dial
   * (`ContextDial.svelte` is untouched), drawn by one requestAnimationFrame
   * loop while the page is visible. His words: "like the turning of the
   * gears, or like putting a minute clock on it that ticks, or like the
   * vibrating … audio thing". Layers, outside in:
   *
   * - wave   — the audio ring: a spoke every 2° just outside the tick scale,
   *            idling in three slow travelling waves; it surges while he
   *            types in the message box (`typed`), on open, on a project
   *            switch, and swells (with an expanding ring) when a prompt
   *            layer is switched and the arcs re-flow (`flowKey`).
   * - hand   — the clock: a bright tick on the tick scale that steps once a
   *            second on the wall clock, overshooting and settling, with a
   *            faint trail filling the minute's lap.
   * - gearA  — 60 teeth inside the inner ring, turning clockwise one tooth a
   *            second; three index teeth make the turn legible.
   * - gearB  — 40 blocks, counter-clockwise, stepping one block each time a
   *            gearA tooth passes 12 o'clock (an escapement: they mesh).
   * - gearC  — three long arc segments turning clockwise, slower.
   * - slow   — the 5-hour window's hand: how far through the window he is
   *            (`plan.resetsAt`), its time left on hover.
   * - radar  — a faint sweep round the band behind the gears, every 5 s.
   *
   * Hover on a part of the dial (`lit`) lights the gear teeth inside that
   * part's span; a project switch (`spinKey`) spins the gears up for about
   * a second. Under `prefers-reduced-motion: reduce` one still frame is
   * drawn (redrawn on hover, theme and once a minute) and nothing loops.
   * The loop stops while the document is hidden.
   *
   * Below 150 px (the short pane's 84 px dial) the compact form draws the
   * wave, one gear and the clock tick only.
   *
   * Item 586: the audio ring leans toward the pointer — the spokes facing it
   * vibrate harder and reach further (`pointerPull` in dialMotion.ts: a lobe
   * toward the pointer, weaker the further the pointer is from the dial), and
   * a moving pointer adds a short surge. Pointer events only record where it
   * is; the loop reads it. Off the page it eases back to idle; under reduced
   * motion the still frame ignores it.
   *
   * Item 587: `column` is the right column's 104 px form — every layer of
   * the new-chat dial (his "the same new chat animations"), re-laid for the
   * size: the wave (48 thicker spokes) and the seconds tick outside the
   * track; gear A (24 teeth), gear B (16 blocks), gear C and the 5-hour hand
   * (on gear C's radius), and the radar, all in the band between the figure's
   * corners (r ≈ 30) and the inner ring (r ≈ 44), so the figure stays clear.
   */
  import { onMount, untrack } from "svelte";
  import { tip as tipAction } from "./tip";
  import { shortClock } from "./newChatPage";
  import {
    drive,
    escapement,
    integral,
    inSpan,
    kick,
    easePresence,
    level,
    pointerPull,
    pointerSpoke,
    POINTER_HOVER,
    prune,
    stirKick,
    secondsAngle,
    windowElapsed,
    windowTip,
  } from "./dialMotion";

  interface Props {
    /** The dial's track diameter, px (ContextDial's `size`). */
    size: number;
    /** ContextDial's `pad`: the canvas centres on the dial's box. */
    pad: number;
    /** The hovered part's span, as shares of a turn from 12 o'clock. */
    lit?: { from: number; share: number } | null;
    /** A change spins the gears up (the project). */
    spinKey?: string | null;
    /** A change swells the wave (the starting context's parts). */
    flowKey?: string;
    /** Bumped on every input in the message box. */
    typed?: number;
    /** Leave gaps in the wave for the quarter labels. */
    labelGaps?: boolean;
    /** The 5-hour window, for the slow hand; null draws none. */
    plan?: { used: number | null; resetsAt: string | null } | null;
    /**
     * Item 585: the right column's dial — every layer at 60 % and no glow,
     * so it never pulls his eye from the chat. Off on the new-chat page.
     */
    quiet?: boolean;
    /** Item 585: a turn is streaming — the wave holds a gentle surge while it runs. */
    streaming?: boolean;
    /** Item 585: draw only these layers (null: all). The column's dial leaves out the gear behind its figure. */
    layers?: string[] | null;
    /** Item 587: the right column's form (gears and the wave, legible at ~104 px). */
    column?: boolean;
  }

  let { size, pad, lit = null, spinKey = null, flowKey = "", typed = 0, labelGaps = false, plan = null, quiet = false, streaming = false, layers = null, column = false }: Props = $props();

  /** Room past the dial's box for the wave's tallest spokes. */
  const compact = $derived(size < 150 && !column);
  const margin = $derived(compact || column ? 12 : 8);
  const box = $derived(size + pad * 2);
  const css = $derived(box + margin * 2);

  type Hook = { at?: number | null; only?: string | null; energy?: number; spin?: number; stats?: boolean; pointer?: { x: number; y: number } | null };
  const hook: Hook | null =
    typeof window !== "undefined" ? ((window as unknown as { __dialMotion?: Hook }).__dialMotion ?? null) : null;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let probe = $state<HTMLSpanElement | null>(null);

  // ---- colours, read from the palette's tokens (re-read on a theme change)
  type Ink = { accent: string; accentInk: string; signal: string; signalInk: string; dim: string; line: string; glow: boolean; calm: boolean };
  let ink: Ink = { accent: "#ffb454", accentInk: "#ffd08a", signal: "#86d8f7", signalInk: "#b8e9fb", dim: "#7d8590", line: "#30363d", glow: true, calm: false };
  function readInk() {
    if (!probe) return;
    const get = (v: string) => {
      probe!.style.color = `var(${v})`;
      return getComputedStyle(probe!).color;
    };
    const root = document.documentElement;
    const glowVar = getComputedStyle(root).getPropertyValue("--glow-accent").trim();
    ink = {
      accent: get("--accent"),
      accentInk: get("--accent-ink"),
      signal: get("--signal"),
      signalInk: get("--signal-ink"),
      dim: get("--dim"),
      line: get("--line2"),
      glow: glowVar !== "" && glowVar !== "none",
      calm: root.dataset.light === "calm",
    };
  }

  // ---- the clock and the drives
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const clock = () => (hook?.at != null ? hook.at / 1000 : (performance.now() - t0) / 1000);
  const wall = () => (hook?.at != null ? new Date(2026, 10, 10, 17, 0, 0).getTime() + hook.at : Date.now());
  /** The wave's surge: τ 0.7 s. */
  const energy = drive(0.7);
  /** The gears' extra turn, deg/s: τ 0.45 s. */
  const spin = drive(0.45);
  /** Item 586: a moving pointer's surge on the spokes facing it: τ 0.9 s (a key's is 0.7). */
  const stir = drive(0.9);
  /** Item 586: where the pointer is (page px) and whether it is on the page; written by the events, read by the loop. */
  let pointer: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false };
  let presence = 0;
  let seen: { x: number; y: number } | null = null;
  let lastFrame = -1;
  /** Swells: an expanding ring per layer switch, 0.8 s each. */
  let swells: number[] = [];
  kick(energy, 0, 0.9);

  // Reactions: a key in the box, a layer switch, a project switch.
  let lastTyped: number | undefined;
  $effect(() => {
    const n = typed;
    if (lastTyped !== undefined && n !== lastTyped) {
      const t = clock();
      if (level(energy, t) < 1.5) kick(energy, t, 0.3);
      kick(spin, t, 25);
      untrack(paint);
    }
    lastTyped = n;
  });
  let lastFlow: string | undefined;
  $effect(() => {
    const k = flowKey;
    if (lastFlow !== undefined && lastFlow !== "" && k !== "" && k !== lastFlow) {
      const t = clock();
      kick(energy, t, 1.1);
      swells = [...swells.filter((s) => t - s < 0.8), t];
      untrack(paint);
    }
    if (k !== "") lastFlow = k;
  });
  let lastSpin: string | null | undefined;
  $effect(() => {
    const k = spinKey;
    if (lastSpin !== undefined && k !== lastSpin) {
      const t = clock();
      kick(spin, t, 340);
      kick(energy, t, 0.8);
      untrack(paint);
    }
    lastSpin = k;
  });
  /** Item 585: the held surge while a turn streams (a key's kick is 0.3, the opening sweep's 0.9). */
  const STREAM_SURGE = 0.45;
  // A hover redraws at once (the still form has no loop to pick it up).
  $effect(() => {
    void lit;
    void plan;
    void streaming;
    void size;
    untrack(paint);
  });

  // ---- the 5-hour hand: where it points, and its hover target
  let minute = $state(Date.now());
  const slow = $derived.by(() => {
    if (compact || !plan?.resetsAt) return null;
    const share = windowElapsed(plan.resetsAt, hook?.at != null ? wall() : minute);
    if (share == null) return null;
    const R = size / 2;
    const k = size / 330;
    const a = share * 2 * Math.PI;
    const r = column ? R - 21 : R - 48 * k;
    return {
      share,
      x: margin + box / 2 + r * Math.sin(a),
      y: margin + box / 2 - r * Math.cos(a),
      tip: windowTip(plan.used, plan.resetsAt, minute, shortClock(plan.resetsAt)),
    };
  });

  // ---- drawing
  const TAU = Math.PI * 2;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const shows = (layer: string) => (!layers || layers.includes(layer)) && (!hook?.only || hook.only.split(",").includes(layer));

  /** Item 586: the pointer relative to the dial's centre, and how much it counts (0 = none). */
  function aim(): { dx: number; dy: number; weight: number } | null {
    const p = hook?.pointer ?? (presence > 0.002 ? pointer : null);
    if (!p || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    const weight = hook?.pointer ? 1 : presence;
    return { dx: p.x - (r.left + r.width / 2), dy: p.y - (r.top + r.height / 2), weight };
  }

  function draw(ctx: CanvasRenderingContext2D, t: number, ms: number, still = false) {
    const R = size / 2;
    const k = compact ? size / 84 : column ? 1 : size / 330;
    const c = margin + box / 2;
    const dim = (ink.calm ? 0.7 : 1) * (quiet ? 0.6 : 1);
    ctx.clearRect(0, 0, css, css);
    ctx.save();
    ctx.translate(c, c);
    ctx.lineCap = "butt";
    // The still form is the idle shape: no surge.
    const surge = still ? 0 : level(energy, t) + (hook?.energy ?? 0) + (streaming ? STREAM_SURGE : 0);
    // The gears' turn: 6°/s, plus the spin-up and a nudge per key.
    const turnA = 6 * t + integral(spin, t) + (hook?.spin ?? 0);
    const radial = (th: number, r1: number, r2: number) => {
      const s = Math.sin(th);
      const co = -Math.cos(th);
      ctx.moveTo(r1 * s, r1 * co);
      ctx.lineTo(r2 * s, r2 * co);
    };
    // World angles: 0 at 12 o'clock, clockwise; canvas arcs start at 3 o'clock.
    const arc = (r: number, a0: number, a1: number) => {
      ctx.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
    };
    const isLit = (th: number) => !!lit && lit.share > 0 && inSpan(th, lit.from, lit.share);

    // radar: a wedge sweeping the band behind the gears, every 5 s.
    if (!compact && shows("radar") && typeof ctx.createConicGradient === "function") {
      const head = rad(72 * t);
      const wedge = rad(70);
      // Item 587: the column's band runs from the figure's corners to the inner ring.
      const ro = column ? R - 9 : R - 31 * k;
      const ri = column ? R - 24 : R - 64 * k;
      const g = ctx.createConicGradient(head - wedge - Math.PI / 2, 0, 0);
      const span = wedge / TAU;
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(span * 0.999, ink.signal);
      g.addColorStop(span, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.16 * dim;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, ro, 0, TAU);
      ctx.arc(0, 0, ri, 0, TAU, true);
      ctx.fill();
      ctx.globalAlpha = 0.5 * dim;
      ctx.strokeStyle = ink.signal;
      ctx.lineWidth = 1;
      ctx.beginPath();
      radial(head, ri, ro);
      ctx.stroke();
    }

    // gearC: three long segments, clockwise, slower.
    if (!compact && shows("gearC")) {
      const a = rad(10 * t + 0.6 * integral(spin, t) + (hook?.spin ?? 0) * 0.6);
      // Item 587: the column's form — just outside the figure's corners, thinner.
      const r = column ? R - 21 : R - 54 * k;
      const cap = column ? 1.6 : 4 * k;
      ctx.strokeStyle = ink.signal;
      ctx.lineWidth = column ? 1.3 : 2 * k;
      ctx.globalAlpha = (column ? 0.5 : 0.6) * dim;
      ctx.beginPath();
      for (const [from, len] of [
        [0, 64],
        [140, 38],
        [250, 18],
      ]) {
        const s = a + rad(from);
        ctx.moveTo(r * Math.sin(s), -r * Math.cos(s));
        arc(r, s, s + rad(len));
      }
      ctx.stroke();
      ctx.lineWidth = column ? 1 : 1.2 * k;
      ctx.beginPath();
      for (const [from, len] of [
        [0, 64],
        [140, 38],
        [250, 18],
      ]) {
        radial(a + rad(from), r - cap, r + cap);
        radial(a + rad(from + len), r - cap, r + cap);
      }
      ctx.stroke();
    }

    // gearB: 40 blocks, counter-clockwise, one step per gearA tooth.
    if (!compact && shows("gearB")) {
      // Item 587: the column's form — 16 blocks between gear C and gear A, stepping per gear-A tooth (15°).
      const nB = column ? 16 : 40;
      const pitch = 360 / nB;
      const a = -rad(escapement(column ? turnA * 2.5 : turnA, column ? 15 : 6, pitch));
      const r = column ? R - 17.5 : R - 40 * k;
      const w = column ? 2 : 5 * k;
      ctx.lineWidth = w;
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? ink.accent : ink.dim;
        ctx.globalAlpha = (pass ? 0.95 : column ? 0.5 : 0.42) * dim;
        ctx.beginPath();
        for (let i = 0; i < nB; i++) {
          const s = a + rad(i * pitch);
          const hot = i % (nB / 4) === 0 || isLit(s + rad(pitch / 4));
          if (hot !== !!pass) continue;
          ctx.moveTo(r * Math.sin(s), -r * Math.cos(s));
          arc(r, s, s + rad(pitch / 2));
        }
        ctx.stroke();
      }
    }

    // gearA: 60 teeth, clockwise, one tooth a second; index teeth at thirds.
    if (shows("gearA")) {
      // Item 587: the column's form — 24 thicker teeth just inside the inner ring, a turn every 24 s (15°/s · 1/2.5).
      const a = rad(column ? turnA * 2.5 : turnA);
      const n = column ? 24 : compact ? 36 : 60;
      const r1 = column ? R - 13.5 : compact ? R - 22 * k : R - 30 * k;
      const r2 = column ? R - 10 : compact ? R - 17 * k : R - 23 * k;
      ctx.lineWidth = column ? 1.8 : (compact ? 1.4 : 1.6) * k;
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? ink.accent : ink.dim;
        ctx.globalAlpha = (pass ? 1 : 0.62) * dim;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const th = a + (i * TAU) / n;
          const index = i % (n / 3) === 0;
          const hot = index || isLit(th);
          if (hot !== !!pass) continue;
          const long = index || i % (column ? 4 : 5) === 0;
          radial(th, long ? r1 - (column ? 2 : 3 * k) : r1, hot && !index ? r2 + 2 * k : r2);
        }
        ctx.stroke();
      }
    }

    // slow: the 5-hour window's hand.
    if (slow && shows("slow")) {
      const a = slow.share * TAU;
      // Item 587: the column's form rides gear C's radius, brighter than it.
      const r = column ? R - 21 : R - 48 * k;
      ctx.globalAlpha = 0.22 * dim;
      ctx.strokeStyle = ink.signal;
      ctx.lineWidth = column ? 1.5 : 2 * k;
      ctx.beginPath();
      arc(r, 0, a);
      ctx.stroke();
      ctx.globalAlpha = 0.95 * dim;
      ctx.strokeStyle = ink.signalInk;
      ctx.lineWidth = column ? 1.5 : 2 * k;
      ctx.beginPath();
      radial(a, r + (column ? 2 : 4 * k), column ? R - 10 : R - 26 * k);
      ctx.stroke();
      ctx.fillStyle = ink.signalInk;
      ctx.beginPath();
      const x = r * Math.sin(a);
      const y = -r * Math.cos(a);
      const d = column ? 2.6 : 3.4 * k;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
      ctx.fill();
    }

    // wave: the audio ring, a spoke every 2° (5° compact).
    if (shows("wave")) {
      // Item 587: the column's form — 48 spokes, thicker, from just past the ticks.
      const n = column ? 48 : compact ? 72 : 180;
      const r0 = column ? R + 5 : compact ? R + 4 * k : R + 11 * k;
      const base = column ? 1.5 : compact ? 1.2 * k : 2.5 * k;
      const reach = column ? 8 : compact ? 7 * k : 14 * k;
      // Item 586: the pointer's pull — a rest hover plus a moving pointer's surge, on the spokes facing it.
      const p = still ? null : aim();
      const push = p ? p.weight * (POINTER_HOVER + level(stir, t)) : 0;
      ctx.strokeStyle = ink.signal;
      ctx.lineWidth = column ? 2 : compact ? 1.1 : 1.5 * k;
      ctx.globalAlpha = Math.min(1, 0.5 + 0.35 * Math.min(1, surge)) * dim;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const th = (i * TAU) / n;
        if (labelGaps) {
          const q = (((th / (Math.PI / 2)) % 1) + 1) % 1;
          if (q < 0.045 || q > 0.955) continue;
        }
        const local = push > 0 && p ? push * pointerPull(th, p.dx, p.dy, R) : 0;
        radial(th, r0, r0 + base + reach * pointerSpoke(th, t, surge, local));
      }
      ctx.stroke();
      // A layer switch: a ring swells out from the track and fades.
      for (const s of swells) {
        const u = (t - s) / 0.8;
        if (u < 0 || u > 1) continue;
        ctx.globalAlpha = 0.6 * (1 - u) * dim;
        ctx.strokeStyle = ink.accent;
        ctx.lineWidth = 2 * k * (1 - u) + 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, R + (6 + 24 * (1 - (1 - u) ** 3)) * k, 0, TAU);
        ctx.stroke();
      }
    }

    // hand: the seconds tick, stepping with an overshoot, and its lap trail.
    if (shows("hand") && Number.isFinite(ms)) {
      // Item 587: the column's form ticks like the compact one.
      const small = compact || column;
      const a = rad(secondsAngle(ms));
      const rt = small ? R + 2.5 * k : R + 8.5 * k;
      ctx.globalAlpha = 0.2 * dim;
      ctx.strokeStyle = ink.accent;
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      arc(rt, 0, Math.max(0, a));
      ctx.stroke();
      ctx.globalAlpha = dim;
      ctx.strokeStyle = ink.accentInk;
      ctx.lineWidth = (small ? 1.6 : 2.4) * k;
      ctx.lineCap = "round";
      if (ink.glow && !ink.calm && !quiet) {
        ctx.shadowColor = ink.accent;
        ctx.shadowBlur = 8;
      }
      ctx.beginPath();
      radial(a, small ? R - 3 * k : R - 3 * k, small ? R + 7 * k : R + 16 * k);
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (!small) {
        ctx.fillStyle = ink.accentInk;
        const tipR = R + 18 * k;
        const s = Math.sin(a);
        const co = -Math.cos(a);
        const px = -co;
        const py = s;
        const w = 3.2 * k;
        ctx.beginPath();
        ctx.moveTo(tipR * s, tipR * co);
        ctx.lineTo((tipR + 6 * k) * s + w * px, (tipR + 6 * k) * co + w * py);
        ctx.lineTo((tipR + 6 * k) * s - w * px, (tipR + 6 * k) * co - w * py);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineCap = "butt";
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- the loop
  const reduce =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let raf = 0;
  let running = false;
  const times: number[] = [];
  let frames = 0;
  function paint() {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(css * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const still = !!reduce?.matches;
    const a = hook?.stats ? performance.now() : 0;
    // The still form: the gears at rest, the wave a gentle shape, no tick.
    draw(ctx, still ? 0 : clock(), still ? NaN : wall(), still);
    if (hook?.stats) {
      times.push(performance.now() - a);
      if (times.length > 900) times.shift();
      frames++;
    }
  }
  function frame() {
    raf = 0;
    if (!running) return;
    // Item 586: the pointer, read once a frame — presence eases, travel stirs.
    const t0f = clock();
    const dt = lastFrame < 0 ? 0 : t0f - lastFrame;
    lastFrame = t0f;
    presence = easePresence(presence, pointer.on ? 1 : 0, dt);
    if (pointer.on) {
      if (seen) {
        const moved = Math.hypot(pointer.x - seen.x, pointer.y - seen.y);
        if (moved > 0.5 && level(stir, t0f) < 1.2) kick(stir, t0f, stirKick(moved));
      }
      seen = { x: pointer.x, y: pointer.y };
    } else seen = null;
    paint();
    const t = clock();
    prune(energy, t);
    prune(spin, t);
    prune(stir, t);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running || reduce?.matches || document.visibilityState === "hidden") return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function sync() {
    if (reduce?.matches || document.visibilityState === "hidden") stop();
    else start();
    paint();
  }

  onMount(() => {
    readInk();
    const mo = new MutationObserver(() => {
      readInk();
      paint();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette", "data-light", "data-theme", "data-layout", "class", "style"] });
    document.addEventListener("visibilitychange", sync);
    reduce?.addEventListener?.("change", sync);
    // Item 586: the events only record; the loop draws.
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY, on: true };
    };
    const onLeave = (e: PointerEvent) => {
      if (!e.relatedTarget) pointer = { ...pointer, on: false };
    };
    const onBlur = () => (pointer = { ...pointer, on: false });
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onLeave, { passive: true });
    window.addEventListener("blur", onBlur);
    const tick = setInterval(() => (minute = Date.now()), 60_000);
    if (hook?.stats) {
      // The harness's bench: n paints back to back, ms per paint (offscreen WebKit throttles the loop itself).
      (window as unknown as { __dialMotionBench: (n: number) => number }).__dialMotionBench = (n) => {
        const a = performance.now();
        for (let i = 0; i < n; i++) paint();
        return (performance.now() - a) / n;
      };
      (window as unknown as { __dialMotionStats: () => unknown }).__dialMotionStats = () => {
        const s = [...times].sort((x, y) => x - y);
        const avg = s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
        return { frames, drawAvgMs: +avg.toFixed(3), drawP95Ms: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(3), drawMaxMs: +(s[s.length - 1] ?? 0).toFixed(3), seconds: +clock().toFixed(2), running };
      };
    }
    sync();
    return () => {
      stop();
      mo.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduce?.removeEventListener?.("change", sync);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onLeave);
      window.removeEventListener("blur", onBlur);
      clearInterval(tick);
    };
  });
  // The still form redraws when the 5-hour hand moves.
  $effect(() => {
    void slow;
    untrack(paint);
  });
</script>

<div class="dm" style:left="{-margin}px" style:top="{-margin}px" style:width="{css}px" style:height="{css}px" aria-hidden="true">
  <canvas bind:this={canvas} style:width="{css}px" style:height="{css}px"></canvas>
  <span class="probe" bind:this={probe}></span>
</div>
{#if slow}
  <span class="slow-hit" style:left="{slow.x - margin - 8}px" style:top="{slow.y - margin - 8}px" use:tipAction={slow.tip}></span>
{/if}

<style>
  .dm {
    position: absolute;
    pointer-events: none;
  }
  canvas {
    display: block;
  }
  .probe {
    display: none;
  }
  /* The 5-hour hand's hover target: a 16 px spot on its diamond. */
  .slow-hit {
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    pointer-events: auto;
    cursor: default;
  }
</style>
