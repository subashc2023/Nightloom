// Item 640 (his pick, 2026-11-11: "horizon blows everything out of the water
// … traeting the whele as a sun with the rays … could maybe even be done lil
// further w a tint on the sunrays"; "radar is pretty sick"): the two shader
// backgrounds of the new-chat page, ported from round 4's design page
// (nightshift notes/runner-design/640-designs/index.html, its shared prelude,
// `horizon` and `radar`).
//
// One WebGL canvas over the CSS dot tile (the dots stay; the light is
// premultiplied with alpha = its brightest channel, so it covers the dots only
// as much as it is lit). Each frame is one full-window triangle.
//
// Cheap by construction: the canvas is drawn at 1 device pixel per CSS pixel
// (a quarter of the pixels on a 2× screen; the compositor scales it up —
// everything in these looks is soft or thin enough to survive that). The
// loop stops while the window is hidden or the page is off screen; Reduce
// motion draws one still pose; Calm (and anywhere `--ground-dots` is `none`)
// keeps today's page. Classic's page is WelcomeClassic and never mounts this.
//
// The scene is written in the design page's coordinates (its dial centre at
// 590, 200 with a 330 px dial); each pixel is mapped there from the live
// dial's centre and radius, so it follows the real layout and any resize.
import { reducedMotion } from "./sendMotion";
import type { Rgb } from "./newChatGround";

export type ShaderLook = "horizon" | "radar";
export function isShaderLook(s: string): s is ShaderLook {
  return s === "horizon" || s === "radar";
}

/** The pose drawn under Reduce motion (seconds), as round 4's page did. */
export const STILL_T = 7.3;
/** The design page's dial radius (330 px dial). */
export const MOCK_R = 165;
/** How many text boxes the veil dims the light under. */
export const MAX_RECTS = 12;
/** Device pixels per CSS pixel the canvas is drawn at (the compositor scales it). */
export const DRAW_SCALE = 1;
/** What carries text on the new-chat page; the light is dimmed under it. */
export const VEIL_SELECTOR = ".ro, .tq, .ready, .composer-slot, .kinds, .thr, .keys, .unfiled, .flatrow, .colw > .warn, .colw > .lede";

const TAU = Math.PI * 2;

export interface ShaderColours {
  sig: [number, number, number];
  amb: [number, number, number];
  cyan: [number, number, number];
  deep: [number, number, number];
  lil: [number, number, number];
  /** The sun-ray tint: the accent, softened toward a warm white. */
  dawn: [number, number, number];
}

/** Jarvis's signal (`--signal`, #86d8f7): the design page's colours are exact for it. */
const JARVIS_SIG: Rgb = [134, 216, 247];
const CYAN0 = [0.31, 0.88, 0.9];
const DEEP0 = [0.16, 0.34, 1.0];
const LIL0 = [0.725, 0.639, 1.0];

/**
 * The scene's colours from the theme's signal and accent. Under Jarvis they
 * are the design page's exactly; another palette's signal shifts the cyan,
 * blue and lilac by the same per-channel ratio, so the look keeps its shape
 * in the palette's own hue (as Weft draws in the theme's colours).
 */
export function shaderColours(signal: Rgb, accent: Rgb): ShaderColours {
  const ratio = [0, 1, 2].map((i) => signal[i] / JARVIS_SIG[i]);
  const shift = (c: number[]) => c.map((v, i) => Math.min(1, v * ratio[i])) as [number, number, number];
  const amb = accent.map((v) => v / 255) as [number, number, number];
  const warmWhite = [1.0, 0.9, 0.74];
  return {
    sig: signal.map((v) => v / 255) as [number, number, number],
    amb,
    cyan: shift(CYAN0),
    deep: shift(DEEP0),
    lil: shift(LIL0),
    dawn: amb.map((v, i) => v * 0.7 + warmWhite[i] * 0.3) as [number, number, number],
  };
}

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** Radar's divisions of a turn: whole numbers, so nothing is cut where the angle wraps at ±π. */
export const RADAR_SPOKES = 24;
export const RADAR_TICKS = 144;
export const RADAR_BLIP_CELLS = 35;

const PRELUDE = `
precision highp float;
uniform float t; uniform vec2 res; uniform float px; uniform float gain; uniform vec2 CL; uniform float K; uniform float tint;
uniform vec3 SIG; uniform vec3 AMB; uniform vec3 CYAN; uniform vec3 DEEP; uniform vec3 LIL; uniform vec3 DAWN;
uniform vec4 RC[${MAX_RECTS}]; uniform float nR;
const vec2 C = vec2(590.0, 200.0);
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float h2(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
/* a soft fall-off, so no dark boxes show */
float cov(vec2 p, vec2 lo, vec2 hi) { vec2 q = max(lo - p, p - hi); return mix(0.5, 1.0, smoothstep(-14.0, 46.0, max(q.x, q.y))); }
/* p: the page (CSS px); q: the same point in the design page's frame */
float veil(vec2 p, vec2 q) {
  float v = mix(0.45, 1.0, smoothstep(138.0, 170.0, length(q - C)));
  for (int i = 0; i < ${MAX_RECTS}; i++) {
    if (float(i) >= nR) break;
    v = min(v, cov(p, RC[i].xy, RC[i].zw));
  }
  return v;
}
/* Specks rising slowly in columns, three depths (near = bigger, brighter, faster). */
float specks(vec2 p, float dens) {
  float s = 0.0;
  for (int L = 0; L < 3; L++) {
    float fl = float(L), sz = 34.0 - fl * 9.0, sp = 16.0 - fl * 5.0;
    vec2 q = vec2(p.x + fl * 13.0, p.y + t * sp * (0.6 + 0.4 * h1(floor((p.x + fl * 13.0) / sz) + fl * 7.0)));
    vec2 id = floor(q / sz), f = q - id * sz;
    float on = step(1.0 - dens, h2(id + fl * 31.0));
    vec2 o = vec2(h2(id + 3.1), h2(id + 7.7)) * (sz - 6.0) + 3.0;
    float d = length(f - o);
    s += on * exp(-d * d / (1.4 - fl * 0.35)) * (1.0 - fl * 0.3) * (0.6 + 0.4 * sin(t * (1.0 + h2(id)) + h2(id) * 6.28));
  }
  return s;
}
/* premultiplied: alpha = the brightest channel */
vec4 outc(vec3 c) { c = min(c, 1.0); return vec4(c, max(c.r, max(c.g, c.b))); }
vec2 P() { return vec2(gl_FragCoord.x / px, res.y - gl_FragCoord.y / px); }
vec2 M(vec2 p) { return (p - CL) / K + C; }
`;

/* Horizon: a wireframe sea whose horizon runs straight through the dial's centre; a dawn glow and light-rays rise behind the wheel,
   specks above. Item 640's tint: the rays and the glow at the wheel's foot warm toward the accent (softened), fading back to the
   cyan at the edges and upward. tint = 0 is round 4's page exactly. */
