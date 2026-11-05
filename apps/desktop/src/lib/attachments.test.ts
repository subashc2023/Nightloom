import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./state.svelte";
import { addAttachment, clearDraft, drafts, removeAttachment } from "./drafts.svelte";
import { attachmentBytes, closeAttachment, draftImageContent, openAttachment } from "./attachments.svelte";

// Item 467: an image chip in a message box opens in the floating card; its
// bytes are read from the box's draft, and there are none once the chip is
// removed or the box is sent (the layer then closes the card).
describe("a draft image chip's address", () => {
  beforeEach(() => {
    for (const k of Object.keys(drafts)) delete drafts[k];
    closeAttachment();
  });
  const img = (id: number, data: string) => ({ id, kind: "image" as const, media_type: "image/png", name: `p${id}.png`, data });

  it("resolves to the chip's own bytes, whichever chat is open", () => {
    addAttachment("box", img(7001, "AAA"));
    addAttachment("box", img(7002, "BBB"));
    const c = draftImageContent("box", 7002, "p7002.png");
    expect(attachmentBytes(c)).toEqual({ media_type: "image/png", data: "BBB", name: "p7002.png" });
    app.activeSessionId = "some-other-chat";
    expect(attachmentBytes(c)?.data).toBe("BBB");
  });

  it("has no bytes once removed or sent, never another chip's", () => {
    addAttachment("box", img(7003, "CCC"));
    addAttachment("box", img(7004, "DDD"));
    const c = draftImageContent("box", 7003, "p7003.png");
    removeAttachment("box", 7003);
    expect(attachmentBytes(c)).toBeNull();
    const d = draftImageContent("box", 7004, "p7004.png");
    clearDraft("box");
    expect(attachmentBytes(d)).toBeNull();
  });

  it("opens in the floating slot with the thumbnail's rect", () => {
    addAttachment("box", img(7005, "EEE"));
    const from = { top: 1, left: 2, width: 64, height: 64 };
    openAttachment(draftImageContent("box", 7005, "p7005.png"), from, { width: 10, height: 20 });
    expect(app.tabs.floating?.content).toMatchObject({ kind: "attachment", draft: { key: "box", chip: 7005 } });
  });
});
