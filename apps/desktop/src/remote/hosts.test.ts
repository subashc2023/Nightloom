import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, TOKEN_KEY, Unreachable, newQueued } from "./client";
import {
  HOSTS_KEY,
  PROBE_MS,
  chooseHost,
  forgetHost,
  guessRole,
  loadHosts,
  missingSentence,
  mixedBlocked,
  nextHeldFor,
  offlineLine,
  openLink,
  order,
  pair,
  pairLink,
  routeFor,
  saveHosts,
  settleRole,
  type HostRole,
  type Hosts,
} from "./hosts";

// Generated test values, not anyone's token.
const T1 = "0123456789abcdef0123456789abcdef";
const T2 = "fedcba9876543210fedcba9876543210";
const MAC = "http://100.101.102.103:8642";
const AWAY = "https://nightloom-test.fly.dev";
const both: Hosts = { mac: { base: MAC, token: T1 }, away: { base: AWAY, token: T2 } };

describe("choosing the host", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes the Mac when it answers", async () => {
    const asked: HostRole[] = [];
    const got = await chooseHost(order(both), both, async (r) => {
      asked.push(r);
      return { host: r === "mac" ? "mac" : "serve" };
    });
    expect(got.role).toBe("mac");
    expect(got.tried).toEqual([]);
    expect(asked).toEqual(["mac"]);
  });

  it("moves to Away when the Mac does not answer in 1.5 s", async () => {
    const told: [HostRole, number][] = [];
    const p = chooseHost(
      order(both),
      both,
      (r, signal) =>
        r === "mac"
          ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Unreachable("aborted", MAC))))
          : Promise.resolve({ host: "serve" }),
      undefined,
      PROBE_MS,
      (r, sofar) => told.push([r, sofar.length]),
    );
    await vi.advanceTimersByTimeAsync(PROBE_MS - 1);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const got = await p;
    expect(got.role).toBe("away");
    expect(got.tried).toEqual([{ role: "mac", base: MAC, why: "timeout" }]);
    // The bar is told Away is being tried, with the Mac's timeout.
    expect(told).toEqual([
      ["mac", 0],
      ["away", 1],
    ]);
    expect(offlineLine(got.tried, "away", ["mac", "away"])).toBe("Can't reach the Mac at 100.101.102.103:8642 — trying Away");
  });

  it("a probe that ignores its signal still loses at the deadline", async () => {
    const p = chooseHost(["mac", "away"], both, (r) => (r === "mac" ? new Promise(() => {}) : Promise.resolve(1)));
    await vi.advanceTimersByTimeAsync(PROBE_MS + 1);
    expect((await p).role).toBe("away");
  });

  it("says both are down, naming both addresses", async () => {
    const got = await chooseHost(order(both), both, async (r) => {
      throw new Unreachable("down", both[r]!.base);
    });
    expect(got.role).toBeNull();
    expect(got.tried.map((t) => t.why)).toEqual(["unreachable", "unreachable"]);
    const line = offlineLine(got.tried, null, ["mac", "away"]);
    expect(line).toContain("Can't reach either host");
    expect(line).toContain("the Mac at 100.101.102.103:8642");
    expect(line).toContain("Away at nightloom-test.fly.dev");
  });

  it("reports a refused token as refused, and skips a blocked host untried", async () => {
    const asked: HostRole[] = [];
    const got = await chooseHost(
      order(both),
      both,
      async (r) => {
        asked.push(r);
        throw new ApiError(401, "wrong token", both[r]!.base);
      },
      (r) => r === "mac",
    );
    expect(asked).toEqual(["away"]);
    expect(got.tried).toEqual([
      { role: "mac", base: MAC, why: "blocked" },
      { role: "away", base: AWAY, why: "refused", message: "wrong token" },
    ]);
  });

  it("one host down says what to check", () => {
    expect(offlineLine([{ role: "mac", base: MAC, why: "unreachable" }], null, ["mac"])).toBe(
      "Can't reach the Mac at 100.101.102.103:8642 — is Tailscale on, and Remote switched on?",
    );
  });

  it("tries the preferred host first, and only paired ones", () => {
    expect(order(both)).toEqual(["mac", "away"]);
    expect(order(both, "away")).toEqual(["away", "mac"]);
    expect(order({ away: both.away })).toEqual(["away"]);
    expect(order({})).toEqual([]);
  });
});

