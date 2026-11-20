// The drive card (nightshift item 872 step 5): Home calls
// `ask_user_to_drive` when a page in Claude's browser needs his own hands —
// a sign-in, a code, a choice only he can make. The card's Take control
// opens the chat's browser tab with the browser held for him; Hand back
// gives it back and answers Allow with the page he left it on and his note
// (`handed_back`). The backend keeps that for the tool and never reads a
// `handed_back` the model wrote itself (`home::drive`).
// Pure: the words and the answer the Mac's card and the phone's card share.

/** The tool's name on the Claude Code engine (`home::drive::TOOL`). */
export const DRIVE_TOOL = "mcp__nightloom__ask_user_to_drive";

export function isDriveRequest(name: string): boolean {
  return name === DRIVE_TOOL;
}

/** The model's one line: what he is to do on the page. */
export function driveWhy(input: unknown): string | null {
  const why = (input as { why?: unknown } | null | undefined)?.why;
  return typeof why === "string" && why.trim() ? why.trim() : null;
}

export interface HandedBack {
  url: string;
  title: string;
  note: string;
}

/**
 * Hand back's answer: the call's input with `handed_back` set from the
 * browser's status and his note — over anything the model put there.
 */
export function handBackAnswer(
  input: unknown,
  page: { url?: string; title?: string } | null | undefined,
  note: string,
): Record<string, unknown> {
  const base = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const handed: HandedBack = { url: page?.url?.trim() ?? "", title: page?.title?.trim() ?? "", note: note.trim() };
  return { ...base, handed_back: handed };
}

/**
 * Where the card's own state is kept (`viewState`): by the chat and the
 * ask's words, not the call's id — the same ask made again (set aside and
 * back, or asked again after a relaunch) finds his note and whether he had
 * taken the page.
 */
export function driveKey(chat: string | null | undefined, input: unknown, what: "note" | "took"): string {
  return `drive.${what}:${chat ?? ""}:${driveWhy(input) ?? ""}`;
}

/** The reason the model reads when he declines. */
export const DRIVE_DECLINED =
  "The user declined to take the page. Do not ask again in this reply unless they say to; carry on without it or say what you could not do.";

export const DRIVE_HEAD = "Home asks you to take the page";
/** No reason given by the model. */
export const DRIVE_NO_WHY = "It did not say what to do there.";
/** The card's one line on what happens. */
export const DRIVE_WHERE = "Claude's browser waits while you have it. Nothing is read or clicked until you hand it back.";
/** No browser to take: Home called before opening a page. */
export const DRIVE_NO_BROWSER = "Claude's browser is not open in this chat, so there is no page to take. Decline, or reply to tell Home to open the page first.";
/** After Take control, back on the card. */
export const DRIVE_TOOK = "You took the page. Hand it back when you are done there.";
/** The phone's line: the Mac's browser cannot be driven from it. */
export const DRIVE_PHONE = "Open Nightloom on your Mac to take the page.";

/** The buttons' tips (two short lines at most). */
export const TAKE_TIP = "Opens Claude's browser tab, held for you.\nClaude waits.";
export const HAND_BACK_TIP = "Gives the browser back.\nHome gets the page you left it on and your note.";
export const DRIVE_LATER_TIP = "Home does the rest of the task first,\nthen asks you again.";
export const DRIVE_DECLINE_TIP = "Home carries on without it.";
