import { describe, expect, it } from "vitest";
import { RESUME_MARGIN_MS, limitPauseFrom, pauseLabel, resumeDelayMs, resumeMessage } from "./limit";

// A turn paused by the usage limit (nightshift backlog 164, pass 1): the
// mark, the reset, the one Resume that never runs into an exhausted
// window, and what it sends.
describe("the limit pause (backlog 164)", () => {
  const now = Date.parse("2026-09-18T02:31:35Z");
  const resets = 1789714200; // 06:50Z, the CLI's figure from his chat
  const res = {
    limit: { resets_at: resets, window: "five_hour", text: "You've hit your session limit · resets 11:50pm (America/Los_Angeles)", subagents: ["toolu_01Lg"] },
  };

  it("reads the pause off the turn's result, and nothing off an ordinary end", () => {
    const p = limitPauseFrom(res, "chat1", now)!;
    expect(p.session).toBe("chat1");
    expect(p.resetsAtMs).toBe(resets * 1000);
    expect(p.window).toBe("five_hour");
    expect(p.subagents).toEqual(["toolu_01Lg"]);
    expect(limitPauseFrom({ limit: null }, "chat1", now)).toBeNull();
  });

  it("waits for the reset plus the margin, and not at all after it", () => {
    const p = limitPauseFrom(res, null, now)!;
    expect(resumeDelayMs(p, now)).toBe(resets * 1000 + RESUME_MARGIN_MS - now);
    expect(resumeDelayMs(p, resets * 1000 + RESUME_MARGIN_MS)).toBe(0);
    expect(resumeDelayMs(p, resets * 1000 + RESUME_MARGIN_MS + 1)).toBe(0);
    expect(resumeDelayMs({ resetsAtMs: null }, now)).toBe(0);
  });

  it("marks the turn paused, not failed, and says when", () => {
    const p = limitPauseFrom(res, null, now)!;
    expect(pauseLabel(p, now)).toMatch(/^paused by the 5-hour limit · resumes at /);
    expect(pauseLabel(p, resets * 1000 + RESUME_MARGIN_MS)).toBe("paused by the 5-hour limit · the window has reset");
    expect(pauseLabel({ resetsAtMs: null, window: null }, now)).toBe("paused by the usage limit · resumes at later");
  });

  it("names the subagents that died and says to resume, not relaunch", () => {
    const one = resumeMessage({ subagents: ["toolu_01Lg"], text: "" });
    expect(one).toContain("One subagent died on the limit (spawned by `toolu_01Lg`)");
    expect(one).toContain("resume it with SendMessage");
    const two = resumeMessage({ subagents: ["a", "b"], text: "" });
    expect(two).toContain("2 subagents died on the limit (spawned by `a`, `b`)");
    expect(resumeMessage({ subagents: [], text: "" })).not.toContain("subagent");
  });
});
