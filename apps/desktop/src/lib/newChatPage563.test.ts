import { describe, expect, it } from "vitest";
import welcomeSrc from "./Welcome.svelte?raw";
import classicSrc from "./WelcomeClassic.svelte?raw";
import {
  dialSize,
  greeting,
  leafOf,
  modelName,
  quarterLabels,
  readings,
  readoutsFit,
  threadWhen,
  tildePath,
  type ReadingsInput,
} from "./newChatPage";
import { dialFrameAt, DIAL_MS } from "./sendMotion";

const base: ReadingsInput = {
  engine: "claude-code",
  provider: "Anthropic",
  connected: true,
  connecting: false,
  subscription: true,
  cliVersion: "2.4.1",
  model: "claude-opus-5-5",
  limit: 1_000_000,
  project: { root: "/Users/you/research/vg", exists: true },
  notes: 48,
  vault: 0,
  chats: 12,
  plan: { five: 26, week: 62, resets: "9:40 PM" },
  nightshift: { enabled: true, live: false, armedAt: "11:00 PM", items: 3, blockers: 1 },
};

describe("item 563: the new-chat page's readings", () => {
  it("draws the mockup's six from what the app holds", () => {
    const r = readings(base);
    expect(r.map((x) => x.key)).toEqual(["engine", "folder", "memory", "plan", "nightshift", "model"]);
    const by = Object.fromEntries(r.map((x) => [x.key, x]));
    expect(by.engine.value).toBe("Claude Code · subscription");
    expect(by.engine.sub).toBe("signed in · CLI 2.4.1");
    expect(by.folder.value).toBe("~/research/vg");
    expect(by.folder.short).toBe("vg");
    expect(by.memory.value).toBe("48 notes · 12 chats");
    expect(by.plan.short).toBe("26% · 62%");
    expect(by.plan.value).toBe("5 hours 26% · week 62%");
    expect(by.plan.sub).toBe("resets 9:40 PM");
    expect(by.nightshift.short).toBe("Armed 11:00 PM");
    expect(by.nightshift.value).toBe("Armed for 11:00 PM");
    expect(by.model.value).toBe("Opus 5.5");
    expect(by.model.sub).toBe("1M window · cache cold");
  });
  it("leaves out what it lacks rather than guessing", () => {
    const r = readings({ ...base, plan: null, nightshift: null, model: null, engine: "api" });
    expect(r.map((x) => x.key)).toEqual(["engine", "folder", "memory"]);
    expect(r[0].value).toBe("Anthropic · API");
    // No git branch or clean state: the frontend has none (blocker 1766).
    expect(readings(base).find((x) => x.key === "folder")!.sub).not.toMatch(/git|clean|main/);
  });
  it("says what is wrong: not connected, the folder missing, no project", () => {
    const off = readings({ ...base, connected: false });
    expect(off[0].warn).toBe(true);
    expect(off[0].sub).toBe("not connected");
    expect(readings({ ...base, connected: false, connecting: true })[0].sub).toBe("connecting…");
    const gone = readings({ ...base, project: { root: "/x/y", exists: false } }).find((x) => x.key === "folder")!;
    expect(gone.warn).toBe(true);
    expect(gone.short).toBe("missing");
    expect(readings({ ...base, project: null }).find((x) => x.key === "folder")!.value).toBe("No project");
    expect(readings({ ...base, project: { root: null, exists: true } }).find((x) => x.key === "folder")!.sub).toBe(
      "notes and chats only",
    );
  });
  it("names Nightshift's state: off, running, armed, ready", () => {
    const ns = (n: Partial<NonNullable<ReadingsInput["nightshift"]>>) =>
      readings({ ...base, nightshift: { ...base.nightshift!, ...n } }).find((x) => x.key === "nightshift")!.short;
    expect(ns({ enabled: false })).toBe("Off");
    expect(ns({ live: true })).toBe("Running");
    expect(ns({ armedAt: null })).toBe("Ready");
  });
  it("small helpers", () => {
    expect(tildePath("/Users/you/a/b")).toBe("~/a/b");
    expect(tildePath("/opt/x")).toBe("/opt/x");
    expect(leafOf("/a/b/")).toBe("b");
    expect(modelName("claude-sonnet-5-0")).toBe("Sonnet 5.0");
    expect(greeting(8)).toBe("Good morning.");
    expect(greeting(13)).toBe("Good afternoon.");
    expect(greeting(20)).toBe("Good evening.");
    expect(greeting(2)).toBe("Good evening.");
    expect(quarterLabels(1_000_000)).toEqual(["0", "250k", "500k", "750k"]);
    expect(quarterLabels(null)).toEqual([]);
    const now = new Date(2026, 10, 9, 20, 14);
    expect(threadWhen("2026-11-09", now)).toBe("today");
    expect(threadWhen("2026-11-08", now)).toBe("Nov 8");
    expect(threadWhen(null, now)).toBe("");
  });
  it("sizes the dial to the pane, and the read-outs only where they fit", () => {
    expect(dialSize(868, 480)).toBe(330);
    expect(dialSize(700, 500)).toBe(200);
    expect(dialSize(600, 500)).toBe(0);
    expect(readoutsFit(1188, 330)).toBe(true);
    expect(readoutsFit(800, 330)).toBe(false);
    expect(readoutsFit(1400, 200)).toBe(false);
  });
});

