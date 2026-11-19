import { describe, expect, it } from "vitest";
import { linksIn, parseRepeat, parseWatch, proposeWatch, readJobDraft, sourceLines, watchLine, writeJobDraft, type Job } from "./jobs";

describe("item 794: research watch", () => {
  it("reads 'keep this current' and its pages out of a message", () => {
    expect(parseWatch("keep this current: sparse autoencoders")).toEqual({ topic: "sparse autoencoders", sources: [] });
    expect(parseWatch("Keep current — concept extrapolation, and https://aligned.ai/blog.")).toEqual({
      topic: "concept extrapolation",
      sources: ["https://aligned.ai/blog"],
    });
    expect(parseWatch("keep me posted on: the Rust 2027 edition")).toEqual({ topic: "the Rust 2027 edition", sources: [] });
    expect(parseWatch("keep it current on brand safety")?.topic).toBe("brand safety");
    // Not a watch: ordinary messages, and an empty topic.
    expect(parseWatch("keep this file current please")).toBeNull();
    expect(parseWatch("please keep this current: x")).toBeNull();
    expect(parseWatch("keep this current: https://only.a/link")).toBeNull();
    // A repeat stays a repeat.
    expect(parseWatch("repeat every morning: keep this current: x")).toBeNull();
    expect(parseRepeat("keep this current: x")).toBeNull();
  });

  it("proposes instructions, a daily time and the named pages, all editable", () => {
    const p = proposeWatch({ topic: "ACE", sources: ["https://a.org", "https://b.org"] });
    expect(p.every).toBe("every morning");
    expect(p.text).toContain("“ACE”");
    expect(p.text).toContain("page you opened");
    expect(sourceLines(p.sources)).toEqual(["https://a.org", "https://b.org"]);
    expect(sourceLines(" a \n\n b ")).toEqual(["a", "b"]);
    expect(linksIn("see https://x.org/a, https://x.org/a and http://y.io.")).toEqual(["https://x.org/a", "http://y.io"]);
  });

  it("keeps a half-made watch in the form's draft", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    writeJobDraft({ every: "", text: "", title: "", watch: { topic: "ACE", sources: "" } }, store);
    expect(readJobDraft(store)?.watch).toEqual({ topic: "ACE", sources: "" });
    writeJobDraft({ every: "every morning", text: "x", title: "" }, store);
    expect(readJobDraft(store)?.watch).toBeUndefined();
    writeJobDraft(null, store);
    expect(readJobDraft(store)).toBeNull();
  });

  it("says on the row which note it keeps and what it checks", () => {
    const j = { watch: { topic: "ACE", sources: ["https://a.org"], note: "watch-ace.md" } } as unknown as Job;
    expect(watchLine(j)).toBe("Keeps watch-ace.md current · checks the literature, news and 1 page");
    expect(watchLine({ watch: null } as unknown as Job)).toBe("");
  });
});
