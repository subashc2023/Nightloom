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
  // Item 515: one parser for the note, `splitAttachNote`; a long PDF sent
  // by path (item 491) is a saved file too.
  return splitAttachNote(text).files.map((f) => f.path);
}

// ---- Item 515: the note the CLI reads, out of what he sees --------------

/** One file the backend's note names (`attach::files_note_with`). */
export interface NotedFile {
  path: string;
  /** Its last part, as drawn. */
  name: string;
  /** A long PDF sent by path (item 491): its page count. */
  pages?: number;
}

/** A user turn's text, split: his words, the files the note names, and
 *  the note itself, byte for byte as the CLI got it ("" when none). */
export interface SplitNote {
  said: string;
  files: NotedFile[];
  note: string;
}

const FILES_HEAD = /^\[Attached (?:a file|files) — saved for you to open with your tools:\n/;
const PDF_BLOCK =
  /^\[Attached a PDF of (\d+) pages, saved for you to read with your tools rather than sent whole:\n- ([^\n]+)\n[^\n]*\]$/;

/** One block of the note (no blank line inside any), or null. */
function noteBlock(block: string): NotedFile[] | null {
  const pdf = PDF_BLOCK.exec(block);
  if (pdf) return [{ path: pdf[2], name: leafOf(pdf[2]), pages: Number(pdf[1]) }];
  const head = FILES_HEAD.exec(block);
  if (!head || !block.endsWith("]")) return null;
  const out: NotedFile[] = [];
  for (const line of block.slice(head[0].length, -1).split("\n")) {
    if (!line.startsWith("- ") || line.length < 3) return null;
    const path = line.slice(2);
    out.push({ path, name: leafOf(path) });
  }
  return out;
}

/**
 * Item 515 (his report, 2026-11-09): the note the backend appends to a
 * message for the files it saved — `{text}\n\n{note}`, or the note alone
 * (`main.rs`, `attach::files_note_for`) — is for the CLI, not for him. It
 * is the message's tail: one or more blocks, each starting `[Attached `,
 * joined by a blank line (the files note first, then each long PDF's).
 * The earliest place from which the whole rest reads as such blocks is
 * where the note starts; text that only looks like one stays his words.
 * The stored text is never changed: this is how it is drawn.
 */
export function splitAttachNote(text: string): SplitNote {
  for (let p = text.indexOf("[Attached "); p >= 0; p = text.indexOf("[Attached ", p + 1)) {
    if (p > 0 && text[p - 1] !== "\n") continue;
    const files: NotedFile[] = [];
    let ok = true;
    for (const block of text.slice(p).split("\n\n")) {
      const got = noteBlock(block);
      if (!got) {
        ok = false;
        break;
      }
      files.push(...got);
    }
    if (!ok) continue;
    const head = text.slice(0, p);
    // The backend's separator is exactly one blank line; any newline of
    // his own before it is his.
    const said = head.endsWith("\n\n") ? head.slice(0, -2) : head;
    return { said, files, note: text.slice(p) };
  }
  return { said: text, files: [], note: "" };
}

/** His words with the note put back after an edit, as the backend joins
 *  them (`main.rs`: the note alone when his words are blank). */
export function joinAttachNote(said: string, note: string): string {
  if (!note) return said;
  return said.trim() === "" ? note : `${said}\n\n${note}`;
}

/** What a one-line view of a user turn shows (a title, the navigator's
 *  tick, a phone row): his words, else the names of the files he sent. */
export function shownText(text: string): string {
  const s = splitAttachNote(text);
  if (s.said.trim() !== "" || s.files.length === 0) return s.said;
  return s.files.map((f) => f.name).join(", ");
}

/** The names a flattened piece of a note names, cut or whole. */
function passageNames(piece: string): string[] {
  const paths = [...piece.matchAll(/(?:^|[ :…])(?:- )?(\/[^\]]*?)(?= - \/| Pull its| Read only|\]|$)/g)].map((x) => x[1]);
  if (paths.length === 0) {
    // A cut tail (`…ments/c1/data.parquet]`): its last path, from the cut.
    const last = piece.replace(/^…/, "").replace(/\]$/, "").split(" - ").pop() ?? "";
    if (last.includes("/") && !/ /.test(last.slice(last.lastIndexOf("/")))) paths.push(last);
  }
  return [...new Set(paths.map((p) => leafOf(p.trim())).filter(Boolean))];
}

