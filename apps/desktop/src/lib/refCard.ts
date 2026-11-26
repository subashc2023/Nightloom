/*
 * The typed link's card, in words (nightshift item 993c): what `RefCard.svelte` shows for an event, an email or a
 * doc, worked out from the link's own fields (`refTag.ts` — what the model read from the connector, blocker 2306)
 * and from what Home reaches (`home.ts`'s `HomeReach`). Pure, so the tests pin each line.
 */
import type { Ref, RefKind } from "./refTag";
import { reachName, type HomeReach, type ReachAccount } from "./home";

export type Rsvp = "needsAction" | "accepted" | "tentative" | "declined" | "organizer";
export type RsvpAnswer = "accepted" | "tentative" | "declined";
export type MailMode = "reply" | "replyAll" | "forward";

/** What a click in the card asks for. Nothing here runs by itself: the card hands it to `act`, after his confirm
 *  for anything that sends (993d wires `act`; without one every action is shown, disabled, "coming soon"). */
export type RefAction =
  | { type: "rsvp"; answer: RsvpAnswer; note: string }
  | { type: "send"; mode: MailMode; to: string; body: string }
  | { type: "saveDraft"; mode: MailMode; to: string; body: string }
  | { type: "copyLink" }
  | { type: "readHere" }
  | { type: "open" };

/** What an action came back with: the stamp's word and the one line beside it; `rsvp` when his answer changed. */
export interface RefReceipt {
  stamp: "Sent" | "Copied" | "Saved";
  text: string;
  rsvp?: Rsvp;
}

export const KIND_WORD: Record<RefKind, string> = { event: "Event", email: "Email", doc: "Doc" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Wall {
  y: number;
  m: number;
  d: number;
  /** Minutes into the day; null for a date with no time (an all-day event). */
  min: number | null;
}

/** A connector's time as the wall clock it names — its own date and hour, whatever the offset after it. */
export function wall(iso: string | undefined): Wall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso?.trim() ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const min = m[4] === undefined ? null : Number(m[4]) * 60 + Number(m[5]);
  return { y, m: mo, d, min: min !== null && min < 1440 ? min : null };
}

const dayNo = (w: Wall) => Math.round(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);
const sameDay = (a: Wall, b: Wall) => dayNo(a) === dayNo(b);

/** "12:00 PM"; `bare` leaves the AM/PM off (the start of "12:00 – 1:00 PM"). */
export function clock12(min: number, bare = false): string {
  const h = Math.floor(min / 60);
  const t = `${h % 12 || 12}:${String(min % 60).padStart(2, "0")}`;
  return bare ? t : `${t} ${h < 12 ? "AM" : "PM"}`;
}

/** "Wed, Nov 25" (with the year when it is not this one). */
export function dateWords(w: Wall, now: Date): string {
  const dow = DAYS[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
  return `${dow}, ${MONTHS[w.m - 1]} ${w.d}${w.y === now.getFullYear() ? "" : `, ${w.y}`}`;
}

/** "today 11:42 AM", "yesterday 9:10 PM", "Mon, Nov 23 · 4:05 PM" — a past moment beside `now`. */
export function agoWords(iso: string | undefined, now: Date): string {
  const w = wall(iso);
  if (!w) return "";
  const today: Wall = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), min: null };
  const gap = dayNo(today) - dayNo(w);
  const time = w.min === null ? "" : clock12(w.min);
  if (gap === 0) return `today${time ? ` ${time}` : ""}`;
  if (gap === 1) return `yesterday${time ? ` ${time}` : ""}`;
  return `${dateWords(w, now)}${time ? ` · ${time}` : ""}`;
}

/** An event's when: "Wed, Nov 25 · 12:00 – 1:00 PM", a date alone for an all-day one. */
export function eventWhen(start: string | undefined, end: string | undefined, now: Date): string {
  const s = wall(start);
  if (!s) return "";
  const e = wall(end);
  const day = dateWords(s, now);
  if (s.min === null) {
    // An all-day event's end is the day after its last day.
    const last = e && e.min === null && dayNo(e) - dayNo(s) > 1 ? wallOf(dayNo(e) - 1) : null;
    return last ? `${day} – ${dateWords(last, now)} · all day` : `${day} · all day`;
  }
  if (!e || e.min === null) return `${day} · ${clock12(s.min)}`;
  if (!sameDay(s, e)) return `${day} · ${clock12(s.min)} – ${dateWords(e, now)} · ${clock12(e.min)}`;
  const samePart = s.min < 720 === e.min < 720;
  return `${day} · ${clock12(s.min, samePart)} – ${clock12(e.min)}`;
}

function wallOf(day: number): Wall {
  const d = new Date(day * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), min: null };
}

export function rsvpOf(v: string | undefined): Rsvp | null {
  return v === "needsAction" || v === "accepted" || v === "tentative" || v === "declined" || v === "organizer" ? v : null;
}

/** His answer as the card's pill says it, and how the pill is lit. */
export function rsvpPill(r: Rsvp | null): { words: string; look: "need" | "ok" | "plain" } | null {
  if (r === "needsAction") return { words: "Not answered", look: "need" };
  if (r === "accepted") return { words: "Going", look: "ok" };
  if (r === "tentative") return { words: "Maybe", look: "plain" };
  if (r === "declined") return { words: "Not going", look: "plain" };
  if (r === "organizer") return { words: "You organize this", look: "plain" };
  return null;
}

