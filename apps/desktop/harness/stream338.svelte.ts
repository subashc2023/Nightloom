// Item 338 harness — the driver (see stream338.html). Mounts the real
// AssistantMessage once per column, replays one stream into it through the
// chosen treatments, and measures frames.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "./stream338-motion.css";
import { mount, unmount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import type { Segment } from "../src/lib/state.svelte";
import { buildStream, longReply, SHORT, type Op } from "./stream338-script";
import { attach, NAMES, TEXT, THINK, TOOL, type Config, type TextT } from "./stream338-motion";
import { MEASURED } from "./stream338-measured";
import { transcript } from "../src/lib/transcriptPrefs.svelte";

const q = new URLSearchParams(location.search);
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  text: byId<HTMLSelectElement>("text"),
  think: byId<HTMLSelectElement>("think"),
  tool: byId<HTMLSelectElement>("tool"),
  compare: byId<HTMLSelectElement>("compare"),
  reply: byId<HTMLSelectElement>("reply"),
  speed: byId<HTMLSelectElement>("speed"),
  reduce: byId<HTMLInputElement>("reduce"),
  open: byId<HTMLInputElement>("open"),
  replay: byId<HTMLButtonElement>("replay"),
  measure: byId<HTMLButtonElement>("measure"),
  stage: byId<HTMLElement>("stage"),
  status: byId<HTMLElement>("status"),
  numbers: byId<HTMLElement>("numbers"),
};

const fill = (sel: HTMLSelectElement, kind: string, ids: readonly string[]) => {
  for (const id of ids) sel.append(new Option(NAMES[`${kind}:${id}`].title, id));
};
fill(ui.text, "text", TEXT);
fill(ui.think, "think", THINK);
fill(ui.tool, "tool", TOOL);
for (const k of ["text", "think", "tool", "compare", "reply", "speed"] as const) {
  const v = q.get(k);
  if (v) ui[k].value = v;
}
if (q.get("reduce") === "1") ui.reduce.checked = true;
if (q.get("open") === "1") ui.open.checked = true;
// The Tools toggle, set in memory only (never saved): one-line calls unless asked.
const applyOpen = () => {
  transcript.tools = ui.open.checked;
  transcript.rev.tool++;
};
applyOpen();

const osReduced = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
const reduced = () => ui.reduce.checked || osReduced();

// ---- one run -----------------------------------------------------------------

interface Column {
  cfg: Config;
  vp: HTMLElement;
  comp: Record<string, unknown>;
  layer: ReturnType<typeof attach>;
}

interface Result {
  text: TextT;
  words: number;
  seconds: number;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
  over33: number;
  over50: number;
  renderMs: number;
  layerMs: number;
  deltas: number;
}

let stop: (() => void) | null = null;
const FOOTER = { model: "claude-opus-5-5", usage: { input_tokens: 18240, output_tokens: 1210 }, stop_reason: "end_turn" };

function columnsFor(base: Config): { cfg: Config; key: string }[] {
  const c = ui.compare.value;
  if (c === "text") return TEXT.map((t) => ({ cfg: { ...base, text: t }, key: `text:${t}` }));
  if (c === "think") return THINK.map((t) => ({ cfg: { ...base, think: t }, key: `think:${t}` }));
  if (c === "tool") return TOOL.map((t) => ({ cfg: { ...base, tool: t }, key: `tool:${t}` }));
  return [{ cfg: base, key: "" }];
}

