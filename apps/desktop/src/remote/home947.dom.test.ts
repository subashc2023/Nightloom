// @vitest-environment happy-dom
/*
 * Item 947 (phone Home stress test): the page must not say "nothing needs you" from a read that never happened.
 *  - the host not answering on the very first read: the header says it has not read, no calm line, the Tell Home hint
 *    does not claim Home is "not set up";
 *  - /push/feed answering 500 after a good read: the rows of the last read stay, a line says part could not be read;
 *  - an older read that lands after a newer one is dropped (a slow reply must not bring back an answered question).
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import HomeFirst from "./HomeFirst.svelte";
import { ApiError, Unreachable, type Client, type RemoteState } from "./client";

const row = (chat: string, label: string) => ({ what: "question", chat, label, project: "p", at: Date.now() - 60_000 });
type Plan = { push: () => Promise<unknown>; feed?: () => Promise<unknown>; send?: (...a: unknown[]) => Promise<unknown> };
function fake(plan: Plan): Client {
  const base: Record<string, () => Promise<unknown>> = {
    homeToday: async () => ({ points: 0.3, cap: 5, week: 41, five_hour: 12, stopped: null }),
    homeFeed: plan.feed ?? (async () => ({ rows: [], seen_at: null, as_of: Date.now(), home: { project: "home", chat: "h" } })),
    homeScan: async () => ({ scan: null }),
    pushFeed: plan.push,
    jobs: async () => ({ jobs: [], now: "" }),
    homeHeld: async () => ({ blockers: [] }),
    running: async () => ({ chats: [], contexts: {} }),
    homeRoutes: async () => ({ cards: [], held: [], started: [] }),
    chats: async () => [],
    send: plan.send ?? (async () => "sent"),
  };
  return new Proxy({ token: "t", base: "" } as unknown as Client, {
    get: (t, k: string) => (k in t ? (t as never)[k] : (base[k] ?? (async () => { throw new ApiError(404, "no route"); }))),
  });
}
const remote = { project: "home", active_chat: null, busy: false, connected: true, engine: "claude-code", pending: [], host: "mac" } as unknown as RemoteState;
let root: ReturnType<typeof mount> | null = null;
const held: unknown[][] = [];
function open(client: Client) {
  held.length = 0;
  localStorage.clear();
  root = mount(HomeFirst, { target: document.body, props: { client, active: "mac" as never, macPaired: true, remote, openLabel: null, fil: true, resume: null, onopen() {}, onjobs() {}, ondrawer() {}, onnew() {}, onhold: (...a: unknown[]) => void held.push(a) } });
  flushSync();
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const text = () => document.body.textContent ?? "";
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
});

describe("947: Home never claims 'nothing needs you' from a read that did not happen", () => {
  it("first read, host not answering: says it has not read, no calm line, no 'not set up'", async () => {
    open(fake({ push: async () => { throw new Unreachable("down"); }, feed: async () => { throw new Unreachable("down"); } }));
    await settle();
    expect(document.querySelector(".h-title")?.textContent).toContain("not read yet");
    expect(text()).not.toContain("Nothing needs you");
    expect(text()).not.toContain("nothing needs you");
    expect(text()).toContain("not answering");
    expect(text()).not.toContain("not set up on this host yet");
  });
  it("first read, /push/feed answers 500: same, with a line that part could not be read", async () => {
    open(fake({ push: async () => { throw new ApiError(500, "boom"); } }));
    await settle();
    expect(document.querySelector(".h-title")?.textContent).toContain("not read yet");
    expect(text()).not.toContain("Nothing needs you");
    expect(text()).toContain("could not be read");
  });
  it("a good read, then /push/feed fails: the rows stay", async () => {
    let fail = false;
    const client = fake({ push: async () => { if (fail) throw new ApiError(500, "boom"); return { rows: [row("c1", "Lease chat")] }; } });
    open(client);
    await settle();
    expect(text()).toContain("Lease chat");
    fail = true;
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(text()).toContain("Lease chat");
    expect(document.querySelector(".h-title")?.textContent).toContain("1 needs you");
    expect(text()).toContain("could not be read");
  });
  it("an old read landing after a newer one is dropped", async () => {
    let n = 0;
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => (release = r));
    const client = fake({
      push: () => {
        n += 1;
        if (n === 1) return slow; // the first read hangs, then lands last with the stale question
        return Promise.resolve({ rows: [] });
      },
    });
    open(client);
    await settle();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(text()).toContain("Nothing needs you");
    release({ rows: [row("c9", "Stale question")] });
    await settle();
    expect(text()).not.toContain("Stale question");
    expect(document.querySelector(".h-title")?.textContent).toContain("nothing needs you");
  });
});

describe("947: answering a Needs-you question on the phone", () => {
  const typeIn = (value: string) => {
    const box = document.querySelector<HTMLTextAreaElement>(".h-reply textarea")!;
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    return box;
  };
  const sendBtn = () => document.querySelector<HTMLButtonElement>(".h-reply .h-btn.primary")!;
  it("a refusal (500) keeps his words in the box", async () => {
    open(fake({ push: async () => ({ rows: [row("c1", "Lease chat")] }), send: async () => { throw new ApiError(500, "nope"); } }));
    await settle();
    const box = typeIn("Yes, bring dessert");
    sendBtn().click();
    await settle();
    expect(box.value).toBe("Yes, bring dessert");
    expect(held.length).toBe(0);
  });
  it("a host not answering holds the message in the page's queue and clears the box", async () => {
    open(fake({ push: async () => ({ rows: [row("c1", "Lease chat")] }), send: async () => { throw new Unreachable("down"); } }));
    await settle();
    const box = typeIn("Yes, bring dessert");
    sendBtn().click();
    await settle();
    expect(held.length).toBe(1);
    expect(held[0][1]).toBe("Yes, bring dessert");
    expect(box.value).toBe("");
  });
  it("two quick taps send once", async () => {
    let sends = 0;
    open(fake({ push: async () => ({ rows: [row("c1", "Lease chat")] }), send: () => { sends += 1; return new Promise((r) => setTimeout(() => r("sent"), 20)); } }));
    await settle();
    typeIn("Yes");
    sendBtn().click();
    sendBtn().click();
    await settle();
    expect(sends).toBe(1);
  });
});
