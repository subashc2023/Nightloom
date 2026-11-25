// Item 967 (916's item B, blocker 2285): the second batch of app commands —
// each one's parse, the surfaces it is on, and the action it calls.
import { describe, expect, it } from "vitest";
import { APP_COMMANDS, commandsOn, noteFileName, onOff, parseCommand, scheduleArg, type AppCommandName } from "./appCommands";
import { runBatch2, type BoxActions } from "./appCommands967";
import { ASIDE_HIDDEN } from "./asideControls";

const BATCH2: AppCommandName[] = ["fork", "schedule", "council", "keepwarm", "thinking", "tools", "remember", "project", "note", "terminal", "commands", "makemain", "settings", "feedback"];
const names = (list: { name: string }[]) => list.map((c) => c.name);

function fake(over: Partial<BoxActions> = {}): BoxActions & { calls: string[] } {
  const calls: string[] = [];
  // Every action records its call; `schedule` answers true (held).
  const rec = (name: string): any => async (...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    return true;
  };
  const base: BoxActions = {
    aside: false,
    toast: (m) => void calls.push(`toast(${m})`),
    clear: () => void calls.push("clear"),
    engine: () => "claude-code",
    busy: () => false,
    sessionId: () => "s1",
    lastLiveUser: () => 4,
    setCheckpoint: rec("setCheckpoint"),
    scheduleBlocked: () => null,
    scheduleTime: (kind, hhmm) => (kind === "time" ? (hhmm === "21:30" ? 2130 : 1) : kind === "five_hour" ? 5 : 7),
    schedule: rec("schedule"),
    openCouncil: () => void calls.push("openCouncil"),
    sendCouncil: rec("sendCouncil"),
    keepWarmChat: () => "s1",
    keepWarmOn: () => false,
    setKeepWarm: rec("setKeepWarm"),
    transcriptOn: () => false,
    thinkingDead: () => false,
    toggleTranscript: (w) => void calls.push(`toggleTranscript("${w}")`),
    capturing: () => false,
    saveMemory: rec("saveMemory"),
    projects: () => [
      { id: "p1", name: "Nightloom" },
      { id: "p2", name: "HopecraftAI" },
    ],
    currentProject: () => "p1",
    canLeaveProject: () => true,
    useProject: rec("useProject"),
    openProjects: () => void calls.push("openProjects"),
    noteScope: () => "project",
    newNote: rec("newNote"),
    terminalCwd: () => "/x",
    openTerminal: rec("openTerminal"),
    openAgentTab: rec("openAgentTab"),
    canMakeMain: () => true,
    makeMain: rec("makeMain"),
    menu: (id) => void calls.push(`menu("${id}")`),
  };
  return Object.assign(base, over, { calls });
}

async function run(text: string, over: Partial<BoxActions> = {}, surface: "chat" | "aside" = "chat"): Promise<string[]> {
  const typed = parseCommand(text, surface);
  if (!typed) throw new Error(`not a command: ${text}`);
  const a = fake({ aside: surface === "aside", ...over });
  expect(await runBatch2(typed, a)).toBe(true);
  return a.calls;
}

describe("967: the table's second batch", () => {
  it("follows the first nine, in 916's order", () => {
    expect(names([...APP_COMMANDS]).slice(9)).toEqual(BATCH2);
  });
  it("leaves out /compact, /delete, /archive, /stop (916's reasons)", () => {
    for (const n of ["compact", "delete", "archive", "stop"]) expect(parseCommand(`/${n}`, "chat")).toBeNull();
  });
  it("asides: all but the chat's own (ASIDE_HIDDEN's words where listed)", () => {
    const inAside = names(commandsOn("aside")).filter((n) => BATCH2.includes(n as AppCommandName));
    expect(inAside).toEqual(["keepwarm", "thinking", "tools", "project", "note", "terminal", "commands", "settings", "feedback"]);
    const row = (n: string) => APP_COMMANDS.find((c) => c.name === n)!;
    expect(row("fork").notInAside).toBe(ASIDE_HIDDEN.fork);
    expect(row("schedule").notInAside).toBe(ASIDE_HIDDEN.schedule);
    expect(row("council").notInAside).toBe(ASIDE_HIDDEN.council);
    expect(row("remember").notInAside).toBeTruthy();
    expect(row("makemain").notInAside).toBeTruthy();
    expect(parseCommand("/fork", "aside")).toBeNull();
    expect(parseCommand("/keepwarm on", "aside")?.cmd.name).toBe("keepwarm");
  });
  it("the phone: the ones its page runs (checkpoint, council sheet, projects page)", () => {
    const onPhone = names(commandsOn("phone")).filter((n) => BATCH2.includes(n as AppCommandName));
    expect(onPhone).toEqual(["fork", "council", "project"]);
  });
});

