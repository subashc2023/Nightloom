import { describe, expect, it } from "vitest";
import { afterSend, feedbackSurface } from "./feedbackText";
import { FEEDBACK_PHONE_KEY, loadPhoneFeedback, savePhoneFeedback, sentSentence } from "../remote/feedbackDraft";
import { keptSheet } from "../remote/schemeReload";

/** Item 805: the feedback box and the phone's sheet. */
describe("feedback (item 805)", () => {
  it("clears only the words that were sent, keeping what was typed meanwhile", () => {
    expect(afterSend("hello", "hello")).toBe("");
    expect(afterSend("hello\nand more", "hello")).toBe("and more");
    expect(afterSend("rewritten", "hello")).toBe("rewritten");
  });

  it("names where it was sent from in plain words", () => {
    expect(feedbackSurface({ home: false, asideOpen: false, theme: "Jarvis" })).toBe("the Mac (Jarvis theme)");
    expect(feedbackSurface({ home: true, asideOpen: true, theme: "Classic" })).toBe(
      "Home on the Mac (Classic theme, an aside open beside the chat)",
    );
  });

  it("keeps the phone's half-typed words until they are sent or discarded", () => {
    const m = new Map<string, string>();
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
    savePhoneFeedback("half typed\n  with spacing ", store);
    expect(m.get(FEEDBACK_PHONE_KEY)).toBe("half typed\n  with spacing ");
    expect(loadPhoneFeedback(store)).toBe("half typed\n  with spacing ");
    savePhoneFeedback("", store);
    expect(m.has(FEEDBACK_PHONE_KEY)).toBe(false);
  });

  it("a reload puts the feedback sheet back", () => {
    expect(keptSheet("feedback")).toBe("feedback");
  });

  it("says which item it became, or why it waits", () => {
    expect(
      sentSentence({ filed: { project: "nightshift-code", item: "807", file: "backlog/807-x.md" }, pending_why: null, saved: null, also_filed: [] }),
    ).toBe("Feedback sent — item 807 in nightshift-code.");
    expect(sentSentence({ filed: null, pending_why: "a shift is live", saved: "x", also_filed: [] })).toBe(
      "Feedback saved, not filed yet — a shift is live.",
    );
  });
});
