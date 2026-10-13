/**
 * The phone page's two hosts (item 246 wave 4B, item 154's page half): the
 * Mac's listener and the away server (`nightloom serve`, on Fly). Each is a
 * base URL and its own token, kept in localStorage as the one token was
 * before — never logged, never in a URL query. The page tries the preferred
 * host (the Mac) with a 1.5 s deadline, then the other; whichever answers
 * carries the state, the event stream and the lists, and a chat belongs to
 * the host that listed it.
 *
 * Pure apart from localStorage, so all of it is under `hosts.test.ts`.
 */
import { TOKEN_KEY, tokenFromHash } from "./client";

export type HostRole = "mac" | "away";
export const ROLES: HostRole[] = ["mac", "away"];

/** One paired host: where it answers and the token it gave. */
export interface HostEntry {
  /** The origin, `scheme://host[:port]`, no trailing slash. */
  base: string;
  token: string;
}
export type Hosts = Partial<Record<HostRole, HostEntry>>;

export const HOSTS_KEY = "nightloom.remote.hosts";
/** How long a host has to answer `/api/state` before the next is tried. */
export const PROBE_MS = 1500;

export function hostLabel(role: HostRole): string {
  return role === "mac" ? "Mac" : "Away";
}

/** "the Mac" / "Away", inside a sentence. */
export function hostName(role: HostRole): string {
  return role === "mac" ? "the Mac" : "Away";
}

// ---- storage -------------------------------------------------------------

function cleanBase(base: string): string | null {
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function validEntry(v: unknown): HostEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.base !== "string" || typeof e.token !== "string") return null;
  const base = cleanBase(e.base);
  if (!base || !/^[0-9a-f]{16,128}$/.test(e.token)) return null;
  return { base, token: e.token };
}

/**
 * The paired hosts. A page from before wave 4 kept one token under
 * `TOKEN_KEY` for the host that served it: that becomes this page's own
 * host (`origin`), in the role its address suggests.
 */
export function loadHosts(origin: string): Hosts {
  const out: Hosts = {};
  try {
    const raw = localStorage.getItem(HOSTS_KEY);
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object")
        for (const r of ROLES) {
          const e = validEntry((v as Record<string, unknown>)[r]);
          if (e) out[r] = e;
        }
    }
    if (Object.keys(out).length === 0) {
      const old = localStorage.getItem(TOKEN_KEY);
      const base = cleanBase(origin);
      if (old && base && /^[0-9a-f]{16,128}$/.test(old)) out[guessRole(base)] = { base, token: old };
    }
  } catch {
    // Storage off: no hosts kept.
  }
  return out;
}

/**
 * Keep `hosts`. The token of this page's own host is also kept under the
 * old `TOKEN_KEY`, so a page rolled back to before wave 4 still finds it.
 */
