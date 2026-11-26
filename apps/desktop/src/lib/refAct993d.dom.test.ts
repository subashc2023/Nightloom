// @vitest-environment happy-dom
/*
 * Item 993d: the card's actions, wired. `refAct.ts` (what a click does), and the card and its host with the real
 * rule behind them: nothing reaches a connector without his click on the confirm (blocker 2304); what comes back
 * is the connector's own answer — done, not there any more, or the reason; an answer he changed can be undone
 * for a few seconds (blocker 2305); opening and copying need no account.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import RefCardHost from "./RefCardHost.svelte";
import { renderReply } from "./markdown";
import { draftOf, resetDrafts } from "./refDrafts.svelte";
import { itemOf, makeRefAct, type RefActDeps } from "./refAct";
import type { RefAction } from "./refCard";
import type { RefActItem, RefActReceipt } from "./api";
import { parseRef } from "./refTag";
import type { HomeReach } from "./home";

const CAL = "claude.ai Google Calendar";
const GMAIL = "claude.ai Gmail 2117773e";
const EVENT = `<event id="ev_123" src="${CAL}" cal="primary" start="2026-11-25T12:00-08:00" end="2026-11-25T13:00-08:00" rsvp="needsAction" organizer="Prof. Lin" link="https://calendar.google.com/calendar/event?eid=abc">COAST Meeting</event>`;
const MAYBE = `<event id="ev_456" src="${CAL}" start="2026-11-26T13:00-08:00" rsvp="tentative">Board Sync</event>`;
const EMAIL = `<email id="m_9" thread="t_9" src="${GMAIL}" from="Priya S." at="2026-11-25T11:42-08:00" link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation</email>`;
const DOC = '<doc id="f_7" src="claude.ai Google Drive" type="doc" link="https://docs.google.com/document/d/f_7/edit">Run of show</doc>';
const NOLINK = '<doc id="f_8" src="claude.ai Google Drive" type="doc">No address</doc>';

const acct = (connector: string, over: Partial<HomeReach["accounts"][number]> = {}) => ({ connector, service: "Google Calendar", kind: "calendar" as const, address: "me@school.edu", nth: null, status: "connected" as const, on: true, claude_ai: true, in_scan: true, ...over });
const REACH: HomeReach = { checked_at: "2026-11-25T15:00:00Z", error: null, accounts: [acct(CAL), acct(GMAIL, { service: "Gmail", kind: "mail" }), acct("claude.ai Google Drive", { service: "Google Drive", kind: "files" })], locals: [] };

interface Log {
  opened: string[];
  tabs: string[];
  copied: string[];
  ran: { item: RefActItem; act: RefAction }[];
}
function deps(answer: (act: RefAction) => RefActReceipt | Promise<RefActReceipt> = () => ({ outcome: "done", text: "Accepted" })): { d: RefActDeps; log: Log } {
  const log: Log = { opened: [], tabs: [], copied: [], ran: [] };
  const d: RefActDeps = {
    openUrl: async (u) => void log.opened.push(u),
    openTab: async (u) => void log.tabs.push(u),
    copy: async (t) => void log.copied.push(t),
    run: async (item, act) => {
      log.ran.push({ item, act });
      return answer(act);
    },
    agent: () => ({ binary: "claude-x", safeMode: true }),
  };
  return { d, log };
}
const ref = (tag: string) => parseRef(tag)!;

describe("993d: what a click does (refAct)", () => {
  it("open, read here and copy use the link and never reach a connector", async () => {
    const { d, log } = deps();
    const act = makeRefAct(d);
    expect(await act(ref(DOC), { type: "open" })).toEqual({ stamp: "Opened", text: "in your browser" });
    expect(await act(ref(DOC), { type: "readHere" })).toEqual({ stamp: "Opened", text: "in a tab here" });
    expect((await act(ref(DOC), { type: "copyLink" })).stamp).toBe("Copied");
    expect(log.opened).toEqual(["https://docs.google.com/document/d/f_7/edit"]);
    expect(log.tabs).toEqual(["https://docs.google.com/document/d/f_7/edit"]);
    expect(log.copied).toEqual(["https://docs.google.com/document/d/f_7/edit"]);
    expect(log.ran).toEqual([]);
    await expect(act(ref(NOLINK), { type: "open" })).rejects.toThrow("without its address");
  });

  it("an answer is one call for exactly that item, and the receipt is the connector's", async () => {
    const { d, log } = deps();
    const r = await makeRefAct(d)(ref(EVENT), { type: "rsvp", answer: "accepted", note: "See you" });
    expect(log.ran).toEqual([{ item: { kind: "event", id: "ev_123", src: CAL, cal: "primary", name: "COAST Meeting" }, act: { type: "rsvp", answer: "accepted", note: "See you" } }]);
    expect(r).toEqual({ stamp: "Sent", text: "Accepted · COAST Meeting", rsvp: "accepted" });
    expect(itemOf(ref(EMAIL))).toEqual({ kind: "email", id: "m_9", src: GMAIL, cal: undefined, name: "Speaker confirmation" });
  });

  it("not there any more is a receipt that says so; an error is thrown with the reason", async () => {
    const gone = makeRefAct(deps(() => ({ outcome: "not_found", text: "It is not there any more." })).d);
    expect(await gone(ref(EVENT), { type: "rsvp", answer: "declined", note: "" })).toEqual({ stamp: "Gone", text: "It is not there any more.", gone: true });
    const bad = makeRefAct(deps(() => ({ outcome: "error", text: "the connector said: rate limited" })).d);
    await expect(bad(ref(EVENT), { type: "rsvp", answer: "declined", note: "" })).rejects.toThrow("rate limited");
  });
});

// ---- The card and its host over the real rule ----

let host: ReturnType<typeof mount> | null = null;
let page: HTMLElement;
let toasts: { text: string; action?: { label: string; run: () => void } }[] = [];

function setup(log: { d: RefActDeps }, opts: { reach?: HomeReach; mailSend?: boolean } = {}) {
  page = document.createElement("div");
  page.innerHTML = `<div class="markdown">${renderReply(`Today: ${EVENT}, ${MAYBE}; mail ${EMAIL}; ${DOC}. Again: ${EVENT}`)}</div>`;
  document.body.appendChild(page);
  host = mount(RefCardHost, { target: document.body, props: { reach: () => opts.reach ?? REACH, act: makeRefAct(log.d), mailSend: opts.mailSend ?? false, toast: (text: string, action?: { label: string; run: () => void }) => void toasts.push({ text, action }) } });
  flushSync();
}
const links = (name: string) => [...page.querySelectorAll<HTMLElement>("a.nl-ref")].filter((a) => a.textContent === name);
const link = (name: string) => links(name)[0];
const card = () => document.querySelector<HTMLElement>(".ref-card");
const btn = (label: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label));
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
const key = async (k: string) => {
  card()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

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

describe("993d: nothing reaches a connector without his click on the confirm (blocker 2304)", () => {
  it("drawing the reply, opening every card, picking an answer and backing out call nothing", async () => {
    const l = deps();
    setup(l);
    for (const name of ["COAST Meeting", "Board Sync", "Speaker confirmation", "Run of show"]) {
      await click(link(name));
      expect(card(), name).not.toBeNull();
    }
    await click(link("COAST Meeting"));
    await key("1");
    expect(card()!.dataset.view).toBe("confirm");
    await type(card()!.querySelector<HTMLInputElement>(".rc-field")!, "See you");
    await key("Escape");
    expect(card()!.dataset.view).toBe("details");
    await click(link("Speaker confirmation"));
    await click(btn("Reply"));
    await type(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!, "Thanks!");
    await click(btn("Back"));
    expect(l.log).toEqual({ opened: [], tabs: [], copied: [], ran: [] });
  });

  it("an answer goes once, on Send: Accept, and the receipt, the pill and every link of the item show it", async () => {
    const l = deps();
    setup(l);
    await click(link("COAST Meeting"));
    await click(btn("1Accept"));
    expect(l.log.ran).toEqual([]);
    await click(btn("Send: Accept"));
    await settle(340);
    expect(l.log.ran.map((x) => x.act)).toEqual([{ type: "rsvp", answer: "accepted", note: "" }]);
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Sent");
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Accepted · COAST Meeting");
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("Going");
    // A first answer cannot be un-answered: no Undo is offered.
    expect(toasts).toEqual([]);
    // Opened again, from the item's other link: the card still says Going.
    await click(links("COAST Meeting")[1]);
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("Going");
  });
});

describe("993d: what came back", () => {
  it("a changed answer offers Undo for a few seconds; Undo puts the old answer back by one more call", async () => {
    const l = deps((a) => ({ outcome: "done", text: a.type === "rsvp" ? a.answer : "" }));
    setup(l);
    await click(link("Board Sync"));
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("Maybe");
    await click(btn("1Accept"));
    await click(btn("Send: Accept"));
    await settle(340);
    expect(toasts.map((t) => [t.text, t.action?.label])).toEqual([["Accepted · Board Sync", "Undo"]]);
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("Going");
    toasts[0].action!.run();
    await settle(10);
    expect(l.log.ran.map((x) => x.act)).toEqual([
      { type: "rsvp", answer: "accepted", note: "" },
      { type: "rsvp", answer: "tentative", note: "" },
    ]);
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("Maybe");
    expect(toasts[1].text).toBe("Put back: Answered maybe · Board Sync");
  });

  it("not there any more: the card says so, the item's links dim, nothing more can be sent, his note stays", async () => {
    const l = deps(() => ({ outcome: "not_found", text: "It is not there any more (deleted or cancelled). Nothing was sent." }));
    setup(l);
    await click(link("COAST Meeting"));
    await click(btn("3Decline"));
    await type(card()!.querySelector<HTMLInputElement>(".rc-field")!, "Sorry");
    await click(btn("Send: Decline"));
    await settle(340);
    expect(card()!.querySelector(".rc-gone")?.textContent).toContain("not there any more");
    expect(card()!.querySelector(".rc-stamp")).toBeNull();
    expect(links("COAST Meeting").map((a) => a.classList.contains("ref-gone"))).toEqual([true, true]);
    expect(links("COAST Meeting").some((a) => a.classList.contains("ref-done"))).toBe(false);
    expect(btn("1Accept")?.disabled).toBe(true);
    expect(draftOf(`event:${CAL}:ev_123`)?.note).toBe("Sorry");
    expect(link("Board Sync").classList.contains("ref-gone")).toBe(false);
  });

  it("an error: the confirm stays with the reason and his words", async () => {
    const l = deps(() => ({ outcome: "error", text: "the connector said: rate limited" }));
    setup(l);
    await click(link("COAST Meeting"));
    await click(btn("1Accept"));
    await type(card()!.querySelector<HTMLInputElement>(".rc-field")!, "See you");
    await click(btn("Send: Accept"));
    await settle(340);
    expect(card()!.dataset.view).toBe("confirm");
    expect(card()!.querySelector(".rc-warn")?.textContent).toContain("rate limited");
    expect(card()!.querySelector<HTMLInputElement>(".rc-field")!.value).toBe("See you");
    expect(link("COAST Meeting").classList.contains("ref-done")).toBe(false);
  });

  it("a reply: Save as Gmail draft saves exactly the words; Send is off until mail send is built", async () => {
    const l = deps(() => ({ outcome: "done", text: "Draft saved in Gmail" }));
    setup(l);
    await click(link("Speaker confirmation"));
    await click(btn("Reply"));
    await type(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!, "Thanks —\nsee you there.");
    expect(btn("Send to Priya S.")?.disabled).toBe(true);
    await click(btn("Send to Priya S."));
    await key("Enter");
    expect(l.log.ran).toEqual([]);
    await click(btn("Save as Gmail draft"));
    await settle(340);
    expect(l.log.ran.map((x) => x.act)).toEqual([{ type: "saveDraft", mode: "reply", to: "Priya S.", body: "Thanks —\nsee you there." }]);
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Saved");
    expect(draftOf(`email:${GMAIL}:m_9`)).toBeNull();
    // A draft is not a send: the link gets no ✓.
    expect(link("Speaker confirmation").classList.contains("ref-done")).toBe(false);
  });

  it("a signed-out account: nothing can be sent, and its page still opens", async () => {
    const l = deps();
    setup(l, { reach: { ...REACH, accounts: [acct(CAL, { status: "needs_sign_in" })] } });
    await click(link("COAST Meeting"));
    expect(btn("1Accept")?.disabled).toBe(true);
    await click(btn("Open in Calendar"));
    await settle(340);
    expect(l.log.opened).toEqual(["https://calendar.google.com/calendar/event?eid=abc"]);
    expect(l.log.ran).toEqual([]);
  });
});
