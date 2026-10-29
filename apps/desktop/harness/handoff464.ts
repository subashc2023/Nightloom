// Item 464 — the tagged hand-off on the real Sidebar + Transcript + Composer (see handoff464.html).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";
import { noteThread } from "../src/lib/handoff.svelte";
import { noteThreadHandoff } from "../src/lib/threadHandoff.svelte";
import type { SessionEvent } from "../src/lib/types";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "card";
const tag = document.getElementById("tag")!;
document.head.insertAdjacentHTML("beforeend", "<style>*{backdrop-filter:none!important}</style>");

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SLUG = "stuart-brainstorm";
const PARENT = "c3d2e4f5-s9";
const HANDED =
  "Read the Queue in thread.md and the newest log.md entry. Q-07 (does the proxy need the full replay set?) is answered: no — 120 rounds were enough in the cut run. Start with Q-08: size the replay set for the second evaluator, using the numbers in .agents/notes/replay-cut-2026-10-28.md, and say which rounds you would drop before running anything.";
const REPLY =
  "Updated `.agents/threads/stuart-brainstorm/thread.md`: Q-07 moved to done with the cut-run numbers (C-31, C-32), Start here rewritten to 412 words, and one dated paragraph appended to log.md.\n\n" +
  `<handoff>\n${HANDED}\n</handoff>\n`;

const sessions = [
  { id: PARENT, title: "Stuart 9 — what counts as a round", mode: "normal", kind: "build", modified: ago(3), thread: SLUG },
  { id: "f6a5b7c8-s8", title: "Stuart 8 — the replay eval", mode: "normal", kind: "build", modified: ago(1500), thread: SLUG },
  { id: "b2e1d3c4-legal", title: "Lease clause 7 negotiation", mode: "normal", kind: "build", modified: ago(25) },
];
const threads = [
  { slug: SLUG, title: "Stuart brainstorm (Deep Thoughts)", status: "As of 2026-10-28, 11:40 PM — Q-07 answered; next: size the replay set", touched: "2026-10-28", start_here_words: 412, tokens: 5200, flags: 0 },
];
// handoff.json, in memory.
let saved: { text: string; from: string; taken: string | null } | null = null;
const calls: string[] = [];
let made = 0;
(window as unknown as { __stub: (c: string, a: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, args = {}) => {
  calls.push(cmd);
  switch (cmd) {
    case "list_threads":
      return threads;
    case "list_sessions":
      return sessions;
    case "turn_usage":
      return [];
    case "new_session":
      return { mode: "normal" };
    case "set_chat_thread":
      return [
        { event: "session_created", id: `c-new${++made > 1 ? made : ""}`, at: ago(0) },
        { event: "thread", thread: args.thread, at: ago(0) },
      ];
    case "save_thread_handoff":
      if (!saved || saved.text !== args.text || saved.from !== args.fromChat) saved = { text: String(args.text), from: String(args.fromChat), taken: null };
      return null;
    case "take_thread_handoff": {
      if (!saved || saved.taken) return null;
      saved.taken = String(args.chat);
      return saved.text;
    }
    case "connect":
      throw "harness: no engine is connected (the box is what is being shown)";
    default:
      return null;
  }
};

const at = ago(4);
const events: SessionEvent[] = [
  { event: "session_created", id: PARENT, at: ago(80) } as SessionEvent,
  { event: "thread", thread: SLUG, at: ago(80) } as unknown as SessionEvent,
  { event: "user_message", text: "Wrap up this chat for the next one in the thread.", at } as SessionEvent,
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text: REPLY }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 }, at } as SessionEvent,
];

async function main() {
  composerFormat.on = false;
  app.project = { id: "p1", name: "Value Generalization", root: "/Users/you/research/value-generalization" } as unknown as typeof app.project;
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.activeSessionId = PARENT;
  app.events = events;
  noteThread(PARENT, SLUG);
  const { default: Sidebar } = await import("../src/lib/Sidebar.svelte");
  const { default: Transcript } = await import("../src/lib/Transcript.svelte");
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Sidebar, { target: document.getElementById("side")! });
  mount(Transcript, { target: document.getElementById("tr")!, props: {} });
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r, 400));
  // The reply's turn end, as `sendAgent` runs it: the block is kept on the thread.
  if (view !== "none") noteThreadHandoff(PARENT, events);
  const plus = () => document.querySelector<HTMLButtonElement>(`.tg-new[aria-label="New chat in the thread ${SLUG}"]`);
  const settle = async () => {
    for (let i = 0; i < 40 && !String(app.activeSessionId).startsWith("c-new"); i++) await new Promise((r) => setTimeout(r, 25));
    await tick();
    await new Promise((r) => setTimeout(r, 200));
  };
  if (view === "plus" || view === "none") {
    plus()?.click();
    await settle();
  } else if (view === "again") {
    plus()?.click();
    await settle();
    // Back to the parent, then + again.
    app.activeSessionId = PARENT;
    app.events = events;
    await tick();
    sessions.unshift({ id: "c-new", title: "New chat", mode: "normal", kind: "build", modified: ago(0), thread: SLUG });
    plus()?.click();
    for (let i = 0; i < 40 && app.activeSessionId !== "c-new2"; i++) await new Promise((r) => setTimeout(r, 25));
    await settle();
  }
  await new Promise((r) => setTimeout(r, Number(q.get("wait") ?? 900)));
  const card = document.querySelector(".transcript .handoff-card");
  const pre = card?.querySelector("pre.handoff-text");
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  const box = app.activeSessionId ? readDraft(app.activeSessionId).text : "";
  const r = (e: Element | null | undefined) => (e ? e.getBoundingClientRect() : null);
  const res = {
    view,
    chat: app.activeSessionId,
    card: !!card,
    cardLabel: card?.querySelector(".handoff-label")?.textContent ?? null,
    cardCopyButton: !!pre?.querySelector(":scope > .code-copy"),
    cardTextIsHanded: (pre?.querySelector("code")?.textContent ?? "") === HANDED,
    rawTagsVisible: /<\/?handoff>/.test(document.querySelector(".transcript")?.textContent ?? ""),
    cardWidth: r(card)?.width ?? null,
    preScrollsSideways: pre ? pre.scrollWidth > pre.clientWidth + 1 : null,
    boxEqualsHanded: box === HANDED,
    textareaEqualsHanded: ta?.value === HANDED,
    boxLength: box.length,
    sentAnything: calls.filter((c) => /send|agent_turn|submit/.test(c)),
    calls: [...new Set(calls)].filter((c) => /handoff|thread|session/.test(c)),
  };
  const { calls: _c, ...shown } = res;
  tag.textContent = Object.entries(shown).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ");
  (window as unknown as { __res: unknown }).__res = res;
}
void main();
