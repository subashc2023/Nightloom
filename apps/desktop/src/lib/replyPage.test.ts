import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import liveSrc from "./liveHtml.ts?raw";
import cardSrc from "./ReplyPage.svelte?raw";
import jarvisSrc from "./AssistantMessage.svelte?raw";
import classicSrc from "./AssistantMessageClassic.svelte?raw";
import phoneSrc from "../remote/Remote.svelte?raw";
import phoneAsideSrc from "../remote/AsideSheet.svelte?raw";
import { BRIDGE_TAG, FIT_MIN, FIT_START, bridgeMessage, fitHeight, pageDocument } from "./htmlPage";
import { FALLBACK_THEME } from "./pageKit";
import { PAGE_CLASS, PAGE_MOUNT_CLASS, PAGE_WRITING_CLASS, fenceClosed, pageFence, pageHead, pageOf, pageTitle, replyPage } from "./replyPage";
import { loadPagesCollapsed } from "./replyPagePrefs.svelte";
import { MAX_LIVE, toSleep } from "./replyPageLive";
import { settledBlocks } from "./streamBlocks";

const md = new Marked().use(replyPage);
const render = (src: string) => md.parse(src, { async: false, gfm: true }) as string;
/** A placeholder as `pageOf` reads it, from the rendered HTML (no DOM here). */
function placeholder(html: string) {
  const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(html)?.[1] ?? null;
  return pageOf({ getAttribute: (n: string) => attr(n) } as unknown as Element);
}

