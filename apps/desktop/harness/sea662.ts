// Item 662 proof harness — see sea662.html. bin/snap's offscreen WebKit window runs no animation frames (and its
// visibility checks pause the live loop), so this draws one frame directly: the real seaTyping() response, stepped by hand
// through `secs` of typing at 5 keys/s (?mode=typed: 3 s; rest: none), then the real Horizon shader (makeRenderer) at the
// same pinned sea moment (t = 8 s), with the typing uniforms the live loop would pass.
import "../src/app.css";
import { MOCK_R, TINT, makeRenderer, seaTyping, shaderColours } from "../src/lib/newChatShader";

const cap = document.getElementById("cap")!;
const host = document.getElementById("host")!;
const canvas = host.querySelector("canvas")!;
const mode = new URLSearchParams(location.search).get("mode") ?? "rest";
const secs = mode === "typed" ? 3 : 0;
const sea = seaTyping();
let nk = 0;
for (let t = 0; t < secs - 1e-9; t += 1 / 120) {
  if (t >= nk * 0.2) {
    sea.key();
    nk++;
  }
  sea.tick(1 / 120);
}
const W = 1180;
const H = 822;
canvas.width = W;
canvas.height = H;
canvas.style.width = `${W}px`;
canvas.style.height = `${H}px`;
const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })!;
const r = makeRenderer(gl, "horizon");
r?.draw({
  t: 8,
  w: W,
  h: H,
  origin: { x: 590, y: 200 },
  r: MOCK_R,
  gain: 1,
  rects: [],
  colours: shaderColours([134, 216, 247], [255, 180, 84]),
  tint: TINT,
  seaTypingE: sea.e,
  seaTypingRoll: sea.roll,
});
cap.textContent = `item 662 · ${mode === "typed" ? `after 3 s of typing at 5 keys/s (${nk} keys)` : "at rest"} · response ${sea.e.toFixed(2)} · extra roll ${sea.roll.toFixed(1)} px · ${r ? "Horizon compiled" : "SHADER FAILED"}`;
