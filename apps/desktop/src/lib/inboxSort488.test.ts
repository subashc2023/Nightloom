import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 488: Sort inbox. The bridge is stubbed: nothing here touches a disk
// or a model.
vi.mock("./inboxSort", async (original) => {
  const real = await original<typeof import("./inboxSort")>();
  return {
    ...real,
    listInbox: vi.fn(async () => ({
      items: [
        { path: "Inbox/alice.md", folder: false, bytes: 9, kind: "text", head: "# Alice" },
        { path: "Inbox/lab3", folder: true, bytes: 0, kind: "folder of 2 files", head: "a, b" },
      ],
      folders: ["people", "courses"],
      left_out: 0,
    })),
    planSort: vi.fn(async () => ({
      proposals: [
        { item: "Inbox/alice.md", folder: false, to: "people", reason: "a person", new_folder: false, tick: true },
        { item: "Inbox/lab3", folder: true, to: "courses/cs161", reason: "a lab", new_folder: true, tick: true },
      ],
      folders: ["people", "courses"],
      left_out: 0,
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 2140, output_tokens: 380 },
      cost_usd: 0.00404,
      interrupted: false,
    })),
    applySort: vi.fn(async (_s: string, moves: { item: string; to: string }[]) =>
      moves.map((m) => ({ item: m.item, landed: `${m.to}/${m.item.split("/").pop()}`, renamed: false })),
    ),
    cancelSort: vi.fn(async () => null),
  };
});
vi.mock("./api", async (original) => {
  const real = await original<typeof import("./api")>();
  return {
    ...real,
    listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
    listNotes: vi.fn(async () => []),
    listProposals: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  };
});

import * as bridge from "./inboxSort";
import { appliedWords, checkDest, costWords, movesOf, type Proposal } from "./inboxSort";
import { applyPlan, closeInboxSort, inboxSort, openInboxSort, resetSort, runSort } from "./inboxSort.svelte";
import { app } from "./state.svelte";

const row = (item: string, to: string, tick = true): Proposal => ({
  item,
  folder: false,
  to,
  reason: "",
  new_folder: false,
  tick,
});

describe("item 488: destinations and moves", () => {
  it("checks a destination as the backend does", () => {
    const f = ["People", "courses/cs161"];
    expect(checkDest("people/", f)).toEqual({ ok: true, rel: "People", isNew: false });
    expect(checkDest(" courses/math120 ", f)).toEqual({ ok: true, rel: "courses/math120", isNew: true });
    expect(checkDest("", f)).toEqual({ ok: true, rel: "", isNew: false });
    for (const bad of ["../out", "a/../b", ".trash", "a/.hidden", "C:/x", "a\\b", "a//b"]) {
      expect(checkDest(bad, f).ok, bad).toBe(false);
    }
    expect(checkDest("Inbox", f).ok).toBe(false);
    expect(checkDest("inbox/sub", f).ok).toBe(false);
  });

  it("moves only ticked rows with a usable destination", () => {
    const rows = [row("Inbox/a.md", "people"), row("Inbox/b.md", "people", false), row("Inbox/c.md", "../x"), row("Inbox/d.md", "")];
    expect(movesOf(rows, ["people"])).toEqual([
      { item: "Inbox/a.md", to: "people" },
      { item: "Inbox/d.md", to: "" },
    ]);
  });

  it("says the cost as an estimate and what Apply did", () => {
    expect(costWords({ model: "claude-haiku-4-5", usage: { input_tokens: 2140, output_tokens: 380 }, cost_usd: 0.00404 })).toBe(
      "Haiku · 2,140 in, 380 out · about $0.0040 at API prices",
    );
    expect(
      appliedWords([
        { item: "Inbox/a", landed: "p/a", renamed: false },
        { item: "Inbox/b", landed: "p/b (2)", renamed: true },
        { item: "Inbox/c", renamed: false, error: "no" },
      ]),
    ).toBe("Moved 2 entries; 1 numbered because the name was taken (Keep both); 1 could not move.");
  });
});

describe("item 488: the sheet's state", () => {
  beforeEach(() => {
    resetSort();
    closeInboxSort();
    app.draft.engine = "claude-code";
    app.notes = [];
    vi.mocked(bridge.planSort).mockClear();
    vi.mocked(bridge.applySort).mockClear();
  });

  it("plans, keeps the plan across close and reopen, and applies only what is ticked", async () => {
    await openInboxSort("project");
    expect(inboxSort.digest?.items.length).toBe(2);
    inboxSort.instruction = "labs under courses";
    await runSort();
    expect(vi.mocked(bridge.planSort).mock.calls[0][0]).toMatchObject({ scope: "project", instruction: "labs under courses" });
    expect(inboxSort.phase).toBe("plan");
    expect(inboxSort.cost).toContain("Haiku");
    // Closing keeps his instruction and his edits.
    inboxSort.rows[1].tick = false;
    closeInboxSort();
    await openInboxSort("project");
    expect(inboxSort.instruction).toBe("labs under courses");
    expect(inboxSort.rows[1].tick).toBe(false);
    expect(vi.mocked(bridge.planSort)).toHaveBeenCalledTimes(1);
    await applyPlan();
    expect(vi.mocked(bridge.applySort).mock.calls[0][1]).toEqual([{ item: "Inbox/alice.md", to: "people" }]);
    expect(inboxSort.phase).toBe("done");
    expect(inboxSort.rows.map((r) => r.item)).toEqual(["Inbox/lab3"]);
  });

  it("refuses on the API engine without calling the model", async () => {
    app.draft.engine = "provider";
    await openInboxSort("project");
    await runSort();
    expect(bridge.planSort).not.toHaveBeenCalled();
    expect(inboxSort.error).toContain("Claude Code engine");
    expect(inboxSort.phase).toBe("idle");
  });
});
