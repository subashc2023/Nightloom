import { describe, expect, it } from "vitest";
import {
  HOME_SOURCE,
  SCAN_LINE,
  carriedEntries,
  carriedLabel,
  clock,
  dateLabel,
  doneSince,
  factsWords,
  handOffLine,
  handOffTip,
  handOffsOf,
  homeCount,
  homeFirst,
  isHome,
  isScanMessage,
  kTokens,
  lastCarried,
  placeDividers,
  scanFacts,
  type FeedRow,
} from "./home";
import type { SessionEvent } from "./types";

// Local times, so the days are the reader's own whatever zone the run is in.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe("Home in the project list (item 763, H1)", () => {
  it("knows Home by its source, never its name", () => {
    expect(isHome({ source: HOME_SOURCE })).toBe(true);
    expect(isHome({ source: null })).toBe(false);
    expect(isHome({})).toBe(false);
    expect(isHome(null)).toBe(false);
  });
  it("puts Home first and keeps the rest in their order", () => {
    const ps: { id: string; source?: string | null }[] = [{ id: "a" }, { id: "h", source: HOME_SOURCE }, { id: "b" }];
    expect(homeFirst(ps).map((p) => p.id)).toEqual(["h", "a", "b"]);
    expect(homeFirst(ps.filter((p) => p.id !== "h")).map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("says the count only when something waits", () => {
    expect(homeCount(0)).toBe("");
    expect(homeCount(1)).toBe("1 needs you");
    expect(homeCount(3)).toBe("3 need you");
  });
});

describe("the date divider (H3)", () => {
  it("names the day as he reads it", () => {
    const now = new Date(2026, 10, 17, 9);
    expect(dateLabel(at(2026, 11, 17, 4), now)).toBe("Tuesday, November 17");
    expect(dateLabel(at(2025, 12, 31, 23), now)).toBe("Wednesday, December 31, 2025");
    expect(clock(at(2026, 11, 17, 4, 12))).toBe("4:12 AM");
    expect(clock(at(2026, 11, 17, 0, 5))).toBe("12:05 AM");
    expect(clock(at(2026, 11, 17, 12, 0))).toBe("12:00 PM");
  });
  it("draws one between two messages whose local days differ, never before the first", () => {
    const items = [
      { index: 1, at: at(2026, 11, 16, 22) },
      { index: 2, at: at(2026, 11, 16, 23) },
      { index: 3, at: at(2026, 11, 17, 8) },
      { index: 4, at: at(2026, 11, 17, 9) },
    ];
    const p = placeDividers(items, []);
    expect([...p.before.keys()]).toEqual([2]);
    expect(p.before.get(2)).toEqual([{ kind: "date", day: "2026-11-17", label: dateLabel(items[2].at) }]);
    expect(p.tail).toEqual([]);
  });
  it("skips undated items (a rewound turn) when comparing days", () => {
    const p = placeDividers(
      [
        { index: 1, at: at(2026, 11, 16, 9) },
        { index: 2, at: null },
        { index: 3, at: at(2026, 11, 16, 10) },
      ],
      [],
    );
    expect(p.before.size).toBe(0);
  });
});

describe("the hand-off divider (H3)", () => {
  const evs = [
    { event: "user_message", text: "hi", at: at(2026, 11, 16, 23) },
    { event: "auto_hand_off", soft: 200000, hard: 330000, at: at(2026, 11, 16, 23) },
    { event: "hand_off", brief: "Carry on with the scan.", context: 212345, reason: "soft", at: at(2026, 11, 17, 4, 12) },
    { event: "user_message", text: "morning", at: at(2026, 11, 17, 8) },
  ] as SessionEvent[];

  it("reads the hand-offs and their places from the log, and never the metadata event", () => {
    const hs = handOffsOf(evs);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ index: 2, context: 212345, reason: "soft", brief: "Carry on with the scan." });
  });
  it("says what happened in one line, and a two-line tooltip", () => {
    expect(handOffLine({ context: 212345, at: at(2026, 11, 17, 4, 12) })).toBe("Handed off in place · 212k → fresh · 4:12 AM");
    const t = handOffTip({ context: 212345, reason: "hard" });
    expect(t.split("\n")).toHaveLength(2);
    expect(t.startsWith("212k")).toBe(true);
    // Item 792: a soft one happens only once the cache has gone cold, and says so.
    expect(handOffTip({ context: 104_000, reason: "soft" })).toBe("104k of context → a fresh start\nAfter the cache went cold · click for the brief");
  });
  it("sits before the first item logged after it, after the day's date line", () => {
    const items = [
      { index: 0, at: at(2026, 11, 16, 23) },
      { index: 3, at: at(2026, 11, 17, 8) },
    ];
    const p = placeDividers(items, handOffsOf(evs));
    const before = p.before.get(1) ?? [];
    expect(before.map((d) => d.kind)).toEqual(["date", "hand_off"]);
  });
  it("goes to the tail when nothing follows it", () => {
    const p = placeDividers([{ index: 0, at: at(2026, 11, 17, 3) }], handOffsOf(evs));
    expect(p.tail.map((d) => d.kind)).toEqual(["hand_off"]);
  });
  it("sizes in k and M", () => {
    expect(kTokens(212345)).toBe("212k");
    expect(kTokens(999)).toBe("999");
    expect(kTokens(1_200_000)).toBe("1.2M");
  });
});

