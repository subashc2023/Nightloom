import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import { app } from "./state.svelte";
import * as tabs from "./tabs";
import TabStrip from "./TabStrip.svelte";
import TabStripClassic from "./TabStripClassic.svelte";
import appSrc from "../App.svelte?raw";

// Item 877 (2026-11-19): a note dragged from the Notes list up to the tab
// strip opened macOS Mission Control. macOS does that for any drag pushed
// against the top of the screen; a zoomed window's strip sits just under the
// system title bar, so the pointer overshot past the strip (no marker there)
// into the edge. A band under the strip now takes the drop as the strip does.

vi.mock("./markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markdown")>()),
  renderMarkdown: (src: string) => `<div data-md>${src}</div>`,
}));

function html(look: typeof TabStrip): string {
  const pane = tabs.makePane([tabs.makeTab({ kind: "chat", session: "a" })]);
  app.tabs = { panes: [pane], focused: pane.id };
  return render(look, { props: { pane } }).body;
}

afterEach(() => {
  app.draggingContent = null;
  app.draggingTerm = false;
  app.draggingTab = null;
});

describe("877: the strip's drop is caught under the strip, short of the screen's top", () => {
  for (const [name, look] of [
    ["Jarvis", TabStrip],
    ["Classic", TabStripClassic],
  ] as const) {
    it(`${name}: no band when nothing is dragged`, () => {
      expect(html(look)).not.toContain("strip-catch");
    });
    it(`${name}: a note's drag draws the band`, () => {
      app.draggingContent = { kind: "note", scope: "project", name: "a.md" };
      expect(html(look)).toContain('class="strip-catch');
    });
    it(`${name}: a terminal shell's drag (also a system drag) draws it`, () => {
      app.draggingTerm = true;
      expect(html(look)).toContain('class="strip-catch');
    });
    it(`${name}: a tab's own drag (a pointer drag, never the system's) does not`, () => {
      app.draggingTab = "t1";
      expect(html(look)).not.toContain("strip-catch");
    });
  }

  it("the pane leaves a drag over the band to the strip, and takes its open-beside half down", () => {
    const over = appSrc.slice(appSrc.indexOf("function onPaneDragOver"), appSrc.indexOf("function onPaneDragLeave"));
    expect(over).toMatch(/closest\("\.strip-catch"\)\)\s*\{\s*if \(dropHalf\?\.pane === paneId\) dropHalf = null;\s*return;/);
    const drop = appSrc.slice(appSrc.indexOf("function onPaneDrop"), appSrc.indexOf("function onPaneDrop") + 400);
    expect(drop).toContain('closest(".tab-strip, .strip-catch")');
  });
});
