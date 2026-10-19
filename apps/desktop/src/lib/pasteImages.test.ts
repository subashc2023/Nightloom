import { describe, expect, it } from "vitest";
import {
  attachPastedImages,
  decodeDataUrl,
  htmlImagePaste,
  preparePaste,
  replaceMarker,
  type FetchedImage,
  type PasteImageEffects,
} from "./pasteImages";
import { mathPasteText } from "./mathPaste";
import type { Attachment } from "./types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The shape WebKit's copy put on the clipboard in the probe (report,
// 2026-10-18): paragraphs, an http image, a data: image (a blob: one arrives
// as data: too), each image between paragraphs.
const SAFARI = `<p id="t" style="color: rgb(0, 0, 0);">First paragraph text.</p><img src="http://127.0.0.1:8765/a.png" width="40" height="30" style="color: rgb(0, 0, 0);"><span style="display: inline !important;"></span><p>Between one and two.</p><img src="data:image/png;base64,${PNG}" style="color: rgb(0, 0, 0);"><p>Between two and three.</p><span><img src="data:image/png;base64,${PNG}"></span><p>Last line.</p>`;

describe("htmlImagePaste", () => {
  it("marks each image where it stood, in order, and lists them", () => {
    const p = htmlImagePaste(SAFARI)!;
    expect(p.text).toBe(
      "First paragraph text.\n\n[image 1]\n\nBetween one and two.\n\n[image 2]\n\nBetween two and three.\n\n[image 3]\n\nLast line.",
    );
    expect(p.images.map((i) => [i.n, i.src.slice(0, 22)])).toEqual([
      [1, "http://127.0.0.1:8765/"],
      [2, "data:image/png;base64,"],
      [3, "data:image/png;base64,"],
    ]);
  });

  it("numbers on from the images already in the box", () => {
    const p = htmlImagePaste('<p>a</p><img src="https://x.test/a.png"><p>b</p>', 3)!;
    expect(p.text).toBe("a\n\n[image 3]\n\nb");
    expect(p.images[0]!.n).toBe(3);
  });

  it("puts an inline image inside its sentence with spaces", () => {
    const p = htmlImagePaste('<p>see<img src="https://x.test/a.png">here, and <img src="https://x.test/b.png">.</p>')!;
    expect(p.text).toBe("see [image 1] here, and [image 2].");
  });

  it("leaves a paste with no image alone", () => {
    expect(htmlImagePaste("<p>just text</p>")).toBeNull();
    expect(htmlImagePaste("")).toBeNull();
  });

  it("drops tracking pixels and writes an emoji picture as its alt", () => {
    expect(htmlImagePaste('<p>hi</p><img src="https://t.test/p.gif" width="1" height="1">')).toBeNull();
    const p = htmlImagePaste('<p>nice <img class="emoji" alt="🎉" src="https://e.test/1f389.png"> work</p><img src="https://x.test/a.png">')!;
    expect(p.text).toBe("nice 🎉 work\n\n[image 1]");
    expect(p.images).toHaveLength(1);
  });

  it("takes a lazy loader's real URL over its placeholder", () => {
    const p = htmlImagePaste('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://x.test/real.jpg">')!;
    expect(p.images[0]!.src).toBe("https://x.test/real.jpg");
  });

  it("keeps math converting in the same paste (item 348)", () => {
    const html =
      '<p>Value <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span> below</p><img src="https://x.test/a.png">';
    const p = htmlImagePaste(html)!;
    expect(p.text).toBe("Value $x^2$ below\n\n[image 1]");
    // And math alone still goes through mathPasteText as before.
    expect(mathPasteText(html.replace(/<img[^>]*>/, ""))).toBe("Value $x^2$ below");
  });

  it("caps the images of one paste and says so in place", () => {
    const html = Array.from({ length: 4 }, (_, i) => `<p>${i}</p><img src="https://x.test/${i}.png">`).join("");
    const p = htmlImagePaste(html, 1, 2)!;
    expect(p.images.map((i) => i.n)).toEqual([1, 2]);
    expect(p.text).toContain("[image 3: not attached, over 2 images in one paste]");
    expect(p.text).toContain("[image 4: not attached, over 2 images in one paste]");
  });
});

