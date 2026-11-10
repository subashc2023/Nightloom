import { beforeEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import appSrc from "../App.svelte?raw";
import sidebarSrc from "./Sidebar.svelte?raw";
import type { Attachment, SessionEvent, SessionMeta } from "./types";

// Items 531 (Send later carries attachments) and 532 (a chat made by Send
// later looks like a chat), 2026-11-09.

const ROWS: SessionMeta[] = [
  { id: "made", path: "/l/made.jsonl", modified: "2026-11-09T20:00:00Z", user_turns: 0, first_user: null, title: null },
  { id: "old", path: "/l/old.jsonl", modified: "2026-11-09T19:00:00Z", user_turns: 3, first_user: "the first", title: null },
];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listSessions: vi.fn(async () => ROWS.map((r) => ({ ...r }))),
}));

const { drafts, readDraft, setDraftText, setDraftAttachments } = await import("./drafts.svelte");
const { app, refreshSessions } = await import("./state.svelte");
const sched = await import("./scheduled.svelte");
const { deliverTo, readScheduled, writeScheduled, nameScheduledRows } = await import("./schedule");
const { chatPage, rowName, hasNoTurns, chipNames } = await import("./waitingChat");
const {
  scheduled,
  scheduleSend,
  scheduledFor,
  cancelScheduled,
  flushScheduled,
  reloadScheduled,
  restoreScheduledFiles,
  runScheduleTick,
  scheduledFileIds,
  stashChips,
} = sched;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQK";

function chip(id: number, name: string, data: string, kind: Attachment["kind"] = "image"): Attachment {
  return { id, kind, media_type: kind === "image" ? "image/png" : "application/pdf", name, data };
}

/** A fake disk: `stash` stores by a fixed id per payload; `read` gives back. */
function disk() {
  const files = new Map<string, string>();
  const ids: Record<string, string> = { [PNG]: SHA_A, [PDF]: SHA_B };
  return {
    files,
    stash: vi.fn(async (data: string) => {
      const id = ids[data];
      if (!id) throw new Error("cannot copy");
      files.set(id, data);
      return id;
    }),
    read: vi.fn(async (id: string) => {
      const d = files.get(id);
      if (d === undefined) throw new Error("gone");
      return d;
    }),
  };
}

const AT = Date.now() + 60 * 60_000;

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(scheduled)) delete scheduled[k];
  localStorage.clear();
  app.sessions = [];
});

