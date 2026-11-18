/**
 * Home's routing as data (nightshift item 763, H5): a Start card is a route waiting for his tap — a chat
 * that may write, or a message into a big chat whose cache is cold. Pure; the Mac's store is
 * `home.svelte.ts`, the phone's is `HomeFirst.svelte`, and both draw `StartCard.svelte`.
 * His edit of a card's prompt is a draft kept per route until he starts or dismisses it.
 */
export type RoutePick = "new" | "into";

export interface HomeRoute {
  id: string;
  /** RFC 3339: when Home asked. */
  at: string;
  kind: "start" | "send";
  project: string | null;
  project_name: string;
  chat: string | null;
  label: string | null;
  /** Home's words; what is sent unless he edits them. */
  prompt: string;
  write: boolean;
  state: "waiting" | "queued" | "started" | "finished" | "failed" | "dismissed";
  hold: "write" | "cold" | "unattended" | null;
  cold: { tokens: number; into_usd: number | null; new_usd: number | null } | null;
  note: string | null;
}

export interface RoutesReply {
  cards: HomeRoute[];
  /** Routes that need nothing from him but cannot start yet (a closed project, a night run), with why in `note`. */
  held?: HomeRoute[];
  /** The chats Home started. */
  started: string[];
}

/** "a new chat in Nightloom" / "“778 fix” in Nightshift". */
export function routeWhere(r: HomeRoute): string {
  if (r.kind === "send") return r.label ? `“${r.label}” in ${r.project_name}` : `a chat in ${r.project_name}`;
  return `a new chat in ${r.project_name}`;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;
const usd = (n: number | null) => (n == null ? "" : ` ≈ $${n < 1 ? n.toFixed(2) : n.toFixed(1)}`);

/** Why the card waits, in one line. */
export function routeWhy(r: HomeRoute): string {
  if (r.hold === "cold" && r.cold) return `${k(r.cold.tokens)} and its cache is cold — sending re-writes all of it`;
  if (r.hold === "unattended") return "Home asked for this while no one was typing (a scan or a job), so it starts only when you tap";
  return "This chat may edit files and run commands, so it starts only when you tap";
}

/** The card's buttons, the default first: one Start, or the cold card's two picks with their costs. */
export function routeChoices(r: HomeRoute): { pick: RoutePick | null; label: string }[] {
  if (r.hold !== "cold") return [{ pick: null, label: r.kind === "send" ? "Send" : "Start" }];
  return [
    { pick: "new", label: `New chat in ${r.project_name}${usd(r.cold?.new_usd ?? null)}` },
    { pick: "into", label: `Send into it anyway${usd(r.cold?.into_usd ?? null)}` },
  ];
}

/** One line for a route that waits on something other than him: where it goes, read-only or not, and why. */
export function heldLine(r: HomeRoute): string {
  const why = (r.note ?? "").replace(/^waiting — /, "");
  return `Waiting to start · ${routeWhere(r)} · ${r.write ? "may write" : "read-only"}${why ? ` · ${why}` : ""}`;
}

/** The sidebar's mark on a chat Home started. */
export const BY_HOME_TIP = "Started by Home";

export const ROUTE_DRAFTS_KEY = "nightloom.home.routeDrafts";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | null => (typeof localStorage === "undefined" ? null : localStorage);

/** His half-edited prompts, by route id. */
export function readRouteDrafts(s: Store | null = store()): Record<string, string> {
  try {
    const v = JSON.parse(s?.getItem(ROUTE_DRAFTS_KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Keep (or with `null`, drop) one route's draft; the new map. */
export function withRouteDraft(drafts: Record<string, string>, id: string, text: string | null, s: Store | null = store()): Record<string, string> {
  const next = { ...drafts };
  if (text === null) delete next[id];
  else next[id] = text;
  try {
    if (Object.keys(next).length) s?.setItem(ROUTE_DRAFTS_KEY, JSON.stringify(next));
    else s?.removeItem(ROUTE_DRAFTS_KEY);
  } catch {
    // best-effort
  }
  return next;
}

/** Drafts of cards that are gone (answered on the other device) are dropped; the rest kept. */
export function pruneRouteDrafts(drafts: Record<string, string>, cards: readonly HomeRoute[], s: Store | null = store()): Record<string, string> {
  let next = drafts;
  for (const id of Object.keys(drafts)) if (!cards.some((c) => c.id === id)) next = withRouteDraft(next, id, null, s);
  return next;
}

/** What the card's box shows: his draft, else Home's words. */
export function routeText(r: HomeRoute, drafts: Record<string, string>): string {
  return drafts[r.id] ?? r.prompt;
}
