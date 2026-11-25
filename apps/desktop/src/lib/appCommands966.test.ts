import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import asideTranscriptSrc from "./AsideTranscript.svelte?raw";
import remoteSrc from "../remote/Remote.svelte?raw";
import promptBoxSrc from "../remote/promptBox.ts?raw";
import {
  APP_COMMANDS,
  commandKind,
  commandMatches,
  commandsOn,
  effortLevel,
  newKind,
  parseCommand,
  pickRow,
  type AppCommandName,
} from "./appCommands";
import { ASIDE_HIDDEN } from "./asideControls";

const names = (list: { name: string }[]) => list.map((c) => c.name);

describe("966: one table of app commands", () => {
  it("holds /handoff and blocker 2285's first batch", () => {
    // Item 967 appended the second batch after these nine (appCommands967.test.ts).
    expect(names([...APP_COMMANDS]).slice(0, 9)).toEqual(["handoff", "aside", "model", "effort", "rename", "rewind", "context", "new", "search"]);
  });

  it("an aside lists all but the chat's own (ASIDE_HIDDEN's words)", () => {
    expect(names(commandsOn("aside")).slice(0, 7)).toEqual(["model", "effort", "rename", "rewind", "context", "new", "search"]);
    expect(APP_COMMANDS.find((c) => c.name === "handoff")!.notInAside).toBe(ASIDE_HIDDEN.handoff);
    expect(APP_COMMANDS.find((c) => c.name === "aside")!.notInAside).toBe(ASIDE_HIDDEN.askAside);
  });

  it("the phone lists the ones its page can run (no hand-off there)", () => {
    expect(names(commandsOn("phone")).slice(0, 8)).toEqual(["aside", "model", "effort", "rename", "rewind", "context", "new", "search"]);
  });

  it("rows say app", () => {
    for (const c of APP_COMMANDS) expect(commandKind(c)).toMatch(/^app · /);
  });
});

describe("966: the menu's matches", () => {
  it("only while the whole box is a /word", () => {
    // Item 967: 9 + 14 rows, and /remember starts with "re" too.
    expect(names(commandMatches("/", "chat"))).toHaveLength(23);
    expect(names(commandMatches("/re", "chat"))).toEqual(["rename", "rewind", "remember"]);
    expect(names(commandMatches("/MO", "chat"))).toEqual(["model"]);
    expect(commandMatches("/model ", "chat")).toEqual([]);
    expect(commandMatches("hi /model", "chat")).toEqual([]);
    expect(commandMatches("/zz", "chat")).toEqual([]);
  });
  it("by surface", () => {
    expect(names(commandMatches("/h", "chat"))).toEqual(["handoff"]);
    expect(commandMatches("/h", "aside")).toEqual([]);
    expect(commandMatches("/h", "phone")).toEqual([]);
    expect(names(commandMatches("/a", "chat"))).toEqual(["aside"]);
    expect(commandMatches("/a", "aside")).toEqual([]);
  });
});

describe("966: what Send runs", () => {
  const run = (t: string, s: "chat" | "aside" | "phone" = "chat") => {
    const p = parseCommand(t, s);
    return p ? { name: p.cmd.name as AppCommandName, arg: p.arg } : null;
  };
  it("each command, alone or with its words", () => {
    expect(run("/handoff")).toEqual({ name: "handoff", arg: "" });
    expect(run("  /handoff \n")).toEqual({ name: "handoff", arg: "" });
    expect(run("/aside what does this do?")).toEqual({ name: "aside", arg: "what does this do?" });
    expect(run("/aside line one\nline two")).toEqual({ name: "aside", arg: "line one\nline two" });
    expect(run("/model opus")).toEqual({ name: "model", arg: "opus" });
    expect(run("/Model")).toEqual({ name: "model", arg: "" });
    expect(run("/effort high")).toEqual({ name: "effort", arg: "high" });
    expect(run("/rename The tab bug")).toEqual({ name: "rename", arg: "The tab bug" });
    expect(run("/rewind")).toEqual({ name: "rewind", arg: "" });
    expect(run("/context")).toEqual({ name: "context", arg: "" });
    expect(run("/new incognito")).toEqual({ name: "new", arg: "incognito" });
    expect(run("/search tab drag")).toEqual({ name: "search", arg: "tab drag" });
  });
  it("text, not a command", () => {
    expect(run("/handoff now")).toBeNull(); // item 915's rule
    expect(run("/context please explain")).toBeNull();
    expect(run("/rewind it all")).toBeNull();
    expect(run("please /model opus")).toBeNull();
    expect(run("/models")).toBeNull();
    expect(run("/model-x")).toBeNull();
    expect(run("/table 3x3")).toBeNull();
    expect(run("/simplify")).toBeNull(); // a Claude Code skill goes to the CLI
  });
  it("by surface", () => {
    expect(run("/handoff", "aside")).toBeNull();
    expect(run("/aside q", "aside")).toBeNull();
    expect(run("/handoff", "phone")).toBeNull();
    expect(run("/model opus", "aside")).toEqual({ name: "model", arg: "opus" });
    expect(run("/rewind", "phone")).toEqual({ name: "rewind", arg: "" });
  });
});

