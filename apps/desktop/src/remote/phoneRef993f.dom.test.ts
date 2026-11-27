// @vitest-environment happy-dom
/*
 * Item 993f: the typed link's card on the phone — the Mac's own card and host as a bottom sheet, every action run on
 * the Mac through the listener. The Mac's listener is a stub client here that records every call (never a real
 * account): what the sheet shows comes from the real message's read, a mail goes only with the tap his press minted,
 * and a phone that loses the Mac during the hold sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import PhoneRefCards from "./PhoneRefCards.svelte";
import { renderMarkdown } from "../lib/markdown";
import { draftOf, refMaybe, resetDrafts } from "../lib/refDrafts.svelte";
import { Unreachable, type Client } from "./client";
import type { HomeReach } from "../lib/home";
import type { MailHeads } from "../lib/refCard";
import type { RefActItem, RefActReceipt } from "../lib/api";

const GMAIL = "claude.ai Gmail 2117773e";
// The tag names Priya S.; the real message is from Client Co (the 993e review's case).
const EMAIL = `<email id="m_9" thread="t_9" src="${GMAIL}" from="Priya S." at="2026-11-25T11:42-08:00" link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation</email>`;
const KEY = `email:${GMAIL}:m_9`;
const HEADS: MailHeads = { from: "client@co.example", from_name: "Client Co", to: ["me@school.edu"], cc: [], subject: "Re: Speaker confirmation", names: {} };
const HOLD = 150;
const REACH: HomeReach = {
  checked_at: "2026-11-25T15:00:00Z",
  error: null,
  accounts: [{ connector: GMAIL, service: "Gmail", kind: "mail", address: "me@school.edu", nth: null, status: "connected", on: true, claude_ai: true, in_scan: true } as HomeReach["accounts"][number]],
  locals: [],
};

type Call = [string, ...unknown[]];
function fakeMac(o: { act?: () => Promise<RefActReceipt>; lock?: string | null } = {}) {
  const calls: Call[] = [];
  let taps = 0;
  const c = {
    refReach: async () => (calls.push(["reach"]), REACH),
    refRead: async (item: RefActItem) => (calls.push(["read", item.id]), HEADS),
    refTap: async (item: RefActItem, act: unknown) => (calls.push(["tap", item.id, act]), { tap: `tap-${++taps}`, hold_ms: 5000 }),
    refAct: async (tap: string, item: RefActItem, act: unknown) => {
      calls.push(["act", tap, item.id, act]);
      return o.act ? o.act() : { outcome: "done", text: "Sent to client@co.example" };
    },
    refUndo: async (tap: string) => void calls.push(["undo", tap]),
    refLock: async (key: string) => (calls.push(["lock", key]), { maybe: o.lock ?? null, going: false, held: false }),
    refChecked: async (key: string) => void calls.push(["checked", key]),
  };
  return { c: c as unknown as Client, calls, of: (k: string) => calls.filter((x) => x[0] === k) };
}

let host: ReturnType<typeof mount> | null = null;
let page: HTMLElement;
let away: string | null = null;
function setup(mac: Client | null) {
  page = document.createElement("div");
  page.innerHTML = `<div class="md">${renderMarkdown(`Mail: ${EMAIL}.`, { breaks: true, localImagesAsText: true })}</div>`;
  document.body.appendChild(page);
  host = mount(PhoneRefCards, { target: document.body, props: { mac: () => mac, offline: () => away, holdMs: HOLD } });
  flushSync();
}
const link = () => page.querySelector<HTMLElement>("a.nl-ref")!;
const card = () => document.querySelector<HTMLElement>(".ref-card");
const btn = (label: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label));
const bar = () => document.querySelector<HTMLElement>(".ref-hold-bar");
async function settle(ms = 0) {
  await tick();
  flushSync();
  await new Promise((r) => setTimeout(r, ms));
  flushSync();
}
const click = async (el: Element | undefined | null) => {
  expect(el, "the thing to click exists").toBeTruthy();
  el!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  (el as HTMLElement).click();
  await settle();
};
const type = async (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
async function reply(body: string) {
  await click(link());
  await settle(5);
  await click(btn("Reply"));
  await settle(5);
  await type(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!, body);
}

beforeEach(() => {
  away = null;
  resetDrafts();
  document.documentElement.dataset.layout = "classic";
});
afterEach(() => {
  if (host) void unmount(host);
  host = null;
  document.body.innerHTML = "";
});

describe("993f: the phone's sheet", () => {
  it("opens as a bottom sheet and shows the recipients read from the real message, not the tag", async () => {
    const m = fakeMac();
    setup(m.c);
    await reply("Thanks, see you Thursday.");
    expect(card()!.classList.contains("sheet")).toBe(true);
    expect(document.querySelector(".ref-shade")).toBeTruthy();
    const to = card()!.querySelector("[data-real-to]")!.textContent!;
    expect(to).toContain("Client Co");
    expect(to).not.toContain("Priya");
    expect(btn("Send to Client Co")?.disabled).toBe(false);
    expect(m.of("read")).toEqual([["read", "m_9"]]);
    // Opening and writing asked the Mac for no tap and ran nothing.
    expect(m.of("tap")).toEqual([]);
    expect(m.of("act")).toEqual([]);
  });

  it("his Send takes one tap; the mail goes only when the hold ends, with that tap and exactly his words", async () => {
    const m = fakeMac();
    setup(m.c);
    await reply("Thanks —\nsee you.");
    await click(btn("Send to Client Co"));
    await settle(5);
    expect(m.of("tap").length).toBe(1);
    expect(m.of("act")).toEqual([]);
    expect(bar()?.textContent).toContain("Sending to Client Co");
    await settle(HOLD + 400);
    expect(m.of("act")).toEqual([["act", "tap-1", "m_9", { type: "send", mode: "reply", to: "Client Co <client@co.example>", body: "Thanks —\nsee you.", recipients: { to: ["client@co.example"], cc: [] }, about: "Re: Speaker confirmation" }]]);
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Sent to client@co.example · Re: Speaker confirmation");
    expect(draftOf(KEY)).toBeNull();
  });

  it("a dropped connection during the hold sends nothing: the hold stops, the tap is dropped, his words stay", async () => {
    const m = fakeMac();
    setup(m.c);
    await reply("Yes, works for me.");
    await click(btn("Send to Client Co"));
    await settle(20);
    expect(m.of("tap").length).toBe(1);
    // The phone loses the Mac mid-hold, and is back before the hold would have ended.
    away = "Your phone is not reaching your Mac right now, so nothing can be sent from here. Your words are kept.";
    await settle(300);
    away = null;
    await settle(HOLD + 400);
    expect(m.of("act")).toEqual([]);
    expect(m.of("undo")).toEqual([["undo", "tap-1"]]);
    expect(bar()?.textContent).toContain("Not sent: your phone lost your Mac during the hold");
    expect(draftOf(KEY)?.body).toBe("Yes, works for me.");
  });

  it("Undo on the hold bar, with the sheet closed, sends nothing", async () => {
    const m = fakeMac();
    setup(m.c);
    await reply("On my way.");
    await click(btn("Send to Client Co"));
    await settle(5);
    // Closing the sheet (a press on the shade) leaves the hold and its Undo on the bar.
    document.querySelector(".ref-shade")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await settle(10);
    expect(card()).toBeNull();
    const undo = [...bar()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
    await click(undo);
    await settle(HOLD + 400);
    expect(m.of("act")).toEqual([]);
    expect(m.of("undo")).toEqual([["undo", "tap-1"]]);
  });

  it("offline before he taps: the actions are off with the reason, and no tap is asked", async () => {
    const m = fakeMac();
    away = "Your phone is not reaching your Mac right now, so nothing can be sent from here. Your words are kept.";
    setup(m.c);
    await click(link());
    await settle(5);
    expect(btn("Reply")?.disabled).toBe(true);
    expect(card()!.textContent).toContain("not reaching your Mac");
    expect(m.of("tap")).toEqual([]);
  });

  it("the answer lost as the mail was let go: it may have gone, and Send stays off until he checked", async () => {
    const m = fakeMac({ act: () => Promise.reject(new Unreachable("TypeError: Load failed")) });
    setup(m.c);
    await reply("Confirmed.");
    await click(btn("Send to Client Co"));
    await settle(HOLD + 400);
    expect(m.of("act").length).toBe(1);
    expect(refMaybe.by[KEY]).toContain("may have gone");
    expect(card()!.querySelector(".rc-maybe")).toBeTruthy();
    await click(btn("I checked: not sent"));
    expect(m.of("checked")).toEqual([["checked", KEY]]);
  });

  it("a lock the Mac keeps (set on the other screen) locks Send here when the sheet opens", async () => {
    const m = fakeMac({ lock: "It may have gone. Check Sent in Gmail before sending again." });
    setup(m.c);
    await click(link());
    await settle(5);
    expect(m.of("lock")).toEqual([["lock", KEY]]);
    expect(card()!.querySelector(".rc-maybe")?.textContent).toContain("It may have gone");
  });
});
