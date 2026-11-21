/**
 * What a hand-off carries besides the model's prompt (nightshift item 747,
 * 2026-11-16; from item 736's survey, `736-synthesis-2026-11-16.md` §2 row 1
 * and `736-survey-B1-2026-11-16.md` A2–A4). Everything here is built from the
 * chat's own log, with no model judgement:
 *
 * - **the goal** — the prompt's own `Goal:` line, which the card shows as a
 *   field he can edit;
 * - **his messages the hand-off does not quote** — each of his messages in
 *   the chat, checked against what the wrap-up turn wrote (its reply and the
 *   files it wrote); the card lists the unquoted ones, tickable, and a ticked
 *   one goes to the next chat word for word. A summary that drops a rule is
 *   how a rule gets broken (ConstraintRot, arXiv 2606.22528, as the survey
 *   reports it), so the copy is his words, never a paraphrase;
 * - **the artifact list** — files edited and most read, commits, subagents
 *   and their report files, backlog items and blockers touched — read from
 *   the tool calls (file tracking is every summariser's weakest score in
 *   Factory's compression eval, same survey);
 * - **what the wrap-up cost** — the wrap-up turn's requests, tokens, time;
 * - **the section check** — which of the fixed sections the wrap-up asked
 *   for are in the `HANDOFF.md` text the turn wrote.
 *
 * Pure: the log in, plain data and text out, so it is tested without a
 * window and replayed over past chats (`notes/runner-design/747-probe/`).
 */
import type { SessionEvent } from "./types";

// ---- the wrap-up's addendum: the fixed sections ----

/** The first line of the addendum; its presence in a message means it is
 *  already there (a chat's own edited copy), so it is not added twice. */
export const SECTIONS_MARK = "Hand-off contents (added by Nightloom):";

/** The headings the HANDOFF.md section is asked to have, in order. */
export const SECTIONS = [
  "Goal",
  "His instructions in this chat (verbatim, dated)",
  "Done / In progress / Blocked",
  "Decisions",
  "Critical context",
  "Next steps",
] as const;

const KEEP_DROP =
  "Keep word for word, never summarised: file paths with their line numbers, function signatures, exact error " +
  "text, exact values and numbers, commit ids. Drop: logs, repeated reads, dead ends (keep each one's lesson in a line).";

const NO_FILE_LIST =
  "Do not spend the hand-off listing every file you read or changed: Nightloom adds that list (files, commits, " +
  "subagent reports, items), built from this chat's tool calls, to the next chat's first message.";

/**
 * What Nightloom adds under any wrap-up message — the built-in, his own
 * Settings text, a chat's own, a thread's — so the fixed sections reach a
 * hand-off whatever the message above says. `file`: whether this wrap-up
 * writes a HANDOFF.md section (false for a thread chat in a project without
 * one, whose memory is the thread's files and their own shape).
 */
export function sectionsAddendum(file: boolean): string {
  const lines = [SECTIONS_MARK];
  lines.push(
    'A. Open the next chat\'s prompt with one line starting "Goal: " — what the next chat is for, in a sentence. ' +
      "If I gave a goal below, use my words.",
  );
  if (file) {
    lines.push(
      "B. Give the new HANDOFF.md section these sub-headings (###), in this order, each present even when it only says \"none\":",
      "   - Goal — one or two sentences.",
      "   - His instructions in this chat (verbatim, dated) — every instruction, constraint, preference or correction " +
        'I gave in this chat that still binds the work ("don\'t touch X", "stop suggesting Y", a caution with its expiry): ' +
        "my exact words in quotation marks, each with its date and time, never paraphrased or merged.",
      "   - Done / In progress / Blocked — three lists; a commit by its id.",
      "   - Decisions — each with its reason.",
      "   - Critical context — what the next chat cannot cheaply find out again.",
      "   - Next steps — the queue in order, as the section's last list.",
      `C. ${KEEP_DROP}`,
      `D. ${NO_FILE_LIST}`,
    );
  } else {
    lines.push(
      "B. In the prompt, under the goal, quote every instruction, constraint or correction I gave in this chat that " +
        "still binds the work: my exact words in quotation marks, each with its date and time, never paraphrased.",
      `C. ${KEEP_DROP}`,
      `D. ${NO_FILE_LIST}`,
    );
  }
  return lines.join("\n");
}

