// Backlog 347 harness — see away347.html. Only the Tauri bridge is faked; the
// window's focus is set through `setWindowFocused`, what Tauri's
// `onFocusChanged` calls in the app.
import "../src/app.css";
import { mount, flushSync } from "svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
import { presence, setWindowFocused } from "../src/lib/away.svelte";
import type { SessionEvent } from "../src/lib/types";

const cap = document.getElementById("cap")!;
const at = new Date(Date.now() - 5 * 60_000).toISOString();
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
// An offscreen WKWebView may report itself hidden, which reads as away; the
// harness holds it visible so the window's focus is the only variable.
const shownState = document.visibilityState;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
app.activeSessionId = "s";
const evs: SessionEvent[] = [];
for (let i = 0; i < 12; i++) {
  evs.push(user(`Question ${i}`));
  evs.push(reply(`Answer ${i}. `.repeat(30)));
}
evs.push(user("Write me a long answer."));
app.events = evs;
mount(Transcript, { target: document.getElementById("root")!, props: {} });
flushSync();

const v = () => document.querySelector<HTMLElement>(".transcript")!;
const top = () => Math.round(v().scrollTop);
const gap = () => Math.round(v().scrollHeight - v().scrollTop - v().clientHeight);
const jump = () => !!document.querySelector(".jump-down.shown");
// Microtasks, not timers: an offscreen WKWebView throttles setTimeout to a
// second or more, and the transcript's follow runs on a tick (a microtask).
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => queueMicrotask(r));
};
let words = "";
async function stream(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    words += `Streaming paragraph ${i}. ${"More of the reply. ".repeat(12)}\n\n`;
    app.live = { segments: [{ kind: "text", text: words }] } as typeof app.live;
    app.liveVersion++;
    flushSync();
    await settle();
  }
  await settle();
}

const lines: string[] = [`document.visibilityState as loaded: ${shownState} (held "visible")`];
window.addEventListener("unhandledrejection", (e) => (cap.textContent = lines.join("\n") + "\nrejection: " + String(e.reason)));
const say = (l: string) => {
  lines.push(l);
  cap.textContent = lines.join("\n");
};
setTimeout(async () => {
  app.busy = true;
  setWindowFocused(true);
  const t0 = top();
  await stream(6);
  say(`A focused, pinned: scrollTop ${t0} -> ${top()}, gap from foot ${gap()}px (follows: gap 0)`);

  setWindowFocused(false);
  const t1 = top();
  await stream(10);
  const t2 = top();
  say(`B away (away=${presence.away}): scrollTop ${t1} -> ${t2}, gap ${gap()}px, jump-down shown ${jump()}`);

  setWindowFocused(true);
  await settle();
  const t3 = top();
  await stream(4);
  say(`C refocused (away=${presence.away}): scrollTop on return ${t3}, after 4 more deltas ${top()}, gap ${gap()}px, jump-down shown ${jump()}`);
  say(t2 === t1 && t3 === t1 && top() === t1 ? "RESULT: the view held at his place while away and after refocus" : "RESULT: the view moved");
}, 600);
