import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./state.svelte";
import * as tabs from "./tabs";
import * as api from "./api";
import { forYou, forYouUnseen, markForYouSeen, openForYou, openPathAsTab, refreshForYou } from "./forYou.svelte";
import { installOpenedFiles } from "./openedFiles.svelte";
import type { ForYouRow } from "./forYou";

/**
 * Files for him (nightshift backlog 377) and Finder's Open With (378), as
 * the window drives them: the list re-read only when the manifest moved,
 * the dot cleared by opening the list, a row or a Finder-opened file
 * landing as a new tab. The backend is mocked; its rules are tested in
 * `mark_file.rs`, `for_you.rs` and `opened_files.rs`.
 */
const listeners = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    listeners.set(name, cb);
    return () => {};
  }),
}));

let stamp = "1:1";
let rows: ForYouRow[] = [];
let opened: string[] = [];
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  forYouStamp: vi.fn(async () => stamp),
  forYouFiles: vi.fn(async () => rows),
  forYouReveal: vi.fn(async () => null),
  takeOpenedFiles: vi.fn(async () => {
    const out = opened;
    opened = [];
    return out;
  }),
  readFileTab: vi.fn(async (path: string) => ({
    path,
    kind: path.endsWith(".bin") ? "other" : path.endsWith(".md") ? "markdown" : "text",
    media_type: "text/plain",
    size: 1,
    text: "x",
    data: null,
    via: "chosen",
  })),
  openFile: vi.fn(async () => null),
  revealFile: vi.fn(async () => null),
}));

const row = (rel: string, at: string, folder = false): ForYouRow => ({ path: `/w/${rel}`, rel, folder, title: null, at });
const tabPaths = () =>
  tabs.focusedPane(app.tabs).tabs.map((t) => (t.content.kind === "file" ? t.content.path : t.content.kind === "note" ? `note:${t.content.name}` : t.content.kind));

beforeEach(() => {
  app.tabs = tabs.emptyWorkspace();
  app.project = null;
  app.toasts = [];
  forYou.seen = {};
  vi.mocked(api.forYouFiles).mockClear();
  vi.mocked(api.openFile).mockClear();
});

describe("the list for him", () => {
  it("re-reads only when the manifest's stamp moves, and opening it clears the dot", async () => {
    rows = [row("a.md", "2026-10-18T10:00:00Z")];
    stamp = "1:1";
    await refreshForYou(true);
    expect(forYou.rows).toHaveLength(1);
    expect(forYouUnseen()).toBe(1);
    await refreshForYou();
    expect(api.forYouFiles).toHaveBeenCalledTimes(1);
    // The model marks another file: the stamp moves, the list follows.
    rows = [row("b.md", "2026-10-18T10:05:00Z"), ...rows];
    stamp = "2:2";
    await refreshForYou();
    expect(api.forYouFiles).toHaveBeenCalledTimes(2);
    expect(forYou.rows.map((r) => r.rel)).toEqual(["b.md", "a.md"]);
    markForYouSeen();
    expect(forYouUnseen()).toBe(0);
    rows = [row("c.md", "2026-10-18T10:09:00Z"), ...rows];
    stamp = "3:3";
    await refreshForYou();
    expect(forYouUnseen()).toBe(1);
  });

  it("a file row opens as a new file tab; a folder row goes to the Finder", async () => {
    await openForYou(row("out/report.md", "2026-10-18T10:00:00Z"));
    expect(tabPaths()).toContain("/w/out/report.md");
    await openForYou(row("results", "2026-10-18T10:00:00Z", true));
    expect(api.forYouReveal).toHaveBeenCalledWith("/w/results");
  });

  it("a .md under the notes folder opens in the note view; a kind the tab cannot draw goes to its app", async () => {
    app.project = { id: "p", name: "P", notes_dir: "/w/.agents" } as typeof app.project;
    await openPathAsTab("/w/.agents/plan.md");
    expect(tabPaths()).toContain("note:plan.md");
    await openPathAsTab("/w/blob.bin");
    expect(api.openFile).toHaveBeenCalledWith("/w/blob.bin");
    expect(tabPaths()).not.toContain("/w/blob.bin");
  });
});

describe("Open With → Nightloom", () => {
  it("opens what launched the app, then each later open, each once, as new tabs", async () => {
    opened = ["/Users/s/Desktop/todo.md"];
    await installOpenedFiles();
    expect(tabPaths()).toContain("/Users/s/Desktop/todo.md");
    opened = ["/Users/s/notes.txt", "/Users/s/other.md"];
    listeners.get("files-opened")!();
    await vi.waitFor(() => expect(tabPaths()).toContain("/Users/s/other.md"));
    expect(tabPaths()).toContain("/Users/s/notes.txt");
    const n = tabPaths().length;
    listeners.get("files-opened")!();
    await new Promise((r) => setTimeout(r, 0));
    expect(tabPaths().length).toBe(n);
  });
});

describe("Open With → Nightloom, a file the tab cannot draw (wave 10 review)", () => {
  it("is shown in the Finder, never handed back to its default app — which may be Nightloom", async () => {
    vi.mocked(api.revealFile).mockClear();
    opened = ["/Users/s/latin1.bin"];
    // Installed by the test above; alone, this installs and takes it now.
    await installOpenedFiles();
    listeners.get("files-opened")!();
    await vi.waitFor(() => expect(api.revealFile).toHaveBeenCalledWith("/Users/s/latin1.bin"));
    expect(api.openFile).not.toHaveBeenCalled();
    expect(tabPaths()).not.toContain("/Users/s/latin1.bin");
  });
});
