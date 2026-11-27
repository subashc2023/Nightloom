// @vitest-environment happy-dom
/*
 * Item 993e: Reply / Reply all / Forward sent from the card — only from his click on "Send to …" with the whole
 * draft on screen (blocker 2304), and the hold before it goes is its Undo (blocker 2305): the one command that
 * sends is called only when the countdown ends; Undo in it (the card's button, the toast's, Esc) calls nothing.
 * The card and host render for real over `refAct.ts`'s rule; only the command is a stub that records its calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
// The app's store, as the toasts read it: only its toast list. The whole store's module graph starts the app's own
// effects (asides), which have no app to run in here; the toasts' functions, refHoldToast and ToastX are the real ones.
vi.mock("./state.svelte", () => ({ app: { toasts: [] } }));
import { app } from "./state.svelte";
import RefCardHost from "./RefCardHost.svelte";
import { renderReply } from "./markdown";
import { REF_DRAFTS_KEY, REF_MAYBE_KEY, draftOf, readDrafts, readMaybe, refDrafts, refMaybe, resetDrafts } from "./refDrafts.svelte";
import ToastX from "./ToastX.svelte";
import { refHoldToast } from "./refHoldToast";
import appSrc from "../App.svelte?raw";
import { makeRefAct, type RefActDeps } from "./refAct";
import type { RefAction } from "./refCard";
import type { RefActItem, RefActReceipt, RefUnfinished } from "./api";
import type { HomeReach } from "./home";
import { MailUndone, isUndone, makeHoldToast, secondsLeft, startHold, type HoldToast } from "./mailHold";
import type { MailHeads } from "./refCard";
import { mailRecipients, sendToWords } from "./refCard";
import { refRuns } from "./refRuns.svelte";

const GMAIL = "claude.ai Gmail 2117773e";
const EMAIL = `<email id="m_9" thread="t_9" src="${GMAIL}" from="Priya S." at="2026-11-25T11:42-08:00" link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation</email>`;
const KEY = `email:${GMAIL}:m_9`;
const DOC = '<doc id="f_7" src="claude.ai Google Drive" type="doc" link="https://docs.google.com/document/d/f_7/edit">Run of show</doc>';
/** The message's real headers, as the read-only read returns them (mocked; never a live read). */
const HEADS: MailHeads = { from: "priya@example.com", from_name: "Priya S.", to: ["me@school.edu"], cc: ["lin@example.edu"], subject: "Re: Speaker confirmation", names: { "lin@example.edu": "Prof. Lin" } };
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
let reads = 0;
let plain: string[] = [];
function setup(d: RefActDeps, mailSend = true, o: { heads?: () => Promise<MailHeads>; noRead?: boolean; unfinished?: () => Promise<RefUnfinished[]> } = {}) {
  page = document.createElement("div");
  page.innerHTML = `<div class="markdown">${renderReply(`Mail: ${EMAIL}. Doc: ${DOC}.`)}</div>`;
  document.body.appendChild(page);
  const readMail = o.noRead ? undefined : () => (reads++, (o.heads ?? (async () => HEADS))());
  host = mount(RefCardHost, { target: document.body, props: { reach: () => REACH, act: makeRefAct(d), mailSend, holdToast, holdMs: HOLD, readMail, unfinished: o.unfinished, toast: (t: string) => void plain.push(t) } });
  flushSync();
}
const link = () => page.querySelector<HTMLElement>("a.nl-ref")!;
const docLink = () => [...page.querySelectorAll<HTMLElement>("a.nl-ref")].find((a) => a.textContent === "Run of show")!;
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
  reads = 0;
  plain = [];
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
    expect(holdRow()?.textContent).toContain("Sending to Priya S. <priya@example.com> in");
    expect(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!.disabled).toBe(true);
    expect(toasts.length).toBe(1);
    expect(toasts[0].text).toMatch(/^Sending to Priya S\. <priya@example\.com> in \d s$/);
    expect(toasts[0].undo).toBeTypeOf("function");
    // A second click in the hold sends nothing more.
    await click(btn("Send to Priya S."));
    await key("Enter", { metaKey: true });
    expect(l.ran).toEqual([]);
    await settle(HOLD + 400);
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "reply", to: "Priya S. <priya@example.com>", body: "Thanks —\nsee you there.", recipients: { to: ["priya@example.com"], cc: [] }, about: "Re: Speaker confirmation" }]);
    expect(l.ran[0].item).toEqual({ kind: "email", id: "m_9", src: GMAIL, cal: undefined, name: "Speaker confirmation" });
    // The receipt says who it went to; the draft is gone; the link gets its ✓.
    expect(card()!.querySelector(".rc-stamp")?.textContent).toBe("Sent");
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Sent to Priya S. · Re: Speaker confirmation");
    expect(draftOf(KEY)).toBeNull();
    expect(link().classList.contains("ref-done")).toBe(true);
    expect(toasts[0].settled).toEqual(["Sending to Priya S. <priya@example.com>…", "Sent to Priya S. · Re: Speaker confirmation"]);
    expect(toasts[0].undo).toBeUndefined();
  });

  it("Undo on the card during the hold: no send command is issued, and the draft stays", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply all", "Yes, works for me.");
    await click(btn("Send to Priya S. <priya@example.com> and 1 more"));
    await click(holdRow()!.querySelector("button"));
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    expect(holdRow()).toBeNull();
    expect(card()!.querySelector(".rc-undone")?.textContent).toContain("Not sent");
    expect(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!.value).toBe("Yes, works for me.");
    expect(draftOf(KEY)?.body).toBe("Yes, works for me.");
    expect(toasts[0].settled).toEqual(["Not sent to Priya S. <priya@example.com> and 1 more: undone. Your words are kept in the card."]);
    // He can send it after all: a fresh hold, then the one call.
    await click(btn("Send to Priya S. <priya@example.com> and 1 more"));
    await settle(HOLD + 400);
    // Every real recipient, his own address left out.
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "replyAll", to: "Priya S. <priya@example.com> and 1 more", body: "Yes, works for me.", recipients: { to: ["priya@example.com"], cc: ["lin@example.edu"] }, about: "Re: Speaker confirmation" }]);
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
    expect(holdRow()?.textContent).toContain("Sending to Priya S. <priya@example.com> in");
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
    expect(toasts[0].text).toBe("Sent to Priya S. · Re: Speaker confirmation");
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
    expect(l.ran.map((x) => x.act)).toEqual([{ type: "send", mode: "forward", to: "sam@example.com", body: "FYI", about: "Re: Speaker confirmation" }]);
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Forwarded to sam@example.com · Re: Speaker confirmation");
    expect(card()?.querySelector("[data-real-fwd]")).toBeNull();
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
    expect(toasts[0].text).toBe("Not sent to Priya S. <priya@example.com>: the connector said: rate limited");
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

