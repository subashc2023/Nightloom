// Item 845 batch 3: Home's stage on the phone — the host over the listener's routes, the brief from the scan page, the
// sentence when a click could not reach Home, and the shared views free of the Mac window's store.
import { describe, expect, it, vi } from "vitest";
import { clickNotSent, phoneBrief, phoneStageHost } from "./phoneStageHost";
import { ApiError, Unreachable, type Client } from "./client";
import homeFirstSrc from "./HomeFirst.svelte?raw";
import homeStageSrc from "./HomeStage.svelte?raw";

const views = import.meta.glob("../lib/homeStage/views/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const parts = import.meta.glob(["../lib/homeStage/*.svelte", "../lib/homeStage/tasks.svelte.ts", "../lib/homeStage/host.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("845 batch 3: the phone's stage", () => {
  it("cuts the scan page into the Mac's brief sections", () => {
    const b = phoneBrief({ date: "2026-11-19", text: "Two things.\n\n## Needs you\n- Lease\n- Mom\n\n## Today\n- Stand-up", ran_at: Date.parse("2026-11-19T16:00:00Z"), today: true, skipped: null });
    expect(b?.sections.map((s) => [s.title, s.lines])).toEqual([["Summary", 0], ["Needs you", 2], ["Today", 1]]);
    expect(b?.at).toBe("2026-11-19T16:00:00.000Z");
    expect(b?.writing).toBe(false);
    expect(phoneBrief(null)).toBeNull();
    expect(phoneBrief({ date: "2026-11-19", text: "  ", ran_at: null, today: true, skipped: null })).toBeNull();
  });

  it("says why a click did not reach Home, in the host's words when it gave some", () => {
    expect(clickNotSent(new Unreachable("down"))).toMatch(/^The Mac is not answering/);
    expect(clickNotSent(new ApiError(503, "Home's stage answers only from the Mac — your click was not sent."))).toBe("Home's stage answers only from the Mac — your click was not sent.");
  });

  it("sends clicks and closes through the client, and notes a refusal before passing it on", async () => {
    const homeTaskEvent = vi.fn(async () => {});
    const homeTaskClose = vi.fn(async () => {
      throw new ApiError(503, "only from the Mac");
    });
    const writeNote = vi.fn(async () => {});
    const notes = vi.fn(async () => [{ name: "Morning brief — Thursday.md" }]);
    const client = { homeTaskEvent, homeTaskClose, writeNote, notes, homeTasks: async () => [] } as unknown as Client;
    const said: string[] = [];
    const opened: string[] = [];
    const h = phoneStageHost({ client: () => client, home: () => ({ project: "home", chat: "h1" }), scan: () => null, open: (c) => opened.push(c), note: (t) => said.push(t) });
    await h.taskEvent("Sorting what arrived", "triage", "you moved a card");
    expect(homeTaskEvent).toHaveBeenCalledWith("Sorting what arrived", "triage", "you moved a card");
    await expect(h.taskClose("sorting")).rejects.toThrow("only from the Mac");
    expect(said).toEqual(["only from the Mac"]);
    expect(await h.noteNames()).toEqual(["Morning brief — Thursday.md"]);
    expect(notes).toHaveBeenCalledWith("project", "home");
    await h.saveNote("Kept.md", "# x");
    expect(writeNote).toHaveBeenCalledWith("project", "Kept.md", "# x", "home");
    h.openChat("c9", null);
    expect(opened).toEqual(["c9"]);
    expect(h.liveBrowser()).toBeNull();
    expect(h.BrowserView).toBeNull();
  });

  it("draws the Mac's own views, none of which reaches for the window's store, its commands or its browser", () => {
    const all = { ...views, ...parts };
    expect(Object.keys(views).length).toBe(8);
    for (const [path, src] of Object.entries(all)) {
      if (path.endsWith("Watch.svelte") || path.endsWith("Stage.svelte")) continue; // the Mac's Watch and its stage
      expect(src, path).not.toMatch(/from "\.\.\/(\.\.\/)?(api|state\.svelte|home\.svelte|claudeBrowser\.svelte|ClaudeBrowserView\.svelte)"/);
    }
    for (const v of ["Brief", "Timeline", "Todo", "Triage", "Browse", "Run", "Research"]) expect(homeStageSrc).toContain(`import ${v} from "../lib/homeStage/views/${v}.svelte"`);
  });

  it("keeps Tell Home under every tab and Home's own sections under Watching", () => {
    expect(homeFirstSrc).toContain("<HomeStage {client} {home} {scan}");
    const tell = homeFirstSrc.indexOf("<!-- 5. Tell Home");
    const before = homeFirstSrc.slice(homeFirstSrc.indexOf("{#if watching}"), tell);
    expect(before.trimEnd().endsWith("{/if}")).toBe(true);
    expect(homeStageSrc).toContain('if (home.chat) onopen(home.chat, home.project);');
  });
});
