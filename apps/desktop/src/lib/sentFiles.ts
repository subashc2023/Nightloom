/**
 * A file a reply sent (nightshift backlog 343): the `send_file` tool's
 * result, read back out of the turn so the reply draws it as a chip —
 * open, save, drag out on the Mac; a tap on the phone page.
 *
 * The tool's result ends with one line, `nightloom-sent-file: {json}`
 * (`send_file.rs`'s `result_text`); this is that line's one reader on this
 * side, shared by the window and the phone page. Read from the recorded
 * `tool_result`, so the chip comes back on reload and in the history.
 */

export interface SentFile {
  /** The copy's folder in Nightloom's store: 32 hex digits. */
  id: string;
  name: string;
  size: number;
  /** The copy, absolute — the window's Open, Save, Reveal and drag. */
  path: string;
  caption?: string;
}

export const SENT_MARKER = "nightloom-sent-file: ";

/** The tool on either engine: `send_file`, or `mcp__nightloom__send_file`.
 *  Exactly those two (343 review, 2026-10-12): another MCP server's
 *  `mcp__<server>__send_file` is not Nightloom's, and a chip drawn from its
 *  result would point Open and Reveal wherever that server said. */
export function isSendFile(name: string): boolean {
  return name === "send_file" || name === "mcp__nightloom__send_file";
}

/** The file one result carries, or null for anything else. The marker
 *  must be the result's last non-empty line, as `result_text` writes it —
 *  not any line (343 review): a line the model put in an argument that a
 *  message quotes back must never be read as a chip. */
export function parseSentFile(text: string): SentFile | null {
  const line = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .pop();
  if (!line || !line.startsWith(SENT_MARKER)) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(SENT_MARKER.length));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    !/^[0-9a-f]{32}$/i.test(o.id) ||
    typeof o.name !== "string" ||
    !o.name ||
    typeof o.size !== "number" ||
    typeof o.path !== "string" ||
    // The copy is always `<store>/<id>/<name>` (343 review): a path that
    // is not is not a copy this tool made.
    !o.path.endsWith(`/${o.id}/${o.name}`) ||
    o.name.includes("/")
  )
    return null;
  const out: SentFile = { id: o.id, name: o.name, size: o.size, path: o.path };
  if (typeof o.caption === "string" && o.caption) out.caption = o.caption;
  return out;
}

/** A tool call as either transcript holds it — the part this module reads. */
interface CallLike {
  name: string;
  result: { content: string; is_error: boolean } | null;
}

/** Every file the calls sent, in order, each once. */
export function sentFilesOfCalls(calls: CallLike[]): SentFile[] {
  const out: SentFile[] = [];
  for (const c of calls) {
    if (!isSendFile(c.name) || !c.result || c.result.is_error) continue;
    const f = parseSentFile(c.result.content);
    if (f && !out.some((o) => o.id === f.id)) out.push(f);
  }
  return out;
}

/** The phone page's route for one file (`/api/sent-files/{id}/{name}`). */
export function sentFileRoute(f: Pick<SentFile, "id" | "name">): string {
  return `/sent-files/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`;
}

/** The badge: the extension, upper-cased by the style, or "file". */
export function sentExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name);
  return m ? m[1].toLowerCase() : "file";
}

/** Whether a pointer moved far enough from where it went down to be a drag. */
export function isDragMove(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= 5;
}
