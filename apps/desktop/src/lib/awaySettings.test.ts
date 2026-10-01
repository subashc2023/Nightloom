import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  awayHeadline,
  clock12,
  markedLine,
  orderedProjects,
  selfTestLine,
  tokenLine,
  urlProblem,
  type AwayStatus,
} from "./awaySettings";

function status(over: Partial<AwayStatus> = {}): AwayStatus {
  return {
    url: "https://nightloom-away-swaraag.fly.dev",
    token_found: true,
    token_path: "/Users/x/.nightloom/remote/away-token",
    running: false,
    last_push: null,
    last_pull: null,
    last_error: null,
    last_summary: null,
    interval_minutes: 15,
    projects: [],
    ...over,
  };
}

describe("clock12", () => {
  const now = new Date(2026, 8, 30, 15, 0);
  it("writes today's times in 12-hour form with AM/PM", () => {
    expect(clock12(new Date(2026, 8, 30, 14, 58).toISOString(), now)).toBe("2:58 PM");
    expect(clock12(new Date(2026, 8, 30, 0, 5).toISOString(), now)).toBe("12:05 AM");
    expect(clock12(new Date(2026, 8, 30, 12, 0).toISOString(), now)).toBe("12:00 PM");
  });
  it("names the day when it is not today, and never for none", () => {
    expect(clock12(new Date(2026, 8, 29, 23, 4).toISOString(), now)).toBe("Sep 29, 11:04 PM");
    expect(clock12(null, now)).toBe("never");
    expect(clock12("not a time", now)).toBe("never");
  });
  it("never writes a 24-hour time", () => {
    for (let h = 0; h < 24; h++) {
      const s = clock12(new Date(2026, 8, 30, h, 30).toISOString(), now);
      expect(s).toMatch(/^(1[0-2]|[1-9]):30 (AM|PM)$/);
    }
  });
});

describe("the away card's lines", () => {
  it("says off, no token, running, failed, never, or the last time", () => {
    expect(awayHeadline(status({ url: "" }))).toMatch(/^off/);
    expect(awayHeadline(status({ token_found: false }))).toMatch(/no token/);
    expect(awayHeadline(status({ running: true }))).toBe("syncing now…");
    expect(awayHeadline(status({ last_error: "x", last_push: "2026-09-30T10:00:00Z" }))).toMatch(/failed/);
    expect(awayHeadline(status())).toBe("not synced yet");
    expect(awayHeadline(status({ last_push: new Date().toISOString() }))).toMatch(/^synced at \d{1,2}:\d\d (AM|PM)$/);
  });
  it("shows whether the token was found, never a value", () => {
    expect(tokenLine(status())).toBe("token found (/Users/x/.nightloom/remote/away-token)");
    expect(tokenLine(status({ token_found: false }))).toMatch(/^no token at /);
    // The status carries no token field at all.
    expect(Object.keys(status())).not.toContain("token");
  });
  it("takes an empty address (off) or http(s), nothing else", () => {
    expect(urlProblem("")).toBeNull();
    expect(urlProblem("https://nightloom-away-swaraag.fly.dev")).toBeNull();
    expect(urlProblem("http://127.0.0.1:8642")).toBeNull();
    expect(urlProblem("nightloom-away-swaraag.fly.dev")).toMatch(/https/);
    expect(urlProblem("ftp://x")).toMatch(/https/);
  });
});

describe("the project list", () => {
  const projects = [
    { id: "a", name: "Zeta", available: false },
    { id: "b", name: "Alpha", available: false },
    { id: "c", name: "Nightloom", available: true },
  ];
  it("puts marked projects first, then by name, and filters by name", () => {
    expect(orderedProjects(projects).map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(orderedProjects(projects, "ze").map((p) => p.id)).toEqual(["a"]);
    // The input is not reordered.
    expect(projects.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
  it("counts what goes up", () => {
    expect(markedLine(projects)).toBe("1 of 3 projects available away.");
    expect(markedLine([])).toMatch(/only memory and the vault/);
  });
});

describe("Test from this Mac", () => {
  it("says the time or the reason", () => {
    expect(selfTestLine({ ok: true, ms: 7, message: "answers in 7 ms at u" })).toBe("Answers in 7 ms.");
    expect(selfTestLine({ ok: false, ms: null, message: "the listener is off" })).toBe(
      "Does not answer: the listener is off",
    );
    expect(selfTestLine(null)).toBe("");
  });
});