describe("967: each command's parse", () => {
  const p = (t: string) => {
    const r = parseCommand(t, "chat");
    return r ? { name: r.cmd.name, arg: r.arg } : null;
  };
  it("alone or with its words", () => {
    expect(p("/fork")).toEqual({ name: "fork", arg: "" });
    expect(p("/schedule 9:30pm check the build")).toEqual({ name: "schedule", arg: "9:30pm check the build" });
    expect(p("/council is this right?")).toEqual({ name: "council", arg: "is this right?" });
    expect(p("/keepwarm off")).toEqual({ name: "keepwarm", arg: "off" });
    expect(p("/thinking")).toEqual({ name: "thinking", arg: "" });
    expect(p("/tools on")).toEqual({ name: "tools", arg: "on" });
    expect(p("/remember")).toEqual({ name: "remember", arg: "" });
    expect(p("/project hopecraft")).toEqual({ name: "project", arg: "hopecraft" });
    expect(p("/note Plan for Friday")).toEqual({ name: "note", arg: "Plan for Friday" });
    expect(p("/terminal")).toEqual({ name: "terminal", arg: "" });
    expect(p("/commands")).toEqual({ name: "commands", arg: "" });
    expect(p("/makemain")).toEqual({ name: "makemain", arg: "" });
    expect(p("/settings")).toEqual({ name: "settings", arg: "" });
    expect(p("/feedback")).toEqual({ name: "feedback", arg: "" });
  });
  it("a no-argument command with words after it is a message", () => {
    for (const n of ["fork", "remember", "terminal", "commands", "makemain", "settings", "feedback"]) expect(p(`/${n} please`)).toBeNull();
  });
  it("/schedule's when and message", () => {
    expect(scheduleArg("21:30 go")).toEqual({ kind: "time", hhmm: "21:30", words: "go" });
    expect(scheduleArg("9:30pm go on\nand on")).toEqual({ kind: "time", hhmm: "21:30", words: "go on\nand on" });
    expect(scheduleArg("9pm go")).toEqual({ kind: "time", hhmm: "21:00", words: "go" });
    expect(scheduleArg("12am go")).toEqual({ kind: "time", hhmm: "00:00", words: "go" });
    expect(scheduleArg("12pm go")).toEqual({ kind: "time", hhmm: "12:00", words: "go" });
    expect(scheduleArg("reset go")).toEqual({ kind: "five_hour", words: "go" });
    expect(scheduleArg("week go")).toEqual({ kind: "seven_day", words: "go" });
    expect(scheduleArg("9 go")).toHaveProperty("error"); // am or pm?
    expect(scheduleArg("25:00 go")).toHaveProperty("error");
    expect(scheduleArg("13pm go")).toHaveProperty("error");
    expect(scheduleArg("9pm")).toEqual({ error: "Type the message after the time" });
  });
  it("on/off and note names", () => {
    expect(onOff("")).toBeNull();
    expect(onOff("ON")).toBe(true);
    expect(onOff("fold")).toBe(false);
    expect(onOff("maybe")).toBe("bad");
    expect(noteFileName("Plan")).toBe("Plan.md");
    expect(noteFileName("data.csv")).toBe("data.csv");
  });
});

