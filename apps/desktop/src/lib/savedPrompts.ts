/**
 * Saved message prompts with blanks (nightshift item 800, from 793 #7) —
 * the pure part: the blanks, the `/name` token, the self-filling blanks,
 * and what a save, a delete and a restore do to the list. Shared by the
 * Mac's composer and Settings and by the phone's boxes, so they agree.
 *
 * A prompt is message text, never a system prompt: inserting one only
 * changes the box. `{word}` is a blank; Tab selects the next one, ⇧Tab the
 * one before. `{clipboard}`, `{date}` and `{selection}` fill themselves
 * when the prompt goes in — each stays a blank to type when it has nothing
 * to fill with (an empty clipboard, no text selected in the transcript).
 */

/** One earlier version, kept when an edit replaced it. */
export interface PromptVersion {
  name: string;
  body: string;
  /** Epoch ms when it was replaced. */
  at: number;
}

/** One saved prompt, as `saved-prompts.json` holds it. */
export interface MessagePrompt {
  id: string;
  /** What follows the slash. */
  name: string;
  body: string;
  updated: number;
  /** Newest first. */
  versions: PromptVersion[];
  /** Epoch ms it went to the trash; absent while live. */
  deleted?: number | null;
}

export interface PromptDoc {
  prompts: MessagePrompt[];
}

/** How many earlier versions a prompt keeps. */
export const MAX_VERSIONS = 20;

/** The blanks that fill themselves. */
export const AUTO_BLANKS = ["clipboard", "date", "selection"] as const;
export type AutoBlank = (typeof AUTO_BLANKS)[number];

/**
 * A blank: a word (letters, digits, spaces, `_`, `-`; up to 40) in braces.
 * Narrow on purpose, so a JSON object or a code block's braces in a prompt
 * (`{"a": 1}`, `{ x }` with spaces at the edge) are not taken for blanks.
 */
const BLANK = /\{([A-Za-z0-9][A-Za-z0-9 _-]{0,38}[A-Za-z0-9]|[A-Za-z0-9])\}/g;

/** A name `/name` can reach: letters, digits, `_`, `-`. */
export const NAME_OK = /^[A-Za-z0-9_-]{1,40}$/;

export interface Span {
  start: number;
  end: number;
}

/** Every blank in `text`, in order. */
export function blanks(text: string): (Span & { word: string })[] {
  const out: (Span & { word: string })[] = [];
  for (const m of text.matchAll(BLANK)) {
    out.push({ start: m.index, end: m.index + m[0].length, word: m[1] });
  }
  return out;
}

/** The blanks' words, each once, in order — what Settings lists. */
export function blankWords(body: string): string[] {
  return [...new Set(blanks(body).map((b) => b.word))];
}

/**
 * The blank Tab goes to from a selection `[from, to]`: the first that
 * starts at or after `to` (the selected blank itself is skipped), wrapping
 * to the first; ⇧Tab the last that ends at or before `from`, wrapping to the
 * last. Null when the text has none.
 */
export function nextBlank(text: string, from: number, to: number, back = false): Span | null {
  const all = blanks(text);
  if (all.length === 0) return null;
  if (back) {
    const before = all.filter((b) => b.end <= from && !(b.start === from && b.end === to));
    const pick = before.length ? before[before.length - 1] : all[all.length - 1];
    return { start: pick.start, end: pick.end };
  }
  const after = all.find((b) => b.start >= to && !(b.start === from && b.end === to));
  const pick = after ?? all[0];
  return { start: pick.start, end: pick.end };
}

/** The `/word` being typed that ends at `caret`: at the start of the box or
 *  of a line, or after a space. `query` is what follows the slash. */
export function slashToken(text: string, caret: number): (Span & { query: string }) | null {
  const head = text.slice(0, caret);
  const m = /(^|[\s])\/([A-Za-z0-9_-]*)$/.exec(head);
  if (!m) return null;
  const start = caret - m[2].length - 1;
  return { start, end: caret, query: m[2] };
}

/** Live prompts whose name starts with `query`, an exact match first. */
export function matching<T extends { name: string; deleted?: number | null }>(list: T[], query: string, max = 12): T[] {
  const q = query.toLowerCase();
  const live = list.filter((p) => !p.deleted && p.name.toLowerCase().startsWith(q));
  live.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q));
  return live.slice(0, max);
}

