// Wave 3 review harness for item 325 — see block325.html. The real NoteView and NoteEditPanel; only the
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
  const line = document.querySelector<HTMLElement>(".blocked");
  const send = document.querySelector<HTMLButtonElement>("button.send");
  const link = document.querySelector<HTMLButtonElement>(".blocked .link");
  const review = document.querySelector<HTMLElement>(".review");
  const scroller = review?.parentElement;
  // Scroll the card's container away first, so the jump has somewhere to go.
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const topBefore = review ? Math.round(review.getBoundingClientRect().top) : null;
  link?.click();
  await tick();
  await new Promise((r) => setTimeout(r, 120));
  const focused = document.activeElement as HTMLElement | null;
  cap.textContent = [
    `blocked line: ${JSON.stringify(line?.textContent?.replace(/\s+/g, " ").trim() ?? null)}`,
    `Send disabled: ${send?.disabled} · link present: ${!!link}`,
    `after Show the proposal: card flash class: ${review?.classList.contains("flash")} · outline ${review ? getComputedStyle(review).outlineColor : "-"}`,
    `focused: ${focused?.tagName} "${focused?.textContent?.trim()}" inside card: ${!!(review && focused && review.contains(focused))} · card top ${topBefore} -> ${review ? Math.round(review.getBoundingClientRect().top) : null}`,
  ].join("\n");
  } catch (e) {
    cap.textContent = "harness error: " + String((e as Error)?.stack ?? e);
  }
}, 800);
