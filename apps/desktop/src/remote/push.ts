/**
 * Push notifications on the phone page (nightshift item 739): the Subscribe
 * control's logic, apart from the DOM so it is under `push.test.ts`.
 *
 * The phone holds **one** subscription (one service worker, one key). The
 * Mac and the away server each keep a copy and each send to it, so both
 * must sign with the same key: the Mac's sync pass gives its key to the
 * away server, and until it has, the away server answers 409 ("key") —
 * the page says so and tries again at its next open (`refreshPush`).
 *
 * What a push says is the host's business (the chat's name and its state,
 * blocker 2011); this file only turns it on and off.
 */
import type { HostRole } from "./hosts";

/** Remembered on this phone: he turned notifications on here. */
export const PUSH_KEY = "nightloom.remote.push";

export type PushSupport =
  /** Can be turned on. */
  | "ok"
  /** An iPhone or iPad in Safari: push exists only for the Home Screen app. */
  | "needs-home-screen"
  /** The page is not on HTTPS: no service worker, so no push. */
  | "insecure"
  /** A browser without push. */
  | "unsupported";

export interface SupportFacts {
  secure: boolean;
  worker: boolean;
  push: boolean;
  notification: boolean;
  /** Opened from the Home Screen. */
  standalone: boolean;
  ios: boolean;
}

export function pushSupport(f: SupportFacts): PushSupport {
  if (!f.secure) return "insecure";
  if (f.worker && f.push && f.notification) return "ok";
  if (f.ios && !f.standalone) return "needs-home-screen";
  return "unsupported";
}

/** Why push cannot be turned on here, in words; `null` when it can. */
export function supportWords(s: PushSupport): string | null {
  switch (s) {
    case "ok":
      return null;
    case "needs-home-screen":
      return "Notifications work from the Home Screen app: Share → Add to Home Screen, then open Nightloom from its icon.";
    case "insecure":
      return "Notifications need the https:// link (Settings → Phone on the Mac shows it).";
    case "unsupported":
      return "This browser has no push notifications (an iPhone needs iOS 16.4 or later).";
  }
}

