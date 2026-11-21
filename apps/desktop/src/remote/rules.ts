/**
 * The approval rules sheet's words and shapes (nightshift item 743). The
 * rules themselves live on the host (`approval_rules.rs`: one file for
 * every chat, one in the chat's own folder) and the host decides what is
 * valid; this file is what the phone shows and sends.
 */

export type RuleAction = "allow" | "ask" | "block";
export type RuleScope = "all" | "chat";

/** One row of `GET /api/rules`. */
export interface RuleRow {
  id: string;
  action: RuleAction;
  tool: string;
  text: string;
  scope: RuleScope;
  /** `grant`: the card's "Allow for this chat", listed as an allow rule.
   *  `read` (item 783): a connector action he answered "Allow always" to in
   *  a read-only chat — it runs there without asking; it can only be removed. */
  source: "rule" | "grant" | "read";
}

export interface RulesListing {
  rules: RuleRow[];
  /** What happens to a call no rule names — the host's sentences. */
  defaults: string[];
  /** The tools the form offers by name. */
  tools: string[];
  /** Whether a chat was named: "this chat" is offered only then. */
  chat: boolean;
  subagents_auto?: boolean;
  /** Item 783: what the last sync between the Mac and the away server had
   *  to say — a rule both changed, kept twice. Absent when nothing. */
  notes?: string[];
}

export type RuleEdit =
  | { op: "add"; scope: RuleScope; action: RuleAction; tool: string; text: string }
  | { op: "change"; id: string; action: RuleAction; tool: string; text: string }
  | { op: "remove"; id: string }
  | { op: "dismiss" };

/** The form, for a new rule (`id` null) or one being changed. */
export interface RuleForm {
  id: string | null;
  action: RuleAction;
  /** A name from the listing's `tools`, or `mcp` for a connector's. */
  tool: string;
  /** The connector tool's name when `tool` is `mcp`. */
  mcp: string;
  text: string;
  scope: RuleScope;
}

export const ACTIONS: { action: RuleAction; label: string; head: string; says: string }[] = [
  { action: "block", label: "Block", head: "Blocked", says: "Refused without asking you; the model is told a rule blocked it." },
  { action: "ask", label: "Ask", head: "Asks first", says: "Shows you the card, even where the tool is allowed." },
  { action: "allow", label: "Allow", head: "Allowed", says: "Runs without asking you." },
];

/** The connector choice in the tool list. */
export const MCP = "mcp";

export function blankForm(chat: boolean): RuleForm {
  return { id: null, action: "ask", tool: "Bash", mcp: "", text: "", scope: chat ? "chat" : "all" };
}

/** A row opened for changing. */
export function formOf(row: RuleRow, tools: string[]): RuleForm {
  const named = tools.includes(row.tool);
  return { id: row.id, action: row.action, tool: named ? row.tool : MCP, mcp: named ? "" : row.tool, text: row.text, scope: row.scope };
}

/** The tool a form names. */
export function formTool(f: RuleForm): string {
  return (f.tool === MCP ? f.mcp : f.tool).trim();
}

/** Why the form cannot be saved yet, or null. The host checks the rest. */
export function formProblem(f: RuleForm): string | null {
  const tool = formTool(f);
  if (!tool) return "Name the connector tool (mcp__name__tool, or mcp__name__* for all of one connector's).";
  if (f.tool === MCP && !tool.startsWith("mcp__")) return "A connector tool's name starts with mcp__.";
  return null;
}

export function editOf(f: RuleForm): RuleEdit {
  const body = { action: f.action, tool: formTool(f), text: f.text.trim() };
  return f.id === null ? { op: "add", scope: f.scope, ...body } : { op: "change", id: f.id, ...body };
}

/** What the text box is looking in, by tool — its label. */
export function textLabel(tool: string): string {
  switch (tool) {
    case "Bash":
      return "the command";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "the file's path";
    case "WebFetch":
      return "the address";
    case "WebSearch":
      return "the search";
    default:
      return "the call's input";
  }
}

/** How the text is matched, for the form's hint — the host's rule, said plainly. */
export function matchHint(action: RuleAction, tool: string): string {
  if (action === "allow" && tool === "Bash") {
    return "Allows one plain command that starts with this text — not one chained with &&, ;, a pipe or a redirect, which still asks. * stands for anything.";
  }
  return "Matches when this text appears anywhere in it. * stands for anything. Leave it empty for every call of the tool.";
}

/** A row in one line: the tool, and what the call must name. */
export function ruleLine(r: Pick<RuleRow, "tool" | "text">): string {
  const text = r.text.trim();
  return text ? `${r.tool} · ${text}` : `${r.tool} · every call`;
}

export function scopeLabel(r: Pick<RuleRow, "scope" | "source">): string {
  if (r.source === "grant") return "This chat · from “Allow for this chat”";
  if (r.source === "read") return "Read-only chats · from “Allow always”";
  // Item 783: one set for both hosts.
  return r.scope === "chat" ? "This chat" : "Every chat · Mac and Away";
}

/** The rows under each head, in the order the host decides them; a head
 *  with no rows is left out. */
export function grouped(rules: RuleRow[]): { head: string; action: RuleAction; rows: RuleRow[] }[] {
  return ACTIONS.map((a) => ({ head: a.head, action: a.action, rows: rules.filter((r) => r.action === a.action) })).filter((g) => g.rows.length > 0);
}

/** What removing a rule does, for the confirm. */
export function removeWords(r: RuleRow): string {
  const what = r.text.trim() ? `${r.tool} calls naming “${r.text.trim()}”` : `${r.tool} calls`;
  if (r.source === "read") return `${what} will ask you again in read-only chats, on the Mac and Away.`;
  switch (r.action) {
    case "block":
      return `${what} will no longer be blocked — they go back to asking you, or to another rule that names them.`;
    case "ask":
      return `${what} will no longer always ask — an allow rule that names them applies again.`;
    case "allow":
      return `${what} will ask you again${r.scope === "chat" ? " in this chat" : ""}.`;
  }
}

/** A connector tool's name as he would say it (item 783):
 *  `mcp__claude_ai_Gmail__send_message` → `Gmail · send message`. */
export function connectorWords(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  // Nightloom's own tool (item 872: Home's Reminders writer) is no
  // connector: its words alone — "update reminders".
  if (m[1] === "nightloom") return m[2].replace(/[_-]/g, " ");
  const server = m[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
  return `${server} · ${m[2].replace(/[_-]/g, " ")}`;
}

/** The card a set-aside call is remembered by: its tool and its input. */
export function asideKey(name: string, input: unknown): string {
  return `${name}\u0000${JSON.stringify(input ?? null)}`;
}
