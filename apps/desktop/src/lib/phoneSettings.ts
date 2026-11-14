/**
 * Settings → Phone's one sentence (item 588): what the switch does, in
 * the state it is in. Pure, so it is under `phoneSettings.test.ts`.
 */
import type { RemoteStatus } from "./types";

/** The switch as he set it; an older backend without `wanted` reports the listener. */
export function phoneWanted(st: RemoteStatus | null): boolean {
  return !!(st?.wanted ?? st?.on);
}

export function phoneLine(st: RemoteStatus | null): string {
  if (!st) return "Reading the phone switch…";
  if (!phoneWanted(st)) return "Off — your phone cannot reach Nightloom. Turn it on to get the code to scan.";
  const kind = st.phone_kind ?? null;
  const waiting = !st.on;
  if (kind === "both")
    return waiting
      ? "On, waiting for Tailscale on this Mac — it comes up by itself. Scan this once and keep the page: it uses this Mac when it answers and the away server when the lid is closed."
      : "On. Scan this once with your phone's camera and keep the page: it uses this Mac while it is awake and the away server when the lid is closed — by itself.";
  if (kind === "away")
    return "On. Scan this once and keep the page: it talks to the away server, which answers with the lid closed (this Mac's own address is not HTTPS, so the page cannot also call it).";
  if (waiting)
    return "On, waiting for Tailscale on this Mac — it comes up by itself. Set up the away server (Settings → Away server) so the phone works with the lid closed.";
  return "On. Scan this with your phone's camera. It reaches this Mac only while it is awake; set up the away server for the lid closed.";
}

/** The link as the card prints it: the tokens stay the QR's. */
export function maskedLink(url: string | null | undefined): string {
  return (url ?? "").replace(/#.*$/, "#…");
}
