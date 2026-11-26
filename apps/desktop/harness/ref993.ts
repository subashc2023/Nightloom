// Item 993c — see ref993.html. The real host and card over a reply drawn by the real renderer; each `at` is reached
// by real clicks, then held still. The stand-in `act` answers as 993d's will; with soon=1 there is none (this build).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { mount, flushSync } from "svelte";
import RefCardHost from "../src/lib/RefCardHost.svelte";
import { applyLayout, layout } from "../src/lib/layout.svelte";
import { renderReply } from "../src/lib/markdown";
import { keepDraft, resetDrafts } from "../src/lib/refDrafts.svelte";
import type { RefAction, RefReceipt } from "../src/lib/refCard";
import type { Ref } from "../src/lib/refTag";
import type { HomeReach } from "../src/lib/home";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.hash.slice(1));
const kind = q.get("kind") ?? "event";
const at = q.get("at") ?? "open";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REPLIES: Record<string, string> = {
  event:
    'You haven\'t responded yet to <event id="ev_123" src="Calendar 974e51a6" cal="primary" start="2026-11-25T12:00-08:00" end="2026-11-25T13:00-08:00" rsvp="needsAction" where="ISEB 1010 · Zoom link" organizer="Prof. Lin" guests="14 · 9 yes, 1 no, 4 waiting" link="https://calendar.google.com/calendar/event?eid=abc">COAST Meeting</event> at 12 PM or <event id="ev_124" src="Calendar 974e51a6" start="2026-11-25T13:00-08:00" rsvp="needsAction">AISCI Board Sync</event> at 1 PM.',
  email:
    '**Club mail:** <email id="m_9" thread="t_9" src="Gmail 2117773e" from="Priya S." at="2026-11-25T11:42-08:00" count="3" gist="Hi! Just confirming Dr. Okafor for the Dec 4 slot. Could you send the room and AV details by Friday so I can forward them to her office?" link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation for Dec 4</email> from Priya is waiting on you.',
  doc: 'She linked <doc id="f_7" src="Google Drive b7e1394d" type="doc" owner="Priya S." editor="Priya S." edited="2026-11-24T21:10-08:00" access="Edit" shared="Club board (6 people)" link="https://docs.google.com/document/d/f_7/edit">Fall Speaker Series — run of show</doc>.',
};
const acct = (connector: string, service: string, k: "calendar" | "mail" | "files", address: string) => ({ connector, service, kind: k, address, nth: null, status: (q.get("out") === "1" ? "needs_sign_in" : "connected") as "needs_sign_in" | "connected", on: true, claude_ai: true, in_scan: true });
const REACH: HomeReach = {
  checked_at: "2026-11-25T23:04:00Z",
  error: null,
  accounts: [acct("Calendar 974e51a6", "Google Calendar", "calendar", "School calendar"), acct("Gmail 2117773e", "Gmail", "mail", "Club mail"), acct("Google Drive b7e1394d", "Google Drive", "files", "School Drive")],
  locals: [],
};
const act = async (_ref: Ref, a: RefAction): Promise<RefReceipt> => {
  if (a.type === "rsvp") return { stamp: "Sent", text: "Accepted · COAST Meeting · Prof. Lin notified", rsvp: a.answer };
  if (a.type === "copyLink") return { stamp: "Copied", text: "docs.google.com/document/d/…" };
  return { stamp: "Sent", text: "Reply to Priya S. · Re: Speaker confirmation" };
};

async function main() {
  if (q.get("classic") === "1") {
    layout.value = "classic";
    applyLayout("classic");
  }
  resetDrafts();
  document.getElementById("lbl")!.textContent = `${kind} · ${at}${q.get("soon") === "1" ? " · this build (actions not wired)" : ""}${q.get("out") === "1" ? " · signed out" : ""}${q.get("classic") === "1" ? " · classic" : ""}`;
  document.getElementById("said")!.innerHTML = renderReply(REPLIES[kind]);
  mount(RefCardHost, { target: document.body, props: { reach: () => REACH, act: q.get("soon") === "1" ? undefined : act, onaccounts: () => {} } });
  flushSync();
  const link = document.querySelector<HTMLElement>("a.nl-ref")!;
  const card = () => document.querySelector<HTMLElement>(".ref-card:not([inert])");
  const btn = (label: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().replace(/^\d/, "").startsWith(label));
  const press = async (el: HTMLElement | undefined | null) => {
    el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el?.click();
    await wait(60);
  };
  const first = kind === "event" ? "Accept" : kind === "email" ? "Reply" : "Copy link";
  if (at !== "link") {
    if (kind === "email" && at !== "open" && at !== "hover") keepDraft("email:Gmail 2117773e:m_9", { mode: "reply", body: "Hi Priya — confirmed, thank you! Room is ISEB 1010; AV is the podium mic plus HDMI. I'll send the parking pass Thursday." });
    await press(link);
    await wait(400);
    if (at === "hover") btn(first)?.classList.add("rc-hov");
    if (at === "confirm" || at === "sent" || at === "close") {
      await press(btn(first));
      if (kind !== "doc" && at !== "confirm") {
        await press(btn("Send"));
      }
      if (at !== "confirm") await wait(700);
    }
    if (at === "close") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(500);
    }
  }
  document.documentElement.classList.add("still");
  const c = card();
  const r = c?.getBoundingClientRect();
  document.title = `993 ${kind} ${at}: card=${c ? `${Math.round(r!.width)}x${Math.round(r!.height)}@${Math.round(r!.left)},${Math.round(r!.top)}` : "none"} view=${c?.dataset.view ?? "-"} disabled=${c ? [...c.querySelectorAll("button:disabled")].length : 0} links=${document.querySelectorAll("a.nl-ref").length} done=${document.querySelectorAll("a.nl-ref.ref-done").length}`;
}
void main();
