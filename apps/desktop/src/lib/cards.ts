/**
 * Cards under a reply (nightshift backlog 078): an artifact the model
 * published and a file it wrote, read out of the reply's text.
 *
 * Under Nightloom the Claude Code CLI never offers `SendUserFile` — that tool
 * exists only for a Remote Control client or a cloud session — so a file the
 * model produced reaches the user as a path in a sentence, and an `Artifact`
 * call's URL comes back as text. This module finds both. It is deliberately
 * conservative: a false card is worse than a missed one, so a path is only a
 * candidate when it is absolute or quoted in backticks with a slash in it,
 * fenced code is skipped, and the backend still has to find a real file at
 * the path before the transcript draws anything (`named_files`).
 *
 * Presentation only: nothing here reads the disk, and nothing here decides
 * what the model may see.
 */

/** One `claude.ai/artifact/…` link, with the markdown link's text as its
 *  title when the reply wrote one. */
export interface ArtifactLink {
  url: string;
  title: string;
}

/** A path the reply named, as written and as resolved for the backend. */
export interface PathCandidate {
  /** What the reply wrote, for the card's label. */
  written: string;
  /** Absolute, or `~/…` for the backend to expand. */
  path: string;
}

/** The most cards of one kind a reply gets; past this the rest stay text. */
export const MAX_CARDS = 8;

/** The artifact host the `Artifact` tool publishes to. */
const ARTIFACT_URL = /https?:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]{6,}/g;

/** The URL wrapped as a markdown link, its text kept as the title. */
const ARTIFACT_MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]{6,})\)/g;

/** Fenced blocks (``` or ~~~), removed before scanning: a path inside a
 *  command the model shows is not a file it is handing over. */
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;

/**
 * An absolute path, `/…` or `~/…`, ending at whitespace or a closing quote or
 * bracket. Path characters are the ordinary file-name set plus the ones
 * paths in this codebase actually carry (`@`, `+`, `~` in the middle of a
 * scratchpad path); spaces are not among them, so a path with a space is a
 * miss rather than a false card.
 */
const ABSOLUTE = /(?:^|[\s(\[<`'"])((?:~)?\/(?:[\w.@+~-]+\/)*[\w.@+~-]+)/g;

/** A relative path in backticks with at least one slash: `notes/ace/x.md`. */
const RELATIVE_QUOTED = /`((?:\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+)`/g;

/** What a sentence leaves stuck to a path or a URL. */
const TRAILING = /[.,;:!?)\]>'"`]+$/;

function stripFences(text: string): string {
  return text.replace(FENCE, "\n");
}

function unique<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** Every artifact link in the reply, in order, each once, at most `MAX_CARDS`. */
export function artifactLinks(text: string): ArtifactLink[] {
  const src = stripFences(text);
  const titled = new Map<string, string>();
  for (const m of src.matchAll(ARTIFACT_MD_LINK)) {
    const title = m[1].trim();
    if (title && !titled.has(m[2])) titled.set(m[2], title);
  }
  const found: ArtifactLink[] = [];
  for (const m of src.matchAll(ARTIFACT_URL)) {
    const url = m[0].replace(TRAILING, "");
    found.push({ url, title: titled.get(url) ?? "Artifact" });
  }
  return unique(found, (l) => l.url).slice(0, MAX_CARDS);
}

/**
 * Every path the reply names that could be a file, resolved for the backend
 * to check. `roots` are the folders a relative path is tried against, in
 * order — the chat's workspace first — and an empty list means relative
 * paths are not candidates at all, since there is nothing to resolve them
 * against. Absolute paths need no root.
 */
export function pathCandidates(text: string, roots: string[]): PathCandidate[] {
  const src = stripFences(text);
  const found: PathCandidate[] = [];
  for (const m of src.matchAll(ABSOLUTE)) {
    const written = m[1].replace(TRAILING, "");
    // A lone slash or a bare `~/` names a folder, not a file the model wrote.
    if (written === "/" || written === "~/" || written.endsWith("/")) continue;
    found.push({ written, path: written });
  }
  const base = roots.map((r) => r.replace(/[\\/]+$/, "")).filter((r) => r !== "");
  if (base.length > 0) {
    for (const m of src.matchAll(RELATIVE_QUOTED)) {
      const written = m[1].replace(TRAILING, "");
      if (written.endsWith("/")) continue;
      // Tried against the first root only: a second guess doubles the
      // chances of a coincidental match, which is the false card this
      // detection is built to avoid.
      found.push({ written, path: `${base[0]}/${written.replace(/^\.\//, "")}` });
    }
  }
  return unique(found, (c) => c.path).slice(0, MAX_CARDS);
}

/** The path as the card shows it: relative to the first root it is under,
 *  else as written. The absolute path is the card's hover. */
export function displayPath(path: string, roots: string[]): string {
  for (const r of roots) {
    const root = r.replace(/[\\/]+$/, "");
    if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  }
  return path;
}

/** The extension badge: `md`, `html`, `pdf`; `file` when there is none. */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "file";
  return name.slice(dot + 1).toLowerCase().slice(0, 6);
}

/** `4.1 KB`, `812 B`, `1.2 MB` — the composer's attachment figure style. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
