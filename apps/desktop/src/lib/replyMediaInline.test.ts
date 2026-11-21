import { describe, expect, it, vi } from "vitest";
// The suite runs in node, where DOMPurify has no window; it keeps `data-*` attributes in the app (as 770's pages rely on).
vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));
import { inlineMediaTargets, renderReply, renderMarkdown, streamingTail } from "./markdown";
import { stripMedia } from "./replyMediaInline";

// Item 875: a markdown image is drawn where the reply placed it; a path named
// alone stays in 820's strip under the reply.

const ROOT = "/Users/demo/work";

describe("pictures where the reply places them", () => {
  it("a local markdown image becomes a placeholder holding its alt text, where it stands", () => {
    const html = renderReply("Before.\n\n![The loss curve](/tmp/loss.png)\n\nAfter.");
    expect(html).toContain('class="md-media"');
    expect(html).toContain(`data-media-src="${encodeURIComponent("/tmp/loss.png")}"`);
    expect(html).toContain('<em class="md-local-img">The loss curve</em>');
    expect(html.indexOf("Before.")).toBeLessThan(html.indexOf("md-media"));
    expect(html.indexOf("md-media")).toBeLessThan(html.indexOf("After."));
  });
  it("the phone's replies get the same placeholder", () => {
    expect(renderMarkdown("![clip](out/clip.mp4)", { breaks: true, localImagesAsText: true })).toContain('class="md-media"');
  });
  it("a web image, and a local file that is not a picture, are unchanged", () => {
    expect(renderReply("![x](https://example.com/a.png)")).toContain("<img");
    const pdf = renderReply("![paper](/tmp/paper.pdf)");
    expect(pdf).not.toContain("md-media");
    expect(pdf).toContain('<em class="md-local-img">paper</em>');
  });
  it("lists the drawn-in-place targets in order, decoded, file:// dropped; none inside code", () => {
    const text = "![a](/tmp/a.png) and ![b](file:///tmp/b%20c.png)\n\n`![c](/tmp/c.png)`\n\n```\n![d](/tmp/d.png)\n```";
    expect(inlineMediaTargets(text)).toEqual(["/tmp/a.png", "/tmp/b c.png"]);
  });
  it("the strip keeps a bare path and leaves out what is drawn in place, even when named both ways", () => {
    const text = `![Plot](${ROOT}/plot.png)\n\nThe raw file is ${ROOT}/plot.png and the other is ${ROOT}/other.png.`;
    expect(stripMedia(text, [ROOT]).map((c) => c.path)).toEqual([`${ROOT}/other.png`]);
  });
  it("a relative markdown image is matched against the chat's folder", () => {
    expect(stripMedia("![p](plot.png) and `plot.png`", [ROOT])).toEqual([]);
  });
  it("with no markdown image, the strip is 820's list as before", () => {
    const text = `Saved ${ROOT}/a.png and ${ROOT}/b.mp4.`;
    expect(stripMedia(text, [ROOT]).map((c) => c.kind)).toEqual(["image", "video"]);
  });
  it("while streaming, a half-typed image is text, and it becomes a placeholder once its ) arrives", () => {
    const half = streamingTail("Here:\n\n![The plot](/tmp/pl");
    expect(renderReply(half)).not.toContain("md-media");
    expect(renderReply(streamingTail("Here:\n\n![The plot](/tmp/plot.png)"))).toContain("md-media");
  });
});
