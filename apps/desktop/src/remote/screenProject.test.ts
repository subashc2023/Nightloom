import { describe, expect, it } from "vitest";
import { NO_PROJECT, notesProject, screenProject, type ScreenInput } from "./screenProject";

const base: ScreenInput = { chatId: null, chatPid: null, newProject: null, activePid: "garden", hasProjects: true };

describe("screenProject (300 B1)", () => {
  it("a chat on screen names its own project, not the host's open one", () => {
    expect(screenProject({ ...base, chatId: "c1", chatPid: "bird" })).toBe("bird");
  });
  it("a chat with no project is No project even while the host has one open", () => {
    expect(screenProject({ ...base, chatId: "c1", chatPid: null })).toBe(NO_PROJECT);
  });
  it("a new chat names the project it starts in", () => {
    expect(screenProject({ ...base, newProject: "bird" })).toBe("bird");
    expect(screenProject({ ...base })).toBe("garden");
    expect(screenProject({ ...base, activePid: "" })).toBe(NO_PROJECT);
  });
  it("an older host that lists no projects gets none", () => {
    expect(screenProject({ ...base, hasProjects: false, chatId: "c1", chatPid: "bird" })).toBeNull();
  });
});

describe("notesProject (300 B1)", () => {
  it("the re-test's repro: Bird log on screen while the host moved to Garden", () => {
    expect(notesProject({ ...base, newProject: "bird" }, true)).toBe("bird");
  });
  it("a host without ?project= on its notes routes gets its own open project, said so", () => {
    expect(notesProject({ ...base, newProject: "bird" }, false)).toBe("garden");
    expect(notesProject({ ...base, activePid: "" }, false)).toBe(NO_PROJECT);
  });
});
