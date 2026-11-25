import { describe, expect, it, vi } from "vitest";

vi.mock("./state.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state.svelte")>()),
  sendInChat: vi.fn(),
  chatRuns: vi.fn(() => false),
}));
vi.mock("./drafts.svelte", async (importOriginal) => {
  const real = await importOriginal<typeof import("./drafts.svelte")>();
  return { ...real, enqueueMessage: vi.fn((key: string, text: string, attachments: unknown[]) => real.enqueueMessage(key, text, attachments as never)) };
});

import * as state from "./state.svelte";
import * as drafts from "./drafts.svelte";
import { answerAsk, replyTakesFiles, replyTo } from "./needsBoard.svelte";
import { chipsReady, needsReplyFilesKey, turnAskFilesKey, answerFilesKey } from "./answerFiles";
import hostSrc from "./TurnAskHost.svelte?raw";
import turnSrc from "./TurnAsk.svelte?raw";
import needsSrc from "./NeedsYou.svelte?raw";
import type { Attachment } from "./types";

const chip = (over: Partial<Attachment> = {}): Attachment => ({ id: 1, kind: "image", media_type: "image/png", name: "a.png", data: "QUJD", ...over });
const target = { chat: "c1", name: "A chat", project: null, projectName: null };
const ask = { question: "Which?", options: ["A", "B"] };

describe("983: files on a turn-end answer and a Needs-you reply", () => {
  it("keys of their own, apart from 975's and the message box's", () => {
    expect(turnAskFilesKey("ta-c1-4")).toBe("turn-ask:ta-c1-4");
    expect(needsReplyFilesKey("r1")).toBe("needs-reply:r1");
    expect(turnAskFilesKey("x")).not.toBe(answerFilesKey("x", 0));
  });
  it("a converting chip holds the answer", () => {
    expect(chipsReady([chip()])).toBe(true);
    expect(chipsReady([chip(), chip({ id: 2, pending: true })])).toBe(false);
  });
  it("a turn-end answer sends its files with the message", async () => {
    const files = [chip()];
    expect(await answerAsk(target, ask, "B", files)).toBe(true);
    expect(vi.mocked(state.sendInChat).mock.calls.at(-1)?.slice(0, 4)).toEqual(["c1", { id: null, name: null }, "B", files]);
  });
  it("queued while the chat runs, the files ride the queued row", async () => {
    vi.mocked(state.chatRuns).mockReturnValueOnce(true);
    const files = [chip({ id: 5 })];
    await answerAsk({ ...target, chat: "c2" }, ask, "A", files);
    expect(vi.mocked(drafts.enqueueMessage)).toHaveBeenLastCalledWith("c2", "A", files);
  });
  it("only a reply to a chat takes files; a message row sends them", async () => {
    expect(replyTakesFiles({ reply: "answer-ask" })).toBe(true);
    expect(replyTakesFiles({ reply: "message" })).toBe(true);
    expect(replyTakesFiles({ reply: "answer-blocker" })).toBe(false);
    expect(replyTakesFiles({ reply: "follow-up" })).toBe(false);
    const files = [chip({ id: 7 })];
    const row = { id: "r9", chat: "c3", title: "T", project: null, reply: "message" } as unknown as Parameters<typeof replyTo>[0];
    expect(await replyTo(row, "see this", files)).toBe(true);
    expect(vi.mocked(state.sendInChat).mock.calls.at(-1)?.[3]).toEqual(files);
  });
  it("the card and the box are wired: drop/paste in, chips cleared only when sent", () => {
    expect(turnSrc).toContain("onfiles={onfiles ? (_i, list) => onfiles(list) : undefined}");
    expect(hostSrc).toContain("onfiles={(list) => void acceptFiles(filesKey, list)}");
    expect(hostSrc).toContain("if (await answerAsk(hereTarget(), ask, answer, [...files])) setDraftAttachments(key, []);");
    expect(needsSrc).toContain("ondrop={(e) => takeFiles(row, e.dataTransfer?.files, e)}");
    expect(needsSrc).toContain("onpaste={(e) => takeFiles(row, e.clipboardData?.files, e)}");
    expect(needsSrc).toContain("if (await replyTo(row, words, [...files])) {");
  });
});
