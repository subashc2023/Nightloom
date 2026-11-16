import { describe, expect, it } from "vitest";
import {
  artifactsOf,
  artifactsSummary,
  artifactsText,
  buildCarry,
  CARRIED_HEAD,
  carriedBlock,
  commonDir,
  composeFirstMessage,
  costText,
  GOAL_ASK,
  isWrapUpText,
  parseCarried,
  quotedShare,
  quoteWords,
  SECTIONS,
  SECTIONS_MARK,
  sectionsAddendum,
  shellPaths,
  shingles,
  splitGoal,
  whenText,
  wrapUpWithSections,
} from "./handoffCarry";
import type { ContentBlock, SessionEvent } from "./types";

const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 12, min)).toISOString();
const user = (text: string, min = 0): SessionEvent => ({ event: "user_message", text, at: at(min) });
const say = (blocks: ContentBlock[], min = 0, usage = { input_tokens: 1000, output_tokens: 100 }): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks,
  stop_reason: "end_turn",
  usage,
  at: at(min),
});
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown): ContentBlock => ({ type: "tool_use", id, name, input });
const result = (id: string, name: string, content: string, is_error = false): SessionEvent => ({
  event: "tool_result",
  tool_use_id: id,
  name,
  content,
  is_error,
  at: at(0),
});
const allLive = (events: SessionEvent[]) => events.map(() => true);

describe("747: the wrap-up goes out with the fixed sections and his goal", () => {
  it("adds the sections under any message, once, and the goal in his words", () => {
    const sent = wrapUpWithSections("Wrap it up, my way.", "  ship the\n card ", true);
    expect(sent.startsWith("Wrap it up, my way.\n\n" + SECTIONS_MARK)).toBe(true);
    for (const s of SECTIONS) expect(sent).toContain(s.split(" (")[0]);
    expect(sent).toContain("my exact words in quotation marks");
    expect(sent.endsWith(`${GOAL_ASK} ship the card`)).toBe(true);
    // A chat's own copy that already holds the addendum is not given a second.
    expect(wrapUpWithSections(sent, "", true)).toBe(sent);
    expect(wrapUpWithSections(sent, "", true).split(SECTIONS_MARK)).toHaveLength(2);
  });
  it("a blank message stays blank, and no goal adds no goal line", () => {
    expect(wrapUpWithSections("  ", "a goal", true)).toBe("  ");
    expect(wrapUpWithSections("Wrap up.", " ", true)).not.toContain(GOAL_ASK);
  });
  it("a thread chat with no HANDOFF.md is asked for the goal and his words in the prompt only", () => {
    const t = sectionsAddendum(false);
    expect(t).toContain('"Goal: "');
    expect(t).toContain("my exact words");
    expect(t).not.toContain("HANDOFF.md section");
    expect(sectionsAddendum(true)).toContain("HANDOFF.md section");
  });
  it("knows a wrap-up from his own message", () => {
    expect(isWrapUpText(wrapUpWithSections("anything", "", true))).toBe(true);
    expect(isWrapUpText("This chat's context window is nearly full, so let's hand off to a new chat.")).toBe(true);
    expect(isWrapUpText("This chat's context is filling, so let's hand off")).toBe(true);
    expect(isWrapUpText("don't touch the context window code")).toBe(false);
  });
});

describe("747: whether the hand-off quotes a message", () => {
  const handoff = 'He said: "never push to main without asking me first, and keep the old flag working." Next: the parser.';
  const words = quoteWords(handoff).join(" ");
  const set = shingles(handoff);
  it("a repeated run of eight words counts; a paraphrase does not", () => {
    expect(quotedShare("Never push to main without asking me first, and keep the old flag working.", words, set)).toBe(1);
    expect(quotedShare("Please do not push to the main branch unless I have said yes to it beforehand", words, set)).toBe(0);
  });
  it("a long message quoted in part is measured by its share of words", () => {
    const long = "never push to main without asking me first, and keep the old flag working. " + "also something else entirely ".repeat(10);
    const share = quotedShare(long, words, set);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.5);
  });
  it("a short message is quoted only whole, on word edges", () => {
    expect(quotedShare("the parser", words, set)).toBe(1);
    expect(quotedShare("the pars", words, set)).toBe(0);
    expect(quotedShare("stop suggesting rebases", words, set)).toBe(0);
  });
  it("curly quotes, case and punctuation do not hide a quotation", () => {
    expect(quotedShare("NEVER push to main — without asking me first, and keep the old flag working", "", shingles("never push to main - without asking me first and keep the old flag working"))).toBe(1);
  });
});

describe("747: the carried block round-trips", () => {
  it("his words go out dated and come back whole, blank lines and all", () => {
    const items = [
      { when: "Nov 16, 2026, 2:58 PM", text: "don't touch prompt.rs\n\nand never quit the app" },
      { when: "Nov 15, 2026, 11:05 PM", text: "> a quote of his own\n- [not a head]" },
    ];
    const block = carriedBlock(items);
    expect(block.startsWith(CARRIED_HEAD)).toBe(true);
    expect(parseCarried(`Goal: x\n\nRead HANDOFF.md.\n\n${block}\n\nFrom the previous chat's tool calls:\nFiles edited (1): a.ts`)).toEqual(items);
    expect(parseCarried("no block here")).toEqual([]);
    expect(carriedBlock([])).toBe("");
  });
});

