/**
 * The stage's tab row (item 845), pure. Watch is always there (it is what Home does when nothing else is live); the
 * conversation is the Chat tab once the chat has a message. Views that draw live work (Brief, Run, and the task
 * views) add their tabs through `more`.
 */
import type { ViewId } from "./stageState.svelte";

export interface Tab {
  id: string;
  view: ViewId;
  name: string;
  needs: number;
  /** Its pulse shows: something is running in it. */
  live: boolean;
}

export function tabsFor(o: { blank: boolean; needs: number; more?: readonly Tab[] }): Tab[] {
  const row: Tab[] = [{ id: "watch", view: "watch", name: "Watching", needs: o.needs, live: false }];
  for (const t of o.more ?? []) row.push(t);
  if (!o.blank) row.push({ id: "chat", view: "chat", name: "Chat", needs: 0, live: false });
  return row;
}

/** The tab in focus: the one he left it on, or Watch when that tab is gone. */
export function focusOf(row: readonly Tab[], kept: string): Tab {
  return row.find((t) => t.id === kept) ?? row[0];
}
