// Item 873: Home's Sources get a look per service, a status light per row, and one group per service.
import { describe, expect, it } from "vitest";
import { sourceGroups, sourceRows } from "./watch";
import { connectorLook, hueFor, macLook } from "./sourceLook";
import { reachName } from "../home";
import type { HomeReach, ReachAccount } from "../home";
import src from "./views/Watch.svelte?raw";

const acct = (service: string, kind: ReachAccount["kind"], nth: number | null, extra: Partial<ReachAccount> = {}): ReachAccount => ({
  connector: `claude.ai ${service} ${nth ?? ""}`.trim(),
  service,
  kind,
  address: null,
  nth,
  status: "connected",
  on: true,
  claude_ai: true,
  in_scan: true,
  ...extra,
});

describe("source looks", () => {
  it("knows the services he connects, each its own tint and mark", () => {
    expect(connectorLook("Gmail", "mail").icon).toBe("mail");
    expect(connectorLook("Google Calendar", "calendar").icon).toBe("calendar");
    expect(connectorLook("Claude Docs", "files").icon).toBe("spark");
    const tints = ["Gmail", "Google Calendar", "Google Drive", "Google Slides", "Google Sheets", "Claude Docs"].map((s) => connectorLook(s, "files").tint);
    expect(new Set(tints).size).toBe(tints.length);
    expect(macLook("messages").icon).toBe("bubble");
  });
  it("gives an unknown service a stable hue from its name", () => {
    expect(connectorLook("Acme Tracker", "other").tint).toBe(hueFor("Acme Tracker"));
    expect(hueFor("Acme Tracker")).toBe(hueFor("acme tracker"));
    expect(hueFor("Acme Tracker")).not.toBe(hueFor("Zeta Board"));
    expect(connectorLook("Acme Tracker", "other").icon).toBe("mcp");
  });
});

describe("source rows and groups", () => {
  const reach: HomeReach = {
    checked_at: null,
    error: null,
    locals: [],
    accounts: [
      acct("Gmail", "mail", 1),
      acct("Gmail", "mail", 2, { status: "needs_sign_in", in_scan: false }),
      acct("Google Slides", "files", null, { in_scan: false }),
      acct("Google Sheets", "files", null, { on: false, in_scan: false }),
      acct("Acme", "other", null, { status: "failed" }),
    ],
  };
  const rows = sourceRows(reach, [{ id: "contacts", name: "Contacts", status: "denied", on: false, why: "", settings_url: "" }], reachName, (s) => s);
  it("lights each row by what it means", () => {
    expect(rows.map((r) => r.light)).toEqual(["ok", "warn", "idle", "off", "bad", "bad"]);
    for (const r of rows) expect(r.why.split("\n")).toHaveLength(2); // tooltips: two short lines
  });
  it("names an account inside its group by which one it is", () => {
    expect(rows[0].name).toBe("Gmail · first account");
    expect(rows[0].short).toBe("first account");
    expect(rows[2].short).toBe("Google Slides");
  });
  it("draws a service with several accounts as one group, in first-seen order", () => {
    const g = sourceGroups(rows);
    expect(g.map((x) => [x.service, x.rows.length])).toEqual([["Gmail", 2], ["Google Slides", 1], ["Google Sheets", 1], ["Acme", 1], ["Contacts · this Mac", 1]]);
    expect(g[0].tint).toBe(connectorLook("Gmail", "mail").tint);
  });
});

describe("the Watch view (item 873)", () => {
  it("draws groups with the tint, and keeps each row's Check now", () => {
    expect(src).toContain("{#each groups as g, gi (g.service)}");
    expect(src).toContain("style:--tint={g.tint}");
    expect(src).toContain("checkOne(s.id)");
  });
  it("shows what each handled row was, not only its state", () => {
    expect(src).toContain("{f.label ?? f.line}");
    expect(src).toContain("placeName(f.project)");
  });
});
