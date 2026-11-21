import { describe, expect, it } from "vitest";
import componentSrc from "./HtmlPage.svelte?raw";
import indexSrc from "../../index.html?raw";
import remoteSrc from "../../remote.html?raw";
import {
  BRIDGE_TAG,
  HTML_CSP,
  HTML_SANDBOX,
  bridgeMessage,
  isHtmlPath,
  pageDocument,
  pagePlace,
  preambleAt,
  setPagePlace,
} from "./htmlPage";

describe("item 819: an HTML file as a sandboxed page", () => {
  it("draws .html and .htm paths as pages, nothing else", () => {
    expect(isHtmlPath("/a/visuals-chunks-1-3.html")).toBe(true);
    expect(isHtmlPath("OLD.HTM")).toBe(true);
    expect(isHtmlPath("notes.md")).toBe(false);
    expect(isHtmlPath("page.html.txt")).toBe(false);
  });

  it("never gives the frame allow-same-origin, in the constant or the component", () => {
    expect(HTML_SANDBOX).toBe("allow-scripts");
    const component = componentSrc;
    expect(component).toMatch(/sandbox=\{HTML_SANDBOX\}/);
    expect(component).not.toMatch(/allow-same-origin/);
    expect(component).not.toMatch(/allow-top-navigation|allow-popups|allow-forms/);
  });

  it("forbids every network load: fetch, XHR, remote images, scripts, styles, frames", () => {
    const d = Object.fromEntries(HTML_CSP.split("; ").map((p) => [p.split(" ")[0], p.slice(p.indexOf(" ") + 1)]));
    expect(d["default-src"]).toBe("'none'");
    expect(d["connect-src"]).toBe("'none'");
    expect(d["frame-src"]).toBe("'none'");
    expect(d["form-action"]).toBe("'none'");
    expect(d["script-src"]).toBe("'unsafe-inline'");
    expect(d["img-src"]).toBe("data: blob:");
    // No directive names a scheme or a host that reaches the network.
    expect(HTML_CSP).not.toMatch(/https?:|\*|'self'/);
  });

  it("puts the policy before the page's first script, after its doctype", () => {
    const page = "<!doctype html><html><head><script>fetch('https://x')</script></head></html>";
    const doc = pageDocument(page, "dark");
    expect(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("fetch("));
    expect(doc).toContain('<meta name="color-scheme" content="dark">');
    expect(doc.endsWith(page.slice("<!doctype html>".length))).toBe(true);
  });

  it("finds the doctype past a BOM, whitespace and comments, and prepends when there is none", () => {
    expect(preambleAt("﻿  <!-- made by a chat -->\n<!DOCTYPE html>\n<p>")).toBe("﻿  <!-- made by a chat -->\n<!DOCTYPE html>".length);
    expect(preambleAt("<p>no doctype</p>")).toBe(0);
    expect(pageDocument("<p>x</p>", "light").startsWith("<meta http-equiv")).toBe(true);
    expect(pageDocument("<p>x</p>", "light")).toContain('content="light"');
  });

  it("takes only the bridge's own message shapes", () => {
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "scroll", x: 0, y: 420 })).toEqual({ tag: BRIDGE_TAG, kind: "scroll", x: 0, y: 420 });
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "scroll", x: -5, y: 3 })?.kind).toBe("scroll");
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "scroll", x: "1", y: 2 })).toBeNull();
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "scroll", x: NaN, y: 2 })).toBeNull();
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "invoke", cmd: "open_file" })).toBeNull();
    expect(bridgeMessage({ kind: "scroll", x: 1, y: 2 })).toBeNull();
    expect(bridgeMessage("scroll")).toBeNull();
    expect(bridgeMessage(null)).toBeNull();
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "link", href: "x".repeat(900) })).toEqual({ tag: BRIDGE_TAG, kind: "link", href: "x".repeat(300) });
  });

  it("keeps a page's scroll by its key", () => {
    expect(pagePlace("file:/a.html")).toBeNull();
    setPagePlace("file:/a.html", 0, 900);
    setPagePlace("note:project:b.html", 0, 40);
    expect(pagePlace("file:/a.html")).toEqual({ x: 0, y: 900 });
    expect(pagePlace("note:project:b.html")).toEqual({ x: 0, y: 40 });
  });

  it("keeps the app's own pages from letting any frame navigate out (frame-src 'none')", () => {
    for (const entry of [indexSrc, remoteSrc]) {
      expect(entry).toContain(`<meta http-equiv="Content-Security-Policy" content="frame-src 'none'" />`);
    }
  });
});