/** Today as `2026-11-18`, in local time. */
export function dateWord(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export interface Fills {
  clipboard?: string | null;
  selection?: string | null;
  date?: string;
}

/** Whether a body asks for the clipboard (so the clipboard is read only
 *  when a prompt names it). */
export function wantsClipboard(body: string): boolean {
  return blanks(body).some((b) => b.word === "clipboard");
}

/** The body with its self-filling blanks filled; one with nothing to fill
 *  with stays a blank. Other blanks are left for Tab. */
export function fillAuto(body: string, fills: Fills): string {
  const value: Record<AutoBlank, string | null | undefined> = {
    clipboard: fills.clipboard,
    selection: fills.selection,
    date: fills.date ?? dateWord(),
  };
  return body.replace(BLANK, (whole, word: string) => {
    const v = (AUTO_BLANKS as readonly string[]).includes(word) ? value[word as AutoBlank] : null;
    return v ? v : whole;
  });
}

/**
 * Put a prompt in place of the `/word` token: the new text, and what to
 * select — the first blank left, else the caret at the end of the insert.
 */
export function insertAt(text: string, token: Span, filled: string): { text: string; select: Span } {
  const next = text.slice(0, token.start) + filled + text.slice(token.end);
  const inserted = blanks(filled)[0];
  const select = inserted
    ? { start: token.start + inserted.start, end: token.start + inserted.end }
    : { start: token.start + filled.length, end: token.start + filled.length };
  return { text: next, select };
}

/** A fresh id, unique enough within one file. */
export function newId(now = Date.now()): string {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Why `name` cannot be saved, or null. `id` is the prompt being edited. */
export function nameProblem(list: MessagePrompt[], name: string, id: string | null): string | null {
  const n = name.trim();
  if (!n) return "Give it a name — it is what you type after the slash.";
  if (!NAME_OK.test(n)) return "A name is letters, digits, - and _ only (no spaces), so /name can reach it.";
  const clash = list.find((p) => !p.deleted && p.id !== id && p.name.toLowerCase() === n.toLowerCase());
  return clash ? `/${clash.name} already exists.` : null;
}

/**
 * Save `name` and `body` as prompt `id` (null: a new one, added at the end).
 * An edit that changes either keeps the version it replaces, newest first,
 * up to {@link MAX_VERSIONS}; an edit that changes nothing changes nothing.
 */
export function saveIn(list: MessagePrompt[], id: string | null, name: string, body: string, now = Date.now()): MessagePrompt[] {
  const n = name.trim();
  if (id === null) {
    return [...list, { id: newId(now), name: n, body, updated: now, versions: [] }];
  }
  return list.map((p) => {
    if (p.id !== id) return p;
    if (p.name === n && p.body === body) return p;
    const kept: PromptVersion = { name: p.name, body: p.body, at: now };
    return { ...p, name: n, body, updated: now, versions: [kept, ...p.versions].slice(0, MAX_VERSIONS) };
  });
}

/** Put an earlier version back; the text it replaces is kept as a version. */
export function restoreVersion(list: MessagePrompt[], id: string, index: number, now = Date.now()): MessagePrompt[] {
  const p = list.find((x) => x.id === id);
  const v = p?.versions[index];
  if (!p || !v) return list;
  return saveIn(list, id, v.name, v.body, now);
}

/** Move a prompt to the trash (Delete confirms first; practices §7). */
export function trash(list: MessagePrompt[], id: string, now = Date.now()): MessagePrompt[] {
  return list.map((p) => (p.id === id ? { ...p, deleted: now } : p));
}

/** Bring a prompt back from the trash; refused (null) when a live prompt
 *  has taken its name meanwhile. */
export function untrash(list: MessagePrompt[], id: string): MessagePrompt[] | null {
  const p = list.find((x) => x.id === id);
  if (!p) return list;
  if (nameProblem(list, p.name, id)) return null;
  return list.map((x) => (x.id === id ? { ...x, deleted: null } : x));
}

/** Move a live prompt one place up (-1) or down (+1) among the live ones. */
export function move(list: MessagePrompt[], id: string, by: -1 | 1): MessagePrompt[] {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return list;
  let j = i + by;
  while (j >= 0 && j < list.length && list[j].deleted) j += by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * The spec-launch prompt the list starts with (793 #7: "his wrap-up and
 * spec-launch prompts are saved as the first two"). Modelled on the
 * orchestrator's launch lines in nightshift-code; his own wording is his
 * to change in Settings (blocker note in the 800 report).
 */
export const SPEC_LAUNCH =
  "Launch {item} from its spec {spec} as a subagent, per practices §3: usage first, tell me the expected cost, " +
  "pin the model, log the launch as a Progress line, and tell me the moment it reports. Spot-check one cited path " +
  "before you accept it. Today is {date}.";

/** The two prompts a list that never existed starts with. */
export function seeds(wrapUp: string, now = Date.now()): MessagePrompt[] {
  return [
    { id: newId(now), name: "wrapup", body: wrapUp, updated: now, versions: [] },
    { id: newId(now + 1), name: "spec", body: SPEC_LAUNCH, updated: now, versions: [] },
  ];
}
