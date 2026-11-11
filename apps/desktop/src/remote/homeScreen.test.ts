import { describe, expect, it } from "vitest";
import { tokenFromHash } from "./client";
import {
  STATIC_MANIFEST,
  halvesFromHash,
  hostsAtLoad,
  iconHash,
  iconManifest,
  isIconStart,
  keepStored,
  manifestHref,
  setManifest,
} from "./homeScreen";
import { macFromHash, pair, type Hosts } from "./hosts";

const AWAY = "https://nightloom-away.fly.dev";
const MAC = "http://100.101.102.103:8642";
const TA = "a".repeat(64);
const TM = "b".repeat(64);
const TNEW = "c".repeat(64);

const both: Hosts = { away: { base: AWAY, token: TA }, mac: { base: MAC, token: TM } };

/** The manifest a `data:` href holds. */
function decode(href: string): Record<string, unknown> {
  expect(href.startsWith("data:application/manifest+json,")).toBe(true);
  return JSON.parse(decodeURIComponent(href.slice("data:application/manifest+json,".length)));
}

describe("item 604: the Home Screen icon's start carries the pairing", () => {
  it("nothing paired, or only another host: the static manifest", () => {
    expect(manifestHref({}, AWAY)).toBe(STATIC_MANIFEST);
    expect(manifestHref({ mac: both.mac }, AWAY)).toBe(STATIC_MANIFEST);
    expect(iconHash({ mac: both.mac }, AWAY)).toBeNull();
  });

  it("on the away server's page, both hosts ride the start_url's fragment, in the QR's form", () => {
    const m = decode(manifestHref(both, AWAY));
    const start = new URL(m.start_url as string);
    expect(start.origin).toBe(AWAY);
    expect(start.pathname).toBe("/");
    expect(start.search).toBe("");
    // The same readers the page's own start uses find both halves.
    expect(tokenFromHash(start.hash)).toBe(TA);
    expect(macFromHash(start.hash)).toEqual(both.mac);
    expect(isIconStart(start.hash)).toBe(true);
  });

  it("on the Mac's page, the away server rides as away=/at=", () => {
    const h = iconHash(both, MAC)!;
    expect(tokenFromHash(h)).toBe(TM);
    expect(halvesFromHash(h)).toEqual([{ role: "away", entry: both.away }]);
  });

  it("every URL is absolute on the page's origin; scope and id carry no token", () => {
    const m = iconManifest(AWAY, iconHash(both, AWAY)!);
    expect(m.scope).toBe(`${AWAY}/`);
    expect(m.id).toBe(`${AWAY}/`);
    expect(m.display).toBe("standalone");
    for (const i of m.icons as { src: string }[]) expect(i.src.startsWith(`${AWAY}/remote/`)).toBe(true);
    expect(JSON.stringify([m.scope, m.id, m.icons])).not.toContain(TA);
  });

  it("the token is never in a URL a request is made to: only the data: href and the start_url's fragment", () => {
    const m = decode(manifestHref(both, AWAY));
    const start = new URL(m.start_url as string);
    for (const t of [TA, TM]) {
      expect(start.origin + start.pathname + start.search).not.toContain(t);
      expect(start.hash).toContain(t);
    }
  });

  it("setManifest adds the link once and points it at the href", () => {
    const links: { rel: string; attrs: Record<string, string>; setAttribute: (k: string, v: string) => void; getAttribute: (k: string) => string | null }[] = [];
    const mk = () => {
      const l = {
        rel: "",
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          l.attrs[k] = v;
        },
        getAttribute(k: string) {
          return l.attrs[k] ?? null;
        },
      };
      return l;
    };
    const doc = {
      head: {
        querySelector: () => links.find((l) => l.rel === "manifest") ?? null,
        appendChild: (l: (typeof links)[number]) => links.push(l),
      },
      createElement: mk,
    } as unknown as Document;
    setManifest(doc, STATIC_MANIFEST);
    setManifest(doc, manifestHref(both, AWAY));
    expect(links).toHaveLength(1);
    expect(links[0].attrs.href.startsWith("data:")).toBe(true);
  });
});

describe("item 604: the icon's start never undoes a newer pairing", () => {
  const iconStart = iconHash(both, AWAY)!;
  const scan = `#token=${TA}&mac=${encodeURIComponent(MAC)}&mt=${TM}`;

  it("a first start from the icon pairs both hosts into its own (empty) storage", () => {
    expect(hostsAtLoad({}, iconStart, AWAY, pair)).toEqual(both);
  });

  it("a later start from the icon keeps a token pasted since", () => {
    const kept: Hosts = { away: { base: AWAY, token: TNEW }, mac: both.mac };
    expect(keepStored(kept, AWAY, iconStart)).toBe(true);
    expect(hostsAtLoad(kept, iconStart, AWAY, pair)).toEqual(kept);
  });

  it("a scan (no icon mark) pairs over what is kept, as before", () => {
    const kept: Hosts = { away: { base: AWAY, token: TNEW } };
    expect(isIconStart(scan)).toBe(false);
    expect(keepStored(kept, AWAY, scan)).toBe(false);
    expect(hostsAtLoad(kept, scan, AWAY, pair)).toEqual(both);
  });

  it("no token in the link: what is kept, unchanged", () => {
    expect(hostsAtLoad(both, "", AWAY, pair)).toBe(both);
    expect(hostsAtLoad(both, "#chat=x", AWAY, pair)).toBe(both);
  });

  it("a malformed away half is ignored", () => {
    expect(halvesFromHash(`#token=${TM}&away=javascript:alert(1)&at=${TA}`)).toEqual([]);
    expect(halvesFromHash(`#token=${TM}&away=${encodeURIComponent(AWAY)}&at=nope`)).toEqual([]);
  });
});
