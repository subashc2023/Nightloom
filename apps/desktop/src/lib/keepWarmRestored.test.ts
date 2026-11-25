// Item 972: the launch offer — every restored tab's chat once, a waiting answer asked again.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { offerRestoredKeepWarm, restoredChats } from "./keepWarmRestored";
import { emptyWorkspace, makeTab } from "./tabs";

describe("keep-warm offer at launch (item 972)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("names every restored chat tab once, shown or not", () => {
    const ws = emptyWorkspace();
    ws.panes[0].tabs = [makeTab({ kind: "chat", session: "a" }), makeTab({ kind: "note", scope: "project", name: "n" } as never), makeTab({ kind: "chat", session: "b" }), makeTab({ kind: "chat", session: "a" }), makeTab({ kind: "chat", session: "c" }), makeTab({ kind: "chat", session: null })];
    ws.panes[0].active = ws.panes[0].tabs[0].id;
    expect(restoredChats(ws)).toEqual(["a", "b", "c"]);
  });
  it("offers all three, and asks again only for what waited for the connection", async () => {
    const spy = vi.spyOn(api, "keepWarmOfferRestored").mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await offerRestoredKeepWarm(["a", "b", "c"], [5]);
    expect(spy).toHaveBeenCalledWith(["a", "b", "c"]);
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("does nothing with no chats and stops quietly on an error", async () => {
    const spy = vi.spyOn(api, "keepWarmOfferRestored").mockRejectedValue("no");
    await offerRestoredKeepWarm([]);
    await offerRestoredKeepWarm(["a"], [5]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
