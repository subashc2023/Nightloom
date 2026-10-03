import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { readDraft } from "./drafts.svelte";
import {
  READ_ORDER,
  WRAP_UP,
  beginWrapUp,
  clearMessage,
  clearReadOrder,
  handoff,
  message,
  noteAgentTurnEnd,
  noteFill,
  noteThread,
  noteThreadFlags,
  pickText,
  readOrder,
  resetHandoff,
  setMessage,
  setReadOrder,
  threadFor,
  threadReadOrder,
  threadWrapUp,
} from "./handoff.svelte";
import { app, chatThread, continueChat, setChatThread } from "./state.svelte";
import { NEW_THREAD, NO_THREAD, pickerOptions, replaceStartHere, slugFrom, validSlug } from "./thread";
import type { SessionEvent, ThreadInfo } from "./types";

// Research threads (nightshift backlog 271, step 1): the wrap-up and the
// read order a bound chat gets, the picker's rows and slug rules (the Rust
// twin is `thread.rs`; the cases match its tests), the binding through the
// state, and Continue on a bound chat end to end against a scripted engine.

const AT = "2026-10-02T01:00:00Z";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  setChatThread: vi.fn(async (thread: string | null) => [
    { event: "session_created", id: "t1", at: "2026-10-02T01:00:00Z" },
    { event: "thread", ...(thread ? { thread } : {}), at: "2026-10-02T01:00:00Z" },
  ]),
  threadUpkeep: vi.fn(async (slug: string) => ({
    slug,
    flags: ['"## Start here" is 700 words, over its 600.'],
    struck_moved: 2,
    struck_kept: 0,
    struck_undated: 0,
    merged: [],
    saved: 40,
    last_round: "2026-10-01",
  })),
  continueSession: vi.fn(async () => ({
    session: "chat-next",
    events: [
      { event: "session_created", id: "chat-next", at: "2026-10-02T01:00:00Z" },
      { event: "thread", thread: "stuart-brainstorm", at: "2026-10-02T01:00:00Z" },
    ],
    forked: true,
  })),
  listSessions: vi.fn(async () => []),
  connect: vi.fn(async () => {
    throw new Error("not connected in tests");
  }),
}));

function info(slug: string, over: Partial<ThreadInfo> = {}): ThreadInfo {
  return { slug, title: slug, status: "", touched: null, start_here_words: 10, tokens: 100, flags: 0, ...over };
}

describe("slugs", () => {
  it("are folder names, never paths — the same cases as thread.rs", () => {
    expect(validSlug("stuart-brainstorm")).toBe(true);
    expect(validSlug("t1_x")).toBe(true);
    for (const bad of ["", "../x", "Stuart", "-x", "a/b", ":new"]) expect(validSlug(bad)).toBe(false);
    expect(slugFrom("  Stuart brainstorm (Deep Thoughts)! ")).toBe("stuart-brainstorm-deep-thoughts");
  });
});

describe("the picker's rows", () => {
  it("lists none, the threads in the backend's order with their status, then New thread", () => {
    const rows = pickerOptions(
      [
        info("stuart-brainstorm", { title: "Stuart brainstorm", status: "As of 1:00 AM — round 3", touched: "2026-10-02", flags: 1 }),
        info("side"),
      ],
      null,
    );
    expect(rows.map((r) => r.value)).toEqual([NO_THREAD, "stuart-brainstorm", "side", NEW_THREAD]);
    expect(rows[1].label).toBe("Stuart brainstorm (stuart-brainstorm)");
    expect(rows[1].detail).toBe("As of 1:00 AM — round 3 · touched 2026-10-02 · 1 upkeep flag");
    expect(rows[2].label).toBe("side");
  });

  it("keeps a binding the project no longer has, marked, so it is never shown as none", () => {
    const rows = pickerOptions([info("a")], "gone");
    expect(rows.map((r) => r.value)).toEqual([NO_THREAD, "a", "gone", NEW_THREAD]);
    expect(rows[2].label).toBe("gone (missing)");
  });
});

