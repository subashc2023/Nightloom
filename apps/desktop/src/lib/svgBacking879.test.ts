// Item 879 — an SVG drawn as an <img> is its own document: its default black cannot follow the app's text colour,
// so on the dark looks a model's black diagram drew black on near-black. `svgBacking` picks its ground.
import { describe, expect, it } from "vitest";
import { colourLuminance, svgBacking, svgPictureOn, withInk } from "./diagramBlock";
import adder from "../../harness/adder879.svg?raw";
import diagramsSrc from "./diagrams.ts?raw";
import fileViewSrc from "./FileView.svelte?raw";
import promptSrc from "../../../../crates/nightloom-service/src/prompt.rs?raw";

// A .css ?raw import is empty under vitest; read the file.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const cssSrc = fs.readFileSync(new URL("./diagramBlock.css", import.meta.url), "utf8");

const svg = (body: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"${attrs}>${body}</svg>`;

describe("svgBacking (879)", () => {
  it("the 4-bit adder from his shot (black lines and text, no background) goes on paper", () => {
    expect(svgBacking(adder)).toBe("paper");
  });
  it("default black — no colour named at all — goes on paper", () => {
    expect(svgBacking(svg(`<text x="5" y="20">A</text><rect x="1" y="1" width="20" height="20"/>`))).toBe("paper");
  });
  it("currentColor everywhere keeps the theme", () => {
    expect(svgBacking(svg(`<g fill="none" stroke="currentColor"><path d="M0 0L9 9"/></g><text fill="currentColor">A</text>`))).toBe("theme");
    expect(svgBacking(svg(`<style>text{fill:currentColor}</style><text>A</text><line stroke="currentColor"/>`))).toBe("theme");
  });
  it("light strokes keep the theme; one dark colour sends it to paper", () => {
    expect(svgBacking(svg(`<line stroke="#eee" fill="none"/>`, ` fill="none"`))).toBe("theme");
    expect(svgBacking(svg(`<line stroke="currentColor"/><text fill="#222">A</text>`))).toBe("paper");
  });
  it("currentColor with a text relying on default black goes on paper", () => {
    expect(svgBacking(svg(`<line stroke="currentColor"/><text x="1" y="9">A</text>`))).toBe("paper");
  });
  it("a full-size background rect or a root background is its own", () => {
    expect(svgBacking(svg(`<rect width="100%" height="100%" fill="#123"/><text fill="white">A</text>`))).toBe("own");
    expect(svgBacking(svg(`<rect x="0" y="0" width="100" height="50" fill="white"/><text>A</text>`))).toBe("own");
    expect(svgBacking(svg(`<text>A</text>`, ` style="background:#fff"`))).toBe("own");
    // A box smaller than the drawing is not a background.
    expect(svgBacking(svg(`<rect width="20" height="20" fill="white" stroke="black"/>`))).toBe("paper");
  });
  it("an unreadable colour is treated as dark (paper is always readable)", () => {
    expect(svgBacking(svg(`<line stroke="hsl(0 0% 90%)"/>`, ` fill="none"`))).toBe("paper");
  });
  it("luminance reads hex, short hex, rgb and names", () => {
    expect(colourLuminance("#000")).toBe(0);
    expect(colourLuminance("white")).toBeCloseTo(1);
    expect(colourLuminance("rgb(255, 255, 255)")).toBeCloseTo(1);
    expect(colourLuminance("#808080")!).toBeLessThan(0.45);
    expect(colourLuminance("var(--x)")).toBeNull();
  });
});

describe("withInk (879)", () => {
  it("sets currentColor on the root, keeping its own style and an own colour", () => {
    expect(withInk(svg(""), "#e9edf2")).toContain(`style="color:#e9edf2"`);
    expect(withInk(svg("", ` style="font-size:12px"`), "#e9edf2")).toContain(`style="color:#e9edf2;font-size:12px"`);
    expect(withInk(svg("", ` color="red"`), "#e9edf2")).not.toContain("#e9edf2");
    expect(withInk(`<?xml version="1.0"?>\n${svg("")}`, "#fff")).toMatch(/^<\?xml[^>]*>\n<svg[^>]*style="color:#fff"/);
  });
  it("never writes a value that could break out of the attribute", () => {
    expect(withInk(svg(""), `red"><script>`)).toBe(svg(""));
  });
  it("svgPictureOn inks only a themed drawing", () => {
    const themed = svgPictureOn(svg(`<g fill="none" stroke="currentColor"><path d="M0 0L9 9"/></g>`), "#e9edf2")!;
    expect(themed.backing).toBe("theme");
    expect(decodeURIComponent(themed.url)).toContain("color:#e9edf2");
    const paper = svgPictureOn(adder, "#e9edf2")!;
    expect(paper.backing).toBe("paper");
    expect(decodeURIComponent(paper.url)).not.toContain("color:#e9edf2");
  });
});

describe("wiring (879)", () => {
  it("reply and note blocks (and the phone, same watcher) draw an svg on its backing, redrawn on a theme change", () => {
    expect(diagramsSrc).toContain("svgPictureOn(d.src, theme.ink)");
    expect(diagramsSrc).toContain("md-diagram-paper");
    expect(diagramsSrc).toContain("const sig = `${d.key}|${themeEpoch}`");
    expect(cssSrc).toMatch(/\.md-diagram-paper\s*\{[^}]*background:\s*#fff/);
  });
  it("an svg file tab uses the same rule", () => {
    expect(fileViewSrc).toContain("svgBacking(text)");
    expect(fileViewSrc).toContain("class:paper=");
  });
  it("chats are told to draw svg in currentColor", () => {
    const note = /pub const DIAGRAM_NOTE: &str = "([^\n]*)";/.exec(promptSrc)![1];
    expect(note).toContain("currentColor");
  });
});
