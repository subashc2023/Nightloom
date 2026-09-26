import { describe, expect, it } from "vitest";
import { defaultDraft } from "./catalog";
import {
  CHAT_CHOICE_KEY,
  applyChoice,
  choiceOf,
  loadChoices,
  noteConnected,
  noteMade,
  readChoice,
  saveChoices,
  wantedChoice,
  type ChatChoice,
  type ChatChoices,
} from "./chatChoice";

const sonnet: ChatChoice = { engine: "claude-code", provider: "anthropic", model: "", agentModel: "sonnet" };
const haiku: ChatChoice = { ...sonnet, agentModel: "haiku" };
const api: ChatChoice = { engine: "provider", provider: "anthropic", model: "claude-haiku-4-5", agentModel: "sonnet" };

function empty(): ChatChoices {
  return { default: null, chats: {} };
}

describe("each chat's model and engine (backlog 205)", () => {
  it("a pick in one chat leaves another chat's choice alone", () => {
    const c = empty();
    noteConnected(c, "stuart-9", sonnet);
    noteConnected(c, "test", sonnet);
    noteConnected(c, "test", haiku); // ⌘⇧H in the test chat
    expect(wantedChoice(c, "stuart-9")).toEqual(sonnet);
    expect(wantedChoice(c, "test")).toEqual(haiku);
  });

  it("the engine is per chat too", () => {
    const c = empty();
    noteConnected(c, "a", sonnet);
    noteConnected(c, "b", sonnet);
    noteConnected(c, "b", api); // Provider chosen in chat B
    expect(wantedChoice(c, "a")?.engine).toBe("claude-code");
    expect(wantedChoice(c, "b")?.engine).toBe("provider");
  });

  it("a New chat takes the default, which a pick moves and a reopen does not", () => {
    const c = empty();
    noteConnected(c, null, sonnet); // the launch connect, on New chat
    expect(wantedChoice(c, null)).toEqual(sonnet);
    noteConnected(c, "a", haiku); // a pick in chat A
    expect(wantedChoice(c, null)).toEqual(haiku);
    noteConnected(c, "b", sonnet); // B recorded on sonnet...
    noteConnected(c, "a", haiku); // ...A reopened on its own choice
    noteConnected(c, "b", sonnet); // ...B reopened on its own choice
    expect(wantedChoice(c, null)).toEqual(sonnet); // B's first record was a pick
    noteConnected(c, "a", haiku); // reopening A is not a pick
    expect(wantedChoice(c, null)).toEqual(sonnet);
  });

  it("a chat with no record takes the default; a made chat keeps the choice it was made on", () => {
    const c = empty();
    expect(wantedChoice(c, "old")).toBeNull();
    c.default = sonnet;
    expect(wantedChoice(c, "old")).toEqual(sonnet);
    noteMade(c, "made", haiku);
    noteMade(c, "made", sonnet); // a second note never overwrites
    expect(wantedChoice(c, "made")).toEqual(haiku);
  });

  it("survives a relaunch through storage, and reads a torn or stray value as nothing", () => {
    const c = empty();
    noteConnected(c, "a", haiku);
    noteConnected(c, "b", api);
    saveChoices(localStorage, c);
    expect(loadChoices(localStorage)).toEqual(c);
    localStorage.setItem(CHAT_CHOICE_KEY, "{not json");
    expect(loadChoices(localStorage)).toEqual(empty());
    localStorage.setItem(
      CHAT_CHOICE_KEY,
      JSON.stringify({ default: { engine: "gpu" }, chats: { a: haiku, b: { engine: "provider" } } }),
    );
    expect(loadChoices(localStorage)).toEqual({ default: null, chats: { a: haiku } });
    expect(readChoice(null)).toBeNull();
  });

  it("applyChoice puts the four fields on the draft and nothing else", () => {
    const d = defaultDraft();
    d.agentEffort = "low";
    expect(applyChoice(d, haiku)).toBe(true);
    expect(choiceOf(d)).toEqual(haiku);
    expect(d.agentEffort).toBe("low");
    expect(applyChoice(d, haiku)).toBe(false);
  });
});
