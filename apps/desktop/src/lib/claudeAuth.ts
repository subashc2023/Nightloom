/**
 * Claude Code's sign-in, the pure part (nightshift backlog 409, 2026-10-24).
 * The store and the Sign in action are `claudeAuth.svelte.ts`; the service's
 * side is `crates/nightloom-service/src/cli_auth.rs`.
 *
 * The Sign in button opens a terminal tab and types the CLI's own login
 * there by its **absolute path** — the binary Nightloom runs, not `claude`
 * on the shell's PATH (his zsh startup had been interrupted and `claude`
 * was "command not found"). The entry point is `claude auth login`
 * (`claude auth --help`, 2.1.310). The terminal panel cannot run a command
 * of its own (its shell is the login shell, nothing more), so the line is
 * typed in; a login zsh runs input typed before its prompt (measured).
 */

/** A word for a POSIX shell, single-quoted: `'…'`, any `'` inside as `'\''`. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into the Sign in tab: `'<absolute cli>' auth login`. */
export function loginCommand(binary: string): string {
  return `${shellQuote(binary)} auth login`;
}

/** The engine chip's second word for the sign-in, or null to leave it be:
 *  only a status that said signed out changes it (unknown is not out). */
export function chipWord(signedIn: boolean | null): string | null {
  return signedIn === false ? "signed out" : null;
}

/** While a Sign in tab is open: look at the status this often … */
export const SIGN_IN_POLL_MS = 5_000;
/** … for at most this long (a login abandoned in the tab stops the look). */
export const SIGN_IN_POLL_LIMIT_MS = 10 * 60_000;
/** A notice mounting asks again at most this often (a chat full of old
 *  signed-out replies asks once). */
export const PROBE_MIN_GAP_MS = 30_000;

/** What the notice says under its title, by where the sign-in stands. */
export type SignInPhase = "idle" | "opening" | "typed" | "signed-in" | "failed";

export function phaseLine(phase: SignInPhase): string {
  switch (phase) {
    case "idle":
      return "Your message was not sent. Sign in, then press Retry.";
    case "opening":
      return "Opening a terminal…";
    case "typed":
      return "Finish signing in in the terminal below (a browser page opens), then press Retry.";
    case "signed-in":
      return "Claude Code is signed in again. Press Retry to send your message.";
    case "failed":
      return "Could not open a terminal for the sign-in. In any terminal, run the command below.";
  }
}
