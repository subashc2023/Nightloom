import { describe, expect, it } from "vitest";
import {
  chatIsCold,
  choicesFor,
  markLine,
  pendingFor,
  reconnectBeforeTurn,
  takenAtCold,
  updateNowCost,
} from "./promptVersions";
import type { PendingLayer, PendingView, SessionEvent } from "./types";

const layer = (choice: PendingLayer["choice"], newer = "new"): PendingLayer => ({
  kind: "user_memory",
  held: "old",
  newer,
  choice,
});
const view = (session: string | null, layers: PendingLayer[]): PendingView => ({ session, layers });

describe("chatIsCold", () => {
  it("counts a chat with no cached turn as cold", () => {
    expect(chatIsCold([] as SessionEvent[], Date.now())).toBe(true);
  });
});

describe("takenAtCold", () => {
  it("takes a scheduled mark, and an unclicked one only under the default", () => {
    expect(takenAtCold(layer("cold"), false)).toBe(true);
    expect(takenAtCold(layer("auto"), true)).toBe(true);
    expect(takenAtCold(layer("auto"), false)).toBe(false);
  });
  it("never takes a kept one", () => {
    expect(takenAtCold(layer("keep"), true)).toBe(false);
  });
});

describe("reconnectBeforeTurn", () => {
  it("reconnects when the connection was built for another chat", () => {
    expect(reconnectBeforeTurn(view("a", []), "b", false, true)).toBe(true);
    expect(reconnectBeforeTurn(view(null, []), "b", false, true)).toBe(true);
  });
  it("never reconnects a warm chat for a mark", () => {
    expect(reconnectBeforeTurn(view("a", [layer("auto")]), "a", false, true)).toBe(false);
    expect(reconnectBeforeTurn(view("a", [layer("cold")]), "a", false, true)).toBe(false);
  });
  // ~~"reconnects a cold chat only for a mark that is taken then"~~ —
  // superseded 2026-09-26 (night batch F): a file edited on disk after the
  // last connect has no mark yet, so a cold chat reconnects whatever the
  // marks say and the connect decides what is taken (Rust `resolve`).
  it("reconnects a cold chat so the connect sees files changed since", () => {
    expect(reconnectBeforeTurn(view("a", [layer("auto")]), "a", true, true)).toBe(true);
    expect(reconnectBeforeTurn(view("a", [layer("auto")]), "a", true, false)).toBe(true);
    expect(reconnectBeforeTurn(view("a", [layer("keep")]), "a", true, true)).toBe(true);
    expect(reconnectBeforeTurn(view("a", []), "a", true, true)).toBe(true);
  });
  it("leaves a new chat alone", () => {
    expect(reconnectBeforeTurn(view(null, []), null, true, true)).toBe(false);
    expect(reconnectBeforeTurn(null, "a", true, true)).toBe(false);
  });
  // Batch review 2026-09-23, finding 2: New chat on a connection built for
  // chat A would send A's held texts, warm or cold, marks or none.
  it("reconnects a new chat whose connection was built for another chat", () => {
    expect(reconnectBeforeTurn(view("a", []), null, false, true)).toBe(true);
    expect(reconnectBeforeTurn(view("a", [layer("keep")]), null, true, false)).toBe(true);
  });
});

describe("the words", () => {
  it("says what the chat reads and when it changes", () => {
    expect(markLine(layer("auto"), true, false)).toMatch(/next cold moment/);
    expect(markLine(layer("auto"), false, false)).toMatch(/still reads the version it started with/);
    expect(markLine(layer("keep"), true, true)).toMatch(/^Keeping/);
    expect(markLine(layer("auto", ""), true, false)).toMatch(/^The file is gone/);
  });
  it("prices Update now from the gauge", () => {
    expect(updateNowCost(57_400, false)).toBe("Rewrites ~57k tokens of cache on the next message.");
    expect(updateNowCost(null, false)).toMatch(/size unknown/);
    expect(updateNowCost(57_400, true)).toMatch(/nothing extra/);
  });
  it("offers Keep and, when it would wait for the click, Update at the next cold moment", () => {
    expect(choicesFor(layer("auto"), true).map((c) => c.choice)).toEqual(["keep"]);
    expect(choicesFor(layer("auto"), false).map((c) => c.choice)).toEqual(["cold", "keep"]);
    expect(choicesFor(layer("keep"), true)).toEqual([{ choice: "auto", label: "Update at the next cold moment" }]);
  });
  it("finds a layer's mark", () => {
    expect(pendingFor(view("a", [layer("auto")]), "user_memory", "a")?.held).toBe("old");
    expect(pendingFor(view("a", [layer("auto")]), "knowledge", "a")).toBeNull();
  });
  // Batch review 2026-09-23, finding 3: chat B's Context page must not show
  // (and so cannot edit) chat A's marks.
  it("shows no mark of a chat other than the open one", () => {
    expect(pendingFor(view("a", [layer("auto")]), "user_memory", "b")).toBeNull();
    expect(pendingFor(view("a", [layer("auto")]), "user_memory", null)).toBeNull();
    expect(pendingFor(null, "user_memory", "a")).toBeNull();
  });
});