function run(opts: { cols: { cfg: Config; key: string }[]; reply: string; speed: () => number; onEnd?: (r: Result) => void }) {
  stop?.();
  ui.stage.replaceChildren();
  ui.stage.classList.toggle("single", opts.cols.length === 1);
  const props = $state({ segs: [] as Segment[], streaming: true, since: Date.now(), footer: null as typeof FOOTER | null });
  const cols: Column[] = opts.cols.map(({ cfg, key }) => {
    const col = document.createElement("section");
    col.className = "col";
    const head = document.createElement("div");
    head.className = "col-head";
    const lines = key
      ? [NAMES[key]]
      : [NAMES[`text:${cfg.text}`], NAMES[`think:${cfg.think}`], NAMES[`tool:${cfg.tool}`]].map((n, i) => ({
          title: `${["Text", "Thinking", "Tools"][i]}: ${n.title}`,
          what: n.what,
        }));
    for (const l of lines) {
      const p = document.createElement("p");
      const b = document.createElement("b");
      b.textContent = l.title;
      p.append(b, " — ", l.what);
      head.append(p);
    }
    const vp = document.createElement("div");
    vp.className = "vp";
    const inner = document.createElement("div");
    inner.className = "inner";
    inner.innerHTML =
      '<div class="user-turn"><div class="user-bubble">Why does the dream pass leave some struck lines in place?</div></div><div class="reply-root"></div>';
    vp.append(inner);
    col.append(head, vp);
    ui.stage.append(col);
    const root = inner.querySelector<HTMLElement>(".reply-root")!;
    root.classList.toggle("m-reduced", reduced());
    const layer = attach(root, cfg, reduced);
    const comp = mount(AssistantMessage, { target: root, props }) as Record<string, unknown>;
    return { cfg, vp, comp, layer };
  });
  flushSync();

  const { ops, end } = buildStream(opts.reply);
  let i = 0;
  let vt = 0;
  let last = performance.now();
  let renderMs = 0;
  let deltas = 0;
  const gaps: number[] = [];
  let prevFrame = 0;
  let raf = 0;
  let done = false;
  const frame = (t: number) => {
    if (prevFrame) gaps.push(t - prevFrame);
    prevFrame = t;
    if (!done) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const t0 = performance.now();

  const tick = () => {
    const n = performance.now();
    vt += (n - last) * opts.speed();
    last = n;
    const pinned = cols.map((c) => c.vp.scrollHeight - c.vp.scrollTop - c.vp.clientHeight < 60);
    let applied = 0;
    const r0 = performance.now();
    while (i < ops.length && ops[i].at <= vt) {
      (ops[i] as Op).apply(props.segs);
      i++;
      applied++;
    }
    if (vt >= end && props.streaming) {
      props.streaming = false;
      props.footer = FOOTER;
      applied++;
    }
    if (applied) {
      flushSync();
      renderMs += performance.now() - r0;
      deltas += applied;
      cols.forEach((c, k) => {
        if (pinned[k]) c.vp.scrollTop = c.vp.scrollHeight;
      });
    }
    ui.status.textContent = `${props.streaming ? "streaming" : "done"} · ${(vt / 1000).toFixed(1)} s of ${(end / 1000).toFixed(1)} s at ${opts.speed()}×${reduced() ? " · reduced motion: treatments off" : ""}`;
    if (!props.streaming) {
      finish();
      return;
    }
    // ?shot=<ms>: pause the stream at that instant (animations keep running) for a still.
    if (SHOT !== null && vt >= SHOT) {
      clearInterval(timer);
      setTimeout(() => ((window as unknown as { __result: unknown }).__result = {
        shot: SHOT,
        segs: props.segs.length,
        tails: cols.map((c) => {
          const mds = c.vp.querySelectorAll(".markdown");
          const md = mds[mds.length - 1];
          if (!md) return null;
          const w = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
          const out: string[] = [];
          for (let n = w.lastChild(); n && out.length < 8; n = w.previousNode())
            out.push(`${(n.parentElement?.className || n.parentElement?.tagName) ?? "?"}:${JSON.stringify((n as Text).data)}`);
          return out;
        }),
      }), 0);
    }
  };
  const timer = setInterval(tick, 8);

  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    const sorted = [...gaps].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    const seconds = (performance.now() - t0) / 1000;
    const words = opts.reply.split(/\s+/).filter(Boolean).length;
    opts.onEnd?.({
      text: cols[0].cfg.text,
      words,
      seconds,
      frames: gaps.length,
      fps: gaps.length / seconds,
      p50: pct(0.5),
      p95: pct(0.95),
      max: sorted[sorted.length - 1] ?? 0,
      over33: gaps.filter((g) => g > 33.4).length,
      over50: gaps.filter((g) => g > 50).length,
      renderMs,
      layerMs: cols[0].layer.stats.ms,
      deltas,
    });
  };

  stop = () => {
    done = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    for (const c of cols) {
      c.layer.detach();
      unmount(c.comp);
    }
    stop = null;
  };
}

