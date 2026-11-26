// @vitest-environment happy-dom
/*
 * Item 995: the phone's one Needs-you number is the Mac pill's — held blockers and proposals included — in the
 * header, the Needs-you section's head and the Watching tab; "nothing needs you" only when it is 0.
 * (Harness copied from home947.dom.test.ts.)
 * Was — Item 947 (phone Home stress test): the page must not say "nothing needs you" from a read that never happened.
 *  - the host not answering on the very first read: the header says it has not read, no calm line, the Tell Home hint
 *    does not claim Home is "not set up";
 *  - /push/feed answering 500 after a good read: the rows of the last read stay, a line says part could not be read;
 *  - an older read that lands after a newer one is dropped (a slow reply must not bring back an answered question).
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import HomeFirst from "./HomeFirst.svelte";
import { ApiError, type Client, type RemoteState } from "./client";

const row = (chat: string, label: string) => ({ what: "question", chat, label, project: "p", at: Date.now() - 60_000 });
type Plan = { push: () => Promise<unknown>; feed?: () => Promise<unknown>; send?: (...a: unknown[]) => Promise<unknown>; held?: () => Promise<unknown> };
function fake(plan: Plan): Client {
  const base: Record<string, () => Promise<unknown>> = {
    homeToday: async () => ({ points: 0.3, cap: 5, week: 41, five_hour: 12, stopped: null }),
    homeFeed: plan.feed ?? (async () => ({ rows: [], seen_at: null, as_of: Date.now(), home: { project: "home", chat: "h" } })),
    homeScan: async () => ({ scan: null }),
    pushFeed: plan.push,
    jobs: async () => ({ jobs: [], now: "" }),
    homeHeld: plan.held ?? (async () => ({ blockers: [] })),
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

const heldB = (id: string) => ({ project: "ns", project_name: "Nightshift", id, item: "1", question: `Question ${id}?` });

describe("995: the phone counts what the Mac's pill counts", () => {
  it("4 held blockers + 1 proposal: header, section head and Watching tab say 5; never 'nothing needs you'", async () => {
    open(fake({ push: async () => ({ rows: [] }), held: async () => ({ blockers: ["2290", "2292", "2300", "2301"].map(heldB), proposals: 1 }) }));
    await settle();
    expect(document.querySelector(".h-title")?.textContent).toContain("5 need you");
    expect(text()).not.toMatch(/nothing needs you/i);
    expect(document.querySelector("[data-home-proposals]")?.textContent).toContain("1 proposal to review");
    expect(text()).toContain("4 held blockers");
    expect(text()).toContain("in the count above");
    expect(document.querySelector(".h9-tab .cnt")?.textContent).toBe("5");
  });

  it("a chat's question + 1 held blocker: 2", async () => {
    open(fake({ push: async () => ({ rows: [row("c1", "Lab 4")] }), held: async () => ({ blockers: [heldB("2290")] }) }));
    await settle();
    expect(document.querySelector(".h-title")?.textContent).toContain("2 need you");
    expect(document.querySelector(".h9-tab .cnt")?.textContent).toBe("2");
  });

  it("nothing waits: 'nothing needs you' in the header and the calm line", async () => {
    open(fake({ push: async () => ({ rows: [] }), held: async () => ({ blockers: [], proposals: 0 }) }));
    await settle();
    expect(document.querySelector(".h-title")?.textContent).toContain("nothing needs you");
    expect(text()).toContain("Nothing needs you");
    expect(document.querySelector(".h9-tab .cnt")).toBeNull();
  });
});
