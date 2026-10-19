/*
 * Item 391 — files dropped on the open Notes panel's Project section are
 * kept in the project, exactly as attaching them and pressing Keep would
 * (his ask, 2026-10-18). Nothing goes into a chat.
 *
 * "Exactly" is had by reusing, not copying: each file goes through the
 * composer's own `acceptFiles` (its routes, its caps, an office file's
 * conversion to PDF, its refusals and their toasts) into a scratch box no
 * one sees, then each chip that came out is kept with `keepNow` — the same
 * backend call, the same "already there" answer, the same toast wording,
 * the same Notes refresh. The scratch box's key starts with the edit box
 * prefix so the drafts store never writes it to disk, and it is dropped
 * when the keeps are done.
 *
 * The Knowledge section takes no drop: Keep writes only into the open
 * project's `.agents/files/` (the backend's `keep::keep_in_project`), and
 * there is no keep into the vault.
 */
import { canKeep, keepKey, type KeepState } from "./keep";
import type { Attachment } from "./types";

/** Why nothing can be kept here, or null when the project can keep. */
export function whyNoKeep(project: { unfiled?: boolean; name?: string } | null | undefined): string | null {
  if (canKeep(project)) return null;
  if (!project) return "No project is open — open a folder first; dropped files are kept in its .agents/files/";
  return "Chats with no project have no folder to keep files in — open a project first";
}

/** The words over the section while files are held over it. */
export function holdTitle(project: { unfiled?: boolean } | null | undefined): string {
  return canKeep(project) ? "Drop to keep in this project" : "No project to keep files in";
}
export const HOLD_LINE = "copied into .agents/files/ — every new chat here can read them";

/** The prefix of the scratch boxes' keys: the edit box prefix (`drafts`'
 *  `EDIT_DRAFT_PREFIX`), which the store never persists. */
export const SCRATCH_PREFIX = "edit:notes-drop:";
let seq = 0;
export function scratchKey(): string {
  return `${SCRATCH_PREFIX}${++seq}`;
}

export type KeepDeps = {
  project: () => { unfiled?: boolean } | null | undefined;
  toast: (text: string) => void;
  /** The composer's `acceptFiles`. */
  attach: (key: string, files: File[]) => Promise<Attachment[]>;
  /** The conversions still running for `key`'s chips (`conversionJobs`). */
  jobs: (key: string) => Promise<void>[];
  /** `key`'s chips as they are now (a conversion updates its chip). */
  chips: (key: string) => readonly Attachment[];
  state: (key: string) => KeepState;
  /** Forget a "kept" state so Keep asks the backend again. */
  forget: (key: string) => void;
  keep: (key: string, name: string, mediaType: string, from: { data: string }) => Promise<void>;
  /** Drop the scratch box. */
  discard: (key: string) => void;
};

/**
 * Keep the dropped files. Returns how many Keep was asked to keep. Every
 * file not kept was named in a toast: by `whyNoKeep`, by `acceptFiles`'
 * refusals and failed conversions, or by `keepNow`'s "Could not keep".
 */
export async function keepDropped(files: readonly File[], d: KeepDeps): Promise<number> {
  if (files.length === 0) return 0;
  const why = whyNoKeep(d.project());
  if (why) {
    d.toast(why);
    return 0;
  }
  const key = scratchKey();
  let asked = 0;
  try {
    const made = await d.attach(key, [...files]);
    // Office files convert behind their chips; Keep waits for the PDF, as
    // the chip's Keep button does (disabled while `pending`).
    await Promise.allSettled(d.jobs(key));
    const ids = new Set(made.map((a) => a.id));
    // A chip whose conversion failed was removed (and said so).
    const ready = d.chips(key).filter((a) => ids.has(a.id) && !a.pending && a.data);
    for (const a of ready) {
      const k = keepKey(a.name, a.data);
      const s = d.state(k);
      // Kept earlier in this window — maybe in another project: ask the
      // backend again; it answers "already there" when it is.
      if (s.phase === "kept") d.forget(k);
      else if (s.phase === "keeping") {
        d.toast(`${a.name} is being kept already`);
        continue;
      }
      asked++;
      await d.keep(k, a.name, a.media_type, { data: a.data });
    }
  } finally {
    d.discard(key);
  }
  return asked;
}

/**
 * Whether files are held over the section: entered and not yet left
 * (children's enter/leave pairs counted), and still moving — WebKit may
 * not say a drag left the window, but it stops sending `dragover`.
 */
export class Hold {
  private depth = 0;
  private last = -Infinity;
  constructor(private staleMs = 1500) {}
  enter(now: number): void {
    this.depth++;
    this.last = now;
  }
  over(now: number): void {
    if (this.depth === 0) this.depth = 1;
    this.last = now;
  }
  leave(): void {
    this.depth = Math.max(0, this.depth - 1);
  }
  end(): void {
    this.depth = 0;
  }
  held(now: number): boolean {
    return this.depth > 0 && now - this.last <= this.staleMs;
  }
}
