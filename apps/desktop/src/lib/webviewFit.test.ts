import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null));
const wakeHandlers: (() => void)[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, h: () => void) => {
    wakeHandlers.push(h);
    return Promise.resolve(() => {});
  },
}));

import { SECOND_LOOK_MS, installWebviewFit, resetWebviewFitForTests } from "./webviewFit";

// The page's half of the wake refit (nightshift backlog 324): the page
// becoming visible, and the wake, each ask Rust to refit with the page's
// own size — now and once more a moment later.

function fakes() {
  let listener: (() => void) | null = null;
  const doc = {
    visibilityState: "hidden",
    addEventListener: (name: string, h: () => void) => {
      if (name === "visibilitychange") listener = h;
    },
  };
  const timers: (() => void)[] = [];
  const win = {
    innerWidth: 756,
    innerHeight: 491,
    setTimeout: (f: () => void, ms: number) => {
      expect(ms).toBe(SECOND_LOOK_MS);
      timers.push(f);
      return 0;
    },
  };
  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    show: (state: string) => {
      doc.visibilityState = state;
      listener?.();
    },
    timers,
  };
}

describe("installWebviewFit", () => {
  beforeEach(() => {
    invoke.mockClear();
    wakeHandlers.length = 0;
    resetWebviewFitForTests();
  });

  it("refits with the page's size when the page becomes visible, not hidden", () => {
    const f = fakes();
    installWebviewFit(f.doc, f.win);
    f.show("hidden");
    expect(invoke).not.toHaveBeenCalled();
    f.show("visible");
    expect(invoke).toHaveBeenCalledWith("refit_webview", {
      trigger: "visible",
      innerWidth: 756,
      innerHeight: 491,
    });
    expect(f.timers).toHaveLength(1);
    f.timers[0]();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ trigger: `visible +${SECOND_LOOK_MS}ms` });
  });

  it("refits on the wake too", () => {
    const f = fakes();
    installWebviewFit(f.doc, f.win);
    expect(wakeHandlers).toHaveLength(1);
    wakeHandlers[0]();
    expect(invoke).toHaveBeenCalledWith("refit_webview", expect.objectContaining({ trigger: "system-woke page" }));
  });

  it("puts its listeners in once", () => {
    const f = fakes();
    installWebviewFit(f.doc, f.win);
    installWebviewFit(f.doc, f.win);
    expect(wakeHandlers).toHaveLength(1);
  });
});