/**
 * A search hit's passage (`store/search.rs`): one line, cut 60 characters
 * before the match and 110 after, so a note may be in it whole or in part.
 * Each piece of a note is drawn as `[attached <names>]`; a match inside a
 * note marks the part of a file's name it hit, else that whole label.
 */
export function cleanPassage(r: { before: string; matched: string; after: string }): {
  before: string;
  matched: string;
  after: string;
} {
  const s = r.before + r.matched + r.after;
  if (!/\[Attached |with your tools|rather than sent whole|\.nightloom\/attachments\/|^…[^ \]]*\/[^ \]]*\]/.test(s)) return r;
  const m0 = r.before.length;
  const m1 = m0 + r.matched.length;
  const spans: [number, number][] = [];
  const whole =
    /\[Attached (?:a file|files) — saved for you to open with your tools: [^\]]*\]|\[Attached a PDF of \d+ pages, saved for you to read with your tools rather than sent whole: [^\]]*\]/g;
  for (let w = whole.exec(s); w; w = whole.exec(s)) spans.push([w.index, w.index + w[0].length]);
  // The window began inside a note: up to its first `]`.
  const firstClose = s.indexOf("]");
  const firstOpen = s.indexOf("[");
  if (s.startsWith("…") && firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    const lead = s.slice(0, firstClose + 1);
    if (/with your tools|rather than sent whole|Read tool's|^…[^ ]*\/[^ ]*\]$|^…[^\]]* - \//.test(lead)) spans.unshift([0, firstClose + 1]);
  }
  // The window ended inside one: from its `[Attached ` on.
  const lastOpen = s.lastIndexOf("[Attached ");
  if (lastOpen >= 0 && !spans.some(([a, b]) => a <= lastOpen && lastOpen < b)) spans.push([lastOpen, s.length]);
  if (spans.length === 0) return r;
  let out = "";
  let o0 = -1;
  let o1 = -1;
  let at = 0;
  const copy = (a: number, b: number) => {
    for (let i = a; i < b; i++) {
      if (i === m0 && o0 < 0) o0 = out.length;
      if (i === m1 && o1 < 0) o1 = out.length;
      out += s[i];
    }
  };
  for (const [a, b] of spans) {
    copy(at, a);
    const names = passageNames(s.slice(a, b));
    const label = names.length > 0 ? `[attached ${names.join(", ")}]` : "[attached file]";
    if (out.length > 0 && !out.endsWith(" ")) out += " ";
    const start = out.length;
    out += label;
    if (m0 < b && m1 > a) {
      const q = r.matched.toLowerCase();
      const name = q ? names.find((n) => n.toLowerCase().includes(q)) : undefined;
      if (name && m0 >= a) {
        const k = label.indexOf(name) + name.toLowerCase().indexOf(q);
        o0 = start + k;
        o1 = start + k + r.matched.length;
      } else {
        if (o0 < 0) o0 = start;
        if (m1 <= b) o1 = start + label.length;
      }
    }
    at = b;
  }
  copy(at, s.length);
  if (o0 < 0) o0 = out.length;
  if (o1 < 0) o1 = out.length;
  if (o1 < o0) o1 = o0;
  return { before: out.slice(0, o0), matched: out.slice(o0, o1), after: out.slice(o1) };
}

/** A path's last part. */
export function leafOf(path: string): string {
  return path.split("/").pop() || path;
}
