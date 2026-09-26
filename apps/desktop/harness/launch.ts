// Backlog 234 harness — see launch.html.
import "../src/app.css";
import { mount, flushSync } from "svelte";
import LaunchScreen from "../src/lib/LaunchScreen.svelte";
import { launch } from "../src/lib/launch.svelte";

const q = new URLSearchParams(location.search);
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
launch.project = q.get("project") ?? "nightshift-code";
mount(LaunchScreen, { target: root });
flushSync();

const t = q.get("t");
setTimeout(() => {
  const anims = document.getAnimations();
  if (t !== null) {
    for (const a of anims) {
      a.pause();
      a.currentTime = Number(t);
    }
  }
  // A timer, not rAF: an offscreen WKWebView holds rAF callbacks.
  setTimeout(() => {
    const svg = document.querySelector(".roll svg");
    const track = document.querySelector(".roll");
    const r = svg?.getBoundingClientRect();
    const tr = track?.getBoundingClientRect();
    cap.textContent =
      `t=${t ?? "live"} animations=${anims.length} ` +
      `(${anims.map((a) => (a as CSSAnimation).animationName ?? "?").join(",")}) ` +
      `transform=${svg ? getComputedStyle(svg).transform : "no svg"} ` +
      `moon x=${r ? r.left.toFixed(1) : "-"} w=${r ? r.width.toFixed(1) : "-"} track x=${tr ? tr.left.toFixed(1) : "-"}–${tr ? tr.right.toFixed(1) : "-"}`;
  }, 50);
}, 300);