/** The line his goal goes out on. */
export const GOAL_ASK = "Goal for the next chat (my words):";

/**
 * The wrap-up as it is sent: the message, the addendum (unless the message
 * already holds it), and his goal when he typed one. A blank message stays
 * blank — nothing sends a blank.
 */
export function wrapUpWithSections(message: string, goal: string, file: boolean): string {
  if (!message.trim()) return message;
  const parts = [message.trimEnd()];
  if (!message.includes(SECTIONS_MARK)) parts.push(sectionsAddendum(file));
  const g = goal.replace(/\s+/g, " ").trim();
  if (g) parts.push(`${GOAL_ASK} ${g}`);
  return parts.join("\n\n");
}

// ---- reading the log ----

type ToolUse = { id: string; name: string; input: Record<string, unknown> };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toolUses(e: SessionEvent): ToolUse[] {
  if (e.event !== "assistant_message") return [];
  const out: ToolUse[] = [];
  for (const b of e.blocks) {
    if (b.type !== "tool_use") continue;
    const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {};
    out.push({ id: b.id, name: b.name, input });
  }
  return out;
}

function replyText(e: SessionEvent): string {
  if (e.event !== "assistant_message") return "";
  return e.blocks.map((b) => (b.type === "text" ? b.text : "")).filter((t) => t).join("\n");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

function pathOf(t: ToolUse): string {
  return str(t.input.file_path) || str(t.input.notebook_path) || str(t.input.path);
}

/** The text a writing call put on disk, as far as its input says. */
function writtenText(t: ToolUse): string {
  if (t.name === "Write") return str(t.input.content);
  if (t.name === "Edit") return str(t.input.new_string);
  if (t.name === "NotebookEdit") return str(t.input.new_source);
  if (t.name === "MultiEdit" && Array.isArray(t.input.edits)) {
    return t.input.edits.map((x) => str((x as Record<string, unknown>)?.new_string)).join("\n");
  }
  if (t.name === "Bash") return str(t.input.command);
  return "";
}

// ---- his messages, and whether the hand-off quotes them ----

/** One of his messages, as the card lists it. */
export interface HisMessage {
  /** `m<log index>` for a message of this chat; `c<n>` for one carried in
   *  from an earlier chat by this same mechanism. */
  id: string;
  /** When he said it, as shown and as sent: "Nov 16, 2026, 2:58 PM". */
  when: string;
  text: string;
  /** Carried into this chat from an earlier one: ticked unless he unticks. */
  carried: boolean;
  /** The share of its words the hand-off repeats, 0..1. */
  quoted: number;
}

/** How many words in a row count as a quotation. */
export const QUOTE_RUN = 8;
/** A message is quoted when at least this share of its words is repeated. */
export const QUOTED_SHARE = 0.5;

/** Words as compared: lower case, quotes and dashes straightened, markup
 *  and punctuation at the edges dropped. */
export function quoteWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((w) => w);
}

/** Every run of `QUOTE_RUN` words in `text`, joined, for a set lookup. */
export function shingles(text: string, run = QUOTE_RUN): Set<string> {
  const w = quoteWords(text);
  const out = new Set<string>();
  for (let i = 0; i + run <= w.length; i++) out.add(w.slice(i, i + run).join(" "));
  return out;
}

/**
 * The share of a message's words that sit in a run of `QUOTE_RUN` words the
 * hand-off repeats; a message shorter than a run is quoted (1) when the
 * hand-off holds all of it in a row, else 0.
 */
export function quotedShare(message: string, handoffWords: string, handoffShingles: Set<string>, run = QUOTE_RUN): number {
  const w = quoteWords(message);
  if (w.length === 0) return 1;
  if (w.length < run) return ` ${handoffWords} `.includes(` ${w.join(" ")} `) ? 1 : 0;
  const covered = new Array<boolean>(w.length).fill(false);
  for (let i = 0; i + run <= w.length; i++) {
    if (!handoffShingles.has(w.slice(i, i + run).join(" "))) continue;
    for (let j = i; j < i + run; j++) covered[j] = true;
  }
  return covered.filter((c) => c).length / w.length;
}

