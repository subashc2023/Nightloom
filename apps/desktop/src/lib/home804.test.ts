// Item 804: what Home can reach — the panel's words, pure.
import { describe, expect, it } from "vitest";
import { REACH_GROUPS, reachName, reachNote, reachStatusWords, reachSummary, type HomeReach, type ReachAccount } from "./home";
import settings from "./SettingsModal.svelte?raw";

function acct(over: Partial<ReachAccount>): ReachAccount {
  return {
    connector: "claude.ai Gmail",
    service: "Gmail",
    kind: "mail",
    address: null,
    nth: null,
    status: "connected",
    on: true,
    claude_ai: true,
    in_scan: true,
    ...over,
  };
}

describe("item 804: the reach panel", () => {
  it("names a row by its address, else by its service and which account", () => {
    expect(reachName(acct({ address: "a@example.com", nth: 2 }))).toBe("a@example.com");
    expect(reachName(acct({}))).toBe("Gmail");
    expect(reachName(acct({ nth: 1 }))).toBe("Gmail · first account");
    expect(reachName(acct({ nth: 3 }))).toBe("Gmail · third account");
    // Never the connector's id.
    expect(reachName(acct({ connector: "claude.ai Gmail 2117773e", nth: 2 }))).not.toContain("2117773e");
  });

  it("says what Home does with each row, and why not when it cannot", () => {
    expect(reachNote(acct({}))).toBe("Read by the morning scan and Home's chat.");
    expect(reachNote(acct({ address: "a@example.com" }))).toBe("Gmail · Read by the morning scan and Home's chat.");
    expect(reachNote(acct({ kind: "files", in_scan: false }))).toContain("the scan does not");
    expect(reachNote(acct({ on: false, in_scan: false }))).toBe("Turned off for Home.");
    expect(reachNote(acct({ status: "needs_sign_in", in_scan: false }))).toContain("sign in to it at claude.ai");
    expect(reachNote(acct({ status: "failed", in_scan: false }))).toContain("did not answer");
    expect(reachNote(acct({ claude_ai: false, kind: "other", in_scan: false }))).toContain("One of your own tools");
    expect(reachStatusWords("needs_sign_in")).toBe("Needs sign-in");
  });

  it("sums what the scan reads", () => {
    const base: HomeReach = { checked_at: "2026-11-17T16:00:00Z", error: null, accounts: [], locals: [] };
    expect(reachSummary(null)).toBe("Not checked yet.");
    expect(reachSummary({ ...base, checked_at: null })).toBe("Not checked yet.");
    expect(reachSummary(base)).toBe("The morning scan reads no mail or calendar yet.");
    const accounts = [
      acct({}),
      acct({ connector: "b", nth: 2 }),
      acct({ connector: "c", kind: "calendar" }),
      acct({ connector: "d", kind: "calendar", in_scan: false, on: false }),
      acct({ connector: "e", kind: "files", in_scan: false }),
    ];
    expect(reachSummary({ ...base, accounts })).toBe("The morning scan reads 2 mail accounts and 1 calendar.");
  });

  it("groups mail first and the panel is in Settings → Home, switches only on connected connectors", () => {
    expect(REACH_GROUPS.map((g) => g.kind)).toEqual(["mail", "calendar", "files", "other"]);
    expect(settings).toContain('data-testid="home-reach"');
    expect(settings).toContain('{#if a.claude_ai && a.status === "connected"}');
    expect(settings).toContain("On this Mac, not reachable");
  });
});