describe("966: the argument matchers", () => {
  const models = [
    { id: "default", label: "default" },
    { id: "sonnet", label: "Sonnet 5" },
    { id: "opus", label: "Opus 5.5" },
    { id: "fable", label: "Fable 5.2" },
    { id: "haiku", label: "Haiku 4.5" },
  ];
  it("a model by id, label, prefix or word", () => {
    expect(pickRow("opus", models)?.label).toBe("Opus 5.5");
    expect(pickRow("Opus 5.5", models)?.id).toBe("opus");
    expect(pickRow("fab", models)?.id).toBe("fable");
    expect(pickRow("DEFAULT", models)?.id).toBe("default");
    expect(pickRow("gpt", models)).toBeNull();
    expect(pickRow("", models)).toBeNull();
  });
  it("several matches are no match", () => {
    expect(pickRow("s", [{ id: "a", label: "Sonnet" }, { id: "b", label: "Spark" }])).toBeNull();
  });
  it("effort levels", () => {
    expect(effortLevel("high")).toBe("high");
    expect(effortLevel("MAX")).toBe("max");
    expect(effortLevel("default")).toBe("");
    expect(effortLevel("med")).toBe("medium");
    expect(effortLevel("hard")).toBeNull();
    expect(effortLevel("")).toBeNull();
  });
  it("new-chat kinds", () => {
    expect(newKind("")).toBe("default");
    expect(newKind("code")).toBe("build");
    expect(newKind("chat")).toBe("chat");
    expect(newKind("incognito")).toBe("incognito");
    expect(newKind("ephemeral")).toBe("ephemeral");
    expect(newKind("banana")).toBeNull();
  });
});

describe("966: every surface reads the table", () => {
  it("the Mac's box lists and runs from it, in the chat and in an aside", () => {
    expect(composerSrc).toContain('commandMatches(text, aside ? "aside" : "chat")');
    expect(composerSrc).toContain('parseCommand(text, aside ? "aside" : "chat")');
    // Before the aside's own send, so an aside's box runs them too.
    const submit = composerSrc.indexOf("async function submit() {");
    expect(composerSrc.slice(submit, submit + 300)).toMatch(/runTypedCommand\(\)[\s\S]*asideSubmit\(\)/);
    // A Claude Code name the app has shows the app's row alone.
    expect(composerSrc).toContain("const taken = new Set([...mine, ...cmd].map((m) => m.name.toLowerCase()));");
  });
  it("each command runs what its control runs", () => {
    const at = composerSrc.indexOf("async function runTypedCommand()");
    const body = composerSrc.slice(at, composerSrc.indexOf("async function submit() {"));
    expect(body).toContain("await sendWrapUpNow(box);");
    expect(body).toContain("setDraftText(key, arg);");
    expect(body).toContain("await submitAside();");
    expect(body).toContain("(aside ? asideModelRows : modelRows)");
    expect(body).toContain("aside ? asideEffortRows : effortRows");
    expect(body).toContain("renameAside(aside, arg);");
    expect(body).toContain("await renameSession(id, arg);");
    expect(body).toContain("rewindAsideWithUndo(aside, last);");
    expect(body).toContain("await rewindTo(at, true);");
    expect(body).toContain('runMenuCommand("context")');
    expect(body).toContain('"new_chat"');
    expect(body).toContain("app.search.open = true;");
  });
  it("the aside's message-menu Rewind and /rewind share one path", () => {
    expect(asideTranscriptSrc).toContain("return rewindAsideWithUndo(aside, i);");
  });
  it("the phone's chat box lists and runs from it", () => {
    expect(remoteSrc).toContain("use:promptBox={{ commands: true }}");
    expect(remoteSrc).toContain('parseCommand(text, "phone")');
    expect(promptBoxSrc).toContain('commandMatches(node.value, "phone")');
  });
});