/** A date as he reads it (practices §4: 12-hour): "Nov 16, 2026, 2:58 PM". */
export function whenText(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getHours();
  const m = d.getMinutes();
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h % 12 === 0 ? 12 : h % 12}:${m < 10 ? "0" : ""}${m} ${h < 12 ? "AM" : "PM"}`;
}

/** A message Nightloom sent for him, not his words: a wrap-up. */
export function isWrapUpText(text: string): boolean {
  return (
    text.includes(SECTIONS_MARK) ||
    /^This chat's context (window )?is (nearly full|filling)/.test(text.trimStart()) ||
    (text.includes("<handoff>") && text.includes("</handoff>") && /HANDOFF\.md|thread\.md/.test(text))
  );
}

// ---- the carried block: his ticked messages, as the next chat gets them ----

export const CARRIED_HEAD =
  "His instructions carried from earlier chats (his exact words, copied from the log by Nightloom; they still bind):";

/** One entry: a dated line, then his words as a quote. */
function carriedEntry(when: string, text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((l) => `  > ${l}`.trimEnd())
    .join("\n");
  return `- [${when}]\n${quote}`;
}

export function carriedBlock(items: readonly Pick<HisMessage, "when" | "text">[]): string {
  if (items.length === 0) return "";
  return [CARRIED_HEAD, ...items.map((m) => carriedEntry(m.when, m.text))].join("\n");
}

/** The entries of a carried block inside a first message, read back, so a
 *  rule he carried once is offered again at the next hand-off. */
export function parseCarried(text: string): { when: string; text: string }[] {
  const at = text.indexOf(CARRIED_HEAD);
  if (at < 0) return [];
  const out: { when: string; text: string }[] = [];
  let cur: { when: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur && cur.lines.join("\n").trim()) out.push({ when: cur.when, text: cur.lines.join("\n").trim() });
    cur = null;
  };
  for (const line of text.slice(at + CARRIED_HEAD.length).split("\n").slice(1)) {
    const head = /^- \[([^\]]+)\]\s*$/.exec(line);
    if (head) {
      flush();
      cur = { when: head[1], lines: [] };
      continue;
    }
    const q = /^ {2}>(?: (.*))?$/.exec(line);
    if (q && cur) {
      (cur as { lines: string[] }).lines.push(q[1] ?? "");
      continue;
    }
    break;
  }
  flush();
  return out;
}

// ---- the artifact list ----

export interface Artifacts {
  /** Files a writing tool changed, with how many calls, most-changed first. */
  edited: { path: string; count: number }[];
  /** Files read, with how many times, most-read first. */
  read: { path: string; count: number }[];
  /** Files named in shell commands (a `sed -n`, an `awk`, a script run), as
   *  written there, most-named first: on the Claude Code engine much reading
   *  goes through the shell, and no Read call records it. */
  shell: { path: string; count: number }[];
  commits: { sha: string; subject: string }[];
  subagents: { description: string; reports: string[] }[];
  /** "backlog 747", "blocker 1220": named by a path or a commit subject. */
  items: string[];
}

export function emptyArtifacts(a: Artifacts): boolean {
  return a.edited.length + a.read.length + a.shell.length + a.commits.length + a.subagents.length + a.items.length === 0;
}

/** A git commit line in a shell result, `[branch sha] subject` (also read by `chapters.ts`, item 799). */
export const COMMIT_LINE = /^\[([^\]\n]*?)\s([0-9a-f]{7,40})\]\s(.+)$/gm;
const REPORT_PATH = /[~\w./-]*report[\w.-]*\.md\b/gi;
const ITEM_PATH = /(?:^|\/)(backlog|blockers)\/(\d{1,5})-/g;
/** A file path as a shell command names it: optional folders, a name, one of
 *  the extensions a project's own files have. Not a URL, not a flag. */
const SHELL_PATH =
  /(?<![\w/:.@-])(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.(?:md|py|ts|tsx|js|mjs|rs|svelte|json|jsonl|sh|css|html|txt|toml|ya?ml|swift|csv|log)(?![\w/-])/g;

/** The file paths a shell command names, once each. */
export function shellPaths(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(SHELL_PATH)) {
    // A URL's tail (`https://host/a.json`) is not a file here.
    if (/[a-z]+:\/\/\S*$/i.test(command.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0))) continue;
    out.add(m[0]);
  }
  return Array.from(out);
}

