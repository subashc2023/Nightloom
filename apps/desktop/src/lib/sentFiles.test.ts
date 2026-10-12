import { describe, expect, it } from "vitest";
import { isDragMove, isSendFile, parseSentFile, sentExt, sentFileRoute, sentFilesOfCalls } from "./sentFiles";

const ID = "0123456789abcdef0123456789abcdef";
// The shape `send_file.rs`'s `result_text` writes.
const RESULT = `Sent "report.pdf" (1.2 MB) to the user: it is attached to your reply, where they can open it, save it or drag it out.
nightloom-sent-file: {"id":"${ID}","name":"report.pdf","size":1258291,"path":"/u/.nightloom/sent-files/${ID}/report.pdf","caption":"Q3 report"}`;

describe("send_file results", () => {
  it("knows the tool on both engines", () => {
    expect(isSendFile("send_file")).toBe(true);
    expect(isSendFile("mcp__nightloom__send_file")).toBe(true);
    expect(isSendFile("read_file")).toBe(false);
  });

  it("reads the chip's line", () => {
    expect(parseSentFile(RESULT)).toEqual({
      id: ID,
      name: "report.pdf",
      size: 1258291,
      path: `/u/.nightloom/sent-files/${ID}/report.pdf`,
      caption: "Q3 report",
    });
  });

  it("refuses text without the line, bad JSON and a malformed id", () => {
    expect(parseSentFile("Sent nothing")).toBeNull();
    expect(parseSentFile("nightloom-sent-file: {not json")).toBeNull();
    expect(parseSentFile(`nightloom-sent-file: {"id":"../x","name":"a","size":1,"path":"/a"}`)).toBeNull();
  });

  it("collects each file once from successful calls on either engine", () => {
    const ok = { content: RESULT, is_error: false };
    const files = sentFilesOfCalls([
      { name: "mcp__nightloom__send_file", result: ok },
      { name: "send_file", result: ok },
      { name: "send_file", result: { content: RESULT, is_error: true } },
      { name: "send_file", result: null },
      { name: "read_file", result: ok },
    ]);
    expect(files.map((f) => f.name)).toEqual(["report.pdf"]);
  });

  it("builds the phone route with the parts escaped", () => {
    expect(sentFileRoute({ id: ID, name: "my report #1.pdf" })).toBe(`/sent-files/${ID}/my%20report%20%231.pdf`);
  });

  it("badges by extension and tells a drag from a click", () => {
    expect(sentExt("a.PDF")).toBe("pdf");
    expect(sentExt("Makefile")).toBe("file");
    expect(isDragMove({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(isDragMove({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
  });
});
