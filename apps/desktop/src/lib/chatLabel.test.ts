// Item 462: a chat named by its first message is drawn as one capped line.
import { describe, expect, it } from "vitest";
import { chatLabel, nameLine } from "./chatLabel";
import { tabTitle } from "./tabs";

const HIS =
  "Alright so I've got a midterm for this class on Friday. This is midterm 2. Funny story, I didn't even go to class for midterm 1 cuz i completely had forgot that we had a midterm.\nLuckily she drops the lowest score.";

describe("nameLine (item 462)", () => {
  it("keeps a short name as it is", () => {
    expect(nameLine("Lecture 4 & 5")).toBe("Lecture 4 & 5");
  });
  it("cuts a long first message to one line of 60 with an ellipsis", () => {
    const n = nameLine(HIS);
    expect(n.length).toBeLessThanOrEqual(60);
    expect(n.endsWith("…")).toBe(true);
    expect(n).not.toContain("\n");
    expect(n.startsWith("Alright so I've got a midterm")).toBe(true);
  });
  it("falls back when there is nothing", () => {
    expect(chatLabel({ title: null, first_user: null }, "empty session")).toBe("empty session");
    expect(chatLabel(undefined, "x")).toBe("x");
  });
});

describe("tab titles (item 462)", () => {
  const sessions = [{ id: "c6fe5cf8", title: HIS, first_user: HIS }];
  it("caps an aside tab's chat name — his screenshot's tooltip", () => {
    const t = tabTitle({ kind: "aside", session: "c6fe5cf8" }, sessions);
    expect(t.startsWith("Aside · Alright so")).toBe(true);
    expect(t.length).toBeLessThanOrEqual("Aside · ".length + 60);
  });
  it("caps a chat tab's name", () => {
    expect(tabTitle({ kind: "chat", session: "c6fe5cf8" }, [{ id: "c6fe5cf8", title: null, first_user: HIS }]).length).toBeLessThanOrEqual(60);
  });
});
