/**
 * "Keep in project" (nightshift item 306), the pure half: whether a chat can
 * keep anything, what the control says, and which files a sent message names.
 *
 * His ask (2026-10-04): "there should be an option that you can just like
 * keep it in the project". Every attachment kind item 277 accepts gets the
 * control — image, PDF, office file (kept as the PDF it became), text, a
 * file for Claude Code — on the composer's chip and on a sent message's.
 * What is kept lands in the project's `.agents/files/`, which every later
 * chat's system prompt lists; nothing is overwritten (the backend's
 * `keep::keep_in_project`).
 */

export type KeepPhase = "idle" | "keeping" | "kept";

export interface KeepState {
  phase: KeepPhase;
  /** Where it went, as the system prompt lists it: `files/deck.pdf`. */
  rel?: string;
}

/** A chat in a project can keep; one with none open, or in the claude.ai
 *  import's holder for chats that had no project, cannot. */
export function canKeep(project: { unfiled?: boolean } | null | undefined): boolean {
  return !!project && !project.unfiled;
}

/** The control's words. */
export function keepLabel(s: KeepState): string {
  if (s.phase === "keeping") return "Keeping…";
  if (s.phase === "kept") return "Kept";
  return "Keep in project";
}

/** The control's tip: what pressing does, or where it went. */
export function keepTip(s: KeepState, name: string, pending = false): string {
  if (pending) return `${name} is still converting — Keep waits for its PDF`;
  if (s.phase === "kept")
    return `Kept as .agents/${s.rel ?? "files/"} — every new chat in this project lists it and can read it`;
  if (s.phase === "keeping") return `Copying ${name} into the project's files…`;
  return `Copy ${name} into this project's files (.agents/files/), so later chats can read it without attaching it again`;
}

/**
 * A key for one attachment's bytes, so the composer's chip and the sent
 * message's chip of the same file share a state. Not a hash of the whole
 * payload (megabytes, on every render): its name, length and both ends.
 */
export function keepKey(name: string, data: string): string {
  return `${name}|${data.length}|${data.slice(0, 48)}|${data.slice(-48)}`;
}

/** An image in the log carries no name: one from its place and type. */
export function imageName(j: number, mediaType: string): string {
  const ext = { "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mediaType] ?? "png";
  return `image-${j + 1}.${ext}`;
}

/**
 * The files a sent message saved for Claude Code (item 277): the paths the
 * backend's `attach::files_note` listed under "[Attached a file — saved for
 * you to open with your tools:" — one `- <path>` line each, up to the `]`.
 */
export function savedFilePaths(text: string): string[] {
  const at = text.lastIndexOf("[Attached ");
  if (at < 0) return [];
  const block = text.slice(at);
  if (!/^\[Attached (a file|files) — saved for you to open with your tools:\n/.test(block)) return [];
  const out: string[] = [];
  for (const line of block.split("\n").slice(1)) {
    const m = /^- (.+?)(\])?$/.exec(line);
    if (!m) break;
    out.push(m[1]);
    if (m[2]) break;
  }
  return out;
}

/** A path's last part. */
export function leafOf(path: string): string {
  return path.split("/").pop() || path;
}