describe("531 — Send later carries files and images", () => {
  it("schedule → persisted without the bytes → relaunch → read back → delivered with them", async () => {
    const d = disk();
    const kept = await stashChips([chip(1, "shot.png", PNG), chip(2, "deck.pdf", PDF, "document")], d.stash);
    expect(kept.map((a) => a.stash)).toEqual([SHA_A, SHA_B]);
    expect(scheduleSend("chat-1", "look at these", "time", AT, true, kept)).toBe(true);
    flushScheduled();

    const raw = localStorage.getItem("nightloom.scheduled")!;
    // The bytes are on disk, not in localStorage.
    expect(raw).not.toContain(PNG);
    expect(raw).not.toContain(PDF);
    expect(raw).toContain(SHA_A);

    // Relaunch: the chips come back pending, then filled from disk.
    reloadScheduled(raw, Date.now());
    const back = scheduledFor("chat-1")!;
    expect(back.attachments!.map((a) => [a.name, a.pending, a.data])).toEqual([
      ["shot.png", true, ""],
      ["deck.pdf", true, ""],
    ]);
    await restoreScheduledFiles(d.read);
    expect(scheduledFor("chat-1")!.attachments!.map((a) => [a.data, a.pending])).toEqual([
      [PNG, undefined],
      [PDF, undefined],
    ]);

    // At the time: the message goes into the chat's queue with both files.
    const sent: { text: string; names: string[]; data: string[] }[] = [];
    scheduledFor("chat-1")!.at = Date.now() - 1000;
    await runScheduleTick({
      now: () => Date.now(),
      limited: async () => false,
      deliver: (s) =>
        deliverTo(s, {
          connected: () => true,
          activeKey: () => "chat-1",
          busy: () => false,
          open: async () => {},
          enqueue: (_k, text, atts) => void sent.push({ text, names: atts.map((a) => a.name), data: atts.map((a) => a.data) }),
          drain: async () => {},
        }),
    });
    expect(sent).toEqual([{ text: "look at these", names: ["shot.png", "deck.pdf"], data: [PNG, PDF] }]);
    expect(scheduledFor("chat-1")).toBeNull();
  });

  it("delivery waits while a file is still being read back", async () => {
    scheduleSend("chat-1", "x", "time", AT, true, [{ ...chip(1, "shot.png", ""), stash: SHA_A, pending: true }]);
    const r = await deliverTo(scheduledFor("chat-1")!, {
      connected: () => true,
      activeKey: () => "chat-1",
      busy: () => false,
      open: async () => {},
      enqueue: () => {
        throw new Error("must not enqueue");
      },
      drain: async () => {},
    });
    expect(r).toEqual({ ok: false, why: "waiting — its files are being read back" });
  });

  it("a copy gone from disk is never skipped silently: the message is held, the note names the file", async () => {
    const d = disk();
    scheduleSend("chat-1", "with a file", "time", AT, true, await stashChips([chip(1, "shot.png", PNG)], d.stash));
    flushScheduled();
    reloadScheduled(localStorage.getItem("nightloom.scheduled"), Date.now());
    d.files.clear();
    await restoreScheduledFiles(d.read);
    const s = scheduledFor("chat-1")!;
    expect(s.state).toBe("held");
    expect(s.note).toContain("shot.png");
    expect(s.text).toBe("with a file");
  });

  it("a chip whose copy fails keeps its bytes in the store; over quota, the words are still written", async () => {
    const d = disk();
    const kept = await stashChips([chip(1, "odd.png", "Zm9v")], d.stash);
    expect(kept[0].stash).toBeUndefined();
    expect(kept[0].data).toBe("Zm9v");
    scheduleSend("chat-1", "hello", "time", AT, true, kept);
    expect(writeScheduled(scheduled)).toContain("Zm9v");
    const bare = writeScheduled(scheduled, true);
    expect(bare).not.toContain("Zm9v");
    expect(readScheduled(bare, Date.now())["chat-1"].text).toBe("hello");
  });

  it("Cancel and Edit give the files back to the box, before any added since, with fresh ids", async () => {
    const d = disk();
    scheduleSend("chat-1", "words", "time", AT, true, await stashChips([chip(7, "shot.png", PNG)], d.stash));
    setDraftText("chat-1", "typed since");
    setDraftAttachments("chat-1", [chip(50, "later.png", PNG)]);
    expect(cancelScheduled("chat-1")).toBe("words");
    const box = readDraft("chat-1");
    expect(box.text).toBe("words\ntyped since");
    expect(box.attachments.map((a) => a.name)).toEqual(["shot.png", "later.png"]);
    expect(box.attachments[0].id).not.toBe(7);
    expect(new Set(box.attachments.map((a) => a.id)).size).toBe(2);
    expect(box.attachments[0].data).toBe(PNG);
    expect(scheduledFor("chat-1")).toBeNull();
  });

  it("a file-only message schedules, and comes back across a relaunch", async () => {
    const d = disk();
    expect(scheduleSend("chat-1", "", "time", AT, true, await stashChips([chip(1, "shot.png", PNG)], d.stash))).toBe(true);
    flushScheduled();
    reloadScheduled(localStorage.getItem("nightloom.scheduled"), Date.now());
    expect(scheduledFor("chat-1")!.attachments!.length).toBe(1);
  });

  it("Cancel before the read-back finishes gives the chip back pending, tracked, and filled when it lands", async () => {
    const d = disk();
    scheduleSend("chat-1", "w", "time", AT, true, await stashChips([chip(1, "shot.png", PNG)], d.stash));
    flushScheduled();
    reloadScheduled(localStorage.getItem("nightloom.scheduled"), Date.now());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = restoreScheduledFiles(async (id) => {
      await gate;
      return d.read(id);
    });
    const tracked: number[] = [];
    cancelScheduled("chat-1", (id) => void tracked.push(id));
    const given = readDraft("chat-1").attachments[0];
    expect(given.pending).toBe(true);
    expect(tracked).toEqual([given.id]);
    release();
    await job;
    expect(readDraft("chat-1").attachments[0].data).toBe(PNG);
    expect(readDraft("chat-1").attachments[0].pending).toBe(false);
  });

  it("the drafts' prune keeps a scheduled message's copies", async () => {
    const d = disk();
    scheduleSend("chat-1", "w", "time", AT, true, await stashChips([chip(1, "shot.png", PNG)], d.stash));
    expect(scheduledFileIds()).toContain(SHA_A);
  });

  it("the composer no longer greys Send later for attachments; a converting chip still waits", () => {
    expect(composerSrc).not.toContain("attachments cannot be scheduled yet");
    expect(composerSrc).toContain("attachments.some((a) => a.pending)");
    expect(composerSrc).toContain("<ScheduleMenu {key} {text} {attachments}");
  });
});

