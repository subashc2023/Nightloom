import { describe, expect, it } from "vitest";
import { injectChip, sendNowToast } from "./midTurn";

// Nightshift backlog 341 (wave 6 review, findings 3–5): what Send now
// tells him when the CLI does not hurry the message or a Take back won.
describe("Send now's toast (341)", () => {
  it("a cancel the CLI did not confirm says it goes at the next step, not that it reached the turn", () => {
    const t = sendNowToast("not_hurried")!;
    expect(t).toContain("next step");
    expect(t).not.toContain("already reached");
  });

  it("a Take back that won the race says it was taken back", () => {
    const t = sendNowToast("taken_back")!;
    expect(t).toContain("taken back");
    expect(t).not.toContain("already reached");
  });

  it("the other answers read as before", () => {
    expect(sendNowToast("sent")).toBeNull();
    expect(sendNowToast("delivered")).toBe("already reached the turn");
    expect(sendNowToast("not_running")).toBe("no turn is running to take it now — it goes as the next message");
  });
});

describe("a sent row's chip (341)", () => {
  it("a Send now row does not claim the step was stopped before the turn says so", () => {
    const c = injectChip({ now: true });
    expect(c.state).toBe("now");
    expect(c.label).not.toContain("stopping");
    expect(c.label).toContain("asked to stop");
  });

  it("a taken row shows where the turn took it, as the backend says", () => {
    expect(injectChip({ now: true, after: "after Bash" })).toMatchObject({ state: "delivered", label: "delivered after Bash" });
    expect(injectChip({ after: "at once, stopping Bash" }).label).toBe("delivered at once, stopping Bash");
  });

  it("a plain sent row reads as before", () => {
    // Backlog 366: future tense until the turn takes it.
    expect(injectChip({})).toMatchObject({ state: "sent", label: "goes at Claude's next step" });
  });
});
