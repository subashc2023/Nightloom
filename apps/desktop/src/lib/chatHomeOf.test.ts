// Item 874 (finding 2): a FINISHED card for a chat Home's routes ran named the open project, so Open chat went to the
// wrong one. The turn's own record names its project; the open project is only the fallback.
import { describe, expect, it } from "vitest";
import { chatHomeOf } from "./chatHomeOf";

const open = { id: "aisc", name: "AI Safety Collective at Irvine" };

describe("where a chat lives (874)", () => {
  it("an off-screen turn's record wins over the open project", () => {
    expect(chatHomeOf("c1", { active: "c9", open, record: { project: "home", projectName: "Home" } })).toEqual({ id: "home", name: "Home" });
  });
  it("a record with no project is unfiled, not the open project", () => {
    expect(chatHomeOf("c1", { active: null, open, record: { project: null, projectName: null } })).toEqual({ id: null, name: null });
  });
  it("the chat on screen is the open project's; a chat seen this launch is its own project's", () => {
    expect(chatHomeOf("c9", { active: "c9", open, known: { project: "x", name: "X" } })).toEqual(open);
    expect(chatHomeOf("c2", { active: "c9", open, known: { project: "x", name: "X" } })).toEqual({ id: "x", name: "X" });
  });
  it("a chat never seen falls back to the open project", () => {
    expect(chatHomeOf("c3", { active: "c9", open })).toEqual(open);
    expect(chatHomeOf(null, { active: "c9", open })).toEqual(open);
  });
});
