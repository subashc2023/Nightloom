/**
 * The Home Screen icon opens signed in (item 604). An iOS Home Screen web
 * app starts at its manifest's `start_url` with storage of its own, not
 * Safari's, so the token Safari kept is not there; and the page takes the
 * token off the address bar the moment it reads it. So once paired, the
 * page points `<link rel=manifest>` at a manifest of its own making — a
 * `data:` URL, built on the phone and never sent anywhere — whose
 * `start_url` carries every paired host in the fragment, the QR's form.
 * The icon then opens with the pairing the way a scan does, and keeps it
 * in its own storage.
 *
 * WebKit (DocumentLoader::loadApplicationManifest) reads the first
 * manifest link in <head> when asked and loads it once per page, so the
 * link is set before the page mounts. A `data:` manifest loads as
 * same-origin (ApplicationManifestLoader's sameOriginDataURLFlag); its
 * `start_url` must be on the page's own origin and keeps its fragment
 * (ApplicationManifestParser); icons are absolute, since they resolve
 * against the manifest's URL.
 *
 * Pure apart from `setManifest`, so all of it is under `homeScreen.test.ts`.
 */
import { tokenFromHash } from "./client";
import { ROLES, guessRole, macFromHash, type HostEntry, type HostRole, type Hosts } from "./hosts";

/** The manifest the page links when nothing is paired (the static file). */
export const STATIC_MANIFEST = "/remote/manifest.webmanifest";

/** Marks a link as the icon's own start: the pairing it carries may be
 *  older than the one the icon has since kept (`keepStored`). */
const ICON_MARK = "icon=1";

/** The fragment keys each other host rides under (588's `mac=`/`mt=`;
 *  `away=`/`at=` for the away server on a page the Mac serves). */
const HALF_KEYS: Record<HostRole, [string, string]> = { mac: ["mac", "mt"], away: ["away", "at"] };

function originOf(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * The fragment the icon starts with: this page's own host's token as
 * `token=`, every other paired host as its address and token, and the
 * icon mark. Null when this page's own host is not paired (an icon that
 * starts here could not use it).
 */
export function iconHash(hosts: Hosts, origin: string): string | null {
  const own = originOf(origin);
  if (!own) return null;
  const mine = ROLES.map((r) => hosts[r]).find((e) => e && e.base === own);
  if (!mine) return null;
  const p = new URLSearchParams();
  p.set("token", mine.token);
  for (const r of ROLES) {
    const e = hosts[r];
    if (!e || e.base === own) continue;
    const [b, t] = HALF_KEYS[r];
    p.set(b, e.base);
    p.set(t, e.token);
  }
  return `#${p.toString()}&${ICON_MARK}`;
}

/** The manifest for the icon: the static file's fields, every URL
 *  absolute on `origin`, and `start_url` carrying `hash`. */
export function iconManifest(origin: string, hash: string): Record<string, unknown> {
  return {
    name: "Nightloom",
    short_name: "Nightloom",
    id: `${origin}/`,
    start_url: `${origin}/${hash}`,
    scope: `${origin}/`,
    display: "standalone",
    background_color: "#111214",
    theme_color: "#111214",
    icons: [
      { src: `${origin}/remote/icon-128.png`, sizes: "128x128", type: "image/png" },
      { src: `${origin}/remote/icon-256.png`, sizes: "256x256", type: "image/png", purpose: "any" },
    ],
  };
}

/** The manifest link's href: the icon's own `data:` manifest once this
 *  page's host is paired, else the static file. */
export function manifestHref(hosts: Hosts, origin: string): string {
  const own = originOf(origin);
  const hash = own ? iconHash(hosts, own) : null;
  if (!own || !hash) return STATIC_MANIFEST;
  return `data:application/manifest+json,${encodeURIComponent(JSON.stringify(iconManifest(own, hash)))}`;
}

/** Point the page's manifest link at `href`, adding the link if there is none. */
export function setManifest(doc: Document, href: string): void {
  let link = doc.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = doc.createElement("link");
    link.rel = "manifest";
    doc.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/** Whether this start is the icon's own (its `start_url`). */
export function isIconStart(hash: string): boolean {
  return new URLSearchParams(hash.replace(/^#/, "")).get("icon") === "1";
}

/**
 * The other host a link carries, as `{ role, entry }`: the Mac (588's
 * `mac=`/`mt=`), or the away server (`away=`/`at=`). The Mac half is read
 * as before, by `macFromHash`.
 */
export function halvesFromHash(hash: string): { role: HostRole; entry: HostEntry }[] {
  const out: { role: HostRole; entry: HostEntry }[] = [];
  const mac = macFromHash(hash);
  if (mac) out.push({ role: "mac", entry: mac });
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const base = p.get(HALF_KEYS.away[0]);
  const token = p.get(HALF_KEYS.away[1])?.toLowerCase();
  const o = base ? originOf(base) : null;
  if (o && token && /^[0-9a-f]{16,128}$/.test(token) && /^https?:/.test(o)) out.push({ role: "away", entry: { base: o, token } });
  return out;
}

/**
 * On the icon's own start, a host already kept at that address keeps its
 * token: the icon's `start_url` was written when it was added, and a
 * token paired since (a paste in the icon) is the newer. A scan (no icon
 * mark) always pairs, as before.
 */
export function keepStored(hosts: Hosts, base: string, hash: string): boolean {
  if (!isIconStart(hash)) return false;
  return ROLES.some((r) => hosts[r]?.base === base);
}

/**
 * The hosts a page load would hold, before the page mounts: the kept ones
 * with the link's pairing on top (the same rules as the page's own start),
 * so the manifest is right before Safari can ask for it.
 */
export function hostsAtLoad(kept: Hosts, hash: string, origin: string, pairFn: (h: Hosts, r: HostRole, e: HostEntry) => Hosts): Hosts {
  let hosts = kept;
  const own = originOf(origin);
  const token = tokenFromHash(hash);
  if (!own || !token) return hosts;
  const ownRole = guessRole(own);
  for (const { role, entry } of halvesFromHash(hash))
    if (role !== ownRole && !keepStored(hosts, entry.base, hash)) hosts = pairFn(hosts, role, entry);
  if (!keepStored(hosts, own, hash)) hosts = pairFn(hosts, ownRole, { base: own, token });
  return hosts;
}
