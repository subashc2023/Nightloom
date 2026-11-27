// @vitest-environment happy-dom
/*
 * Item 993g: Settings → Phone's "Phones allowed to send". A phone's ask shows with its code; his Allow click here is
 * what allows it (the window's `phone_key_allow` command, called from this component and nowhere else); Remove asks
 * first. The Mac's commands are stubs here: no Keychain is touched. Who may call the Allow command at all is
 * `phoneKeyAllowCallers993g.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import PhoneKeys from "./PhoneKeys.svelte";
import type { PhoneKeys as Lists } from "./api";

function fakeMac() {
  const calls: [string, string?][] = [];
  const s: Lists = { asked: [{ id: "k1", name: "iPhone · Safari", code: "123 456", at: "2026-11-27T15:00:00Z" }], allowed: [], error: null };
  let again: (() => void) | null = null;
  return {
    calls,
    s,
    ask: (id: string) => (s.asked.push({ id, name: "iPhone · Home Screen app", code: "654 321", at: "2026-11-27T15:05:00Z" }), again?.()),
    deps: {
      list: async () => (calls.push(["list"]), structuredClone(s)),
      allow: async (id: string) => {
        calls.push(["allow", id]);
        const a = s.asked.find((x) => x.id === id)!;
        s.asked = s.asked.filter((x) => x.id !== id);
        s.allowed.push({ ...a, code: null });
        return structuredClone(s);
      },
      deny: async (id: string) => (calls.push(["deny", id]), (s.asked = s.asked.filter((x) => x.id !== id)), structuredClone(s)),
      revoke: async (id: string) => (calls.push(["revoke", id]), (s.allowed = s.allowed.filter((x) => x.id !== id)), structuredClone(s)),
      changed: async (f: () => void) => ((again = f), () => (again = null)),
    },
  };
}

let host: ReturnType<typeof mount> | null = null;
async function settle() {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label);
afterEach(() => {
  if (host) void unmount(host);
  host = null;
  document.body.innerHTML = "";
});

describe("993g: the Mac's Allow", () => {
  it("shows a phone's ask with its code, allows it only on his click, and lists it as allowed", async () => {
    const m = fakeMac();
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    const ask = document.querySelector("[data-phone-ask='k1']")!;
    expect(ask.textContent).toContain("iPhone · Safari asks to send");
    expect(ask.querySelector(".pk-code")!.textContent).toBe("123 456");
    // Showing it allowed nothing.
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([]);
    btn("Allow")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([["allow", "k1"]]);
    expect(document.querySelector("[data-phone-ask]")).toBeNull();
    expect(document.querySelector("[data-phone-allowed='k1']")!.textContent).toContain("Allowed to send since");
  });

  it("a second phone's ask appears while the card is open; Don't allow drops it", async () => {
    const m = fakeMac();
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    m.ask("k2");
    await settle();
    const second = document.querySelector("[data-phone-ask='k2']")!;
    expect(second.querySelector(".pk-code")!.textContent).toBe("654 321");
    [...second.querySelectorAll("button")].find((b) => b.textContent === "Don't allow")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "deny")).toEqual([["deny", "k2"]]);
    expect(document.querySelector("[data-phone-ask='k2']")).toBeNull();
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([]);
  });

  it("Remove asks first, and Keep leaves the phone allowed", async () => {
    const m = fakeMac();
    m.s.asked = [];
    m.s.allowed = [{ id: "k1", name: "iPhone · Safari", code: null, at: "2026-11-27T15:00:00Z" }];
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    btn("Remove…")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "revoke")).toEqual([]);
    btn("Keep")!.click();
    await settle();
    expect(document.querySelector("[data-phone-allowed='k1']")).toBeTruthy();
    btn("Remove…")!.click();
    await settle();
    btn("Remove")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "revoke")).toEqual([["revoke", "k1"]]);
    expect(document.querySelector("[data-phone-allowed]")).toBeNull();
  });

  it("a Keychain that cannot be read says so", async () => {
    const m = fakeMac();
    m.s.asked = [];
    m.s.error = "Your Mac's Keychain could not be read, so no phone can send until it can.";
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    expect(document.querySelector("[role='alert']")!.textContent).toContain("Keychain could not be read");
  });
});