describe("the scan card (H3)", () => {
  const scan = `${SCAN_LINE}\n\n- Nightloom: CI green\n- Nightshift: 2 blockers held\n`;
  it("knows the scan by its first line only", () => {
    expect(isScanMessage(scan)).toBe(true);
    expect(isScanMessage(`  ${scan}`)).toBe(true);
    expect(isScanMessage(`Please do a ${SCAN_LINE}`)).toBe(false);
    expect(isScanMessage("Morning scan")).toBe(false);
    expect(isScanMessage("")).toBe(false);
  });
  it("folds the facts under the line", () => {
    expect(scanFacts(scan)).toBe("- Nightloom: CI green\n- Nightshift: 2 blockers held");
    expect(factsWords(scanFacts(scan))).toBe("2 lines of facts");
    expect(factsWords(scanFacts(SCAN_LINE))).toBe("no facts");
  });
});

describe("Done since you looked (H2)", () => {
  const row = (iso: string, line: string): FeedRow => ({ at: iso, kind: "done", label: null, chat: "c", project: "p", line });
  it("lists rows newer than the seen time, newest first", () => {
    const rows = [row("2026-11-17T08:00:00Z", "a"), row("2026-11-17T10:00:00Z", "b"), row("2026-11-17T06:00:00Z", "old")];
    expect(doneSince(rows, "2026-11-17T07:00:00Z").map((r) => r.line)).toEqual(["b", "a"]);
  });
  it("lists everything when he has never looked", () => {
    expect(doneSince([row("2026-11-17T08:00:00Z", "a")], null)).toHaveLength(1);
  });
});

// ---- item 763 finish: palette numbers, Home's model and effort ----
import { paletteKeys, HOME_MODEL, HOME_EFFORT } from "./home";
import { applyHomeEffort, homeChoice, loadChoices, saveChoices, type ChatChoices } from "./chatChoice";
import { defaultDraft } from "./catalog";
import paletteSrc from "./Palette.svelte?raw";
import connectionSrc from "./state/connection.svelte.ts?raw";

describe("763 finish — the palette keeps his number keys", () => {
  const a = { id: "a", source: null };
  const b = { id: "b", source: null };
  const h = { id: "h", source: HOME_SOURCE };
  it("other projects keep the numbers they had before Home; Home takes the next free one", () => {
    const keys = paletteKeys(homeFirst([a, b, h]));
    expect(keys.get("a")).toBe("1");
    expect(keys.get("b")).toBe("2");
    expect(keys.get("h")).toBe("3");
  });
  it("Home gets no number past 9", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, source: null }));
    const keys = paletteKeys([h, ...many]);
    expect(keys.get("p0")).toBe("1");
    expect(keys.get("p8")).toBe("9");
    expect(keys.get("h")).toBe("");
  });
  it("the palette reads its numbers from paletteKeys, Home still listed first", () => {
    const src = paletteSrc;
    expect(src).toContain("paletteKeys(app.projects)");
    expect(src).toContain("homeFirst(app.projects).map((p) =>");
    expect(src).not.toContain("key: i < 9 ? String(i + 1) : \"\",\n      group: \"Projects");
  });
});

