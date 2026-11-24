import { describe, expect, it, vi } from "vitest";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  answerAsideAsk: vi.fn(async () => {}),
}));

import * as api from "./api";
import { app, resolveApproval } from "./state.svelte";
import { applyAsideAsk, asideApprovals, asideAsks } from "./asideAsk.svelte";
import { asideBrowserSession } from "./claudeBrowser";
import { asideWire } from "./state/asides.svelte";
import * as tabs from "./tabs";

// Item 919: an aside's card is the chat's card, answered for the aside alone.
describe("919: an aside's approval card", () => {
  it("shows for the asking exchange and goes when the hook stops waiting", () => {
    applyAsideAsk({ seq: 7, call: { id: "t1", name: "Bash", input: { command: "ls" } }, reason: "to look" });
    expect(asideApprovals(7)).toEqual([expect.objectContaining({ id: "t1", name: "Bash", aside: 7, reason: "to look" })]);
    expect(asideApprovals(8)).toEqual([]);
    applyAsideAsk({ seq: 7, call: null });
    expect(asideApprovals(7)).toEqual([]);
  });

  it("Allow answers the aside, never the chat's prompts; for-this-chat is an Allow once", async () => {
    app.pendingApprovals = [{ id: "c1", name: "Bash", input: {}, effect: "mutating" }];
    applyAsideAsk({ seq: 9, call: { id: "t2", name: "Bash", input: {} } });
    expect(await resolveApproval("t2", "name", "always")).toBe(true);
    expect(vi.mocked(api.answerAsideAsk)).toHaveBeenCalledWith(9, "t2", "allow", undefined);
    expect(app.pendingApprovals.map((r) => r.id)).toEqual(["c1"]);
    expect(asideAsks.bySeq[9]).toBeUndefined();
    applyAsideAsk({ seq: 9, call: { id: "t3", name: "mcp__playwright__browser_navigate", input: {} } });
    await resolveApproval("t3", "x", "deny", "no");
    expect(vi.mocked(api.answerAsideAsk)).toHaveBeenLastCalledWith(9, "t3", "deny", "no");
  });
});

describe("919: an aside's own browser", () => {
  it("is keyed apart from the chat's, as the service keys it, and its tab is named for the aside", () => {
    const k = asideBrowserSession("chat-1", "u-1/x");
    expect(k).toBe("chat-1~aside~u-1x");
    expect(tabs.sameContent({ kind: "browser", session: k }, { kind: "browser", session: "chat-1" })).toBe(false);
    expect(tabs.tabTitle({ kind: "browser", session: k, name: "Why" }, [])).toBe("Claude's browser · Why");
  });

  it("the aside's send names its thread", () => {
    expect(asideWire({ model: null, effort: null, uid: "u9" }, [])).toEqual({ aside: "u9" });
  });
});
