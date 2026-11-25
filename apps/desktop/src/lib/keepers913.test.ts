/*
 * Item 913 (his ask, 2026-11-23): one screen listing every open cache keeper, with Extend and Stop on each row.
 */
import { describe, expect, it } from "vitest";
import { idleWords, keeperLine, keeperRows, nextHold, type KeepWarmStatus } from "./keepWarm";
import { cacheSummary, CONTROLS } from "./settings/subscriptionPane";
import settings from "./SettingsModal.svelte?raw";
import list from "./KeepersList.svelte?raw";
import store from "./keepWarm.svelte?raw";
import api from "./api?raw";

const H = 3_600_000;
const now = Date.UTC(2026, 10, 25, 10, 0);
function st(chat: string, o: Partial<KeepWarmStatus> = {}): KeepWarmStatus {
  return {
    chat,
    mode: "on",
    scheduled: true,
    warm_until_ms: now + 2 * H,
    touched_ms: now - 10 * 60_000,
    next_ping_ms: now + 45 * 60_000,
    why: null,
    spent: { pings: 3, cache_read: 300000, cache_write: 0, output: 30, cost_usd: 0.27 },
    policy: { every_ms: 55 * 60_000, cap_ms: 6 * H, min_context: 50000 },
    ...o,
  };
}

describe("Chats kept warm now (item 913)", () => {
  it("lists only the chats keeping warm now, soonest cold first", () => {
    const rows = keeperRows(
      {
        a: st("a", { warm_until_ms: now + 3 * H }),
        b: st("b", { warm_until_ms: now + 1 * H }),
        off: st("off", { mode: "off" }),
        idle: st("idle", { scheduled: false }),
        cold: st("cold", { warm_until_ms: now - 1 }),
      },
      now,
    );
    expect(rows.map((r) => r.chat)).toEqual(["b", "a"]);
  });
  it("Extend goes 12 h then 24 h, then is the longest", () => {
    expect(nextHold(st("a"))).toBe(12);
    expect(nextHold(st("a", { hold_hours: 12 }))).toBe(24);
    expect(nextHold(st("a", { hold_hours: 24 }))).toBeNull();
  });
  it("a row says when it goes cold, the next ping, the hold and the spend", () => {
    const line = keeperLine(st("a", { hold_hours: 12 }), now);
    expect(line).toMatch(/^warm until \d{1,2}:\d{2} [AP]M · next ping \d{1,2}:\d{2} [AP]M · held 12 h · 3 pings ≈ \$0\.27$/);
  });
  it("the group's summary counts them; the search finds the row", () => {
    expect(cacheSummary(true, 2)).toBe("2 warm now · every chat kept warm, up to the cap");
    expect(cacheSummary(false, 0)).toBe("none warm now · off unless a chat's switch is on");
    expect(cacheSummary(true)).toBe("every chat kept warm, up to the cap");
    expect(CONTROLS.find((c) => c.id === "cache-keepers")?.label).toBe("Chats kept warm now");
  });
  it("the screen reads the backend's whole list; Extend holds, Stop stops without re-reading (which would restart)", () => {
    expect(settings).toContain('<SettingRow fold="subscription/cache-keepers"');
    expect(settings).toContain("<KeepersList />");
    expect(api).toContain('invoke("keep_warm_list")');
    expect(list).toContain("void loadAllKeepWarm()");
    expect(list).toContain("holdKeepWarm(chat, hours)");
    expect(list).toContain("await stopKeeper(chat)");
    const stop = store.slice(store.indexOf("export async function stopKeeper"));
    expect(stop.slice(0, stop.indexOf("\n}"))).not.toContain("loadKeepWarm(");
  });
  it("Stop holds until the next send or reply (blocker 2282): its own command, read as 'stopped'", () => {
    expect(api).toContain('invoke("keep_warm_stop_until_next", { chat })');
    const stop = store.slice(store.indexOf("export async function stopKeeper"));
    expect(stop.slice(0, stop.indexOf("\n}"))).toContain("api.keepWarmStopUntilNext(chat)");
    expect(list).toContain("Stop the pings until its next message");
    const s = {
      chat: "c",
      mode: "on",
      scheduled: false,
      warm_until_ms: null,
      touched_ms: null,
      next_ping_ms: null,
      why: "stopped",
      spent: { pings: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: 0 },
      policy: { every_ms: 55 * 60_000, cap_ms: 6 * 3_600_000, min_context: 50_000 },
    } as KeepWarmStatus;
    expect(idleWords(s)).toBe("stopped — starts again at the next message");
  });
});
