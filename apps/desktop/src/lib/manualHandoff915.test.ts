import { describe, expect, it, vi, beforeEach } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import classicSrc from "./RightRailClassic.svelte?raw";

vi.mock("./state.svelte", () => ({
  app: { busy: false, connection: { engine: "claude-code" }, activeSessionId: "c1", error: null },
  addToast: vi.fn(),
  send: vi.fn(async () => {}),
}));
vi.mock("./handoff.svelte", () => ({
  abortWrapUp: vi.fn(),
  beginWrapUp: vi.fn(),
  message: () => "wrap up please",
  noteActivity: vi.fn(),
  wrapUpToSend: (_c: string | null, t: string) => t,
}));
vi.mock("./wrapAsides.svelte", () => ({
  requestWrapUp: vi.fn(async (_c: string, go: (extra: string) => Promise<void>) => go("")),
}));

import { app, send } from "./state.svelte";
import { handOffBlock, handOffNow, isHandoffCommand } from "./manualHandoff.svelte";

describe("item 915: hand off now", () => {
  beforeEach(() => {
    (app as { busy: boolean }).busy = false;
    vi.mocked(send).mockClear();
  });

  it("sends the wrap-up once through the shared path", async () => {
    await handOffNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("wrap up please");
  });

  it("uses the caller's dispatch once when given one", async () => {
    const d = vi.fn(async () => {});
    await handOffNow(d);
    expect(d).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing and says why while busy", async () => {
    (app as { busy: boolean }).busy = true;
    expect(handOffBlock()).toMatch(/running/);
    await handOffNow();
    expect(send).not.toHaveBeenCalled();
  });

  it("/handoff alone is the command; text around it is not", () => {
    expect(isHandoffCommand("/handoff")).toBe(true);
    expect(isHandoffCommand("  /handoff \n")).toBe(true);
    expect(isHandoffCommand("/handoff now")).toBe(false);
    expect(isHandoffCommand("please /handoff")).toBe(false);
  });

  it("the composer and both rails call the shared path, not a copy", () => {
    const c = composerSrc;
    expect(c).toContain("handOffNow((t) => dispatch(t, [], true))");
    expect(c).toContain("isHandoffCommand(text)");
    expect(c).not.toContain("requestWrapUp(");
    for (const r of [railSrc, classicSrc]) {
      expect(r).toContain("handOffNow()");
      expect(r).toContain("!T.aside && app.activeSessionId");
    }
  });
});
