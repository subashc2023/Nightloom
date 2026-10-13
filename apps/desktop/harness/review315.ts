// Review of item 315 (2026-10-05): probes on the real Composer, measured by the page. ?s= one of:
//   drift     a fenced draft with comments (non-ASCII), tabs and a wrapping line: the layer's glyphs vs the textarea's
//   undo      native undo after a code paste and the composer's ⌘Z (lost text?)
//   bytes     pastes with CRLF, tabs, trailing spaces, mid-line; the draft and Send's text vs the paste
//   perf      typing inside a 2,000-line fenced draft: ms per keystroke (?f=1: the formatted box)
//   long      a 2,100-word code paste: the attachment offer, no fence
//   opaque    ?s=drift but the textarea's text drawn opaque red over the layer (a shot to compare)
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";
import { EditorView } from "@codemirror/view";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "drift";
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const yieldNow = () =>
  new Promise<void>((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
const settle = async (k = 30) => {
  for (let i = 0; i < k; i++) await yieldNow();
};
let sent: string | null = null;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "send_agent" || cmd === "send") sent = String(args?.text ?? "");
    return null;
  },
  transformCallback: () => 0,
};
const box = (): HTMLElement =>
  composerFormat.on ? document.querySelector<HTMLElement>(".composer .cm-content")! : document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
const draft = () => readDraft("chat-a").text;
function paste(text: string): boolean {
  const el = box();
  el.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (!ev.defaultPrevented) document.execCommand("insertText", false, text);
  return ev.defaultPrevented;
}
const type = (t: string) => {
  box().focus();
  document.execCommand("insertText", false, t);
};
const cmdZ = () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
const J = (t: string) => JSON.stringify(t.length > 120 ? t.slice(0, 60) + "…" + t.slice(-50) : t);

const PY = `def fib(n: int) -> int:
\t# naïve → café 日本 — a comment with wide glyphs and a long tail that should wrap past the edge of the box for sure, yes, really long
    a, b = 0, 1   
    for _ in range(n):
        a, b = b, a + b  # «swap» ✓
    return a`;

async function start(): Promise<void> {
  composerFormat.on = q.get("f") === "1";
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  await settle();
}

async function drift(opaque: boolean): Promise<void> {
  await start();
  type("Look at this:\n");
  await settle();
  paste(PY);
  await settle();
  const ta = box() as HTMLTextAreaElement;
  const mirror = document.querySelector<HTMLElement>(".ta-mirror")!;
  // The layer's text, drawn plain in an identical layer: where does each line end?
  const plain = mirror.cloneNode(true) as HTMLElement;
  for (const l of plain.querySelectorAll(".ml")) l.textContent = l.textContent;
  plain.style.visibility = "hidden";
  mirror.parentElement!.append(plain);
  const ends = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".ml")].map((l) => {
      const r = document.createRange();
      r.selectNodeContents(l);
      const rs = r.getClientRects();
      const last = rs[rs.length - 1];
      return { h: l.offsetHeight, right: last ? Math.round(last.right * 10) / 10 : 0 };
    });
  const a = ends(mirror);
  const b = ends(plain);
  const diffs = a.map((x, i) => Math.max(Math.abs(x.h - b[i].h), Math.abs(x.right - b[i].right)));
  plain.remove();
  const it = [...mirror.querySelectorAll(".hljs-comment")].map((e) => getComputedStyle(e).fontStyle);
  say(`drift: ${a.length} layer lines; comment font-style ${it.join(",")}; max line-end/height diff vs plain = ${Math.max(...diffs).toFixed(1)} px (per line ${diffs.map((d) => d.toFixed(1)).join(" ")}); layer height ${mirror.scrollHeight} vs textarea ${ta.scrollHeight}`);
  if (opaque) {
    ta.style.color = "rgba(255,0,0,0.85)";
    say("textarea glyphs drawn red over the layer: any colour fringe = drift");
  }
}

async function undo(): Promise<void> {
  await start();
  type("hello ");
  await settle();
  const raw = "def f(x):\n    return x + 1\n\nprint(f(2))";
  paste(raw);
  await settle();
  say(`after paste: ${J(draft())}`);
  type("X");
  await settle();
  say(`typed X: ${J(draft())}`);
  for (let i = 1; i <= 4; i++) {
    const before = draft();
    cmdZ();
    await settle();
    // What the menu's Undo does when the composer does not take it: the box's own undo.
    if (before === draft()) document.execCommand("undo");
    await settle();
    say(`undo ${i}: ${J(draft())}`);
  }
  for (let i = 1; i <= 4; i++) {
    document.execCommand("redo");
    await settle();
    say(`redo ${i}: ${J(draft())}`);
  }
  // Second run: paste, then composer ⌘Z, then native undo twice.
  setDraftText("chat-a", "");
  await settle();
  type("abc ");
  await settle();
  paste(raw);
  await settle();
  cmdZ();
  await settle();
  say(`B: ⌘Z after paste: ${J(draft())}`);
  document.execCommand("undo");
  await settle();
  say(`B: native undo: ${J(draft())}`);
  document.execCommand("undo");
  await settle();
  say(`B: native undo 2: ${J(draft())}`);
}