describe("item 770: a page inside a reply", () => {
  it("takes only a fence that says page; a plain html block stays code", () => {
    expect(pageFence("html page")).toEqual({ title: "" });
    expect(pageFence("HTML Page  Sales by month ")).toEqual({ title: "Sales by month" });
    expect(pageFence("htm page")).toEqual({ title: "" });
    expect(pageFence("html")).toBeNull();
    expect(pageFence("html pages")).toBeNull();
    expect(pageFence("page")).toBeNull();
    expect(pageFence(undefined)).toBeNull();
    expect(render("```html\n<p>hi</p>\n```")).toBe('<pre><code class="language-html">&lt;p&gt;hi&lt;/p&gt;\n</code></pre>\n');
  });

  it("draws a closed page fence as a placeholder that carries the page whole", () => {
    const page = `<!doctype html>\n<title>T & "q"</title>\n<style>p{color:red}</style>\n<p>a < b --> c</p>\n<script>if (1 < 2 && "x") document.title = '</title>';</script>`;
    const html = render("Before.\n\n```html page\n" + page + "\n```\n\nAfter.");
    expect(html).toContain(`<div class="${PAGE_CLASS}"`);
    // Nothing of the page is live markup in the reply, and nothing DOMPurify drops an attribute for.
    const tag = /<div class="md-page"[^>]*>/.exec(html)![0];
    expect(tag).not.toMatch(/<\/(style|title|textarea)|-->|<script/i);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    const got = placeholder(html)!;
    expect(got.html).toBe(page);
    expect(got.title).toBe('T & "q"');
    expect(got.key).toMatch(/^[0-9a-z]+:[0-9a-z]+$/);
    expect(html.indexOf("Before.")).toBeLessThan(html.indexOf("md-page"));
    expect(html.indexOf("md-page")).toBeLessThan(html.indexOf("After."));
  });

  it("titles a page by its fence, then its <title>, then Page", () => {
    expect(pageTitle("Named", "<title>Own</title>")).toBe("Named");
    expect(pageTitle("", "<title>Own</title>")).toBe("Own");
    expect(pageTitle("", "<p>x</p>")).toBe("Page");
    expect(placeholder(render("```html page Revenue, 2026\n<p>x</p>\n```"))!.title).toBe("Revenue, 2026");
  });

  it("shows a fence still open as a short code box, not a half page", () => {
    expect(fenceClosed("```html page\n<p>x</p>\n```")).toBe(true);
    expect(fenceClosed("~~~~html page\n<p>x</p>\n~~~~\n")).toBe(true);
    expect(fenceClosed("```html page\n<p>x</p>\n")).toBe(false);
    expect(fenceClosed("```html page\n<p>x</p>\n``")).toBe(false);
    expect(fenceClosed("```html page")).toBe(false);
    const open = render("Here:\n\n```html page\n<div id='c'></div>\n<script>");
    expect(open).toContain(`class="${PAGE_WRITING_CLASS}"`);
    expect(open).not.toContain(`class="${PAGE_CLASS}"`);
    expect(open).toContain("&lt;script&gt;");
    // The same text once the fence closes is the page.
    expect(render("Here:\n\n```html page\n<div id='c'></div>\n<script></script>\n```")).toContain(`class="${PAGE_CLASS}"`);
  });

  it("is a finished block of a streaming reply once its fence closes (drawn once, kept while the rest streams)", () => {
    const { blocks, tail } = settledBlocks("Intro.\n\n```html page\n<p>one</p>\n\n<p>two</p>\n```\n\nAnd then more.\n\nNext wor");
    expect(blocks).toEqual(["Intro.\n\n", "```html page\n<p>one</p>\n\n<p>two</p>\n```\n\n"]);
    expect(tail).toBe("And then more.\n\nNext wor");
  });

  it("starts a page from the app's colours on a transparent ground, at no specificity", () => {
    const head = pageHead(FALLBACK_THEME);
    expect(head).toContain(`--ink:${FALLBACK_THEME.ink};`);
    expect(head).toContain(`--accent:${FALLBACK_THEME.accent};`);
    expect(head).toContain(`--series-8:${FALLBACK_THEME.series[7]};`);
    expect(head).toContain(":where(html){background:transparent");
    // Every rule after the variables is :where(...), so the page's own style always wins.
    const rules = head.slice(head.indexOf("}") + 1, head.indexOf("</style>"));
    for (const r of rules.split("}").filter(Boolean)) expect(r.trim().startsWith(":where("), r).toBe(true);
    // A colour value cannot close the style element or the rule.
    expect(pageHead({ ...FALLBACK_THEME, ink: "red}</style><script>x" })).not.toContain("</style><script>x");
    const doc = pageDocument("<p>x</p>", "dark", { head });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("--ink:"));
    expect(doc.indexOf("--ink:")).toBeLessThan(doc.indexOf("<p>x</p>"));
  });

  it("sizes the frame to the page: its own height between the floor and the cap", () => {
    expect(fitHeight(null, 640)).toBe(FIT_START);
    expect(fitHeight(null, 200)).toBe(200);
    expect(fitHeight(10, 640)).toBe(FIT_MIN);
    expect(fitHeight(412.2, 640)).toBe(413);
    expect(fitHeight(5000, 640)).toBe(640);
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "size", h: 412 })).toEqual({ tag: BRIDGE_TAG, kind: "size", h: 412 });
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "size", h: 1e9 })).toEqual({ tag: BRIDGE_TAG, kind: "size", h: 100000 });
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "size", h: "9" })).toBeNull();
    expect(bridgeMessage({ tag: BRIDGE_TAG, kind: "error", text: "x is not defined" })).toEqual({ tag: BRIDGE_TAG, kind: "error", text: "x is not defined" });
    expect(bridgeMessage({ tag: "other", kind: "error", text: "x" })).toBeNull();
    const doc = pageDocument("<p>x</p>", "dark");
    expect(doc).toContain('post({ kind: "size", h: h })');
    expect(doc).toContain('post({ kind: "error"');
  });

  it("keeps at most MAX_LIVE frames: the farthest sleeps, never one near the viewport", () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({ id: i, near: i >= 6, distance: 1000 * (8 - i) }));
    expect(toSleep(pages).map((p) => p.id)).toEqual([0, 1]);
    expect(toSleep(pages.slice(0, MAX_LIVE))).toEqual([]);
    // All near: none sleeps, even past the limit.
    expect(toSleep(pages.map((p) => ({ ...p, near: true })))).toEqual([]);
  });

  it("opens pages drawn unless the setting says collapsed", () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(loadPagesCollapsed(store(null))).toBe(false);
    expect(loadPagesCollapsed(store("0"))).toBe(false);
    expect(loadPagesCollapsed(store("1"))).toBe(true);
    expect(cardSrc).toContain('chosen === "open" || (chosen === "" && !replyPagePrefs.collapsed)');
  });

  it("is mounted on every surface a reply shows on, and the patcher leaves its card alone", () => {
    for (const [name, src] of [["Jarvis", jarvisSrc], ["Classic", classicSrc], ["phone", phoneSrc], ["phone aside", phoneAsideSrc]] as const)
      expect(src, name).toMatch(/use:replyPages=/);
    expect(phoneAsideSrc.match(/use:replyPages=/g)).toHaveLength(2);
    expect(liveSrc).toContain(`n.classList.contains("${PAGE_MOUNT_CLASS}")`);
    // The card draws through the sandboxed component, never as markup of its own.
    expect(cardSrc).toContain("<HtmlPage");
    expect(cardSrc).not.toMatch(/\{@html/);
    expect(cardSrc).not.toMatch(/<iframe/);
  });
});