describe("763 finish — Home's chat defaults to Opus 5.5 at low effort", () => {
  it("a Home chat with no choice starts on Claude Code + Opus 5.5", () => {
    const c = homeChoice({ engine: "provider", provider: "anthropic", model: "claude-sonnet-5", agentModel: "sonnet" });
    expect(c).toEqual({ engine: "claude-code", provider: "anthropic", model: "claude-sonnet-5", agentModel: HOME_MODEL });
  });
  it("entering Home puts its effort on, leaving puts his window effort back", () => {
    const choices: ChatChoices = { default: null, chats: {} };
    const d = defaultDraft();
    d.agentEffort = "high";
    expect(applyHomeEffort(choices, d, true)).toBe(true);
    expect(d.agentEffort).toBe(HOME_EFFORT);
    expect(applyHomeEffort(choices, d, true)).toBe(false);
    expect(d.agentEffort).toBe(HOME_EFFORT);
    expect(applyHomeEffort(choices, d, false)).toBe(true);
    expect(d.agentEffort).toBe("high");
    expect(applyHomeEffort(choices, d, false)).toBe(false);
  });
  it("an effort he picked in Home is Home's, and survives a relaunch", () => {
    const choices: ChatChoices = { default: null, chats: {}, homeEffort: "medium" };
    const d = defaultDraft();
    d.agentEffort = "";
    applyHomeEffort(choices, d, true);
    expect(d.agentEffort).toBe("medium");
    const store = new Map<string, string>();
    saveChoices({ setItem: (k, v) => void store.set(k, v) }, choices);
    const back = loadChoices({ getItem: (k) => store.get(k) ?? null });
    expect(back.homeEffort).toBe("medium");
    expect(back.windowEffort).toBe("");
    applyHomeEffort(back, d, false);
    expect(d.agentEffort).toBe("");
  });
  it("restoreChatChoice and the connect use them", () => {
    const src = connectionSrc;
    expect(src).toContain("homeChoice(wanted ?? choiceOf(app.draft))");
    expect(src).toContain("applyHomeEffort(chatChoice.choices, app.draft, inHome)");
    expect(src).toContain("if (!(inHome && chat === null)) noteConnected");
  });
});

// Items 789 + 791: the run log a hand-off carried, drawn on its divider. The brief's shape is `chain.rs`'s.
describe("the run log on the hand-off divider (items 789, 791)", () => {
  const brief = [
    "## Hand-off (in place)",
    "",
    "## His words since the last hand-off, verbatim (oldest first)",
    "",
    "- 2026-11-17 08:00 UTC — check the signup flow",
    "",
    "## State file (as of this hand-off; frozen for this slice)",
    "",
    "### not an entry",
    "",
    "## Run log (newest 2 of 5; written once each, never rewritten)",
    "",
    "Notes the model wrote at the end of earlier runs.",
    "",
    "### 2026-11-16 08:03:12 UTC · by the model",
    "",
    "p95 412.7 ms on /api/signup",
    "",
    "### 2026-11-17 08:04:00 UTC · run failed · by code",
    "",
    "The run did not finish: no reply",
    "",
    "(3 older entries are not carried here — read the file or search the chat.)",
    "",
    "## The hand-off before this one",
    "",
    "### 2026-11-10 08:00:00 UTC · by the model",
    "old",
  ].join("\n");

  it("reads only the run log's entries, exact, oldest first", () => {
    const es = carriedEntries(brief);
    expect(es.map((e) => e.body)).toEqual(["p95 412.7 ms on /api/signup", "The run did not finish: no reply"]);
    expect(es[0].at).toBe("2026-11-16T08:03:12Z");
    expect(es[0].who).toBe("by the model");
  });

  it("draws the newest, and says when a run failed", () => {
    const e = lastCarried(brief)!;
    expect(carriedLabel(e)).toBe(`Run failed · ${clock("2026-11-17T08:04:00Z")}`);
    expect(carriedLabel(carriedEntries(brief)[0])).toMatch(/^Run log · /);
  });

  it("draws nothing for a brief from before the run log", () => {
    expect(lastCarried("## Hand-off (in place)\n\n## His words\n- hi")).toBeNull();
  });
});
