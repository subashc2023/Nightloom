// Item 739: what the Mac's window tells the phone's push — the chat, its
// name and the state; never the reply, whatever the banner's own rules say.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushed = vi.fn((..._a: unknown[]) => Promise.resolve(null));
const banner = vi.fn((..._a: unknown[]) => Promise.resolve(null));
vi.mock("./api", () => ({
  notify: (t: string, b: string) => banner(t, b),
  pushNote: (what: string, chat: string | null, label: string | null, project: string | null) => pushed(what, chat, label, project),
}));

import { notifyNeedsYou, notifyTurnEnd, pushWhatForCall, pushWhatForEnd } from "./notify";
import type { ApprovalRequest } from "./types";

const off = { turnEnd: false, needsYou: false, usageRefresh: false };
const call = (name: string, chat?: string): ApprovalRequest => ({ id: "t1", name, input: { command: "rm -rf build" }, effect: "mutating", chat }) as ApprovalRequest;

beforeEach(() => {
  pushed.mockClear();
  banner.mockClear();
});

describe("what the phone's push says", () => {
  it("names a turn's end: the limit before failed, failed before finished", () => {
    expect(pushWhatForEnd({ error: null })).toBe("done");
    expect(pushWhatForEnd({ error: "boom" })).toBe("failed");
    expect(pushWhatForEnd({ error: null, cliError: true })).toBe("failed");
    expect(pushWhatForEnd({ error: "boom", limit: true })).toBe("limit");
  });

  it("names a waiting call: a question or a plan is his answer, the rest an approval", () => {
    expect(pushWhatForCall({ name: "AskUserQuestion" })).toBe("question");
    expect(pushWhatForCall({ name: "ExitPlanMode" })).toBe("question");
    expect(pushWhatForCall({ name: "Bash" })).toBe("approval");
  });
});

describe("the window hands the phone its push", () => {
  it("at a turn's end, with the banner's switch off — and never the error's text", async () => {
    await notifyTurnEnd({ chat: "Fix the tab drag", segs: [], outTokens: 10, elapsedMs: 1000, error: "secret path /Users/x failed", prefs: off, phone: { chat: "c1", project: "p1", limit: false, cliError: false } });
    expect(pushed.mock.calls).toEqual([["failed", "c1", "Fix the tab drag", "p1"]]);
    expect(banner).not.toHaveBeenCalled();
  });

  it("not for a turn he stopped himself (739 review L5)", async () => {
    await notifyTurnEnd({ chat: "Fix the tab drag", segs: [], outTokens: 10, elapsedMs: 1000, error: null, prefs: off, phone: { chat: "c1", project: "p1", limit: false, cliError: false, stopped: true } });
    await notifyTurnEnd({ chat: "Fix the tab drag", segs: [], outTokens: 10, elapsedMs: 1000, error: "cancelled", prefs: off, phone: { chat: "c1", project: "p1", limit: false, cliError: false, stopped: true } });
    expect(pushed).not.toHaveBeenCalled();
  });

  it("not for an end that is no chat's turn", async () => {
    await notifyTurnEnd({ chat: "x", segs: [], outTokens: null, elapsedMs: null, error: null, prefs: off });
    expect(pushed).not.toHaveBeenCalled();
  });

  it("for a waiting call, with its chat and none of its input", async () => {
    await notifyNeedsYou("Plans", call("Bash", "c2"), off);
    await notifyNeedsYou("Plans", call("AskUserQuestion"), off);
    expect(pushed.mock.calls).toEqual([
      ["approval", "c2", "Plans", null],
      ["question", null, "Plans", null],
    ]);
    expect(JSON.stringify(pushed.mock.calls)).not.toContain("rm -rf");
  });
});
