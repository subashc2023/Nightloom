import { describe, expect, it } from "vitest";
import { dueResumes, limitResumeTime, nextResumeAt, readResumes, RETRY_AFTER_MS, writeResumes, type ChatResume } from "./chatResume";
import { RESUME_MARGIN_MS } from "./limit";

// Item 543a: each paused chat has its own entry and its own time.

const NOW = 1_800_000_000_000;
const entry = (chat: string, at: number | null): ChatResume => ({
  chat,
  project: { id: "p1", name: "Project" },
  at,
  why: "limit",
  text: "continue",
  pause: { session: chat, resetsAtMs: at, window: "five_hour", text: "limit", subagents: [], agents: [], hitAtMs: NOW },
});

describe("543a — when a limit pause resumes by itself", () => {
  it("at the reset plus the margin", () => {
    expect(limitResumeTime({ resetsAtMs: NOW + 3600_000 }, NOW)).toBe(NOW + 3600_000 + RESUME_MARGIN_MS);
  });
  it("never by itself when the CLI named no reset", () => {
    expect(limitResumeTime({ resetsAtMs: null }, NOW)).toBeNull();
  });
  it("a reset already past goes after the margin — but a chat that just resumed into the limit again waits, never a loop", () => {
    expect(limitResumeTime({ resetsAtMs: NOW - 60_000 }, NOW)).toBe(NOW + RESUME_MARGIN_MS);
    expect(limitResumeTime({ resetsAtMs: NOW - 60_000 }, NOW, NOW - 5_000)).toBe(NOW + RETRY_AFTER_MS);
    // A reset still ahead is taken as given, however recent the last resume.
    expect(limitResumeTime({ resetsAtMs: NOW + 1000 }, NOW, NOW - 5_000)).toBe(NOW + 1000 + RESUME_MARGIN_MS);
  });
});

describe("543a — many entries, one clock", () => {
  const map = { a: entry("a", NOW + 50_000), b: entry("b", NOW + 10_000), c: entry("c", null) };
  it("the clock is armed for the earliest; a cancelled entry has no time", () => {
    expect(nextResumeAt(map)).toBe(NOW + 10_000);
    expect(nextResumeAt({ c: entry("c", null) })).toBeNull();
  });
  it("every entry whose time has come is due, earliest first", () => {
    expect(dueResumes(map, NOW).map((r) => r.chat)).toEqual([]);
    expect(dueResumes(map, NOW + 10_000).map((r) => r.chat)).toEqual(["b"]);
    expect(dueResumes(map, NOW + 60_000).map((r) => r.chat)).toEqual(["b", "a"]);
  });
});

describe("543a — the entries survive a relaunch", () => {
  it("round-trips, and drops what is malformed", () => {
    const map = { a: entry("a", NOW + 500), c: { ...entry("c", null), note: "its project is not open" } };
    expect(readResumes(writeResumes(map))).toEqual(map);
    expect(readResumes(null)).toEqual({});
    expect(readResumes("not json")).toEqual({});
    expect(readResumes(JSON.stringify({ x: { why: "limit", text: "" }, y: { why: "other", text: "t" }, z: 3 }))).toEqual({});
  });
});
