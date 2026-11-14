// The terminal dock's header strip, said in words (item 528). His report:
// "i dont even konw what's going on here like what each thing is" — a run
// block's tab read `cd "/Users/swaraagsistla/Docume…`, the right-hand
// glyphs were bare. Pure: the names, marks and tooltips the strip draws,
// so a test pins them; `TerminalDock.svelte` only lays them out.
import { shortCwd, type ShellRow } from "./terminal";

/** The last segment of a folder: `/a/b/vg` → `vg`; `/` stays `/`. */
export function folderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/**
 * A command's first word, the program it runs: the first line that is not
 * blank or a comment, past any `VAR=value` assignments and a `sudo`, `env`,
 * `time`, `exec` or `nohup` in front. `cd "/Users/…"` → `cd`;
 * `FOO=1 npm test` → `npm`; `./build.sh -x` → `build.sh`.
 */
export function firstWord(command: string): string {
  const line = command.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  const words = line.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["sudo", "env", "time", "exec", "nohup"].includes(words[i]))) i++;
  const w = (words[i] ?? "").replace(/^["']|["']$/g, "");
  // A path to a program is named by its last part.
  return w.includes("/") ? (w.split("/").filter(Boolean).pop() ?? w) : w;
}

/** What kind of tab this is: his own shell, a block run from a reply, or
 *  the agent's commands (view only). */
export type TabKind = "shell" | "run" | "agent";
export function tabKind(row: ShellRow): TabKind {
  return row.agentChat ? "agent" : row.run ? "run" : "shell";
}

/**
 * The tab's readable name, in two parts: the folder, and what runs there.
 * A run block: `walkee-e · cd`. A plain shell: the folder, plus the program
 * in front while one runs (`vg · npm`). The agent's tab: "Agent commands".
 */
export function tabName(row: ShellRow): { folder: string; what: string | null } {
  if (row.agentChat) return { folder: "Agent commands", what: null };
  const folder = folderName(row.cwd);
  if (row.run) return { folder, what: firstWord(row.run.command) || null };
  if (!row.exit && row.title && row.title !== row.shell) return { folder, what: row.title };
  return { folder, what: null };
}

/**
 * The names of a dock's tabs, each told apart: two shells in one folder
 * read `vg` and `vg 2` (the second and later get the number).
 */
export function tabNames(rows: ShellRow[]): { folder: string; what: string | null; text: string }[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = tabName(r);
    const base = n.what ? `${n.folder} · ${n.what}` : n.folder;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    const folder = k > 1 && !n.what ? `${n.folder} ${k}` : n.folder;
    const what = k > 1 && n.what ? `${n.what} ${k}` : n.what;
    return { folder, what, text: what ? `${folder} · ${what}` : folder };
  });
}

/**
 * How a tab ended, as a small mark: `ok` (a run's exit 0: a check), `fail`
 * (a non-zero code: the number), `signal`, `stopped` (he pressed Stop), or
 * `restart` (his own shell ended: a click starts a new one). `words` is
 * the mark said in full, for the tooltip and a screen reader.
 */
export type ExitMark = { kind: "ok" | "fail" | "signal" | "stopped" | "restart"; text: string; words: string };
export function exitMark(row: ShellRow): ExitMark | null {
  const e = row.exit;
  if (!e) return null;
  const how = e.code !== null ? `exit ${e.code}` : e.signal ? `ended by ${e.signal}` : "ended";
  if (!row.run) return { kind: "restart", text: "", words: `ended (${how})` };
  if (row.run.stopped) return { kind: "stopped", text: "", words: `stopped by you (${how})` };
  if (e.code === 0) return { kind: "ok", text: "", words: "finished (exit 0)" };
  if (e.code !== null) return { kind: "fail", text: String(e.code), words: `failed (exit ${e.code})` };
  return { kind: "signal", text: "sig", words: how };
}

/** The tab's tooltip: what it is, the whole command, the whole folder, how
 *  it ended, what a click does. */
export function tabTip(row: ShellRow, mac: boolean): string {
  const mark = exitMark(row);
  if (row.agentChat) return "Agent commands: what this chat's agent ran, and the output. View only. Drag onto the other pane to move it.";
  if (row.run) {
    const lines = row.run.command.trim().split("\n");
    const cmd = lines[0].length > 200 ? `${lines[0].slice(0, 199)}…` : lines[0];
    const more = lines.length > 1 ? ` (+${lines.length - 1} more ${lines.length === 2 ? "line" : "lines"})` : "";
    const state = mark ? `It ${mark.words}.` : "Running.";
    return `A command run from a reply: ${cmd}${more}\nIn ${row.cwd}\n${state}`;
  }
  if (mark) return `Your shell (${row.shell}) in ${row.cwd}, ${mark.words}.\nClick to start a new shell in the same folder.`;
  const what = row.title && row.title !== row.shell ? `, running ${row.title}` : "";
  return `Your shell (${row.shell}) in ${row.cwd}${what}.\nDrag onto the other pane for a terminal there.${mac ? " ⌘W closes it." : ""}`;
}

/** The folder chip's text and tooltip, for the tab in front. */
export function frontFolder(row: ShellRow | null, home: string | null): { short: string; tip: string } | null {
  if (!row || row.agentChat || !row.cwd) return null;
  return { short: shortCwd(row.cwd, home), tip: `The folder of the tab in front: ${row.cwd}` };
}
