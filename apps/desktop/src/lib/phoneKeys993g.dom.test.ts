// @vitest-environment happy-dom
/*
 * Item 993g: Settings → Phone's "Phones allowed to send". A phone's ask shows WITHOUT a code (review 2026-11-27,
 * finding 1: only the phone shows it); he types the code from his phone and his Allow click here is what allows it (the window's `phone_key_allow` command, called from this component and nowhere else); Remove asks
 * first. The Mac's commands are stubs here: no Keychain is touched. Who may call the Allow command at all is
 * `phoneKeyAllowCallers993g.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import PhoneKeys from "./PhoneKeys.svelte";
import type { PhoneKeys as Lists } from "./api";

function fakeMac() {
  const calls: [string, string?, string?][] = [];
  // The code each asking phone shows on its own screen; the Mac's lists never carry it.
  const codes: Record<string, string> = { k1: "123456", k2: "654321" };
  const misses: Record<string, number> = {};
  const s: Lists = { asked: [{ id: "k1", name: "iPhone · Safari", at: "2026-11-27T15:00:00Z" }], allowed: [], error: null };
  let again: (() => void) | null = null;
  return {
    calls,
    s,
    ask: (id: string) => (s.asked.push({ id, name: "iPhone · Home Screen app", at: "2026-11-27T15:05:00Z" }), again?.()),
    deps: {
      list: async () => (calls.push(["list"]), structuredClone(s)),
      allow: async (id: string, code: string) => {
        calls.push(["allow", id, code]);
        const a = s.asked.find((x) => x.id === id)!;
        if (code !== codes[id]) {
          misses[id] = (misses[id] ?? 0) + 1;
          if (misses[id] >= 3) s.asked = s.asked.filter((x) => x.id !== id);
          throw new Error(misses[id] >= 3 ? "That was not the code 3 times, so this ask is gone." : "That is not the code this phone shows.");
        }
        s.asked = s.asked.filter((x) => x.id !== id);
        s.allowed.push({ ...a });
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
function type(row: Element, text: string) {
  const i = row.querySelector<HTMLInputElement>("input.pk-code")!;
  i.value = text;
  i.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label);
afterEach(() => {
  if (host) void unmount(host);
  host = null;
  document.body.innerHTML = "";
});

describe("993g: the Mac's Allow", () => {
  it("shows a phone's ask with no code, allows it only with the code he typed and his click, and lists it as allowed", async () => {
    const m = fakeMac();
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    const ask = document.querySelector("[data-phone-ask='k1']")!;
    expect(ask.textContent).toContain("iPhone · Safari asks to send");
    // The Mac never shows the code: not in the row, not anywhere on the page.
    expect(document.body.textContent).not.toContain("123");
    // Showing it allowed nothing, and Allow waits for six digits.
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([]);
    expect(btn("Allow")!.disabled).toBe(true);
    type(ask, "123 45");
    expect(btn("Allow")!.disabled).toBe(true);
    type(ask, "123 456");
    expect(btn("Allow")!.disabled).toBe(false);
    btn("Allow")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([["allow", "k1", "123456"]]);
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
    expect(second.querySelector<HTMLInputElement>("input.pk-code")!.value).toBe("");
    [...second.querySelectorAll("button")].find((b) => b.textContent === "Don't allow")!.click();
    await settle();
    expect(m.calls.filter((c) => c[0] === "deny")).toEqual([["deny", "k2"]]);
    expect(document.querySelector("[data-phone-ask='k2']")).toBeNull();
    expect(m.calls.filter((c) => c[0] === "allow")).toEqual([]);
  });

  it("a wrong code is refused with the reason, and the third drops the ask", async () => {
    const m = fakeMac();
    host = mount(PhoneKeys, { target: document.body, props: { deps: m.deps } });
    await settle();
    for (let i = 0; i < 2; i++) {
      type(document.querySelector("[data-phone-ask='k1']")!, "999999");
      btn("Allow")!.click();
      await settle();
      expect(document.querySelector("[role='alert']")!.textContent).toContain("not the code");
      expect(document.querySelector("[data-phone-ask='k1']")).toBeTruthy();
    }
    type(document.querySelector("[data-phone-ask='k1']")!, "999999");
    btn("Allow")!.click();
    await settle();
    expect(document.querySelector("[data-phone-ask='k1']")).toBeNull();
    expect(document.querySelector("[data-phone-allowed]")).toBeNull();
  });

  it("Remove asks first, and Keep leaves the phone allowed", async () => {
    const m = fakeMac();
    m.s.asked = [];
    m.s.allowed = [{ id: "k1", name: "iPhone · Safari", at: "2026-11-27T15:00:00Z" }];
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
