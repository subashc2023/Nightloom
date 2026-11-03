import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 488 follow-up (practices §7): an unapplied plan, with his edits and
// his instruction, survives a quit and relaunch. The bridge is stubbed.
vi.mock("./inboxSort", async (original) => {
  const real = await original<typeof import("./inboxSort")>();
  return {
    ...real,
    listInbox: vi.fn(async () => ({
      items: [{ path: "Inbox/alice.md", folder: false, bytes: 9, kind: "text", head: "# Alice" }],
      folders: ["people"],
      left_out: 0,
    })),
    planSort: vi.fn(),
    applySort: vi.fn(),
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

import { SAVED_KEY, keptAt, parseSort, serializeSort, type SavedSort } from "./inboxSort";

const plan: SavedSort = {
  scope: "project",
  instruction: "people under people/",
  rows: [
    { item: "Inbox/alice.md", folder: false, to: "people/friends", reason: "a friend", new_folder: true, tick: true },
    { item: "Inbox/gone.md", folder: false, to: "people", reason: "moved meanwhile", new_folder: false, tick: false },
  ],
  folders: ["people"],
  cost: "Haiku · 4,959 in, 504 out · about $0.0011 at API prices",
  savedAt: "2026-11-02T18:50:00",
};

describe("item 488b: the stored plan", () => {
  it("round-trips and refuses what is not a plan", () => {
    expect(parseSort(serializeSort(plan))).toEqual(plan);
    expect(parseSort(null)).toBeNull();
    expect(parseSort("{not json")).toBeNull();
    expect(parseSort(JSON.stringify({ scope: "project", instruction: "  ", rows: [] }))).toBeNull();
    const odd = parseSort(
      JSON.stringify({ scope: "elsewhere", rows: [{ item: "people/x.md", to: "a" }, { item: "Inbox/y", to: "b", tick: "yes" }, 4] }),
    );
    expect(odd?.scope).toBe("project");
    expect(odd?.rows).toEqual([{ item: "Inbox/y", folder: false, to: "b", reason: "", new_folder: false, tick: false }]);
    // An instruction alone is worth offering back.
    expect(parseSort(JSON.stringify({ instruction: "half-typed" }))?.instruction).toBe("half-typed");
    expect(keptAt("2026-11-02T18:50:00")).toBe("6:50 PM");
    expect(keptAt("nonsense")).toBe("");
  });
});

describe("item 488b: a relaunch offers the plan back", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("restores the plan and his edits, saves new edits, and drops rows that left the inbox", async () => {
    localStorage.setItem(SAVED_KEY, serializeSort(plan));
    const s = await import("./inboxSort.svelte");
    const { app } = await import("./state.svelte");
    app.notes = [];
    expect(s.inboxSort.phase).toBe("plan");
    expect(s.inboxSort.instruction).toBe("people under people/");
    expect(s.inboxSort.rows[0]).toMatchObject({ to: "people/friends", tick: true });
    // An edit after the relaunch is stored too.
    s.inboxSort.rows[0].to = "people/close";
    s.flushInboxSort();
    expect(parseSort(localStorage.getItem(SAVED_KEY))?.rows[0].to).toBe("people/close");
    // Opening it: the row for an entry no longer in the inbox goes, the rest stays.
    await s.openInboxSort("project");
    expect(s.inboxSort.rows.map((r) => r.item)).toEqual(["Inbox/alice.md"]);
    expect(s.inboxSort.notice).toContain("1 entry has left the inbox");
    expect(s.inboxSort.phase).toBe("plan");
  });

  it("keeps a Project plan when the Knowledge inbox is opened, and only Start over clears the store", async () => {
    localStorage.setItem(SAVED_KEY, serializeSort(plan));
    const s = await import("./inboxSort.svelte");
    await s.openInboxSort("knowledge");
    expect(s.inboxSort.scope).toBe("project");
    expect(s.inboxSort.rows.length).toBe(1);
    expect(s.inboxSort.notice).toContain("Project sort is kept");
    s.closeInboxSort();
    s.flushInboxSort();
    expect(localStorage.getItem(SAVED_KEY)).not.toBeNull();
    s.resetSort();
    expect(localStorage.getItem(SAVED_KEY)).toBeNull();
  });

  it("stores an instruction typed before any plan", async () => {
    const s = await import("./inboxSort.svelte");
    s.inboxSort.instruction = "labs go under courses";
    s.flushInboxSort();
    vi.resetModules();
    const again = await import("./inboxSort.svelte");
    expect(again.inboxSort.instruction).toBe("labs go under courses");
    expect(again.inboxSort.phase).toBe("idle");
  });
});
