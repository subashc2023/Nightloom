// @vitest-environment happy-dom
/*
 * Item 993c: the typed link's card, mounted and driven through the real host and the real renderer (item 980's
 * rule: the rendered DOM, real clicks and keys). What is pinned:
 *  - a click on a link opens its card with that item's details; Esc, ✕, an outside press and a second click close it;
 *  - in this build (no `act`) every action is shown and disabled, marked "coming soon" — nothing can fire;
 *  - with `act`: nothing is sent on a first click; the confirm names what goes; only its named button sends, once;
 *  - a reply typed in the card survives Back, closing the card, and a remount from storage; Discard asks first;
 *  - a signed-out account disables the actions and says why.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import RefCardHost from "./RefCardHost.svelte";
import { renderReply } from "./markdown";
import { REF_DRAFTS_KEY, draftOf, readDrafts, refDrafts, resetDrafts } from "./refDrafts.svelte";
import { accountOf, agoWords, detailRows, eventWhen, openElsewhere, whenLine } from "./refCard";
import type { RefAction, RefReceipt } from "./refCard";
import { parseRef, type Ref } from "./refTag";
import type { HomeReach } from "./home";

const EVENT =
  '<event id="ev_123" src="Calendar 974e51a6" cal="primary" start="2026-11-25T12:00-08:00" end="2026-11-25T13:00-08:00" rsvp="needsAction" where="ISEB 1010" organizer="Prof. Lin" guests="14 · 9 yes, 1 no, 4 waiting" link="https://calendar.google.com/calendar/event?eid=abc">COAST Meeting</event>';
const EMAIL =
  '<email id="m_9" thread="t_9" src="Gmail 2117773e" from="Priya S." at="2026-11-25T11:42-08:00" count="3" gist="Hi! Just confirming Dr. Okafor for the Dec 4 slot." link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation for Dec 4</email>';
const DOC = '<doc id="f_7" src="Google Drive b7e1394d" type="doc" owner="Priya S." editor="Priya S." edited="2026-11-24T21:10-08:00" access="Edit" link="https://docs.google.com/document/d/f_7/edit">Run of show</doc>';
const MINE = '<event id="ev_me" src="Calendar 974e51a6" start="2026-11-27" rsvp="organizer">Office hours</event>';

const acct = (connector: string, over: Partial<HomeReach["accounts"][number]> = {}) => ({ connector, service: "Google Calendar", kind: "calendar" as const, address: "me@school.edu", nth: null, status: "connected" as const, on: true, claude_ai: true, in_scan: true, ...over });
const REACH: HomeReach = { checked_at: "2026-11-25T15:00:00Z", error: null, accounts: [acct("Calendar 974e51a6"), acct("Gmail 2117773e", { service: "Gmail", kind: "mail", address: "club@school.edu" })], locals: [] };

let host: ReturnType<typeof mount> | null = null;
let page: HTMLElement;
const sentActions: { ref: Ref; a: RefAction }[] = [];

function setup(opts: { act?: boolean | ((a: RefAction) => Promise<RefReceipt>); reach?: HomeReach } = {}) {
  page = document.createElement("div");
  page.innerHTML = `<div class="markdown">${renderReply(`You have ${EVENT} at 12 PM, ${MINE} and mail: ${EMAIL}. She linked ${DOC}.`)}</div><button id="elsewhere">x</button>`;
  document.body.appendChild(page);
  const act = opts.act
    ? async (ref: Ref, a: RefAction): Promise<RefReceipt> => {
        sentActions.push({ ref, a });
        if (typeof opts.act === "function") return opts.act(a);
        if (a.type === "rsvp") return { stamp: "Sent", text: "Accepted · COAST Meeting · Prof. Lin notified", rsvp: a.answer };
        if (a.type === "copyLink") return { stamp: "Copied", text: "docs.google.com/document/d/…" };
        if (a.type === "saveDraft") return { stamp: "Saved", text: "Draft saved in Gmail" };
        return { stamp: "Sent", text: "Reply to Priya S." };
      }
    : undefined;
  // The hold before a mail goes (993e) is its own test's (refAct993e); here the stand-in answers at once.
  host = mount(RefCardHost, { target: document.body, props: { reach: () => opts.reach ?? REACH, act, holdMs: 0 } });
  flushSync();
}
const link = (name: string) => [...page.querySelectorAll<HTMLElement>("a.nl-ref")].find((a) => a.textContent === name)!;
const card = () => document.querySelector<HTMLElement>(".ref-card");
const btn = (label: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label));
const click = async (el: Element | undefined | null) => {
  expect(el, "the thing to click exists").toBeTruthy();
  el!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  (el as HTMLElement).click();
  await settle();
};
const key = async (k: string, target: Element = card()!, init: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  await settle();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
async function settle(ms = 0) {
  await tick();
  flushSync();
  await new Promise((r) => setTimeout(r, ms));
  flushSync();
}
// A close plays the menu's out transition; the card leaves the DOM when it ends.
const closed = async () => {
  for (let i = 0; i < 40 && card(); i++) await settle(20);
  return card() === null;
};

beforeEach(() => {
  sentActions.length = 0;
  resetDrafts();
  document.documentElement.dataset.layout = "classic"; // no transition lengths: the DOM settles at once
});
afterEach(() => {
  if (host) void unmount(host);
  host = null;
  document.body.innerHTML = "";
});

describe("993c: opening and closing", () => {
  it("the host gives links their look only while it is mounted", () => {
    expect(document.documentElement.dataset.refCards).toBeUndefined();
    setup();
    expect(document.documentElement.dataset.refCards).toBe("1");
    void unmount(host!);
    host = null;
    expect(document.documentElement.dataset.refCards).toBeUndefined();
  });

  it("a click opens that item's card: kind, account, title, when, details, his answer", async () => {
    setup();
    await click(link("COAST Meeting"));
    const c = card()!;
    expect(c.dataset.refCard).toBe("event");
    expect(c.getAttribute("aria-label")).toBe("Event: COAST Meeting");
    expect(c.querySelector(".rc-head")?.textContent).toContain("Event");
    expect(c.querySelector(".rc-acct")?.textContent).toBe("me@school.edu");
    expect(c.querySelector(".rc-title")?.textContent).toBe("COAST Meeting");
    expect(c.querySelector(".rc-when")?.textContent).toBe("Wed, Nov 25 · 12:00 – 1:00 PM");
    expect([...c.querySelectorAll(".rc-kv dt")].map((d) => d.textContent)).toEqual(["Where", "Organizer", "Guests", "You"]);
    expect(c.querySelector(".rc-pill")?.textContent).toBe("Not answered");
    expect(link("COAST Meeting").classList.contains("ref-open")).toBe(true);
    expect(document.activeElement).toBe(c);
  });

  it("Esc, the ✕, an outside press and a second click on the link each close it; another link moves the card", async () => {
    setup();
    await click(link("COAST Meeting"));
    await key("Escape", document.body);
    expect(await closed()).toBe(true);
    expect(document.activeElement).toBe(link("COAST Meeting"));
    expect(link("COAST Meeting").classList.contains("ref-open")).toBe(false);

    await click(link("COAST Meeting"));
    await click(card()!.querySelector(".rc-x"));
    expect(await closed()).toBe(true);

    await click(link("COAST Meeting"));
    await click(page.querySelector("#elsewhere"));
    expect(await closed()).toBe(true);

    await click(link("COAST Meeting"));
    await click(link("COAST Meeting"));
    expect(await closed()).toBe(true);

    await click(link("COAST Meeting"));
    await click(link("Speaker confirmation for Dec 4"));
    await settle(60);
    const cards = [...document.querySelectorAll<HTMLElement>(".ref-card")].filter((x) => !x.inert);
    expect(cards.at(-1)?.dataset.refCard).toBe("email");
    expect(cards.at(-1)?.querySelector(".rc-snip")?.textContent).toContain("Dr. Okafor");
    expect(link("COAST Meeting").classList.contains("ref-open")).toBe(false);
  });

  it("Return on a focused link opens it; a link that does not check out opens nothing", async () => {
    setup();
    link("Run of show").focus();
    await key("Enter", link("Run of show"));
    expect(card()?.dataset.refCard).toBe("doc");
    expect(card()?.querySelector(".rc-when")?.textContent).toMatch(/^Google Doc · edited by Priya S\. /);
    await key("Escape");
    await closed();
    const fake = document.createElement("a");
    fake.className = "nl-ref";
    fake.textContent = "Fake";
    page.appendChild(fake);
    await click(fake);
    expect(card()).toBeNull();
  });
});

describe("993c: this build — actions shown, none wired", () => {
  it("every action of every kind is disabled and marked coming soon; keys and clicks fire nothing", async () => {
    setup();
    for (const [name, labels] of [
      ["COAST Meeting", ["Accept", "Maybe", "Decline", "Open in Calendar"]],
      ["Speaker confirmation for Dec 4", ["Reply", "Reply all", "Forward", "Open in Gmail"]],
      ["Run of show", ["Read it here", "Copy link", "Open in Docs"]],
    ] as const) {
      await click(link(name));
      await settle(40);
      const c = [...document.querySelectorAll<HTMLElement>(".ref-card")].at(-1)!;
      const buttons = [...c.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.classList.contains("rc-x"));
      expect(buttons.map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().replace(/^\d/, "").replace(/ (calendar|mail|docs)\.google\.com.*$/, "").replace(/ Coming soon.*$/, "")), name).toEqual([...labels]);
      expect(buttons.every((b) => b.disabled), name).toBe(true);
      expect(c.querySelectorAll(".rc-soon").length, name).toBe(2);
      for (const b of buttons) b.click();
      await key("1", c);
      await key("Enter", c);
      expect(c.dataset.view).toBe("details");
      await key("Escape");
      await closed();
    }
    expect(sentActions).toEqual([]);
  });

  it("an event he organizes has no RSVP row", async () => {
    setup();
    await click(link("Office hours"));
    expect(card()!.querySelector(".rc-acts")).toBeNull();
    expect(card()!.querySelector(".rc-pill")?.textContent).toBe("You organize this");
    expect(card()!.querySelector(".rc-when")?.textContent).toBe("Fri, Nov 27 · all day");
  });
});

describe("993c: with actions wired (993d's side, here a stand-in)", () => {
  it("an RSVP: nothing goes on the first click; the confirm names it; Send: Accept sends once; the receipt and ✓ follow", async () => {
    setup({ act: true });
    await click(link("COAST Meeting"));
    await click(btn("1Accept"));
    expect(sentActions).toEqual([]);
    const c = card()!;
    expect(c.dataset.view).toBe("confirm");
    expect(c.querySelector(".rc-cf.lk-shell .lk-br")).not.toBeNull();
    expect(c.querySelector(".rc-qt")?.textContent).toBe("Accept COAST Meeting? Prof. Lin and the guests see your answer.");
    await type(c.querySelector<HTMLInputElement>(".rc-field")!, "See you there");
    expect(btn("Send: Accept")).toBeTruthy();
    await click(btn("Send: Accept"));
    await settle(340);
    expect(sentActions.map((s) => s.a)).toEqual([{ type: "rsvp", answer: "accepted", note: "See you there" }]);
    expect(sentActions[0].ref.id).toBe("ev_123");
    expect(c.dataset.view).toBe("details");
    expect(c.querySelector(".rc-stamp")?.textContent).toBe("Sent");
    expect(c.querySelector(".rc-rt")?.textContent).toBe("Accepted · COAST Meeting · Prof. Lin notified");
    expect(c.querySelector(".rc-pill")?.textContent).toBe("Going");
    expect(link("COAST Meeting").classList.contains("ref-done")).toBe(true);
    // The note went with it: nothing left to offer back.
    expect(draftOf("event:Calendar 974e51a6:ev_123")).toBeNull();
  });

  it("the keys: 2 picks Maybe, Esc in the confirm goes back (not closed), Return sends", async () => {
    setup({ act: true });
    await click(link("COAST Meeting"));
    await key("2");
    expect(card()!.querySelector(".rc-qt")?.textContent).toContain("Answer maybe to COAST Meeting?");
    await key("Escape");
    expect(card()!.dataset.view).toBe("details");
    expect(sentActions).toEqual([]);
    await key("3");
    await key("Enter", card()!.querySelector(".rc-field")!);
    await settle(340);
    expect(sentActions.map((s) => s.a)).toEqual([{ type: "rsvp", answer: "declined", note: "" }]);
  });

  it("a reply: typed words survive Back, closing the card and a restart; Send names the recipient; Discard asks first", async () => {
    setup({ act: true });
    const K = "email:Gmail 2117773e:m_9";
    await click(link("Speaker confirmation for Dec 4"));
    await click(btn("Reply"));
    const body = () => card()!.querySelector<HTMLTextAreaElement>(".rc-body")!;
    expect(card()!.querySelector(".rc-q")?.textContent).toBe("Reply · nothing sent yet");
    expect(card()!.querySelector(".rc-to")?.textContent).toBe("To: Priya S.");
    expect(btn("Send to Priya S.")?.disabled).toBe(true);
    await type(body(), "Hi Priya — confirmed, thank you!");
    expect(btn("Send to Priya S.")?.disabled).toBe(false);
    // Return in the body is a new line, never a send.
    await key("Enter", body());
    expect(sentActions).toEqual([]);
    // Back: the details offer the draft back.
    await key("Escape");
    expect(card()!.querySelector(".rc-kept")?.textContent).toContain("Your reply is kept here, unsent.");
    // Close the card, open it again: still there. And in storage, as a restart reads it.
    await key("Escape");
    await closed();
    expect(readDrafts(localStorage.getItem(REF_DRAFTS_KEY))[K]).toEqual({ mode: "reply", body: "Hi Priya — confirmed, thank you!", to: "", note: "" });
    await click(link("Speaker confirmation for Dec 4"));
    await click(btn("Open draft"));
    expect(body().value).toBe("Hi Priya — confirmed, thank you!");
    // Discard asks; "Keep it" keeps.
    await click(btn("Discard"));
    expect(card()!.querySelector("[role=alertdialog]")?.textContent).toContain("Discard this draft?");
    expect(refDrafts.by[K]?.body).toBe("Hi Priya — confirmed, thank you!");
    await click(btn("Keep it"));
    expect(body().value).toBe("Hi Priya — confirmed, thank you!");
    // A failed send drops nothing.
    void unmount(host!);
    document.body.innerHTML = "";
    let fail = true;
    setup({ act: async () => (fail ? Promise.reject(new Error("Gmail did not answer")) : { stamp: "Sent", text: "Reply to Priya S. · Re: Speaker confirmation" }) });
    await click(link("Speaker confirmation for Dec 4"));
    await click(btn("Open draft"));
    await click(btn("Send to Priya S."));
    await settle(20);
    expect(card()!.querySelector("[role=alert]")?.textContent).toContain("Gmail did not answer");
    expect(body().value).toBe("Hi Priya — confirmed, thank you!");
    fail = false;
    await key("Enter", body(), { metaKey: true });
    await settle(340);
    expect(sentActions.at(-1)?.a).toEqual({ type: "send", mode: "reply", to: "Priya S.", body: "Hi Priya — confirmed, thank you!" });
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Sent");
    expect(draftOf(K)).toBeNull();
  });

  it("a forward cannot go without a recipient he typed; a confirmed Discard drops the draft", async () => {
    setup({ act: true });
    await click(link("Speaker confirmation for Dec 4"));
    await click(btn("Forward"));
    await type(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!, "FYI");
    expect(btn("Send to …")?.disabled).toBe(true);
    await type(card()!.querySelector<HTMLInputElement>(".rc-to input")!, "okafor@example.edu");
    expect(btn("Send to okafor@example.edu")?.disabled).toBe(false);
    await click(btn("Discard"));
    await click([...card()!.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((b) => b.textContent === "Discard"));
    expect(draftOf("email:Gmail 2117773e:m_9")).toBeNull();
    expect(card()!.dataset.view).toBe("details");
    expect(sentActions).toEqual([]);
  });

  it("a doc: Copy link stamps COPIED; nothing asks", async () => {
    setup({ act: true });
    await click(link("Run of show"));
    await click(btn("Copy link"));
    await settle(340);
    expect(sentActions.map((s) => s.a)).toEqual([{ type: "copyLink" }]);
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Copied");
    expect(link("Run of show").classList.contains("ref-done")).toBe(false);
  });

  it("a signed-out account: details stay, actions are off, the notice leads to Sources", async () => {
    setup({ act: true, reach: { ...REACH, accounts: [acct("Calendar 974e51a6", { status: "needs_sign_in" })] } });
    await click(link("COAST Meeting"));
    expect(card()!.querySelector(".rc-warn")?.textContent).toContain("me@school.edu is signed out");
    expect(btn("1Accept")?.disabled).toBe(true);
    expect(card()!.querySelector(".rc-title")?.textContent).toBe("COAST Meeting");
    await key("1");
    expect(card()!.dataset.view).toBe("details");
  });
});

describe("993c: the card's words", () => {
  const now = new Date(2026, 10, 25, 15, 4);
  it("times are 12-hour and read from the connector's own clock", () => {
    expect(eventWhen("2026-11-25T12:00-08:00", "2026-11-25T13:00-08:00", now)).toBe("Wed, Nov 25 · 12:00 – 1:00 PM");
    expect(eventWhen("2026-11-25T09:30-08:00", "2026-11-25T10:00-08:00", now)).toBe("Wed, Nov 25 · 9:30 – 10:00 AM");
    expect(eventWhen("2026-11-25T11:00-08:00", "2026-11-25T13:00-08:00", now)).toBe("Wed, Nov 25 · 11:00 AM – 1:00 PM");
    expect(eventWhen("2026-11-27", "2026-11-28", now)).toBe("Fri, Nov 27 · all day");
    expect(eventWhen("2026-11-27", "2026-11-30", now)).toBe("Fri, Nov 27 – Sun, Nov 29 · all day");
    expect(eventWhen("2027-01-04T08:00Z", undefined, now)).toBe("Mon, Jan 4, 2027 · 8:00 AM");
    expect(eventWhen("soon", undefined, now)).toBe("");
    expect(agoWords("2026-11-25T11:42-08:00", now)).toBe("today 11:42 AM");
    expect(agoWords("2026-11-24T21:10-08:00", now)).toBe("yesterday 9:10 PM");
    expect(agoWords("2026-11-20T00:05-08:00", now)).toBe("Fri, Nov 20 · 12:05 AM");
  });
  it("each kind's line, rows and foot row show only what the link carries", () => {
    expect(whenLine(parseRef(EMAIL)!, now)).toBe("Priya S. · today 11:42 AM · 3 in thread");
    expect(whenLine(parseRef(DOC)!, now)).toBe("Google Doc · edited by Priya S. yesterday 9:10 PM");
    expect(whenLine(parseRef('<doc id="1" src="s">Bare</doc>')!, now)).toBe("");
    expect(detailRows(parseRef(DOC)!)).toEqual([["Owner", "Priya S."], ["You can", "Edit"]]);
    expect(openElsewhere(parseRef(DOC)!)).toEqual({ label: "Open in Docs", host: "docs.google.com" });
    expect(openElsewhere(parseRef('<doc id="1" src="s" type="sheet">S</doc>')!)).toEqual({ label: "Open in Sheets", host: "" });
  });
  it("the account: its address when known, the tag's own source when Home never listed it", () => {
    expect(accountOf(REACH, "Gmail 2117773e")).toEqual({ label: "club@school.edu", state: "ok" });
    expect(accountOf(REACH, "Gmail other")).toEqual({ label: "Gmail other", state: "unknown" });
    expect(accountOf(null, "Calendar 1")).toEqual({ label: "Calendar 1", state: "unknown" });
    expect(accountOf({ accounts: [acct("C", { on: false })] }, "C").state).toBe("off");
  });
});
