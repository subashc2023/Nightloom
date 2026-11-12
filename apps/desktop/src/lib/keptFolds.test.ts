import { beforeEach, describe, expect, it } from "vitest";
import { decodeOverride, encodeOverride, foldKey, keptGet, keptOpen, keptSet } from "./keptFolds.svelte";
import { VIEW_STATE_KEY, resetViewState, viewGet } from "./viewState";
import messageSrc from "./AssistantMessage.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import subagentSrc from "./SubagentView.svelte?raw";

// Item 495 part 2: the chat view's folds kept past a chat switch.

function fakeStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/** A `<details>` as far as the action touches it. */
function fakeDetails(open = false) {
  const listeners: (() => void)[] = [];
  const el = {
    open,
    addEventListener: (_: string, f: () => void) => listeners.push(f),
    removeEventListener: (_: string, f: () => void) => listeners.splice(listeners.indexOf(f), 1),
    /** He clicks the summary: the browser flips it, then fires `toggle`. */
    click() {
      el.open = !el.open;
      for (const f of [...listeners]) f();
    },
    listeners,
  };
  return el;
}

describe("the chat view's kept folds", () => {
  let disk: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    disk = fakeStorage();
    resetViewState(disk);
  });

  it("a tool call's fold is the chat's (live and recorded reply share it); others are per turn", () => {
    const live = { chat: "c1", turn: "live:5" };
    const rec = { chat: "c1", turn: "7" };
    expect(foldKey(live, "tool:toolu_1")).toBe(foldKey(rec, "tool:toolu_1"));
    expect(foldKey(live, "block:tool:toolu_1")).toBe(foldKey(rec, "block:tool:toolu_1"));
    expect(foldKey(live, "thinking:0")).not.toBe(foldKey(rec, "thinking:0"));
    expect(foldKey(rec, "thinking:0")).not.toBe(foldKey({ chat: "c2", turn: "7" }, "thinking:0"));
    expect(foldKey(rec, "tool:toolu_1")).not.toBe(foldKey({ chat: "c2", turn: "7" }, "tool:toolu_1"));
  });

  it("an override round-trips; anything else reads as none", () => {
    expect(decodeOverride(encodeOverride({ open: true, rev: 3 }))).toEqual({ open: true, rev: 3 });
    expect(decodeOverride(encodeOverride({ open: false, rev: 0 }))).toEqual({ open: false, rev: 0 });
    expect(decodeOverride("")).toBeUndefined();
    expect(decodeOverride("x:1")).toBeUndefined();
  });

  it("a fold set reads back after its view is gone, and is session only", () => {
    keptSet("fold:c1|tool:a", true, false);
    expect(keptGet("fold:c1|tool:a", false)).toBe(true);
    expect(disk.m.get(VIEW_STATE_KEY) ?? "{}").not.toContain("fold:");
    // A relaunch: memory gone, nothing on disk.
    resetViewState(disk);
    expect(keptGet("fold:c1|tool:a", false)).toBe(false);
  });

  it("a <details> reads its kept state when drawn and writes each toggle", () => {
    const a = fakeDetails();
    const act = keptOpen(a as unknown as HTMLDetailsElement, { key: "fold:c1|3|removed" });
    expect(a.open).toBe(false);
    a.click();
    expect(viewGet("fold:c1|3|removed", false)).toBe(true);
    act.destroy();
    expect(a.listeners.length).toBe(0);
    // The chat drawn again: a new element, open as he left it.
    const b = fakeDetails();
    keptOpen(b as unknown as HTMLDetailsElement, { key: "fold:c1|3|removed" });
    expect(b.open).toBe(true);
  });

  it("an element reused under another chat reads that chat's state", () => {
    keptSet("fold:c1|3|removed", true, false);
    const el = fakeDetails();
    const act = keptOpen(el as unknown as HTMLDetailsElement, { key: "fold:c1|3|removed" });
    expect(el.open).toBe(true);
    act.update({ key: "fold:c2|3|removed" });
    expect(el.open).toBe(false);
    act.update({ key: "fold:c1|3|removed" });
    expect(el.open).toBe(true);
  });

  it("the fallback is the default open state; a null key leaves the element alone", () => {
    const err = fakeDetails();
    keptOpen(err as unknown as HTMLDetailsElement, { key: "fold:c|agent:t|call:x", fallback: true });
    expect(err.open).toBe(true);
    err.click();
    expect(viewGet("fold:c|agent:t|call:x", true)).toBe(false);
    const free = fakeDetails(true);
    keptOpen(free as unknown as HTMLDetailsElement, { key: null });
    expect(free.open).toBe(true);
    free.click();
    expect(disk.m.get(VIEW_STATE_KEY) ?? "{}").toBe("{}");
  });

  it("the transcript passes every reply its folds' place, and the diff its call", () => {
    // Item 674: the running reply's place is `liveFolds` (an aside keeps one
    // scope for the live and the recorded answer).
    expect(transcriptSrc.match(/folds=\{(turnFolds|liveFolds)\(/g)?.length).toBe(2);
    expect(messageSrc.match(/<EditDiffView [^>]*keep=\{detailsKey\(`tool:\$\{[a-z.]+\.id\}:diff`\)\}/g)?.length).toBe(2);
    expect(messageSrc).toMatch(/<details class="sub" use:keptOpen=/);
    expect(messageSrc).toMatch(/<details class="removed-original" use:keptOpen=/);
    expect(transcriptSrc.match(/<details class="[a-z-]+"[^>]*use:keptOpen=/g)?.length).toBe(4);
    expect(subagentSrc.match(/use:keptOpen=/g)?.length).toBe(3);
    expect(transcriptSrc).not.toMatch(/diffOpen\[/);
  });
});
