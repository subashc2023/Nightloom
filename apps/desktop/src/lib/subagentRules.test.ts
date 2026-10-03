import { describe, expect, it } from "vitest";
import {
  adoptNewChat,
  emptyRules,
  hasOwnRules,
  limitsSummary,
  loadRules,
  readRules,
  rulesFor,
  saveRules,
  setRulesFor,
  useDefaultFor,
} from "./subagentRules";
import { DEFAULT_LIMITS, allOn, readLimits } from "./catalog";

describe("subagent rules in words (backlog 291)", () => {
  it("a chat reads its own text, else the Settings default", () => {
    const s = emptyRules();
    s.default = "Two at once, ask before a third.";
    expect(rulesFor(s, "a")).toBe("Two at once, ask before a third.");
    expect(hasOwnRules(s, "a")).toBe(false);
    setRulesFor(s, "a", "No subagents in this chat.");
    expect(rulesFor(s, "a")).toBe("No subagents in this chat.");
    expect(rulesFor(s, "b")).toBe(s.default);
    // An empty own text is his choice too, not the default.
    setRulesFor(s, "b", "");
    expect(rulesFor(s, "b")).toBe("");
    useDefaultFor(s, "b");
    expect(rulesFor(s, "b")).toBe(s.default);
  });

  it("a New chat's text becomes the chat's own when its first turn makes it", () => {
    const s = emptyRules();
    s.default = "default";
    expect(rulesFor(s, null)).toBe("default");
    setRulesFor(s, null, "for the new one");
    expect(rulesFor(s, null)).toBe("for the new one");
    expect(adoptNewChat(s, "made")).toBe(true);
    expect(rulesFor(s, "made")).toBe("for the new one");
    expect(s.newChat).toBeNull();
    expect(rulesFor(s, null)).toBe("default");
    expect(adoptNewChat(s, "other")).toBe(false);
    expect(hasOwnRules(s, "other")).toBe(false);
  });

  it("round-trips through storage and reads a torn value as nothing", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => void (mem[k] = v) };
    const s = emptyRules();
    s.default = "d";
    setRulesFor(s, "a", "x");
    saveRules(storage, s);
    expect(loadRules(storage)).toEqual(s);
    mem["nightloom.subagent-rules"] = "{not json";
    expect(loadRules(storage)).toEqual(emptyRules());
    expect(readRules({ default: 3, chats: { a: "ok", b: 4 } })).toEqual({ default: "", chats: { a: "ok" }, newChat: null });
  });
});

describe("the folded limits grid (backlog 291)", () => {
  it("summarises the numbers in force, and folding keeps every stored number", () => {
    expect(limitsSummary(DEFAULT_LIMITS)).toBe("6 a message · 4 at once · depth 3 · 4 from 70% · stop at 85% · 35% a message");
    const mine = readLimits({ ...DEFAULT_LIMITS, per_turn: 2, stop_at: 60, off: { ...allOn(), budget_pct: true } });
    expect(limitsSummary(mine)).toBe("2 a message · 4 at once · depth 3 · 4 from 70% · stop at 60% · no message budget");
    // The fold is display only: the stored object is untouched by it.
    expect(mine.per_turn).toBe(2);
    expect(mine.budget_pct).toBe(35);
  });
});