export const RSVP_CHOICES: { answer: RsvpAnswer; label: string; key: string; done: string }[] = [
  { answer: "accepted", label: "Accept", key: "1", done: "Accepted" },
  { answer: "tentative", label: "Maybe", key: "2", done: "Answered maybe" },
  { answer: "declined", label: "Decline", key: "3", done: "Declined" },
];

const DOC_TYPES: Record<string, { words: string; app: string }> = {
  doc: { words: "Google Doc", app: "Docs" },
  sheet: { words: "Google Sheet", app: "Sheets" },
  slides: { words: "Google Slides", app: "Slides" },
  pdf: { words: "PDF", app: "Drive" },
  file: { words: "File", app: "Drive" },
};

/** The line under the title: when (an event), who and when (an email), what and its last edit (a doc). */
export function whenLine(r: Ref, now: Date = new Date()): string {
  const f = r.fields;
  if (r.kind === "event") return [eventWhen(f.start, f.end, now), f.repeats ? `repeats ${f.repeats.replace(/^repeats\s+/i, "")}` : ""].filter(Boolean).join(" · ");
  if (r.kind === "email") {
    const n = Number(f.count);
    return [f.from ?? "", agoWords(f.at, now), Number.isInteger(n) && n > 1 ? `${n} in thread` : ""].filter(Boolean).join(" · ");
  }
  const type = DOC_TYPES[f.type ?? ""]?.words ?? "";
  const when = agoWords(f.edited, now);
  const edited = when ? `edited${f.editor ? ` by ${f.editor}` : ""} ${when}` : "";
  return [type, edited].filter(Boolean).join(" · ");
}

/** The details table: only what the link carries. An event's own answer is drawn by the card (the pill). */
export function detailRows(r: Ref): [string, string][] {
  const f = r.fields;
  const rows: [string, string | undefined][] =
    r.kind === "event"
      ? [
          ["Where", f.where],
          ["Organizer", f.organizer],
          ["Guests", f.guests],
        ]
      : r.kind === "email"
        ? [["To", f.to]]
        : [
            ["Owner", f.owner],
            ["You can", f.access],
            ["Shared", f.shared],
          ];
  return rows.filter((x): x is [string, string] => !!x[1]);
}

/** The foot row: where the item's own page opens, by its (already checked) link. */
export function openElsewhere(r: Ref): { label: string; host: string } {
  const app = r.kind === "event" ? "Calendar" : r.kind === "email" ? "Gmail" : (DOC_TYPES[r.fields.type ?? ""]?.app ?? "Drive");
  let host = "";
  try {
    host = r.fields.link ? new URL(r.fields.link).hostname : "";
  } catch {
    host = "";
  }
  return { label: `Open in ${app}`, host };
}

/** "as of 3:04 PM" — when the model read the fields, when the link says. */
export function asOfWords(r: Ref, now: Date = new Date()): string {
  const w = agoWords(r.fields.asof, now);
  return w ? `as of ${w.replace(/^today /, "")}` : "";
}

export type AccountState = "ok" | "signin" | "failed" | "off" | "unknown";

/**
 * The account a link came from, for the card's head: its address once a scan has read it, else the service and
 * which account; and whether an action could reach it now. A source Home has never listed is `unknown`: the name
 * is the tag's own `src`, and nothing is claimed about it.
 */
export function accountOf(reach: Pick<HomeReach, "accounts"> | null | undefined, src: string): { label: string; state: AccountState } {
  const a: ReachAccount | undefined = reach?.accounts.find((x) => x.connector === src);
  if (!a) return { label: src, state: "unknown" };
  const state: AccountState = a.status === "needs_sign_in" ? "signin" : a.status === "failed" ? "failed" : a.on ? "ok" : "off";
  return { label: reachName(a), state };
}

/** Why the actions are off for this account, in one line; null when they are not. */
export function accountWarn(state: AccountState, label: string): string | null {
  if (state === "signin") return `${label} is signed out, so nothing can be sent from here. These details are what was read before.`;
  if (state === "failed") return `${label} did not answer the last check, so nothing can be sent from here yet.`;
  if (state === "off") return `${label} is turned off for Home. These details are what was read before.`;
  return null;
}

/** The confirm's sentence for an RSVP: what goes, and who sees it. */
export function rsvpConfirm(r: Ref, answer: RsvpAnswer): { ask: string; who: string } {
  const c = RSVP_CHOICES.find((x) => x.answer === answer)!;
  const verb = answer === "tentative" ? "Answer maybe to" : c.label;
  const organizer = r.fields.organizer;
  return { ask: `${verb} ${r.name}?`, who: organizer ? `${organizer} and the guests see your answer.` : "The organizer and the guests see your answer." };
}

/** Who a mail goes to, as the Send button names them: the sender for a reply, his typed recipient for a forward. */
export function mailTo(r: Ref, mode: MailMode, typed: string): string {
  if (mode === "forward") return typed.trim();
  const from = r.fields.from ?? "";
  return mode === "replyAll" ? (from ? `${from} and everyone on it` : "everyone on it") : from || "the sender";
}

export const MAIL_WORD: Record<MailMode, string> = { reply: "Reply", replyAll: "Reply all", forward: "Forward" };
