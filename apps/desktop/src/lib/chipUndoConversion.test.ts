import { describe, expect, it, vi } from "vitest";

// Review fix (item 458 meeting 277): a chip taken out of the box while its
// office file converts — ⌘Z undid the attach, or × removed it — and then
// put back by ⌘Z/⌘⇧Z comes back converted, not as a pending chip with no
// job behind it that Send would no longer wait for and would send empty.

let finish: (v: unknown) => void = () => {};
let fail: (e: unknown) => void = () => {};
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  officeConverter: () => Promise.resolve(true),
  prepareOfficeAttachment: () =>
    new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }),
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

const { acceptFiles, settleRestored } = await import("./attachFiles.svelte");
const { removeAttachment } = await import("./drafts.svelte");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("a converting chip out of the box and back", () => {
  it("comes back with the conversion that finished while it was out", async () => {
    const [chip] = await acceptFiles("chip-undo-a", [new File(["x"], "deck.pptx")], () => {});
    expect(chip.pending).toBe(true);
    removeAttachment("chip-undo-a", chip.id);
    await settle();
    finish({ media_type: "application/pdf", data: "UERG", via: "pdf", count: 3 });
    await settle();
    const back = settleRestored(chip);
    expect(back?.pending).toBe(false);
    expect(back?.data).toBe("UERG");
    // Taken once: the chip that left again carries its converted state itself.
    expect(settleRestored(chip)).toBe(chip);
  });

  it("stays out when the conversion failed meanwhile (the failure was said)", async () => {
    const [chip] = await acceptFiles("chip-undo-b", [new File(["x"], "sheet.xlsx")], () => {});
    removeAttachment("chip-undo-b", chip.id);
    await settle();
    fail(new Error("soffice crashed"));
    await settle();
    expect(settleRestored(chip)).toBeNull();
  });

  it("a chip still converting, or finished, is put back as it is", () => {
    const done = { id: 999_001, kind: "document", name: "a.pdf", media_type: "application/pdf", data: "x" } as const;
    expect(settleRestored({ ...done })).toEqual(done);
  });
});
