/**
 * The files a rewound turn wrote (nightshift item 259).
 *
 * A rewind takes a turn out of the conversation but not off the disk: on
 * 2026-09-28 Stuart 9's re-run read the rewound turn's brainstorm notes,
 * its HANDOFF.md and its appends to the memory files as real, and did the
 * wrong thing. So a rewind lists what the turns it removes wrote, read off
 * the log's tool calls before the rewind supersedes them, and offers to set
 * the files it *created* aside — moved to a dated folder, never deleted.
 *
 * What can be known: Write, Edit, MultiEdit and NotebookEdit name their
 * file, and Write's result says whether it created the file or replaced
 * one. A Bash command's writes can only be guessed from its text
 * (`> f`, `>> f`, `tee f`); those are listed as guesses. A subagent's own
 * calls are not in this chat's log and are not listed.
 */
import { invoke } from "@tauri-apps/api/core";
import type { SessionEvent } from "./types";

/** How a file was written: made by the turn, changed by it, or named by a
 *  shell command that looks like it wrote there. */
export type WriteKind = "created" | "edited" | "shell";

export interface RewoundWrite {
  path: string;
  how: WriteKind;
  /** The tool that wrote it last in the rewound turns. */
  tool: string;
}

/** What the transcript's card shows after a rewind that removed writes. */
export interface RewoundWrites {
  session: string | null;
  workspace: string | null;
  files: RewoundWrite[];
  /** Set once he chose: the folder the files went to, or "kept". */
  done: string | null;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.notebook_path ?? o.path;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

function inputCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const c = (input as Record<string, unknown>).command;
  return typeof c === "string" ? c : null;
}

/** A shell command without its heredoc bodies (their text is data, and a
 *  `>` in it is not a redirect) and without `-c`/`-e` script arguments. */
function commandText(command: string): string {
  const kept: string[] = [];
  let until: string | null = null;
  for (const line of command.split("\n")) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    kept.push(line);
    const h = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/);
    if (h) until = h[1] ?? h[2] ?? h[3];
  }
  return kept
    .join("\n")
    .replace(/\s-[ce]\s+("(?:[^"\\]|\\.)*"|'[^']*')/g, " -c ''");
}

/** A command split at its unquoted `&&`, `||`, `;` and newlines — a `;`
 *  inside a quoted sed script is not a break. */
function segments(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < text.length) {
        cur += c + text[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** `a/./b/../c` → `a/c`, for an absolute path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * The files a shell command's text redirects or tees into — a guess, and
 * a conservative one: `/dev/*`, `&1`-style descriptors and anything with a
 * `$` or a `~` in it are left out, since no path can be named for them.
 * A relative target after `cd <absolute folder>` in the same command is
 * read against that folder; otherwise it is left relative (to the chat's
 * folder, which is where the shell starts).
 */
export function shellTargets(command: string): string[] {
  const out: string[] = [];
  let cwd: string | null = null;
  const add = (raw: string) => {
    let p = raw.replace(/^["']|["']$/g, "");
    if (!p || p.startsWith("&") || p.startsWith("/dev/") || p.includes("$") || p.startsWith("~")) return;
    if (p.startsWith("/")) p = normalize(p);
    else if (cwd !== null) p = normalize(`${cwd}/${p}`);
    if (!out.includes(p)) out.push(p);
  };
  for (const segment of segments(commandText(command))) {
    const cd = segment.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s]+)\s*$/);
    if (cd) {
      const dir = cd[1].replace(/^["']|["']$/g, "");
      if (dir.startsWith("/")) cwd = normalize(dir);
      else if (cwd !== null && !dir.includes("$") && !dir.startsWith("~")) cwd = normalize(`${cwd}/${dir}`);
      else cwd = null;
      continue;
    }
    // `> file`, `>> file`, `1> file`; not `2>&1`, not `>=`/`=>` in text.
    for (const m of segment.matchAll(/(?:^|[\s|(])\d?>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) {
      add(m[1]);
    }
    // `sed -i '' 's/…/' file` (and perl -pi): the file it edits in place is
    // its last word once the quoted script is out.
    if (/^\s*(?:sed\s+(?:-[a-zA-Z]*\s+)*-i|perl\s+-[a-z]*i)/.test(segment)) {
      const words = segment
        .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ")
        .trim()
        .split(/\s+/);
      const last = words[words.length - 1];
      if (words.length > 2 && last && !last.startsWith("-")) add(last);
    }
    // `tee file`, `tee -a file other`.
    for (const m of segment.matchAll(/\btee((?:\s+-[a-z]+)*)((?:\s+(?:"[^"]+"|'[^']+'|[^\s;|&<>()-][^\s;|&<>()]*))+)/g)) {
      for (const f of m[2].trim().split(/\s+/)) add(f);
    }
  }
  return out;
}

/**
 * The files the live turns from event `to` on wrote, in the order first
 * written; a file written twice keeps its first kind, since what matters
 * is whether it existed before the turn. Failed calls are left out; a Write
 * with no result (a stopped turn) is listed as edited, not created, so it
 * is never moved without his tick.
 */
export function rewoundWrites(events: SessionEvent[], live: boolean[], to: number): RewoundWrite[] {
  const results = new Map<string, { content: string; error: boolean }>();
  for (let i = to; i < events.length; i++) {
    const e = events[i];
    if (live[i] && e.event === "tool_result") {
      results.set(e.tool_use_id, { content: e.content, error: e.is_error === true });
    }
  }
  const out: RewoundWrite[] = [];
  const seen = new Map<string, RewoundWrite>();
  const note = (path: string, how: WriteKind, tool: string) => {
    const had = seen.get(path);
    if (had) {
      had.tool = tool;
      return;
    }
    const w = { path, how, tool };
    seen.set(path, w);
    out.push(w);
  };
  for (let i = to; i < events.length; i++) {
    const e = events[i];
    if (!live[i] || e.event !== "assistant_message") continue;
    for (const b of e.blocks) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id);
      if (r?.error) continue;
      if (FILE_TOOLS.has(b.name)) {
        const path = inputPath(b.input);
        if (!path) continue;
        const created = b.name === "Write" && r !== undefined && /^File created/i.test(r.content);
        note(path, created ? "created" : "edited", b.name);
      } else if (b.name === "Bash") {
        const cmd = inputCommand(b.input);
        if (!cmd) continue;
        for (const p of shellTargets(cmd)) note(p, "shell", "Bash");
      }
    }
  }
  return out;
}

/** What `set_aside_files` did: the folder, what moved, what did not and why. */
export interface SetAsideResult {
  folder: string | null;
  moved: { from: string; to: string }[];
  skipped: { path: string; why: string }[];
}

/** Move `paths` into a dated folder outside the project (never deleted). */
export function setAsideFiles(chat: string | null, workspace: string | null, paths: string[]): Promise<SetAsideResult> {
  return invoke("set_aside_files", { chat, workspace, paths });
}
