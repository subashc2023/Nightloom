// @vitest-environment happy-dom
/*
 * Item 1013 (740 Simulator audit): Capture from the phone said "Capturing on the Mac" for 4 s; the 3-minute pass
 * then saved 58 observations and the phone never said so. Now (item 1005's rule, mirrored): started → working
 * with a clock → the Mac's result line, held until he closes it; a missed end event is caught by Running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import PassStatusView from "./PassStatus.svelte";
import { MISSED_AFTER_MS, clockText, passEvent, passRunningRead, passStarted, type PassStatus } from "./passStatus";

describe("1013: the pass's status, pure", () => {
  it("start → the Mac's done line, with the start's clock kept", () => {
    const s = passStarted("capture", "the Mac", 1000);
    expect(s).toMatchObject({ kind: "capture", phase: "working", ended: null });
    expect(s.text).toMatch(/^Capturing on the Mac/);
    const text = "capture: captured 58 observations from 6 chats — 58 from STATS 67";
    const e = passEvent(s, JSON.stringify({ kind: "capture", state: "done", text }), 181_000);
    expect(e).toEqual({ kind: "capture", phase: "done", text, since: 1000, ended: 181_000 });
  });
  it("a failed end says failed; a started event or a malformed one changes nothing", () => {
    const s = passStarted("dream", "the Mac", 0);
    expect(passEvent(s, '{"kind":"dream","state":"started","text":null}', 5)).toBe(s);
    expect(passEvent(s, "{nope", 5)).toBe(s);
    expect(passEvent(s, '{"kind":"dream","state":"failed","text":"dream failed: no provider"}', 5)?.phase).toBe("failed");
    expect(passEvent(s, '{"kind":"dream","state":"failed","text":null}', 5)?.text).toBe("Dream failed on the Mac");
  });
  it("the empty-inbox dream ends as done, in its own words", () => {
    const s = passStarted("dream", "the Mac", 0);
    const e = passEvent(s, JSON.stringify({ kind: "dream", state: "done", text: "dream: nothing to consolidate — the memory inbox is empty (Capture fills it)" }), 900);
    expect(e?.phase).toBe("done");
    expect(e?.text).not.toMatch(/failed/);
  });
  it("Running no longer listing it ends a missed pass; listed, or too soon, it keeps working", () => {
    const s = passStarted("capture", "the Mac", 0);
    expect(passRunningRead(s, { dream: false, capture: true }, MISSED_AFTER_MS + 1)).toBe(s);
    expect(passRunningRead(s, { dream: false, capture: false }, MISSED_AFTER_MS - 1)).toBe(s);
    const m = passRunningRead(s, { dream: false, capture: false }, MISSED_AFTER_MS + 1);
    expect(m?.phase).toBe("done");
    expect(m?.text).toMatch(/missed its result/);
    const done: PassStatus = { ...s, phase: "done", ended: 5 };
    expect(passRunningRead(done, { dream: false, capture: false }, 99_999)).toBe(done);
  });
  it("clock", () => {
    expect(clockText(7_000)).toBe("0:07");
    expect(clockText(151_000)).toBe("2:31");
    expect(clockText(3_725_000)).toBe("1:02:05");
  });
});

describe("1013: PassStatus drawn", () => {
  let root: ReturnType<typeof mount> | null = null;
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: 0 }));
  afterEach(() => {
    if (root) unmount(root);
    root = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("working: the start line, a pulsing dot and a ticking clock", () => {
    let closed = 0;
    root = mount(PassStatusView, { target: document.body, props: { status: passStarted("capture", "the Mac", 0), onclose: () => closed++ } });
    flushSync();
    const el = document.querySelector("[data-pass-status]")!;
    expect(el.getAttribute("data-pass-status")).toBe("working");
    expect(el.textContent).toContain("Capturing on the Mac");
    expect(el.querySelector(".ps-dot")).not.toBeNull();
    expect(el.querySelector(".ps-clock")?.textContent).toBe("0:00");
    vi.advanceTimersByTime(65_000);
    flushSync();
    expect(el.querySelector(".ps-clock")?.textContent).toBe("1:05");
    expect(closed).toBe(0);
  });

  it("result: the Mac's line and how long it took, held until closed", () => {
    let closed = 0;
    const text = "capture: captured 58 observations from 6 chats";
    const st = passEvent(passStarted("capture", "the Mac", 0), JSON.stringify({ kind: "capture", state: "done", text }), 178_000)!;
    root = mount(PassStatusView, { target: document.body, props: { status: st, onclose: () => closed++ } });
    flushSync();
    vi.advanceTimersByTime(10 * 60_000);
    flushSync();
    const el = document.querySelector("[data-pass-status]")!;
    expect(el.getAttribute("data-pass-status")).toBe("done");
    expect(el.textContent).toContain(text);
    expect(el.querySelector(".ps-clock")?.textContent).toBe("· 2:58");
    expect(el.querySelector(".ps-dot")).toBeNull();
    (el.querySelector("button[aria-label='Close']") as HTMLButtonElement).click();
    expect(closed).toBe(1);
  });
});

