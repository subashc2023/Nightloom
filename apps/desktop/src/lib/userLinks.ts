/**
 * Item 1029: links in words he typed. Only the URL is drawn as a link; every other
 * character stays exactly as typed (no markdown), so copying gives his original text.
 * Matches `http(s)://…` and `www.…` (the reply's own rule: marked's GFM autolinks);
 * trailing punctuation and an unmatched closing bracket stay outside the link.
 */
export type LinkPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimUrl(u: string): string {
  for (;;) {
    const last = u[u.length - 1];
    if (last && ".,;:!?'*_~".includes(last)) {
      u = u.slice(0, -1);
    } else if (last && OPEN[last]) {
      const opens = u.split(OPEN[last]).length - 1;
      const closes = u.split(last).length - 1;
      if (closes > opens) u = u.slice(0, -1);
      else return u;
    } else return u;
  }
}

export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    // A bare "www." or "https://" with nothing after it is not a link.
    if (!/^(?:https?:\/\/|www\.)[^\s./]/i.test(url)) continue;
    const i = m.index ?? 0;
    if (i > at) out.push({ kind: "text", text: text.slice(at, i) });
    out.push({ kind: "link", text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    at = i + url.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
