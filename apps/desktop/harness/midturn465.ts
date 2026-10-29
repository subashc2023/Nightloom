// Item 465 — a mid-turn message as his bubble, on the real Transcript + Composer (see midturn465.html).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import { app, openChatKey } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { enqueueMessage, markInjected } from "../src/lib/drafts.svelte";
import { deliveredNotice } from "../src/lib/midTurn";
import type { SessionEvent } from "../src/lib/types";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "pending";
const tag = document.getElementById("tag")!;
document.head.insertAdjacentHTML("beforeend", "<style>*{backdrop-filter:none!important}</style>");
document.getElementById("side")!.remove();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
(window as unknown as { __stub: (c: string) => Promise<unknown> }).__stub = async (cmd) => {
  if (cmd === "turn_usage" || cmd.startsWith("list_")) return [];
  return null;
};
const CHAT = "chat-a";
const MSG = "Also check whether the second paper's ablation uses the same 120 rounds — if not, say so before you plot anything.";
const at = ago(2);
const live: { kind: string; [k: string]: unknown }[] = [
  { kind: "text", text: "Reading the cut-run numbers first, then I will size the replay set.\n\nThe first paper's table 3 puts the proxy's error at 4.1% with 120 rounds." },
  { kind: "tool", call: { id: "t1", name: "Bash", input: { command: "python3 scripts/replay_cut.py --rounds 120" }, status: "running" } },
];
if (view === "delivered") {
  live.push({ kind: "notice", text: deliveredNotice("after Bash", MSG), delivered: { text: MSG, after: "after Bash" } });
  live.push({ kind: "text", text: "Checked: the second paper's ablation uses 80 rounds, not 120, so its numbers are not comparable as they stand." });
}

async function main() {
  composerFormat.on = false;
  app.project = { id: "p1", name: "Value Generalization", root: "/Users/you/research/vg" } as unknown as typeof app.project;
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
  app.activeSessionId = CHAT;
  app.sessions = [{ id: CHAT, title: "Stuart 10 — replay set" }] as unknown as typeof app.sessions;
  app.events = [
    { event: "session_created", id: CHAT, at: ago(30) } as SessionEvent,
    { event: "user_message", text: "Size the replay set for the second evaluator.", at } as SessionEvent,
  ];
  app.busy = true;
  app.live = { segments: live } as unknown as typeof app.live;
  if (view !== "delivered") {
    const row = enqueueMessage(openChatKey(), MSG, []);
    markInjected(openChatKey(), row.id, { id: "u-1", turn: "turn:1" });
  }
  const { default: Transcript } = await import("../src/lib/Transcript.svelte");
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Transcript, { target: document.getElementById("tr")!, props: {} });
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r, 500));
  if (view === "arrive") document.querySelector<HTMLButtonElement>('[data-mt="arrive"]')?.click();
  if (view === "confirm") document.querySelector<HTMLButtonElement>('[data-mt="cancel"]')?.click();
  await tick();
  await new Promise((r) => setTimeout(r, Number(q.get("wait") ?? 700)));
  const b = document.querySelector(".midturn");
  const res = {
    view,
    bubble: b?.getAttribute("data-midturn") ?? null,
    state: b?.querySelector(".mt-state")?.textContent ?? null,
    buttons: Array.from(b?.querySelectorAll(".mt-actions button") ?? []).map((x) => x.textContent?.trim()),
    oldLine: (document.querySelector(".transcript")?.textContent ?? "").includes("Claude is reading it now"),
    opacity: b ? getComputedStyle(b.querySelector(".mt-bubble")!).opacity : null,
  };
  tag.textContent = Object.entries(res).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ");
}
void main();
