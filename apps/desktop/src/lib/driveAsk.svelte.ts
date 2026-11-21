/**
 * The drive card's actions (nightshift item 872 step 5), shared by the card
 * in the chat (`DriveCard`) and the line in Claude's browser tab
 * (`ClaudeBrowserView`): take the page, hand it back. The pure half is
 * `drive.ts`.
 *
 * His note and whether he took the page are kept in `viewState` by the
 * chat and the ask (`driveKey`), written as he types: the card is drawn
 * afresh each time he comes back from the browser tab, and the same ask
 * made again after a set-aside or a relaunch finds them.
 */
import { app, resolveApproval } from "./state.svelte";
import { browsers, openBrowserTab, readStatus, setHold } from "./claudeBrowser.svelte";
import { driveKey, handBackAnswer, isDriveRequest } from "./drive";
import { viewGet, viewSet } from "./viewState";
import type { ApprovalRequest } from "./types";

/** The chat whose browser the ask is about. */
export function driveChat(req: ApprovalRequest): string {
  return req.chat ?? app.activeSessionId ?? "";
}

/** The drive ask waiting in `session`, if one is. */
export function pendingDrive(session: string): ApprovalRequest | null {
  return app.pendingApprovals.find((r) => isDriveRequest(r.name) && driveChat(r) === session) ?? null;
}

export function driveNote(req: ApprovalRequest): string {
  return viewGet(driveKey(driveChat(req), req.input, "note"), "");
}
export function setDriveNote(req: ApprovalRequest, note: string): void {
  viewSet(driveKey(driveChat(req), req.input, "note"), note, "");
}
export function driveTook(req: ApprovalRequest): boolean {
  return viewGet(driveKey(driveChat(req), req.input, "took"), false);
}
function setTook(req: ApprovalRequest, took: boolean): void {
  viewSet(driveKey(driveChat(req), req.input, "took"), took, false);
}

/**
 * The kept "took" flag, checked against the browser: when it is not held for
 * him (given back in the browser tab, the turn stopped, a relaunch), the ask
 * is untaken again. Returns whether he still has the page.
 */
export function settleTook(req: ApprovalRequest, heldByHim: boolean): boolean {
  if (!heldByHim && driveTook(req)) setTook(req, false);
  return driveTook(req);
}

/** The ask is over: nothing of it is kept. */
export function forgetDrive(req: ApprovalRequest): void {
  setDriveNote(req, "");
  setTook(req, false);
}

function words(e: unknown): string {
  return String(e).replace(/^Error:\s*/, "");
}

/**
 * Take control: the browser is held for him, then its tab comes forward.
 * The error to show, or null. Nothing opens when there is no browser.
 */
export async function takePage(req: ApprovalRequest): Promise<string | null> {
  const chat = driveChat(req);
  try {
    await setHold(chat, true);
  } catch (e) {
    return `Not taken: ${words(e)}.`;
  }
  setTook(req, true);
  try {
    await openBrowserTab(chat);
  } catch (e) {
    return `The browser is yours, but its tab did not open: ${words(e)}.`;
  }
  return null;
}

/**
 * Give the browser back without answering (Not now, Decline). He no longer
 * has the page, so the same ask made again opens untaken (his note stays).
 */
export async function releasePage(req: ApprovalRequest): Promise<void> {
  const chat = driveChat(req);
  setTook(req, false);
  if (browsers.byChat[chat]?.held_by !== "user") return;
  try {
    await setHold(chat, false);
  } catch {
    // Not running: nobody holds it.
  }
}

/**
 * Hand back: the browser goes back to Claude, and the ask is answered with
 * the page it is on now and his note. The error to show, or null. His note
 * is forgotten only once the answer was taken.
 */
export async function handBack(req: ApprovalRequest, note = driveNote(req)): Promise<string | null> {
  const chat = driveChat(req);
  try {
    await setHold(chat, false);
  } catch {
    // The browser ended while he had it: handed back with no page known.
  }
  await readStatus(chat);
  const s = browsers.byChat[chat];
  const ok = await resolveApproval(req.id, req.name, "allow", undefined, handBackAnswer(req.input, s?.live ? s : null, note));
  if (!ok) return "That request is no longer waiting: its reply has ended. Your note is kept.";
  forgetDrive(req);
  return null;
}
