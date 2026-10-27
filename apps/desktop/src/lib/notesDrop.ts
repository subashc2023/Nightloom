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
import type { UnpackedZip } from "./api";

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
  /** The composer's `acceptFiles`; `toast` takes its refusals' words. */
  attach: (key: string, files: File[], toast?: (text: string) => void) => Promise<Attachment[]>;
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
  /** Item 414: how a zip is unpacked and its entries kept. Without it, a
   *  zip goes through `attach` as any file. */
  zip?: ZipDeps;
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
  // Item 414: a zip is unpacked into a folder, not kept whole.
  const zips = d.zip ? files.filter(isZip) : [];
  const rest = files.filter((f) => !zips.includes(f));
  let asked = rest.length > 0 ? await keepFiles(rest, d) : 0;
  for (const z of zips) asked += await keepZip(z, d, d.zip!);
  return asked;
}

async function keepFiles(files: readonly File[], d: KeepDeps): Promise<number> {
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

/*
 * Item 414 (his bug, 2026-10-26: "Why cant i drop a zip file into the
 * notes section... bro"; blocker 1526) — a zip dropped here is unpacked
 * into `files/<zip name>/`: the backend reads it and refuses what must not
 * land (`keep::unpack_zip`: `__MACOSX/`, dot-files, paths that climb out,
 * symlinks, bombs), then each entry meets a dropped file's own rules —
 * `acceptFiles`' routes, caps, office → PDF and refusals — and is kept in
 * its folder. One toast says what came of the whole zip.
 */

export type ZipDeps = {
  /** The zip's bytes as base64. */
  read: (file: File) => Promise<string>;
  unpack: (name: string, data: string) => Promise<UnpackedZip>;
  /** Keep one entry's bytes in `files/<dir>/`. */
  keepAt: (name: string, mediaType: string, data: string, dir: string) => Promise<{ rel: string; already: boolean }>;
  /** After the keeps: refresh Notes and hand the rows to 416's flash. */
  kept: (rels: string[], anyNew: boolean) => Promise<void>;
};

export function isZip(f: { name: string; type?: string }): boolean {
  return /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";
}

const SYSTEM = "system file";

/** The one toast for a zip: what was kept where, and what was not. */
export function zipToast(zip: string, folder: string, kept: number, skipped: readonly { name: string; why: string }[]): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  let line = kept > 0 ? `Kept ${files(kept)} from ${zip} in files/${folder}/` : `Kept nothing from ${zip}`;
  if (skipped.length === 0) return line;
  const system = skipped.filter((s) => s.why === SYSTEM).length;
  const others = skipped.filter((s) => s.why !== SYSTEM);
  const parts: string[] = [];
  if (system > 0) parts.push(`${system} system file${system === 1 ? "" : "s"}`);
  const shown = others.slice(0, 3).map((s) => s.name);
  if (others.length > 3) shown.push(`+${others.length - 3} more`);
  if (shown.length) parts.push(shown.join(", "));
  line += ` · ${skipped.length} skipped (${parts.join("; ")})`;
  if (others.length > 0) {
    const first = others[0];
    const leaf = first.name.slice(first.name.lastIndexOf("/") + 1);
    line += ` — ${first.why.startsWith(leaf) ? first.why : `${leaf}: ${first.why}`}`;
  }
  return line;
}

function bytesOf(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Unpack one zip and keep its entries. Returns how many were kept. */
export async function keepZip(file: File, d: KeepDeps, z: ZipDeps): Promise<number> {
  let u: UnpackedZip;
  try {
    u = await z.unpack(file.name, await z.read(file));
  } catch (e) {
    d.toast(`Could not open ${file.name}: ${String(e)}`);
    return 0;
  }
  if (u.files.length === 0 && u.skipped.length === 0) {
    d.toast(`${file.name} is empty — nothing to keep`);
    return 0;
  }
  const key = scratchKey();
  const said: string[] = [];
  const say = (t: string) => void said.push(t);
  const skipped = [...u.skipped];
  const pathOf = new Map<number, string>();
  const dirOf = (path: string) => {
    const cut = path.lastIndexOf("/");
    return cut >= 0 ? `${u.folder}/${path.slice(0, cut)}` : u.folder;
  };
  const leafOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const reason = (path: string, fallback: string) =>
    said.find((m) => m.startsWith(leafOf(path))) ?? fallback;
  const rels: string[] = [];
  let anyNew = false;
  try {
    for (const f of u.files) {
      const made = await d.attach(key, [new File([bytesOf(f.data)], leafOf(f.path))], say);
      if (made.length === 0) skipped.push({ name: f.path, why: reason(f.path, "refused") });
      for (const a of made) pathOf.set(a.id, f.path);
    }
    // Office entries convert behind their chips, as a dropped file's do.
    await Promise.allSettled(d.jobs(key));
    const chips = d.chips(key);
    for (const [id, path] of pathOf) {
      const a = chips.find((c) => c.id === id);
      if (!a || a.pending || !a.data) {
        skipped.push({ name: path, why: reason(path, "could not be converted") });
        continue;
      }
      try {
        const k = await z.keepAt(a.name, a.media_type, a.data, dirOf(path));
        rels.push(k.rel);
        anyNew ||= !k.already;
      } catch (e) {
        skipped.push({ name: path, why: String(e) });
      }
    }
  } finally {
    d.discard(key);
  }
  if (rels.length > 0) await z.kept(rels, anyNew);
  d.toast(zipToast(file.name, u.folder, rels.length, skipped));
  return rels.length;
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

/*
 * Item 416 (his ask, 2026-10-26: "scroll u to where it is and like
 * highlight it for a sec") — after a keep, the Notes list scrolls the
 * kept file's row to the middle and flashes it. The pure half.
 */

/** A kept file the panel has not shown yet: its note name (`files/a.pdf`,
 *  the keep's `rel`) and when it was kept (ms, `performance.now()`). */
export type KeptNotice = { rel: string; at: number };

/** Older than this, a notice is not shown: the panel was not open when the
 *  file was kept, and flashing it on a later visit would be noise. */
export const NOTICE_MS = 4000;
/** How long a row flashes. */
export const FLASH_MS = 1000;

/**
 * Which rows to flash and which to scroll to: the noticed files that are
 * in the list, once each, in the list's order; the scroll goes to the
 * first of them (the top-most, so the others sit below it in view).
 */
export function flashPlan(
  notices: readonly KeptNotice[],
  names: readonly string[],
  now: number,
): { scrollTo: string | null; flash: string[] } {
  const fresh = new Set(notices.filter((n) => now - n.at <= NOTICE_MS).map((n) => n.rel));
  const flash = names.filter((n) => fresh.has(n));
  return { scrollTo: flash[0] ?? null, flash };
}

/**
 * The `scrollTop` that puts a row in the middle of its scrolling box,
 * clamped to what the box can scroll. `rowTop` is the row's top relative
 * to the box's visible top (`rowRect.top - boxRect.top`).
 */
export function centredScrollTop(
  scrollTop: number,
  rowTop: number,
  rowHeight: number,
  boxHeight: number,
  scrollHeight: number,
): number {
  const want = scrollTop + rowTop - (boxHeight - rowHeight) / 2;
  return Math.max(0, Math.min(Math.round(want), Math.max(0, scrollHeight - boxHeight)));
}
