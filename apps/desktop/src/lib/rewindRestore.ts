/**
 * Rewind's "restore files too" (nightshift item 765, the 762 survey's
 * draft 2). Each agent turn's start and end are saved as hidden git
 * snapshots of the chat's folder (`turn_snapshot.rs`); after a rewind the
 * transcript's card lists what the rewound turns changed and offers
 * Restore or Keep. A restore writes each ticked file back as it was before
 * the first rewound turn, moves a file the turns made aside (item 259's
 * dated folder, never deleted), and leaves alone any file changed since
 * the last rewound turn ended. Its Undo puts the files back as they were
 * just before the restore.
 *
 * Without a git repository, or a snapshot of the turn, the item-259 card
 * stands as before and says why files cannot be restored.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RewoundWrite } from "./rewoundFiles";

export interface Plan {
  git: boolean;
  root: string | null;
  start: string | null;
  end: string | null;
  now: string | null;
  files: { path: string; how: "added" | "modified" | "deleted"; since: boolean }[];
  note: string | null;
}

export interface RestoreFile {
  /** Relative to the repository's top folder. */
  path: string;
  how: "added" | "modified" | "deleted";
  /** Changed again after the turn ended: left alone. */
  since: boolean;
  /** Named by one of the rewound turns' own file tools. */
  named: boolean;
}

/** The card after a rewind whose turns' snapshots exist. */
export interface RewindRestore {
  session: string | null;
  chat: string;
  root: string;
  start: string;
  end: string;
  now: string;
  files: RestoreFile[];
  /** What the restore did, once he chose; "kept" when he kept them. */
  done: string | null;
  /** The restore's undo, while it can be offered. */
  undo: { from: string; guard: string; paths: string[] } | null;
  busy: boolean;
}

export interface Restored {
  restored: string[];
  aside: { folder: string | null; moved: { from: string; to: string }[]; skipped: { path: string; why: string }[] };
  skipped: { path: string; why: string }[];
  after: string | null;
}

export function rewindFiles(workspace: string, chat: string, to: number): Promise<Plan> {
  return invoke("rewind_files", { workspace, chat, to });
}

export function restoreRewoundFiles(
  chat: string | null,
  root: string,
  from: string,
  guard: string,
  paths: string[],
  added: string[],
): Promise<Restored> {
  return invoke("restore_rewound_files", { chat, root, from, guard, paths, added });
}

const join = (a: string, b: string) => (b.startsWith("/") ? b : `${a.replace(/\/+$/, "")}/${b.replace(/^\.\//, "")}`);

/** The card's files from a plan, each marked when the rewound turns' own
 *  tools named it (a file only a shell command, a helper or another chat
 *  changed is listed as such). */
export function restoreFiles(plan: Plan, workspace: string | null, written: RewoundWrite[]): RestoreFile[] {
  const named = new Set(written.filter((w) => w.how !== "shell").map((w) => join(workspace ?? plan.root ?? "", w.path)));
  return plan.files.map((f) => ({ ...f, named: named.has(join(plan.root ?? "", f.path)) }));
}

/** Ticked to start with: every file not changed since. */
export const tickedAtFirst = (f: RestoreFile): boolean => !f.since;

/** The restore's two lists: written back, and made by the turns (moved aside). */
export function split(files: RestoreFile[], ticked: (f: RestoreFile) => boolean): { paths: string[]; added: string[] } {
  const chosen = files.filter((f) => !f.since && ticked(f));
  return {
    paths: chosen.filter((f) => f.how !== "added").map((f) => f.path),
    added: chosen.filter((f) => f.how === "added").map((f) => f.path),
  };
}

/** What the card says after a restore, and the paths its undo puts back. */
export function restoredSummary(root: string, out: Restored): { text: string; undoPaths: string[] } {
  const rel = (p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const moved = out.aside.moved.map((m) => rel(m.from));
  const skipped = [...out.skipped, ...out.aside.skipped].map((s) => `${s.path}: ${s.why}`);
  const parts: string[] = [];
  parts.push(out.restored.length === 1 ? "Restored 1 file" : `Restored ${out.restored.length} files`);
  if (moved.length) parts.push(`moved ${moved.length} the turns made to ${out.aside.folder}`);
  if (skipped.length) parts.push(`left alone: ${skipped.join("; ")}`);
  return { text: parts.join(" · "), undoPaths: [...out.restored, ...moved] };
}

export const HOW_RESTORE: Record<RestoreFile["how"], string> = {
  modified: "edited — goes back",
  deleted: "deleted — comes back",
  added: "made by the turn — moved aside, not deleted",
};
