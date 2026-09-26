// Backlogs 237, 238 harness — see asidetab.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, unmount, flushSync } from "svelte";
import AsideView from "../src/lib/AsideView.svelte";
import { app, draftAside, switchAside } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const n = Number(q.get("turns") ?? "3");
const scroll = Number(q.get("scroll") ?? "0");
const mode = q.get("mode") ?? "";

app.sessions = [
  { id: "chat-a", title: "Stuart 9 deep thoughts" },
  { id: "chat-b", title: "Another chat" },
] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
app.activeSessionId = "chat-a";

const para =
  "This seems incredibly interesting. The watermark advances only on success, so a unit that fails is redone rather than skipped; redoing is cheap and skipping is not. ";
const a = draftAside({ text: "The watermark advances only on success.", role: "assistant", ordinal: 2 }, null)!;
if (q.get("draft") !== "1") {
  a.draft = false;
  for (let i = 0; i < n; i++) {
    const asking = q.get("asking") === "1" && i === n - 1;
    const answer = Array.from({ length: 4 }, (_, k) => `Paragraph ${k + 1} of answer ${i + 1}. ${para.repeat(2)}`).join("\n\n");
    a.turns.push({
      seq: i + 1,
      question: `Question ${i + 1}: why does it advance only on success?`,
      partial: asking ? answer.slice(0, 200) : answer,
      answer: asking ? null : answer,
      error: null,
      cancelled: false,
      cacheRead: 0,
    });
  }
}
if (q.get("unsent")) a.unsent = q.get("unsent")!;
if (q.get("open") === "0") {
  switchAside("chat-b");
  app.activeSessionId = "chat-b";
}

const props = { session: "chat-a", thread: a.id };
let comp = mount(AsideView, { target: root, props });
flushSync();

const sc = () => document.querySelector<HTMLElement>(".aside-view-scroll") ?? document.querySelector<HTMLElement>(".aside-view")!;
const lines: string[] = [];
const say = (label: string) => {
  const el = sc();
  lines.push(`${label}: scrollTop ${Math.round(el.scrollTop)} of ${el.scrollHeight - el.clientHeight}`);
};
function rectOf(sel: string): string {
  const e = document.querySelector(sel);
  if (!e) return "absent";
  const r = e.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  const shown = r.top >= rr.top - 0.5 && r.bottom <= rr.bottom + 0.5 && r.height > 0;
  return `${Math.round(r.top)}..${Math.round(r.bottom)} ${shown ? "in view" : "OUT OF VIEW"}`;
}

setTimeout(() => {
  if (scroll > 0) {
    const el = sc();
    el.scrollTop = scroll;
    el.dispatchEvent(new Event("scroll"));
    say("scrolled");
    if (mode === "remount") {
      unmount(comp);
      flushSync();
      comp = mount(AsideView, { target: root, props });
      flushSync();
    } else if (mode === "switch") {
      switchAside("chat-b");
      app.activeSessionId = "chat-b";
      flushSync();
      say("other chat open");
      switchAside("chat-a");
      app.activeSessionId = "chat-a";
      flushSync();
    }
  }
  setTimeout(() => {
    if (scroll > 0) say(mode ? `after ${mode}` : "after");
    const box = document.querySelector("textarea");
    lines.push(
      `root 0..${Math.round(root.getBoundingClientRect().bottom)} · box ${rectOf("textarea")} · send ${rectOf(".aside-view-send")} · ` +
        `follow-up button ${rectOf(".aside-view-row button")} · box text "${box ? (box as HTMLTextAreaElement).value.slice(0, 30) : ""}"`,
    );
    const note = document.querySelector(".aside-view-foot-note");
    if (note) lines.push(`foot note: ${note.textContent?.trim()}`);
    cap.textContent = lines.join("\n");
  }, 150);
}, 300);
