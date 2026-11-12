// Item 671 cost bench (sky671.html?bench=2): the Horizon shader's own GPU work per frame, and what each part of the sky costs
// (the source with one piece removed by string replacement). Why not ?bench=1: there each frame's 1-px readback and the
// driver's fixed cost (~1-1.4 ms) dominate at 1x, and performance.now() is coarse (1 ms) in WebKit, so per-frame figures
// carried +/-1 ms of noise. Here the canvas is drawn at `s` (default 3) device px per CSS px so the shader's work is s^2 times
// larger than that fixed cost, frames are timed in blocks of `b` synced frames, the variants run round-robin in one context,
// and own work at 1x = (frame - clear) / s^2. ?hrs=2,21 &v=clear,shipped,now,... &n=200 &s=3 &b=10.
import { shaderSource as newSrc, shaderColours, TINT } from "../src/lib/newChatShader";
import { shaderSource as baseSrc } from "./sky671-assets/baseShader";
import dump from "./sky671-assets/dump.json";
const cap = document.getElementById("cap")!;
cap.textContent = "benching…";
const [, , W, H] = dump.welcome as number[];
const VS = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const qs = new URLSearchParams(location.search);
const S = Number(qs.get("s") ?? 3), N = Number(qs.get("n") ?? 200);
// One context; every variant's program compiled once; blocks go round-robin across the variants (block i of each, then
// block i+1 ...), each frame = clear + draw + a 1-px readback (synced). Drift and load spikes hit every variant alike;
// the figure is each variant's median block (per frame). "clear" = the readback alone.
function benchAll(srcs: Record<string, string>, hr: number): Record<string, number> {
  const c = document.createElement("canvas");
  c.width = Math.round(W * S); c.height = Math.round(H * S);
  const gl = c.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false })!;
  gl.viewport(0, 0, c.width, c.height);
  const sh = (ty: number, s: string) => { const x = gl.createShader(ty)!; gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? "compile"); return x; };
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const col = shaderColours([134, 216, 247], [255, 180, 84]);
  const progs: Record<string, { pr: WebGLProgram | null; t: WebGLUniformLocation | null; te: WebGLUniformLocation | null }> = {};
  for (const [k, src] of Object.entries(srcs)) {
    if (!src) { progs[k] = { pr: null, t: null, te: null }; continue; }
    const pr = gl.createProgram()!; gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, src)); gl.linkProgram(pr); gl.useProgram(pr);
    const loc = gl.getAttribLocation(pr, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(pr, n);
    gl.uniform2f(U("res"), W, H); gl.uniform1f(U("px"), S); gl.uniform1f(U("gain"), 1); gl.uniform2f(U("CL"), W / 2, 200); gl.uniform1f(U("K"), 1);
    gl.uniform1f(U("tint"), TINT); gl.uniform3fv(U("SIG"), col.sig); gl.uniform3fv(U("AMB"), col.amb); gl.uniform3fv(U("CYAN"), col.cyan); gl.uniform3fv(U("DEEP"), col.deep); gl.uniform3fv(U("LIL"), col.lil); gl.uniform3fv(U("DAWN"), col.dawn);
    gl.uniform4fv(U("RC"), new Float32Array(48)); gl.uniform1f(U("nR"), 0); gl.uniform1f(U("hr"), hr); gl.uniform1f(U("ev"), 1);
    progs[k] = { pr, t: U("t"), te: U("te") };
  }
  // performance.now() is coarse here (1 ms in this WebKit), so a sample is a block of B synced frames timed together.
  const B = Number(qs.get("b") ?? 10);
  const px = new Uint8Array(4), ms: Record<string, number[]> = {};
  for (let i = 0; i < N / B + 1; i++) for (const [k, g] of Object.entries(progs)) {
    if (g.pr) gl.useProgram(g.pr);
    const t0 = performance.now();
    for (let j = 0; j < B; j++) {
      const tt = 3 + (i * B + j) / 60;
      if (g.pr) { gl.uniform1f(g.t, tt); gl.uniform1f(g.te, tt); }
      gl.clear(gl.COLOR_BUFFER_BIT); if (g.pr) gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    if (i >= 1) (ms[k] ??= []).push((performance.now() - t0) / B);
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  const out: Record<string, number> = {};
  for (const [k, xs] of Object.entries(ms)) { const s = xs.slice().sort((a, b) => a - b); out[k] = s[Math.floor(s.length / 2)]; }
  return out;
}
const base = newSrc("horizon");
const rep = (a: string, b: string) => { if (!base.includes(a)) throw new Error("missing: " + a.slice(0, 50)); return base.replace(a, b); };
const V: Record<string, string> = {
  clear: "",
  shipped: baseSrc("horizon"),
  now: base,
  noL2: rep("for (int L = 0; L < 3; L++) {\n    float fl = float(L), sz = L == 0 ? 24.0", "for (int L = 0; L < 2; L++) {\n    float fl = float(L), sz = L == 0 ? 24.0"),
  noStars: rep("col += (starSky2(q, u, 1.0) + moonSky", "col += (moonSky"),
  noReflect: rep("if (dy < 80.0) col += reflectSea", "if (false) col += reflectSea"),
  noBreakers: rep("if (dy < 60.0 && ev > 0.5) col += breakers", "if (false) col += breakers"),
  noSunSky: rep("if (wE > 0.0) sky += (duskSky(u, lat) + sunSky(q)) * wE;", ""),
  noMeteorComet: rep("if (wN > 0.0 && ev > 0.5) col += cometSky", "if (false) col += cometSky").replace("if (ev > 0.5) col += meteors", "if (false) col += meteors"),
  noAurora: rep("if (wD > 0.0) sky += auroraSky2", "if (false) sky += auroraSky2"),
};
const hours = (qs.get("hrs") ?? "2,21,13,5.75").split(",").map(Number);
const names = (qs.get("v") ?? "clear,shipped,now").split(",");
setTimeout(() => {
  const out = [`round-robin bench ${W}x${H} CSS at scale ${S} (${S * S}x the pixels of 1x), ${N} frames each in blocks of ${qs.get("b") ?? 10} synced frames, median block mean per frame (ms); own work at 1x = (v - clear) / ${S * S}`];
  for (const h of hours) {
    const r = benchAll(Object.fromEntries(names.map((k) => [k, V[k]])), h);
    out.push(`hr ${h}: ` + names.map((k) => `${k} ${r[k].toFixed(2)}` + (k === "clear" ? "" : ` (${((r[k] - r.clear) / (S * S)).toFixed(2)})`)).join(" | "));
  }
  cap.textContent = out.join("\n");
}, 300);
