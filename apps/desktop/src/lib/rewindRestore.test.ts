import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreFiles, restoredSummary, split, tickedAtFirst, type Plan } from "./rewindRestore";
import type { SessionEvent } from "./types";

/*
 * Item 765: Rewind's "restore files too". The backend (`rewind_files`,
 * `restore_rewound_files`) is mocked at `invoke`; `turn_snapshot.rs` has
 * the git side's own tests.
 */

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let plan: Plan;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "rewind_files") return plan;
    if (cmd === "restore_rewound_files") {
      const paths = args.paths as string[];
      const added = args.added as string[];
      return {
        restored: paths,
        aside: {
          folder: added.length ? "/cfg/rewound/x" : null,
          moved: added.map((p) => ({ from: `/repo/${p}`, to: `/cfg/rewound/x/${p}` })),
          skipped: [],
        },
        skipped: [],
        after: "AFTER",
      };
    }
    return null;
  }),
}));

const AT = "2026-01-01T00:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at: AT });
const created: SessionEvent = { event: "session_created", id: "chat-1", at: AT };
const base: SessionEvent[] = [created, user("one"), user("two")];
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  rewind: vi.fn(async () => [...base, { event: "rewind", to: 2, at: AT }]),
  unrewind: vi.fn(async () => base),
  transcript: vi.fn(async () => base),
  setUndoMenu: vi.fn(async () => {}),
}));
const { app, rewindTo, restoreRewound, undoRestore, keepRewindFiles } = await import("./state.svelte");

const full: Plan = {
  git: true,
  root: "/repo",
  start: "S",
  end: "E",
  now: "N",
  files: [
    { path: "src/a.ts", how: "modified", since: false },
    { path: "notes/new.md", how: "added", since: false },
    { path: "old.txt", how: "deleted", since: false },
    { path: "his.txt", how: "modified", since: true },
  ],
  note: null,
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  calls.length = 0;
  plan = structuredClone(full);
  app.events = [...base];
  app.activeSessionId = "chat-1";
  app.busy = false;
  app.connection = { workspace: "/repo" } as typeof app.connection;
  app.rewindRestore = null;
  app.rewoundWrites = null;
  app.toasts = [];
});

describe("the restore card's rules (item 765)", () => {
  it("marks files the turns' own tools named, and ticks all but those changed since", () => {
    const files = restoreFiles(full, "/repo", [{ path: "src/a.ts", how: "edited", tool: "Edit" }]);
    expect(files.map((f) => [f.path, f.named])).toEqual([
      ["src/a.ts", true],
      ["notes/new.md", false],
      ["old.txt", false],
      ["his.txt", false],
    ]);
    expect(files.map(tickedAtFirst)).toEqual([true, true, true, false]);
    // A file changed since is never sent, even if ticked.
    expect(split(files, () => true)).toEqual({ paths: ["src/a.ts", "old.txt"], added: ["notes/new.md"] });
  });
  it("says what the restore did, and its undo covers moved files too", () => {
    const s = restoredSummary("/repo", {
      restored: ["src/a.ts"],
      aside: { folder: "/cfg/r", moved: [{ from: "/repo/n.md", to: "/cfg/r/n.md" }], skipped: [] },
      skipped: [{ path: "x", why: "changed since the turn ended — left alone" }],
      after: "A",
    });
    expect(s.text).toBe("Restored 1 file · moved 1 the turns made to /cfg/r · left alone: x: changed since the turn ended — left alone");
    expect(s.undoPaths).toEqual(["src/a.ts", "n.md"]);
  });
});

describe("Rewind offers restore files too / keep files (item 765)", () => {
  it("a rewind in a git folder with snapshots offers the restore; Restore, then Undo", async () => {
    await rewindTo(2);
    await settle();
    expect(calls[0]).toEqual({ cmd: "rewind_files", args: { workspace: "/repo", chat: "chat-1", to: 2 } });
    const r = app.rewindRestore!;
    expect(r.files).toHaveLength(4);
    await restoreRewound((f) => tickedAtFirst(f));
    expect(calls[1]).toEqual({
      cmd: "restore_rewound_files",
      args: { chat: "chat-1", root: "/repo", from: "S", guard: "E", paths: ["src/a.ts", "old.txt"], added: ["notes/new.md"] },
    });
    expect(app.rewindRestore!.done).toContain("Restored 2 files");
    expect(app.rewindRestore!.undo).toEqual({ from: "N", guard: "AFTER", paths: ["src/a.ts", "old.txt", "notes/new.md"] });
    await undoRestore();
    expect(calls[2].args).toMatchObject({ from: "N", guard: "AFTER", paths: ["src/a.ts", "old.txt", "notes/new.md"], added: [] });
    expect(app.rewindRestore!.done).toContain("Restore undone: 3 files");
    expect(app.rewindRestore!.undo).toBeNull();
  });
  it("Keep files closes the card and touches nothing", async () => {
    await rewindTo(2);
    await settle();
    keepRewindFiles();
    expect(app.rewindRestore).toBeNull();
    expect(calls.map((c) => c.cmd)).toEqual(["rewind_files"]);
  });
  it("a folder that is not git says so on item 259's card; no restore card", async () => {
    plan = { git: false, root: null, start: null, end: null, now: null, files: [], note: "This folder is not in a git repository, so its files cannot be restored." };
    app.events = [
      created,
      user("one"),
      user("two"),
      {
        event: "assistant_message",
        model: "m",
        blocks: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/x.md", content: "x" } }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        at: AT,
      } as SessionEvent,
    ];
    await rewindTo(2);
    await settle();
    expect(app.rewindRestore).toBeNull();
    expect(app.rewoundWrites?.note).toContain("not in a git repository");
  });
});