describe("993e review fixes", () => {
  it("1+2: the card shows and sends to the message's real sender when the tag's from disagrees", async () => {
    const l = deps(() => ({ outcome: "done", text: "Sent to client@corp.example" }));
    setup(l.d, true, { heads: async () => ({ from: "client@corp.example", from_name: "Client Co", to: ["me@school.edu"], cc: [], subject: "Contract", names: {} }) });
    await draft("Reply", "Hi.");
    // The tag said Priya S.; the message is from Client Co.
    expect(card()!.querySelector("[data-real-to]")?.textContent).toBe("To: Client Co <client@corp.example>");
    expect(card()!.querySelector(".rc-draft")!.textContent).not.toContain("Priya");
    expect(btn("Send to Client Co")?.disabled).toBe(false);
    await click(btn("Send to Client Co"));
    await settle(HOLD + 400);
    expect(l.ran[0].act).toMatchObject({ type: "send", mode: "reply", recipients: { to: ["client@corp.example"], cc: [] }, about: "Contract" });
    expect(card()!.querySelector(".rc-rt")?.textContent).toBe("Sent to client@corp.example · Contract");
    expect(reads).toBe(1);
  });

  it("1: Reply all shows every real recipient (To and Cc), never his own address", async () => {
    setup(deps().d);
    await draft("Reply all", "All.");
    expect(card()!.querySelector("[data-real-to]")?.textContent).toBe("To: Priya S. <priya@example.com>");
    expect(card()!.querySelector("[data-real-cc]")?.textContent).toBe("Cc: Prof. Lin <lin@example.edu>");
    expect(card()!.querySelector(".rc-draft")!.textContent).not.toContain("me@school.edu");
    const h: MailHeads = { from: "a@x.io", to: ["me@school.edu", "b@x.io", "A@X.io"], cc: ["c@x.io", "b@x.io", "ME@school.edu"], names: {} };
    expect(mailRecipients(h, "replyAll", "me@school.edu")).toEqual({ to: ["a@x.io", "b@x.io"], cc: ["c@x.io"] });
    expect(mailRecipients(h, "reply", "me@school.edu")).toEqual({ to: ["a@x.io"], cc: [] });
    // His own message: a reply goes to its first recipient, not to himself.
    expect(mailRecipients({ ...h, from: "me@school.edu" }, "reply", "me@school.edu")).toEqual({ to: ["b@x.io"], cc: [] });
    expect(sendToWords(h, { to: ["a@x.io", "b@x.io"], cc: ["c@x.io"] })).toBe("a@x.io and 2 more");
  });

  it("1: until the read is back, or when it fails, or with no read at all, Send stays off with the reason", async () => {
    let fail: (e: Error) => void = () => {};
    const l = deps();
    setup(l.d, true, { heads: () => new Promise<MailHeads>((_, no) => (fail = no)) });
    await draft("Reply", "Waiting.");
    expect(card()!.textContent).toContain("To: reading who this goes to…");
    expect(btn("Send to")?.disabled).toBe(true);
    fail(new Error("the connector said: 401"));
    await settle(10);
    expect(card()!.querySelector(".rc-bad")?.textContent).toContain("could not be read from the message — the connector said: 401");
    expect(btn("Send to")?.disabled).toBe(true);
    await click(btn("Send to"));
    await key("Enter", { metaKey: true });
    await settle(HOLD + 100);
    expect(l.ran).toEqual([]);
    expect(toasts).toEqual([]);
    void unmount(host!);
    document.body.innerHTML = "";
    setup(l.d, true, { noRead: true });
    await draft("Reply", "No read.");
    expect(btn("Send to")?.disabled).toBe(true);
    await click(btn("Send to"));
    await settle(HOLD + 100);
    expect(l.ran).toEqual([]);
  });

  it("4: a mail that may have gone keeps Send off until he says he checked Sent", async () => {
    let outcome: RefActReceipt = { outcome: "unknown", text: "It may have gone. Check Sent in Gmail before sending again. (the call started and nothing came back)" };
    const l = deps(() => outcome);
    setup(l.d);
    await draft("Reply", "Maybe.");
    await click(btn("Send to Priya S."));
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(1);
    expect(card()!.querySelector(".rc-maybe")?.textContent).toContain("It may have gone. Check Sent in Gmail");
    expect(card()!.textContent).not.toContain("Not sent");
    expect(toasts[0].text).toMatch(/^To Priya S\. <priya@example\.com>: It may have gone/);
    expect(btn("Send to Priya S.")?.disabled).toBe(true);
    await click(btn("Send to Priya S."));
    await settle(HOLD + 200);
    expect(l.ran.length).toBe(1);
    // Closed and reopened: still held.
    await click(card()!.querySelector(".rc-x"));
    await click(link());
    expect(card()!.querySelector(".rc-maybe")).not.toBeNull();
    // His explicit step: then a fresh send is possible.
    await click(btn("I checked: not sent"));
    expect(card()!.querySelector(".rc-maybe")).toBeNull();
    outcome = { outcome: "done", text: "Sent to priya@example.com" };
    await click(btn("Open draft"));
    await click(btn("Send to Priya S."));
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(2);
  });

  it("5: a mail finishing after its card closed marks its own link, not the card open now", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Mine.");
    await click(btn("Send to Priya S."));
    await click(card()!.querySelector(".rc-x"));
    await click(docLink());
    expect(card()?.dataset.refCard).toBe("doc");
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(1);
    expect(link().classList.contains("ref-done")).toBe(true);
    expect(docLink().classList.contains("ref-done")).toBe(false);
  });

  it("7: the call after the hold is listed as running work (the quit guard asks); a quit's leftovers are told at launch", async () => {
    let finish: () => void = () => {};
    const l = deps(() => new Promise<RefActReceipt>((ok) => (finish = () => ok({ outcome: "done", text: "Sent to priya@example.com" }))));
    setup(l.d, true, { unfinished: async () => [{ key: "email:other:m_1", what: "a reply to sam@example.com", item: "Budget", mail: true }] });
    await settle(5);
    expect(plain).toEqual(["Nightloom quit while a reply to sam@example.com was going (Budget). It may have gone: check Sent in Gmail before sending again."]);
    await draft("Reply", "Going.");
    await click(btn("Send to Priya S."));
    // In the hold nothing runs yet.
    expect(Object.values(refRuns)).toEqual([]);
    await settle(HOLD + 100);
    expect(Object.values(refRuns).map((r) => r.doing)).toEqual(["Sending mail to Priya S. <priya@example.com>"]);
    finish();
    await settle(400);
    expect(Object.values(refRuns)).toEqual([]);
  });

  it("3: the hold toast's X is its Undo while the hold runs (blocker 2355)", () => {
    const rows: { id: number; text: string; since?: number; xUndoes?: boolean; action?: { run: () => void } }[] = [];
    const ht = makeHoldToast({
      progress: (text, action) => (rows.push({ id: rows.length + 1, text, since: 1, action }), rows.length),
      find: (id) => rows[id - 1],
      update: () => {},
      settle: (id, text) => void (rows[id - 1] = { id, text }),
    });
    let undone = 0;
    const id = ht.start("Sending to Priya S. in 5 s", () => void undone++);
    expect(rows[0].xUndoes).toBe(true);
    expect(rows[0].since).toBeUndefined();
    // App.svelte's X runs the action when xUndoes is set (runToastAction).
    rows[0].action!.run();
    expect(undone).toBe(1);
    ht.settle(id, "Sent to priya@example.com");
    expect(rows[0].xUndoes).toBeUndefined();
  });
});