describe("tokens, per host", () => {
  beforeEach(() => localStorage.clear());

  it("keeps each host's own token and address", () => {
    saveHosts(both, MAC);
    const back = loadHosts(MAC);
    expect(back.mac).toEqual({ base: MAC, token: T1 });
    expect(back.away).toEqual({ base: AWAY, token: T2 });
    // This page's own host's token is also where an older page looks.
    expect(localStorage.getItem(TOKEN_KEY)).toBe(T1);
    saveHosts(forgetHost(back, "mac"), MAC);
    expect(loadHosts(MAC)).toEqual({ away: { base: AWAY, token: T2 } });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("takes the one token a page from before wave 4 kept as this page's host", () => {
    localStorage.setItem(TOKEN_KEY, T1);
    expect(loadHosts(MAC)).toEqual({ mac: { base: MAC, token: T1 } });
    expect(loadHosts(AWAY + "/")).toEqual({ away: { base: AWAY, token: T1 } });
  });

  it("drops a stored host that is not a host", () => {
    localStorage.setItem(HOSTS_KEY, JSON.stringify({ mac: { base: "javascript:alert(1)", token: T1 }, away: { base: AWAY, token: "nope" } }));
    expect(loadHosts(MAC)).toEqual({});
  });

  it("pairs from a pasted link or a bare token, never from a query", () => {
    expect(pairLink(`${AWAY}/#token=${T2}`, MAC)).toEqual({ base: AWAY, token: T2 });
    expect(pairLink(T1.toUpperCase(), MAC)).toEqual({ base: MAC, token: T1 });
    expect(pairLink(`${AWAY}/?token=${T2}`, MAC)).toBeNull();
    expect(pairLink("hello", MAC)).toBeNull();
    expect(openLink({ base: AWAY, token: T2 })).toBe(`${AWAY}/#token=${T2}`);
  });

  it("one address is one host", () => {
    const h = pair({ mac: { base: AWAY, token: T1 } }, "away", { base: AWAY, token: T2 });
    expect(h).toEqual({ away: { base: AWAY, token: T2 } });
  });

  it("guesses the role from the address, and the host's own word settles it", () => {
    expect(guessRole(AWAY)).toBe("away");
    expect(guessRole(MAC)).toBe("mac");
    const wrong: Hosts = { mac: { base: "https://example.test", token: T2 } };
    expect(settleRole(wrong, "mac", "serve")).toEqual({ hosts: { away: wrong.mac }, role: "away" });
    expect(settleRole(both, "mac", undefined)).toEqual({ hosts: both, role: "mac" });
    expect(settleRole(both, "away", "serve")).toEqual({ hosts: both, role: "away" });
  });
});

describe("what cannot cross", () => {
  it("an HTTPS page cannot call the Mac's plain HTTP; the Mac's page can call Away", () => {
    expect(mixedBlocked(AWAY, MAC)).toBe(true);
    expect(mixedBlocked(MAC, AWAY)).toBe(false);
    expect(mixedBlocked(AWAY, "http://127.0.0.1:5310")).toBe(false);
    expect(mixedBlocked(AWAY, "https://mac.tailnet.ts.net:8642")).toBe(false);
  });
});

describe("the sentence for a missing feature", () => {
  const older = "This Mac's Nightloom is older than the phone page: update it to see running tasks here.";
  it("says the away server lacks it", () => expect(missingSentence("serve", older)).toBe("Not on the away server yet."));
  it("keeps the older-Mac sentence when the host does not say what it is", () => {
    expect(missingSentence(undefined, older)).toBe(older);
    expect(missingSentence(null, older)).toBe(older);
  });
  it("says a current Mac does not offer it", () => expect(missingSentence("mac", older)).toBe("This Mac does not offer this."));
});

describe("a chat goes to its own host", () => {
  it("routes a chat to the host that listed it, a new chat to the host answering", () => {
    expect(routeFor("away", "mac")).toBe("away");
    expect(routeFor("mac", "away")).toBe("mac");
    expect(routeFor(null, "away")).toBe("away");
    expect(routeFor(null, null)).toBeNull();
  });

  it("drains held messages per host; one held before wave 3 is the Mac's", () => {
    const old = newQueued("c1", "held long ago");
    const away = newQueued("a1", "for away", new Date(), null, "away");
    const mac = newQueued("c2", "for the mac", new Date(), null, "mac");
    expect(nextHeldFor([away, old, mac], "mac")).toBe(old);
    expect(nextHeldFor([old, away], "away")).toBe(away);
    expect(nextHeldFor([old], "away")).toBeNull();
    expect(nextHeldFor([old], null)).toBeNull();
  });
});
