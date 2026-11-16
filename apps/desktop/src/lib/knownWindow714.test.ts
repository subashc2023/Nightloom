import { describe, expect, it } from "vitest";
import { windowModelFor } from "./knownWindow";
import { readings, type ReadingsInput } from "./newChatPage";
import connSrc from "./state/connection.svelte.ts?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import type { SeenModels } from "./modelSeen";

const seen: SeenModels = {
  fable: { id: "claude-fable-5-1", cliVersion: "2.1.321", seenAt: "2026-11-15T10:00:00Z" },
  opus: { id: "claude-opus-5-5", cliVersion: "2.1.300", seenAt: "2026-11-01T10:00:00Z" },
  "": { id: "claude-opus-5-5", cliVersion: "2.1.321", seenAt: "2026-11-15T10:00:00Z" },
};

describe("item 714: a new chat's window before its first turn", () => {
  it("reads the alias's model as the CLI now resolves it", () => {
    expect(windowModelFor(seen, "fable", "2.1.321")).toEqual({ id: "claude-fable-5-1", from: "fable → Fable 5.1 on CLI 2.1.321" });
  });
  it("names an earlier CLI's resolution as such", () => {
    expect(windowModelFor(seen, "opus", "2.1.321")).toEqual({
      id: "claude-opus-5-5",
      from: "opus → Opus 5.5 on CLI 2.1.300, not yet run on 2.1.321",
    });
  });
  it("reads the default from its record, and `default` is the same alias", () => {
    expect(windowModelFor(seen, "", "2.1.321")?.id).toBe("claude-opus-5-5");
    expect(windowModelFor(seen, "default", "2.1.321")?.from).toBe("default → Opus 5.5 on CLI 2.1.321");
  });
  it("falls back to the family's newest listed model, named, when the alias never ran", () => {
    expect(windowModelFor({}, "fable", "2.1.321")).toEqual({
      id: "claude-fable-5-2",
      from: "Fable 5.2, the newest listed; fable not run yet",
    });
    expect(windowModelFor({}, "opus[1m]", null)?.id).toBe("claude-opus-5-5");
  });
  it("leaves a full id to the backend and an unrecorded default unknown", () => {
    expect(windowModelFor(seen, "claude-opus-5-5", "2.1.321")).toBeNull();
    expect(windowModelFor({}, "", "2.1.321")).toBeNull();
    expect(windowModelFor({}, "mystery", "2.1.321")).toBeNull();
  });
  it("the Model read-out shows the window and its source", () => {
    const base = { engine: "claude-code", provider: "Anthropic", connected: true, connecting: false, subscription: true, cliVersion: "2.1.321", model: "fable", project: null, notes: 0, vault: 0, chats: 0, plan: null, nightshift: null } as const;
    const m = (i: Partial<ReadingsInput>) => readings({ ...base, limit: null, ...i } as ReadingsInput).find((r) => r.key === "model")!;
    expect(m({ limit: 1_000_000, windowFrom: "fable → Fable 5.1 on CLI 2.1.321" }).sub).toBe("1M window (fable → Fable 5.1 on CLI 2.1.321) · cache cold");
    expect(m({ limit: 1_000_000 }).sub).toBe("1M window · cache cold");
    expect(m({}).sub).toBe("window unknown until the first turn");
  });
  it("is wired: the connect fills it, the page passes its source", () => {
    expect(connSrc).toMatch(/contextLimit == null\) void fillKnownWindow\(/);
    expect(connSrc).toMatch(/api\.contextLimits\("anthropic", \[pick\.id\]\)/);
    expect(welcomeSrc).toMatch(/windowFrom: app\.connection\?\.windowFrom/);
  });
});
