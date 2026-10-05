/**
 * Item 300, wave 8D (B1): the project on the phone's screen — the one the
 * header names — for calls that must never follow the host's open project
 * (the notes, and so the project's instructions). The host's open project
 * moves under the phone whenever a turn runs elsewhere; a note saved while
 * it moved went into the wrong project's AGENTS.md.
 */

/** The id the hosts use for No project (`serve::NO_PROJECT_ID`). */
export const NO_PROJECT = "unfiled";

export interface ScreenInput {
  /** The chat on screen; `null` is a new chat. */
  chatId: string | null;
  /** The chat's own project, named when it was opened (`null`: no project). */
  chatPid: string | null;
  /** The project a new chat starts in; `null` is the host's open one. */
  newProject: string | null;
  /** The host's open project's id; "" for none. */
  activePid: string;
  /** The host lists projects at all (an older host does not). */
  hasProjects: boolean;
}

/** The project id the screen shows: the chat's own, or the new chat's,
 *  `unfiled` for No project, `null` when the host lists no projects. */
export function screenProject(s: ScreenInput): string | null {
  if (!s.hasProjects) return null;
  if (s.chatId !== null) return s.chatPid ?? NO_PROJECT;
  return s.newProject ?? (s.activePid || NO_PROJECT);
}

/** The project the Notes sheet works in. A host that takes `?project=` on
 *  its notes routes (`notes_project`) gets the screen's; an older one
 *  reads only its open project, so the sheet names that one instead of
 *  claiming another project's notes. */
export function notesProject(s: ScreenInput, hostTakesProject: boolean): string | null {
  if (!s.hasProjects) return null;
  return hostTakesProject ? screenProject(s) : s.activePid || NO_PROJECT;
}
