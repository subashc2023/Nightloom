import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, dismissAside, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { threadChip } from "./thread";
import { threadWrapUp } from "./handoff.svelte";
import { asideFromStored, storedAsideOf } from "./asides";
import { foldBlocked, foldEntry, foldPrompt, foldStamp, foldedWarning } from "./asideFold";
import {
  answerFoldDiscard,
  appendFold,
  continueFold,
  foldDiscard,
  requestCancelFold,
  setFoldText,
  startFold,
} from "./asideFold.svelte";
import type { SessionEvent } from "./types";

// Nightshift backlog 281 (the thread chip) and 282 (Fold into thread):
// the chip's three states, and the fold end to end against a scripted
// aside turn and a recorded append — fixtures only, no real thread files.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({
    answer: "### His words\n- \"keep the proxy small\" — c1 aside \"idea\" ex 1",
    is_error: false,
    notices: [],
    cache_read: 10,
  })),
  appendThreadLog: vi.fn(async (_slug: string, entry: string) => entry.length),
  cancelAside: vi.fn(async () => null),
  setChatThread: vi.fn(async (thread: string | null) => [
    { event: "session_created", id: "c1", at: "2026-10-02T01:00:00Z" },
    { event: "thread", ...(thread ? { thread } : {}), at: "2026-10-02T01:00:00Z" },
  ]),
  threadUpkeep: vi.fn(async (slug: string) => ({
    slug,
    flags: [],
    struck_moved: 0,
    struck_kept: 0,
    struck_undated: 0,
    merged: [],
    saved: 0,
    last_round: null,
  })),
  listSessions: vi.fn(async () => []),
  connect: vi.fn(async () => {
    throw new Error("not connected in tests");
  }),
}));

const AT = "2026-10-02T01:00:00Z";
const created: SessionEvent = { event: "session_created", id: "c1", at: AT } as SessionEvent;
const bound = (slug: string): SessionEvent[] => [created, { event: "thread", thread: slug, at: AT } as SessionEvent];

function answered(): Aside {
  return {
    id: 7,
    name: "idea",
    quote: null,
    draft: false,
    turns: [
      { seq: 1, question: "what if the proxy stays small?", partial: "Then …", answer: "Then …", error: null, cancelled: false, cacheRead: 0 },
    ],
    anchor: null,
  };
}

/** The live (proxied) aside, as the card holds it. */
function openAside(): Aside {
  app.asides = [answered()];
  return app.asides[0]!;
}

beforeEach(() => {
  switchAside(null);
  app.activeSessionId = "c1";
  app.events = bound("stuart-brainstorm");
  app.project = { id: "p1", name: "Value Generalization" } as unknown as typeof app.project;
  app.connection = { engine: "claude-code" } as typeof app.connection;
  app.sessions = [{ id: "c1", title: "Stuart 9", first_user: null } as unknown as (typeof app.sessions)[number]];
  app.busy = false;
  app.connecting = false;
  foldDiscard.aside = null;
  vi.mocked(api.askAside).mockClear();
  vi.mocked(api.appendThreadLog).mockClear();
  vi.mocked(api.setChatThread).mockClear();
});

describe("the thread chip (281)", () => {
  it("reads ◇ <slug> when bound, a dim Thread when not, and is absent with no folder", () => {
    expect(threadChip("stuart-brainstorm", true, "normal")).toEqual({ label: "◇ stuart-brainstorm", bound: true });
    expect(threadChip(null, true, "normal")).toEqual({ label: "Thread", bound: false });
    // A chat with no project folder: threads live in a project.
    expect(threadChip(null, false, "normal")).toBeNull();
    expect(threadChip("x", false, "normal")).toBeNull();
    // An ephemeral chat has no log to bind in.
    expect(threadChip(null, true, "ephemeral")).toBeNull();
    expect(threadChip(null, true, "incognito")).toEqual({ label: "Thread", bound: false });
  });
});

