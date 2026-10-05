/**
 * Nightshift on the phone (item 246 wave 5; blocker 669's default as the
 * wave-3 spec narrows it): the queue, an item, the morning pages, the open
 * blockers and their answers, and a new item. No diffs, no reverts, no
 * launching a shift — those stay on the Mac.
 *
 * The wire is `remote/nightshift_routes.rs`; this module is its client and
 * the drafts rule the sheet keeps (practices §7): a blocker's answer and a
 * new item are kept in localStorage on every keystroke until Send (or
 * Create) lands, or a confirmed Discard drops them.
 */
import { ApiError, Unreachable, countedFetch } from "./client";

// ---- the wire ----

export interface NsProject {
  id: string;
  name: string;
  kind: string;
  /** A shift is running: answers and new items wait until it ends. */
  live: boolean;
  items: number;
  open_blockers: number;
  newest_morning: string | null;
  config_error: string | null;
}

export interface NsItemRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  order: number | null;
}

export interface NsQueue {
  items: NsItemRow[];
  errors: string[];
}

export interface NsItem {
  id: string;
  title: string;
  kind: string;
  status: string;
  created: string;
  source: string;
  order: number | null;
  fields: Record<string, string>;
  /** Below the front matter, as written: rendered as Markdown. */
  body: string;
}

export interface NsBlockerRow {
  id: string;
  status: string;
  raised: string;
  item: string;
  question: string;
}

export interface NsBlocker extends NsBlockerRow {
  /** `## What I would have done, and why` — the default taken. */
  guess: string;
  blocks: string;
  answer: string;
  body: string;
}

export interface NsMorningRow {
  name: string;
  size: number;
  modified: string;
}

export interface NsMorning {
  name: string;
  text: string;
}

/** The `/api/nightshift` client, on one host (`base`, as `Client`'s). */
export class NightshiftClient {
  constructor(
    public token: string,
    public base = "",
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await countedFetch(`${this.base}/api/nightshift${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        cache: "no-store",
      });
    } catch (e) {
      throw new Unreachable(String(e), this.base);
    }
    if (!r.ok) throw new ApiError(r.status, (await r.text()) || r.statusText, this.base);
    return r;
  }

  private static id(s: string): string {
    return encodeURIComponent(s);
  }

  async projects(): Promise<NsProject[]> {
    return (await this.call("")).json();
  }

  async queue(project: string): Promise<NsQueue> {
    return (await this.call(`/${NightshiftClient.id(project)}/queue`)).json();
  }

  async item(project: string, id: string): Promise<NsItem> {
    return (await this.call(`/${NightshiftClient.id(project)}/items/${NightshiftClient.id(id)}`)).json();
  }

  /** A new item: his title and his words, under `## What Swaraag said`.
   *  `nonce` (wave 4 C1) is the same on every try of one item: a try after
   *  a lost reply gets the first try's id instead of a second item. */
  async newItem(project: string, title: string, said: string, nonce?: string): Promise<string> {
    const body: Record<string, string> = { title, said };
    if (nonce) body.nonce = nonce;
    const r = await this.call(`/${NightshiftClient.id(project)}/items`, { method: "POST", body: JSON.stringify(body) });
    return ((await r.json()) as { id: string }).id;
  }

  async blockers(project: string): Promise<NsBlockerRow[]> {
    return ((await (await this.call(`/${NightshiftClient.id(project)}/blockers`)).json()) as { blockers: NsBlockerRow[] }).blockers;
  }

  async blocker(project: string, id: string): Promise<NsBlocker> {
    return (await this.call(`/${NightshiftClient.id(project)}/blockers/${NightshiftClient.id(id)}`)).json();
  }

  /** His answer, written as the Mac's Answer box writes it; the blocker after. */
  async answer(project: string, id: string, answer: string): Promise<NsBlocker> {
    const r = await this.call(`/${NightshiftClient.id(project)}/blockers/${NightshiftClient.id(id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    return r.json();
  }

  /** The morning pages, newest first. */
  async mornings(project: string): Promise<NsMorningRow[]> {
    return (await this.call(`/${NightshiftClient.id(project)}/mornings`)).json();
  }

  async morning(project: string, name: string): Promise<NsMorning> {
    return (await this.call(`/${NightshiftClient.id(project)}/mornings/${NightshiftClient.id(name)}`)).json();
  }
}

/** The sentence for a failed call, in his words. */
export function nsProblem(e: unknown, host: string | null | undefined): string {
  if (e instanceof Unreachable) return host === "serve" ? "The away server is unreachable." : "The Mac is unreachable.";
  if (e instanceof ApiError) {
    if (e.status === 501) return host === "serve" ? "Nightshift is not on the away server yet." : "Nightshift is not on this host.";
    if (e.status === 404 && /^\s*$/.test(e.message)) return "This Nightloom has no Nightshift routes — update it.";
    return e.message;
  }
  return String(e instanceof Error ? e.message : e);
}

/** "2026-09-11.md" → "Thursday, September 11"; any other name as it is. */
export function morningTitle(name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
  if (!m) return name.replace(/\.md$/, "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** A queue row's status as a short tag ("" for todo, which is most). */
export function statusTag(status: string): string {
  return status === "todo" || status === "" ? "" : status.replace("-", " ");
}

// ---- drafts (practices §7: never lose his text) ----

export const NS_DRAFTS_KEY = "nightloom.remote.nsdrafts";

/** A kept draft: a blocker's answer (`text`), or a new item (`title` + `text`). */
export interface NsDraft {
  text: string;
  title?: string;
}

/** The key of a blocker answer's draft, or of a new item's. */
export function answerDraftKey(project: string, blocker: string): string {
  return `answer:${project}/${blocker}`;
}
export function itemDraftKey(project: string): string {
  return `item:${project}`;
}

function readDrafts(): Record<string, NsDraft> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NS_DRAFTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, NsDraft>) : {};
  } catch {
    return {};
  }
}

export function loadNsDraft(key: string): NsDraft | null {
  const d = readDrafts()[key];
  if (!d || typeof d !== "object" || typeof d.text !== "string") return null;
  return typeof d.title === "string" ? { text: d.text, title: d.title } : { text: d.text };
}

/** Keep `draft` under `key`; `null`, or a draft with nothing typed, drops
 *  it (only Send/Create landing, or a confirmed Discard, pass `null`). */
export function saveNsDraft(key: string, draft: NsDraft | null): void {
  const all = readDrafts();
  if (draft && (draft.text.trim() || (draft.title ?? "").trim())) all[key] = draft;
  else delete all[key];
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(NS_DRAFTS_KEY);
    else localStorage.setItem(NS_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // Storage off: the draft lives in the sheet's state only.
  }
}

export function nsDraftKeys(): string[] {
  return Object.keys(readDrafts());
}

/** Whether Discard must ask first: there is typed text to lose. */
export function discardNeedsConfirm(draft: NsDraft | null): boolean {
  return !!draft && (draft.text.trim() !== "" || (draft.title ?? "").trim() !== "");
}
