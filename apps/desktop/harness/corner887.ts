// Item 887 harness — see corner887.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import ChapterContents from "../src/lib/ChapterContents.svelte";
import AsidesList from "../src/lib/AsidesList.svelte";
import { app, type Aside } from "../src/lib/state.svelte";
import { pastAsides } from "../src/lib/asideHistory.svelte";
import { storedAsideOf } from "../src/lib/asides";
import { applyLayout, layout } from "../src/lib/layout.svelte";
import type { ShownChapter } from "../src/lib/chapters";

const q = new URLSearchParams(location.search);
const classic = q.get("classic") === "1";
if (classic) {
  layout.value = "classic";
  applyLayout("classic");
}
const root = document.getElementById("root")!;
root.style.setProperty("--w", `${q.get("w") ?? 960}px`);
const cap = document.getElementById("cap")!;
const chat = "chat-887";
app.activeSessionId = chat;

const thread = (id: number, question: string): Aside => ({
  id,
  quote: { text: "The watermark advances only on success.", role: "assistant", ordinal: 2 },
  draft: false,
  turns: [{ seq: id, question, partial: "Because a skipped unit is lost.", answer: "Because a skipped unit is lost.", error: null, cancelled: false, cacheRead: 0 }],
  anchor: null,
});
if (q.get("asides") !== "0") {
  app.asides = [thread(1, "Why does the watermark advance only on success?")];
  pastAsides.byChat[chat] = [{ key: "k1", closedAt: Date.now() - 3_600_000, thread: storedAsideOf(thread(9, "Old runner?"))! }];
}

const ch = (key: string, kind: string, index: number, title: string): ShownChapter =>
  ({ key, kind, index, anchor: index, title, at: null, shown: title, renamed: false, removed: false }) as unknown as ShownChapter;
const chapters = q.get("chapters") === "0" ? [] : [ch("start:0", "start", 0, "Start"), ch("mark:4", "mark", 4, "Implementation")];

// The transcript: a scroller filling a positioned box, as in App's .content.
const vp = document.createElement("div");
vp.className = "transcript";
vp.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:16px 40px;color:var(--ink);font:14px var(--sans)";
vp.innerHTML = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1}: the watermark advances only on success.</p>`).join("");
root.appendChild(vp);
mount(AsidesList, { target: root, props: { viewport: vp, onbring: () => {} } });
mount(ChapterContents, { target: root, props: { chapters, chat, viewport: vp, classic, onjump: () => {} } });
flushSync();

setTimeout(() => {
  const pill = document.querySelector(".asides-pill")?.getBoundingClientRect();
  const ct = document.querySelector(".ct-btn")?.getBoundingClientRect();
  const fmt = (r?: DOMRect) => (r ? `${Math.round(r.left)}–${Math.round(r.right)} x ${Math.round(r.top)}–${Math.round(r.bottom)}` : "none");
  const overlap = pill && ct && pill.left < ct.right && ct.left < pill.right && pill.top < ct.bottom && ct.top < pill.bottom;
  cap.textContent = `${classic ? "Classic" : "Jarvis"} w=${q.get("w") ?? 960}  pill ${fmt(pill)}  contents ${fmt(ct)}  overlap=${overlap ? "YES" : "no"}`;
}, 300);
