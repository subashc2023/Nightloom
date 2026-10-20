import { describe, expect, it, vi } from "vitest";
import { AttachMark, convertOffer, isConvertTag } from "./pastedText.svelte";
import { addAttachment, readDraft } from "./drafts.svelte";
import { followOffer, longPasteOffer } from "./pasteAttach";
import type { Attachment } from "./types";

// Item 399b: the long paste's offer and ⌥⌘V, shared by the composer and
// the edit box of one of his messages (his answer to blocker 1508).

const LONG = Array.from({ length: 2100 }, (_, i) => `word${i}`).join(" ");
const chipFor = (key: string, id: number) => async (): Promise<Attachment> => {
  const chip = { id, kind: "document", media_type: "text/plain", name: "Pasted text", data: "" } as Attachment;
  addAttachment(key, chip);
  return chip;
};

describe("convertOffer", () => {
  it("moves the pasted span into a chip; the text before and after for the Undo", async () => {
    const key = "edit:t1";
    const text = "Before: " + LONG + " after";
    const o = followOffer(longPasteOffer(LONG, 8), text)!;
    expect(o.after).toBe(text);
    const done = await convertOffer(o, key, () => text, chipFor(key, 901));
    expect(done?.before).toBe(text);
    expect(done?.after).toBe("Before:  after");
    expect(readDraft(key).attachments.map((a) => a.id)).toContain(901);
  });
  it("a span no longer there makes no chip", async () => {
    const attach = vi.fn();
    const o = followOffer(longPasteOffer(LONG, 0), LONG)!;
    expect(await convertOffer(o, "edit:t2", () => "he cleared it", attach)).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });
  it("typed into while the chip was made: the chip is taken back, the text stays", async () => {
    const key = "edit:t3";
    let text = LONG;
    const o = followOffer(longPasteOffer(LONG, 0), text)!;
    const done = await convertOffer(o, key, () => text, async () => {
      const chip = await chipFor(key, 903)();
      text = "x" + LONG;
      return chip;
    });
    expect(done).toBeNull();
    expect(readDraft(key).attachments.map((a) => a.id)).not.toContain(903);
  });
  it("the editor closed meanwhile (read gives null): no chip kept", async () => {
    const key = "edit:t4";
    let open = true;
    const o = followOffer(longPasteOffer(LONG, 0), LONG)!;
    const done = await convertOffer(o, key, () => (open ? LONG : null), async () => {
      const chip = await chipFor(key, 904)();
      open = false;
      return chip;
    });
    expect(done).toBeNull();
    expect(readDraft(key).attachments).toHaveLength(0);
  });
});

describe("AttachMark (⌥⌘V)", () => {
  it("marks only the next paste, and only for a moment", () => {
    const now = vi.spyOn(performance, "now");
    const m = new AttachMark(1500);
    now.mockReturnValue(1000);
    m.arm();
    now.mockReturnValue(1200);
    expect(m.take()).toBe(true);
    expect(m.take()).toBe(false);
    m.arm();
    now.mockReturnValue(4000);
    expect(m.take()).toBe(false);
    now.mockRestore();
  });
});

describe("isConvertTag", () => {
  it("knows a conversion's step from any other", () => {
    expect(isConvertTag({ convert: true, chip: {}, before: "", after: "", caret: 0 })).toBe(true);
    expect(isConvertTag(undefined)).toBe(false);
    expect(isConvertTag({ convert: false })).toBe(false);
  });
});
