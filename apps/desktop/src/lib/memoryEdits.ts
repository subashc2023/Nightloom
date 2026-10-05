/**
 * "Updated course-progress.md" (nightshift backlog 305): a turn that changes
 * a memory note, the instructions (`AGENTS.md`) or a research thread's file
 * says so in the transcript, where it happened, as a line that opens the
 * note editor at the change.
 *
 * Read straight out of the turn's tool calls — Claude Code's `Edit`,
 * `Write` and `MultiEdit`, the API engine's `edit_file` and `write_file` —
 * so a recorded turn draws the same line on reload with nothing new stored.
 * Ordinary code edits draw nothing new.
 */

export interface MemoryEdit {
  /** Absolute, as the editor's `memory_note_for` wants it. */
  path: string;
  /** What the line names: `course-progress.md`, `stuart/thread.md`. */
  label: string;
  verb: "Updated" | "Created";
  /** Text the edit put in the file, to find the changed line by; "" when
   *  nothing locates it (a deletion), which opens at the top. */
  needle: string;
  /** Lines at the needle's head the edit kept as they were (its context):
   *  the change starts this many lines into it. */
  skip: number;
}

interface CallLike {
  name: string;
  input: unknown;
  result: { content: string; is_error: boolean } | null;
  denied?: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit_file", "write_file"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** `a/./b/../c` → `a/c`, slashes forward; enough for a model's relative path. */
function normalize(p: string): string {
  const out: string[] = [];
  const lead = p.startsWith("/") ? "/" : "";
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return lead + out.join("/");
}

/**
 * The note-ish kind of a path, and its label, or null for any other file.
 * Memory notes under `.agents/memory/`, thread files under
 * `.agents/threads/<slug>/`, and an `AGENTS.md` anywhere (the project's and
 * the user's own).
 */
export function memoryPathLabel(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (base === "AGENTS.md") return base;
  const at = parts.lastIndexOf(".agents");
  if (at < 0 || at + 2 >= parts.length) return null;
  const area = parts[at + 1];
  if (area === "memory") return parts.slice(at + 2).join("/");
  if (area === "threads") return parts.slice(at + 2).join("/");
  return null;
}

/** Whole lines `old` and `new` begin with alike — an edit's context, not its change. */
export function sameHead(old: string, next: string): number {
  const a = old.split("\n");
  const b = next.split("\n");
  let n = 0;
  // The new text's last line may be a fragment, so only a line it goes on
  // past counts as kept; the old text's last line counts when the new one
  // keeps it whole and goes on (Haiku's "Week 2" → "Week 2\nWeek 3").
  while (n < a.length && n < b.length - 1 && a[n] === b[n]) n++;
  return n;
}

/** What an edit put in — the new text, the first edit's for `MultiEdit` —
 *  and how many of its first lines it kept. */
function needleOf(name: string, input: Record<string, unknown>): { needle: string; skip: number } {
  if (name === "Write" || name === "write_file") return { needle: str(input.content), skip: 0 };
  let edit: Record<string, unknown> = input;
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const first = edits.find((e) => str((e as Record<string, unknown> | null)?.new_string).trim());
    if (!first) return { needle: "", skip: 0 };
    edit = first as Record<string, unknown>;
  }
  const needle = str(edit.new_string);
  return { needle, skip: sameHead(str(edit.old_string), needle) };
}

/**
 * The memory edit one call made, or null: a finished, successful edit of a
 * memory path. `workspace` resolves the API engine's relative paths; one
 * that cannot be resolved (no workspace, the `@kb/` vault) is not drawn.
 */
export function memoryEditOf(call: CallLike, workspace: string | null | undefined): MemoryEdit | null {
  if (!EDIT_TOOLS.has(call.name) || !call.result || call.result.is_error || call.denied) return null;
  const input = (call.input ?? {}) as Record<string, unknown>;
  let path = str(input.file_path) || str(input.path);
  if (!path) return null;
  if (!isAbsolute(path)) {
    if (!workspace || path.startsWith("@")) return null;
    path = normalize(`${workspace.replace(/\\/g, "/").replace(/\/$/, "")}/${path.replace(/\\/g, "/")}`);
  }
  const label = memoryPathLabel(path);
  if (!label) return null;
  // Both engines say which: Claude Code "File created successfully at …",
  // the API engine "Created <path> (N bytes)". Anything else changed a file.
  const created = /^(File created|Created )/.test(call.result.content.trimStart());
  return { path, label, verb: created ? "Created" : "Updated", ...needleOf(call.name, input) };
}

/** The 1-based line of the change: where `needle` starts in `text`, plus
 *  the `skip` lines it kept; 1 when it is not there. */
export function lineOfNeedle(text: string, needle: string, skip = 0): number {
  if (!needle.trim()) return 1;
  let at = text.indexOf(needle);
  let extra = skip;
  if (at < 0) {
    // Edited again since: its first line with words on it, if still there.
    const first = needle.split("\n").find((l) => l.trim()) ?? "";
    at = text.indexOf(first);
    extra = 0;
  }
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line + extra;
}
