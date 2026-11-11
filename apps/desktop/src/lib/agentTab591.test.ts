import { beforeEach, describe, expect, it } from "vitest";
import {
  BRIEF_DEFAULT,
  BRIEF_HEIGHT_KEY,
  BRIEF_MIN,
  BRIEF_OPEN_KEY,
  briefDrag,
  briefHeight,
  briefKeyStep,
  briefMax,
} from "./agentBrief";
import { briefOpen, briefStored, setBriefOpen, setBriefStored } from "./agentBrief.svelte";
import { VIEW_STATE_KEY, resetViewState } from "./viewState";
import src from "./SubagentView.svelte?raw";

// Item 591: a subagent's tab — the brief a resizable section, the bottom one composer.

function fakeStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("the brief's height", () => {
  it("starts at ~240 px in his 1440 × 900 tab, never over 35% of the pane", () => {
    expect(briefHeight(0, 860)).toBe(BRIEF_DEFAULT);
    expect(briefHeight(0, 500)).toBe(175);
    expect(briefHeight(0, 100)).toBe(BRIEF_MIN);
    expect(briefHeight(0, 0)).toBe(BRIEF_DEFAULT);
  });
  it("a dragged height stands, within the minimum and 80% of the pane", () => {
    expect(briefHeight(400, 860)).toBe(400);
    expect(briefHeight(10, 860)).toBe(BRIEF_MIN);
    expect(briefHeight(5000, 860)).toBe(briefMax(860));
    expect(briefMax(860)).toBe(688);
  });
  it("a drag follows the pointer, stops at the brief's own end and at the pane's limit", () => {
    expect(briefDrag(240, 60, 860)).toBe(300);
    expect(briefDrag(240, -500, 860)).toBe(BRIEF_MIN);
    expect(briefDrag(240, 60, 860, 270)).toBe(270);
    expect(briefDrag(240, 2000, 860)).toBe(688);
  });
  it("the handle's keys: arrows by 24 (Shift 96), Home and End to the ends; others pass", () => {
    expect(briefKeyStep("ArrowDown", false, 240, 860)).toBe(264);
    expect(briefKeyStep("ArrowUp", true, 240, 860)).toBe(144);
    expect(briefKeyStep("Home", false, 240, 860)).toBe(BRIEF_MIN);
    expect(briefKeyStep("End", false, 240, 860, 500)).toBe(500);
    expect(briefKeyStep("a", false, 240, 860)).toBeNull();
  });
});

describe("the brief's setting (one for every agent tab, kept across a relaunch)", () => {
  let disk: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    disk = fakeStorage();
    resetViewState(disk);
  });
  it("is open by default, and a fold is written to disk", () => {
    expect(briefOpen()).toBe(true);
    setBriefOpen(false);
    expect(briefOpen()).toBe(false);
    expect(disk.m.get(VIEW_STATE_KEY)).toContain(BRIEF_OPEN_KEY);
    resetViewState(disk);
    expect(briefOpen()).toBe(false);
  });
  it("keeps the dragged height; 0 (a double-click) is the default again", () => {
    expect(briefStored()).toBe(0);
    setBriefStored(333.4);
    resetViewState(disk);
    expect(briefStored()).toBe(333);
    expect(disk.m.get(VIEW_STATE_KEY)).toContain(BRIEF_HEIGHT_KEY);
    setBriefStored(0);
    expect(briefStored()).toBe(0);
  });
});

describe("SubagentView's markup", () => {
  it("Classic keeps its old brief, line and box (each behind classic())", () => {
    expect(src).toMatch(/\{#if row\.prompt && classic\(\)\}\s*<details class="task" use:keptOpen=/);
    expect(src).toMatch(/\{#if classic\(\)\}\s*<p class="note small hint">/);
    expect(src).toContain("Tell the main chat too");
    expect(src).toMatch(/<textarea\s+class="ask"\s+rows="2"/);
  });
  it("Filament IV: the brief opens by the shared setting, scrolls in its box, and has a drag handle", () => {
    expect(src).toMatch(/<details class="brief" open=\{briefOpen\(\)\} ontoggle=/);
    expect(src).toMatch(/class="brief-box" bind:this=\{briefBox\} style:max-height="\{shownH\}px"/);
    expect(src).toMatch(/class="brief-grip"[\s\S]*?role="separator"[\s\S]*?onpointerdown=\{gripDown\}[\s\S]*?onkeydown=\{gripKey\}/);
    expect(src).toMatch(/\.brief-box \{[^}]*overflow: auto;/);
  });
  it("Filament IV: one composer — the box, Tell main chat as a toggle chip, a short hint with its ?, Send", () => {
    const card = src.slice(src.indexOf('<div class="ask-card"'), src.indexOf("</style>"));
    expect(card).toMatch(/class="tell-chip"[\s\S]*?aria-pressed=\{agentAsk\.tellMain\}[\s\S]*?onclick=\{\(\) => setTellMain\(!agentAsk\.tellMain\)\}/);
    expect(card).toMatch(/<span class="ask-hint">\{hintShort\}<\/span>/);
    expect(card).toMatch(/class="ask-why" aria-label=\{hintLong\} use:tip=\{hintLong\}/);
    expect(card).toMatch(/class="ns-btn accent ask-send"/);
    // The note is the kept draft, and Enter still sends.
    expect(card).toMatch(/value=\{agentAsk\.drafts\[key\] \?\? ""\}\s*oninput=\{\(e\) => setAgentDraft\(key, e\.currentTarget\.value\)\}\s*onkeydown=\{onKey\}/);
  });
});