describe("967: each command calls its control's action", () => {
  it("/fork → the checkpoint at the last live message", async () => {
    expect(await run("/fork")).toEqual(["clear", "setCheckpoint(4)"]);
    expect((await run("/fork", { lastLiveUser: () => -1 }))[0]).toMatch(/^toast/);
    expect((await run("/fork", { engine: () => "provider" }))[0]).toMatch(/Claude Code/);
  });
  it("/schedule → Send ▾'s pick with the message", async () => {
    expect(await run("/schedule 9:30pm check it")).toEqual(['schedule("check it","time",2130)']);
    expect(await run("/schedule reset go")).toEqual(['schedule("go","five_hour",5)']);
    expect((await run("/schedule reset go", { scheduleTime: () => null }))[0]).toMatch(/not known/);
    expect((await run("/schedule 9pm go", { scheduleBlocked: () => "already" }))[0]).toMatch(/^toast\(Send later: already/);
    expect((await run("/schedule"))[0]).toMatch(/^toast\(Type a time/);
  });
  it("/council → the popover's send, or its roster alone", async () => {
    expect(await run("/council why?")).toEqual(['sendCouncil("why?")']);
    expect(await run("/council")).toEqual(["clear", "openCouncil"]);
    expect((await run("/council why?", { busy: () => true }))[0]).toMatch(/reply is running/);
  });
  it("/keepwarm → the switch", async () => {
    expect(await run("/keepwarm")).toEqual(["clear", 'setKeepWarm("on")']);
    expect(await run("/keepwarm", { keepWarmOn: () => true })).toEqual(["clear", 'setKeepWarm("off")']);
    expect(await run("/keepwarm off")).toEqual(["clear", 'setKeepWarm("off")']);
    expect(await run("/keepwarm on", {}, "aside")).toEqual(["clear", 'setKeepWarm("on")']);
    expect((await run("/keepwarm on", { keepWarmChat: () => null }))[0]).toMatch(/^toast/);
  });
  it("/thinking, /tools → the transcript toggles", async () => {
    expect((await run("/thinking")).slice(0, 2)).toEqual(["clear", 'toggleTranscript("thinking")']);
    expect((await run("/tools", {}, "aside")).slice(0, 2)).toEqual(["clear", 'toggleTranscript("tool")']);
    // Already as asked: no flip.
    expect((await run("/tools off")).slice(0, 2)).toEqual(["clear", "toast(Tool calls: folded)"]);
    expect((await run("/thinking", { thinkingDead: () => true }))[0]).toMatch(/hidden/);
  });
  it("/remember → Save memory from this chat", async () => {
    expect(await run("/remember")).toEqual(["clear", 'saveMemory("s1")']);
    expect((await run("/remember", { capturing: () => true }))[0]).toMatch(/already running/);
  });
  it("/project → ⌘P's rows, or the list alone", async () => {
    expect(await run("/project hope")).toEqual(["clear", 'useProject("p2")']);
    expect(await run("/project")).toEqual(["clear", "openProjects"]);
    expect(await run("/project nightloom")).toEqual(["clear", "toast(Already in Nightloom)"]);
    expect((await run("/project zzz"))[0]).toMatch(/No project/);
    expect((await run("/project hope", { canLeaveProject: () => false }))[0]).toMatch(/reply is running/);
  });
  it("/note → New note, .md added", async () => {
    expect(await run("/note Plan")).toEqual(["clear", 'newNote("project","Plan.md")']);
    expect(await run("/note Plan", { noteScope: () => "knowledge" })).toEqual(["clear", 'newNote("knowledge","Plan.md")']);
    expect((await run("/note Plan", { noteScope: () => null }))[0]).toMatch(/No project/);
  });
  it("/terminal, /commands → ⌘K's Panels rows", async () => {
    expect(await run("/terminal")).toEqual(["clear", "openTerminal()"]);
    expect((await run("/terminal", { terminalCwd: () => null }))[0]).toMatch(/No folder/);
    expect(await run("/commands")).toEqual(["clear", 'openAgentTab("s1")']);
  });
  it("/makemain → Make main", async () => {
    expect(await run("/makemain")).toEqual(["clear", 'makeMain("s1")']);
    expect((await run("/makemain", { canMakeMain: () => false }))[0]).toMatch(/no version/);
  });
  it("/settings, /feedback → the menu bar's ids", async () => {
    expect(await run("/settings")).toEqual(["clear", 'menu("settings")']);
    expect(await run("/feedback", {}, "aside")).toEqual(["clear", 'menu("feedback")']);
  });
  it("the first batch is not its to run", async () => {
    const t = parseCommand("/model opus", "chat")!;
    const a = fake();
    expect(await runBatch2(t, a)).toBe(false);
    expect(a.calls).toEqual([]);
  });
});
