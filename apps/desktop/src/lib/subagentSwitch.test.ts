import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "./catalog";
import { SWITCH_1757_KEY, switchSameToChoose } from "./subagentSwitch";

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const draft = (model: "same" | "choose" | "sonnet") => ({ agentLimits: { ...DEFAULT_LIMITS, off: { ...DEFAULT_LIMITS.off }, model } });

describe("blocker 1757 — Same becomes Choose once", () => {
  it("first launch: the setting and the files are switched, the other limits untouched, the marker kept", () => {
    const s = store();
    const d = draft("same");
    const before = { ...d.agentLimits, model: "choose" };
    const save = vi.fn();
    const files = vi.fn(async () => 136);
    expect(switchSameToChoose(d, s, save, files)).toBe(true);
    expect(d.agentLimits).toEqual(before);
    expect(save).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenCalledTimes(1);
    expect(s.m.has(SWITCH_1757_KEY)).toBe(true);
  });

  it("never again: he sets it back to Same and the next launch leaves it", () => {
    const s = store();
    switchSameToChoose(draft("same"), s, () => {}, async () => 0);
    const d = draft("same");
    const files = vi.fn(async () => 0);
    expect(switchSameToChoose(d, s, () => {}, files)).toBe(false);
    expect(d.agentLimits.model).toBe("same");
    expect(files).not.toHaveBeenCalled();
  });

  it("Sonnet or Choose is not changed (the files are still asked: some chats may be on Same)", () => {
    const d = draft("sonnet");
    const save = vi.fn();
    const files = vi.fn(async () => 3);
    expect(switchSameToChoose(d, store(), save, files)).toBe(true);
    expect(d.agentLimits.model).toBe("sonnet");
    expect(save).not.toHaveBeenCalled();
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("a backend refusal is swallowed and not retried", async () => {
    const s = store();
    expect(switchSameToChoose(draft("same"), s, () => {}, async () => Promise.reject(new Error("no")))).toBe(true);
    await Promise.resolve();
    expect(switchSameToChoose(draft("same"), s, () => {}, async () => 0)).toBe(false);
  });
});
