// Item 1014 (740 Simulator audit, the minor set) — the phone page's pieces that are not drawn by a component
// of their own. LaTeX in snippets: src/lib/plainMath1014.test.ts; Dream on an empty inbox:
// src/lib/passFeedback1005.state.test.ts; the env token's shape: credentials.rs's Rust tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, SEND_DEADLINE_MS, Unreachable, pillText, shortModel } from "./client";
import { escapeLayer } from "./sheetLayout";


describe("1014: the first Hold while connecting is never invisible", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a send to a host that never answers throws Unreachable at the deadline, not a minute later", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const c = new Client("ab".repeat(16), "http://100.64.0.1:8659");
    const t0 = Date.now();
    await expect(c.send("c1", "hi", { nonce: "n1", deadlineMs: 60 })).rejects.toBeInstanceOf(Unreachable);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(SEND_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });

  it("no deadline asked: no signal (a photo upload may be slow)", async () => {
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => ((seen = init.signal), new Response("sent", { status: 202 })));
    await new Client("ab".repeat(16), "").send("c1", "hi", { nonce: "n1" });
    expect(seen ?? null).toBeNull();
  });

});

describe("1014: the model pill and the Model sheet say one model", () => {
  it("the pill reads the rail in short — 'haiku 5.5', not 'claude-hai…'", () => {
    expect(shortModel("claude-haiku-5-5")).toBe("haiku 5.5");
    // Measured in the Simulator with Aside and Stop: 99 px; "haiku 5.5" needs 114, "sonnet" 98.
    expect(pillText("claude-haiku-5-5", false)).toBe("haiku 5.5");
    expect(pillText("claude-haiku-5-5", true)).toBe("haiku");
    expect(pillText("claude-sonnet-5-5", true)).toBe("sonnet");
    expect(pillText("haiku", true)).toBe("haiku");
  });
});

describe("1014: Escape closes the top layer (Projects had no outside to tap)", () => {
  it("top first", () => {
    expect(escapeLayer({ projectsPage: true, sheet: true, drawer: true })).toBe("project-page");
    expect(escapeLayer({ projectsPage: false, sheet: true, drawer: false })).toBe("projects");
    expect(escapeLayer({ projectsPage: null, sheet: true, drawer: true })).toBe("sheet");
    expect(escapeLayer({ projectsPage: null, sheet: false, drawer: true })).toBe("drawer");
    expect(escapeLayer({ projectsPage: null, sheet: false, drawer: false })).toBeNull();
  });
});
