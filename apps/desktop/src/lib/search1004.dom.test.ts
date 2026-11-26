// @vitest-environment happy-dom
/*
 * Item 1004 (verify sweep 2, row 8e): the REAL search panel mounted in a DOM over a mocked backend whose
 * `search_everywhere` answers for the project open "on the Mac". Repro: `/search sampling` in Home (nothing),
 * `/project STATS 67`, `/search sampling` → the panel kept Home's empty answer under STATS 67 until the scope was
 * flipped. Now the project is part of what a kept answer answers (`searchKey`), the panel searches again on a
 * switch (open or reopened), the sidebar's `14 ▸` hides a stale answer, and the place searched is named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.hoisted(() => {
  (globalThis as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ = "macos";
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});
const backend = vi.hoisted(() => ({ project: "home", calls: [] as { query: string; scope: string; project: string }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { query: string; scope: string }) => {
    if (cmd !== "search_everywhere") throw new Error("no backend");
    backend.calls.push({ ...args, project: backend.project });
    const hit = backend.project === "stats" || args.scope === "all";
    const group = {
      id: "c1",
      name: "Solving sampling distribution problems",
      modified: 0,
      hits: 14,
      rows: [{ index: 3, who: "you", before: "the ", matched: "sampling", after: " distribution", at: 0, matches: 1 }],
    };
    return hit
      ? { matches: 14, messages: 11, chats: 4, shown: 11, elapsed_ms: 20, groups: [group], notes: [] }
      : { matches: 0, messages: 0, chats: 0, shown: 0, elapsed_ms: 20, groups: [], notes: [] };
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

await import("./asides.svelte");
const { app } = await import("./state.svelte");
const { keptIsCurrent, searchKey, scopeWhere, emptyLine } = await import("./search");
const SearchPanel = (await import("./SearchPanel.svelte")).default;

const HOME = { id: "home", name: "Home", root: "/h", exists: true };
const STATS = { id: "stats", name: "STATS 67", root: "/w/STATS-67", exists: true };

let mounted: Record<string, unknown>[] = [];
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  if (ms) await new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
/** Past the panel's 180 ms debounce and the answer's landing. */
const answered = () => settle(260);
function switchTo(p: typeof HOME | null): void {
  backend.project = p?.id ?? "";
  app.project = p as never;
}
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  backend.calls.length = 0;
  switchTo(HOME);
  app.projects = [HOME, STATS] as never;
  app.search.open = false;
  app.search.query = "";
  app.search.scope = "this";
  app.search.result = null;
  app.search.selected = 0;
  app.search.key = "";
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
});
function openPanel(): void {
  app.search.open = true;
  mounted.push(mount(SearchPanel, { target: document.body, props: {} }));
}
function closePanel(): void {
  app.search.open = false;
  for (const c of mounted) unmount(c);
  mounted = [];
}

describe("1004: search follows the open project", () => {
  it("the sweep's repro: /search in Home, switch to STATS 67, /search again → STATS 67's 14 matches", async () => {
    app.search.query = "sampling";
    openPanel();
    await answered();
    expect(text()).toContain("Nothing mentions “sampling” in Home.");
    closePanel();
    switchTo(STATS);
    // `/search sampling` again: the composer sets the query and opens the panel.
    app.search.query = "sampling";
    openPanel();
    await answered();
    expect(backend.calls.at(-1)).toEqual({ query: "sampling", scope: "this", project: "stats" });
    expect(text()).not.toContain("Nothing mentions");
    expect(text()).toContain("14 matches in 11 messages · 4 chats");
    expect(document.querySelector(".search-where")?.textContent).toBe("in STATS 67’s chats");
  });

  it("a switch while the panel is open searches again, no flip of the scope needed", async () => {
    app.search.query = "sampling";
    openPanel();
    await answered();
    expect(app.search.result?.matches).toBe(0);
    switchTo(STATS);
    await answered();
    expect(app.search.result?.matches).toBe(14);
    expect(backend.calls.map((c) => c.project)).toEqual(["home", "stats"]);
  });

  it("all chats: a switch keeps the answer (it reads every project) and searches nothing again", async () => {
    app.search.scope = "all";
    app.search.query = "sampling";
    openPanel();
    await answered();
    switchTo(STATS);
    await answered();
    expect(backend.calls.length).toBe(1);
    expect(document.querySelector(".search-where")).toBeNull();
  });

  it("the kept answer (the sidebar's `14 ▸`, ⌘F's dot) is stale after a switch while the panel was shut", async () => {
    switchTo(STATS);
    app.search.query = "sampling";
    openPanel();
    await answered();
    closePanel();
    expect(keptIsCurrent(app.search, "stats")).toBe(true);
    switchTo(HOME);
    expect(keptIsCurrent(app.search, "home")).toBe(false);
    // Back to STATS 67: the answer is its own again, reopened without a search.
    switchTo(STATS);
    expect(keptIsCurrent(app.search, "stats")).toBe(true);
    openPanel();
    await answered();
    expect(backend.calls.length).toBe(1);
  });

  it("names the place each scope searches", () => {
    expect(scopeWhere("this", "STATS 67")).toBe("STATS 67’s chats");
    expect(scopeWhere("this", null)).toBe("the unfiled chats");
    expect(scopeWhere("notes", "STATS 67")).toBe("STATS 67’s notes and the vault");
    expect(scopeWhere("all", "STATS 67")).toBeNull();
    expect(emptyLine("x", "this", "STATS 67")).toBe("Nothing mentions “x” in STATS 67.");
    expect(emptyLine("x", "this", null)).toBe("Nothing mentions “x” in the unfiled chats.");
    expect(searchKey("q", "all", "a")).toBe(searchKey("q", "all", "b"));
    expect(searchKey("q", "this", "a")).not.toBe(searchKey("q", "this", "b"));
    expect(searchKey("q", "notes", "a")).not.toBe(searchKey("q", "notes", "b"));
  });
});