describe("747: the artifact list is read from the tool calls", () => {
  const root = "/Users/you/proj/";
  const events: SessionEvent[] = [
    { event: "session_created", id: "c", at: at(0) },
    user("start"),
    say([
      call("r1", "Read", { file_path: root + "src/a.ts" }),
      call("r2", "Read", { file_path: root + "src/a.ts" }),
      call("r3", "Read", { file_path: root + "backlog/747-hand-off.md" }),
      call("e1", "Edit", { file_path: root + "src/a.ts", old_string: "x", new_string: "y" }),
      call("e2", "Write", { file_path: root + "src/b.ts", content: "z" }),
      call("e3", "Edit", { file_path: root + "src/fail.ts", old_string: "x", new_string: "y" }),
      call("b1", "Bash", { command: "sed -n 1,40p notes/plan.md && python3 bin/run.py --out /tmp/x.json; curl https://api.example.com/v1/runs.json; git commit -m x" }),
      call("a1", "Agent", { description: "Survey the logs", prompt: "Write notes/wave-d-handoff-report-2026-11-16.md", subagent_type: "reusable" }),
    ]),
    result("e3", "Edit", "String to replace not found", true),
    result("b1", "Bash", "[dk-handoff 1a2b3c4d] 747 + 705: the card carries more\n 3 files changed"),
    result("a1", "Agent", "Report at notes/wave-d-handoff-report-2026-11-16.md and blockers/1220-night.md"),
    say([call("e4", "Edit", { file_path: root + "src/a.ts", old_string: "y", new_string: "w" })]),
  ];
  const a = artifactsOf(events, allLive(events), events.length - 1);
  it("files by calls, failed calls left out", () => {
    expect(a.edited).toEqual([
      { path: root + "src/a.ts", count: 2 },
      { path: root + "src/b.ts", count: 1 },
    ]);
    expect(a.read[0]).toEqual({ path: root + "src/a.ts", count: 2 });
  });
  it("commits, subagent reports, and the items a path or a subject names", () => {
    expect(a.commits).toEqual([{ sha: "1a2b3c4d", subject: "747 + 705: the card carries more" }]);
    expect(a.subagents).toEqual([{ description: "Survey the logs", reports: ["notes/wave-d-handoff-report-2026-11-16.md"] }]);
    expect(a.items).toEqual(["backlog 705", "backlog 747"]);
  });
  it("stops at the reply it is asked about, and skips what a rewind superseded", () => {
    expect(artifactsOf(events, allLive(events), 2).edited.find((f) => f.path.endsWith("a.ts"))?.count).toBe(1);
    const live = allLive(events);
    live[events.length - 1] = false;
    expect(artifactsOf(events, live, events.length - 1).edited[0].count).toBe(1);
  });
  it("is written for the next chat with paths under their shared folder", () => {
    const t = artifactsText(a);
    expect(t).toContain(`Paths are under ${root}`);
    expect(t).toContain("Files edited (2): src/a.ts ×2, src/b.ts");
    expect(t).toContain("- 1a2b3c4d 747 + 705: the card carries more");
    expect(t).toContain("- Survey the logs — report: notes/wave-d-handoff-report-2026-11-16.md");
    expect(t).toContain("Items touched: backlog 705, backlog 747");
    expect(t).toContain("Files named most in shell commands (of 3): /tmp/x.json, bin/run.py, notes/plan.md");
    expect(artifactsSummary(a)).toBe("2 files edited · 2 files read · 3 files in shell commands · 1 commit · 1 subagent · 2 items");
    expect(artifactsText(artifactsOf([], [], 0))).toBe("");
  });
  it("reads file paths out of a shell command, not URLs or flags", () => {
    expect(shellPaths("awk 'NR>=8 && NR<17' 736-survey-B1-2026-11-16.md; cat ../../backlog/747-x.md ~/.claude/a.json")).toEqual([
      "736-survey-B1-2026-11-16.md",
      "../../backlog/747-x.md",
      "~/.claude/a.json",
    ]);
    expect(shellPaths("curl -s https://api.github.com/repos/x/y/runs.json --max-time 5")).toEqual([]);
    expect(shellPaths("cargo test -p nightloom-service -j 2")).toEqual([]);
  });
  it("names no shared folder for one path or unrelated ones", () => {
    expect(commonDir(["/a/b/c.ts"])).toBe("");
    expect(commonDir(["/a/b/c.ts", "/x/y.ts"])).toBe("");
    expect(commonDir(["/a/b/c.ts", "/a/b/d/e.ts"])).toBe("/a/b/");
  });
});

