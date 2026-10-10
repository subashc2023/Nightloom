import { describe, expect, it } from "vitest";
import * as tabs from "./tabs";
import { noteForPath } from "./cards";

/**
 * A file card's Open as a tab (nightshift backlog 161): the `file` kind's
 * descriptor, one tab per path, and which paths open in the note view
 * instead. The path check itself is the backend's (`filetab.rs`, tested
 * there).
 */
describe("the file tab's descriptor", () => {
  it("parses an absolute path, keeps the chat, refuses anything else", () => {
    const c = { kind: "file", path: "/tmp/acepaper.txt", session: "c1" };
    expect(tabs.parseContentDrag(JSON.stringify(c))).toEqual(c);
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "file", path: "/a/b.md" }))).toEqual({ kind: "file", path: "/a/b.md" });
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "file", path: "C:\\x\\y.txt" }))).toEqual({ kind: "file", path: "C:\\x\\y.txt" });
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "file", path: "relative/x.txt" }))).toBeNull();
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "file" }))).toBeNull();
  });

  it("is one tab per path whichever chat opened it, titled by its name", () => {
    const a: tabs.TabContent = { kind: "file", path: "/tmp/acepaper.txt", session: "c1" };
    const b: tabs.TabContent = { kind: "file", path: "/tmp/acepaper.txt", session: "c2" };
    expect(tabs.sameContent(a, b)).toBe(true);
    expect(tabs.sameContent(a, { kind: "file", path: "/tmp/other.txt" })).toBe(false);
    expect(tabs.tabTitle(a, [])).toBe("acepaper.txt");
    expect(tabs.tabGlyph(a)).toBe("read");
    // A second Open lands on the tab already there.
    const ws = tabs.emptyWorkspace();
    const pane = tabs.focusedPane(ws);
    const first = tabs.land(ws, pane, a, "new");
    const again = tabs.land(ws, pane, b, "new");
    expect(again.id).toBe(first.id);
    expect(pane.tabs).toHaveLength(2);
  });
});

describe("noteForPath", () => {
  const folders = { project: "/p/.agents", knowledge: "/v" };
  it("a .md under the notes folder or the vault is that note, named as the Notes list names it", () => {
    expect(noteForPath("/p/.agents/runner/a.md", folders)).toEqual({ scope: "project", name: "runner/a.md" });
    expect(noteForPath("/v/me.md", folders)).toEqual({ scope: "knowledge", name: "me.md" });
  });
  it("anything else is a file tab: not Markdown, outside both, or climbing out", () => {
    expect(noteForPath("/p/.agents/a.txt", folders)).toBeNull();
    expect(noteForPath("/p/README.md", folders)).toBeNull();
    expect(noteForPath("/p/.agents/../x.md", folders)).toBeNull();
    expect(noteForPath("/p/.agentsX/a.md", folders)).toBeNull();
    expect(noteForPath("/p/.agents/a.md", {})).toBeNull();
  });
});
