import { describe, expect, it } from "vitest";
import { OVERLAY_SELECTOR, PageQueue, externalHref, linkRoute, overlaps, parseLinkPref } from "./extlink";

describe("externalHref (links in replies open in the browser, 2026-09-18)", () => {
  const origin = "tauri://localhost";
  it("hands an http(s) or mailto link to the browser", () => {
    expect(externalHref("https://arxiv.org/abs/2607.27250", origin)).toBe(
      "https://arxiv.org/abs/2607.27250",
    );
    expect(externalHref("mailto:a@b.c", origin)).toBe("mailto:a@b.c");
  });
  it("leaves fragments, same-origin, note links and missing hrefs alone", () => {
    expect(externalHref("#top", origin)).toBeNull();
    expect(externalHref("tauri://localhost/x", origin)).toBeNull();
    expect(externalHref("/notes/x", origin)).toBeNull();
    expect(externalHref("note:thing", origin)).toBeNull();
    expect(externalHref(null, origin)).toBeNull();
    expect(externalHref("", origin)).toBeNull();
  });
});

describe("linkRoute (backlog 172: a web tab or the browser)", () => {
  const u = "https://example.com/a";
  it("sends a plain click where the setting says, and ⌘ to the other place", () => {
    expect(linkRoute(u, "browser", false)).toBe("browser");
    expect(linkRoute(u, "browser", true)).toBe("tab");
    expect(linkRoute(u, "tab", false)).toBe("tab");
    expect(linkRoute(u, "tab", true)).toBe("browser");
  });
  it("never makes a tab of mailto or anything not http(s)", () => {
    expect(linkRoute("mailto:a@b.c", "tab", false)).toBe("browser");
    expect(linkRoute("mailto:a@b.c", "browser", true)).toBe("browser");
  });
  it("reads the stored preference, the browser by default", () => {
    expect(parseLinkPref(null)).toBe("browser");
    expect(parseLinkPref("junk")).toBe("browser");
    expect(parseLinkPref("tab")).toBe("tab");
  });
});

describe("overlaps (a dialog over a web tab hides the page)", () => {
  const page = { left: 100, top: 100, right: 500, bottom: 400 };
  it("is true for any shared area and false for touching edges", () => {
    expect(overlaps(page, { left: 450, top: 50, right: 600, bottom: 120 })).toBe(true);
    expect(overlaps(page, { left: 500, top: 100, right: 600, bottom: 400 })).toBe(false);
    expect(overlaps(page, { left: 0, top: 0, right: 99, bottom: 99 })).toBe(false);
  });
});

// Batch review 2026-09-23, finding 4: a native page draws over every HTML
// layer, so whatever floats over the panes must hide it while they overlap.
describe("OVERLAY_SELECTOR", () => {
  it("covers toasts and a moved aside card as well as dialogs and menus", () => {
    const parts = OVERLAY_SELECTOR.split(",").map((p) => p.trim());
    for (const want of [".toast", ".aside-card.moved", '[role="dialog"]', '[role="menu"]', ".settings-overlay"]) {
      expect(parts).toContain(want);
    }
  });
});

// Batch review 2026-09-23, finding 5: a tab closed while its page is being
// created — the close must reach the page, not run before it exists.
describe("PageQueue", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("runs a close only after the open in flight has landed", async () => {
    const q = new PageQueue();
    const log: string[] = [];
    const open = deferred();
    const opened = q.run("web-1", () => {
      log.push("open sent");
      return open.promise.then(() => void log.push("page exists"));
    });
    const closed = q.run("web-1", async () => void log.push("close"));
    await Promise.resolve();
    expect(log).toEqual(["open sent"]);
    open.resolve();
    await opened;
    await closed;
    expect(log).toEqual(["open sent", "page exists", "close"]);
  });

  it("still closes after an open that failed, and keeps labels apart", async () => {
    const q = new PageQueue();
    const log: string[] = [];
    const open = deferred();
    const opened = q.run("web-1", () => open.promise);
    const other = q.run("web-2", async () => void log.push("web-2"));
    const closed = q.run("web-1", async () => void log.push("close web-1"));
    await other;
    expect(log).toEqual(["web-2"]);
    open.reject(new Error("refused"));
    await expect(opened).rejects.toThrow("refused");
    await closed;
    expect(log).toEqual(["web-2", "close web-1"]);
  });
});
