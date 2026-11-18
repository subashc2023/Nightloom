import { describe, expect, it } from "vitest";
import { askedLine, countLine, countTip, whereLine } from "./imageCalls";

const summary = { total: 3, recent: 2, recent_days: 14, calls: [], path: "/x" };

describe("the image tool's count (item 823)", () => {
  it("says the total and the last 14 days", () => {
    expect(countLine(summary)).toBe("3 calls · 2 in the last 14 days");
    expect(countLine({ ...summary, total: 1, recent: 1 })).toBe("1 call · 1 in the last 14 days");
  });

  it("hovers in two short lines", () => {
    const lines = countTip(summary).split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(44);
  });

  it("shows the prompt, or says an incognito chat kept none", () => {
    expect(askedLine({ at: "", engine: "api", prompt: "a fox", size: "16:9" })).toBe("a fox — 16:9");
    expect(askedLine({ at: "", engine: "api", private: true })).toBe("(incognito chat: prompt not kept)");
    expect(whereLine({ at: "", engine: "claude-code", project: "Nightloom" })).toBe("Nightloom · Claude Code");
    expect(whereLine({ at: "", engine: "api" })).toBe("Unfiled · API");
  });
});
