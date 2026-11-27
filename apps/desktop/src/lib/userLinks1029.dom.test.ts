// @vitest-environment happy-dom
// Item 1029: URLs in his own sent words are links (only the URL), long ones wrap in the bubble.
import { describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { externalHref } from "./extlink";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no backend"); } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { linkParts } = await import("./userLinks");
const MathText = (await import("./MathText.svelte")).default;

const draw = (text: string, links = true) => {
  const el = document.createElement("div");
  document.body.append(el);
  const c = mount(MathText, { target: el, props: { text, links } });
  flushSync();
  return { el, done: () => unmount(c) };
};

describe("1029 links in his messages", () => {
  it("renders an <a> that the app's external-link path accepts", () => {
    const { el, done } = draw("see https://example.com/a?b=1#c and http://x.org now");
    const as = [...el.querySelectorAll("a")];
    expect(as.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1#c", "http://x.org"]);
    expect(externalHref(as[0].getAttribute("href"), "http://localhost")).toBe("https://example.com/a?b=1#c");
    expect(el.textContent).toBe("see https://example.com/a?b=1#c and http://x.org now");
    done();
  });
  it("leaves trailing punctuation and an unmatched ) outside the link", () => {
    const urls = (t: string) => linkParts(t).filter((p) => p.kind === "link").map((p) => p.text);
    expect(urls("(see https://a.com/x).")).toEqual(["https://a.com/x"]);
    expect(urls("go to https://a.com/x.")).toEqual(["https://a.com/x"]);
    expect(urls("https://en.wikipedia.org/wiki/A_(b)")).toEqual(["https://en.wikipedia.org/wiki/A_(b)"]);
    expect(urls("https://a.com, then https://b.com!")).toEqual(["https://a.com", "https://b.com"]);
    expect(urls("no link here, https:// alone")).toEqual([]);
  });
  it("keeps the exact text, no markdown, across a line break", () => {
    const t = "**bold** _x_ https://a.com/\nhttps://b.com\n`code`";
    const { el, done } = draw(t);
    expect(el.textContent).toBe(t);
    expect(el.querySelectorAll("a").length).toBe(2);
    done();
  });
  it("without links the text stays plain", () => {
    const { el, done } = draw("https://a.com", false);
    expect(el.querySelectorAll("a").length).toBe(0);
    done();
  });
  it("a 200-character URL is one whole link", () => {
    const long = "https://example.com/" + "a".repeat(180);
    expect(linkParts(long)[0]).toMatchObject({ kind: "link" });
    const { el, done } = draw(long);
    const a = el.querySelector("a")!;
    expect(a.textContent).toBe(long);
    // The wrap rules (.user-link, .user-text, phone .bubble: overflow-wrap: anywhere) are scoped CSS, not applied under happy-dom.
    done();
  });
});
