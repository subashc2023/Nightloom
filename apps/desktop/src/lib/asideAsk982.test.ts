import { describe, expect, it, vi } from "vitest";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  answerAsideAsk: vi.fn(async () => {}),
  approveCall: vi.fn(async () => null),
}));

import * as api from "./api";
import { app, resolveApproval } from "./state.svelte";
import { applyAsideAsk } from "./asideAsk.svelte";

// Item 982: an aside's question card sends its answers, the same value the chat's card sends.
describe("982: an aside's AskUserQuestion answer", () => {
  const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] };
  const answer = { ...input, answers: { "Which?": "B" } };

  it("reaches the aside as the allow's updatedInput", async () => {
    applyAsideAsk({ seq: 3, call: { id: "q1", name: "AskUserQuestion", input } });
    expect(await resolveApproval("q1", "AskUserQuestion", "allow", undefined, answer)).toBe(true);
    expect(vi.mocked(api.answerAsideAsk)).toHaveBeenLastCalledWith(3, "q1", "allow", undefined, answer);
  });

  it("is the same value the main chat's card hands approveCall", async () => {
    app.pendingApprovals = [{ id: "q2", name: "AskUserQuestion", input, effect: "mutating" }];
    await resolveApproval("q2", "AskUserQuestion", "allow", undefined, answer);
    const mainAnswer = vi.mocked(api.approveCall).mock.calls.at(-1)?.[4];
    const asideAnswer = vi.mocked(api.answerAsideAsk).mock.calls.at(-1)?.[4];
    expect(asideAnswer).toEqual(mainAnswer);
  });

  it("a Skip on an aside's question is still a deny in its words, with no answer", async () => {
    applyAsideAsk({ seq: 4, call: { id: "q3", name: "AskUserQuestion", input } });
    await resolveApproval("q3", "AskUserQuestion", "deny", "decide yourself");
    expect(vi.mocked(api.answerAsideAsk)).toHaveBeenLastCalledWith(4, "q3", "deny", "decide yourself");
  });
});
