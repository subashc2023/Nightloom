// Item 345 harness — see built345.html. The real NoteView and NoteEditPanel (his pick D2, as built) with a
// thread seeded per state; only the Tauri bridge is faked (read_note returns the note).
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import NoteView from "../src/lib/NoteView.svelte";
import { app, noteDraftKey } from "../src/lib/state.svelte";
import { noteEdits, noteEditUi } from "../src/lib/noteEdit.svelte";
import type { NoteEditTurn } from "../src/lib/noteEdit";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "answered";
const cap = document.getElementById("cap")!;

const N0 = "# Memory\n\n- Times in 12-hour AM/PM.\n- New chats open in the neutral folder.\n- Review the backlog every Friday.\n- Plans before code.\n- Push without asking.\n";
const N1 = N0.replace(
  "- New chats open in the neutral folder.\n",
  "- ~~New chats open in the neutral folder.~~ (2026-10-12)\n- A chat opens in the project it was started from.\n",
);
const N2 = N1.replace("- Review the backlog every Friday.\n", "- ~~Review the backlog every Friday.~~ (2026-10-12)\n");
const NOTE = state === "empty" || state === "proposal" ? N0 : state === "running" ? N1 : N2;

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "read_note") return NOTE;
    return null;
  },
  transformCallback: () => 0,
};

const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).toISOString();
const neutral: NoteEditTurn = {
  id: 1,
  request: "we dropped the neutral folder; update everything that assumes it",
  strike: true,
  at: at(14, 41),
  status: "applied",
  before: N0,
  after: N1,
  edits: 2,
  summary: "Struck the line that sends new chats to the neutral folder and added that a chat now opens in the project it was started from.",
};
const summary: NoteEditTurn = {
  id: 2,
  request: "summarize what changed this week",
  strike: true,
  at: at(14, 44),
  status: "unchanged",
  before: N1,
  after: N1,
  summary: "Two changes: the neutral folder is gone (struck today), and times are written in 12-hour AM/PM (added Tuesday). Nothing else moved.",
};
const weekly: NoteEditTurn = {
  id: 3,
  request: "also drop the line about weekly reviews",
  strike: true,
  at: at(14, 46),
  status: "applied",
  before: N1,
  after: N2,
  edits: 1,
  summary: "Struck the weekly-review line.",
};
const runningTurn: NoteEditTurn = {
  id: 2,
  request: "times are AM/PM now, everywhere",
  strike: true,
  at: at(14, 49),
  status: "running",
  before: N1,
  current: N1.replace("- Plans before code.\n", "- Plans before code (checked 9:30 AM).\n"),
  partial: "Found three times written as 24-hour; changing them one at a time…",
  edits: 2,
};

const key = noteDraftKey("memory", "MEMORY.md");
const turns =
  state === "answered" ? [neutral, summary, weekly] : state === "running" ? [neutral, runningTurn] : [];
noteEdits[key] = {
  draft: state === "proposal" ? "we now use AM/PM times" : "",
  strike: true,
  turns,
  touched: at(14, 50),
};
app.openNote = { scope: "memory", name: "MEMORY.md" } as typeof app.openNote;
if (state === "proposal") {
  const entry = {
    id: "p-1",
    proposal: {
      v: 1,
      at: "2026-10-12T15:00:00Z",
      target: { kind: "user" as const },
      why: "Three chats this week asked for times in 12-hour AM/PM.",
      text: N0 + "- Times always with AM/PM, never 24-hour.\n",
      from_dream: true,
    },
  };
  app.proposals.memory = [entry] as typeof app.proposals.memory;
  app.proposalReview = { scope: "memory", entry } as typeof app.proposalReview;
}
noteEditUi.open = true;
mount(NoteView, { target: document.getElementById("root")!, props: {} });
flushSync();

if (q.get("measure") === "1") {
  setTimeout(async () => {
    try {
      const panel = document.querySelector<HTMLElement>("aside.panel")!;
      const out: string[] = [`panel width ${Math.round(panel.getBoundingClientRect().width)}px at window ${innerWidth}px`];
      out.push(
        `cards ${document.querySelectorAll(".card").length} · plain replies ${document.querySelectorAll(".plain").length} · bubbles ${document.querySelectorAll(".bubble").length}`,
      );
      const card = document.querySelectorAll<HTMLElement>(".card")[0];
      const rows = () => card.querySelectorAll<HTMLButtonElement>(".dl");
      const firstAdd = card.querySelector<HTMLButtonElement>(".dl.add")!;
      out.push(`first card rows ${rows().length}, white-space ${getComputedStyle(firstAdd).whiteSpace}`);
      card.querySelector<HTMLButtonElement>(".more")!.click();
      await tick();
      out.push(`after expand: rows ${rows().length}, white-space ${getComputedStyle(rows()[1]).whiteSpace}, control "${card.querySelector(".more")?.textContent}"`);
      const target = rows()[2]; // "+ A chat opens in the project …"
      target.click();
      await tick();
      const mark = document.querySelector<HTMLElement>(".stream.jumped .ln.mark");
      const lines = [...document.querySelectorAll<HTMLElement>(".stream .ln")];
      out.push(`clicked ${JSON.stringify(target.textContent)} → note shows line ${mark ? lines.indexOf(mark) : "none"} marked: ${JSON.stringify(mark?.textContent)}`);
      await new Promise((r) => setTimeout(r, 1800));
      out.push(`after 1.8 s: marks gone ${!document.querySelector(".stream.jumped")}, editor back ${!!document.querySelector(".cm-editor, textarea.area, .main textarea")}`);
      cap.textContent = out.join("\n");
    } catch (e) {
      cap.textContent = "harness error: " + String((e as Error)?.stack ?? e);
    }
  }, 700);
}
