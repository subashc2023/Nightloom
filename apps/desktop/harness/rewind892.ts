// Item 892 harness — see rewind892.html. A message sent with two passage
// comments is put in the log, then rewound by the real `rewindTo`.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app, rewindTo } from "../src/lib/state.svelte";
import { draftComments, readDraft, setDraftText } from "../src/lib/drafts.svelte";
import { sendWithComments } from "../src/lib/sentComments";
import { setLayout } from "../src/lib/layout.svelte";

const h = new URLSearchParams(location.hash.slice(1));
const which = h.get("case") ?? "empty";
const cap = document.getElementById("cap")!;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "rewind" ? [] : null),
  transformCallback: () => 0,
};

async function main(): Promise<void> {
  setLayout(h.get("layout") === "classic" ? "classic" : "filament");
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { draftKey } = await import("../src/lib/drafts.svelte");
  const key = draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread);
  const text = sendWithComments(
    [
      { id: 1, quote: "The ripple delay grows linearly with the number of bits.", source: "reply", ordinal: 2, note: "so all of the adders wait on the carry?" },
      { id: 2, quote: "Cout = 1 carries out of the top bit", source: "reply", ordinal: 2, note: "what does Cout mean here" },
    ],
    "and can you show a 4-bit example?",
  ).trim();
  (app as unknown as { events: unknown[] }).events = [{ event: "user_message", text, at: "2026-11-19T20:00:00Z" }];
  if (which === "kept") setDraftText(key, "something I was typing");
  await rewindTo(0);
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  flushSync();
  const d = readDraft(key);
  cap.textContent = `case=${which} · box text: ${JSON.stringify(d.text)} · comments: ${draftComments(key).length} (${draftComments(key).map((c) => JSON.stringify(c.note)).join(", ")}) · chips on screen: ${document.querySelectorAll(".comment-chip").length}`;
}
void main();