function byCount(m: Map<string, number>): { path: string; count: number }[] {
  // Most calls first; a tie keeps the later-touched file ahead (a Map keeps
  // insertion order, and a re-touched path is re-inserted at the end).
  return Array.from(m, ([path, count]) => ({ path, count }))
    .reverse()
    .sort((a, b) => b.count - a.count);
}

/**
 * The artifact list of a chat, from its tool calls up to `upTo` (a log
 * index, inclusive). Calls whose result was an error do not count. What a
 * shell command wrote is not seen — only the writing tools' own calls.
 */
export function artifactsOf(events: readonly SessionEvent[], live: readonly boolean[], upTo: number): Artifacts {
  const failed = new Set<string>();
  const results = new Map<string, string>();
  for (let i = 0; i <= upTo && i < events.length; i++) {
    const e = events[i];
    if (!live[i] || e.event !== "tool_result") continue;
    if (e.is_error) failed.add(e.tool_use_id);
    results.set(e.tool_use_id, e.content);
  }
  const edited = new Map<string, number>();
  const read = new Map<string, number>();
  const shell = new Map<string, number>();
  const commits: Artifacts["commits"] = [];
  const subagents: Artifacts["subagents"] = [];
  const items = new Set<string>();
  const bump = (m: Map<string, number>, p: string) => {
    const n = m.get(p) ?? 0;
    m.delete(p);
    m.set(p, n + 1);
  };
  const noteItems = (text: string) => {
    for (const m of text.matchAll(ITEM_PATH)) items.add(`${m[1] === "backlog" ? "backlog" : "blocker"} ${Number(m[2])}`);
  };
  for (let i = 0; i <= upTo && i < events.length; i++) {
    if (!live[i]) continue;
    for (const t of toolUses(events[i])) {
      if (failed.has(t.id)) continue;
      const p = pathOf(t);
      if (EDIT_TOOLS.has(t.name) && p) {
        bump(edited, p);
        noteItems(p);
      } else if (t.name === "Read" && p) {
        bump(read, p);
        noteItems(p);
      } else if (t.name === "Bash") {
        noteItems(str(t.input.command));
        for (const sp of shellPaths(str(t.input.command))) bump(shell, sp);
        for (const m of (results.get(t.id) ?? "").matchAll(COMMIT_LINE)) {
          if (commits.some((c) => c.sha === m[2])) continue;
          commits.push({ sha: m[2], subject: m[3].trim() });
          const ids = /^(\d{1,5}(?:\s*\+\s*\d{1,5})*):/.exec(m[3].trim());
          if (ids) for (const id of ids[1].split("+")) items.add(`backlog ${Number(id.trim())}`);
        }
      } else if (AGENT_TOOLS.has(t.name)) {
        const text = `${str(t.input.prompt)}\n${results.get(t.id) ?? ""}`;
        const reports = Array.from(new Set(Array.from(text.matchAll(REPORT_PATH), (m) => m[0])));
        subagents.push({ description: str(t.input.description) || str(t.input.subagent_type) || "subagent", reports });
        noteItems(str(t.input.prompt));
      }
    }
  }
  const order = (s: string) => [s.startsWith("backlog") ? 0 : 1, Number(s.split(" ")[1])] as const;
  return {
    edited: byCount(edited),
    read: byCount(read),
    shell: byCount(shell),
    commits,
    subagents,
    items: Array.from(items).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]),
  };
}

/** The folder every path sits under, with its end slash; "" when there is
 *  none worth naming (one path, or nothing shared past the root). */
export function commonDir(paths: readonly string[]): string {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2 || abs.length !== paths.length) return "";
  let prefix = abs[0].slice(0, abs[0].lastIndexOf("/") + 1);
  for (const p of abs) {
    while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
  }
  return prefix.split("/").filter((s) => s).length >= 2 ? prefix : "";
}

