// Item 323 harness — see usage323.html. The real Transcript, its store and the footer; only the Tauri bridge is
// faked: `turn_usage` returns the lines the backend would have written for this fixture chat.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
import type { SessionEvent } from "../src/lib/types";
import type { TurnUsageLine } from "../src/lib/replyUsage";

const cap = document.getElementById("cap")!;
const at = new Date(Date.now() - 5 * 60_000).toISOString();
const t0 = Date.now() - 30 * 60_000;
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (text: string, input: number, output: number): SessionEvent =>
  ({
    event: "assistant_message",
    model: "claude-opus-5-5",
    blocks: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: input, output_tokens: output },
    at,
  }) as SessionEvent;
const line = (target: number, fh: [number, number], wk: [number, number], over: Partial<TurnUsageLine> = {}): TurnUsageLine => ({
  target,
  started_at_ms: t0,
  ended_at_ms: t0 + 60_000,
  five_hour: { start: fh[0], end: fh[1] },
  seven_day: { start: wk[0], end: wk[1] },
  shared: false,
  cost_usd: 0.42,
  est: null,
  start_at_ms: t0 + 2_000,
  end_at_ms: t0 + 120_000,
  ...over,
});
const LINES: TurnUsageLine[] = [
  line(1, [41, 45], [12, 13]),
  line(3, [45, 52], [13, 14], { shared: true }),
  line(5, [52, 52], [14, 14], { est: { five_hour: 0.34, seven_day: 0.04, replies: 12 } }),
];
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(`${cmd}${args?.session ? `(${String(args.session)})` : ""}`);
    if (cmd === "turn_usage") return LINES;
    return null;
  },
  transformCallback: () => 0,
};

app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
app.activeSessionId = "s";
app.events = [
  user("Fix the Enter key for Japanese input."),
  reply("Done: Enter that commits the word no longer sends.", 25_593, 812),
  user("And run the whole suite."),
  reply("Ran it while another chat was working: all green.", 26_784, 240),
  user("Small question."),
  reply("A short answer.", 27_000, 40),
  user("One more."),
  reply("This reply has no reading yet.", 27_100, 30),
];
mount(Transcript, { target: document.getElementById("root")!, props: {} });
flushSync();
setTimeout(() => {
  const rows = [...document.querySelectorAll<HTMLElement>(".footer")].map((f) => {
    const p = f.querySelector<HTMLElement>(".meta.plan");
    return p ? p.textContent!.trim() : "(none)";
  });
  const first = document.querySelector<HTMLElement>(".meta.plan");
  cap.textContent = `reply footers' plan figures: ${JSON.stringify(rows)}\ncalls: ${calls.filter((c) => c.startsWith("turn_usage")).join(", ")}\nfirst one's hover text exists: ${!!first}`;
}, 400);
