import { describe, expect, it } from "vitest";
import {
  PushRefusal,
  disablePush,
  enablePush,
  keyBytes,
  madeWith,
  pushSummary,
  pushSupport,
  refreshPush,
  supportWords,
  syncBadge,
  tapFrom,
  type PushEnv,
  type PushHost,
  type PushStatus,
  type Sub,
} from "./push";
import type { HostRole } from "./hosts";

// 65 bytes each, base64url — two different "keys".
const KEY_A = btoa(String.fromCharCode(4, ...new Array(64).fill(1))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const KEY_B = btoa(String.fromCharCode(4, ...new Array(64).fill(2))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fakeEnv(start: { permission?: "default" | "granted" | "denied"; grant?: "granted" | "denied" | "default"; sub?: Sub | null; remembered?: boolean } = {}) {
  const log: string[] = [];
  let permission = start.permission ?? "default";
  let sub: Sub | null = start.sub ?? null;
  let remembered = start.remembered ?? false;
  let made = 0;
  let badge: number | null = null;
  const mk = (key: Uint8Array): Sub => {
    const mine: Sub = {
      endpoint: `https://web.push.apple.com/sub${++made}`,
      key: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
      json: () => ({ endpoint: mine.endpoint, keys: { p256dh: "P", auth: "A" } }),
      unsubscribe: async () => {
        log.push(`unsubscribe ${mine.endpoint}`);
        if (sub === mine) sub = null;
        return true;
      },
    };
    return mine;
  };
  const env: PushEnv = {
    permission: () => permission,
    requestPermission: async () => {
      log.push("ask");
      permission = start.grant ?? "granted";
      return permission;
    },
    current: async () => sub,
    subscribe: async (key) => {
      log.push("subscribe");
      sub = mk(key);
      return sub;
    },
    remembered: () => remembered,
    remember: (on) => (remembered = on),
    badge: (n) => (badge = n),
  };
  return { env, log, mk, sub: () => sub, remembered: () => remembered, badge: () => badge };
}

function fakeHost(role: HostRole, key: string, opts: { down?: boolean; none?: boolean; waiting?: number } = {}) {
  const subs = new Set<string>();
  const fail = () => {
    if (opts.down) throw new PushRefusal(0, "unreachable");
    if (opts.none) throw new PushRefusal(501, "not available on this host");
  };
  const status = (): PushStatus => ({ key, subscriptions: subs.size, waiting: opts.waiting ?? 0 });
  const host: PushHost = {
    role,
    status: async () => {
      fail();
      return status();
    },
    subscribe: async (body) => {
      fail();
      if (body.key !== key) throw new PushRefusal(409, "this host's push key is not the one the phone subscribed with");
      subs.add(body.endpoint);
      return status();
    },
    unsubscribe: async (endpoint) => {
      fail();
      subs.delete(endpoint);
    },
    test: async () => ({ sent: subs.size, dropped: 0, failed: 0 }),
  };
  return { host, subs, opts, setKey: (k: string) => (key = k) };
}

describe("push support", () => {
  const all = { secure: true, worker: true, push: true, notification: true, standalone: true, ios: true };
  it("is on for the Home Screen app, and says why elsewhere", () => {
    expect(pushSupport(all)).toBe("ok");
    expect(supportWords("ok")).toBeNull();
    // Safari on the iPhone has no PushManager: the Home Screen app does.
    expect(pushSupport({ ...all, push: false, standalone: false })).toBe("needs-home-screen");
    expect(supportWords("needs-home-screen")).toContain("Add to Home Screen");
    // The Home Screen app on an iOS older than 16.4.
    expect(pushSupport({ ...all, push: false })).toBe("unsupported");
    // The plain-HTTP tailnet link: no service worker at all.
    expect(pushSupport({ ...all, secure: false })).toBe("insecure");
    expect(supportWords("insecure")).toContain("https://");
    // A desktop browser with push.
    expect(pushSupport({ ...all, ios: false, standalone: false })).toBe("ok");
  });
});

describe("the key", () => {
  it("reads base64url, padded or not, and compares to a subscription's", () => {
    const b = keyBytes(KEY_A);
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
    expect(keyBytes(KEY_A + "=").length).toBe(65);
    expect(madeWith(b.buffer as ArrayBuffer, KEY_A)).toBe(true);
    expect(madeWith(b.buffer as ArrayBuffer, KEY_B)).toBe(false);
    expect(madeWith(null, KEY_A)).toBe(false);
    expect(madeWith(b.buffer as ArrayBuffer, "!!not base64!!")).toBe(false);
  });
});

describe("turning notifications on", () => {
  it("asks once, subscribes with the Mac's key, and hands it to both hosts", async () => {
    const f = fakeEnv();
    const mac = fakeHost("mac", KEY_A);
    const away = fakeHost("away", KEY_A);
    // Away listed first: the Mac's key is still the one asked first.
    const r = await enablePush(f.env, [away.host, mac.host]);
    expect(r).toEqual({ state: "on", hosts: { mac: "on", away: "on" } });
    expect(f.log).toEqual(["ask", "subscribe"]);
    expect(madeWith(f.sub()!.key, KEY_A)).toBe(true);
    expect([...mac.subs]).toEqual([f.sub()!.endpoint]);
    expect([...away.subs]).toEqual([f.sub()!.endpoint]);
    expect(f.remembered()).toBe(true);
  });

  it("a refused permission subscribes nothing and is not remembered as on", async () => {
    const f = fakeEnv({ grant: "denied" });
    const mac = fakeHost("mac", KEY_A);
    const r = await enablePush(f.env, [mac.host]);
    expect(r.state).toBe("denied");
    expect(f.log).toEqual(["ask"]);
    expect(mac.subs.size).toBe(0);
    expect(f.remembered()).toBe(false);
    // Dismissed without an answer: not "denied", and still nothing.
    const g = fakeEnv({ grant: "default" });
    expect((await enablePush(g.env, [mac.host])).state).toBe("failed");
  });

  it("the away server with its own key waits for the Mac's sync; the Mac is on", async () => {
    const f = fakeEnv();
    const mac = fakeHost("mac", KEY_A);
    const away = fakeHost("away", KEY_B);
    const r = await enablePush(f.env, [mac.host, away.host]);
    expect(r).toEqual({ state: "on", hosts: { mac: "on", away: "key" } });
    expect(pushSummary(r.hosts)).toBe("On for the Mac. Away will join after the Mac's next sync.");
    // The sync happened: the next open hands the same subscription over.
    away.setKey(KEY_A);
    const again = await refreshPush(f.env, [mac.host, away.host]);
    expect(again).toEqual({ state: "on", hosts: { mac: "on", away: "on" } });
    expect(f.log).toEqual(["ask", "subscribe"]);
    expect(away.subs.size).toBe(1);
    expect(pushSummary(again!.hosts)).toBe("On for the Mac and Away.");
  });

  it("with the Mac off, Away's key is used; when the keys then differ the phone subscribes again", async () => {
    const f = fakeEnv();
    const mac = fakeHost("mac", KEY_A, { down: true });
    const away = fakeHost("away", KEY_B);
    const r = await enablePush(f.env, [mac.host, away.host]);
    expect(r).toEqual({ state: "on", hosts: { mac: "offline", away: "on" } });
    const first = f.sub()!.endpoint;
    // The Mac is back and its sync gave Away the Mac's key (Away forgot the
    // old subscription): the page's next open makes a new one, unasked.
    mac.opts.down = false;
    away.setKey(KEY_A);
    away.subs.clear();
    const again = await refreshPush(f.env, [mac.host, away.host]);
    expect(again).toEqual({ state: "on", hosts: { mac: "on", away: "on" } });
    expect(f.log).toEqual(["ask", "subscribe", `unsubscribe ${first}`, "subscribe"]);
    expect(madeWith(f.sub()!.key, KEY_A)).toBe(true);
    expect([...mac.subs]).toEqual([f.sub()!.endpoint]);
  });

  it("a host from an older build is named, and no host at all is a failure in words", async () => {
    const f = fakeEnv();
    const mac = fakeHost("mac", KEY_A);
    const old = fakeHost("away", KEY_A, { none: true });
    const r = await enablePush(f.env, [mac.host, old.host]);
    expect(r).toEqual({ state: "on", hosts: { mac: "on", away: "none" } });
    expect(pushSummary(r.hosts)).toContain("Away runs a build without notifications.");

    const g = fakeEnv();
    const down = fakeHost("mac", KEY_A, { down: true });
    const none = await enablePush(g.env, [down.host]);
    expect(none.state).toBe("failed");
    expect(none.problem).toContain("No host");
    expect(g.log).toEqual(["ask"]);
    expect(g.remembered()).toBe(false);
  });

  it("the page's open asks nothing unless he turned it on here", async () => {
    const mac = fakeHost("mac", KEY_A);
    const never = fakeEnv({ permission: "granted" });
    expect(await refreshPush(never.env, [mac.host])).toBeNull();
    const revoked = fakeEnv({ permission: "denied", remembered: true });
    expect(await refreshPush(revoked.env, [mac.host])).toBeNull();
    expect(revoked.log).toEqual([]);
    expect(mac.subs.size).toBe(0);
  });
});

describe("turning notifications off", () => {
  it("every host forgets the phone, the phone forgets the subscription, the badge clears", async () => {
    const f = fakeEnv();
    const mac = fakeHost("mac", KEY_A);
    const away = fakeHost("away", KEY_A, { down: false });
    await enablePush(f.env, [mac.host, away.host]);
    const endpoint = f.sub()!.endpoint;
    // Away is unreachable at the moment he switches it off: still off here.
    away.opts.down = true;
    await disablePush(f.env, [mac.host, away.host]);
    expect(mac.subs.size).toBe(0);
    expect(f.sub()).toBeNull();
    expect(f.log).toContain(`unsubscribe ${endpoint}`);
    expect(f.remembered()).toBe(false);
    expect(f.badge()).toBe(0);
    expect(await refreshPush(f.env, [mac.host])).toBeNull();
  });
});

describe("the badge", () => {
  it("is the hosts' waiting chats added up; a host that is off counts none", async () => {
    const f = fakeEnv({ remembered: true });
    const mac = fakeHost("mac", KEY_A, { waiting: 2 });
    const away = fakeHost("away", KEY_A, { waiting: 1 });
    expect(await syncBadge(f.env, [mac.host, away.host])).toBe(3);
    expect(f.badge()).toBe(3);
    away.opts.down = true;
    expect(await syncBadge(f.env, [mac.host, away.host])).toBe(2);
    const off = fakeEnv();
    expect(await syncBadge(off.env, [mac.host])).toBeNull();
    expect(off.badge()).toBeNull();
  });
});

describe("a tapped notification", () => {
  it("names the chat, its project and its host; anything else is ignored", () => {
    expect(tapFrom({ type: "nightloom-open", chat: "c1", project: "p1", host: "away" })).toEqual({ chat: "c1", project: "p1", host: "away" });
    expect(tapFrom({ type: "nightloom-open", chat: "c1", project: null, host: "elsewhere" })).toEqual({ chat: "c1", project: null, host: null });
    expect(tapFrom({ type: "nightloom-open", chat: "" })).toBeNull();
    expect(tapFrom({ type: "other", chat: "c1" })).toBeNull();
    expect(tapFrom("nightloom-open")).toBeNull();
    expect(tapFrom(null)).toBeNull();
  });
});
