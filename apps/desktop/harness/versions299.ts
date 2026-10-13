// Item 299 harness — see versions299.html. Fixtures only.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
import { versions } from "../src/lib/versions.svelte";
import type { SessionEvent } from "../src/lib/types";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const v = q.get("v") ?? "sidebar";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const t = (min: number) => new Date(Date.now() - (120 - min) * 60_000).toISOString();
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const reply = (text: string, at: string): SessionEvent =>
  ({ event: "assistant_message", model: "opus", blocks: [{ type: "text", text }], stop_reason: "end_turn", usage, at }) as unknown as SessionEvent;
const user = (text: string, at: string): SessionEvent => ({ event: "user_message", text, at });
const created = (id: string, at: string, parent?: string): SessionEvent =>
  ({ event: "session_created", id, at, ...(parent ? { forked_from: { session: parent, index: 3 } } : {}) }) as SessionEvent;

const prefix = [user("What does the watermark do?", t(1)), reply("It records progress; it advances only on success.", t(2))];
const logs: Record<string, SessionEvent[]> = {
  o: [created("o", t(0)), ...prefix, user("Why does it advnace only on sucess?", t(3)), reply("Because a skipped unit is lost forever.", t(4))],
  f: [created("f", t(10), "o"), ...prefix, user("Why does it advance only on success?", t(11)), reply("Because a skipped unit would be lost; a redone one is cheap.", t(12))],
  g: [created("g", t(20), "o"), ...prefix, user("Why does it advance only on success — and what if a unit half-finishes?", t(21)), reply("A half-finished unit is committed WIP and redone.", t(22))],
};
(window as unknown as { __stub: (c: string, a: { id?: string }) => Promise<unknown> }).__stub = async (cmd, args) => {
  if (cmd === "peek_session" && args?.id) return logs[args.id] ?? [];
  return null;
};

const row = (id: string, title: string, min: number, parent?: string) => ({
  id,
  path: `/fixture/${id}.jsonl`,
  title,
  first_user: "What does the watermark do?",
  user_turns: 2,
  modified: t(min),
  ...(parent ? { forked_from: { session: parent, index: 3 } } : {}),
});
app.sessions = [
  row("x", "Release notes for 0.9", 40),
  row("g", "Watermark rule (third try)", 22, "o"),
  row("f", "Watermark rule, typo fixed", 12, "o"),
  row("o", "Watermark rule", 4),
  row("y", "Sidebar polish", 2),
] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code", workspace: "/tmp/w", folders: [], model: "opus" } as unknown as typeof app.connection;
if (q.get("main") === "1") versions.map = { o: "f" };

const chat = q.get("chat") ?? "f";
app.activeSessionId = chat;
app.events = logs[chat];
app.tabs = {
  panes: [{ id: "p1", tabs: [{ id: "t1", content: { kind: "chat", session: chat } }], active: "t1" }],
  focused: "p1",
} as unknown as typeof app.tabs;

async function main() {
  if (v === "sidebar") {
    try {
      localStorage.setItem("nightloom.forksOpen", JSON.stringify(["o", "f"]));
    } catch {
      /* harness */
    }
    root.style.setProperty("--w", "300px");
    root.style.setProperty("--h", "760px");
    mount(Sidebar, { target: root });
  } else {
    root.style.setProperty("--w", "760px");
    root.style.setProperty("--h", "520px");
    mount(Transcript, { target: root });
  }
  flushSync();
  await wait(400);
  if (v === "sidebar" && q.get("menu") === "1") {
    const items = [...document.querySelectorAll<HTMLElement>(".session-item")];
    const target = items.find((e) => e.textContent?.includes(q.get("main") === "1" ? "Watermark rule" : "typo fixed"));
    target?.querySelector<HTMLElement>(".more-btn")?.click();
    flushSync();
  }
  await wait(150);
  const lines: string[] = [];
  if (v === "sidebar") {
    for (const e of document.querySelectorAll(".session-item"))
      lines.push(`${e.classList.contains("fork") ? "  fork" : "row  "} ${e.querySelector(".snippet")?.textContent?.trim()}${e.classList.contains("active") ? "  [lit]" : ""}`);
    const menu = document.querySelector(".row-menu");
    if (menu) lines.push(`menu: ${[...menu.querySelectorAll("button")].map((b) => b.textContent!.replace(/\s+/g, " ").trim()).join(" | ")}`);
  } else {
    const vs = [...document.querySelectorAll(".versions")].map((e) => e.textContent!.replace(/\s+/g, " ").trim());
    lines.push(`versions: ${vs.join(" ; ") || "none"}`);
  }
  cap.textContent = lines.join("\n");
}
void main();
