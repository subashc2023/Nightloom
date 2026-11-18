import { describe, expect, it } from "vitest";
import { isLocalTarget, mediaCandidates, mediaKindOf } from "./replyMedia";
import { Marked } from "marked";
import { localImageAsText } from "./markdown";
import mdSrc from "./markdown.ts?raw";
import { _resetMedia, mediaState, type Loaded } from "./replyMediaStore.svelte";
import stripSrc from "./ReplyMedia.svelte?raw";
import macSrc from "./AssistantMessage.svelte?raw";
import classicSrc from "./AssistantMessageClassic.svelte?raw";
import phoneSrc from "../remote/Remote.svelte?raw";
import asideSrc from "../remote/AsideSheet.svelte?raw";

// Item 820: pictures and video a chat makes show inside its reply.

const ROOT = "/Users/demo/work/stats";

describe("mediaCandidates", () => {
  it("finds a markdown image, an absolute path, a backticked name — in order, once each", () => {
    const text = [
      "Saved to `/tmp/plot.png`:",
      "![Two signals](/tmp/plot.png)",
      "The bars are `bars.svg`, the clip /tmp/run/clip.mp4, and notes in `notes/a.md`.",
    ].join("\n\n");
    const got = mediaCandidates(text, [ROOT]);
    expect(got.map((c) => [c.path, c.kind, c.explicit])).toEqual([
      ["/tmp/plot.png", "image", true],
      [`${ROOT}/bars.svg`, "image", false],
      ["/tmp/run/clip.mp4", "video", false],
    ]);
  });

  it("resolves a relative markdown image against the chat's folder; keeps it as written with no folder (the phone)", () => {
    expect(mediaCandidates("![p](out/plot.png)", [ROOT])[0].path).toBe(`${ROOT}/out/plot.png`);
    expect(mediaCandidates("![p](out/plot.png)", [])[0].path).toBe("out/plot.png");
    expect(mediaCandidates("![p](<my plot.png>)", [ROOT])[0].path).toBe(`${ROOT}/my plot.png`);
  });

  it("skips web images, fenced code, and files that are not pictures or video", () => {
    const text = "![web](https://example.com/a.png) ![d](data:image/png;base64,AAAA)\n\n```\nsavefig('/tmp/in-code.png')\n```\n\n`/tmp/report.pdf`";
    expect(mediaCandidates(text, [ROOT])).toEqual([]);
    expect(isLocalTarget("https://x/a.png")).toBe(false);
    expect(isLocalTarget("//x/a.png")).toBe(false);
    expect(isLocalTarget("plot.png")).toBe(true);
  });

  it("reads kinds by extension, case-blind", () => {
    expect(mediaKindOf("/a/B.PNG")).toBe("image");
    expect(mediaKindOf("/a/b.svg")).toBe("image");
    expect(mediaKindOf("/a/b.webm")).toBe("video");
    expect(mediaKindOf("/a/b.md")).toBeNull();
  });
});

describe("a local markdown image in a reply", () => {
  // DOMPurify needs a DOM, which this suite has not: the extension is run
  // through its own marked instance, and the wiring is read from the source.
  const md = new Marked().use(localImageAsText);
  const parse = (t: string) => md.parse(t, { async: false }) as string;
  it("is its alt text, not a broken <img>; a web image is unchanged", () => {
    const html = parse("![Two signals](/tmp/plot.png) and ![w](https://example.com/w.png)");
    expect(html).toContain('<em class="md-local-img">Two signals</em>');
    expect(html).not.toContain('src="/tmp/plot.png"');
    expect(html).toContain('src="https://example.com/w.png"');
  });
  it("is escaped (alt text is never markup), and falls back to the file name", () => {
    expect(parse("![<b>x</b>](a.png)")).not.toContain("<b>");
    expect(parse("![](out/plot.png)")).toContain(">plot.png</em>");
  });
  it("replies and the phone's replies use it; notes' markdown does not", () => {
    expect(mdSrc).toContain("replyMarked.use(localImageAsText)");
    expect(mdSrc).toContain("phoneMarked.use(localImageAsText)");
    expect(mdSrc).not.toMatch(/^marked\.use\(localImageAsText\)/m);
    expect(phoneSrc).toContain("localImagesAsText: true");
  });
});

describe("an SVG with a script in it never runs it", () => {
  it("the strip draws every picture through <img src={blob url}> and never as markup", () => {
    // No raw HTML at all in the component: an SVG's text cannot reach the DOM.
    expect(stripSrc).not.toMatch(/\{@html/);
    expect(stripSrc).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|<object|<iframe|<embed/);
    expect(stripSrc).toMatch(/<img src=\{s\.url\}/);
  });

  it("the bytes become a typed blob URL — the SVG's text is never read into the page", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>top.__ran=1</script></svg>';
    const loader = async (): Promise<Loaded> => ({
      kind: "image",
      mediaType: "image/svg+xml",
      size: svg.length,
      bytes: new Blob([svg], { type: "application/octet-stream" }),
    });
    _resetMedia(loader);
    expect(mediaState("/tmp/evil.svg", "c").status).toBe("loading");
    await new Promise((r) => setTimeout(r, 20));
    const s = mediaState("/tmp/evil.svg", "c");
    expect(s.status).toBe("done");
    if (s.status !== "done") return;
    expect(s.url.startsWith("blob:")).toBe(true);
    expect((globalThis as { __ran?: number }).__ran).toBeUndefined();
    _resetMedia();
  });
});

describe("the store", () => {
  it("says the size past the limit, and a refusal or a deleted file in words", async () => {
    _resetMedia(async (path) => {
      if (path.endsWith("big.png")) return { kind: "image", mediaType: "image/png", size: 40 * 1024 * 1024, bytes: null };
      throw new Error(`${path} is no longer on disk`);
    });
    mediaState("/tmp/big.png", null);
    mediaState("/tmp/gone.png", null);
    await new Promise((r) => setTimeout(r, 20));
    expect(mediaState("/tmp/big.png", null)).toEqual({ status: "big", kind: "image", size: 40 * 1024 * 1024 });
    expect(mediaState("/tmp/gone.png", null)).toEqual({ status: "failed", message: "/tmp/gone.png is no longer on disk" });
    _resetMedia();
  });
});

describe("every reply surface draws the strip (his rule: asides mirror the main chat)", () => {
  it("the Mac's reply, both looks (asides render through AssistantMessage), the phone's reply and aside sheet", () => {
    for (const src of [macSrc, classicSrc, phoneSrc, asideSrc]) expect(src).toContain("<ReplyMedia");
    expect(phoneSrc).toContain('hasFeature(remote, "reply_media")');
  });
});
