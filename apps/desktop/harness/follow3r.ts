// Wave 3 review harness — see follow3r.html. Only the Tauri bridge is faked.
import "../src/app.css";
import { mount, flushSync } from "svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
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
app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
app.activeSessionId = "s";
const evs: SessionEvent[] = [];
for (let i = 0; i < 20; i++) {
  evs.push(user(`Question ${i}`));
  evs.push(reply(`Answer ${i}. `.repeat(30)));
}
app.events = evs;
mount(Transcript, { target: document.getElementById("root")!, props: {} });
flushSync();
const gap = () => {
  const v = document.querySelector<HTMLElement>(".transcript")!;
  return Math.round(v.scrollHeight - v.scrollTop - v.clientHeight);
};
setTimeout(() => {
  const before = gap();
  const n = app.events.length;
  app.events.push(user("A new message, pushed in place. ".repeat(40)));
  setTimeout(() => {
    cap.textContent = `events ${n} -> ${app.events.length}; gap from the foot before push: ${before}px, after push: ${gap()}px`;
  }, 600);
}, 600);