// ---- Item 662 (his pick B1 Roll, round 4, 2026-11-12; he said "B is good but not niticeable enough still. maybe needs
// more brightness. also takes too long to fade back"): while he types in the composer, the sea's grid eases from 40 to
// about 92 px/s toward him, its lines grow about 3.6× as bright and a soft cyan glow gathers on the wave crests; it all
// settles back about 1.3 s after his last key. Only the sea (below the horizon) responds; the sky is untouched.
// Design and measurements: nightshift notes/runner-design/662-r4-designs/index.html and 662-r4-report-2026-11-12.md.

/** At full response: the grid rolls 40 × (1 + this) px/s. */
export const SEA_TYPING_ROLL = 1.3;
/** At full response: every sea line is (1 + this) times as bright. */
export const SEA_TYPING_LIT = 2.6;
/** At full response: the crest glow's strength. */
export const SEA_TYPING_GLOW = 1.2;
/** The sea grid's period (px); the extra roll is kept modulo it, so the float stays small. */
export const SEA_GRID = 64;

/**
 * The typing response (0..1), round 4's curve. No key reaches the sea directly: each key adds 0.35 to a reservoir (cap
 * 1.3). While keys keep coming (the last under 0.4 s ago) it drains slowly (τ 2 s), so typing at 3 keys/s or faster holds
 * it full; after that it drains fast (τ 0.15 s). The response eases toward min(1, reservoir): τ 0.5 s rising, 0.22 s
 * falling, then a second 0.15 s ease so its slope stays continuous. From rest at 5 keys/s: 0.68 after 1 s, 0.96 after 2 s;
 * under 0.10 1.33 s after the last key. `roll` is the extra distance the grid has rolled (px, modulo SEA_GRID).
 */
export interface SeaTyping {
  e: number;
  roll: number;
  key(): void;
  tick(dt: number): number;
  reset(): void;
}
export function seaTyping(): SeaTyping {
  let s1 = 0;
  let s2 = 0;
  let since = 99;
  return {
    e: 0,
    roll: 0,
    key() {
      s1 = Math.min(1.3, s1 + 0.35);
      since = 0;
    },
    tick(dt: number) {
      if (!(dt > 0)) return this.e;
      since += dt;
      s1 *= Math.exp(-dt / (since < 0.4 ? 2.0 : 0.15));
      const g = Math.min(1, s1);
      s2 += (g - s2) * (1 - Math.exp(-dt / (g > s2 ? 0.5 : 0.22)));
      this.e += (s2 - this.e) * (1 - Math.exp(-dt / 0.15));
      if (this.e < 1e-4 && s1 < 1e-4) this.e = 0;
      this.roll = (this.roll + 40 * SEA_TYPING_ROLL * this.e * dt) % SEA_GRID;
      return this.e;
    },
    reset() {
      s1 = 0;
      s2 = 0;
      since = 99;
      this.e = 0;
    },
  };
}

// ---- Item 671 (his asks, 2026-11-12: the sky "slightly more aurora borealis or like interesting"; "could u make it time
// based? … aurora borealis during day … by evening it's like the bright red … at night … constellation shit … space dust";
// round 2: "I like N2 stars more. but … can be more vibrant. the aurora shit can be brighter and clearer and more
// interesting"; round 3: "comets shooting stars distant waves and crashes on the horizon side of the water waves"). Horizon's
// sky follows his local clock: a soft dawn (7–9 AM), the aurora by day (11:30 AM–2:30 PM), the red sun at evening
// (5:30–7:30 PM), stars and space dust at night (10 PM–4:30 AM), each handover a 2.5–3 h smoothstep. On top: a slow comet at
// night, rare shooting stars (~2 a minute), distant waves breaking on the far sea, a crescent moon, the sky reflected in the
// sea. Built set (the orchestrator's pick from round 3): stars Vivid, aurora Vivid+, every event Soft, no satellite.
// Reduce motion: one still pose at the current hour (redrawn once a minute), no events. Radar is untouched.
// Design and measurements: nightshift notes/runner-design/671-r3-designs/index.html and 671-r3-report-2026-11-12.md.

