// Item 973: Allow / Deny on the macOS needs-you banner. A press answers the
// waiting call with exactly the banner's id, never another; a banner whose
// call was answered already does nothing and says so; Allow is offered only
// when the banner shows the whole call, and never comes from a click.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "./types";

const plain = vi.fn((..._a: unknown[]) => Promise.resolve(null));
const withButtons = vi.fn((..._a: unknown[]) => Promise.resolve(null));
vi.mock("./api", () => ({
  notify: (t: string, b: string) => plain(t, b),
  notifyApproval: (id: string, t: string, b: string, allow: boolean) => withButtons(id, t, b, allow),
  pushNote: () => Promise.resolve(null),
}));

import { BANNER_ALLOW_CHARS, answeredLine, bannerAllows, routeBannerPress, staleLine } from "./bannerAnswer";
import { needsYouBanner, notifyNeedsYou, postedBanner } from "./notify";

const call = (id: string, name: string, input: unknown, extra: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ id, name, input, effect: "mutating", ...extra }) as ApprovalRequest;
const bash = (id: string, command: string, extra: Partial<ApprovalRequest> = {}) =>
  call(id, "Bash", { command, description: "Remove the build folder" }, extra);

describe("which banners offer Allow", () => {
  it("a short one-line call, shown whole — Bash's description label set aside", () => {
    expect(bannerAllows(bash("a", "rm -rf build"))).toBe("rm -rf build");
    expect(bannerAllows(call("a", "Read", { file_path: "/tmp/x.txt", limit: 20 }))).toBe("/tmp/x.txt");
    expect(bannerAllows(call("a", "Bash", { command: "ls", timeout: 5000, run_in_background: false }))).toBe("ls");
  });

  it("never one the banner would cut: long, several lines, or two strings", () => {
    expect(bannerAllows(bash("a", "x".repeat(BANNER_ALLOW_CHARS + 1)))).toBeNull();
    expect(bannerAllows(bash("a", "cd /tmp\nrm -rf *"))).toBeNull();
    expect(bannerAllows(call("a", "Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }))).toBeNull();
    expect(bannerAllows(call("a", "WebFetch", { url: "https://x.dev", prompt: "read it" }))).toBeNull();
    expect(bannerAllows(call("a", "mcp__x__y", { q: "a", opts: { deep: true } }))).toBeNull();
    expect(bannerAllows(call("a", "mcp__x__y", "a string input"))).toBeNull();
    expect(bannerAllows(call("a", "mcp__x__y", {}))).toBeNull();
  });

  it("never a card that asks more than yes or no", () => {
    expect(bannerAllows(call("a", "AskUserQuestion", { questions: [] }))).toBeNull();
    expect(bannerAllows(call("a", "ExitPlanMode", { plan: "do it" }))).toBeNull();
    expect(bannerAllows(bash("a", "ls", { outside: "/Users/x/elsewhere" }))).toBeNull();
    expect(bannerAllows(bash("a", "ls", { kind: "home_write" }))).toBeNull();
    expect(bannerAllows(bash("a", "ls", { aside: 3 }))).toBeNull();
    expect(bannerAllows(call("a", "mcp__nightloom__add_folder", { path: "/x" }))).toBeNull();
  });
});

describe("the banner posted", () => {
  beforeEach(() => {
    plain.mockClear();
    withButtons.mockClear();
    vi.stubGlobal("document", { hasFocus: () => false, visibilityState: "visible" });
  });
  const on = { turnEnd: true, needsYou: true, usageRefresh: true };

  it("a short call: the Allow button, its command whole, under its own id", async () => {
    await notifyNeedsYou("Builds", bash("t1", "rm -rf build"), on);
    expect(plain).not.toHaveBeenCalled();
    expect(withButtons).toHaveBeenCalledTimes(1);
    const [id, title, body, allow] = withButtons.mock.calls[0];
    expect(id).toBe("t1");
    expect(title).toBe("Builds — Run Bash?");
    expect(body).toContain("rm -rf build");
    expect(allow).toBe(true);
    expect(postedBanner("t1")).toEqual({ chat: "Builds", name: "Bash" });
  });

  it("an Edit: the Deny button, with the card's summary", async () => {
    await notifyNeedsYou("Builds", call("t2", "Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }), on);
    expect(withButtons.mock.calls[0][0]).toBe("t2");
    expect(withButtons.mock.calls[0][3]).toBe(false);
  });

  it("a question: the plain banner, no buttons", async () => {
    await notifyNeedsYou("Builds", call("t3", "AskUserQuestion", { questions: [] }), on);
    expect(withButtons).not.toHaveBeenCalled();
    expect(plain).toHaveBeenCalledTimes(1);
    expect(needsYouBanner("Builds", call("t3", "AskUserQuestion", { questions: [] })).buttons).toBe(false);
  });
});

describe("where a press goes", () => {
  const screen = [bash("s1", "ls"), bash("s2", "rm -rf build")];
  const background = { chatB: { approvals: [bash("b1", "make")] } };

  it("answers exactly the call with the banner's id, on screen or off", () => {
    const r = routeBannerPress("s2", "allow", screen, background);
    expect(r).toMatchObject({ act: "answer", decision: "allow", background: null });
    expect(r.act === "answer" && r.req.id).toBe("s2");
    const b = routeBannerPress("b1", "allow", screen, background);
    expect(b).toMatchObject({ act: "answer", decision: "allow", background: "chatB" });
    expect(b.act === "answer" && b.req.id).toBe("b1");
    const long = { chatB: { approvals: [bash("b2", "y".repeat(BANNER_ALLOW_CHARS + 1))] } };
    const d = routeBannerPress("b2", "deny", screen, long);
    expect(d).toMatchObject({ act: "answer", decision: "deny", background: "chatB" });
    expect(d.act === "answer" && d.req.id).toBe("b2");
  });

  it("a banner whose call no longer waits does nothing", () => {
    expect(routeBannerPress("gone", "allow", screen, background)).toEqual({ act: "stale" });
    expect(routeBannerPress("gone", "deny", screen, background)).toEqual({ act: "stale" });
    expect(routeBannerPress("gone", "open", screen, background)).toEqual({ act: "stale" });
    // Nothing about ids is fuzzy: a prefix or a neighbour is not the call.
    expect(routeBannerPress("s", "allow", screen, background)).toEqual({ act: "stale" });
  });

  it("an Allow the banner could not have offered is a look, never an allow", () => {
    const long = [bash("l1", "x".repeat(BANNER_ALLOW_CHARS + 5))];
    expect(routeBannerPress("l1", "allow", long, {})).toEqual({ act: "open" });
    // Deny still answers it.
    expect(routeBannerPress("l1", "deny", long, {})).toMatchObject({ act: "answer", decision: "deny" });
    const q = [call("q1", "AskUserQuestion", { questions: [] })];
    expect(routeBannerPress("q1", "allow", q, {})).toEqual({ act: "open" });
    expect(routeBannerPress("q1", "deny", q, {})).toEqual({ act: "open" });
  });

  it("a Deny on an Allow banner was never offered: a look, never a deny", () => {
    expect(routeBannerPress("s1", "deny", screen, background)).toEqual({ act: "open" });
  });

  it("a click on the body answers nothing", () => {
    expect(routeBannerPress("s1", "open", screen, background)).toEqual({ act: "open" });
  });
});

describe("what he is told", () => {
  it("who answered, what, where and when; and that a stale press did nothing", () => {
    const at = new Date(2026, 10, 25, 6, 41).getTime();
    expect(answeredLine("allow", "Bash", "Builds", at)).toBe("Allowed Bash in Builds from the notification at 6:41 AM");
    expect(answeredLine("deny", "Bash", "Builds", at)).toBe("Denied Bash in Builds from the notification at 6:41 AM");
    expect(staleLine("Bash", "Builds")).toBe("Bash in Builds was already answered, so the notification did nothing");
    expect(staleLine(null, null)).toBe("That call was already answered, so the notification did nothing");
  });
});