async function bytes(): Promise<void> {
  await start();
  const cases: [string, string, number | null][] = [
    ["crlf+tabs+trailing", "def f(x):\r\n\treturn x  \r\n\r\nprint(f(1))\t\r\n", null],
    ["mid-line", "for (int i = 0; i < n; i++) {\n    sum += i;\n}", 5],
    ["leading blank+indent", "\n\n    if x:\n        y = 1\n    return y", null],
  ];
  for (const [name, raw, at] of cases) {
    setDraftText("chat-a", "");
    await settle();
    type("prose before and after");
    await settle();
    const ta = box() as HTMLTextAreaElement;
    if (at !== null) ta.selectionStart = ta.selectionEnd = at;
    const took = paste(raw);
    await settle();
    const d = draft();
    const norm = raw.replace(/\r\n?/g, "\n");
    const m = /```(\w*)\n([\s\S]*?)\n```/.exec(d);
    const body = m?.[2] ?? null;
    say(`${name}: fenced=${took} lang=${m?.[1]} body==paste(LF)=${body === norm} body==paste minus trailing \\n=${body === norm.replace(/\n+$/, "")} draft=${J(d)}`);
  }
  sent = null;
  const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent?.trim() === "Send");
  const before = draft();
  b?.click();
  await settle(200);
  say(`Send: handed == box: ${sent === before} (${sent === null ? "nothing sent" : sent.length + " chars"})`);
}

async function perf(): Promise<void> {
  await start();
  const line = (i: number) => `    total += compute(i, "x${i}")  # step ${i} {i}`;
  const body = Array.from({ length: Number(q.get("lines") ?? 2000) }, (_, i) => line(i)).join("\n");
  const d = q.get("d") ?? "fence";
  const text = d === "plain" ? "intro\ndef run():\n" + body + "\nafter" : d === "quote" ? "intro\n> a quote\ndef run():\n" + body + "\nafter" : "intro\n```python\ndef run():\n" + body + "\n```\nafter";
  setDraftText("chat-a", text);
  await settle();
  flushSync();
  const el = box() as HTMLTextAreaElement;
  el.focus();
  const mid = text.indexOf("step 1000");
  if (el instanceof HTMLTextAreaElement) el.selectionStart = el.selectionEnd = mid;
  else {
    // CodeMirror: place by its own API through a click-free route.
    const sel = window.getSelection()!;
    sel.removeAllRanges();
  }
  const view = composerFormat.on ? EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!) : null;
  const insert = (at: number, ch: string) => {
    if (view) view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" });
    else document.execCommand("insertText", false, ch);
  };
  const times: number[] = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    insert(mid + i, "a");
    flushSync();
    // layout, as the frame would
    void document.body.offsetHeight;
    times.push(performance.now() - t0);
    await yieldNow();
  }
  const outside = [] as number[];
  if (el instanceof HTMLTextAreaElement) el.selectionStart = el.selectionEnd = 3;
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    insert(3 + i, "b");
    flushSync();
    void document.body.offsetHeight;
    outside.push(performance.now() - t0);
    await yieldNow();
  }
  const { layerLines, findFences } = await import("../src/lib/codeDetect");
  let t1 = performance.now();
  layerLines(draft());
  const ll = performance.now() - t1;
  t1 = performance.now();
  findFences(draft());
  const ff = performance.now() - t1;
  t1 = performance.now();
  (document.querySelector(".ta-mirror") as HTMLElement | null)?.querySelectorAll("[data-fence]").forEach((e) => void (e as HTMLElement).offsetTop);
  const lay = performance.now() - t1;
  say(`layerLines(now) ${ll.toFixed(1)} ms; findFences ${ff.toFixed(1)} ms; offsetTop ${lay.toFixed(1)} ms`);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1);
  say(`perf [${d}, ${q.get("lines") ?? 2000} lines] ${composerFormat.on ? "formatted" : "plain"} box, 2,000-line fenced draft: keystroke inside the block median ${med(times)} ms (max ${Math.max(...times).toFixed(1)}); outside median ${med(outside)} ms (max ${Math.max(...outside).toFixed(1)}); draft grew ${draft().length - text.length}`);
}

async function long(): Promise<void> {
  await start();
  const body = Array.from({ length: 700 }, (_, i) => `    x${i} = compute(${i}, y)`).join("\n");
  const raw = "def big():\n" + body;
  const took = paste(raw);
  await settle();
  const offer = document.querySelector(".paste-offer")?.textContent?.trim() ?? "none";
  say(`long code paste (${raw.split(/\s+/).length} words): fenced=${took} fence in draft=${draft().includes("```")} offer=${J(offer)}`);
}

const run: Record<string, () => Promise<void>> = { drift: () => drift(false), opaque: () => drift(true), undo, bytes, perf, long };
void (run[s] ?? run.drift)().catch((e) => say(`error: ${String(e)}`));
