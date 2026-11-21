// Items 880 + 881 harness — see comment880.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { addComment, setCommentNote, setDraftText } from "../src/lib/drafts.svelte";
import { holdPassage } from "../src/lib/heldPassage.svelte";
import { setLayout } from "../src/lib/layout.svelte";

const h = new URLSearchParams(location.hash.slice(1));
const which = h.get("case") ?? "his";
const cap = document.getElementById("cap")!;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0 };

const HIS = "$$t_{\\text{ripple}} = N \\cdot t_{FA}$$";
const SECOND = "So SUM = 0010 (that's 2 ✓) and Cout = 1. Cout = $c_4$ carries out of the top bit";

async function main(): Promise<void> {
  setLayout(h.get("layout") === "classic" ? "classic" : "filament");
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  (app as unknown as { events: unknown[] }).events = [{ kind: "x" }];
  const { draftKey } = await import("../src/lib/drafts.svelte");
  const key = draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread);
  if (which === "held") {
    setDraftText(key, "why is this linear in N?");
    holdPassage(key, { text: `The ripple delay is ${HIS} for an N-bit adder.`, role: "assistant", ordinal: 2 } as never, null);
  } else {
    const a = addComment(key, HIS, "reply", 2);
    if (which === "two") {
      setCommentNote(key, a, "So this implies that all of the adders wait on the carry");
      addComment(key, SECOND, "reply", 2, "wait why is this fine, what does Cout mean here");
    }
  }
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  if (which === "his") document.querySelector<HTMLButtonElement>(".comment-open")?.click();
  flushSync();
  await tick();
  const q = document.querySelector(".comment-q, .held-q");
  const chips = [...document.querySelectorAll(".comment-chip")].map((c) => Math.round(c.getBoundingClientRect().left));
  cap.textContent = `case=${which} layout=${h.get("layout") ?? "jarvis"} · chip katex: ${q?.querySelectorAll(".katex").length ?? 0} · quote katex: ${document.querySelectorAll(".comment-quote .katex").length} · chip lefts: ${chips.join(", ")}`;
}
void main();
