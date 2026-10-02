/**
 * Research threads, the pure half (nightshift backlog 271, step 1): the
 * picker's options, slugs, and the Start-here splice *Make this the file*
 * uses. The Rust twin of the slug rules is `thread.rs` (`valid_slug`,
 * `slug_from`); the two must agree, and the tests pin both to the same
 * cases.
 */
import type { SessionEvent, ThreadInfo } from "./types";

/** A slug names a folder: lowercase letters, digits, `-` and `_`, starting
 *  with a letter or digit, at most 64 characters. Never a path. */
export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);
}

/** A slug from a name: lowercase, runs of anything else become one `-`. */
export function slugFrom(name: string): string {
  let out = "";
  for (const c of name.trim()) {
    if (/[A-Za-z0-9]/.test(c)) out += c.toLowerCase();
    else if (out !== "" && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "").slice(0, 64);
}

/** One row of the picker: a thread, "none", or "New thread…". */
export interface PickerOption {
  value: string;
  label: string;
  /** The line under the label: status and last touched. */
  detail: string;
}

/** The value "New thread…" carries; never a slug (slugs have no `:`). */
export const NEW_THREAD = ":new";
/** The value "No thread" carries. */
export const NO_THREAD = "";

/**
 * The picker's rows: none first, then the project's threads most recently
 * touched first (the backend's order), then *New thread…*. A bound slug
 * the project no longer has stays listed, marked, so the picker never
 * shows a binding it cannot name.
 */
export function pickerOptions(threads: ThreadInfo[], bound: string | null): PickerOption[] {
  const rows: PickerOption[] = [{ value: NO_THREAD, label: "No thread", detail: "wrap-up writes HANDOFF.md" }];
  for (const t of threads) {
    const when = t.touched ? `touched ${t.touched}` : "";
    const flags = t.flags > 0 ? `${t.flags} upkeep flag${t.flags === 1 ? "" : "s"}` : "";
    rows.push({
      value: t.slug,
      label: t.title === t.slug ? t.slug : `${t.title} (${t.slug})`,
      detail: [t.status, when, flags].filter((x) => x).join(" · "),
    });
  }
  if (bound && !threads.some((t) => t.slug === bound)) {
    rows.push({ value: bound, label: `${bound} (missing)`, detail: "no thread.md in this project" });
  }
  rows.push({ value: NEW_THREAD, label: "New thread…", detail: "from the project's template" });
  return rows;
}

/** The chat's thread, projected from the log: the latest live `thread`
 *  event, or null. `live` is the log's liveness flags (rewinds). */
export function threadOfEvents(events: SessionEvent[], live: boolean[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "thread") return e.thread ?? null;
  }
  return null;
}

/**
 * `thread.md` with its `## Start here` body replaced by `body` — what
 * *Make this the file* puts in the editor as a draft (never a write). The
 * rest of the file is untouched; a file with no such section gets one at
 * its end. `## ` lines inside fences are not headings.
 */
export function replaceStartHere(file: string, body: string): string {
  const lines = file.split("\n");
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence || !lines[i].startsWith("## ")) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (lines[i].slice(3).trim().toLowerCase() === "start here") start = i + 1;
  }
  const block = body.trim().split("\n");
  if (start < 0) {
    return [...lines, "", "## Start here", ...block, ""].join("\n");
  }
  return [...lines.slice(0, start), ...block, "", ...lines.slice(end)].join("\n");
}
