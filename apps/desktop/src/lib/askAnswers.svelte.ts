// What he answered to the model's questions, by tool call id (backlog 354), so the answered table under the call
// has the answers as he gave them. The CLI's result text varies by version; it is only the fallback
// (`answersFromResult`). Kept in localStorage, newest 200 calls; storage refused → this window only.
import type { AnsweredRow } from "./askQuestions";

const KEY = "nightloom.ask.answers";
const KEEP = 200;

type Entry = { rows: AnsweredRow[]; at: string };

function load(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

const store = $state<{ byCall: Record<string, Entry> }>({ byCall: load() });

/** Remember the answers he gave to the call `id`. */
export function recordAnswers(id: string, rows: AnsweredRow[], now = new Date()): void {
  store.byCall[id] = { rows, at: now.toISOString() };
  const ids = Object.keys(store.byCall);
  if (ids.length > KEEP) {
    ids
      .sort((a, b) => store.byCall[a].at.localeCompare(store.byCall[b].at))
      .slice(0, ids.length - KEEP)
      .forEach((old) => delete store.byCall[old]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store.byCall));
  } catch {
    // Storage refused: the table holds for this window only.
  }
}

/** The answers recorded for the call `id`, if any. */
export function recordedAnswers(id: string): Entry | null {
  return store.byCall[id] ?? null;
}
