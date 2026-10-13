/**
 * "Where in your memory does it say X?" (nightshift backlog 296): reading a
 * `memory_where` result back out of a turn, so the reply can draw every hit
 * as a link that opens the note editor at that line, with a Strike beside it.
 *
 * The tool's reply is text the model reads (`memory_where.rs`'s `render`):
 * a `## <layer> — <loading>( (<note>))?` heading per group and one
 * `<path>:<line>: <text>` line per hit. This is that format's one reader on
 * this side; the Rust `parse_hit_line` test pins the same shape.
 */

export type Loading = "every" | "demand";

export interface MemoryHit {
  path: string;
  line: number;
  text: string;
}

export interface MemoryGroup {
  layer: string;
  loading: Loading;
  /** A qualifier on "every chat": "Chat-kind chats only", … */
  note: string | null;
  hits: MemoryHit[];
}

/** The tool on either engine: `memory_where`, or `mcp__nightloom__memory_where`. */
export function isMemoryWhere(name: string): boolean {
  return name === "memory_where" || name.endsWith("__memory_where");
}

const HEADING = /^## (.+?) — (loaded into every chat|read on demand)(?: \((.+)\))?$/;
const HIT = /^(.+?):(\d+): (.*)$/;

/** The groups of one result. Lines before the first heading are the summary. */
export function parseMemoryReply(text: string): MemoryGroup[] {
  const out: MemoryGroup[] = [];
  let group: MemoryGroup | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const h = HEADING.exec(line);
    if (h) {
      group = {
        layer: h[1],
        loading: h[2] === "read on demand" ? "demand" : "every",
        note: h[3] ?? null,
        hits: [],
      };
      out.push(group);
      continue;
    }
    if (!group) continue;
    const m = HIT.exec(line);
    if (!m) continue;
    const path = m[1];
    if (!(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) continue;
    group.hits.push({ path, line: Number(m[2]), text: m[3] });
  }
  return out.filter((g) => g.hits.length > 0);
}

/** A tool call as the transcript holds it — the part this module reads. */
interface CallLike {
  name: string;
  result: { content: string; is_error: boolean } | null;
}

/**
 * Every hit the turn's `memory_where` calls returned, groups merged by
 * layer and loading, a hit seen twice kept once.
 */
export function hitsOfCalls(calls: CallLike[]): MemoryGroup[] {
  const out: MemoryGroup[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    if (!isMemoryWhere(c.name) || !c.result || c.result.is_error) continue;
    for (const g of parseMemoryReply(c.result.content)) {
      let into = out.find((o) => o.layer === g.layer && o.loading === g.loading && o.note === g.note);
      if (!into) {
        into = { ...g, hits: [] };
        out.push(into);
      }
      for (const h of g.hits) {
        const key = `${h.path}:${h.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        into.hits.push(h);
      }
    }
  }
  return out.filter((g) => g.hits.length > 0);
}

/** The character offset of the start of 1-based `line` in `text` (clamped). */
export function lineOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return at;
    at = next + 1;
  }
  return at;
}

/** `…/memory/stuart.md` — the last two parts of a path, for a row's label. */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

/** Hit references in reply text: `name.md:12`, with any path before it. */
const REF = /(~?[\w./\\-]*\/)?([\w.-]+\.(?:md|markdown|txt)):(\d+)/g;

/**
 * Where in `text` a hit is named, as the model was asked to name it
 * (`path:line`): each match with the hit it means. A reference resolves to
 * a hit with the same line whose path ends with what the reply wrote (a `~`
 * stripped), so `~/.nightloom/AGENTS.md:12` and `AGENTS.md:12` both find
 * it; an ambiguous bare name (two files called AGENTS.md) resolves to
 * nothing rather than to a guess.
 */
export function findRefs(text: string, hits: MemoryHit[]): { start: number; end: number; hit: MemoryHit }[] {
  const out: { start: number; end: number; hit: MemoryHit }[] = [];
  for (const m of text.matchAll(REF)) {
    const line = Number(m[3]);
    const written = `${m[1] ?? ""}${m[2]}`.replace(/\\/g, "/").replace(/^~/, "");
    const tail = written.startsWith("/") ? written : `/${written}`;
    const at = (t: string) => hits.filter((h) => h.line === line && h.path.replace(/\\/g, "/").endsWith(t));
    let found = at(tail);
    // A path the reply shortened its own way: the file name alone, if unique.
    if (found.length === 0) found = at(`/${m[2]}`);
    if (found.length !== 1) continue;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, hit: found[0] });
  }
  return out;
}