// ---- the page --------------------------------------------------------------------

const LONG_WORDS = 5000;
const SHOT = q.has("shot") ? Number(q.get("shot")) : null;
addEventListener("error", (e) => ((window as unknown as { __result: unknown }).__result = { error: String(e.message) }));
addEventListener("unhandledrejection", (e) => ((window as unknown as { __result: unknown }).__result = { error: String(e.reason) }));
let longCache: string | null = null;
const replyText = () => (ui.reply.value === "long" ? (longCache ??= longReply(LONG_WORDS)) : SHORT);
const speed = () => Number(ui.speed.value) || 1;
const cfgNow = (): Config => ({ text: ui.text.value as Config["text"], think: ui.think.value as Config["think"], tool: ui.tool.value as Config["tool"] });

function replay() {
  run({ cols: columnsFor(cfgNow()), reply: replyText(), speed });
}

for (const el of [ui.text, ui.think, ui.tool, ui.compare, ui.reply, ui.reduce]) el.addEventListener("change", replay);
ui.open.addEventListener("change", () => {
  applyOpen();
  replay();
});
ui.replay.addEventListener("click", replay);

// ---- numbers -----------------------------------------------------------------------

const fmt = (n: number, d = 1) => n.toFixed(d);
function table(rows: Result[], title: string, note: string): HTMLElement {
  const wrap = document.createElement("div");
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = note;
  const t = document.createElement("table");
  t.innerHTML =
    "<thead><tr><th>Text treatment</th><th>frames/s</th><th>median frame</th><th>95th pct</th><th>worst</th><th>frames &gt; 33 ms</th><th>frames &gt; 50 ms</th><th>render (component)</th><th>layer (treatment)</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      NAMES[`text:${r.text}`].title + ((r as Result & { run?: number }).run ? ` (pass ${(r as Result & { run?: number }).run})` : ""),
      fmt(r.fps),
      `${fmt(r.p50)} ms`,
      `${fmt(r.p95)} ms`,
      `${fmt(r.max, 0)} ms`,
      `${r.over33} of ${r.frames}`,
      `${r.over50}`,
      `${fmt(r.renderMs / 1000, 2)} s · ${fmt(r.renderMs / Math.max(1, r.deltas), 2)} ms/delta`,
      `${fmt(r.layerMs / 1000, 2)} s · ${fmt(r.layerMs / Math.max(1, r.deltas), 2)} ms/delta`,
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(h, p, t);
  return wrap;
}

function showNumbers(live: Result[] | null) {
  ui.numbers.replaceChildren();
  if (MEASURED.rows.length)
    ui.numbers.append(table(MEASURED.rows as Result[], `Measured ${MEASURED.when}`, MEASURED.how));
  if (live) ui.numbers.append(table(live, "Measured here, just now", `This browser, the ~${LONG_WORDS.toLocaleString()}-word reply at ${MEASURE_SPEED}×, single column, your other settings as chosen.`));
}

const MEASURE_SPEED = 2;
function measureOne(text: TextT): Promise<Result> {
  return new Promise((res) => {
    run({ cols: [{ cfg: { ...cfgNow(), text }, key: "" }], reply: (longCache ??= longReply(LONG_WORDS)), speed: () => MEASURE_SPEED, onEnd: res });
  });
}

ui.measure.addEventListener("click", async () => {
  ui.measure.disabled = true;
  const out: Result[] = [];
  for (const t of TEXT) {
    out.push(await measureOne(t));
    showNumbers(out);
  }
  ui.measure.disabled = false;
});

showNumbers(null);

// ?measure=<text treatment>: one long run, the result left on window.__result (the WebKit runner reads it).
const m = q.get("measure");
if (m && (TEXT as readonly string[]).includes(m)) {
  measureOne(m as TextT).then((r) => ((window as unknown as { __result: Result }).__result = r));
} else {
  replay();
}
