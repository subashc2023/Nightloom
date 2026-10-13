import { afterEach, describe, expect, it, vi } from "vitest";
import { saveDraft, saveNoteDraft, unsavedDrafts } from "./client";
import { saveNsDraft } from "./nightshiftClient";
import { atRisk } from "./schemeReload";

/** Storage full or blocked: every write throws, as Safari's does. */
function storageFails() {
  const quota = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  vi.spyOn(localStorage, "setItem").mockImplementation(quota);
  vi.spyOn(localStorage, "removeItem").mockImplementation(quota);
}

const calm = { attachments: 0, writes: 0, unkept: false, held: false, naming: false };

describe("a failed draft save unmarks data-kept (item 303, 302 review 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Each save that works clears its own key.
    saveDraft("c1", "");
    saveNoteDraft("n1", null);
    saveNsDraft("b1", null);
    localStorage.clear();
  });

  it("a save that works says so, and nothing is at risk", () => {
    expect(saveDraft("c1", "half a thought")).toBe(true);
    expect(unsavedDrafts()).toBe(0);
    expect(atRisk({ ...calm, unsavedDrafts: unsavedDrafts() })).toBe(false);
  });

  it("the composer, a note and a blocker answer: a failed save is counted, so the reload waits", () => {
    storageFails();
    expect(saveDraft("c1", "half a thought")).toBe(false);
    expect(saveNoteDraft("n1", { text: "new words", base: "" })).toBe(false);
    expect(saveNsDraft("b1", { text: "yes" })).toBe(false);
    expect(unsavedDrafts()).toBe(3);
    expect(atRisk({ ...calm, unsavedDrafts: unsavedDrafts() })).toBe(true);
  });

  it("once storage works again the next save clears it", () => {
    storageFails();
    saveDraft("c1", "half a thought");
    expect(unsavedDrafts()).toBe(1);
    vi.restoreAllMocks();
    expect(saveDraft("c1", "half a thought, finished")).toBe(true);
    expect(unsavedDrafts()).toBe(0);
  });

  it("an emptied field has nothing to lose, even when its removal fails", () => {
    storageFails();
    saveDraft("c1", "words");
    expect(unsavedDrafts()).toBe(1);
    saveDraft("c1", "   ");
    expect(unsavedDrafts()).toBe(0);
  });
});
