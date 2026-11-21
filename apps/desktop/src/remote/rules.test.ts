import { describe, expect, it } from "vitest";
import { asideKey, blankForm, editOf, formOf, formProblem, grouped, matchHint, MCP, removeWords, ruleLine, scopeLabel, textLabel, type RuleRow } from "./rules";

const TOOLS = ["Bash", "Write", "WebFetch"];
const row = (over: Partial<RuleRow> = {}): RuleRow => ({ id: "c1", action: "allow", tool: "Bash", text: "git status", scope: "chat", source: "rule", ...over });

describe("the rules sheet (item 743)", () => {
  it("groups rows in the order the host decides them, and leaves an empty head out", () => {
    const g = grouped([row(), row({ id: "a1", action: "block", scope: "all", text: "sudo" })]);
    expect(g.map((x) => x.head)).toEqual(["Blocked", "Allowed"]);
    expect(g[0].rows[0].id).toBe("a1");
    expect(grouped([])).toEqual([]);
  });

  it("says a row in one line and where it applies", () => {
    expect(ruleLine(row())).toBe("Bash · git status");
    expect(ruleLine(row({ text: "  " }))).toBe("Bash · every call");
    expect(scopeLabel(row())).toBe("This chat");
    expect(scopeLabel(row({ scope: "all" }))).toBe("Every chat · Mac and Away");
    expect(scopeLabel(row({ source: "grant" }))).toContain("Allow for this chat");
  });

  it("a new rule starts as an ask, for this chat when one is open", () => {
    expect(blankForm(true)).toMatchObject({ id: null, action: "ask", scope: "chat" });
    expect(blankForm(false).scope).toBe("all");
  });

  it("a form becomes an add or a change, trimmed", () => {
    const f = { ...blankForm(true), action: "block" as const, text: "  rm -rf  " };
    expect(editOf(f)).toEqual({ op: "add", scope: "chat", action: "block", tool: "Bash", text: "rm -rf" });
    const changed = { ...formOf(row(), TOOLS), action: "ask" as const };
    expect(editOf(changed)).toEqual({ op: "change", id: "c1", action: "ask", tool: "Bash", text: "git status" });
  });

  it("a connector's tool is typed by name, and must look like one", () => {
    const f = formOf(row({ tool: "mcp__github__create_issue", text: "" }), TOOLS);
    expect(f).toMatchObject({ tool: MCP, mcp: "mcp__github__create_issue" });
    expect(formProblem(f)).toBeNull();
    expect(formProblem({ ...f, mcp: "" })).toContain("Name the connector tool");
    expect(formProblem({ ...f, mcp: "github" })).toContain("starts with mcp__");
    expect(editOf(f)).toMatchObject({ tool: "mcp__github__create_issue" });
    expect(formProblem(blankForm(true))).toBeNull();
  });

  it("the hint says the narrower match of an allow on Bash", () => {
    expect(matchHint("allow", "Bash")).toContain("starts with");
    expect(matchHint("block", "Bash")).toContain("anywhere");
    expect(matchHint("allow", "Write")).toContain("anywhere");
    expect(textLabel("Bash")).toBe("the command");
    expect(textLabel("Write")).toBe("the file's path");
    expect(textLabel("mcp__x__y")).toBe("the call's input");
  });

  it("the remove confirm says what happens to those calls next", () => {
    expect(removeWords(row())).toBe("Bash calls naming “git status” will ask you again in this chat.");
    expect(removeWords(row({ action: "block", text: "" }))).toContain("no longer be blocked");
    expect(removeWords(row({ action: "ask", scope: "all" }))).toContain("an allow rule that names them applies again");
  });

  it("a set-aside call is remembered by its tool and input", () => {
    expect(asideKey("Bash", { command: "ls" })).toBe(asideKey("Bash", { command: "ls" }));
    expect(asideKey("Bash", { command: "ls" })).not.toBe(asideKey("Bash", { command: "ls -a" }));
    expect(asideKey("Bash", undefined)).toBe(asideKey("Bash", null));
  });
});

// Item 783: one rule set for both hosts, and the read-only chat's allowed actions.
import { connectorWords as words783, removeWords as remove783, scopeLabel as scope783 } from "./rules";
describe("783: shared rules and read-only allowances", () => {
  it("says an every-chat rule is on both hosts, and where a read-only allowance came from", () => {
    expect(scope783({ scope: "all", source: "rule" })).toBe("Every chat · Mac and Away");
    expect(scope783({ scope: "chat", source: "rule" })).toBe("This chat");
    expect(scope783({ scope: "all", source: "read" })).toBe("Read-only chats · from “Allow always”");
  });
  it("removing a read-only allowance says the action asks again", () => {
    const row = { id: "read:mcp__x__inspect", action: "allow" as const, tool: "mcp__x__inspect", text: "", scope: "all" as const, source: "read" as const };
    expect(remove783(row)).toBe("mcp__x__inspect calls will ask you again in read-only chats, on the Mac and Away.");
  });
  it("names a connector action in plain words", () => {
    expect(words783("mcp__claude_ai_Gmail__send_message")).toBe("Gmail · send message");
    expect(words783("mcp__claude_ai_Google_Drive__share_file")).toBe("Google Drive · share file");
    expect(words783("Bash")).toBe("Bash");
    // Item 872: Nightloom's own gated tool reads as its words alone.
    expect(words783("mcp__nightloom__update_reminders")).toBe("update reminders");
  });
});
