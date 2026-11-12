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
  } else {
    vec2 d = q - vec2(C.x, HZ); float r = length(d), a = atan(-d.y, d.x);
    float br = 0.85 + 0.15 * sin(t * 0.5);
    float up = clamp(-dy / 220.0, 0.0, 1.0);
    vec3 glow = mix(CYAN, LIL, up);
    glow = mix(glow, DAWN, tint * 0.55 * exp(-pow(d.x / 300.0, 2.0)) * (1.0 - 0.75 * up));
    col += glow * 0.30 * br * exp(-pow(length(d * vec2(0.42, 1.0)) / 250.0, 2.0));
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
  return PRELUDE + (look === "horizon" ? HORIZON : RADAR);
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

type Win = Window & { __groundStats?: { frames: number; totalMs: number; maxMs: number }; __groundT?: number; __shaderTint?: number };

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
export function benchShader(look: ShaderLook | "clear", w: number, h: number, scale: number, n = 300): { mean: number; p95: number; max: number } | null {
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