describe("Fold into thread (282)", () => {
  it("runs one aside turn, then appends a dated entry to the thread's log.md on Append", async () => {
    const a = openAside();
    await startFold(a);
    expect(api.askAside).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.askAside).mock.calls[0]![0];
    // The aside's own conversation: its exchange travels with the ask.
    expect(sent).toContain("what if the proxy stays small?");
    expect(sent).toContain("Fold this side conversation into the research thread .agents/threads/stuart-brainstorm/");
    expect(a.fold?.stage).toBe("ready");
    expect(api.appendThreadLog).not.toHaveBeenCalled(); // nothing written before Append

    expect(await appendFold(a, new Date(2026, 9, 2, 17, 41))).toBe(true);
    expect(api.appendThreadLog).toHaveBeenCalledTimes(1);
    const [slug, entry] = vi.mocked(api.appendThreadLog).mock.calls[0]!;
    expect(slug).toBe("stuart-brainstorm");
    expect(entry).toContain("## 2026-10-02, 5:41 PM — aside 'idea' from chat 'Stuart 9'");
    expect(entry.startsWith('<!-- aside fold chat=c1 aside="idea" -->')).toBe(true);
    expect(entry.trimEnd().endsWith("<!-- /aside fold -->")).toBe(true);
    expect(entry).toContain('"keep the proxy small"');
    expect(a.fold).toBeUndefined();
    expect(a.foldedInto).toEqual([{ at: "2026-10-02, 5:41 PM", slug: "stuart-brainstorm" }]);
  });

  it("Cancel keeps edited text until he says Discard", async () => {
    const a = openAside();
    await startFold(a);
    setFoldText(a, "my own words, edited");
    requestCancelFold(a);
    expect(foldDiscard.aside).toBe(a);
    expect(a.fold?.text).toBe("my own words, edited");
    answerFoldDiscard(false);
    expect(a.fold?.text).toBe("my own words, edited");
    requestCancelFold(a);
    answerFoldDiscard(true);
    expect(a.fold).toBeUndefined();
    expect(api.appendThreadLog).not.toHaveBeenCalled();
  });

  it("Cancel on unedited model text drops it without asking", async () => {
    const a = openAside();
    await startFold(a);
    requestCancelFold(a);
    expect(foldDiscard.aside).toBeNull();
    expect(a.fold).toBeUndefined();
  });

  it("on an unbound chat offers the thread picker first, then writes for the picked thread", async () => {
    app.events = [created];
    const a = openAside();
    await startFold(a);
    expect(a.fold?.stage).toBe("pick");
    expect(api.askAside).not.toHaveBeenCalled();
    // Nothing picked yet: Write the summary does nothing.
    await continueFold(a);
    expect(api.askAside).not.toHaveBeenCalled();
    app.events = bound("side-thread");
    await continueFold(a);
    expect(a.fold?.stage).toBe("ready");
    expect(a.fold?.slug).toBe("side-thread");
  });

  it("folding twice appends twice, with an 'already folded at' warning", async () => {
    const a = openAside();
    await startFold(a);
    await appendFold(a, new Date(2026, 9, 2, 17, 41));
    expect(foldedWarning(a.foldedInto)).toBe(
      "Already folded at 2026-10-02, 5:41 PM into ◇ stuart-brainstorm — Append adds another entry.",
    );
    await startFold(a);
    await appendFold(a, new Date(2026, 9, 2, 18, 5));
    expect(api.appendThreadLog).toHaveBeenCalledTimes(2);
    expect(a.foldedInto?.length).toBe(2);
    expect(foldedWarning(a.foldedInto)).toContain("Already folded at 2026-10-02, 6:05 PM into ◇ stuart-brainstorm (2 times)");
  });

  it("closing the aside keeps an unappended summary and the folds done (past list form)", async () => {
    const a = openAside();
    await startFold(a);
    await appendFold(a, new Date(2026, 9, 2, 9, 3));
    await startFold(a);
    setFoldText(a, "edited, not yet appended");
    const stored = storedAsideOf(a)!;
    const back = asideFromStored(JSON.parse(JSON.stringify(stored)))!;
    expect(back.fold?.text).toBe("edited, not yet appended");
    expect(back.fold?.edited).toBe(true);
    expect(back.foldedInto).toEqual([{ at: "2026-10-02, 9:03 AM", slug: "stuart-brainstorm" }]);
    dismissAside(a);
    expect(app.asides.length).toBe(0);
  });

  it("refuses an append into another project's thread", async () => {
    const a = openAside();
    await startFold(a);
    app.project = { id: "p2", name: "Other" } as unknown as typeof app.project;
    expect(await appendFold(a)).toBe(false);
    expect(api.appendThreadLog).not.toHaveBeenCalled();
    expect(a.fold?.stage).toBe("ready");
  });

  it("is off in incognito and ephemeral chats, off another chat's aside, and needs the Claude Code engine", () => {
    const ok = { mode: "normal" as const, claudeCode: true, open: true, answered: 1 };
    expect(foldBlocked(ok)).toBeNull();
    expect(foldBlocked({ ...ok, mode: "incognito" })).toBe("private");
    expect(foldBlocked({ ...ok, mode: "ephemeral" })).toBe("private");
    expect(foldBlocked({ ...ok, open: false })).toBe("not-open");
    expect(foldBlocked({ ...ok, claudeCode: false })).toBe("engine");
    expect(foldBlocked({ ...ok, answered: 0 })).toBe("nothing");
  });
});

describe("the fold's text and the wrap-up", () => {
  it("asks for his words verbatim with pointers, tags, queue rows and no placeholders", () => {
    const p = foldPrompt({ slug: "s", chatId: "c1", label: "idea", passageEvent: 12 });
    expect(p).toContain("verbatim");
    expect(p).toContain("tagged `inferred`");
    expect(p).toContain('"source X claims Y"');
    expect(p).toContain("New queue rows");
    expect(p).toContain("Open questions");
    expect(p).toContain('`c1 aside "idea" ex <n>`');
    expect(p).toContain("`c1 ev 12` is the chat message");
    expect(p).toContain("No [brackets], placeholders");
  });

  it("stamps in 12-hour time and keeps names from breaking the entry", () => {
    expect(foldStamp(new Date(2026, 9, 2, 0, 7))).toBe("2026-10-02, 12:07 AM");
    expect(foldStamp(new Date(2026, 9, 2, 12, 30))).toBe("2026-10-02, 12:30 PM");
    const e = foldEntry({ at: "x", chatId: "c", chatTitle: "it's --> odd", label: 'a "b"\nc', body: "body" });
    expect(e.split("\n")[0]).toBe('<!-- aside fold chat=c aside="a ”b” c" -->');
    expect(e).toContain("from chat 'it’s —> odd'");
  });

  it("the bound chat's wrap-up folds aside entries from log.md into thread.md", () => {
    const w = threadWrapUp("stuart-brainstorm");
    expect(w).toContain("Fold any log.md entries from asides since the last wrap-up into thread.md");
    expect(w).toContain("Leave the entries in log.md as they are.");
    expect(w).toContain("6. End your reply");
  });
});
