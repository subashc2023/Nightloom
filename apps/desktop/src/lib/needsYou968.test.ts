/**
 * Item 968 (911 C): the Needs-you number counts only what needs him — held blockers, a chat's question or
 * approval card, a proposal still pending — on every surface. Measured on synthetic data shaped like his on
 * 2026-11-25 (916-911 report: 19 open blockers in one project, 16 of them `default: applied`, 3 held; 24
 * shipped items; one open question and one approval card; 5 proposals pending). Never his real data.
 */
import { describe, expect, it } from "vitest";
import { badgeWords, blockerCounts, groupNeeds, homeNeeds, isHeld, needRows, waitingCount, type NeedSources, type OpenBlocker, type PendingProposal, type ShippedItem } from "./needsYou";
import type { RunEntry } from "./running";
import view from "./NeedsYou.svelte?raw";
import badge from "./NotificationCentre.svelte?raw"; // item 1026: the one button draws the number
import header from "./NightshiftHeader.svelte?raw";
import headerClassic from "./NightshiftHeaderClassic.svelte?raw";
import sidebarLogic from "./sidebar/logic.svelte.ts?raw";
import sheet from "../remote/NightshiftSheet.svelte?raw";

const blockers: OpenBlocker[] = Array.from({ length: 19 }, (_, i) => ({
  project: "ns",
  projectName: "nightshift-code",
  id: String(2270 + i),
  question: `Question ${i}?`,
  guess: "the default",
  held: i < 3,
  raised: "2026-11-24",
}));
const shipped: ShippedItem[] = Array.from({ length: 24 }, (_, i) => ({ project: "ns", projectName: "nightshift-code", id: String(930 + i), title: `Item ${i}`, shipped: "2026-11-24" }));
const proposals: PendingProposal[] = Array.from({ length: 5 }, (_, i) => ({
  id: `proposal:p${i}:e${i}`,
  title: `A change to project ${i}'s instructions`,
  why: "the dream proposed it",
  project: `p${i}`,
  projectName: `project ${i}`,
  at: 1_700_000_000_000 + i,
}));
const card: RunEntry = { id: "turn:c9", kind: "turn", project: "p1", where: "Nightloom", session: "c9", chat: "Wave", doing: "", startedAt: 1, onScreen: false, waiting: true, survivesQuit: false };
const his: NeedSources = {
  runs: [card],
  ended: [{ chat: "c1", name: "AI Safety Collective", project: "p2", projectName: "AISC", at: 5, failed: false, ask: { question: "Which?", options: ["A", "B"] } }],
  here: null,
  blockers,
  shipped,
  proposals,
  running: () => false,
};

describe("Needs you counts only what needs him (968)", () => {
  it("reads 10 on data shaped like his, against 21 before", () => {
    const rows = needRows(his);
    // 3 held + 1 question + 1 card + 5 proposals.
    expect(waitingCount(rows)).toBe(10);
    expect(badgeWords(rows)).toEqual({ n: 10, word: "need you", waiting: true });
    // Before 968 every open blocker waited, and proposals were the bell's: 19 + 2 = 21.
    expect(rows.filter((r) => r.kind === "blocker").length + 2).toBe(21);
  });

  it("folds the 16 defaulted blockers into Decided for you, answerable, and keeps them out of the count", () => {
    const g = groupNeeds(needRows(his));
    expect(g.map((x) => x.state)).toEqual(["waiting", "decided", "review", "working"]);
    const decided = g.find((x) => x.state === "decided")!;
    expect(decided.label).toBe("Decided for you — say if wrong");
    expect(decided.rows).toHaveLength(16);
    expect(decided.rows.every((r) => r.reply === "answer-blocker" && r.detail.startsWith("Went ahead on:"))).toBe(true);
    // An empty Decided group is not drawn.
    expect(groupNeeds(needRows({ ...his, blockers: blockers.slice(0, 3) })).map((x) => x.state)).toEqual(["waiting", "review", "working"]);
  });

  it("lists a pending proposal as waiting, with Review", () => {
    const rows = needRows(his).filter((r) => r.kind === "proposal");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ state: "waiting", tag: "proposal", reply: null, chat: null });
    expect(rows[0].proposal).toBe("proposal:p4:e4");
    expect(view).toMatch(/row\.kind === "proposal"[\s\S]{0,200}reviewProposalRow\(row\)/);
  });

  it("with nothing waiting, the badge says to review without a number", () => {
    const rows = needRows({ ...his, runs: [], ended: [], proposals: [], blockers: blockers.slice(3) });
    expect(waitingCount(rows)).toBe(0);
    expect(badgeWords(rows)).toEqual({ n: 0, word: "to review", waiting: false });
    expect(badge).toMatch(/badge\.n > 0[\s\S]{0,40}class="n"/);
  });

  it("keeps Home's own list as item 945 left it: chat rows only, proposals and blockers not listed", () => {
    const h = homeNeeds(needRows(his));
    expect(h.rows.map((r) => r.kind)).toEqual(["card", "ask"]);
    expect(waitingCount(h.rows)).toBe(2);
    expect(h.blockers).toBe(19);
    expect(h.shipped).toBe(24);
  });

  it("reads a blocker as held only from `default: held`", () => {
    expect(isHeld({ default: "held" })).toBe(true);
    expect(isHeld({ default: " held " })).toBe(true);
    expect(isHeld({ default: "applied" })).toBe(false);
    expect(isHeld({})).toBe(false);
    expect(isHeld(undefined)).toBe(false);
  });

  it("counts a project's blockers from its list, else its row, else every open one held", () => {
    const list = [
      ...Array.from({ length: 3 }, () => ({ status: "open", fields: { default: "held" } })),
      ...Array.from({ length: 16 }, () => ({ status: "open", fields: { default: "applied" } })),
      { status: "answered", fields: { default: "held" } },
    ];
    expect(blockerCounts(list, null)).toEqual({ held: 3, open: 19, decided: 16 });
    expect(blockerCounts(null, { open_blockers: 19, held_blockers: 3 })).toEqual({ held: 3, open: 19, decided: 16 });
    // An older backend without the field: nothing hidden.
    expect(blockerCounts(null, { open_blockers: 4 })).toEqual({ held: 4, open: 4, decided: 0 });
    expect(blockerCounts(null, null)).toEqual({ held: 0, open: 0, decided: 0 });
  });

  it("puts the held number on the Nightshift header (Jarvis and Classic), the sidebar and the phone's list", () => {
    expect(header).toMatch(/heldBlockers > 0[\s\S]{0,300}wait\{heldBlockers === 1/);
    expect(header).toMatch(/<span class="n hot">\{heldBlockers\}<\/span>/);
    expect(headerClassic).toMatch(/bc\.held\} held blocker/);
    expect(sidebarLogic).toMatch(/nightshiftBlockers = \$derived\(blockerCounts\(null, openRow\?\.nightshift\)\.held\)/);
    expect(sheet).toMatch(/p\.held_blockers \?\? p\.open_blockers/);
  });
});
