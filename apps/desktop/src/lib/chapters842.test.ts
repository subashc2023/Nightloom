// Item 842: chapter edits in the chat's log (the phone reads them there), the
// window's copy synced into it, and where the phone draws the dividers.
import { beforeEach, describe, expect, it } from "vitest";
import { chaptersOf, logEdits, placeOnRows, withEdits } from "./chapters";
import {
  RETRY_MS,
  editsFor,
  renameChapter,
  resetChapterEdits,
  setChapterRemoved,
  setChapterWriter,
  syncChapterEdits,
  type ChapterEdit,
} from "./chapterEdits.svelte";
import { liveFlags } from "./state.svelte";
import { transcriptRows } from "../remote/client";
import type { SessionEvent } from "./types";

const at = "2026-11-18T12:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (blocks: unknown[]): SessionEvent =>
  ({ event: "assistant_message", model: "m", blocks, stop_reason: null, usage: {}, at }) as unknown as SessionEvent;
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (id: string, name: string, content: string): SessionEvent => ({ event: "tool_result", tool_use_id: id, name, content, is_error: false, at });
const edit = (key: string, title: string | null, removed = false): SessionEvent => ({ event: "chapter_edit", key, title, removed, at });

function chat(): SessionEvent[] {
  return [
    { event: "session_created", id: "c", at } as unknown as SessionEvent, // 0
    user("# Build chapters"), // 1
    reply([call("p1", "ExitPlanMode", { plan: "## The plan" })]), // 2
    result("p1", "ExitPlanMode", "approved"), // 3
    reply([call("a1", "Agent", { description: "wave A" }), call("a2", "Agent", { description: "wave B" })]), // 4
    result("a1", "Agent", "done"), // 5
    result("a2", "Agent", "done"), // 6
    reply([call("b1", "Bash", { command: "git commit" })]), // 7
    result("b1", "Bash", "[fix-842 abc1234] 842: phone chapters"), // 8
    reply([{ type: "text", text: "Done." }]), // 9
    user("next"), // 10
    { event: "hand_off", brief: "b", context: 1, reason: "soft", at }, // 11
    user("after the hand-off"), // 12
    reply([{ type: "text", text: "ok" }]), // 13
  ];
}

describe("logEdits (item 842)", () => {
  it("the latest line per key wins, a bare line clears it, over the whole log", () => {
    const evs = [
      ...chat(),
      edit("plan:2", "First name"),
      edit("wave:4", null, true),
      edit("plan:2", "The plan he approved"),
      edit("commit:7", "Shipped"),
      edit("commit:7", null),
      { event: "rewind", to: 14, at } as SessionEvent, // a rewind does not undo a name
    ];
    expect(logEdits(evs)).toEqual({ "plan:2": { title: "The plan he approved" }, "wave:4": { removed: true } });
  });
});

