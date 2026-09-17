/**
 * Search everywhere (nightshift backlog 117, with 106's second half): the
 * panel that takes the sidebar's column and lists every message — in this
 * project's chats, in every chat, or in the notes — that mentions a
 * phrase, grouped by chat, with the passage, who said it and when. ↑↓
 * previews the chat behind the panel at the message, every match marked;
 * ↵ opens it and hands the query to ⌘F's bar so ⌘G steps on.
 *
 * The panel is `SearchPanel.svelte`; the scan is the store's
 * (`store/search.rs`, `searchEverywhere` in `api.ts`); this file is the
 * pure half between them — the row list the arrows walk, the count line,
 * the labels — and the one handle the panel needs on the find bar, which
 * lives in `App.svelte`'s content area and registers itself here.
 */

import { aliasOf } from "./catalog";
import type {
  ChatGroup,
  ChatRow,
  NoteGroup,
  NoteRow,
  SearchResult,
  SearchScope,
} from "./types";

// ---- the find bar's handle ----------------------------------------------

/** What the panel asks of ⌘F's bar: open with a query without taking
 *  focus, landing on the first hit inside a given turn. */
export interface FindBarHandle {
  openWith(query: string, turn?: number): void;
  /** The bar's query, or "" while it is closed. */
  query(): string;
}

let bar: FindBarHandle | null = null;

/** `FindBar.svelte` registers on mount and unregisters on destroy. */
export function registerFindBar(handle: FindBarHandle | null): void {
  bar = handle;
}

export function findBar(): FindBarHandle | null {
  return bar;
}

// ---- rows -----------------------------------------------------------------

/** One row of the panel's list, with the group it belongs to. */
export type FlatRow =
  | { kind: "chat"; group: ChatGroup; row: ChatRow }
  | { kind: "note"; group: NoteGroup; row: NoteRow };

/**
 * The rows in the order they are drawn — chats as the store orders them
 * (newest first), each chat's rows in message order, then the notes — so
 * ↑↓ walks the panel top to bottom. A group past the row budget has no
 * rows and is skipped here; it still lists with its count.
 */
export function flatten(result: SearchResult | null): FlatRow[] {
  if (!result) return [];
  const out: FlatRow[] = [];
  for (const group of result.groups)
    for (const row of group.rows) out.push({ kind: "chat", group, row });
  for (const group of result.notes)
    for (const row of group.rows) out.push({ kind: "note", group, row });
  return out;
}

/** The selection after ↑ or ↓: clamped, not wrapped — a list, not a
 *  cycle; the bar behind wraps, this does not. Nowhere with no rows. */
export function stepRow(current: number, dir: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, current + dir));
}

/** The key a group folds under: the chat's id, or the note's scope and
 *  name. */
export function groupKey(g: ChatGroup | NoteGroup): string {
  return "id" in g ? g.id : `${g.scope}/${g.name}`;
}

// ---- the count line -------------------------------------------------------

/** `1,340` — the count line's numbers, grouped. */
export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/** `0.2 s` — the scan's time, one decimal; under 50 ms reads `0.0 s`
 *  rather than a millisecond figure nobody compares. */
export function elapsedLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The line under the scope: `14 matches in 9 messages · 4 chats`, or
 * `200 of 1,340 matches shown` with `narrow` set when the store capped
 * the rows (board 11c's "too many" state). Under *notes* the units are
 * lines and notes. `elapsed` is printed at the right.
 */
export function countLine(
  result: SearchResult,
  scope: SearchScope,
): { text: string; narrow: boolean; elapsed: string } {
  const elapsed = elapsedLabel(result.elapsed_ms);
  if (result.shown < result.messages) {
    return {
      text: `${thousands(result.shown)} of ${thousands(result.messages)} matches shown`,
      narrow: true,
      elapsed,
    };
  }
  const unit = scope === "notes" ? "line" : "message";
  const holder = scope === "notes" ? "note" : "chat";
  return {
    text: `${thousands(result.matches)} ${plural(result.matches, "match", "matches")} in ${thousands(result.messages)} ${plural(result.messages, unit, `${unit}s`)} · ${thousands(result.chats)} ${plural(result.chats, holder, `${holder}s`)}`,
    narrow: false,
    elapsed,
  };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The empty state's sentence: where nothing mentioned the query. */
export function emptyLine(query: string, scope: SearchScope): string {
  const where =
    scope === "this"
      ? "in this project"
      : scope === "all"
        ? "in any chat"
        : "in the notes";
  return `Nothing mentions “${query}” ${where}.`;
}

// ---- labels ---------------------------------------------------------------

/** Who said it, as the row prints it: `You`; the model by its family
 *  (`opus`) where the id carries one, else the id; `name` for a hit in
 *  the chat's title. */
export function whoLabel(who: string): string {
  if (who === "you") return "You";
  if (who === "name") return "name";
  return aliasOf(who) ?? who;
}

/** The scope control's three positions, in the drawn order. */
export const SCOPES: { scope: SearchScope; label: string }[] = [
  { scope: "this", label: "this project" },
  { scope: "all", label: "all chats" },
  { scope: "notes", label: "notes" },
];

/** `· 3 matches` after a row's time when the message holds more than one. */
export function matchesSuffix(n: number): string {
  return n > 1 ? ` · ${n} matches` : "";
}