export function saveHosts(hosts: Hosts, origin: string): void {
  try {
    const keep: Hosts = {};
    for (const r of ROLES) if (hosts[r]) keep[r] = hosts[r];
    if (Object.keys(keep).length === 0) localStorage.removeItem(HOSTS_KEY);
    else localStorage.setItem(HOSTS_KEY, JSON.stringify(keep));
    const own = ROLES.map((r) => keep[r]).find((e) => e && e.base === cleanBase(origin));
    if (own) localStorage.setItem(TOKEN_KEY, own.token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage off: the hosts live for this page load only.
  }
}

// ---- pairing ---------------------------------------------------------------

/** Which role an address most likely is before it has answered: the away
 *  server lives on Fly (`*.fly.dev`); anything else is the Mac. The host's
 *  own `/api/state` settles it (`settleRole`). */
export function guessRole(base: string): HostRole {
  try {
    return /\.fly\.dev$/i.test(new URL(base).hostname) ? "away" : "mac";
  } catch {
    return "mac";
  }
}

/**
 * What he pasted to pair: a whole link (`https://x.fly.dev/#token=…`, the
 * QR's form) — its origin and token — or a bare token, which is this
 * page's own host's. Null for anything else.
 */
export function pairLink(text: string, origin: string): HostEntry | null {
  const t = text.trim();
  if (/^[0-9a-fA-F]{16,128}$/.test(t)) {
    const base = cleanBase(origin);
    return base ? { base, token: t.toLowerCase() } : null;
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  const token = tokenFromHash(u.hash);
  const base = cleanBase(u.origin);
  return token && base ? { base, token } : null;
}

/** The link that pairs `entry` when opened (the QR's form): the token in
 *  the fragment, which never leaves the browser. */
export function openLink(entry: HostEntry): string {
  return `${entry.base}/#token=${entry.token}`;
}

/**
 * Put `entry` in `role`; a host already paired at the same address in the
 * other role moves out (one address is one host).
 */
export function pair(hosts: Hosts, role: HostRole, entry: HostEntry): Hosts {
  const out: Hosts = { ...hosts, [role]: entry };
  for (const r of ROLES) if (r !== role && out[r]?.base === entry.base) delete out[r];
  return out;
}

export function forgetHost(hosts: Hosts, role: HostRole): Hosts {
  const out: Hosts = { ...hosts };
  delete out[role];
  return out;
}

/**
 * The host's own word on what it is (`/api/state`'s `host`): `"serve"` is
 * the away server; `"mac"`, or none (an older Mac), is the Mac. When the
 * host that answered in `role` says it is the other, the two swap.
 */
export function settleRole(hosts: Hosts, role: HostRole, host: string | null | undefined): { hosts: Hosts; role: HostRole } {
  const truly: HostRole = host === "serve" ? "away" : "mac";
  if (truly === role) return { hosts, role };
  const out: Hosts = {};
  if (hosts[role]) out[truly] = hosts[role];
  if (hosts[truly]) out[role] = hosts[truly];
  return { hosts: out, role: truly };
}

// ---- what can be reached from this page ------------------------------------------

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * A page served over HTTPS (Away, on fly.dev) cannot call a plain-HTTP
 * address (the Mac's listener until blocker 660 gives it HTTPS): the
 * browser blocks mixed content, and there is no way around it from the
 * page. A plain-HTTP page may call HTTPS. Loopback counts as secure.
 */
export function mixedBlocked(pageOrigin: string, base: string): boolean {
  try {
    const page = new URL(pageOrigin);
    const to = new URL(base);
    return page.protocol === "https:" && to.protocol === "http:" && !isLoopback(to.hostname);
  } catch {
    return false;
  }
}

/** The paired roles in the order to try: `prefer` first. */
export function order(hosts: Hosts, prefer: HostRole = "mac"): HostRole[] {
  const first = hosts[prefer] ? [prefer] : [];
  return [...first, ...ROLES.filter((r) => r !== prefer && hosts[r])];
}

/** `host:port` of a base, for a sentence: "100.101.102.103:8642". */
export function addressOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

// ---- choosing the host that answers ---------------------------------------------

export type TriedWhy = "timeout" | "unreachable" | "refused" | "blocked";

export interface Tried {
  role: HostRole;
  base: string;
  why: TriedWhy;
  /** The host's sentence for a refusal (401). */
  message?: string;
}

export type Choice<S> = { role: HostRole; state: S; tried: Tried[] } | { role: null; state: null; tried: Tried[] };

/**
 * Try each role in `roles` in order, each with `ms` to answer `probe`
 * (`/api/state`); the first that answers is the host. Roles the page
 * cannot reach at all (`blocked`, mixed content) are not tried, only
 * reported. A 401 (`status` on the error) is a refused token, reported as
 * such so the page can ask for a new scan of that host alone.
 */
export async function chooseHost<S>(
  roles: HostRole[],
  hosts: Hosts,
  probe: (role: HostRole, signal: AbortSignal) => Promise<S>,
  blocked: (role: HostRole) => boolean = () => false,
  ms = PROBE_MS,
  /** Told before each probe: the host about to be tried and what the
   *  earlier ones did (the offline bar's "… — trying Away"). */
  onTry: (role: HostRole, tried: Tried[]) => void = () => {},
): Promise<Choice<S>> {
  const tried: Tried[] = [];
  for (const role of roles) {
    const base = hosts[role]?.base ?? "";
    if (blocked(role)) {
      tried.push({ role, base, why: "blocked" });
      continue;
    }
    onTry(role, tried.slice());
    const ctl = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      ctl.abort();
    }, ms);
    try {
      const state = await Promise.race([
        probe(role, ctl.signal),
        // A probe that ignores its signal still loses the race.
        new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("timeout")))),
      ]);
      clearTimeout(timer);
      return { role, state, tried };
    } catch (e) {
      clearTimeout(timer);
      const status = (e as { status?: unknown })?.status;
      if (status === 401) tried.push({ role, base, why: "refused", message: e instanceof Error ? e.message : undefined });
      else tried.push({ role, base, why: late ? "timeout" : "unreachable" });
    }
  }
  return { role: null, state: null, tried };
}

// ---- what the page says -----------------------------------------------------------

/**
 * The offline bar (item 154's page half): which address was tried, for
 * which host, and what happens next. `next` is the host being tried now,
 * or null when every host has been tried.
 */
export function offlineLine(tried: Tried[], next: HostRole | null, paired: HostRole[]): string {
  const failed = tried.filter((t) => t.why !== "refused" || paired.length === 1);
  const at = (t: Tried) =>
    t.why === "blocked"
      ? `${hostName(t.role)} (its plain-HTTP address cannot be called from this HTTPS page)`
      : `${hostName(t.role)} at ${addressOf(t.base)}`;
  if (next) {
    const first = failed[0];
    return first ? `Can't reach ${at(first)} — trying ${hostName(next)}` : `Connecting to ${hostName(next)}…`;
  }
  if (paired.length >= 2) {
    const parts = failed.map(at);
    return parts.length > 0 ? `Can't reach either host — ${parts.join("; ")}.` : "Can't reach either host.";
  }
  const only = failed[0];
  if (!only) return "Can't reach the host.";
  return only.role === "mac" && only.why !== "blocked"
    ? `Can't reach ${at(only)} — is Tailscale on, and Remote switched on?`
    : `Can't reach ${at(only)}.`;
}

/**
 * The one sentence for a feature this host does not offer, used by every
 * place the page greys one out. `older` is that place's own sentence for
 * a Mac from before the feature (no `host` in `/api/state`), the only case
 * in which "older" is true.
 */
export function missingSentence(host: string | null | undefined, older: string): string {
  if (host === "serve") return "Not on the away server yet.";
  if (host === "mac") return "This Mac does not offer this.";
  return older;
}

/**
 * Which host a chat-addressed call goes to: the host that listed the chat
 * (a chat from Away is never sent to the Mac); a new chat, which no host
 * has listed yet, goes to the host answering now.
 */
export function routeFor(chatHost: HostRole | null | undefined, active: HostRole | null): HostRole | null {
  return chatHost ?? active;
}

/** The oldest held message for `role` (one held before wave 3 is the
 *  Mac's): the queue drains per host, so nothing goes to the wrong one. */
export function nextHeldFor<Q extends { host?: HostRole }>(queue: Q[], role: HostRole | null): Q | null {
  if (!role) return null;
  return queue.find((q) => (q.host ?? "mac") === role) ?? null;
}
