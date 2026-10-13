import { afterEach, describe, expect, it, vi } from "vitest";
import { countedFetch, writesInFlight } from "./client";

describe("writesInFlight (item 302)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts a write while it is on its way, and not a read", async () => {
    let finish: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", () => new Promise<Response>((res) => (finish = res)));
    const read = countedFetch("/api/state", {});
    expect(writesInFlight()).toBe(0);
    finish(new Response("{}"));
    await read;
    const send = countedFetch("/api/send", { method: "POST", body: "{}" });
    expect(writesInFlight()).toBe(1);
    finish(new Response("{}"));
    await send;
    expect(writesInFlight()).toBe(0);
  });

  it("a write that fails is no longer counted", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    await expect(countedFetch("/api/send", { method: "POST" })).rejects.toThrow("offline");
    expect(writesInFlight()).toBe(0);
  });
});
