import { describe, expect, it } from "vitest";
import type { ShellRow } from "./terminal";
import { exitMark, firstWord, folderName, frontFolder, tabKind, tabNames, tabTip } from "./terminalStrip";

const row = (o: Partial<ShellRow> = {}): ShellRow => ({ id: 1, shell: "zsh", title: "zsh", cwd: "/Users/me/research/vg", pid: 1, exit: null, ...o });
const run = (command: string, o: Partial<ShellRow> = {}): ShellRow =>
  row({ run: { command, title: command.slice(0, 32), note: null, stopped: false, finished: false }, ...o });

describe("item 528: the strip's names", () => {
  it("names a folder by its last part", () => {
    expect(folderName("/Users/me/research/vg/")).toBe("vg");
    expect(folderName("/")).toBe("/");
  });
  it("finds a command's program", () => {
    expect(firstWord('cd "/Users/swaraagsistla/Documents/AI-Safety-Collective-at-Irvine"')).toBe("cd");
    expect(firstWord("# set up\nFOO=1 BAR=2 npm test")).toBe("npm");
    expect(firstWord("sudo ./bin/build.sh -x")).toBe("build.sh");
    expect(firstWord("")).toBe("");
  });
  it("names a run block's tab by its folder and program, as his screenshot's tab should have read", () => {
    const r = run('cd "/Users/swaraagsistla/Documents/AI-Safety-Collective-at-Irvine"', { cwd: "/Users/me/walkee-e", exit: { code: 0, signal: null } });
    expect(tabNames([r])[0].text).toBe("walkee-e · cd");
    expect(tabKind(r)).toBe("run");
  });
  it("names a plain shell by its folder, with the program while one runs", () => {
    expect(tabNames([row()])[0].text).toBe("vg");
    expect(tabNames([row({ title: "npm" })])[0].text).toBe("vg · npm");
    expect(tabNames([row({ title: "npm", exit: { code: 1, signal: null } })])[0].text).toBe("vg");
  });
  it("tells two tabs with one name apart", () => {
    expect(tabNames([row(), row({ id: 2 }), run("ls", { id: 3 }), run("ls -la", { id: 4 })]).map((n) => n.text)).toEqual(["vg", "vg 2", "vg · ls", "vg · ls 2"]);
  });
  it("names the agent's tab", () => {
    expect(tabNames([row({ id: -1, shell: "Agent commands", agentChat: "s1" })])[0].text).toBe("Agent commands");
  });
});

describe("item 528: how a tab ended", () => {
  it("marks each ending", () => {
    expect(exitMark(row())).toBeNull();
    expect(exitMark(run("ls", { exit: { code: 0, signal: null } }))?.kind).toBe("ok");
    expect(exitMark(run("ls", { exit: { code: 2, signal: null } }))).toMatchObject({ kind: "fail", text: "2" });
    expect(exitMark(run("ls", { exit: { code: null, signal: "SIGHUP" } }))?.kind).toBe("signal");
    const stopped = run("yes", { exit: { code: null, signal: "SIGINT" } });
    stopped.run!.stopped = true;
    expect(exitMark(stopped)?.kind).toBe("stopped");
    expect(exitMark(row({ exit: { code: 0, signal: null } }))?.kind).toBe("restart");
  });
  it("puts the whole command, the whole folder and the ending in the tooltip", () => {
    const t = tabTip(run('cd "/Users/x/AI"\nls', { exit: { code: 0, signal: null } }), true);
    expect(t).toContain('cd "/Users/x/AI" (+1 more line)');
    expect(t).toContain("In /Users/me/research/vg");
    expect(t).toContain("finished (exit 0)");
    expect(tabTip(row({ exit: { code: 1, signal: null } }), true)).toContain("Click to start a new shell");
  });
  it("gives the folder chip the tab in front's folder", () => {
    expect(frontFolder(row(), "/Users/me")?.short).toBe("~/…/vg");
    expect(frontFolder(null, null)).toBeNull();
  });
});
