// Item 674 harness — see aside674.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import AsideView from "../src/lib/AsideView.svelte";
import { app, draftAside, type Segment } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const n = Number(q.get("turns") ?? "4");
app.sessions = [{ id: "chat-a", title: "Midterm prep" }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code", model: "claude-opus-5-5", contextLimit: 1_000_000 } as unknown as typeof app.connection;
app.activeSessionId = "chat-a";

const para =
  "The watermark advances only on success, so a unit that fails is redone rather than skipped; redoing is cheap and skipping is not. ";
const a = draftAside({ text: "The watermark advances only on success.", role: "assistant", ordinal: 2 }, null)!;
a.draft = false;
const first = q.get("long") === "1"
  ? "Why is the stack built on one queue instead of two, and what would break in the amortised analysis if the transfer happened on every push rather than only when the output side runs dry?"
  : "Stack on one queue";
for (let i = 0; i < n; i++) {
  const asking = q.get("asking") === "1" && i === n - 1;
  const stopped = q.get("stopped") === "1" && i === n - 1;
  const answer = Array.from({ length: 3 }, (_, k) => `Paragraph ${k + 1} of answer ${i + 1}. ${para.repeat(2)}`).join("\n\n");
  const segments: Segment[] = [
    { kind: "thinking", text: `Thinking about question ${i + 1}: the unit either lands or it does not.`, done: !asking },
    { kind: "tool", call: { id: `t${i}`, name: "Read", input: { file_path: "state/watermark.json" }, result: { content: '{"unit": 41}', is_error: false } } },
    { kind: "text", text: asking ? answer.slice(0, 220) : stopped ? answer.slice(0, 300) : answer },
  ];
  a.turns.push({
    seq: i + 1,
    question: i === 0 ? first : `Question ${i + 1}: why does it advance only on success?`,
    partial: asking ? answer.slice(0, 220) : answer,
    answer: asking || stopped ? null : answer,
    error: q.get("stopped") === "1" && i === n - 2 ? "The answer could not be read back." : null,
    cancelled: stopped,
    cacheRead: 188_342,
    model: "claude-opus-5-5",
    usage: asking ? undefined : { input_tokens: 190_000 + i * 900, output_tokens: 640, cache_read_tokens: 188_342 },
    at: asking ? undefined : new Date(Date.now() - (n - i) * 60_000).toISOString(),
    tookMs: 9_000,
    startedAt: asking ? Date.now() - 12_000 : undefined,
    heardAt: asking ? Date.now() - 1_000 : undefined,
    phase: asking ? "running" : undefined,
    segments,
  });
}
mount(AsideView, { target: document.getElementById("root")!, props: { session: "chat-a", thread: a.id } });
flushSync();
const say = () => {
  const t = document.querySelector<HTMLElement>(".transcript");
  const s = (sel: string) => document.querySelectorAll(sel).length;
  document.getElementById("cap")!.textContent =
    q.get("cap") === "1" && t
      ? `transcript ${t.clientWidth}x${t.clientHeight} scroll ${Math.round(t.scrollTop)}/${t.scrollHeight - t.clientHeight} · turns ${s(".transcript [data-turn]")} · thinking rows open ${s('.transcript [aria-expanded="true"]')} · canvas ${s("canvas.dot-field")} dotfield ${t.classList.contains("dotfield")} · rail ${s("nav, .navigator")} · jump ${s(".jump-down")} · aside-thread ${s(".aside-thread")}`
      : "";
};
setTimeout(say, 400);
