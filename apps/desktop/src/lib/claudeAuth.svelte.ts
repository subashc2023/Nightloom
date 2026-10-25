/**
 * Claude Code's sign-in, the state and the Sign in action (nightshift
 * backlog 409). The rules are `claudeAuth.ts`.
 *
 * - **Probe**: `claude auth status` (the service reads `loggedIn` alone) at
 *   each Claude Code connect, when a signed-out notice mounts (at most every
 *   `PROBE_MIN_GAP_MS`), on window focus while signed out, and every
 *   `SIGN_IN_POLL_MS` while a Sign in tab is open. The engine chip reads it.
 * - **Sign in**: a new terminal tab — the chat's folder, else home — with
 *   `'<absolute cli>' auth login` typed in. Retry (item 333) sends the
 *   message again once he has signed in; nothing is resent by itself.
 */
import * as api from "./api";
import { app, addToast } from "./state.svelte";
import type { ClaudeAuthStatus } from "./types";
import {
  PROBE_MIN_GAP_MS,
  SIGN_IN_POLL_LIMIT_MS,
  SIGN_IN_POLL_MS,
  loginCommand,
  type SignInPhase,
} from "./claudeAuth";

export const auth = $state({
  /** The last status: true, false, or null before one was read / unreadable. */
  signedIn: null as boolean | null,
  /** The absolute CLI the last status was read from. */
  binary: null as string | null,
  home: null as string | null,
  /** Where the notice's Sign in stands. */
  phase: "idle" as SignInPhase,
  /** When the last probe started (ms). */
  probedAt: 0,
});

/** The connected Claude Code chat's binary, else null (`claude` resolved). */
function connectedBinary(): string | null {
  return app.connection?.engine === "claude-code" ? (app.connection.agent?.binary ?? null) : null;
}

let focusHooked = false;

/** Ask the CLI whether it is signed in. Never throws. */
export async function probeAuth(binary: string | null = connectedBinary()): Promise<ClaudeAuthStatus | null> {
  auth.probedAt = Date.now();
  hookFocus();
  try {
    const s = await api.claudeAuthStatus(binary);
    const was = auth.signedIn;
    auth.signedIn = s.signed_in;
    auth.binary = s.binary;
    auth.home = s.home;
    if (s.signed_in === true && was === false && auth.phase === "typed") auth.phase = "signed-in";
    return s;
  } catch {
    return null;
  }
}

/** A signed-out notice mounted: look again, unless a look was just made. */
export function probeSoon(now = Date.now()): void {
  if (now - auth.probedAt < PROBE_MIN_GAP_MS) return;
  void probeAuth();
}

function hookFocus(): void {
  if (focusHooked || typeof window === "undefined") return;
  focusHooked = true;
  window.addEventListener("focus", () => {
    if (auth.signedIn === false) void probeAuth();
  });
}

let poll: ReturnType<typeof setTimeout> | null = null;

function pollUntilSignedIn(started: number): void {
  if (poll) clearTimeout(poll);
  poll = setTimeout(async () => {
    poll = null;
    const s = await probeAuth();
    if (s?.signed_in === true) return; // probeAuth moved the phase on

    if (Date.now() - started < SIGN_IN_POLL_LIMIT_MS) pollUntilSignedIn(started);
  }, SIGN_IN_POLL_MS);
}

/**
 * Sign in: a new terminal tab with the CLI's login typed in by its absolute
 * path. True when the line was typed.
 */
export async function signIn(): Promise<boolean> {
  auth.phase = "opening";
  const s = await probeAuth();
  const binary = s?.binary ?? auth.binary;
  if (!binary) {
    auth.phase = "failed";
    addToast("Could not find Claude Code to sign in with");
    return false;
  }
  // Loaded here, not at the top: `state.svelte` imports this file at
  // start-up, and the terminal store reaches into `state.svelte` as it loads.
  const { newShell } = await import("./terminal.svelte");
  const row = await newShell(null, s?.home ?? auth.home);
  if (!row) {
    auth.phase = "failed";
    return false;
  }
  try {
    // Enter is a carriage return, as xterm sends it.
    await api.terminalWrite(row.id, `${loginCommand(binary)}\r`);
  } catch (e) {
    auth.phase = "failed";
    addToast(`Could not type the sign-in into the terminal: ${String(e)}`);
    return false;
  }
  auth.phase = "typed";
  // Watched only from a status that said signed out: a CLI whose status
  // still says signed in while its refresh fails (possible — the status
  // reads stored credentials) has no change to see, and the notice's words
  // already say to press Retry once the terminal is done.
  if (auth.signedIn === false) pollUntilSignedIn(Date.now());
  return true;
}

/** The line Sign in types, for the notice's fallback and its tooltip. */
export function signInLine(): string {
  return loginCommand(auth.binary ?? "claude");
}

/** For tests: back to the start. */
export function resetAuthForTest(): void {
  if (poll) clearTimeout(poll);
  poll = null;
  auth.signedIn = null;
  auth.binary = null;
  auth.home = null;
  auth.phase = "idle";
  auth.probedAt = 0;
}