describe("the window's copy and the log", () => {
  let writes: { chat: string; key: string; edit: ChapterEdit }[];
  let refuse: boolean;
  beforeEach(() => {
    localStorage.clear();
    resetChapterEdits({});
    writes = [];
    refuse = false;
    setChapterWriter(async (chat, key, e) => {
      writes.push({ chat, key, edit: e });
      if (refuse) throw new Error("that chat is running a turn");
    });
  });

  it("a rename is written to the log at once and shown before the log has it", async () => {
    const evs = chat();
    renameChapter("c1", { key: "plan:2", title: "Plan approved: The plan" }, "Chapters planned");
    await Promise.resolve();
    expect(writes).toEqual([{ chat: "c1", key: "plan:2", edit: { title: "Chapters planned" } }]);
    expect(editsFor("c1", evs)["plan:2"]).toEqual({ title: "Chapters planned" });
    // The log now says it: the window's copy is dropped, the name stays.
    const logged = [...evs, edit("plan:2", "Chapters planned")];
    syncChapterEdits("c1", logged);
    expect(editsFor("c1")).toEqual({});
    expect(editsFor("c1", logged)["plan:2"]).toEqual({ title: "Chapters planned" });
    expect(writes.length).toBe(1);
  });

  it("removing a chapter keeps the name the log holds", async () => {
    const evs = [...chat(), edit("plan:2", "His name")];
    const shown = withEdits(chaptersOf(evs, liveFlags(evs)), editsFor("c1", evs)).find((c) => c.key === "plan:2")!;
    setChapterRemoved("c1", shown, true);
    await Promise.resolve();
    expect(writes.at(-1)?.edit).toEqual({ title: "His name", removed: true });
  });

  it("a reset over a logged name is kept until the log clears it", async () => {
    const evs = [...chat(), edit("plan:2", "His name")];
    const shown = withEdits(chaptersOf(evs, liveFlags(evs)), editsFor("c1", evs)).find((c) => c.key === "plan:2")!;
    renameChapter("c1", shown, "");
    await Promise.resolve();
    expect(writes.at(-1)?.edit).toEqual({});
    expect(editsFor("c1", evs)["plan:2"]).toBeUndefined();
    syncChapterEdits("c1", [...evs, edit("plan:2", null)]);
    expect(editsFor("c1")).toEqual({});
  });

  it("a refused write (a turn holds the chat) is sent again later, not before RETRY_MS", async () => {
    refuse = true;
    const evs = chat();
    renameChapter("c1", { key: "wave:4", title: "2 helpers" }, "The wave");
    await Promise.resolve();
    await Promise.resolve();
    expect(writes.length).toBe(1);
    const t = Date.now();
    syncChapterEdits("c1", evs, t + 10);
    expect(writes.length).toBe(1);
    refuse = false;
    syncChapterEdits("c1", evs, t + RETRY_MS + 10);
    await Promise.resolve();
    expect(writes.length).toBe(2);
    expect(editsFor("c1", evs)["wave:4"]).toEqual({ title: "The wave" });
    // Sent: a later sync does not send it again.
    await Promise.resolve();
    syncChapterEdits("c1", evs, t + 3 * RETRY_MS);
    expect(writes.length).toBe(2);
  });

  it("an aside's edits stay in the window (no log of its own)", async () => {
    renameChapter("aside:9", { key: "plan:2", title: "x" }, "Aside name");
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(editsFor("aside:9")).toEqual({ "plan:2": { title: "Aside name" } });
  });

  it("799's edits, kept in the window before 842, reach the log on the next sync", () => {
    resetChapterEdits({ c1: { t: 1, edits: { "commit:7": { title: "Old rename" } } } });
    syncChapterEdits("c1", chat());
    expect(writes).toEqual([{ chat: "c1", key: "commit:7", edit: { title: "Old rename" } }]);
  });
});

describe("placeOnRows: the phone's dividers (item 842)", () => {
  it("a mid-turn wave and a commit below their reply row, a hand-off above the row after it", () => {
    const evs = [...chat(), edit("commit:7", "Shipped"), edit("plan:2", null, true)];
    const rows = transcriptRows(evs);
    const ranges = rows.map((r) =>
      r.kind === "user" ? { first: r.index, last: r.index } : r.kind === "assistant" ? { first: r.indexes[0], last: r.indexes[r.indexes.length - 1] } : null,
    );
    const shown = withEdits(chaptersOf(evs, liveFlags(evs)), logEdits(evs)).filter((c) => !c.removed);
    const { before, tail } = placeOnRows(ranges, shown);
    // rows: 0 user(1), 1 reply(2..9), 2 user(10), 3 user(12), 4 reply(13)
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "user", "assistant"]);
    // The wave was launched mid-turn (the row opens at 2): below the row, before the commit.
    expect(before.get(1)).toBeUndefined();
    expect(before.get(2)?.map((c) => [c.key, c.shown])).toEqual([["wave:4", "2 helpers: wave A, wave B"], ["commit:7", "Shipped"]]);
    expect(before.get(3)?.map((c) => c.key)).toEqual(["hand_off:11"]);
    expect(tail).toEqual([]);
    // The start is not drawn; the removed plan is not either.
    expect([...before.values()].flat().some((c) => c.kind === "start" || c.key === "plan:2")).toBe(false);
  });

  it("a wave that opens its row goes above it", () => {
    const evs = [user("go"), reply([call("a1", "Agent", { description: "x" }), call("a2", "Agent", { description: "y" })]), result("a1", "Agent", "d"), result("a2", "Agent", "d"), user("next")];
    const { before } = placeOnRows([{ first: 0, last: 0 }, { first: 1, last: 1 }, { first: 4, last: 4 }], withEdits(chaptersOf(evs, liveFlags(evs)), {}));
    expect(before.get(1)?.map((c) => c.kind)).toEqual(["wave"]);
  });

  it("a mark in the last row goes to the tail", () => {
    const evs = chat().slice(0, 10);
    const rows = transcriptRows(evs);
    const ranges = rows.map((r) => (r.kind === "assistant" ? { first: r.indexes[0], last: r.indexes.at(-1)! } : r.kind === "user" ? { first: r.index, last: r.index } : null));
    const { tail } = placeOnRows(ranges, withEdits(chaptersOf(evs, liveFlags(evs)), {}));
    expect(tail.map((c) => c.kind)).toEqual(["plan", "wave", "commit"]);
  });
});
