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
    // A result from before pass 2 (no `agents`): named by the spawning call.
    const one = resumeMessage({ subagents: ["toolu_01Lg"] });
    expect(one).toContain("One subagent stopped on the limit before returning: the one spawned by `toolu_01Lg`.");
    expect(one).toContain("Resume it with SendMessage to its agent id");
    const two = resumeMessage({ subagents: ["a", "b"] });
    expect(two).toContain("2 subagents stopped on the limit before returning: the one spawned by `a`, the one spawned by `b`.");
    expect(resumeMessage({ subagents: [] })).not.toContain("subagent");
  });

  // Pass 2 (2026-10-09): the agent id SendMessage takes, from the stream's
  // `task_started`, and a child no line of its own named.
  it("names each stopped child by its agent id, and matches serve.rs word for word", () => {
    const agents = [
      { tool_use_id: "toolu_a", agent_id: "a1", description: "law scan", status: "running" },
      { tool_use_id: "toolu_b", agent_id: "", description: "", status: "" },
    ];
    const p = limitPauseFrom({ limit: { ...res.limit, subagents: ["toolu_a"], agents } }, "chat1", now)!;
    expect(p.agents).toEqual(agents);
    // The same sentence `serve.rs`'s `the_resume_message_is_limit_ts_word_for_word` pins.
    expect(resumeMessage(p)).toContain(
      " 2 subagents stopped on the limit before returning: `a1` (law scan; spawned by `toolu_a`), the one spawned by `toolu_b`. Resume each with SendMessage to its agent id",
    );
    expect(resumeMessage({ subagents: [], agents: [agents[0]] })).toContain(
      " One subagent stopped on the limit before returning: `a1` (law scan; spawned by `toolu_a`). Resume it with",
    );
  });
});
