/**
 * A thread's next-chat prompt (nightshift item 464, 2026-10-28; his words in
 * backlog/464: "If I just clicked plus, it just put in the handoff").
 *
 * At a turn's end in a chat bound to a thread, the reply's last `<handoff>`
 * block (`handoffTag.ts`) is saved on the thread (`handoff.json` beside
 * `thread.md`, Rust `thread_handoff`). The thread's + then takes it: the
 * first child chat opened after it was saved gets exactly that text in its
 * box, never sent; any later + opens an empty box until a newer hand-off is
 * saved. Only a finished reply is read — mid-stream text is never kept.
 */
import * as api from "./api";
import { lastReplyText, threadFor } from "./handoff.svelte";
import { extractHandoff } from "./handoffTag";
import type { SessionEvent } from "./types";

/** The saves in flight, so a + right after a turn's end waits for its save. */
let pending: Promise<unknown> = Promise.resolve();

/** What a turn's end saves for `chat`: its thread and the prompt, or null. */
export function handoffToSave(chat: string | null, events: SessionEvent[] | null): { slug: string; text: string } | null {
  const slug = threadFor(chat);
  if (!slug || !events) return null;
  const text = extractHandoff(lastReplyText(events));
  return text ? { slug, text } : null;
}

/** At a turn's end: keep the reply's hand-off on the chat's thread, if it has
 *  both. Best-effort — a failed save leaves the card in the reply to copy. */
export function noteThreadHandoff(chat: string | null, events: SessionEvent[] | null): void {
  const save = handoffToSave(chat, events);
  if (!chat || !save) return;
  pending = pending.then(() => api.saveThreadHandoff(save.slug, save.text, chat).catch(() => null));
}

/** The thread's + for the new child chat `chat`: the saved prompt if no child
 *  chat has started from it yet, else null (an empty box). */
export async function takeThreadHandoff(slug: string, chat: string): Promise<string | null> {
  await pending;
  try {
    const text = await api.takeThreadHandoff(slug, chat);
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}
