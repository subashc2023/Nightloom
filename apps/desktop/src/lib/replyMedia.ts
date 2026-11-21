/**
 * Pictures and video a reply names (item 820): which paths in a finished
 * reply's text are a picture or a video to draw under it. Pure — nothing
 * here reads the disk; the backend (`read_reply_media`, the phone's
 * `/api/chats/{id}/media`) decides what may be read and finds out what is
 * really there.
 *
 * Three forms count, in the order the reply writes them:
 * - any path the file cards already find (`pathCandidates`: absolute, or
 *   backticked with a slash) whose extension is a picture or a video;
 * - a markdown image's target, `![plot](plot.png)`, relative or absolute —
 *   the one form that says "show this", so a missing file is said to be gone;
 * - a backticked bare file name with a picture or video extension,
 *   `` `plot.png` `` — how a reply usually names what a script saved in the
 *   chat's folder.
 */
import { pathCandidates } from "./cards";

/** The picture and video extensions, as the backend's `media_kind` reads them. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

/** The most pictures one reply draws; past this the rest stay cards. */
export const MAX_MEDIA = 12;

export type MediaKind = "image" | "video";

export function mediaKindOf(path: string): MediaKind | null {
  const p = path.split(/[?#]/)[0];
  if (IMAGE_EXT.test(p)) return "image";
  if (VIDEO_EXT.test(p)) return "video";
  return null;
}

/** One picture or video the reply names. */
export interface MediaCandidate {
  /** What the reply wrote: the label, and what the phone sends. */
  written: string;
  /** Resolved against the first root when relative and a root is known; else as written. */
  path: string;
  kind: MediaKind;
  /** Named by a markdown image, so a miss is worth a line. */
  explicit: boolean;
}

const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
/** `![alt](target)` or `![alt](<target with spaces>)`, an optional title after. */
const MD_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
/** A backticked bare file name: `plot.png`. */
const BARE_QUOTED = /`([\w.@+-]+\.[A-Za-z0-9]{2,5})`/g;

/** A written path against the first root when relative and a root is known; else as written. */
export function resolveMedia(written: string, roots: string[]): string {
  if (written.startsWith("/") || written.startsWith("~/")) return written;
  const base = roots.map((r) => r.replace(/[\\/]+$/, "")).find((r) => r !== "");
  return base ? `${base}/${written.replace(/^\.\//, "")}` : written;
}

/** Whether a markdown image's target is a file on this Mac rather than the web. */
export function isLocalTarget(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
}

/**
 * Every picture or video the reply names, each once, in the order written,
 * at most `MAX_MEDIA`. `roots` resolve a relative path, the chat's folder
 * first; with none, a relative path is kept as written (the phone sends it
 * and the Mac resolves it).
 */
export function mediaCandidates(text: string, roots: string[]): MediaCandidate[] {
  const src = text.replace(FENCE, "\n");
  const found: { at: number; c: MediaCandidate }[] = [];
  const add = (at: number, written: string, explicit: boolean) => {
    let w = written.trim();
    try {
      if (explicit) w = decodeURI(w);
    } catch {
      // A target that is not valid percent-encoding stays as written.
    }
    w = w.replace(/^file:\/\//, "");
    const kind = mediaKindOf(w);
    if (!kind) return;
    found.push({ at, c: { written: w, path: resolveMedia(w, roots), kind, explicit } });
  };
  for (const m of src.matchAll(MD_IMAGE)) {
    const target = m[1] ?? m[2];
    if (target.startsWith("file://") || isLocalTarget(target)) add(m.index ?? 0, target, true);
  }
  for (const c of pathCandidates(src, roots)) {
    add(src.indexOf(c.written), c.written, false);
  }
  for (const m of src.matchAll(BARE_QUOTED)) add(m.index ?? 0, m[1], false);
  found.sort((a, b) => a.at - b.at);
  const out: MediaCandidate[] = [];
  const seen = new Map<string, MediaCandidate>();
  for (const { c } of found) {
    const had = seen.get(c.path);
    if (had) {
      had.explicit ||= c.explicit;
      continue;
    }
    seen.set(c.path, c);
    out.push(c);
  }
  return out.slice(0, MAX_MEDIA);
}
