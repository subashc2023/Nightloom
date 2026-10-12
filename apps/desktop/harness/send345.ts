// Item 345 harness — see send345.html. The real NoteView and NoteEditPanel with a dream's proposal open
// on Memory; only the Tauri bridge is faked (read_note returns the note; edit_note_by_prompt returns the
// note as the model edited it). Types a request, clicks Send, and prints what happened.
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import NoteView from "../src/lib/NoteView.svelte";
import { app, noteDraftKey } from "../src/lib/state.svelte";
import { noteEdits, noteEditUi, setRequestDraft } from "../src/lib/noteEdit.svelte";

const cap = document.getElementById("cap")!;
const NOTE = "# Memory\n\n- standing rule 1\n- times in 24-hour\n- standing rule 3\n";
const EDITED = NOTE.replace("- times in 24-hour", "- ~~times in 24-hour~~ (2026-10-12)\n- times in 12-hour AM/PM");
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "read_note") return NOTE;
    if (cmd === "read_note_media") return null;
    if (cmd === "edit_note_by_prompt") {
      const a = (args as { args?: { text?: string } }).args ?? (args as { text?: string });
      if (a.text !== NOTE) throw new Error("sent text is not the note");
      return { text: EDITED, summary: "Struck the 24-hour line and added AM/PM.", edits: 1, interrupted: false,
        error: null, was_on_disk: null, cost_usd: null, notices: [] };
    }
    return null;
  },
  transformCallback: () => 0,
};
const entry = {
  id: "p-1",
  proposal: {
    v: 1,
    at: "2026-10-08T08:00:00Z",
    target: { kind: "user" as const },
    why: "Three chats this week asked for a short note on travel.",
    text: NOTE + "- travel light\n",
    from_dream: true,
  },
};
app.openNote = { scope: "memory", name: "MEMORY.md" } as typeof app.openNote;
app.proposals.memory = [entry] as typeof app.proposals.memory;
app.proposalReview = { scope: "memory", entry } as typeof app.proposalReview;
const before = JSON.stringify({ p: app.proposals.memory, r: app.proposalReview });
noteEditUi.open = true;
mount(NoteView, { target: document.getElementById("root")!, props: {} });
flushSync();
setTimeout(async () => {
  try {
    const key = noteDraftKey("memory", "MEMORY.md");
    setRequestDraft(key, "we now use AM/PM times");
    await tick();
    const send = document.querySelector<HTMLButtonElement>("button.send");
    const ta = document.querySelector<HTMLTextAreaElement>("aside textarea");
    const line = document.querySelector<HTMLElement>(".blocked")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const disabledBefore = send?.disabled;
    send?.click();
    await new Promise((r) => setTimeout(r, 300));
    await tick();
    const turn = noteEdits[key]?.turns.at(-1);
    const marked = document.querySelectorAll(".ln.mark").length;
    // The changed lines stay marked for 5 s, then the proposal card is back.
    await new Promise((r) => setTimeout(r, 5400));
    await tick();
    const after = JSON.stringify({ p: app.proposals.memory, r: app.proposalReview });
    cap.textContent = [
      `notice line: ${JSON.stringify(line)}`,
      `Send disabled with text typed + proposal open: ${disabledBefore}`,
      `textarea autocorrect=${ta?.getAttribute("autocorrect")} autocapitalize=${ta?.getAttribute("autocapitalize")} spellcheck=${ta?.getAttribute("spellcheck")}`,
      `edit_note_by_prompt called: ${calls.filter((c) => c === "edit_note_by_prompt").length} · turn status: ${turn?.status} · after has AM/PM: ${turn?.after?.includes("12-hour AM/PM")} · lines marked on landing: ${marked}`,
      `proposal unchanged and still open: ${after === before} · review card back after the marks: ${!!document.querySelector(".review")}`,
    ].join("\n");
  } catch (e) {
    cap.textContent = "harness error: " + String((e as Error)?.stack ?? e);
  }
}, 800);