export const MAX_EDITED = 25;
export const MAX_READ = 20;
export const MAX_SHELL = 40;
export const MAX_COMMITS = 20;
export const MAX_SUBAGENTS = 15;

function capped<T>(rows: readonly T[], max: number, show: (r: T) => string, sep: string): string {
  const head = rows.slice(0, max).map(show).join(sep);
  return rows.length > max ? `${head}${sep}+${rows.length - max} more` : head;
}

export const ARTIFACTS_HEAD = "From the previous chat's tool calls (listed by Nightloom from the log, not written by the model):";

/** The artifact list as the next chat reads it; "" when there is nothing. */
export function artifactsText(a: Artifacts): string {
  if (emptyArtifacts(a)) return "";
  const dir = commonDir([...a.edited, ...a.read].map((f) => f.path));
  const rel = (p: string) => (dir && p.startsWith(dir) ? p.slice(dir.length) : p);
  const file = (f: { path: string; count: number }) => (f.count > 1 ? `${rel(f.path)} ×${f.count}` : rel(f.path));
  const lines = [ARTIFACTS_HEAD];
  if (dir) lines.push(`Paths are under ${dir}`);
  if (a.edited.length) lines.push(`Files edited (${a.edited.length}): ${capped(a.edited, MAX_EDITED, file, ", ")}`);
  if (a.read.length) lines.push(`Files read most (of ${a.read.length}): ${capped(a.read, MAX_READ, file, ", ").replace(/, \+\d+ more$/, "")}`);
  if (a.shell.length) {
    lines.push(`Files named most in shell commands (of ${a.shell.length}): ${capped(a.shell, MAX_SHELL, file, ", ").replace(/, \+\d+ more$/, "")}`);
  }
  if (a.commits.length) {
    lines.push(`Commits (${a.commits.length}):`);
    for (const c of a.commits.slice(-MAX_COMMITS)) lines.push(`- ${c.sha.slice(0, 8)} ${c.subject}`);
    if (a.commits.length > MAX_COMMITS) lines.splice(lines.length - MAX_COMMITS, 0, `- (${a.commits.length - MAX_COMMITS} earlier ones not listed)`);
  }
  if (a.subagents.length) {
    lines.push(`Subagents launched (${a.subagents.length}):`);
    for (const s of a.subagents.slice(-MAX_SUBAGENTS)) {
      lines.push(`- ${s.description}${s.reports.length ? ` — report: ${s.reports.join(", ")}` : ""}`);
    }
    if (a.subagents.length > MAX_SUBAGENTS) lines.splice(lines.length - MAX_SUBAGENTS, 0, `- (${a.subagents.length - MAX_SUBAGENTS} earlier ones not listed)`);
  }
  if (a.items.length) lines.push(`Items touched: ${a.items.join(", ")}`);
  return lines.join("\n");
}

/** One line for the card's fold: "12 files edited · 3 commits · …". */
export function artifactsSummary(a: Artifacts): string {
  const n = (count: number, one: string, many: string) => (count ? `${count} ${count === 1 ? one : many}` : "");
  return [
    n(a.edited.length, "file edited", "files edited"),
    n(a.read.length, "file read", "files read"),
    n(a.shell.length, "file in shell commands", "files in shell commands"),
    n(a.commits.length, "commit", "commits"),
    n(a.subagents.length, "subagent", "subagents"),
    n(a.items.length, "item", "items"),
  ]
    .filter((s) => s)
    .join(" · ");
}

// ---- what the wrap-up cost ----

