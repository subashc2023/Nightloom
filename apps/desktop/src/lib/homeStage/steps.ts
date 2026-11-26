/**
 * Home's steps (item 845): the Home chat's own tool calls, in plain words, newest last — what the Steps panel on
 * every view draws. Pure, so it is tested without a page. Never shows a tool's raw arguments (his note on round 4:
 * "plain words not JSON"); the detail rows carry one short, cleaned value at most.
 */
export interface StepRow {
  key: string;
  kind: "do" | "say" | "you";
  icon: string;
  title: string;
  out: string;
  detail: [string, string][];
  at: string | null;
}
interface Block {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}
export interface Ev {
  event: string;
  text?: string;
  at?: string;
  blocks?: Block[];
}

const WORDS: [RegExp, string, string][] = [
  [/^update_task$/, "Updated the stage", "play"],
  [/^start_chat$/, "Planned a chat in a project", "play"],
  [/^send_chat$/, "Sent into a project's chat", "reply"],
  [/^chat_status$/, "Checked what it routed", "refresh"],
  [/^search_chats$/, "Searched your chats", "grep"],
  [/^read_chat$/, "Read a chat", "read"],
  [/^remember$/, "Saved a memory", "note"],
  [/^AskUserQuestion$/, "Asked you a question", "reply"],
  [/^request_secret$/, "Asked you for a secret, on its card", "reply"],
  [/^ask_user_to_drive$/, "Asked you to take the page", "globe"],
  [/gmail|mail/i, "Read your mail", "read"],
  [/calendar/i, "Checked your calendar", "updown"],
  [/drive|docs|sheets/i, "Read your documents", "read"],
  [/notion/i, "Read Notion", "read"],
  [/playwright|browser/i, "Used its browser", "globe"],
  [/^(WebSearch|web_search)$/, "Searched the web", "grep"],
  [/^(WebFetch|fetch_page)$/, "Read a web page", "globe"],
  [/^Read$/, "Read a file", "read"],
  [/^(Grep|Glob)$/, "Searched files", "grep"],
  [/^Bash$/, "Ran a command", "play"],
  [/^(Agent|Task)$/, "Started a helper", "play"],
];

/** A tool's name in plain words, with its icon. */
export function toolWords(name: string): [string, string] {
  // Nightloom's own tools reach Claude Code as `mcp__<server>__<tool>`: match the bare name too.
  const own = name.replace(/^mcp__.*__/, "");
  const hit = WORDS.find(([re]) => re.test(name) || re.test(own));
  if (hit) return [hit[1], hit[2]];
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").replace(/_/g, " ");
  return [`Used ${bare || "a tool"}`, "play"];
}

const SAFE_KEYS = ["description", "query", "pattern", "url", "project", "file_path", "path", "name", "task", "doing", "what"];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// Item 809: a reply's one-line summary in plain words — its Markdown marks (headings, bold, code ticks, bullets,
// link targets) showed raw ("…the rest is handled. ## Needs you · …"). The step's detail keeps the text as written.
export const plainLine = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*(?:[-*+]|\d+\.)\s+/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim()
    .replace(/\s+/g, " ");

/** One short value from a tool's input — never a secret-looking key, never the whole object. */
export function toolNote(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const k of SAFE_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return cut(v.trim().replace(/\s+/g, " "), 90);
  }
  return "";
}

/** The steps of the chat's last `turns` turns (a turn starts at his message). */
export function stepsOf(events: readonly Ev[], turns = 3, isScan: (t: string) => boolean = () => false): StepRow[] {
  const starts: number[] = [];
  events.forEach((e, i) => e.event === "user_message" && starts.push(i));
  const from = starts.length > turns ? starts[starts.length - turns] : 0;
  const out: StepRow[] = [];
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.event === "user_message") {
      const scan = isScan(e.text ?? "");
      out.push({ key: `u${i}`, kind: "you", icon: "reply", title: scan ? "The morning scan started" : `You: ${cut(plainLine(e.text ?? ""), 80)}` /* item 999: his words, not their marks */, out: "", detail: [["From", scan ? "The scan, on its schedule" : "You, in the message box"]], at: e.at ?? null });
    } else if (e.event === "assistant_message") {
      (e.blocks ?? []).forEach((b, j) => {
        if (b.type === "tool_use" && b.name) {
          const [title, icon] = toolWords(b.name);
          const note = toolNote(b.input);
          out.push({ key: `t${i}.${j}`, kind: "do", icon, title, out: note, detail: [["Tool", b.name.replace(/^mcp__/, "").replace(/__/g, " · ")], ...(note ? ([["About", note]] as [string, string][]) : [])], at: e.at ?? null });
        } else if (b.type === "text" && b.text?.trim()) {
          out.push({ key: `s${i}.${j}`, kind: "say", icon: "chat", title: "Told you", out: cut(plainLine(b.text), 120), detail: [["Said", cut(b.text.trim(), 600)]], at: e.at ?? null });
        }
      });
    }
  }
  return out;
}

/** His last message and Home's words after it — what the reply strip shows. */
export function lastExchange(events: readonly Ev[], isScan: (t: string) => boolean = () => false): { him: string; at: string; home: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "user_message" || isScan(e.text ?? "")) continue;
    let home = "";
    for (let k = i + 1; k < events.length; k++) {
      const a = events[k];
      if (a.event === "user_message") break;
      if (a.event === "assistant_message") for (const b of a.blocks ?? []) if (b.type === "text" && b.text?.trim()) home = b.text.trim();
    }
    return { him: (e.text ?? "").trim(), at: e.at ?? String(i), home };
  }
  return null;
}