describe("532 — a chat made by Send later looks like a chat", () => {
  it("the list names it by the scheduled message until it goes", async () => {
    scheduleSend("made", "Alright so i want a very comprehensive review of o…\nmore", "five_hour", AT, true);
    await refreshSessions();
    expect(app.sessions.find((s) => s.id === "made")!.first_user).toContain("Alright so i want");
    // A chat with a first message keeps its own name.
    expect(app.sessions.find((s) => s.id === "old")!.first_user).toBe("the first");
    // Cancelled: the next listing has nothing to name it by.
    cancelScheduled("made");
    await refreshSessions();
    expect(app.sessions.find((s) => s.id === "made")!.first_user).toBeNull();
  });

  it("a files-only scheduled message names the row by its files", () => {
    const rows = nameScheduledRows(ROWS, { made: { text: "", attachments: [chip(1, "shot.png", PNG)] } });
    expect(rows[0].first_user).toBe("shot.png");
  });

  it("row names: title, first message, scheduled message, the box's words, else New chat — never 'empty session'", () => {
    const bare = { title: null, first_user: null };
    expect(rowName({ title: "Named", first_user: "x" }, "s", "d")).toBe("Named");
    expect(rowName({ title: null, first_user: "first" }, "s", "d")).toBe("first");
    expect(rowName(bare, "the scheduled one\nline 2", "d")).toBe("the scheduled one");
    expect(rowName(bare, null, "typed in the box")).toBe("typed in the box");
    expect(rowName(bare, null, "")).toBe("New chat");
    expect(sidebarSrc).not.toContain('chatLabel(s, "empty session")');
    expect(sidebarSrc).toContain("data-sched-mark");
  });

  it("Welcome vs waiting page vs chat", () => {
    const made: SessionEvent[] = [{ event: "session_created", id: "made", at: "t" } as unknown as SessionEvent];
    const sent: SessionEvent[] = [...made, { event: "user_message", text: "hi", at: "t" } as unknown as SessionEvent];
    expect(chatPage([], false, null, false)).toBe("welcome"); // a New chat
    expect(chatPage(made, false, "made", false)).toBe("welcome"); // made ahead (layers, kind, thread), nothing waiting
    expect(chatPage(made, false, "made", true)).toBe("waiting"); // made by Send later
    expect(chatPage(made, true, "made", true)).toBe("chat"); // the message is going
    expect(chatPage(sent, false, "made", true)).toBe("chat");
    expect(hasNoTurns(made, false)).toBe(true);
    expect(appSrc).toContain("<WaitingChat key={app.activeSessionId} />");
    expect(appSrc).toContain("{#if !blank || waiting}");
  });

  it("the composer under the waiting page does not repeat the scheduled row", () => {
    expect(composerSrc).toContain('composerShows("schedule", !!aside) && !onWaitingPage');
  });

  it("the files chip says one name or a count", () => {
    expect(chipNames([])).toBeNull();
    expect(chipNames([{ name: "a.png" }])!.short).toBe("a.png");
    expect(chipNames([{ name: "a.png" }, { name: "b.pdf" }])).toEqual({ short: "2 files", all: "a.png\nb.pdf" });
  });
});
