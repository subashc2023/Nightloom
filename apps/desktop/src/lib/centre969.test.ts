/**
 * Item 969 (911 D): the bell as a daily digest — one row per day of what the automation did, no number (a dot
 * while something is new), days past 7 dropped, "Mark all seen". Measured on synthetic data shaped like his on
 * 2026-11-25 (916-911 report: 70 dream commits — 10 in the vault, 60 over 7 projects — 52 dream writes with
 * no commit, 10 memory changes, 5 proposals, blockers open in a project, a morning page, a release). Never his
 * real data.
 */
import { describe, expect, it } from "vitest";
import { bellList, buildNotices, daySummary, placesWords, withSeen, type NoticeSources } from "./centre";
import type { AppliedNotice, DreamCommit, MemoryCommit, NightshiftRow, ProposalNotice } from "./types";
import bell from "./NotificationCentre.svelte?raw";

const now = new Date(2026, 10, 25, 5, 30);
/** Local noon `d` days before `now`, as RFC 3339. */
const daysAgo = (d: number, h = 3) => new Date(2026, 10, 25 - d, h, 0).toISOString();
const projects = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `project-${i}` }));

const commits: DreamCommit[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ project: null, repo: "/vault", hash: `v${i}`, at: daysAgo(i), subject: "dream", files: [{ path: `n${i}.md`, added: 3, removed: 1 }] })),
  ...Array.from({ length: 60 }, (_, i) => ({
    project: projects[i % 7],
    repo: `/w/${i % 7}`,
    hash: `c${i}`,
    at: daysAgo(Math.floor(i / 6)),
    subject: "dream",
    files: [
      { path: `notes/a${i}.md`, added: 2, removed: 0 },
      ...(i % 10 === 0 ? [{ path: "AGENTS.md", added: 1, removed: 0 }] : []),
    ],
  })),
];
const entry = (i: number, at: string) => ({ id: `e${i}`, proposal: { v: 1, at, target: { kind: "user" as const }, why: "why", text: "t", from_dream: true, applied: { at } } });
const applied: AppliedNotice[] = Array.from({ length: 52 }, (_, i) => ({ project: projects[i % 7], entry: entry(i, daysAgo(i % 9)) as never, file: "AGENTS.md" }));
const memory: MemoryCommit[] = Array.from({ length: 10 }, (_, i) => ({ hash: `m${i}`, at: daysAgo(i), subject: "sync", files: [{ path: "-Users-x/memory/a.md", added: 1, removed: 0 }], places: ["nightshift-code"] }));
const proposals: ProposalNotice[] = Array.from({ length: 5 }, (_, i) => ({ project: projects[i], entry: { id: `pr${i}`, proposal: { v: 1, at: daysAgo(0), target: { kind: "user" }, why: "w", text: "t", from_dream: true } } as never }));
const rows: NightshiftRow[] = [
  { id: "ns", name: "nightshift-code", workspace: null, exists: true, disabled: null, nightshift: { newest_morning: "2026-11-25.md", open_blockers: 19, held_blockers: 3 } as NightshiftRow["nightshift"] },
];
const sources: NoticeSources = {
  proposals,
  commits,
  applied,
  memory,
  rows,
  read: {},
  stamp: { version: "0.1.0", exe_modified: daysAgo(1, 9) },
  seenStamp: "older",
  dismissed: [],
};

describe("the bell as a daily digest (969)", () => {
  const notices = buildNotices(sources);
  const list = bellList(notices, [], now);

  it("shows at most 7 rows on data shaped like his, against ~140 notices before", () => {
    expect(notices.length).toBeGreaterThanOrEqual(130);
    expect(list.alone.length + list.days.length).toBeLessThanOrEqual(10);
    expect(list.days).toHaveLength(7);
    expect(list.days.map((d) => d.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
  });

  it("drops days older than 7, and lists neither proposals nor blockers (Needs you has them)", () => {
    const keys = list.days.map((d) => d.key);
    expect(keys[keys.length - 1]).toBe("2026-11-19");
    const kinds = new Set(list.days.flatMap((d) => d.notices.map((n) => n.kind)));
    expect(kinds.has("proposal")).toBe(false);
    expect(kinds.has("blocker")).toBe(false);
    expect([...kinds].sort()).toEqual(["dream", "memory", "morning", "release"]);
  });

  it("says each day in one line", () => {
    const today = list.days[0];
    expect(today.summary).toMatch(/^Dreams changed \d+ notes and \d+ instructions files in /);
    expect(today.summary).toContain("Claude Code's memory changed once (1 note)");
    expect(today.summary).toContain("A morning page to read in nightshift-code");
    expect(list.days[1].summary).toContain("A release was installed");
    expect(placesWords(["a"])).toBe("a");
    expect(placesWords(["a", "b"])).toBe("a and b");
    expect(placesWords(["a", "b", "c", "d"])).toBe("a, b and 2 more");
    expect(daySummary([])).toBe("");
  });

  it("wears a dot while a row is new; Mark all seen clears it, and a new row brings it back", () => {
    expect(list.fresh).toBe(true);
    const seen = withSeen([], list.ids);
    const after = bellList(notices, seen, now);
    expect(after.fresh).toBe(false);
    expect(after.days.every((d) => d.fresh === 0)).toBe(true);
    // The rows stay until 7 days old: seen is not dismissed.
    expect(after.days).toHaveLength(7);
    const more = buildNotices({ ...sources, memory: [...memory, { hash: "new", at: daysAgo(0, 5), subject: "s", files: [], places: [] }] });
    expect(bellList(more, seen, now).fresh).toBe(true);
    expect(withSeen(["a"], ["a", "b", "b"])).toEqual(["a", "b"]);
  });

  it("draws no number on the bell, a dot, Mark all seen and Done, in one component for Jarvis and Classic", () => {
    expect(bell).not.toContain("centre-count");
    expect(bell).toMatch(/\{#if bell\.fresh\}<span class="centre-dot"/);
    expect(bell).toContain("Mark all seen");
    expect(bell).toMatch(/onclick=\{\(\) => doneDay\(d\.notices\)\}>Done</);
    expect(bell).toMatch(/:root:not\(\[data-layout="classic"\]\)\)\) \.centre-day-label/);
  });
});
