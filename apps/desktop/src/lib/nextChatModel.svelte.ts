/**
 * Item 705 (his words, 2026-11-15: "in the handoff prompt should be a button
 * to choose which model the new chat is in. By default it should be the same
 * model that the previous chat was in"): the *Next chat* pick, per wrapped
 * chat. "" is the default — the wrapped chat's own model, no switch. Kept on
 * disk (`viewState`) so the pick survives a chat switch and a relaunch; the
 * hand-off card and the reply's next-chat card read and write the same value,
 * so the two always agree. `openContinuation` (state.svelte.ts) puts the new
 * chat on it.
 */
import { viewGet, viewSet } from "./viewState";

const tick = $state({ n: 0 });
const key = (chat: string) => `handoff.next-model:${chat}`;

/** The pick for the chat after `chat`: a Claude Code model id or alias, or "" (this chat's). */
export function nextModel(chat: string | null): string {
  void tick.n;
  return chat ? viewGet(key(chat), "") : "";
}

export function setNextModel(chat: string | null, model: string): void {
  if (!chat) return;
  viewSet(key(chat), model.trim(), "");
  tick.n++;
}

/** One row of the pick's menu. `id` is what `setNextModel` keeps. */
export interface NextModelRow {
  id: string;
  label: string;
  detail?: string;
  on: boolean;
}

/**
 * The menu's rows and this chat's model name, drawn by the main composer from
 * the same family rows as its own model menu (`familyRows`), and read by the
 * reply's next-chat card (`handoffButton.ts`), which has no model list of its
 * own. Written by the composer only (one writer).
 */
export const nextModelMenu = $state<{ chatName: string; families: { pick: string; label: string; detail: string; key: string }[] }>({
  chatName: "",
  families: [],
});

/** The rows for `chat`'s pick: "this chat's" first, then one per family. */
export function nextModelRows(chat: string | null): NextModelRow[] {
  const cur = nextModel(chat);
  const rows: NextModelRow[] = [
    { id: "", label: "this chat's", detail: nextModelMenu.chatName ? `${nextModelMenu.chatName} · the default` : "the default", on: cur === "" },
  ];
  for (const f of nextModelMenu.families) rows.push({ id: f.pick, label: f.label, detail: f.detail, on: cur !== "" && cur === f.pick });
  if (cur !== "" && !rows.some((r) => r.on)) rows.push({ id: cur, label: cur, on: true });
  return rows;
}

/** What the pick's button reads: the model's name, and whether it is the default. */
export function nextModelLabel(chat: string | null): { name: string; isDefault: boolean } {
  const cur = nextModel(chat);
  if (cur === "") return { name: nextModelMenu.chatName || "this chat's", isDefault: true };
  const fam = nextModelMenu.families.find((f) => f.pick === cur);
  return { name: fam?.label ?? cur, isDefault: false };
}