export interface WrapCost {
  requests: number;
  output: number;
  /** Input over every request of the turn, and its cached parts. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars as recorded; null when any request was unpriced. */
  dollars: number | null;
  /** From his wrap-up message to the reply; null when a stamp is unreadable. */
  seconds: number | null;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

function fmtSpan(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "The wrap-up cost 4 requests, 6.2k tokens written, 1.2M read (1.1M from cache), 2m 10s". */
export function costText(c: WrapCost | null): string {
  if (!c || c.requests === 0) return "";
  const parts = [
    `${c.requests} ${c.requests === 1 ? "request" : "requests"}`,
    `${fmtK(c.output)} tokens written`,
    `${fmtK(c.input)} read${c.cacheRead ? ` (${fmtK(c.cacheRead)} from cache)` : ""}`,
  ];
  if (c.seconds !== null) parts.push(fmtSpan(c.seconds));
  if (c.dollars !== null && c.dollars > 0) parts.push(`$${c.dollars.toFixed(2)}`);
  return `The wrap-up cost ${parts.join(", ")}`;
}

// ---- the goal line ----

const GOAL_LINE = /^\s*(?:\*\*)?goal(?:\*\*)?\s*[:—-]\s*(?:\*\*)?\s*(.+?)\s*$/i;

/** The prompt's own goal — its first line, when that line names one — and
 *  the rest. */
export function splitGoal(prompt: string): { goal: string; body: string } {
  const text = prompt.trim();
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const m = GOAL_LINE.exec(first);
  if (!m) return { goal: "", body: text };
  return { goal: m[1].trim(), body: nl < 0 ? "" : text.slice(nl + 1).trim() };
}

// ---- the whole of it, for one reply's card ----

export interface Carry {
  /** The prompt's own goal ("" when it names none) and the prompt without it. */
  goal: string;
  body: string;
  /** His messages the hand-off does not quote, oldest first; carried ones lead. */
  unquoted: HisMessage[];
  /** Item 850: every message of his since the last hand-off (carried ones
   *  lead), oldest first — all go to the next chat word for word, capped. */
  words: HisMessage[];
  /** How many of his messages there were, and how many the hand-off quotes. */
  messages: number;
  quoted: number;
  artifacts: Artifacts;
  cost: WrapCost | null;
  /** The fixed sections missing from the HANDOFF.md text this turn wrote;
   *  null when the turn wrote no HANDOFF.md (nothing to check). */
  missing: string[] | null;
}

export interface CarryInput {
  events: readonly SessionEvent[];
  /** `liveFlags(events)`. */
  live: readonly boolean[];
  /** The log index of the reply that holds the prompt. */
  reply: number;
  prompt: string;
  /** `editTexts(events)`: a user message's text after his edit, else null. */
  edited?: readonly (string | null)[];
  /** `elideFlags(events)`: messages he removed from the conversation. */
  elided?: readonly boolean[];
}

export function buildCarry(inp: CarryInput): Carry {
  const { events, live, reply } = inp;
  const { goal, body } = splitGoal(inp.prompt);
  // The turn that wrote the hand-off: from his last message before the reply.
  let ask = -1;
  for (let i = Math.min(reply, events.length) - 1; i >= 0; i--) {
    if (live[i] && events[i].event === "user_message") {
      ask = i;
      break;
    }
  }
  // What the hand-off says: the turn's replies and what its calls wrote.
  const said: string[] = [];
  const handoffFile: string[] = [];
  let requests = 0;
  let output = 0;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let dollars: number | null = 0;
  for (let i = Math.max(ask, 0); i <= reply && i < events.length; i++) {
    const e = events[i];
    if (!live[i] || e.event !== "assistant_message") continue;
    said.push(replyText(e));
    for (const t of toolUses(e)) {
      const w = writtenText(t);
      if (w) said.push(w);
      if (EDIT_TOOLS.has(t.name) && /(^|\/)HANDOFF\.md$/.test(pathOf(t))) handoffFile.push(w);
    }
    requests++;
    output += e.usage.output_tokens;
    input += e.usage.input_tokens;
    cacheRead += e.usage.cache_read_tokens ?? 0;
    cacheWrite += e.usage.cache_write_tokens ?? 0;
    dollars = dollars === null || e.cost === undefined ? null : dollars + e.cost;
  }
  let seconds: number | null = null;
  const end = events[reply];
  const start = ask >= 0 ? events[ask] : undefined;
  if (start && end && "at" in start && "at" in end) {
    const span = (new Date(end.at).getTime() - new Date(start.at).getTime()) / 1000;
    seconds = Number.isFinite(span) && span >= 0 ? span : null;
  }
  const cost: WrapCost | null = requests ? { requests, output, input, cacheRead, cacheWrite, dollars, seconds } : null;

  const handoffText = said.join("\n");
  const words = quoteWords(handoffText).join(" ");
  const set = shingles(handoffText);
  const measure = (text: string) => quotedShare(text, words, set);

  const his: HisMessage[] = [];
  const first = events[0];
  const continues = first?.event === "session_created" && first.forked_from?.reason === "handoff";
  let seenFirst = false;
  for (let i = 0; i < events.length && i < (ask < 0 ? reply : ask); i++) {
    const e = events[i];
    if (!live[i] || e.event !== "user_message") continue;
    const text = (inp.edited?.[i] ?? e.text).trim();
    const isFirst = !seenFirst;
    seenFirst = true;
    // The first message of a continued chat is the earlier hand-off's prompt:
    // not his words, but it holds the ones he carried.
    const carried = parseCarried(text);
    if (carried.length > 0 || (isFirst && continues)) {
      carried.forEach((c, n) => his.push({ id: `c${i}.${n}`, when: c.when, text: c.text, carried: true, quoted: measure(c.text) }));
      continue;
    }
    if (inp.elided?.[i] || !text || isWrapUpText(text)) continue;
    his.push({ id: `m${i}`, when: whenText(e.at), text, carried: false, quoted: measure(text) });
  }
  const unquoted = his.filter((m) => m.quoted < QUOTED_SHARE);

  let missing: string[] | null = null;
  if (handoffFile.length > 0) {
    const file = handoffFile.join("\n").toLowerCase();
    missing = SECTIONS.filter((s) => !new RegExp(`^#{2,4}\\s*${s.split(" ")[0].toLowerCase()}`, "m").test(file));
  }

  return {
    goal,
    body,
    unquoted: [...unquoted.filter((m) => m.carried), ...unquoted.filter((m) => !m.carried)],
    words: [...his.filter((m) => m.carried), ...his.filter((m) => !m.carried)],
    messages: his.length,
    quoted: his.length - unquoted.length,
    artifacts: artifactsOf(events, live, reply),
    cost,
    missing,
  };
}

/**
 * Item 850: the cap on his words carried to the next chat, the auto
 * hand-off's (`crates/nightloom-service/src/hand_off.rs` `WORDS_CAP_TOKENS`,
 * ~4 characters a token): the newest are kept, the oldest past it dropped
 * and counted. No model in between.
 */
export const WORDS_CAP_TOKENS = 15_000;

/** His words within the cap, newest first as `brief_in` takes them, given
 *  back oldest first; `dropped` counts the older ones past it. */
export function capWords<T extends Pick<HisMessage, "when" | "text">>(items: readonly T[]): { kept: T[]; dropped: number } {
  let budget = WORDS_CAP_TOKENS * 4;
  const kept: T[] = [];
  let dropped = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const len = carriedEntry(items[i].when, items[i].text).length + 1;
    if (len > budget) {
      dropped++;
      continue;
    }
    budget -= len;
    kept.push(items[i]);
  }
  kept.reverse();
  return { kept, dropped };
}

/** The line under the carried block when some were past the cap. */
export function droppedNote(dropped: number): string {
  return `(${dropped} older message${dropped === 1 ? "" : "s"} of his ${dropped === 1 ? "is" : "are"} past the ${WORDS_CAP_TOKENS}-token cap — search the earlier chat for ${dropped === 1 ? "it" : "them"}.)`;
}

/**
 * The next chat's first message: the goal line (his edit, else the
 * prompt's own), the model's prompt, ~~his ticked messages~~ every message
 * of his since the last hand-off word for word within the cap (item 850),
 * the artifact list and the cost line. With no goal, no words of his and no
 * tool calls it is the prompt unchanged.
 */
export function composeFirstMessage(carry: Carry, goal: string | null): string {
  const g = (goal ?? carry.goal).replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  if (g) parts.push(`Goal: ${g}`);
  if (carry.body) parts.push(carry.body);
  const { kept, dropped } = capWords(carry.words);
  const carried = carriedBlock(kept);
  if (carried) parts.push(dropped ? `${carried}\n${droppedNote(dropped)}` : carried);
  const list = artifactsText(carry.artifacts);
  const cost = costText(carry.cost);
  if (list) parts.push(cost ? `${list}\n${cost}.` : list);
  return parts.join("\n\n");
}
