// @vitest-environment happy-dom
/*
 * Item 993e: Reply / Reply all / Forward sent from the card — only from his click on "Send to …" with the whole
 * draft on screen (blocker 2304), and the hold before it goes is its Undo (blocker 2305): the one command that
 * sends is called only when the countdown ends; Undo in it (the card's button, the toast's, Esc) calls nothing.
 * The card and host render for real over `refAct.ts`'s rule; only the command is a stub that records its calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import RefCardHost from "./RefCardHost.svelte";
import { renderReply } from "./markdown";
import { draftOf, resetDrafts } from "./refDrafts.svelte";
import { makeRefAct, type RefActDeps } from "./refAct";
import type { RefAction } from "./refCard";
import type { RefActItem, RefActReceipt } from "./api";
import type { HomeReach } from "./home";
import { MailUndone, isUndone, secondsLeft, startHold, type HoldToast } from "./mailHold";

const GMAIL = "claude.ai Gmail 2117773e";
const EMAIL = `<email id="m_9" thread="t_9" src="${GMAIL}" from="Priya S." at="2026-11-25T11:42-08:00" link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation</email>`;
const KEY = `email:${GMAIL}:m_9`;
const HOLD = 150;

const acct = (connector: string, over: Partial<HomeReach["accounts"][number]> = {}) => ({ connector, service: "Gmail", kind: "mail" as const, address: "me@school.edu", nth: null, status: "connected" as const, on: true, claude_ai: true, in_scan: true, ...over });
const REACH: HomeReach = { checked_at: "2026-11-25T15:00:00Z", error: null, accounts: [acct(GMAIL)], locals: [] };

describe("993e: the hold (mailHold)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs out into a send; Undo before then means none, and Undo after it is too late", async () => {
    const h = startHold(5000);
    expect(secondsLeft(h.until)).toBe(5);
    vi.advanceTimersByTime(4999);
    expect(h.undo()).toBe(true);
    expect(await h.done).toBe(false);
    vi.advanceTimersByTime(10);
    expect(h.undo()).toBe(false);

    const g = startHold(5000);
    vi.advanceTimersByTime(5000);
    expect(await g.done).toBe(true);
    expect(g.undo()).toBe(false);
    expect(isUndone(new MailUndone())).toBe(true);
    expect(isUndone(new Error("x"))).toBe(false);
  });
});

interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  settled: string[];
}
let toasts: Toast[] = [];
const holdToast: HoldToast = {
  start: (text, undo) => {
    const t = { id: toasts.length + 1, text, undo, settled: [] as string[] };
    toasts.push(t);
    return t.id;
  },
  update: (id, text) => void (toasts[id - 1].text = text),
  settle: (id, text) => {
    const t = toasts[id - 1];
    t.undo = undefined;
    t.text = text;
    t.settled.push(text);
  },
};

function deps(answer: (act: RefAction) => RefActReceipt | Promise<RefActReceipt> = () => ({ outcome: "done", text: "Sent to Priya S." })) {
  const ran: { item: RefActItem; act: RefAction }[] = [];
  const d: RefActDeps = {
    openUrl: async () => {},
    openTab: async () => {},
    copy: async () => {},
    run: async (item, act) => {
      ran.push({ item, act });
      return answer(act);
    },
  };
  return { d, ran };
}

let host: ReturnType<typeof mount> | null = null;
let page: HTMLElement;
function setup(d: RefActDeps, mailSend = true) {
  page = document.createElement("div");
  page.innerHTML = `<div class="markdown">${renderReply(`Mail: ${EMAIL}.`)}</div>`;
  document.body.appendChild(page);
  host = mount(RefCardHost, { target: document.body, props: { reach: () => REACH, act: makeRefAct(d), mailSend, holdToast, holdMs: HOLD } });
  flushSync();
}
const link = () => page.querySelector<HTMLElement>("a.nl-ref")!;
const card = () => document.querySelector<HTMLElement>(".ref-card");
const btn = (label: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label));
const holdRow = () => card()?.querySelector<HTMLElement>(".rc-hold") ?? null;
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
const key = async (k: string, over: KeyboardEventInit = {}) => {
  (document.activeElement && card()?.contains(document.activeElement) ? document.activeElement : card()!).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...over }));
  await settle();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
async function draft(mode: "Reply" | "Reply all" | "Forward", body: string, to?: string) {
  await click(link());
  await click(btn(mode));
  if (to !== undefined) await type(card()!.querySelector<HTMLInputElement>(".rc-to input")!, to);
  await type(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!, body);
}

beforeEach(() => {
  toasts = [];
  resetDrafts();
  document.documentElement.dataset.layout = "classic";
});
afterEach(() => {
  if (host) void unmount(host);
  host = null;
  document.body.innerHTML = "";
});

describe("993e: a mail goes only from his click, after the hold", () => {
  it("drawing the reply, opening the card and writing a draft call nothing", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Thanks — see you.");
    await settle(HOLD + 60);
    expect(l.ran).toEqual([]);
    expect(holdRow()).toBeNull();
    expect(toasts).toEqual([]);
  });

  it("Send to Priya S.: nothing is called during the hold; then exactly the words on screen go, once", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Thanks —\nsee you there.");
    expect(btn("Send to Priya S.")?.disabled).toBe(false);
    await click(btn("Send to Priya S."));
    // The hold: shown on the card and on a toast, words locked, nothing called.
    expect(l.ran).toEqual([]);
    expect(holdRow()?.textContent).toContain("Sending to Priya S. in");
    expect(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!.disabled).toBe(true);
    expect(toasts.length).toBe(1);
    expect(toasts[0].text).toMatch(/^Sending to Priya S\. in \d s$/);
    expect(toasts[0].undo).toBeTypeOf("function");
    // A second click in the hold sends nothing more.
    await click(btn("Send to Priya S."));
    await key("Enter", { metaKey: true });
    expect(l.ran).toEqual([]);
    await settle(HOLD + 400);
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "reply", to: "Priya S.", body: "Thanks —\nsee you there." }]);
    expect(l.ran[0].item).toEqual({ kind: "email", id: "m_9", src: GMAIL, cal: undefined, name: "Speaker confirmation" });
    // The receipt says who it went to; the draft is gone; the link gets its ✓.
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Sent");
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Sent to Priya S. · Speaker confirmation");
    expect(draftOf(KEY)).toBeNull();
    expect(link().classList.contains("ref-done")).toBe(true);
    expect(toasts[0].settled).toEqual(["Sending to Priya S.…", "Sent to Priya S. · Speaker confirmation"]);
    expect(toasts[0].undo).toBeUndefined();
  });

  it("Undo on the card during the hold: no send command is issued, and the draft stays", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply all", "Yes, works for me.");
    await click(btn("Send to Priya S. and everyone on it"));
    await click(holdRow()!.querySelector("button"));
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    expect(holdRow()).toBeNull();
    expect(card()!.querySelector(".rc-undone")?.textContent).toContain("Not sent");
    expect(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!.value).toBe("Yes, works for me.");
    expect(draftOf(KEY)?.body).toBe("Yes, works for me.");
    expect(toasts[0].settled).toEqual(["Not sent to Priya S. and everyone on it: undone. Your words are kept in the card."]);
    // He can send it after all: a fresh hold, then the one call.
    await click(btn("Send to Priya S. and everyone on it"));
    await settle(HOLD + 400);
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "replyAll", to: "Priya S. and everyone on it", body: "Yes, works for me." }]);
  });

  it("Undo on the toast, and Esc in the card, stop it too", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "One.");
    await click(btn("Send to Priya S."));
    toasts[0].undo!();
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    expect(card()).not.toBeNull();

    await click(btn("Send to Priya S."));
    expect(holdRow()).not.toBeNull();
    await key("Escape");
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    // Esc stopped the mail; it did not close the card or leave the confirm.
    expect(card()?.dataset.view).toBe("confirm");
  });

  it("closing the card does not stop the hold; the toast keeps its Undo; reopened, the card shows it", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Closing on it.");
    await click(btn("Send to Priya S."));
    await click(card()!.querySelector(".rc-x"));
    expect(card()).toBeNull();
    expect(toasts[0].undo).toBeTypeOf("function");
    await click(link());
    expect(holdRow()?.textContent).toContain("Sending to Priya S. in");
    // No new mail can start while one is held.
    expect(btn("Reply")?.disabled).toBe(false);
    await click(btn("Reply"));
    expect(card()?.dataset.view).toBe("details");
    toasts[0].undo!();
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    expect(holdRow()).toBeNull();
  });

  it("closed and left alone, it goes when the hold ends; an Undo after that is too late and does nothing", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Left alone.");
    await click(btn("Send to Priya S."));
    const late = toasts[0].undo!;
    await click(card()!.querySelector(".rc-x"));
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(1);
    late();
    await settle(50);
    expect(l.ran.length).toBe(1);
    expect(toasts[0].text).toBe("Sent to Priya S. · Speaker confirmation");
    expect(draftOf(KEY)).toBeNull();
  });

  it("a forward needs his address; it goes to exactly that address", async () => {
    const l = deps(() => ({ outcome: "done", text: "Forwarded to sam@example.com" }));
    setup(l.d);
    await draft("Forward", "FYI");
    expect(btn("Send to")?.disabled).toBe(true);
    await type(card()!.querySelector<HTMLInputElement>(".rc-to input")!, "sam@example.com");
    await click(btn("Send to sam@example.com"));
    await settle(HOLD + 400);
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "forward", to: "sam@example.com", body: "FYI" }]);
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Forwarded to sam@example.com · Speaker confirmation");
  });

  it("a failed send keeps the confirm and his words, and the toast says why", async () => {
    const l = deps(() => ({ outcome: "error", text: "the connector said: rate limited" }));
    setup(l.d);
    await draft("Reply", "Try me.");
    await click(btn("Send to Priya S."));
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(1);
    expect(card()?.dataset.view).toBe("confirm");
    expect(card()!.querySelector("[role=alert]")?.textContent).toContain("rate limited");
    expect(draftOf(KEY)?.body).toBe("Try me.");
    expect(link().classList.contains("ref-done")).toBe(false);
    expect(toasts[0].text).toBe("Not sent to Priya S.: the connector said: rate limited");
  });

  it("with mail send off, Send to … stays disabled and nothing is held or called", async () => {
    const l = deps();
    setup(l.d, false);
    await draft("Reply", "Off.");
    expect(btn("Send to Priya S.")?.disabled).toBe(true);
    await click(btn("Send to Priya S."));
    await key("Enter", { metaKey: true });
    await settle(HOLD + 100);
    expect(l.ran).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