/** The four phase handovers (local hours, start and end of each smoothstep): night→morning, morning→day, day→evening, evening→night. */
export const SKY_HANDOVERS: readonly [number, number][] = [
  [4.5, 7.0],
  [9.0, 11.5],
  [14.5, 17.5],
  [19.5, 22.0],
];
const H = SKY_HANDOVERS;
/** The built levels (1 = round 3's Soft/Vivid, 2 = Strong/Vivid+). */
export const SKY_LEVELS = { stars: 1, aurora: 2, events: 1 } as const;
/** Shooting stars: one slot of this many seconds holds at most one, with probability METEOR_P. */
export const METEOR_SLOT = 10;
export const METEOR_P = 0.35;
/** The comet: one pass per this many seconds, visible from 0 to 0.88 of it. */
export const COMET_PERIOD = 300;
/** Distant breakers: lanes, and one wave's life (s); each lane's period is 8–14 s, longer than a life. */
export const BREAKER_LANES = 3;
export const BREAKER_LIFE = 5.5;

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Each phase's weight at a local hour (0–24); they sum to 1. The shader's phaseW() is the same curve. */
export function skyPhases(hr: number): { night: number; morning: number; day: number; evening: number } {
  const [pa, pb, pc, pd] = H.map(([a, b]) => smooth(a, b, hr));
  return { night: 1 - pa + pd, morning: pa - pb, day: pb - pc, evening: pc - pd };
}
/** The local hour, 0–24 (his clock, daylight saving included). */
export function localHour(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
/** Ease the drawn hour toward the clock (τ 2 s), the short way round midnight, so waking from sleep never snaps the sky. */
export function easeHour(cur: number, target: number, dt: number): number {
  let d = target - cur;
  if (d > 12) d -= 24;
  if (d < -12) d += 24;
  const k = 1 - Math.exp(-Math.max(0, dt) / 2);
  return (((cur + d * k) % 24) + 24) % 24;
}
/** The shader's hash, in JS (for the schedule tests; the GPU's float32 differs in detail, not in the bounds). */
export function skyHash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
/** Shooting star slot `id` (as meteors() draws it): whether it holds one, its start and duration (s) within the slot. */
export function meteorSlot(id: number): { on: boolean; start: number; dur: number } {
  const dur = 0.65 + 0.4 * skyHash(id * 2.1 + 0.3);
  const start = skyHash(id * 3.3 + 0.1) * Math.max(METEOR_SLOT - dur - 0.1, 0);
  return { on: skyHash(id * 1.37 + 0.5) <= METEOR_P, start, dur };
}
/** The comet's fade at event time `te` (s): 0 outside its pass. */
export function cometVisibility(te: number): number {
  const f = (te - Math.floor(te / COMET_PERIOD) * COMET_PERIOD) / COMET_PERIOD;
  return smooth(0, 0.08, f) * (1 - smooth(0.78, 0.88, f));
}
/** Breaker lane `i`'s period (s), as breakers() computes it. */
export function breakerPeriod(i: number): number {
  return 8 + 6 * skyHash(i * 3.1 + 0.7);
}

/* The sky's functions (round 2's dawn, dusk and sun; round 3's stars, aurora, comet, shooting stars, moon, breakers and
   reflection), from the design page's generator (671-r3-designs/harness/make_page.py) with the built levels fixed.
   hr = his local hour (0–24); te = the event clock (s); ev = 0 under Reduce motion (no events). */
const SKY = `
uniform float hr; uniform float te; uniform float ev;
/* Morning: a soft dawn, pale gold low, rose above it, cool (cyan-lilac) higher up. */
vec3 dawnSky(float u, float lat) {
  vec3 low = mix(vec3(1.0, 0.80, 0.56), vec3(1.0, 0.62, 0.72), smoothstep(0.0, 50.0, u));
  vec3 c = mix(low, mix(CYAN, LIL, 0.5), smoothstep(40.0, 150.0, u));
  return c * (0.36 * exp(-u / 70.0) + 0.10 * exp(-u / 200.0)) * lat;
}

/* Evening: round 1's R1 dusk band. */
vec3 duskSky(float u, float lat) {
  vec3 c = mix(vec3(1.0, 0.58, 0.24), vec3(0.80, 0.17, 0.12), smoothstep(0.0, 55.0, u));
  c = mix(c, LIL * vec3(0.75, 0.5, 0.85), smoothstep(45.0, 140.0, u));
  return c * (0.28 * exp(-u / 60.0) + 0.07 * exp(-u / 170.0)) * lat;
}

/* Evening: round 1's R2 sun behind the wheel, sinking 120 px from 4:30 PM to 9:30 PM (about 0.4 px a minute). */
vec3 sunSky(vec2 q) {
  vec2 sc = vec2(C.x, C.y + mix(-30.0, 90.0, smoothstep(16.5, 21.5, hr)));
  float rr = length(q - sc), disk = smoothstep(240.0, 232.0, rr);
  return mix(vec3(1.0, 0.50, 0.20), vec3(0.82, 0.18, 0.12), smoothstep(185.0, 238.0, rr)) * disk * 0.22
       + vec3(0.95, 0.30, 0.15) * exp(-max(rr - 236.0, 0.0) / 60.0) * (1.0 - disk) * 0.10;
}

float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }

/* Two small constellations, one each side of the dial, clear of the readouts. */
vec2 cst(int i) {
  if (i == 0) return vec2(38.0, 128.0); if (i == 1) return vec2(72.0, 74.0); if (i == 2) return vec2(112.0, 100.0);
  if (i == 3) return vec2(146.0, 46.0); if (i == 4) return vec2(176.0, 84.0); if (i == 5) return vec2(1012.0, 36.0);
  if (i == 6) return vec2(1050.0, 78.0); if (i == 7) return vec2(1094.0, 56.0); if (i == 8) return vec2(1128.0, 104.0);
  return vec2(1162.0, 82.0);
}

vec4 phaseW() { float pa = smoothstep(${f(H[0][0])}, ${f(H[0][1])}, hr), pb = smoothstep(${f(H[1][0])}, ${f(H[1][1])}, hr), pc = smoothstep(${f(H[2][0])}, ${f(H[2][1])}, hr), pd = smoothstep(${f(H[3][0])}, ${f(H[3][1])}, hr);
  return vec4(1.0 - pa + pd, pa - pb, pb - pc, pc - pd); } /* night, morning, day, evening */

/* night, morning, day, evening */
vec2 segh(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return vec2(length(pa - ba * h), h); }

/* N2, vivid: a deeper night tint; a Milky-Way-like dust band (two noise octaves, a dark lane down its middle, lilac/cyan with
   rose knots); two faint nebulae; three star depths (a dense faint dust layer added), coloured stars, the brightest with a soft
   glow and short spikes; constellations brighter, with a slow light pulse walking along their lines (one pass per 16 s). */
vec3 starSky2(vec2 q, float u, float V) {
  float k = V > 1.5 ? 1.5 : 1.0;
  vec2 s = q + vec2(6.0 * sin(t * 0.010), 3.0 * sin(t * 0.013));
  vec3 c = mix(DEEP * 0.10, LIL * 0.06, smoothstep(30.0, 180.0, u)) * (0.55 + 0.45 * exp(-u / 140.0));
  float v = (s.y - 92.0) + 0.16 * (s.x - C.x);
  float n1 = vn(s * 0.017), n2 = vn(s * 0.055 + 7.0), n = 0.6 * n1 + 0.4 * n2;
  float core = exp(-pow(v / 38.0, 2.0)), halo = exp(-pow(v / 100.0, 2.0));
  float lane = 1.0 - 0.7 * exp(-pow((v + 14.0 * (n1 - 0.5)) / 7.0, 2.0)) * smoothstep(0.3, 0.7, n2);
  vec3 bc = mix(LIL, CYAN, smoothstep(0.25, 0.75, n1));
  bc = mix(bc, vec3(1.0, 0.55, 0.78), 0.45 * smoothstep(0.55, 0.85, n2));
  float band = core * (0.3 + 0.7 * n);
  c += bc * (band * 0.26 + halo * 0.05 * (0.5 + n)) * lane * k;
  vec2 e1 = s - vec2(250.0, 150.0), e2 = s - vec2(930.0, 40.0);
  c += vec3(0.22, 0.85, 0.80) * exp(-dot(e1, e1) / 7000.0) * n2 * 0.09 * k;
  c += vec3(0.95, 0.45, 0.75) * exp(-dot(e2, e2) / 6000.0) * n1 * 0.09 * k;
  for (int L = 0; L < 3; L++) {
    float fl = float(L), sz = L == 0 ? 24.0 : (L == 1 ? 15.0 : 8.5);
    vec2 g = s / sz + fl * 17.0, id = floor(g), f = fract(g) - 0.5;
    float on = step(L == 0 ? 0.86 : (L == 1 ? 0.80 : 0.64), h2(id + 3.7));
    if (on < 0.5) continue;
    vec2 o = (vec2(h2(id + 1.1), h2(id + 2.3)) - 0.5) * 0.7;
    vec2 r = (f - o) * sz; float dd = length(r), hb = h2(id + 9.1);
    float b = (pow(hb, 3.0) * (L == 0 ? 1.5 : (L == 1 ? 0.7 : 0.22)) + (L == 2 ? 0.07 : 0.2)) * 1.5;
    float tw = 0.85 + 0.15 * sin(t * (0.25 + 0.2 * h2(id)) + h2(id + 4.0) * 6.28);
    float hc = h2(id + 6.0);
    vec3 sc = hc < 0.3 ? SIG : (hc < 0.55 ? LIL : (hc < 0.75 ? vec3(1.0, 0.80, 0.58) : vec3(0.85, 0.92, 1.0)));
    sc = mix(vec3(1.0), sc, 0.6);
    float pt = exp(-dd * dd / (L == 2 ? 0.45 : (L == 1 ? 0.6 : 0.9)));
    if (L == 0 && hb > 0.7) {
      pt += exp(-dd / 3.2) * 0.22;
      if (hb > 0.88) pt += (exp(-abs(r.x) * 0.9 - r.y * r.y * 3.0) + exp(-abs(r.y) * 0.9 - r.x * r.x * 3.0)) * 0.22 * (1.0 - smoothstep(4.0, 9.0, dd));
    }
    c += sc * b * tw * pt * (1.0 + 2.5 * band) * k;
  }
  if (s.y < 150.0 && (s.x < 200.0 || s.x > 990.0)) {
    float ln = 1e9, pts = 0.0, pl = 0.0;
    float ph0 = fract(t / 16.0) * 5.0, ph1 = fract(t / 16.0 + 0.5) * 5.0;
    for (int i = 0; i < 9; i++) {
      if (i == 4) continue;
      vec2 a = cst(i), bb = cst(i + 1), sh = segh(s, a, bb);
      ln = min(ln, sh.x);
      float j = i < 4 ? float(i) : float(i - 5), ph = i < 4 ? ph0 : ph1;
      pl += exp(-sh.x * sh.x / 1.4) * exp(-pow((sh.y - (ph - j)) * length(bb - a) / 7.0, 2.0));
    }
    for (int i = 0; i < 10; i++) { float dd = length(s - cst(i)); pts += exp(-dd * dd / 2.2) * 1.3 + exp(-dd / 4.0) * 0.18; }
    c += SIG * k * (0.16 * (1.0 - smoothstep(0.3, 1.4, ln)) + 0.035 * exp(-ln / 4.0) + 0.45 * pl) + vec3(1.0, 0.95, 0.85) * pts * k;
  }
  return c * smoothstep(2.0, 24.0, u);
}

/* Day aurora, vivid: two curtains (a front one low and green, a back one higher and violet-teal, slower), each with a sharp
   bright lower hem, vertical ray striations that drift with the folds, a rose under-fringe below the hem (real auroras show
   one), and a slow brightening that travels sideways along the curtain (~34 px/s). */
vec3 auroraSky2(float x, float u, float V) {
  float k = V > 1.5 ? 1.45 : 1.0;
  vec3 acc = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float fl = float(L), sp = mix(1.0, 0.7, fl);
    float fold = x + 40.0 * sin(x * 0.0040 + t * 0.06 * sp + fl * 2.0) + 18.0 * sin(x * 0.011 - t * 0.05 * sp + fl);
    float yc = mix(52.0, 100.0, fl) + 30.0 * sin(x * 0.0042 + t * 0.045 * sp + fl * 1.7) + 9.0 * sin(x * 0.012 - t * 0.06 * sp);
    float e = u - yc;
    float rays = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(fold * 0.085 + fl * 1.3), 3.0) * (0.5 + 0.5 * vn(vec2(fold * 0.03, t * 0.15 + fl * 5.0))) + 0.35 * pow(vn(vec2(fold * 0.05, fl * 9.0 + t * 0.05)), 4.0);
    float pulse = 0.65 + 0.35 * smoothstep(0.2, 0.9, 0.5 + 0.5 * sin(x * 0.0065 - t * 0.22 + fl * 2.5));
    float H = mix(70.0, 95.0, fl) * (0.5 + 1.1 * rays);
    float hem = smoothstep(-3.0, 3.0, e);
    float body = hem * exp(-max(e, 0.0) / H);
    float edge = exp(-pow(max(e, 0.0) / 7.0, 2.0)) * hem;
    float fringe = exp(-pow(min(e, 0.0) / 6.0, 2.0)) * (1.0 - hem);
    float span = 1.0 - smoothstep(480.0, 720.0, abs(x - C.x));
    vec3 cl = mix(vec3(0.20, 1.0, 0.55), vec3(0.25, 0.85, 0.95), smoothstep(10.0, 60.0, e));
    cl = mix(cl, vec3(0.70, 0.36, 1.0), smoothstep(40.0, 120.0, e));
    if (L == 1) cl = mix(cl, vec3(0.78, 0.36, 1.0), 0.6);
    acc += (cl * (body * rays * 0.55 + edge * 0.42 * (0.6 + 0.4 * rays)) + vec3(1.0, 0.36, 0.62) * fringe * 0.26) * pulse * span * mix(1.0, 0.8, fl);
  }
  return acc * k * smoothstep(0.0, 10.0, u);
}

/* Comet: right of the dial, above the MODEL readout. One pass per 5 min of event clock: fades in over ~25 s, drifts 115 px
   (~0.45 px/s) toward the dial while slowly setting, fades out. A nucleus and coma, a straight narrow cyan ion tail with faint
   slow streaks, and a broader warm dust tail that curves away. */
vec3 cometSky(vec2 q, float V) {
  float P = ${f(COMET_PERIOD)}, id = floor(te / P), f = (te - id * P) / P;
  float vis = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.78, 0.88, f));
  if (vis <= 0.0) return vec3(0.0);
  vec2 head = vec2(mix(905.0, 790.0, f), mix(62.0, 36.0, f)), td = normalize(vec2(0.93, -0.37));
  float L = V > 1.5 ? 230.0 : 160.0;
  vec2 rel = q - head;
  if (rel.x < -30.0 || rel.x > L + 30.0 || abs(rel.y) > L * 0.55 + 30.0) return vec3(0.0);
  float a = dot(rel, td), b = dot(rel, vec2(-td.y, td.x)), r2 = dot(rel, rel), r = sqrt(r2);
  vec3 c = vec3(1.0, 0.97, 0.9) * (exp(-r2 / 3.0) * 1.3 + exp(-r / 5.5) * 0.45) + mix(CYAN, vec3(0.75, 0.95, 1.0), 0.4) * exp(-r / 14.0) * 0.15;
  if (a > 0.0) {
    float ion = exp(-b * b / pow(1.0 + a * 0.03, 2.0)) * exp(-a / (L * 0.75));
    float streak = 0.75 + 0.25 * sin(b * 1.3 + a * 0.05 - t * 0.8);
    float bd = b + a * a * 0.0022, wd = 2.5 + a * 0.14;
    float dust = exp(-bd * bd / (wd * wd)) * exp(-a / (L * 0.55));
    c += mix(CYAN, DEEP, 0.3) * ion * streak * 0.55 + vec3(1.0, 0.88, 0.70) * dust * 0.55;
  }
  return c * vis * (V > 1.5 ? 1.25 : 1.0);
}

/* Shooting stars: one 10 s slot of event clock at a time; a slot holds a meteor with probability 0.35 (soft, ~2 a minute) or 0.55
   (strong, ~3 a minute). A meteor lasts 0.65-1.05 s, eases in over 0.18 s and out over 0.3 s (no flash), runs 380-560 px/s at
   18-38 degrees downward, with a 70-140 px tail (x1.3 strong) going from white at the head to lilac-cyan. */
vec3 meteors(vec2 q, float V) {
  float S = ${f(METEOR_SLOT)}, id = floor(te / S), tau = te - id * S;
  float dur = 0.65 + 0.4 * h1(id * 2.1 + 0.3);
  float st = h1(id * 3.3 + 0.1) * max(S - dur - 0.1, 0.0), tt = tau - st;
  if (h1(id * 1.37 + 0.5) > (V > 1.5 ? 0.55 : ${f(METEOR_P)})) return vec3(0.0);
  if (tt < 0.0 || tt > dur) return vec3(0.0);
  float side = h1(id * 4.7) > 0.5 ? 1.0 : -1.0, ang = mix(0.31, 0.66, h1(id * 7.3));
  vec2 p0 = vec2(mix(60.0, 1120.0, h1(id * 5.9)), mix(8.0, 90.0, h1(id * 6.1))), dir = vec2(side * cos(ang), sin(ang));
  float sp = mix(380.0, 560.0, h1(id * 8.9)), Lt = mix(70.0, 140.0, h1(id * 9.7)) * (V > 1.5 ? 1.3 : 1.0);
  vec2 rel = q - (p0 + dir * sp * tt);
  float a = -dot(rel, dir), b = dot(rel, vec2(-dir.y, dir.x)), len = max(min(Lt, sp * tt), 1.0);
  if (a < -5.0 || a > len + 5.0 || abs(b) > 6.0) return vec3(0.0);
  float env = smoothstep(0.0, 0.18, tt) * (1.0 - smoothstep(dur - 0.3, dur, tt));
  float along = clamp(1.0 - a / len, 0.0, 1.0);
  float tail = exp(-b * b / (0.35 + 0.6 * (1.0 - along))) * along * along * step(0.0, a);
  vec3 c = mix(mix(LIL, CYAN, 0.5), vec3(1.0, 0.98, 0.94), along);
  return (c * tail * 1.5 + vec3(1.0) * (exp(-dot(rel, rel) / 2.6) * 1.6 + exp(-length(rel) / 5.0) * 0.25)) * env * (V > 1.5 ? 1.3 : 1.0);
}

const vec2 MOON = vec2(322.0, 34.0);
vec3 moonSky(vec2 q, float V) {
  vec2 d = q - MOON; float r = length(d);
  if (r > 160.0) return vec3(0.0);
  float R = 10.0, disk = smoothstep(R + 0.8, R - 0.8, r), lit = disk * smoothstep(R - 0.6, R + 1.0, length(d - vec2(-4.5, -2.5)));
  float tex = 0.85 + 0.15 * vn(d * 0.4 + 3.0);
  return vec3(1.0, 0.95, 0.85) * lit * 0.95 * tex + vec3(0.5, 0.55, 0.75) * (disk - lit) * 0.08
       + mix(LIL, vec3(1.0), 0.5) * (exp(-r / (V > 1.5 ? 60.0 : 38.0)) * (V > 1.5 ? 0.12 : 0.08) + exp(-r / 14.0) * 0.06) * (1.0 - disk);
}

/* Distant breakers on the far sea (the band just under the horizon, dy < 48 px). 3 lanes (soft) or 6 (strong), each with its own
   8-14 s period; a lane's slot fires with probability 0.65 at a random x and depth (deeper = nearer = larger, by perspective).
   Each wave: 0-2.2 s a thin crest line rises and brightens; ~2.1-3.1 s it breaks, white foam running out sideways along the crest
   from one point with a little spray above it and a soft glow; then the foam drifts toward the viewer and fades by 5.5 s.
   Foam is the theme's cyan-white, warmed in the evening. */
vec3 breakers(vec2 q, float dy, float V) {
  vec3 acc = vec3(0.0);
  vec4 w = phaseW();
  vec3 foamC = mix(mix(CYAN, vec3(1.0), 0.55), vec3(1.0, 0.72, 0.5), 0.6 * w.w);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= 3.0 * V) break;
    float P = 8.0 + 6.0 * h1(fi * 3.1 + 0.7), D = ${f(BREAKER_LIFE)}, ph = t + fi * 2.37 * P;
    float id = floor(ph / P), tau = ph - id * P;
    if (tau > D || h1(id * 7.13 + fi * 31.7) > 0.65) continue;
    float x0 = 40.0 + 1100.0 * h1(id * 3.7 + fi * 11.0), dy0 = mix(3.0, 38.0, pow(h1(id * 5.3 + fi * 1.9), 1.4));
    float sc = 0.35 + dy0 / 14.0, wl = (24.0 + 46.0 * h1(id * 9.1 + fi)) * sc * (V > 1.5 ? 1.35 : 1.0);
    float lx = (q.x - x0) / wl;
    if (abs(lx) > 1.6 || abs(dy - dy0) > 14.0 * sc + 4.0) continue;
    float rise = smoothstep(0.0, 2.2, tau) * (1.0 - smoothstep(2.4, 3.2, tau));
    float ly = dy - dy0 + 1.6 * sc * smoothstep(0.0, 2.2, tau), th = 0.45 + 0.35 * sc;
    float swell = exp(-ly * ly / (th * th)) * exp(-lx * lx * 2.2) * rise;
    float bk = smoothstep(2.1, 3.1, tau), spread = bk * 1.15;
    float run = 1.0 - smoothstep(spread - 0.25, spread, abs(lx - 0.15 * (h1(id) - 0.5)));
    float decay = smoothstep(2.1, 2.6, tau) * (1.0 - smoothstep(2.9, D, tau));
    float fy = ly - max(tau - 2.1, 0.0) * 0.5 * sc * bk;
    float foamV = exp(-max(fy, 0.0) / (th * 2.0 + max(tau - 2.1, 0.0) * 0.8 * sc)) * exp(-pow(min(fy, 0.0) / (th * (1.0 + 2.0 * bk)), 2.0));
    float grain = 0.45 + 0.55 * vn(vec2(q.x * 0.35 / sc, dy * 0.9 + fi * 9.0));
    float foam = run * decay * foamV * grain * max(1.0 - 0.6 * lx * lx, 0.0);
    float glow = exp(-(lx * lx * 1.5 + pow(ly / (6.0 * sc), 2.0))) * decay * 0.18;
    acc += mix(DEEP, CYAN, 0.7) * swell * 0.9 + foamC * (foam * 2.0 + glow * 1.5);
  }
  return acc * (V > 1.5 ? 1.35 : 1.0) * smoothstep(0.5, 2.0, dy);
}

/* Sea reflection (dy < 80 px): the sky of the hour, mirrored and stretched, broken into rippling horizontal streaks that fade
   with distance from the horizon — the aurora's green by day, the red sun's glitter path in the evening, the moon's glitter
   column at night (when the moon is on). */
vec3 reflectSea(vec2 q, float dy, float V) {
  vec4 w = phaseW();
  float rip = sin(dy * 1.1 - t * 1.6 + 0.6 * sin(q.x * 0.013 + t * 0.3));
  float xo = rip * (1.0 + dy * 0.12), u = dy * 1.3 + 6.0, x = q.x + xo;
  vec3 s = vec3(0.0);
  if (w.y > 0.0) s += dawnSky(u, exp(-pow((x - C.x) / 640.0, 2.0))) * w.y;
  if (w.z > 0.0) s += auroraSky2(x, u, ${f(SKY_LEVELS.aurora)}) * w.z;
  if (w.w > 0.0) s += (duskSky(u, exp(-pow((x - C.x) / 640.0, 2.0))) + sunSky(vec2(x, C.y - u))) * w.w;
  float streak = 0.55 + 0.45 * sin(dy * 2.3 - t * 1.9 + 3.0 * vn(vec2(q.x * 0.02, dy * 0.2)));
  float k = V > 1.5 ? 0.75 : 0.45;
  vec3 c = s * streak * k * exp(-dy / 30.0);
  if (w.x > 0.0) {
    float g = exp(-pow((q.x - MOON.x + xo * 2.0) / (3.0 + dy * 0.35), 2.0)) * pow(vn(vec2(q.x * 0.25, dy * 1.5 - t * 1.2)), 3.0);
    c += vec3(1.0, 0.95, 0.85) * g * 1.4 * k * exp(-dy / 45.0) * w.x;
  }
  return c;
}
`;

const HORIZON = `
uniform float seaTypingE; uniform float seaTypingRoll;
void main() {
  vec2 p = P(), q = M(p); float HZ = C.y, F = 700.0, CH = 150.0;
  vec3 col = vec3(0.0);
  float dy = q.y - HZ;
  if (dy > 0.5) {
    float Z = CH * F / dy, X = (q.x - C.x) * Z / F;
    float w = 22.0 * sin(X * 0.010 + t * 0.55) * cos(Z * 0.0075 - t * 0.40) + 11.0 * sin((X + Z) * 0.018 - t * 0.9);
    float Xg = X + w * 0.6, Zg = Z - w * 4.0 - t * 40.0 - seaTypingRoll;
    float px_ = Z / F, pz = Z * Z / (CH * F);
    float lx = 1.0 - smoothstep(0.0, px_ * 1.4, abs(fract(Xg / 64.0) - 0.5) * 64.0);
    float lz = (1.0 - smoothstep(0.0, pz * 1.4, abs(fract(Zg / 64.0) - 0.5) * 64.0)) * smoothstep(40.0, 10.0, pz);
    float crest = smoothstep(-20.0, 26.0, w), fade = exp(-Z / 2600.0) * smoothstep(0.0, 26.0, dy);
    col += mix(DEEP, CYAN, crest) * (lx * 0.55 + lz * 0.75) * fade * (0.55 + 0.6 * crest);
    // Item 662: typing lights the sea (its lines, and a glow on the crests).
    col += mix(CYAN, SIG, 0.5) * ((lx * 0.55 + lz * 0.75) * (0.55 + 0.6 * crest) * ${f(SEA_TYPING_LIT)} + 0.05 * ${f(SEA_TYPING_GLOW)} * (0.35 + 0.65 * crest)) * fade * seaTypingE;
    col += DEEP * 0.10 * exp(-dy / 90.0);
    // Item 671: waves breaking far out (an event: none under Reduce motion) and the sky of the hour reflected.
    if (dy < 60.0 && ev > 0.5) col += breakers(q, dy, ${f(SKY_LEVELS.events)});
    if (dy < 80.0) col += reflectSea(q, dy, ${f(SKY_LEVELS.events)});
  } else {
    vec2 d = q - vec2(C.x, HZ); float r = length(d), a = atan(-d.y, d.x);
    float br = 0.85 + 0.15 * sin(t * 0.5);
    // Item 671: the sky of the hour (the four phases' weights sum to 1), then the night's events.
    float up = clamp(-dy / 220.0, 0.0, 1.0), u = max(-dy, 0.0), lat = exp(-pow(d.x / 640.0, 2.0));
    vec4 W = phaseW(); float wN = W.x, wM = W.y, wD = W.z, wE = W.w;
    vec3 glow = mix(CYAN, LIL, up);
    glow = mix(glow, DAWN, tint * 0.55 * exp(-pow(d.x / 300.0, 2.0)) * (1.0 - 0.75 * up));
    vec3 sky = glow * (0.18 * wM + 0.24 * wD) * exp(-pow(length(d * vec2(0.42, 1.0)) / 250.0, 2.0));
    if (wM > 0.0) sky += dawnSky(u, lat) * wM;
    if (wD > 0.0) sky += auroraSky2(q.x, u, ${f(SKY_LEVELS.aurora)}) * wD;
    if (wE > 0.0) sky += (duskSky(u, lat) + sunSky(q)) * wE;
    col += sky * br;
    if (wN > 0.0) col += (starSky2(q, u, ${f(SKY_LEVELS.stars)}) + moonSky(q, ${f(SKY_LEVELS.events)}) * smoothstep(2.0, 24.0, u)) * wN;
    if (wN > 0.0 && ev > 0.5) col += cometSky(q, ${f(SKY_LEVELS.events)}) * wN * smoothstep(2.0, 24.0, u);
    if (ev > 0.5) col += meteors(q, ${f(SKY_LEVELS.events)}) * (0.55 + 0.45 * wN) * smoothstep(2.0, 14.0, u);
    // Item 669 (his pick, B Rim flare "slightly less bright"): a short cyan-white flare at each ray's foot,
    // starting on the tick ring's outer edge (r 184), so the light reads as leaving the rim; then today's warm body.
    float sh = pow(0.5 + 0.5 * sin(a * 26.0 + t * 0.25), 10.0), foot = smoothstep(176.0, 190.0, r);
    vec3 ray = mix(SIG, DAWN, tint * 0.85 * (1.0 - smoothstep(200.0, 660.0, r)));
    col += ray * sh * 0.16 * exp(-r / 520.0) * foot;
    col += mix(SIG, vec3(1.0), 0.3) * sh * 0.18 * exp(-(r - 184.0) / 34.0) * foot;
    col += SIG * specks(q, 0.16) * 0.55 * smoothstep(0.0, 60.0, -dy);
  }
  col += CYAN * exp(-abs(dy) / 1.6) * 0.65 * exp(-pow((q.x - C.x) / 700.0, 2.0));
  gl_FragColor = outc(col * veil(p, q) * gain);
}`;

/* Radar: a polar instrument grid round the dial, a sweep turning with its afterglow, pings radiating out, blips that flare as the
   sweep passes. Divisions of a turn are whole (spokes, ticks, blip cells), so there is no cut where atan wraps. */
const RADAR = `
void main() {
  vec2 p = P(), q = M(p), d = q - C; float r = length(d), a = atan(d.y, d.x);
  float out_ = smoothstep(180.0, 205.0, r), far = exp(-max(r - 200.0, 0.0) / 650.0);
  float s = mod(t * 0.5 - a, 6.28318);
  vec3 col = DEEP * 0.14 * exp(-pow(r / 520.0, 2.0));
  col += mix(CYAN, SIG, 0.5) * exp(-s * 1.8) * 0.30 * out_ * far + SIG * exp(-s * 70.0) * 0.55 * out_ * far;
  float rg = 1.0 - smoothstep(0.0, 1.2, abs(fract((r - 200.0) / 52.0) - 0.5) * 52.0);
  float SP = ${f(TAU / RADAR_SPOKES)}, TK = ${f(TAU / RADAR_TICKS)}, BC = ${f(TAU / RADAR_BLIP_CELLS)};
  float spk = 1.0 - smoothstep(0.0, 1.0, abs(fract(a / SP) - 0.5) * SP * r);
  float tk = (1.0 - smoothstep(0.0, 1.0, abs(fract(a / TK) - 0.5) * TK * r)) * step(abs(r - 236.0), 5.0);
  col += SIG * (rg * 0.10 + spk * 0.045 + tk * 0.35) * out_ * far * (1.0 + 2.0 * exp(-s * 2.5));
  for (int k = 0; k < 3; k++) {
    float rp = 200.0 + mod(t * 95.0 + float(k) * 290.0, 870.0);
    col += SIG * exp(-pow((r - rp) / 5.0, 2.0)) * 0.45 * (1.0 - (rp - 200.0) / 870.0);
  }
  vec2 pc = vec2(a / BC, (r - 200.0) / 44.0), id = floor(pc);
  id.x = mod(id.x, ${f(RADAR_BLIP_CELLS)});
  float on = step(0.86, h2(id)) * out_;
  vec2 ctr = (id + 0.25 + 0.5 * vec2(h2(id + 1.3), h2(id + 2.9)));
  float ang = ctr.x * BC, rad = 200.0 + ctr.y * 44.0;
  vec2 bp = C + rad * vec2(cos(ang), sin(ang));
  float age = mod(t * 0.5 - ang, 6.28318);
  col += mix(CYAN, AMB, step(0.97, h2(id + 5.0))) * on * exp(-dot(q - bp, q - bp) / 4.0) * (0.25 + 1.4 * exp(-age * 1.2));
  float dash = step(0.5, fract(a * 36.0 / 6.28318 + t * 0.03)) * (1.0 - smoothstep(0.0, 1.0, abs(r - 262.0)));
  col += SIG * dash * 0.25;
  gl_FragColor = outc(col * veil(p, q) * gain);
}`;

/** The fragment shader for a look. */
export function shaderSource(look: ShaderLook): string {
  return PRELUDE + (look === "horizon" ? SKY + HORIZON : RADAR);
}

const VS = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";

/** One frame's inputs (CSS px of the canvas's box). */
export interface ShaderFrame {
  t: number;
  w: number;
  h: number;
  origin: { x: number; y: number };
  /** The live dial's radius (CSS px). */
  r: number;
  gain: number;
  rects: number[][];
  colours: ShaderColours;
  tint: number;
  /** Item 662: the sea's typing response (0..1) and the grid's extra roll (px); absent = none. */
  seaTypingE?: number;
  seaTypingRoll?: number;
  /** Item 671: his local hour (0–24), the event clock (s), and whether events run (0 under Reduce motion); absent = 2 AM, t, on. */
  hr?: number;
  te?: number;
  ev?: number;
}

/** The sun-ray tint item 640 ships (0 = round 4's page). */
export const TINT = 1;

interface Renderer {
  gl: WebGLRenderingContext;
  draw(fr: ShaderFrame): void;
}

/** Compile a look into a context; null if WebGL or the shader fails. */
export function makeRenderer(gl: WebGLRenderingContext, look: ShaderLook): Renderer | null {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(`newChatShader ${look}:`, gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VS);
  const fs = sh(gl.FRAGMENT_SHADER, shaderSource(look));
  const pr = gl.createProgram();
  if (!vs || !fs || !pr) return null;
  gl.attachShader(pr, vs);
  gl.attachShader(pr, fs);
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (k: string) => gl.getUniformLocation(pr, k);
  const u = {
    t: U("t"), res: U("res"), px: U("px"), gain: U("gain"), CL: U("CL"), K: U("K"), tint: U("tint"),
    SIG: U("SIG"), AMB: U("AMB"), CYAN: U("CYAN"), DEEP: U("DEEP"), LIL: U("LIL"), DAWN: U("DAWN"), RC: U("RC"), nR: U("nR"),
    seaTypingE: U("seaTypingE"), seaTypingRoll: U("seaTypingRoll"),
    hr: U("hr"), te: U("te"), ev: U("ev"),
  };
  const rc = new Float32Array(MAX_RECTS * 4);
  return {
    gl,
    draw(fr) {
      // Each look has its own program on the one context: bind it (and the triangle) before drawing.
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const cw = gl.drawingBufferWidth;
      const ch = gl.drawingBufferHeight;
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.t, fr.t);
      gl.uniform2f(u.res, fr.w, fr.h);
      gl.uniform1f(u.px, fr.w > 0 ? cw / fr.w : 1);
      gl.uniform1f(u.gain, fr.gain);
      gl.uniform2f(u.CL, fr.origin.x, fr.origin.y);
      gl.uniform1f(u.K, Math.max(0.05, fr.r / MOCK_R));
      gl.uniform1f(u.tint, fr.tint);
      const c = fr.colours;
      gl.uniform3fv(u.SIG, c.sig);
      gl.uniform3fv(u.AMB, c.amb);
      gl.uniform3fv(u.CYAN, c.cyan);
      gl.uniform3fv(u.DEEP, c.deep);
      gl.uniform3fv(u.LIL, c.lil);
      gl.uniform3fv(u.DAWN, c.dawn);
      rc.fill(0);
      const n = Math.min(MAX_RECTS, fr.rects.length);
      for (let i = 0; i < n; i++) rc.set(fr.rects[i], i * 4);
      gl.uniform4fv(u.RC, rc);
      gl.uniform1f(u.nR, n);
      if (u.seaTypingE) gl.uniform1f(u.seaTypingE, fr.seaTypingE ?? 0);
      if (u.seaTypingRoll) gl.uniform1f(u.seaTypingRoll, fr.seaTypingRoll ?? 0);
      if (u.hr) gl.uniform1f(u.hr, fr.hr ?? 2);
      if (u.te) gl.uniform1f(u.te, fr.te ?? fr.t);
      if (u.ev) gl.uniform1f(u.ev, fr.ev ?? 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** Text boxes in `host`'s box (CSS px, [x0, y0, x1, y1]), largest first, at most MAX_RECTS. */
export function veilRects(host: HTMLElement, selector: string): number[][] {
  if (!selector) return [];
  const hr = host.getBoundingClientRect();
  const out: number[][] = [];
  host.querySelectorAll(selector).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    out.push([r.left - hr.left, r.top - hr.top, r.right - hr.left, r.bottom - hr.top]);
  });
  out.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
  return out.slice(0, MAX_RECTS);
}

/** Whether the canvas runs at all: a shader look, and the lit ground on (unless `always`, as on a Settings card). */
export function shaderWanted(style: string, groundToken: string, always = false): boolean {
  const g = groundToken.trim();
  return isShaderLook(style) && (always || (g !== "" && g !== "none"));
}

type Win = Window & { __groundStats?: { frames: number; totalMs: number; maxMs: number }; __groundT?: number; __shaderTint?: number; __groundHour?: number };

export interface ShaderOptions {
  /** Elements whose text the light is dimmed under. */
  veil?: string;
  /** Run whatever `--ground-dots` says (a Settings preview). */
  always?: boolean;
}

/**
 * Wire a WebGL canvas covering `host` (absolutely, inset 0). `originOf`
 * gives the dial's centre and radius in `host`'s box, or null for the box's
 * centre and the design page's radius.
 */
export function shaderGround(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  originOf: () => { x: number; y: number; r: number } | null,
  opts: ShaderOptions = {},
): { set(style: string): void; typed(): void; destroy(): void } {
  const w = window as Win;
  // Item 662: the sea's typing response, ticked by this loop's own frames.
  const sea = seaTyping();
  let lastFrame = 0;
  // Item 671: the drawn hour, eased toward his clock (a harness may pin it with window.__groundHour).
  const clockHour = () => (typeof w.__groundHour === "number" ? w.__groundHour : localHour(new Date()));
  let hour = clockHour();
  let stillTimer: ReturnType<typeof setInterval> | null = null;
  let style = "";
  let gl: WebGLRenderingContext | null = null;
  let lost = false;
  const programs = new Map<ShaderLook, Renderer | null>();
  let renderer: Renderer | null = null;
  let on = false;
  let still = false;
  let seen = true;
  let raf = 0;
  let frames = 0;
  const fr: ShaderFrame = {
    t: 0,
    w: 0,
    h: 0,
    origin: { x: 0, y: 0 },
    r: MOCK_R,
    gain: 1,
    rects: [],
    colours: shaderColours(JARVIS_SIG, [255, 180, 84]),
    tint: TINT,
  };

  const read = (v: string) => {
    canvas.style.color = v;
    return getComputedStyle(canvas).color;
  };
  function readColours() {
    const parse = (css: string, fb: Rgb): Rgb => {
      const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(css.trim());
      return m ? [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])] : fb;
    };
    fr.colours = shaderColours(parse(read("var(--signal)"), JARVIS_SIG), parse(read("var(--accent)"), [255, 180, 84]));
  }
  function readOrigin() {
    const o = originOf();
    fr.origin = o ? { x: o.x, y: o.y } : { x: fr.w / 2, y: fr.h / 2 };
    fr.r = o?.r ?? MOCK_R;
  }
  function readLayout() {
    readOrigin();
    fr.rects = veilRects(host, opts.veil ?? "");
  }
  function context(): WebGLRenderingContext | null {
    if (gl || lost) return gl;
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    return gl;
  }
  function resize() {
    fr.w = host.clientWidth;
    fr.h = host.clientHeight;
    canvas.style.width = `${fr.w}px`;
    canvas.style.height = `${fr.h}px`;
    const s = Math.min(DRAW_SCALE, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(fr.w * s));
    canvas.height = Math.max(1, Math.round(fr.h * s));
    readLayout();
  }
  function draw(tSec: number) {
    if (!renderer) return;
    fr.t = tSec;
    fr.gain = still ? 0.8 : 1;
    fr.tint = typeof w.__shaderTint === "number" ? w.__shaderTint : TINT;
    fr.seaTypingE = still ? 0 : sea.e;
    fr.seaTypingRoll = still ? 0 : sea.roll;
    fr.hr = hour;
    fr.te = tSec;
    fr.ev = still ? 0 : 1;
    const t0 = performance.now();
    renderer.draw(fr);
    const s = w.__groundStats;
    if (s && !still) {
      const ms = performance.now() - t0;
      s.frames++;
      s.totalMs += ms;
      if (ms > s.maxMs) s.maxMs = ms;
    }
  }
  const nowSec = (t: number) => (typeof w.__groundT === "number" ? w.__groundT : t) / 1000;
  function frame(t: number) {
    raf = 0;
    if (!on || still || !renderer || document.hidden || !seen) return; // visibility restarts it
    // Item 668 (his bug, 2026-11-12): the sea is centred on the dial, which is
    // still settling when the page opens; read only every 30 frames, the sea
    // jumped to the dial's new place ~1 s in. The dial's place is read every
    // frame (two rects); the veils every frame for the first second, then
    // every 30.
    frames++;
    if (frames <= 60 || frames % 30 === 0) readLayout();
    else readOrigin();
    // Real time between frames (capped, so a stall or a hidden spell does not jump the response).
    sea.tick(lastFrame ? Math.min(0.1, Math.max(0, (t - lastFrame) / 1000)) : 0);
    // Eased (τ 2 s) even after a hidden spell or sleep, so the sky drifts to the new hour instead of snapping.
    hour = easeHour(hour, clockHour(), lastFrame ? Math.min(0.1, Math.max(0, (t - lastFrame) / 1000)) : 0);
    lastFrame = t;
    draw(nowSec(t));
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (on && !still && renderer && !raf && !document.hidden && seen) raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastFrame = 0;
  }
  function decide() {
    stop();
    if (stillTimer) clearInterval(stillTimer);
    stillTimer = null;
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--ground-dots");
    on = shaderWanted(style, ground, !!opts.always) && !!context() && !lost;
    if (!on || !gl || !isShaderLook(style)) {
      on = false;
      renderer = null;
      canvas.style.display = "none";
      return;
    }
    if (!programs.has(style)) programs.set(style, makeRenderer(gl, style));
    renderer = programs.get(style) ?? null;
    if (!renderer) {
      on = false;
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "block";
    frames = 0;
    still = reducedMotion();
    if (still) sea.reset();
    if (still || frames === 0) hour = clockHour();
    // Item 671: Reduce motion's one pose still follows the hour, redrawn once a minute.
    if (still)
      stillTimer = setInterval(() => {
        hour = clockHour();
        draw(STILL_T);
      }, 60_000);
    readColours();
    resize();
    // Draw at once, so the light is there even while the loop waits (hidden window, Reduce motion's one pose).
    draw(still ? STILL_T : nowSec(performance.now()));
    kick();
  }
  const ro = new ResizeObserver(() => {
    if (on) {
      resize();
      draw(still ? STILL_T : nowSec(performance.now()));
    }
  });
  ro.observe(host);
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((es) => {
      seen = es.some((e) => e.isIntersecting);
      if (seen) {
        frames = 0;
        kick();
      }
      else stop();
    });
    io.observe(host);
  }
  const mo = new MutationObserver(() => decide());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-light", "data-palette", "data-layout", "data-accent", "style", "class"] });
  let mq: MediaQueryList | null = null;
  try {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", decide);
  } catch {
    mq = null;
  }
  const onVis = () => kick();
  document.addEventListener("visibilitychange", onVis);
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    programs.clear();
    renderer = null;
  };
  const onRestored = () => {
    lost = false;
    decide();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  decide();
  return {
    /** A key landed in the composer (Reduce motion: no response; Radar ignores it). */
    typed() {
      if (still || style !== "horizon") return;
      sea.key();
      kick();
    },
    set(next: string) {
      if (next === style) return;
      style = next;
      decide();
    },
    destroy() {
      stop();
      if (stillTimer) clearInterval(stillTimer);
      ro.disconnect();
      io?.disconnect();
      mo.disconnect();
      mq?.removeEventListener("change", decide);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.style.display = "none";
    },
  };
}

