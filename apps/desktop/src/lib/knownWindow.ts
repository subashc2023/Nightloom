/**
 * A Claude Code chat's context window before its first turn (nightshift
 * item 714, his "why tf is this window unknown").
 *
 * The backend reads the window off the id this chat's last turn reported
 * (`claude_code_window`, item 216), so a new chat on an alias (`fable`,
 * `opus`) had none until a turn ran, and every new-chat page said "window
 * unknown". The app does know which model the alias names: every turn
 * records `alias → id` (`modelSeen`, item 511). This picks the id whose
 * window the limits table is asked for, and says where it came from, in
 * order of trust:
 *
 * 1. what the alias resolved to on the CLI running now;
 * 2. what it resolved to on an earlier CLI (a CLI update can move an
 *    alias, so the source says which version);
 * 3. the alias's family's newest model this build lists (`NEWEST`), when
 *    no turn has run on the alias at all — named as such.
 *
 * A full id is the backend's own case (the table reads it directly), and
 * the CLI's default with no record names no family, so both give null.
 */
import { NEWEST, displayName, familyOf, isFullId, type SeenModels } from "./modelSeen";

export interface WindowModel {
  /** The full id the window is looked up for. */
  id: string;
  /** The source, short enough for the read-out's mono line. */
  from: string;
}

export function windowModelFor(seen: SeenModels, alias: string, cliNow: string | null): WindowModel | null {
  let a = alias.trim();
  if (a.toLowerCase() === "default") a = "";
  if (isFullId(a)) return null;
  const r = seen[a];
  const name = a || "default";
  if (r) {
    const same = cliNow === null || r.cliVersion === cliNow;
    const on = r.cliVersion ? ` on CLI ${r.cliVersion}` : "";
    const now = same ? "" : `, not yet run on ${cliNow}`;
    return { id: r.id, from: `${name} → ${displayName(r.id)}${on}${now}` };
  }
  if (!a) return null;
  const fam = a.toLowerCase().replace(/\[[^\]]*\]$/, "");
  const newest = NEWEST.find((id) => familyOf(id) === fam);
  if (!newest) return null;
  return { id: newest, from: `${displayName(newest)}, the newest listed; ${a} not run yet` };
}