describe("993e re-review fixes", () => {
  it("N3: the Send button and the hold toast name the address beside the display name", async () => {
    const l = deps();
    setup(l.d);
    await draft("Reply", "Hi.");
    expect(btn("Send to")?.textContent).toContain("Send to Priya S. <priya@example.com>");
    await click(btn("Send to"));
    expect(toasts[0].text).toMatch(/^Sending to Priya S\. <priya@example\.com> in \d s$/);
    await settle(HOLD + 300);
    expect(l.ran.length).toBe(1);
    // Reply all: the first person with their address, then how many more.
    expect(sendToWords(HEADS, mailRecipients(HEADS, "replyAll", "me@school.edu"))).toBe("Priya S. <priya@example.com> and 1 more");
    // A name made to look like someone else's address still shows the real one beside it.
    const fake: MailHeads = { ...HEADS, from: "eve@evil.io", from_name: "boss@corp.com", names: {} };
    expect(sendToWords(fake, mailRecipients(fake, "reply", "me@school.edu"))).toBe("boss@corp.com <eve@evil.io>");
  });

  it("N2: a mail that may have gone keeps Send locked with the warning across a reload or restart, until he checked", async () => {
    const l = deps(() => ({ outcome: "unknown", text: "It may have gone. Check Sent in Gmail before sending again. (nothing came back)" }));
    setup(l.d);
    await draft("Reply", "Maybe twice?");
    await click(btn("Send to"));
    await settle(HOLD + 400);
    expect(l.ran.length).toBe(1);
    // Kept beside the draft, in storage.
    expect(readMaybe(localStorage.getItem(REF_MAYBE_KEY))[KEY]).toContain("It may have gone");
    expect(readDrafts(localStorage.getItem(REF_DRAFTS_KEY))[KEY]?.body).toBe("Maybe twice?");
    // A restart: the window is gone, and what comes back is only what storage held.
    void unmount(host!);
    host = null;
    document.body.innerHTML = "";
    refMaybe.by = {};
    refDrafts.by = {};
    refMaybe.by = readMaybe(localStorage.getItem(REF_MAYBE_KEY));
    refDrafts.by = readDrafts(localStorage.getItem(REF_DRAFTS_KEY));
    setup(l.d);
    await click(link());
    expect(card()!.querySelector(".rc-maybe")?.textContent).toContain("It may have gone");
    await click(btn("Open draft"));
    await settle(5);
    expect(btn("Send to")?.disabled).toBe(true);
    await click(btn("Send to"));
    await settle(HOLD + 200);
    expect(l.ran.length).toBe(1);
    // Only his "I checked: not sent" unlocks it, and that is kept too.
    await click(btn("I checked: not sent"));
    expect(card()!.querySelector(".rc-maybe")).toBeNull();
    expect(readMaybe(localStorage.getItem(REF_MAYBE_KEY))[KEY]).toBeUndefined();
    expect(btn("Send to")?.disabled).toBe(false);
  });

  it("T1: App.svelte's real X on the hold toast is the Undo — no send; after the hold it is a plain close", async () => {
    // App.svelte draws every toast's X as ToastX.
    expect(appSrc).toMatch(/\{#each app\.toasts as t \(t\.id\)\}[\s\S]*?<ToastX \{t\} \/>[\s\S]*?\{\/each\}/);
    app.toasts.splice(0);
    const l = deps(() => ({ outcome: "done", text: "Sent to priya@example.com" }));
    page = document.createElement("div");
    page.innerHTML = `<div class="markdown">${renderReply(`Mail: ${EMAIL}.`)}</div>`;
    document.body.appendChild(page);
    host = mount(RefCardHost, { target: document.body, props: { reach: () => REACH, act: makeRefAct(l.d), holdToast: refHoldToast, holdMs: HOLD, readMail: async () => HEADS } });
    flushSync();
    await draft("Reply", "Hold on.");
    await click(btn("Send to"));
    const row = app.toasts.find((t) => t.text.startsWith("Sending to"))!;
    expect(row.xUndoes).toBe(true);
    const xs = document.createElement("div");
    document.body.appendChild(xs);
    const x = mount(ToastX, { target: xs, props: { t: row } });
    flushSync();
    const xb = xs.querySelector<HTMLButtonElement>("button.toast-x")!;
    expect(xb.getAttribute("aria-label")).toBe("Undo: nothing is sent");
    await click(xb);
    await settle(HOLD + 300);
    expect(l.ran).toEqual([]);
    expect(app.toasts.some((t) => t.text.startsWith("Not sent to") && t.text.includes("undone"))).toBe(true);
    void unmount(x);
    xs.innerHTML = "";

    // A press on the toast is outside the card, so the card closed (as in the app); his words are kept.
    expect(draftOf(KEY)?.body).toBe("Hold on.");
    // Sent this time: once the hold is over, the X only closes the toast; it runs nothing.
    await click(link());
    if (!btn("Send to")) await click(btn("Open draft"));
    await click(btn("Send to"));
    await settle(HOLD + 300);
    expect(l.ran.length).toBe(1);
    const done = app.toasts.find((t) => t.text.startsWith("Sent to priya@example.com"))!;
    expect(done.xUndoes).toBeFalsy();
    const x2 = mount(ToastX, { target: xs, props: { t: done } });
    flushSync();
    const xb2 = xs.querySelector<HTMLButtonElement>("button.toast-x")!;
    expect(xb2.getAttribute("aria-label")).toBe("Dismiss");
    await click(xb2);
    expect(app.toasts.includes(done)).toBe(false);
    await settle(HOLD + 200);
    expect(l.ran.length).toBe(1);
    void unmount(x2);
    app.toasts.splice(0);
  });

  it("verify: a journal entry left from an earlier run locks that item's Send until he checked; an RSVP's does not", async () => {
    // The draft he had typed, kept from before the quit.
    refDrafts.by[KEY] = { mode: "reply", body: "Typed before the quit.", to: "", note: "" };
    const l = deps();
    setup(l.d, true, {
      unfinished: async () => [
        { key: KEY, what: "a reply to priya@example.com", item: "Speaker confirmation", mail: true },
        { key: "event:claude.ai Google Calendar:e_1", what: "your answer to the invitation", item: "Standup", mail: false },
      ],
    });
    await settle(5);
    expect(plain).toEqual([
      "Nightloom quit while a reply to priya@example.com was going (Speaker confirmation). It may have gone: check Sent in Gmail before sending again.",
      "Nightloom quit while your answer to the invitation was going (Standup). It may have gone through: open the event to check.",
    ]);
    expect(plain.join(" ")).not.toMatch(/Sent to|a mail was going/);
    // Kept, so a second restart still holds it; the RSVP's item is not locked.
    expect(readMaybe(localStorage.getItem(REF_MAYBE_KEY))[KEY]).toContain("Nightloom quit while a reply");
    expect(refMaybe.by["event:claude.ai Google Calendar:e_1"]).toBeUndefined();
    await click(link());
    expect(card()!.querySelector(".rc-maybe")?.textContent).toContain("It may have gone");
    await click(btn("Open draft"));
    await settle(5);
    expect(card()!.querySelector<HTMLTextAreaElement>(".rc-body")!.value).toBe("Typed before the quit.");
    expect(btn("Send to")?.disabled).toBe(true);
    await click(btn("Send to"));
    await settle(HOLD + 200);
    expect(l.ran).toEqual([]);
    await click(btn("I checked: not sent"));
    expect(btn("Send to")?.disabled).toBe(false);
  });
});