/** base64url → bytes (the `applicationServerKey`). */
export function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether a subscription was made with `key` (base64url). */
export function madeWith(subKey: ArrayBuffer | null, key: string): boolean {
  if (!subKey) return false;
  const a = new Uint8Array(subKey);
  let b: Uint8Array;
  try {
    b = keyBytes(key);
  } catch {
    return false;
  }
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The phone's subscription, as much of `PushSubscription` as is used. */
export interface Sub {
  endpoint: string;
  /** The key it was made with. */
  key: ArrayBuffer | null;
  json(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

/** The browser's part, injected so the tests have none. */
export interface PushEnv {
  permission(): "default" | "granted" | "denied";
  requestPermission(): Promise<"default" | "granted" | "denied">;
  current(): Promise<Sub | null>;
  subscribe(key: Uint8Array): Promise<Sub>;
  remembered(): boolean;
  remember(on: boolean): void;
  badge(n: number): void;
}

export interface PushStatus {
  key: string;
  subscriptions: number;
  waiting: number;
}

/** One paired host's `/api/push` routes. Each rejects with `PushRefusal`. */
export interface PushHost {
  role: HostRole;
  status(): Promise<PushStatus>;
  subscribe(body: { endpoint: string; keys: { p256dh: string; auth: string }; key: string }): Promise<PushStatus>;
  unsubscribe(endpoint: string): Promise<void>;
  test(): Promise<{ sent: number; dropped: number; failed: number; skipped?: string }>;
}

export class PushRefusal extends Error {
  constructor(
    /** The HTTP status; 0 when the host did not answer. */
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Where one host stands after a subscribe:
 *  `on` it will send; `key` it signs with another key until the Mac's next
 *  sync; `none` it has no push (an older build); `offline` it did not
 *  answer; `refused` it answered no, with its sentence. */
export type HostPush = "on" | "key" | "none" | "offline" | "refused";

export interface PushResult {
  state: "on" | "denied" | "failed";
  /** Each paired host's standing, when `on`. */
  hosts: Partial<Record<HostRole, HostPush>>;
  /** A sentence for `failed`. */
  problem?: string;
}

function standing(e: unknown): HostPush {
  if (e instanceof PushRefusal) {
    if (e.status === 0) return "offline";
    if (e.status === 501 || e.status === 404) return "none";
    if (e.status === 409) return "key";
  }
  return "refused";
}

/** The Mac first: its key is the one both hosts end up with. */
function macFirst(hosts: PushHost[]): PushHost[] {
  return [...hosts].sort((a, b) => (a.role === b.role ? 0 : a.role === "mac" ? -1 : 1));
}

/**
 * Subscribe this phone (or bring an existing subscription up to date) and
 * hand it to every paired host. `ask`: from his tap — the permission
 * prompt may show; without it (the page's open) nothing is asked.
 */
async function establish(env: PushEnv, hosts: PushHost[], ask: boolean): Promise<PushResult> {
  let permission = env.permission();
  if (permission === "default" && ask) permission = await env.requestPermission();
  if (permission !== "granted") return { state: permission === "denied" ? "denied" : "failed", hosts: {}, problem: permission === "denied" ? undefined : "Notifications were not allowed." };

  const out: Partial<Record<HostRole, HostPush>> = {};
  // The key: the first host that answers, the Mac before Away.
  let key: string | null = null;
  for (const h of macFirst(hosts)) {
    try {
      key = (await h.status()).key;
      break;
    } catch (e) {
      out[h.role] = standing(e);
    }
  }
  if (!key) return { state: "failed", hosts: out, problem: "No host with notifications answered — try again when the Mac or Away is reachable." };

  let sub = await env.current();
  if (sub && !madeWith(sub.key, key)) {
    // Made with a key no host signs with any more (the away server took
    // the Mac's): a new one, which needs no new permission.
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  try {
    sub ??= await env.subscribe(keyBytes(key));
  } catch (e) {
    return { state: "failed", hosts: out, problem: `The phone would not subscribe: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = { ...sub.json(), key };
  await Promise.all(
    hosts.map(async (h) => {
      try {
        await h.subscribe(body);
        out[h.role] = "on";
      } catch (e) {
        out[h.role] = standing(e);
      }
    }),
  );
  if (!Object.values(out).includes("on")) return { state: "failed", hosts: out, problem: "No host took the subscription." };
  env.remember(true);
  return { state: "on", hosts: out };
}

/** His tap on "Turn on notifications". Call it straight from the tap: the
 *  permission prompt needs the gesture. */
export function enablePush(env: PushEnv, hosts: PushHost[]): Promise<PushResult> {
  return establish(env, hosts, true);
}

/** At the page's open: if he turned push on here, hand the subscription to
 *  every host again (a host paired since, a key the away server took
 *  since). Asks nothing; `null` when push is not on here. */
export async function refreshPush(env: PushEnv, hosts: PushHost[]): Promise<PushResult | null> {
  if (!env.remembered() || env.permission() !== "granted" || hosts.length === 0) return null;
  return establish(env, hosts, false);
}

/** The off switch: every host forgets this phone, then the phone forgets
 *  the subscription. A host that does not answer keeps a dead row, which
 *  it drops at its next push (the service answers "gone"). */
export async function disablePush(env: PushEnv, hosts: PushHost[]): Promise<void> {
  env.remember(false);
  const sub = await env.current();
  if (sub) {
    await Promise.all(hosts.map((h) => h.unsubscribe(sub.endpoint).catch(() => undefined)));
    await sub.unsubscribe().catch(() => false);
  }
  env.badge(0);
}

/** The icon's badge from the hosts' own counts (chats waiting on him). */
export async function syncBadge(env: PushEnv, hosts: PushHost[]): Promise<number | null> {
  if (!env.remembered()) return null;
  const counts = await Promise.all(hosts.map((h) => h.status().then((s) => s.waiting, () => 0)));
  const n = counts.reduce((a, b) => a + b, 0);
  env.badge(n);
  return n;
}

/** "On — the Mac and Away", and what is not yet, in a sentence. */
export function pushSummary(hosts: Partial<Record<HostRole, HostPush>>): string {
  const name = (r: HostRole) => (r === "mac" ? "the Mac" : "Away");
  const roles = (["mac", "away"] as HostRole[]).filter((r) => hosts[r]);
  const on = roles.filter((r) => hosts[r] === "on").map(name);
  const parts: string[] = [on.length ? `On for ${on.join(" and ")}.` : "Not on for any host yet."];
  for (const r of roles) {
    const s = hosts[r];
    if (s === "key") parts.push(`${r === "mac" ? "The Mac" : "Away"} will join after the Mac's next sync.`);
    else if (s === "offline") parts.push(`${r === "mac" ? "The Mac" : "Away"} did not answer; it joins when this page next opens with it reachable.`);
    else if (s === "none") parts.push(`${r === "mac" ? "The Mac" : "Away"} runs a build without notifications.`);
    else if (s === "refused") parts.push(`${r === "mac" ? "The Mac" : "Away"} refused the subscription.`);
  }
  return parts.join(" ");
}

/** A tapped notification's chat, as the service worker posts it. */
export interface PushTap {
  chat: string;
  project: string | null;
  host: HostRole | null;
}

export function tapFrom(data: unknown): PushTap | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "nightloom-open" || typeof d.chat !== "string" || !d.chat) return null;
  return {
    chat: d.chat,
    project: typeof d.project === "string" && d.project ? d.project : null,
    host: d.host === "mac" || d.host === "away" ? d.host : null,
  };
}

// ---- the browser's half ----------------------------------------------------

export const WORKER_URL = "/push-sw.js";

export function supportHere(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const nav = navigator as Navigator & { standalone?: boolean };
  return pushSupport({
    secure: window.isSecureContext,
    worker: "serviceWorker" in navigator,
    push: "PushManager" in window,
    notification: "Notification" in window,
    standalone: nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  });
}

function wrap(s: PushSubscription): Sub {
  return {
    endpoint: s.endpoint,
    key: s.options?.applicationServerKey ?? null,
    json: () => {
      const j = s.toJSON();
      return { endpoint: s.endpoint, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } };
    },
    unsubscribe: () => s.unsubscribe(),
  };
}

/** The real browser. Only called where `supportHere()` is `ok`. */
export function browserEnv(): PushEnv {
  const registration = async () => {
    await navigator.serviceWorker.register(WORKER_URL, { scope: "/" });
    return navigator.serviceWorker.ready;
  };
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    current: async () => {
      const s = await (await registration()).pushManager.getSubscription();
      return s ? wrap(s) : null;
    },
    subscribe: async (key) => wrap(await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })),
    remembered: () => {
      try {
        return localStorage.getItem(PUSH_KEY) === "on";
      } catch {
        return false;
      }
    },
    remember: (on) => {
      try {
        if (on) localStorage.setItem(PUSH_KEY, "on");
        else localStorage.removeItem(PUSH_KEY);
      } catch {
        // Not kept: the page asks the subscription itself next time.
      }
    },
    badge: (n) => {
      const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
    },
  };
}

/** A host's push routes over its token (never in a URL). */
export function pushHost(role: HostRole, c: { token: string; base: string }): PushHost {
  const call = async (path: string, body?: unknown): Promise<Response> => {
    let r: Response;
    try {
      r = await fetch(`${c.base}/api/push${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      throw new PushRefusal(0, String(e));
    }
    if (!r.ok) throw new PushRefusal(r.status, (await r.text().catch(() => "")) || r.statusText);
    return r;
  };
  return {
    role,
    status: async () => (await call("")).json(),
    subscribe: async (body) => (await call("/subscribe", body)).json(),
    unsubscribe: async (endpoint) => void (await call("/unsubscribe", { endpoint })),
    test: async () => (await call("/test", {})).json(),
  };
}

/** Hear the service worker's "open this chat" (a tapped notification while
 *  the page is alive). Returns the un-listen. */
export function watchPushTaps(open: (tap: PushTap) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const on = (e: MessageEvent) => {
    const tap = tapFrom(e.data);
    if (tap) open(tap);
  };
  navigator.serviceWorker.addEventListener("message", on);
  return () => navigator.serviceWorker.removeEventListener("message", on);
}
