import { describe, expect, it, vi } from "vitest";

/*
 * Item 868: a deck split into parts moves as one in the box's undo
 * history — ⌘Z right after attaching it takes every part, ⌘⇧Z brings every
 * part back — and a deck taken out while it converts comes back with all
 * its parts. And while it converts, the chip and the Notes row say so with
 * the time it has taken.
 */
let finish: (v: unknown) => void = () => {};
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  officeConverter: () => Promise.resolve(true),
  prepareOfficeAttachment: () => new Promise((resolve) => (finish = resolve)),
}));

class StubReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(): void {
    this.result = "data:application/octet-stream;base64,QUJD";
    queueMicrotask(() => this.onload?.());
  }
}
vi.stubGlobal("FileReader", StubReader);

const { acceptFiles, stepChips } = await import("./attachFiles.svelte");
const { readDraft, removeAttachment, setDraftAttachments } = await import("./drafts.svelte");
const { convertingWords } = await import("./attachKinds");
const { addRows, rowWords } = await import("./notesPending");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const split = {
  media_type: "application/pdf",
  name: "deck (part 1 of 2).pptx",
  data: "UDE=",
  via: "pdf",
  count: 92,
  note: "184 slides, over the 100-page limit for one PDF — split into 2 parts",
  source_sha256: "a",
  more: [{ media_type: "application/pdf", name: "deck (part 2 of 2).pptx", data: "UDI=", via: "pdf", count: 92, note: null, source_sha256: "b" }],
};
const names = (key: string) => readDraft(key).attachments.map((a) => a.name);

describe("a split deck in the box's undo history (item 868)", () => {
  it("one ⌘Z after attaching takes every part; ⌘⇧Z brings every part back", async () => {
    const key = "split-undo-a";
    const [chip] = await acceptFiles(key, [new File(["x"], "deck.pptx")], () => {});
    await settle();
    finish(split);
    await settle();
    expect(names(key)).toEqual(["deck (part 1 of 2).pptx", "deck (part 2 of 2).pptx"]);
    const tag = { chipStep: "add" as const, chip, index: 0 };
    setDraftAttachments(key, stepChips(tag, "undo", readDraft(key).attachments));
    expect(names(key)).toEqual([]);
    setDraftAttachments(key, stepChips(tag, "redo", readDraft(key).attachments));
    expect(names(key)).toEqual(["deck (part 1 of 2).pptx", "deck (part 2 of 2).pptx"]);
    expect(readDraft(key).attachments.every((a) => !a.pending && a.data)).toBe(true);
  });

  it("a deck taken out while it converts comes back with every part", async () => {
    const key = "split-undo-b";
    const [chip] = await acceptFiles(key, [new File(["x"], "deck.pptx")], () => {});
    expect(chip.pending).toBe(true);
    const tag = { chipStep: "add" as const, chip, index: 0 };
    setDraftAttachments(key, stepChips(tag, "undo", readDraft(key).attachments));
    expect(names(key)).toEqual([]);
    await settle();
    finish(split);
    await settle();
    // Nothing lands in the box while the deck is out.
    expect(names(key)).toEqual([]);
    setDraftAttachments(key, stepChips(tag, "redo", readDraft(key).attachments));
    expect(names(key)).toEqual(["deck (part 1 of 2).pptx", "deck (part 2 of 2).pptx"]);
    expect(readDraft(key).attachments.map((a) => a.data)).toEqual(["UDE=", "UDI="]);
  });

  it("a part removed by its own × stays out when part 1 is stepped", async () => {
    const key = "split-undo-c";
    const [chip] = await acceptFiles(key, [new File(["x"], "deck.pptx")], () => {});
    await settle();
    finish(split);
    await settle();
    const part2 = readDraft(key).attachments[1];
    removeAttachment(key, part2.id);
    const tag = { chipStep: "remove" as const, chip: readDraft(key).attachments[0], index: 0 };
    removeAttachment(key, chip.id);
    setDraftAttachments(key, stepChips(tag, "undo", readDraft(key).attachments));
    // Part 1's own removal undone: part 2 left by its own step and stays out.
    expect(names(key)).toEqual(["deck (part 1 of 2).pptx"]);
  });
});

describe("converting words with the time taken (item 868)", () => {
  it("the chip says what it is doing and for how long", () => {
    expect(convertingWords("deck.pptx", "pdf", 72_000)).toBe("converting slides · 1:12");
    expect(convertingWords("notes.docx", "text", 4_000)).toBe("reading document · 0:04");
  });

  it("a Notes row for an office file ticks; any other file reads as before", () => {
    const { list } = addRows([], "p", "files/lectures", [
      { name: "deck.pptx", zip: false },
      { name: "a.pdf", zip: false },
    ], (() => { let n = 0; return () => ++n; })(), 1_000);
    expect(rowWords(list[0], 1_000 + 133_000)).toBe("converting slides · 2:13");
    expect(rowWords(list[1], 5_000)).toBe("adding to files/lectures/…");
    expect(rowWords(list[0])).toBe("adding to files/lectures/…");
  });
});