/**
 * Frame cost, synced (round 4's method: each frame ends in a 1-px readback,
 * so the GPU's work is counted; the first 20 frames are dropped). Draws a
 * `w` × `h` CSS px box at `scale` device pixels per CSS pixel. For a harness.
 */
export function benchShader(look: ShaderLook | "clear", w: number, h: number, scale: number, n = 300, hr = 2): { mean: number; p95: number; max: number } | null {
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!g) return null;
  const r = look === "clear" ? null : makeRenderer(g, look);
  if (look !== "clear" && !r) return null;
  const px = new Uint8Array(4);
  const fr: ShaderFrame = {
    t: 3,
    w,
    h,
    origin: { x: w / 2, y: 200 },
    r: MOCK_R,
    gain: 1,
    rects: [],
    colours: shaderColours(JARVIS_SIG, [255, 180, 84]),
    tint: TINT,
    hr,
  };
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    if (r) {
      fr.t = 3 + i / 60;
      r.draw(fr);
    } else {
      g.viewport(0, 0, c.width, c.height);
      g.clear(g.COLOR_BUFFER_BIT);
    }
    g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    ms.push(performance.now() - t0);
  }
  const s = ms.slice(20).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  g.getExtension("WEBGL_lose_context")?.loseContext();
  return { mean, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}
