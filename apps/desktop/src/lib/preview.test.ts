import { describe, expect, it } from "vitest";
import type { PreviewSnapshot } from "./api";
import { applyPreviewChange, previewCommandLine, previewHost, previewStatusText } from "./preview";

const snap = (over: Partial<PreviewSnapshot> = {}): PreviewSnapshot => ({
  chat: "c1",
  command: "npm run dev -- --port $PORT",
  cwd: "/w",
  port: 5173,
  url: "http://localhost:5173",
  status: "listening",
  exit_code: null,
  log: [],
  started_ms: 0,
  pgid: 42,
  ...over,
});

describe("preview chip words (item 430)", () => {
  it("says the status plainly", () => {
    expect(previewStatusText(snap())).toBe("running");
    expect(previewStatusText(snap({ status: "starting" }))).toBe("starting");
    expect(previewStatusText(snap({ status: "exited", exit_code: 3 }))).toBe("exited (code 3)");
    expect(previewStatusText(snap({ status: "exited", exit_code: null }))).toBe("stopped by a signal");
  });
  it("shows the address without its scheme", () => {
    expect(previewHost(snap())).toBe("localhost:5173");
  });
  it("cuts a long command to one line", () => {
    expect(previewCommandLine("a\n  b")).toBe("a b");
    const long = previewCommandLine("x".repeat(100), 20);
    expect(long.length).toBe(20);
    expect(long.endsWith("…")).toBe(true);
  });
  it("keeps one preview per chat and drops a stopped one", () => {
    let m = applyPreviewChange({}, "c1", snap());
    m = applyPreviewChange(m, "c2", snap({ chat: "c2", port: 8000 }));
    m = applyPreviewChange(m, "c1", snap({ status: "exited", exit_code: 1 }));
    expect(Object.keys(m).sort()).toEqual(["c1", "c2"]);
    expect(m.c1.status).toBe("exited");
    m = applyPreviewChange(m, "c1", null);
    expect(Object.keys(m)).toEqual(["c2"]);
  });
});
