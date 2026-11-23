import { describe, expect, it } from "vitest";
import { byDoorTip, doorExample, doorMcpConfig, doorWord, shellWord } from "./door";
import { settingsGroups } from "./settingsUsage";
import sidebar from "./Sidebar.svelte?raw";
import sidebarClassic from "./SidebarClassic.svelte?raw";

const card = { writes: false, socket: "/Users/x/.nightloom/door.sock", command: "/Applications/Night loom.app/Contents/MacOS/nightloom-desktop --chat" };

describe("the door (item 767)", () => {
  it("says who started a chat, and read only until switched on", () => {
    expect(byDoorTip("nightshift")).toBe("Started from outside Nightloom by nightshift");
    expect(doorWord(null)).toBe("read only");
    expect(doorWord(card)).toBe("read only");
    expect(doorWord({ ...card, writes: true })).toBe("start and message");
  });

  it("gives a command and an MCP entry that survive a space in the app's path", () => {
    expect(shellWord("/a/b")).toBe("/a/b");
    expect(doorExample(card)).toBe("'/Applications/Night loom.app/Contents/MacOS/nightloom-desktop' --chat list");
    const mcp = JSON.parse(doorMcpConfig(card, "Claude desktop"));
    expect(mcp.mcpServers.nightloom.command).toBe("/Applications/Night loom.app/Contents/MacOS/nightloom-desktop");
    expect(mcp.mcpServers.nightloom.args).toEqual(["--mcp-serve", "--outside", "--as", "Claude desktop"]);
  });

  it("has its pane under Remote and its mark in both sidebars", () => {
    const groups = settingsGroups([], []);
    expect(groups.find((g) => g.title === "Remote")?.panes).toEqual(["remote", "away", "outside"]);
    for (const src of [sidebar, sidebarClassic]) expect(src).toContain("data-by-door");
  });
});
