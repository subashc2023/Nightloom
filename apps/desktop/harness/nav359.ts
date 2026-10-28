// Item 359 (wave 9) — the ported navigator in the real Transcript (see nav359.html).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync } from "svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
import { easeOutCubic, JUMP_OFFSET } from "../src/lib/navigator";
import type { SessionEvent } from "../src/lib/types";
import { QS, REPLY } from "./fixture359";

const q = new URLSearchParams(location.search);
if (q.get("palette")) document.documentElement.dataset.palette = q.get("palette")!;
const m = Number(q.get("m") ?? 168);
const tag = document.getElementById("tag")!;
const at = new Date(Date.now() - 50 * 60_000).toISOString();
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (text: string): SessionEvent =>
  ({
    event: "assistant_message",
    model: "claude-opus-5-5",
    blocks: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
    at,
  }) as SessionEvent;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "turn_usage" ? [] : null),
  transformCallback: () => 0,
};
app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
app.activeSessionId = "s359";
const evs: SessionEvent[] = [];
for (let i = 0; evs.length < m; i++) {
  evs.push(user(QS[i % QS.length]));
  if (evs.length < m) evs.push(reply(REPLY(i)));
}
app.events = evs;
if (q.get("stream")) {
  const words = Number(q.get("words") ?? 40);
  const text = REPLY(6).split(" ").slice(0, words).join(" ");
  app.live = { segments: words > 0 ? [{ kind: "text", text }] : [] } as typeof app.live;
}
mount(Transcript, { target: document.getElementById("root")!, props: {} });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const v = () => document.querySelector<HTMLElement>(".transcript")!;
const ribs = () => [...document.querySelectorAll<HTMLElement>(".nav .col .rib")];

async function main() {
  await wait(150);
  const el = v();
  if (q.has("at")) {
    el.scrollTop = Number(q.get("at")) * (el.scrollHeight - el.clientHeight);
    el.dispatchEvent(new Event("scroll"));
    await wait(80);
  }
  if (q.has("scroll")) {
    // The eased jump, frozen at t: the same arithmetic as animateScroll (from → target, easeOutCubic).
    const i = Number(q.get("scroll"));
    const t = Number(q.get("t") ?? 1);
    // Tick i's anchor: the i-th turn in the transcript (the fixture has no rewound turns).
    const a = [...el.querySelectorAll<HTMLElement>("[data-turn]")][i];
    const from = el.scrollTop;
    const to = Math.min(
      a.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - JUMP_OFFSET,
      el.scrollHeight - el.clientHeight,
    );
    el.scrollTop = from + (to - from) * easeOutCubic(t);
    el.dispatchEvent(new Event("scroll"));
    await wait(80);
  }
  if (q.has("hover")) {
    const r = ribs()[Number(q.get("hover"))];
    if (r) {
      const b = r.getBoundingClientRect();
      const y = b.top + b.height / 2 + Number(q.get("dy") ?? 0);
      const col = document.querySelector<HTMLElement>(".nav .col")!;
      col.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y, clientX: b.right - 10 }));
      await wait(200);
    }
  }
  await wait(120);
  const dpr = devicePixelRatio;
  const lines = [...document.querySelectorAll<HTMLElement>(".nav .rib .line")];
  const hs = new Set(lines.map((l) => +(l.getBoundingClientRect().height * dpr).toFixed(3)));
  const offs = lines.map((l) => {
    const y = l.getBoundingClientRect().top * dpr;
    return Math.abs(y - Math.round(y));
  });
  const cur = ribs().findIndex((r) => r.getAttribute("aria-current") === "true");
  const nav = document.querySelector(".nav")?.getBoundingClientRect();
  const out = {
    m,
    ribs: ribs().length,
    current: cur,
    foot: document.querySelector('.nav .end:last-of-type .rib[aria-current="true"]') ? 1 : 0,
    dpr,
    ribHeightsDev: [...hs].join("/"),
    maxTopFracDev: +Math.max(0, ...offs).toFixed(3),
    nav: nav ? `${Math.round(nav.width)}x${Math.round(nav.height)}` : "hidden",
    tip: document.querySelector(".nav .tip")?.textContent?.trim().slice(0, 40) ?? "",
    dbg: (() => {
      const f = (x: number) => +(x * dpr - Math.round(x * dpr)).toFixed(3);
      const n = document.querySelector<HTMLElement>(".nav");
      const c = document.querySelector<HTMLElement>(".nav .col");
      const r = c?.querySelector<HTMLElement>(".rib");
      return q.has("dbg") && n && c && r
        ? `nav ${f(n.getBoundingClientRect().top)} col ${f(c.getBoundingClientRect().top)} st ${c.scrollTop} rib ${f(r.getBoundingClientRect().top)} ` +
            `par ${f((n.offsetParent as HTMLElement).getBoundingClientRect().top)} navstyle ${n.style.top} pad ${n.style.padding}`
        : "";
    })(),
  };
  tag.textContent = JSON.stringify(out);
  (window as unknown as Record<string, unknown>).__out = out;
}
void main();
