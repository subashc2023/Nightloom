import composerSrc from "./Composer.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { ScrollHold, placeOf, putPlace, trackPlace, type BoxPlace, type PlaceBox } from "./boxPlace";
import {
  clearDraft,
  draftScroll,
  drafts,
  loadDrafts,
  moveDraft,
  saveDrafts,
  setDraftScroll,
  setDraftText,
  stashEdit,
  takeEdit,
} from "./drafts.svelte";
import { editReduce } from "./edit";

// Backlog 355: a draft taller than its box comes back at its scroll place
// after a switch — the chat's box and an aside's (the composer: the drafts
// store's `scroll` and `ScrollHold`), and the message-edit box (its place
// stashed with the edit, put back by `putPlace`).

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  localStorage.clear();
});

const long = "line\n".repeat(200);

describe("the composer's kept scroll (the chat's box and an aside's)", () => {
  for (const key of ["chat-1", "aside:u-7"]) {
    it(`${key}: kept beside the text, read back after a switch, a reload too`, () => {
      setDraftText(key, long);
      setDraftScroll(key, 1830.4);
      setDraftText("chat-2", "other");
      setDraftScroll("chat-2", 0);
      expect(draftScroll(key)).toBe(1830);
      expect(draftScroll("chat-2")).toBe(null);
      saveDrafts(drafts, localStorage);
      expect(loadDrafts(localStorage)[key]?.scroll).toBe(1830);
    });
  }
  it("an empty box keeps nothing; a send clears it; a bad stored value reads as none", () => {
    setDraftScroll("nobody", 50);
    expect(draftScroll("nobody")).toBe(null);
    setDraftText("c", long);
    setDraftScroll("c", 400);
    clearDraft("c");
    expect(draftScroll("c")).toBe(null);
    localStorage.setItem("nightloom.drafts", JSON.stringify({ d: { text: "x", attachments: [], scroll: "far" } }));
    const back = loadDrafts(localStorage);
    expect(back.d?.text).toBe("x");
    expect(back.d?.scroll).toBeUndefined();
  });
  it("the pending chat's scroll follows its draft into the chat it made", () => {
    setDraftText("new:p", long);
    setDraftScroll("new:p", 700);
    moveDraft("new:p", "made");
    expect(draftScroll("made")).toBe(700);
  });
});

describe("ScrollHold", () => {
  it("holds the arriving key's place until settled, then lets scrolls record", () => {
    const h = new ScrollHold(600);
    h.start("chat-1", 1000);
    expect(h.holds("chat-1", 1200)).toBe(true);
    expect(h.holds("chat-2", 1200)).toBe(false);
    expect(h.holds("chat-1", 1601)).toBe(false);
    expect(h.holds("chat-1", 1200)).toBe(false);
  });
  it("his own key, press or wheel ends it at once", () => {
    const h = new ScrollHold(600);
    h.start("aside:u-7", 0);
    h.release();
    expect(h.holds("aside:u-7", 10)).toBe(false);
  });
});

class FakeBox implements PlaceBox {
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;
  listeners = new Map<string, () => void>();
  constructor(public value: string) {}
  addEventListener(k: string, f: () => void) {
    this.listeners.set(k, f);
  }
  removeEventListener(k: string) {
    this.listeners.delete(k);
  }
  fire(k: string) {
    this.listeners.get(k)?.();
  }
}

describe("the message-edit box's place", () => {
  it("is tracked as he scrolls and moves, stashed with the edit, and put back on a fresh box", () => {
    const box = new FakeBox(long);
    const places: (BoxPlace | null)[] = [];
    const act = trackPlace(box as unknown as HTMLTextAreaElement, (p) => (places[0] = p));
    box.scrollTop = 2400;
    box.selectionStart = box.selectionEnd = long.length;
    box.fire("scroll");
    expect(places[0]).toEqual({ scroll: 2400, start: long.length, end: long.length });
    const editing = editReduce(null, { type: "begin", index: 3, text: long });
    stashEdit("chat-1", { editing: editing!, line: "", boxes: places.slice() });
    act.destroy();

    // The switch back draws a new textarea at the top; the stash puts it back.
    const again = new FakeBox(long);
    putPlace(again, takeEdit("chat-1")?.boxes?.[0]);
    expect(again.scrollTop).toBe(2400);
    expect(again.selectionStart).toBe(long.length);
  });
  it("a kept caret past a shorter text is clamped, never a reason to change the text", () => {
    const box = new FakeBox("short");
    putPlace(box, { scroll: 90, start: 400, end: 500 });
    expect(box.value).toBe("short");
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 5]);
    expect(box.scrollTop).toBe(90);
  });
  it("nothing kept leaves the box alone", () => {
    const box = new FakeBox(long);
    box.scrollTop = 12;
    putPlace(box, null);
    expect(box.scrollTop).toBe(12);
    expect(placeOf(null)).toBe(null);
  });
});

// Wave 8 review: the hold and the track above are pure; these pin where the
// composer and the edit box use them (removing any failed no test).

describe("355: the wiring", () => {
  it("the composer holds a switched-to key's scroll, puts it back on each re-measure, and records his scrolls", () => {
    expect(composerSrc).toContain("scrollHold.start(k, performance.now());");
    // Within a few lines of the re-measure (360's overflowY line sits between).
    expect(composerSrc).toMatch(/ta\.style\.height = growHeight\([^\n]*\n(?:[^\n]*\n){1,4}\s*putScrollBack\(\);/);
    expect(composerSrc).toContain("onscrollcapture={recordScroll}");
    for (const ev of ["onkeydowncapture", "onbeforeinputcapture", "onwheel"])
      expect(composerSrc).toContain(`${ev}={() => scrollHold.release()}`);
  });
  it("the edit box tracks every textarea and stashes the places with the edit", () => {
    expect(transcriptSrc).toContain("use:trackPlace={(pl) => (editPlaces[0] = pl)}");
    expect(transcriptSrc).toContain("use:trackPlace={(pl) => (editPlaces[p + 1] = pl)}");
    expect([...transcriptSrc.matchAll(/boxes: editPlaces\.slice\(\)/g)].length).toBe(3);
    expect([...transcriptSrc.matchAll(/placeBack\(back/g)].length).toBe(2);
  });
});
