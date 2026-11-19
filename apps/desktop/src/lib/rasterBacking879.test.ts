// Item 879 (2:54 PM): a transparent PNG with black lines drew black-on-dark. `rasterBackingOf` decides paper.
import { describe, expect, it } from "vitest";
import replyMedia from "./ReplyMedia.svelte?raw";
import fileView from "./FileView.svelte?raw";
import noteMedia from "./NoteMedia.svelte?raw";
import toolImages from "./ToolImagesView.svelte?raw";
import attachmentView from "./AttachmentView.svelte?raw";
import attachmentLayer from "./AttachmentLayer.svelte?raw";
import userBubble from "./UserBubble.svelte?raw";
import userBubbleClassic from "./UserBubbleClassic.svelte?raw";
import noteEditor from "./noteEditor.ts?raw";

// A .css ?raw import is empty under vitest; read the file (as svgBacking879.test.ts does).
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
import { rasterBackingOf } from "./rasterBacking";

/** A w×h picture: `paint(x, y)` answers [r, g, b, a]. */
function picture(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(paint(x, y), (y * w + x) * 4);
  return px;
}
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
const grid = (x: number, y: number) => x % 20 === 0 || y % 20 === 0;

describe("rasterBackingOf (item 879)", () => {
  it("puts black lines on a transparent background on paper", () => {
    expect(rasterBackingOf(picture(200, 100, (x, y) => (grid(x, y) ? [0, 0, 0, 255] : CLEAR)))).toBe("paper");
  });

  it("puts his kind of drawing on paper: white boxes with black outlines and wires on nothing", () => {
    const px = picture(200, 100, (x, y) => {
      const inBox = x >= 40 && x < 100 && y >= 20 && y < 80;
      const edge = inBox && (x === 40 || x === 99 || y === 20 || y === 79);
      if (edge || y === 50 || x === 150) return [0, 0, 0, 255];
      return inBox ? [255, 255, 255, 255] : CLEAR;
    });
    expect(rasterBackingOf(px)).toBe("paper");
  });

  it("counts thin dark lines thinned by scaling (half-transparent ink)", () => {
    expect(rasterBackingOf(picture(200, 100, (x, y) => (grid(x, y) ? [20, 20, 20, 110] : CLEAR)))).toBe("paper");
  });

  it("leaves an opaque picture as it is, dark or light", () => {
    expect(rasterBackingOf(picture(100, 100, (x, y) => (grid(x, y) ? [0, 0, 0, 255] : [255, 255, 255, 255])))).toBe("none");
    expect(rasterBackingOf(picture(100, 100, () => [10, 10, 10, 255]))).toBe("none");
  });

  it("leaves a transparent picture drawn in light ink as it is", () => {
    expect(rasterBackingOf(picture(200, 100, (x, y) => (grid(x, y) ? [235, 235, 235, 255] : CLEAR)))).toBe("none");
  });

  it("leaves a fully transparent or empty picture as it is", () => {
    expect(rasterBackingOf(picture(10, 10, () => CLEAR))).toBe("none");
    expect(rasterBackingOf(new Uint8ClampedArray(0))).toBe("none");
  });

  it("is wired into every surface a picture shows on, and the paper is white", () => {
    const files = { replyMedia, fileView, noteMedia, toolImages, attachmentView, attachmentLayer, userBubble, userBubbleClassic };
    for (const [name, src] of Object.entries(files)) expect(src, name).toMatch(/use:paperIfDarkInk/);
    expect(replyMedia.match(/use:paperIfDarkInk/g)).toHaveLength(2);
    expect(noteEditor).toMatch(/paperIfDarkInk\(el\)/);
    expect(fs.readFileSync(new URL("./rasterBacking.css", import.meta.url), "utf8")).toMatch(/img\.nl-paper\s*{[^}]*background:\s*#fff/);
  });
});
