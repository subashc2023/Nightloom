// W4-B harness for w3 review finding 5 — see flash5.html. Copied from block325.ts (item 325): the real NoteView and NoteEditPanel; only the
// Tauri bridge is faked (read_note returns the note's text).
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import NoteView from "../src/lib/NoteView.svelte";
import { app } from "../src/lib/state.svelte";
import { noteEditUi, setRequestDraft } from "../src/lib/noteEdit.svelte";
import { noteDraftKey } from "../src/lib/state.svelte";

const cap = document.getElementById("cap")!;
const NOTE = "# Memory\n\n" + Array.from({ length: 60 }, (_, i) => `- standing rule ${i}`).join("\n") + "\n";
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "read_note") return NOTE;
    if (cmd === "read_note_media") return null;
    return null;
  },
  transformCallback: () => 0,
};
app.openNote = { scope: "memory", name: "MEMORY.md" } as typeof app.openNote;
app.proposalReview = {
  scope: "memory",
  entry: {
    id: "p-1",
    proposal: {
      v: 1,
      at: "2026-10-08T08:00:00Z",
      target: { kind: "user" },
      why: "Three chats this week asked for times in 12-hour AM/PM.",
      text: NOTE.replace("- standing rule 3", "- times in 12-hour AM/PM"),
      from_dream: true,
    },
  },
};
noteEditUi.open = true;
mount(NoteView, { target: document.getElementById("root")!, props: {} });
flushSync();
setTimeout(async () => {
  try {
    setRequestDraft(noteDraftKey("memory", "MEMORY.md"), "we now use AM/PM times");
    await tick();
    const link = document.querySelector<HTMLButtonElement>(".blocked .link");
    const review = document.querySelector<HTMLElement>(".review");
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const on = () => !!review?.classList.contains("flash");
    const t0 = performance.now();
    const rows: string[] = [];
    const mark = (what: string) => rows.push(`${Math.round(performance.now() - t0)} ms ${what}: flash ${on()}`);
    link?.click();
    await tick();
    mark("first click");
    await wait(800);
    link?.click();
    await tick();
    mark("second click");
    await wait(600);
    mark("1.4 s after the first click (0.6 s after the second)");
    await wait(800);
    mark("2.2 s after the first (1.4 s after the second)");
    cap.textContent = ["w3 review finding 5 — the flash after two clicks 0.8 s apart", ...rows].join("\n");
  } catch (e) {
    cap.textContent = "harness error: " + String((e as Error)?.stack ?? e);
  }
}, 800);
