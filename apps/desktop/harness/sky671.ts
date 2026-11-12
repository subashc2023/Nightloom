// Item 671 proof harness — see sky671.html. bin/snap's offscreen WebKit window runs no animation frames, so this draws one
// frame directly with the real renderer at a forced hour (the live loop would pass the same uniforms), or benchmarks it.
import { MOCK_R, TINT, benchShader, makeRenderer, shaderColours, skyPhases, type ShaderFrame } from "../src/lib/newChatShader";
import dump from "./sky671-assets/dump.json";
// The shipped shader (nightshift 82552fa), copied out of git into sky671-assets/ (excluded), as a same-run baseline.
import { benchShader as benchBase } from "./sky671-assets/baseShader";

const cap = document.getElementById("cap")!;
const canvas = document.querySelector("canvas")!;
const qs = new URLSearchParams(location.search);
const hr = Number(qs.get("hr") ?? 2);
const t = Number(qs.get("t") ?? 7.3);
const [WX, WY, W, H] = dump.welcome as number[];
const core = dump.core as number[];
const PAD = 26;
Object.assign(canvas.style, { left: `${WX}px`, top: `${WY}px`, width: `${W}px`, height: `${H}px` });
canvas.width = W;
canvas.height = H;
const frame = (h: number, tt: number): ShaderFrame => ({
  t: tt,
  w: W,
  h: H,
  origin: { x: core[0] + core[2] / 2, y: core[1] + core[3] / 2 },
  r: core[2] / 2 - PAD,
  gain: 1,
  rects: (dump.rects as number[][]).slice(0, 12),
  colours: shaderColours([134, 216, 247], [255, 180, 84]),
  tint: TINT,
  hr: h,
  te: tt,
  ev: 1,
});
const fmt = (h: number) => `${((Math.floor(h) + 11) % 12) + 1}:${String(Math.round((h % 1) * 60)).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
if (qs.get("bench") === "1") {
  // Synced (one 1-px readback a frame, 150 frames, first 20 dropped) at 1x, 1180 x 822. The shipped shader and the new one
  // alternate, three rounds each, so load drift hits both; the figure is the median of the three means.
  setTimeout(() => {
    const out = [`item 671 bench, ${W} x ${H} CSS px at 1x, synced, 150 frames (first 20 dropped), median of 3 alternating rounds, dpr ${devicePixelRatio}`];
    const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[1];
    const run = (f: () => { mean: number } | null) => [0, 1, 2].map(() => f()?.mean ?? NaN);
    const base = run(() => benchBase("horizon", W, H, 1, 150));
    out.push(`shipped Horizon (82552fa): ${med(base).toFixed(2)} ms  [${base.map((x) => x.toFixed(2)).join(", ")}]`);
    for (const h of [2, 21, 13, 5.75]) {
      const b = run(() => benchShader("horizon", W, H, 1, 150, h));
      const b2 = run(() => benchBase("horizon", W, H, 1, 150));
      out.push(`671 at ${fmt(h)}: ${med(b).toFixed(2)} ms  [${b.map((x) => x.toFixed(2)).join(", ")}]  vs shipped ${med(b2).toFixed(2)}`);
    }
    const c = run(() => benchShader("clear", W, H, 1));
    out.push(`clear (readback only): ${med(c).toFixed(2)} ms`);
    cap.textContent = out.join("\n");
  }, 300);
} else {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })!;
  const r = makeRenderer(gl, "horizon");
  r?.draw(frame(hr, t));
  const w = skyPhases(hr);
  cap.textContent = `item 671 · ${fmt(hr)} · ${Object.entries(w).filter(([, v]) => v > 0.005).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ")} · t ${t} s · ${r ? "Horizon compiled" : "SHADER FAILED"}`;
}
