/**
 * Edits as versions (nightshift backlog 299): the stored *Make main* map,
 * what the arrows need read off the forks' logs, and the two actions —
 * Make main and opening a version. The rules are `versions.ts`.
 *
 * The map lives in this window's storage (`nightloom.versionsMain`), like
 * the forks' open set: nothing is written to a log, so a map lost puts
 * each original back as a row and loses nothing (blocker 1061).
 */
import * as api from "./api";
import { addToast, app, openSession, refreshSessions } from "./state.svelte";
import type { SessionEvent } from "./types";
import {
  VERSIONS_KEY,
  forkInfo,
  lineageForks,
  makeMain,
  parseVersions,
  replacedBy,
  versionsAt,
  type ForkInfo,
  type VersionMap,
} from "./versions";

function load(): VersionMap {
  try {
    return parseVersions(localStorage.getItem(VERSIONS_KEY));
  } catch {
    return {};
  }
}

export const versions = $state({
  map: (typeof localStorage === "undefined" ? {} : load()) as VersionMap,
  /** Per fork: what `forkInfo` read, and the listing's `modified` it read at. */
  info: {} as Record<string, ForkInfo & { modified: string }>,
});

function save(map: VersionMap): void {
  versions.map = map;
  try {
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(map));
  } catch {
    // best-effort, like the forks' open set
  }
}

const reading = new Set<string>();

/**
 * Read the fork info of every edit fork in chat `id`'s lineage that is
 * not read yet or has changed since. `events` is the chat's own log when
 * it is open, so the open chat is never peeked.
 */
export function ensureForkInfo(id: string, events: SessionEvent[] | null = null): void {
  for (const f of lineageForks(app.sessions, id)) {
    const meta = app.sessions.find((s) => s.id === f);
    if (!meta) continue;
    const have = versions.info[f];
    if (f === id && events) {
      const got = forkInfo(events);
      if (got && (!have || have.cut !== got.cut)) versions.info[f] = { ...got, modified: meta.modified };
      continue;
    }
    // Read once per listing stamp: a fork whose own message has not landed
    // yet is read again when its log changes, not on every pass.
    if (have && have.modified === meta.modified) continue;
    if (reading.has(f)) continue;
    reading.add(f);
    api
      .peekSession(f)
      .then((evs) => {
        const got = forkInfo(evs);
        if (got) versions.info[f] = { ...got, modified: meta.modified };
      })
      .catch(() => {
        // a log that cannot be read has no arrows; nothing else changes
      })
      .finally(() => reading.delete(f));
  }
}

/** The versions of chat `id`'s message at event `index`, in order, or null. */
export function versionsOf(id: string, index: number): string[] | null {
  const info = new Map(Object.entries(versions.info));
  return versionsAt(app.sessions, info, id, index);
}

/** Open a version in the tab in front, as a sidebar click would. */
export function openVersion(id: string): void {
  if (id === app.activeSessionId) return;
  app.openNext = "replace";
  void openSession(id);
}

/**
 * *Make main* on chat `id`: it takes the row, the name and the place of
 * the chat it replaces, which stays a version (‹ › under the edited
 * message). The toast's Undo puts the map and the name back.
 */
export async function makeMainChat(id: string): Promise<void> {
  const replaced = replacedBy(app.sessions, versions.map, id);
  const next = replaced ? makeMain(app.sessions, versions.map, id) : null;
  if (!replaced || !next) return;
  const before = versions.map;
  const meta = app.sessions.find((s) => s.id === id);
  const old = app.sessions.find((s) => s.id === replaced);
  const ownTitle = meta?.title ?? null;
  const takeTitle = old?.title && old.title !== ownTitle ? old.title : null;
  save(next);
  // The name: the original's, when it has one (the row he knew it by).
  // A refused rename (the fork mid-turn) leaves its own name; the place
  // is taken either way.
  if (takeTitle) {
    try {
      await api.renameSession(id, takeTitle, app.activeSessionId);
    } catch (e) {
      addToast(`Made main; kept its own name (${String(e)})`);
    }
  }
  await refreshSessions();
  addToast("Made main — the earlier version is under the edited message (‹ ›)", {
    label: "Undo",
    run: () => {
      save(before);
      void (async () => {
        if (takeTitle && ownTitle) {
          try {
            await api.renameSession(id, ownTitle, app.activeSessionId);
          } catch (e) {
            addToast(String(e));
          }
        }
        await refreshSessions();
      })();
    },
  });
}
