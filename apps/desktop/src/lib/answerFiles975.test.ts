import { describe, expect, it } from "vitest";
import askSrc from "./AskQuestions.svelte?raw";
import promptSrc from "./ApprovalPrompt.svelte?raw";
import apiSrc from "./api.ts?raw";
import { answerFilesKey, filesToSave, withFilesNote } from "./answerFiles";
import type { Attachment } from "./types";

const chip = (over: Partial<Attachment>): Attachment => ({ id: 1, kind: "image", media_type: "image/png", name: "a.png", data: "QUJD", ...over });

describe("975: files on a question card's answer", () => {
  it("each question of each card has its own key, apart from the message box's", () => {
    expect(answerFilesKey("call_1", 0)).toBe("ask-answer:call_1:0");
    expect(answerFilesKey("call_1", 1)).not.toBe(answerFilesKey("call_1", 0));
    expect(answerFilesKey("call_2", 0)).not.toBe(answerFilesKey("call_1", 0));
  });
  it("saves every kind by name and bytes; a converting chip waits", () => {
    expect(filesToSave([chip({}), chip({ id: 2, kind: "file", name: "x.bin", data: "AAA" }), chip({ id: 3, pending: true, data: "" })])).toEqual([
      { name: "a.png", data: "QUJD" },
      { name: "x.bin", data: "AAA" },
    ]);
  });
  it("the answer names the paths after his words, or alone", () => {
    expect(withFilesNote("Option A", "[Attached a file — …]")).toBe("Option A\n\n[Attached a file — …]");
    expect(withFilesNote("", "[Attached a file — …]")).toBe("[Attached a file — …]");
    expect(withFilesNote("Option A", "")).toBe("Option A");
  });
  it("drop and paste on Other reach the host; the card saves before it answers", () => {
    expect(askSrc).toContain("ondrop={(e) => takeFiles(i, e.dataTransfer?.files, e)}");
    expect(askSrc).toContain("onpaste={(e) => takeFiles(i, e.clipboardData?.files, e)}");
    expect(promptSrc).toContain("acceptFiles(answerFilesKey(req.id, i), list)");
    const at = promptSrc.indexOf("async function answerQuestions()");
    const body = promptSrc.slice(at, at + 2000);
    expect(body.indexOf("saveAnswerFiles(")).toBeGreaterThan(0);
    expect(body.indexOf("saveAnswerFiles(")).toBeLessThan(body.indexOf('decide("allow", payload)'));
    expect(apiSrc).toContain('invoke("save_answer_files"');
  });
  it("not on an aside's card (its answer carries no input)", () => {
    expect(promptSrc).toContain("const takesFiles = $derived(req.aside === undefined);");
  });
});
