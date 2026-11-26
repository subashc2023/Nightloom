// @vitest-environment happy-dom
/*
 * Item 1006 (verify sweep 2, 2026-11-26 1:07 AM): under "stop at your sleep, up to 8 h awake · your sleep
 * 2–9 AM", a reply at 1:07 AM got no ping (the first, 2:02 AM, falls in his sleep — the rule as decided), but
 * its cache was warm to 2:07 AM, and the switch read "stopped — you're usually asleep" while "Chats kept warm
 * now" said none. After Extend then Stop the switch kept a "· 12 h" tail. The real KeepersList and
 * KeepWarmNotice, mounted on the backend's statuses, in each state: warm, warm with its pings ended for his
 * sleep or the cap, stopped, extended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { KeepWarmStatus } from "./keepWarm";

const H = 3_600_000;
const backend: Record<string, KeepWarmStatus> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { chat?: string }) => {
    if (cmd === "keep_warm_list") return Object.values(backend);
    if (cmd === "keep_warm_status" && args.chat) return backend[args.chat] ?? null;
    if (cmd === "keep_warm_stop_until_next") return true;
    if (cmd === "chat_home") return { found: true, name: "Lab" };
    throw new Error("no backend");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

await import("./asides.svelte");
await import("./state.svelte");
const { keepWarm } = await import("./keepWarm.svelte");
const { holdTail, switchLabel, switchTitle } = await import("./keepWarm");
const KeepersList = (await import("./KeepersList.svelte")).default;
const KeepWarmNotice = (await import("./KeepWarmNotice.svelte")).default;

const now = Date.now();
function st(chat: string, o: Partial<KeepWarmStatus> = {}): KeepWarmStatus {
  return {
    chat,
    mode: "on",
    chosen: true,
    scheduled: true,
    warm_until_ms: now + 3 * H,
    touched_ms: now - 5 * 60_000,
    next_ping_ms: now + 50 * 60_000,
    why: null,
    spent: { pings: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: 0 },
    policy: { every_ms: 55 * 60_000, cap_ms: 8 * H, min_context: 50000 },
    hold_hours: null,
    sleep_cut: false,
    sleep: { start: 2, end: 9 },
    ...o,
  };
}
/** The 1:07 AM keeper: no ping (2:02 AM is his sleep), warm its own hour. */
const asleep = (chat = "lab4") => st(chat, { scheduled: false, why: "sleep", sleep_cut: true, next_ping_ms: null, warm_until_ms: now + 59 * 60_000 });

let mounted: Record<string, unknown>[] = [];
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
const body = () => document.body.textContent ?? "";

beforeEach(() => {
  document.body.innerHTML = "";
  for (const k of Object.keys(backend)) delete backend[k];
  keepWarm.byChat = {};
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
});

describe("keep-warm tells the truth in every state (item 1006)", () => {
  it("the list shows a keeper whose pings ended for his sleep while its cache is warm, with Extend and Stop", async () => {
    backend.lab4 = asleep();
    mounted.push(mount(KeepersList, { target: document.body }));
    await settle();
    expect(body()).not.toContain("No chat's cache is being kept warm");
    const line = document.querySelector(".line")?.textContent ?? "";
    expect(line).toMatch(/^warm until \d{1,2}:\d{2} [AP]M · no pings in your sleep \(2–9 AM\)$/);
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Extend to 12 h", "Stop"]);
  });

  it("the switch and the notice say warm until its hour ends, not stopped", async () => {
    const s = asleep();
    expect(switchLabel(s, now)).toMatch(/^warm until \d{1,2}:\d{2} [AP]M · no pings in your sleep \(2–9 AM\)$/);
    expect(switchLabel(s, now)).not.toContain("stopped");
    expect(switchTitle(s, now)).toMatch(/^Warm until .* — no pings in your sleep \(2–9 AM\); they start again at the next reply\./);
    backend.lab4 = s;
    mounted.push(mount(KeepWarmNotice, { target: document.body, props: { chat: "lab4" } }));
    await settle();
    expect(body()).toMatch(/Warm until ~\d{1,2}:\d{2} [AP]M — no pings in your sleep \(2–9 AM\)/);
    // Once its hour has passed: ended for his sleep — still not "stopped", and not listed.
    const cold = { ...s, warm_until_ms: now - 1 };
    expect(switchLabel(cold, now)).toBe("keep warm · ended — no pings in your sleep (2–9 AM)");
  });

  it("the cap's last hour is listed too; a cold, off or stopped chat is not", async () => {
    backend.capped = st("capped", { scheduled: false, why: "cap", next_ping_ms: null, warm_until_ms: now + 20 * 60_000 });
    backend.warm = st("warm");
    backend.cold = { ...asleep("cold"), warm_until_ms: now - 1 };
    backend.off = st("off", { mode: "off", scheduled: false, why: "off" });
    backend.stopped = st("stopped", { scheduled: false, why: "stopped", warm_until_ms: null, next_ping_ms: null });
    mounted.push(mount(KeepersList, { target: document.body }));
    await settle();
    const lines = [...document.querySelectorAll(".line")].map((e) => e.textContent ?? "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/· no more pings — 8 h since the last reply$/);
    expect(lines[1]).toMatch(/· next ping /);
    // The switch keeps its 582 words for the cap's last hour.
    expect(switchLabel(backend.capped, now)).toBe("keep warm · ended — 8 h since the last reply");
  });

  it("Extend then Stop: the row leaves and the switch keeps no '· 12 h' tail", async () => {
    backend.lab4 = st("lab4", { hold_hours: 12, cap_ms: 12 * H });
    mounted.push(mount(KeepersList, { target: document.body }));
    await settle();
    expect(document.querySelector(".line")?.textContent).toContain("held 12 h");
    expect(holdTail(keepWarm.byChat.lab4)).toBe("· 12 h");
    const stop = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Stop") as HTMLButtonElement;
    stop.click();
    await settle();
    expect(document.querySelectorAll("li")).toHaveLength(0);
    const s = keepWarm.byChat.lab4;
    expect(switchLabel(s, now)).toBe("keep warm · stopped — starts again at the next message");
    // The optimistic status still carries the hold; the backend's drops it — neither shows a tail.
    expect(holdTail(s)).toBe("");
    expect(holdTail({ ...s, hold_hours: null })).toBe("");
  });
});