describe("item 563: the dial's move to the right column", () => {
  const from = { x: 500, y: 100, w: 382, h: 382 };
  const to = { x: 1250, y: 80, w: 132, h: 132 };
  it("starts where the page's dial was and ends on the column's, at its size", () => {
    const a = dialFrameAt(0, from, to);
    expect(a).toMatchObject({ dx: 0, dy: 0, scale: 1, ghost: 1, target: 0, done: false });
    const b = dialFrameAt(DIAL_MS, from, to);
    expect(b.dx).toBeCloseTo(1316 - 691);
    expect(b.dy).toBeCloseTo(146 - 291);
    expect(b.scale).toBeCloseTo(132 / 382);
    expect(b.ghost).toBe(0);
    expect(b.target).toBe(1);
    expect(b.done).toBe(true);
  });
  it("hands over to the column's dial only at the end", () => {
    const m = dialFrameAt(DIAL_MS * 0.5, from, to);
    expect(m.ghost).toBe(1);
    expect(m.target).toBe(0);
  });
  it("with no column, shrinks a little in place and fades", () => {
    const e = dialFrameAt(DIAL_MS, from, null);
    expect(e).toMatchObject({ dx: 0, dy: 0, ghost: 0, target: null, done: true });
    expect(e.scale).toBeCloseTo(0.86);
  });
});

describe("item 563 (leftover): the column slides in on the dial's timeline", () => {
  const from = { x: 500, y: 100, w: 382, h: 382 };
  const to = { x: 1250, y: 80, w: 132, h: 132 };
  it("starts a full width out and half-faded, and is home when the dial lands", () => {
    const a = dialFrameAt(0, from, to);
    expect(a.slide).toBe(1);
    expect(a.colOpacity).toBeCloseTo(0.35);
    const m = dialFrameAt(DIAL_MS * 0.5, from, to);
    expect(m.slide).toBeGreaterThan(0);
    expect(m.slide).toBeLessThan(0.2);
    const b = dialFrameAt(DIAL_MS, from, to);
    expect(b.slide).toBe(0);
    expect(b.colOpacity).toBe(1);
  });
  it("never slides when there is no column", () => {
    expect(dialFrameAt(100, from, null)).toMatchObject({ slide: 0, colOpacity: 1 });
  });
});

describe("item 563: Classic keeps the old page", () => {
  it("Welcome chooses the verbatim copy under Classic", () => {
    expect(welcomeSrc).toMatch(/\{#if classic\(\)\}\s*<WelcomeClassic \/>/);
    expect(classicSrc).toContain("const INNER_LAP = 240;");
    expect(classicSrc).toContain('class="welcome" data-drop-chat');
  });
  it("the page registers its dial for the move", () => {
    expect(welcomeSrc).toContain('<div class="dial-wrap" use:departs>');
  });
});
