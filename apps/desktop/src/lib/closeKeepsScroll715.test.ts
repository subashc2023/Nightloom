// Item 715 (his words, 2026-11-15: close and reopen Settings "should remain where i left off, not jus on the same
// page but on the saem scroll too"; his rule: every view keeps its state). Every view that scrolls and is unmounted
// when it closes carries item 487's `tabPlace`, which keeps each scroller's place under a key and puts it back while
// the view loads. The put-back itself is tabPlace's own suite; this pins which surfaces carry it, and with what key.
import { describe, expect, it } from "vitest";
import settingsModal from "./SettingsModal.svelte?raw";
import contextPanel from "./ContextPanel.svelte?raw";
import runningTasks from "./RunningTasks.svelte?raw";
import promptLibrary from "./PromptLibrary.svelte?raw";
import rightRailLogicRaw from "./rightRail/logic.svelte.ts?raw";
import rightRailRaw from "./RightRail.svelte?raw";
const rightRail = asOneFile(rightRailRaw, rightRailLogicRaw);
import rightRailClassicRaw from "./RightRailClassic.svelte?raw";
const rightRailClassic = asOneFile(rightRailClassicRaw, rightRailLogicRaw);
import { asOneFile } from "../test/oneFile";
import sidebarLogicRaw from "./sidebar/logic.svelte.ts?raw";
import sidebarRaw from "./Sidebar.svelte?raw";
const sidebar = asOneFile(sidebarRaw, sidebarLogicRaw);
import sidebarClassicRaw from "./SidebarClassic.svelte?raw";
const sidebarClassic = asOneFile(sidebarClassicRaw, sidebarLogicRaw);
import notesPanel from "./NotesPanel.svelte?raw";
import searchPanel from "./SearchPanel.svelte?raw";
import { atPath, pathOf, recallPlaces, rememberPlace, resetPlaces } from "./tabPlace";

describe("every closing view keeps its scroll (item 715)", () => {
  it("Settings: each pane by its own key, and the nav", () => {
    const panes = settingsModal.match(/<div class="pane"[^>]*>/g) ?? [];
    expect(panes.length).toBeGreaterThanOrEqual(11);
    for (const p of panes) expect(p).toContain('use:tabPlace={"settings:" + selected}');
    expect(settingsModal).toContain('<nav class="nav" bind:this={navEl} use:tabPlace={"settings:nav"}>');
  });
  it("the overlays: Context (per chat), Running tasks (per chat), the prompt library", () => {
    expect(contextPanel).toContain('<div class="pane" use:tabPlace={"context:" + chatKey}>');
    expect(runningTasks).toContain('<div class="pane" use:tabPlace={"tasks:" + (app.activeSessionId ?? "new")}>');
    expect(promptLibrary).toContain('<nav class="nav" use:tabPlace={"prompts:nav"}>');
  });
  it("the right column and its popover, Jarvis and Classic", () => {
    expect(rightRail).toMatch(/<aside class="col" data-rail-col [^>]*use:tabPlace=\{"rail:col:"/);
    expect(rightRail).toContain("<aside class=\"rail\" use:tabPlace={`rail:pop:${aside ? \"aside\" : tab}`}>");
    expect(rightRailClassic).toContain("<aside class=\"rail\" use:tabPlace={`rail:pop:classic:${tab}`}>");
  });
  it("the sidebar: chat list (495), notes, search results, the Nightshift tab", () => {
    for (const s of [sidebar, sidebarClassic]) {
      expect(s).toContain("use:tabPlace={`chat-list:");
      expect(s).toContain("<div class=\"ns-scroll\" use:tabPlace={`nightshift-side:");
    }
    expect(notesPanel).toContain("use:tabPlace={`notes-panel:");
    expect(searchPanel).toContain('use:tabPlace={"search-res"}');
  });
  it("a pane's place is kept by key, the pane box itself at the empty path", () => {
    resetPlaces();
    rememberPlace("settings:animations", "", { top: 640, left: 0 });
    rememberPlace("settings:appearance", "", { top: 120, left: 0 });
    expect(recallPlaces("settings:animations").get("")).toEqual({ top: 640, left: 0 });
    expect(recallPlaces("settings:appearance").get("")).toEqual({ top: 120, left: 0 });
    // Back at the top forgets it, so the pane opens at its top.
    rememberPlace("settings:appearance", "", { top: 0, left: 0 });
    expect(recallPlaces("settings:appearance").size).toBe(0);
    const root = { parentElement: null } as unknown as Element;
    expect(pathOf(root, root)).toBe("");
    expect(atPath(root, "")).toBe(root);
  });
});