describe("747: the goal line and the first message", () => {
  it("reads the prompt's own goal, in the shapes a model writes it", () => {
    expect(splitGoal("Goal: ship 747\n\nRead HANDOFF.md.")).toEqual({ goal: "ship 747", body: "Read HANDOFF.md." });
    expect(splitGoal("**Goal:** ship 747\nRead.")).toEqual({ goal: "ship 747", body: "Read." });
    expect(splitGoal("Read HANDOFF.md.\nGoal: later")).toEqual({ goal: "", body: "Read HANDOFF.md.\nGoal: later" });
  });

  const handoffMd =
    "## STATE AS OF Nov 16\n### Goal\nship\n### His instructions in this chat (verbatim, dated)\n" +
    '- [Nov 16] "never push to main without asking me first, and keep the old flag working"\n' +
    "### Done / In progress / Blocked\n### Decisions\n### Next steps\n1. x";
  const events: SessionEvent[] = [
    { event: "session_created", id: "c2", at: at(0), forked_from: { session: "c1", index: 9, reason: "handoff" } as never },
    user(`Goal: older\n\nRead things.\n\n${carriedBlock([{ when: "Nov 14, 2026, 9:00 AM", text: "always use bin/snap, never Chrome" }])}`, 1),
    say([text("ok")], 2),
    user("never push to main without asking me first, and keep the old flag working", 3),
    say([text("ok")], 4),
    user("stop suggesting rebases", 5),
    say([text("ok")], 6),
    user("removed one", 7),
    user("This chat's context window is nearly full, so let's hand off to a new chat.", 10),
    say([call("w1", "Edit", { file_path: "/p/HANDOFF.md", old_string: "", new_string: handoffMd })], 11, {
      input_tokens: 300_000,
      output_tokens: 2000,
      cache_read_tokens: 290_000,
    } as never),
    result("w1", "Edit", "ok"),
    say([text("Done.\n\n<handoff>\nGoal: ship 747\n\nRead the newest HANDOFF.md section.\n</handoff>")], 12, {
      input_tokens: 302_000,
      output_tokens: 500,
      cache_read_tokens: 300_000,
    } as never),
  ];
  const elided = events.map((_, i) => i === 7);
  const carry = buildCarry({
    events,
    live: allLive(events),
    reply: events.length - 1,
    prompt: "Goal: ship 747\n\nRead the newest HANDOFF.md section.",
    elided,
  });

  it("lists only his messages the hand-off does not quote, carried ones first", () => {
    expect(carry.goal).toBe("ship 747");
    expect(carry.messages).toBe(3);
    expect(carry.quoted).toBe(1);
    expect(carry.unquoted.map((m) => [m.text, m.carried])).toEqual([
      ["always use bin/snap, never Chrome", true],
      ["stop suggesting rebases", false],
    ]);
    expect(carry.unquoted[1].id).toBe("m5");
    expect(carry.unquoted[1].when).toBe(whenText(at(5)));
  });
  it("checks the fixed sections against what the turn wrote to HANDOFF.md", () => {
    expect(carry.missing).toEqual(["Critical context"]);
    const none = buildCarry({ events: events.slice(0, 5), live: allLive(events.slice(0, 5)), reply: 4, prompt: "x" });
    expect(none.missing).toBeNull();
  });
  it("adds up what the wrap-up cost", () => {
    expect(carry.cost).toMatchObject({ requests: 2, output: 2500, input: 602_000, cacheRead: 590_000, seconds: 120, dollars: null });
    expect(costText(carry.cost)).toBe("The wrap-up cost 2 requests, 2.5k tokens written, 602k read (590k from cache), 2m 0s");
    expect(costText(null)).toBe("");
  });
  it("sends the goal, the prompt, his ticked words and the list; carried ones go unless unticked", () => {
    const sent = composeFirstMessage(carry, null, {});
    expect(sent.startsWith("Goal: ship 747\n\nRead the newest HANDOFF.md section.\n\n" + CARRIED_HEAD)).toBe(true);
    expect(parseCarried(sent)).toEqual([{ when: "Nov 14, 2026, 9:00 AM", text: "always use bin/snap, never Chrome" }]);
    expect(sent).toContain("Files edited (1): /p/HANDOFF.md");
    expect(sent).toContain("The wrap-up cost 2 requests");

    const ticked = composeFirstMessage(carry, "ship 747 and 705", { m5: true, [carry.unquoted[0].id]: false });
    expect(ticked.startsWith("Goal: ship 747 and 705\n\n")).toBe(true);
    expect(parseCarried(ticked)).toEqual([{ when: whenText(at(5)), text: "stop suggesting rebases" }]);
    // A goal he emptied sends none.
    expect(composeFirstMessage(carry, " ", {}).startsWith("Read the newest")).toBe(true);
  });
  it("with nothing to add, the prompt goes as it was", () => {
    const bare: SessionEvent[] = [{ event: "session_created", id: "c", at: at(0) }, user("hand off please", 1), say([text("<handoff>\nRead a.\n</handoff>")], 2)];
    const c = buildCarry({ events: bare, live: allLive(bare), reply: 2, prompt: "Read a." });
    expect(c.messages).toBe(0);
    expect(composeFirstMessage(c, null, {})).toBe("Read a.");
  });
});