describe("the wrap-up and the read order a chat gets", () => {
  beforeEach(() => {
    noteThread("c1", null);
    clearMessage("c1");
    clearReadOrder("c1");
  });

  it("picks the chat's own text, else the thread's, else the default", () => {
    expect(pickText("own", "thread", "default")).toBe("own");
    // A blank of his own is kept.
    expect(pickText("", "thread", "default")).toBe("");
    expect(pickText(undefined, "thread", "default")).toBe("thread");
    expect(pickText(undefined, null, "default")).toBe("default");
  });

  it("an unbound chat wraps up into HANDOFF.md as before", () => {
    expect(threadFor("c1")).toBeNull();
    expect(message("c1")).toBe(WRAP_UP);
    expect(readOrder("c1")).toBe(READ_ORDER);
  });

  it("a bound chat gets the research wrap-up and the thread's read order", () => {
    noteThread("c1", "stuart-brainstorm");
    const w = message("c1");
    expect(w).toBe(threadWrapUp("stuart-brainstorm"));
    expect(w).toContain(".agents/threads/stuart-brainstorm/thread.md by small edits, never a rewrite");
    expect(w).toContain("Do not write HANDOFF.md for this chat.");
    expect(w).toContain('"As of <date, time AM/PM> — <one line>"');
    expect(w).toContain("claim by claim, each claim keeping its pointer");
    expect(w).toContain("no [brackets] or placeholders");
    expect(w).toContain("tagged start-prompt");
    expect(readOrder("c1")).toBe(threadReadOrder("stuart-brainstorm"));
    expect(readOrder("c1")).toContain('the "## Queue" section of .agents/threads/stuart-brainstorm/thread.md');
    expect(readOrder("c1")).not.toContain("backlog/INDEX.md");
  });

  it("carries the upkeep flags Nightloom found", () => {
    noteThread("c1", "stuart-brainstorm");
    noteThreadFlags("stuart-brainstorm", ["A pasted block in thread.md at line 40 runs 30 lines (over 15)."]);
    expect(message("c1")).toContain("Upkeep Nightloom found in the thread files");
    expect(message("c1")).toContain("- A pasted block in thread.md at line 40 runs 30 lines");
    noteThreadFlags("stuart-brainstorm", []);
    expect(message("c1")).not.toContain("Upkeep Nightloom found");
  });

  it("his own edit wins over the thread's, and setting the thread's text back clears it", () => {
    noteThread("c1", "stuart-brainstorm");
    setMessage("c1", "my own wrap-up");
    expect(message("c1")).toBe("my own wrap-up");
    setMessage("c1", threadWrapUp("stuart-brainstorm"));
    expect(message("c1")).toBe(threadWrapUp("stuart-brainstorm"));
    setReadOrder("c1", "read X");
    expect(readOrder("c1")).toBe("read X");
    clearReadOrder("c1");
    expect(readOrder("c1")).toBe(threadReadOrder("stuart-brainstorm"));
  });
});

describe("Start here for Make this the file", () => {
  it("replaces the section's body and nothing else", () => {
    const file = "# Thread: S\n\n## Start here\nold front\n\n## Queue\n| T-01 | x |\n";
    expect(replaceStartHere(file, "new front")).toBe("# Thread: S\n\n## Start here\nnew front\n\n## Queue\n| T-01 | x |\n");
  });
  it("ignores a ## line inside a fence, and adds the section when there is none", () => {
    const file = "## Start here\na\n```\n## not a heading\n```\n## Queue\n";
    expect(replaceStartHere(file, "b")).toBe("## Start here\nb\n\n## Queue\n");
    expect(replaceStartHere("# T\n", "front")).toBe("# T\n\n\n## Start here\nfront\n");
  });
});

describe("binding a chat through the state", () => {
  it("records the thread, notes it for the hand-off, and is a no-op on the same thread", async () => {
    vi.mocked(api.setChatThread).mockClear();
    app.busy = false;
    app.connecting = false;
    app.events = [];
    app.activeSessionId = null;
    expect(await setChatThread(null)).toBe(true);
    expect(api.setChatThread).not.toHaveBeenCalled();
    expect(await setChatThread("stuart-brainstorm")).toBe(true);
    expect(api.setChatThread).toHaveBeenCalledWith("stuart-brainstorm");
    expect(app.activeSessionId).toBe("t1");
    expect(chatThread(app.events)).toBe("stuart-brainstorm");
    expect(threadFor("t1")).toBe("stuart-brainstorm");
    expect(message("t1")).toBe(threadWrapUp("stuart-brainstorm", ['"## Start here" is 700 words, over its 600.']));
    // The projection takes the latest live event; a rewind past it takes it back.
    const ev: SessionEvent[] = [
      { event: "session_created", id: "x", at: AT },
      { event: "user_message", text: "one", at: AT },
      { event: "thread", thread: "a", at: AT },
      { event: "thread", at: AT },
    ];
    expect(chatThread(ev)).toBeNull();
    expect(chatThread(ev.slice(0, 3))).toBe("a");
    expect(chatThread([...ev.slice(0, 3), { event: "rewind", to: 1, at: AT } as SessionEvent])).toBeNull();
    app.events = [];
    app.activeSessionId = null;
  });
});

/** One scripted engine turn: his message and the model's reply. */
function turn(user: string, reply: string): SessionEvent[] {
  return [
    { event: "user_message", text: user, at: AT },
    {
      event: "assistant_message",
      model: "claude-haiku-4-5",
      blocks: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      at: AT,
    },
  ] as unknown as SessionEvent[];
}

describe("Continue on a bound chat", () => {
  it("opens the next chat on the thread's read order, notes its thread, and runs the upkeep", async () => {
    vi.mocked(api.threadUpkeep).mockClear();
    resetHandoff();
    const chat = "chat-stuart-10";
    noteThread(chat, "stuart-brainstorm");
    app.activeSessionId = chat;
    app.busy = false;
    const limit = 200_000;
    noteFill(chat, 150_000, limit, false);
    noteAgentTurnEnd(chat, 150_000, limit, turn("go on", "round 3"));
    expect(handoff.stage).toBe("due");
    beginWrapUp(chat);
    noteAgentTurnEnd(chat, 152_000, limit, turn("wrap up", "Updated thread.md.\n\n```start-prompt\nStart with T-04.\n```\n"));
    expect(handoff.stage).toBe("wrapped");
    await continueChat();
    expect(app.activeSessionId).toBe("chat-next");
    expect(readDraft("chat-next").text).toBe(`${threadReadOrder("stuart-brainstorm")}\n\nStart with T-04.`);
    expect(threadFor("chat-next")).toBe("stuart-brainstorm");
    expect(api.threadUpkeep).toHaveBeenCalledWith("stuart-brainstorm", true);
  });
});
