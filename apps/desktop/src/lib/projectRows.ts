import type { ProjectInfo } from "./types";

/**
 * What a project write does to the project list on screen, before any
 * re-read of the disk (nightshift backlog 211's leftovers, 2026-09-26).
 *
 * Since 211 (`afterWrite.ts`) a write acknowledges from what the app already
 * knows and the re-read follows in the background under
 * `REFRESH_LIMIT_MS`. Create, open-folder, rename and forget still sat on
 * `refreshProjects()` first — the New-project form stayed up until a list
 * that could hang on an iCloud folder came back. The backend answers each
 * of those writes with the project it wrote, which is all the row needs.
 */

/** The list with `project` in it: replaced where its id is, else first
 *  (a project just made or opened is the most recently opened). */
export function withProject(list: ProjectInfo[], project: ProjectInfo): ProjectInfo[] {
  const at = list.findIndex((p) => p.id === project.id);
  if (at === -1) return [project, ...list];
  const next = list.slice();
  next[at] = project;
  return next;
}

/** The list without project `id`. */
export function withoutProject(list: ProjectInfo[], id: string): ProjectInfo[] {
  return list.filter((p) => p.id !== id);
}
