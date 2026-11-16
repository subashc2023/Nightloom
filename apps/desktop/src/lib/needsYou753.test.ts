import { describe, expect, it } from "vitest";
import { badgeWords, followUpTitle, groupNeeds, needRows, parseEnded, trimEnded, waitingCount, type EndedTurn, type NeedSources } from "./needsYou";
import type { RunEntry } from "./running";
import view from "./NeedsYou.svelte?raw";
import app from "../App.svelte?raw";
import jarvis from "./Transcript.svelte?raw";
import classic from "./TranscriptClassic.svelte?raw";

const run = (over: Partial<RunEntry>): RunEntry => ({
  id: "turn:c1",
  kind: "turn",
  project: "p1",
  where: "Nightloom",
  session: "c1",
  chat: "Wave F",
  doing: "running Bash",
  startedAt: 1000,
  onScreen: false,
  waiting: false,
  survivesQuit: false,
  ...over,
});
const ended = (over: Partial<EndedTurn>): EndedTurn => ({ chat: "c2", name: "Merge", project: "p1", projectName: "Nightloom", at: 2000, failed: false, ask: null, ...over });
const base: NeedSources = { runs: [], ended: [], here: null, blockers: [], shipped: [], running: () => false };
const ask = { question: "Roll now?", options: ["Yes", "After lunch"] };

describe("the Needs-you view's rows (753)", () => {
  it("groups everything by state: waiting, review, working", () => {
    const rows = needRows({
      ...base,
      runs: [run({}), run({ id: "turn:c9", session: "c9", chat: "Asks", waiting: true }), run({ id: "sub:1", kind: "subagent", chat: "Wave F", doing: "reading files" })],
      ended: [ended({}), ended({ chat: "c3", name: "Asked", ask, at: 3000 }), ended({ chat: "c4", name: "Broke", failed: true, at: 2500 })],
      blockers: [
        { project: "p1", projectName: "Nightloom", id: "1220", question: "Auto-restart?", guess: "Yes", held: false, raised: "" },
        { project: "p1", projectName: "Nightloom", id: "1300", question: "Spend it?", guess: "", held: true, raised: "" },
      ],
      shipped: [{ project: "p1", projectName: "Nightloom", id: "712", title: "Comment button", shipped: "2026-11-16" }],
    });
    const g = groupNeeds(rows);
    expect(g.map((x) => x.label)).toEqual(["Waiting on you", "Ready for review", "Working"]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["card:turn:c9", "ask:c3", "blocker:p1:1300", "blocker:p1:1220"]);
    expect(g[1].rows.map((r) => r.id)).toEqual(["done:c4", "done:c2", "shipped:p1:712"]);
    expect(g[2].rows.map((r) => r.tag)).toEqual(["turn", "subagent"]);
    expect(waitingCount(rows)).toBe(4);
    // Each row that takes words says what its reply does.
    expect(g[0].rows.map((r) => r.reply)).toEqual([null, "answer-ask", "answer-blocker", "answer-blocker"]);
    expect(g[1].rows.map((r) => r.reply)).toEqual(["message", "message", "follow-up"]);
    expect(g[0].rows[2].tag).toBe("held blocker 1300");
  });

  it("lists the chat on screen's question once, and drops rows of a chat that runs again", () => {
    const here = { chat: "c3", name: "Asked", project: "p1", projectName: "Nightloom", ask };
    const rows = needRows({ ...base, here, ended: [ended({ chat: "c3", ask }), ended({ chat: "c5", ask })], running: (c) => c === "c5" });
    expect(rows.map((r) => r.id)).toEqual(["ask:c3"]);
    expect(needRows({ ...base, here, running: () => true })).toEqual([]);
  });

  it("words the badge: what waits first, then what is ready", () => {
    expect(badgeWords([])).toBeNull();
    expect(badgeWords(needRows({ ...base, ended: [ended({})] }))).toEqual({ n: 1, word: "to review", waiting: false });
    expect(badgeWords(needRows({ ...base, ended: [ended({}), ended({ chat: "c3", ask })] }))).toEqual({ n: 1, word: "needs you", waiting: true });
  });

  it("keeps his words whole in a follow-up, and the kept turns bounded", () => {
    expect(followUpTitle("712", "Comment button", "the  tip\nis cut off")).toBe("Follow-up to 712 (Comment button): the tip is cut off");
    const many = Array.from({ length: 80 }, (_, i) => ended({ chat: `c${i}`, at: i }));
    const kept = trimEnded([...many, ended({ chat: "old-ask", at: -5, ask })], 60);
    expect(kept).toHaveLength(60);
    expect(kept[0].chat).toBe("old-ask");
    expect(parseEnded("not json")).toEqual([]);
    expect(parseEnded(JSON.stringify([ended({}), { nope: 1 }]))).toHaveLength(1);
  });

  it("is mounted: the view over the app, the card under both transcripts", () => {
    expect(app).toContain("<NeedsYou />");
    for (const src of [jarvis, classic]) expect(src).toContain("<TurnAskHost");
    // Every group draws, an empty one in words; a reply box per row that takes words.
    expect(view).toContain("NEED_EMPTY");
    expect(view).toContain("row.reply");
  });
});
