// Item 923: toasts last longer; errors and important ones longest; hover holds; a click copies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./state.svelte";
import { ACTION_TOAST_MS, IMPORTANT_TOAST_MS, TOAST_MS, TOAST_RESUME_MS, addToast, copyToast, holdToast, isImportantToast, releaseToast, toastMs } from "./state/toasts.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  app.toasts = [];
});
afterEach(() => vi.useRealTimers());

describe("923: durations", () => {
  it("before 5 s / 8 s with an action; now 8 s / 12 s with an action / 20 s for errors and important ones", () => {
    expect(TOAST_MS).toBe(8000);
    expect(ACTION_TOAST_MS).toBe(12000);
    expect(IMPORTANT_TOAST_MS).toBeGreaterThanOrEqual(15000);
    expect(toastMs("Copied")).toBe(8000);
    expect(toastMs("Removed from context", {})).toBe(12000);
    expect(toastMs("Not sent: no engine is connected")).toBe(IMPORTANT_TOAST_MS);
    expect(isImportantToast("The blocker was not filed — disk full")).toBe(true);
    expect(isImportantToast("Queued — your answer goes when the running work allows.")).toBe(false);
  });
  it("an ordinary toast goes at 8 s, an error not before 20 s", () => {
    addToast("Saved");
    addToast("Could not save the note");
    vi.advanceTimersByTime(7999);
    expect(app.toasts).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(app.toasts.map((t) => t.text)).toEqual(["Could not save the note"]);
    vi.advanceTimersByTime(IMPORTANT_TOAST_MS - 8000 - 1);
    expect(app.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(app.toasts).toHaveLength(0);
  });
});

describe("923: hover and click", () => {
  it("hover holds the timer; leaving keeps what was left, at least 3 s", () => {
    addToast("Saved");
    const id = app.toasts[0].id;
    vi.advanceTimersByTime(7000);
    holdToast(id);
    vi.advanceTimersByTime(60_000);
    expect(app.toasts).toHaveLength(1);
    releaseToast(id);
    vi.advanceTimersByTime(TOAST_RESUME_MS - 1);
    expect(app.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(app.toasts).toHaveLength(0);
  });
  it("a click copies the text", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    addToast("Not sent: no engine");
    expect(await copyToast(app.toasts[0].id)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("Not sent: no engine");
    expect(app.toasts[0].copied).toBe(true);
    vi.unstubAllGlobals();
  });
});