describe("decodeDataUrl", () => {
  it("decodes a base64 image", () => {
    expect(decodeDataUrl(`data:image/png;base64,${PNG}`)).toEqual({ media_type: "image/png", data: PNG });
  });
  it("refuses what the model cannot take", () => {
    expect(decodeDataUrl("data:image/svg+xml;utf8,<svg/>")).toEqual({ error: "could not be attached (image/svg+xml)" });
    expect(decodeDataUrl("data:nonsense")).toEqual({ error: "could not be read" });
  });
});

describe("replaceMarker", () => {
  it("replaces the first marker of that number only, and nothing when it is gone", () => {
    expect(replaceMarker("a [image 1] b [image 12]", 1, "[image 1: x]")).toBe("a [image 1: x] b [image 12]");
    expect(replaceMarker("edited away", 1, "x")).toBe("edited away");
  });
});

describe("preparePaste + attachPastedImages", () => {
  function harness(fetched: Record<string, FetchedImage | "fail">, boxText: string) {
    let text = boxText;
    let id = 100;
    const chips: Attachment[] = [];
    const toasts: string[] = [];
    const tracked: number[] = [];
    const fx: PasteImageEffects = {
      nextId: () => ++id,
      add: (c) => chips.push({ ...c }),
      update: (i, patch) => Object.assign(chips.find((c) => c.id === i)!, patch),
      remove: (i) => chips.splice(chips.findIndex((c) => c.id === i), 1),
      readText: () => text,
      setText: (t) => {
        text = t;
      },
      fetch: (url) => {
        const r = fetched[url];
        // Out of order on purpose: later URLs settle first.
        return new Promise((ok, no) => setTimeout(() => (r && r !== "fail" ? ok(r) : no(new Error("nope"))), 50 - Object.keys(fetched).indexOf(url) * 10));
      },
      track: (i) => tracked.push(i),
      record: () => {},
      cap: 1000,
      toast: (m) => toasts.push(m),
    };
    return { fx, chips, toasts, tracked, text: () => text };
  }

  it("adds chips in marker order however the fetches finish, and marks the lost one", async () => {
    const html = `<p>a</p><img src="https://x.test/1.png"><p>b</p><img src="data:image/png;base64,${PNG}"><p>c</p><img src="https://x.test/3.png"><img src="data:image/svg+xml;utf8,<svg/>">`;
    const paste = htmlImagePaste(html)!;
    const ready = preparePaste(paste, 1000);
    expect(ready.text).toBe("a\n\n[image 1]\n\nb\n\n[image 2]\n\nc\n\n[image 3] [image 4: could not be attached (image/svg+xml)]");
    const h = harness({ "https://x.test/1.png": { media_type: "image/jpeg", data: "QUJD" }, "https://x.test/3.png": "fail" }, ready.text);
    const done = attachPastedImages(ready.images, ready.failed, h.fx);
    // At once: three chips in order, the fetched ones waiting.
    expect(h.chips.map((c) => [c.name, !!c.pending])).toEqual([
      ["image 1", true],
      ["image 2", false],
      ["image 3", true],
    ]);
    expect(h.tracked).toHaveLength(2);
    await done;
    expect(h.chips.map((c) => [c.name, c.media_type, c.data, !!c.pending])).toEqual([
      ["image 1", "image/jpeg", "QUJD", false],
      ["image 2", "image/png", PNG, false],
    ]);
    expect(h.text()).toContain("[image 3: could not be fetched]");
    expect(h.toasts).toEqual(["2 images from the paste could not be attached (3, 4); their places in the text say so"]);
  });

  it("refuses a fetched image over the cap, in place", async () => {
    const paste = htmlImagePaste('<img src="https://x.test/big.png">')!;
    const ready = preparePaste(paste, 1000);
    const h = harness({ "https://x.test/big.png": { media_type: "image/png", data: "A".repeat(2000) } }, ready.text);
    await attachPastedImages(ready.images, ready.failed, h.fx);
    expect(h.chips).toEqual([]);
    expect(h.text()).toBe("[image 1: could not be attached (over the image size limit)]");
  });
});
