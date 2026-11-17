/**
 * What macOS keeps on this Mac, for Home (nightshift item 808): Messages,
 * Contacts, Reminders and the Calendar app. The rows come from the Mac
 * (`home_sources`, or `GET /api/home/sources` on the phone); this is the
 * words and the one button each row shows — the same on the Mac and the
 * phone. Pure, so vitest covers it.
 */

export type SourceId = "messages" | "contacts" | "reminders" | "calendar";
export type SourceStatus = "allowed" | "not_asked" | "denied" | "write_only" | "not_on_this_mac";

export interface HomeSource {
  id: SourceId;
  name: string;
  status: SourceStatus;
  /** His switch; meaningful once allowed. */
  on: boolean;
  /** What it means now, in one sentence (the Mac's words). */
  why: string;
  /** The System Settings pane for it. */
  settings_url: string;
}

/** The status tag. */
export function sourceStatusWords(s: SourceStatus): string {
  switch (s) {
    case "allowed":
      return "Allowed";
    case "not_asked":
      return "Not allowed yet";
    case "denied":
      return "Turned down";
    case "write_only":
      return "Add only";
    case "not_on_this_mac":
      return "Not on this Mac";
  }
}

/** The row's button on the Mac: Allow (asks macOS, or opens Full Disk
 *  Access for Messages), Open System Settings (a no or add-only is
 *  changed there), or none. */
export function sourceButton(r: HomeSource): "Allow" | "Open System Settings" | null {
  if (r.status === "not_asked") return "Allow";
  if (r.status === "denied" || r.status === "write_only") return r.id === "messages" ? "Allow" : "Open System Settings";
  return null;
}

/** What to do after pressing Allow on Messages, in one line. */
export const MESSAGES_STEP = "In System Settings, turn on Nightloom under Full Disk Access, then come back here.";

/** The phone's button: ask the Mac, for every row not yet allowed. */
export function canAsk(r: HomeSource): boolean {
  return r.status === "not_asked" || r.status === "denied" || r.status === "write_only";
}

/** Read by the scan now. */
export function isRead(r: HomeSource): boolean {
  return r.status === "allowed" && r.on;
}

/** The group's one-line summary. */
export function sourcesSummary(rows: HomeSource[]): string {
  if (rows.length === 0) return "";
  if (rows.every((r) => r.status === "not_on_this_mac")) return "Only the Nightloom app on your Mac reads these.";
  const read = rows.filter(isRead).map((r) => r.name);
  if (read.length === 0) return "The morning scan reads none of these yet.";
  if (read.length === rows.length) return "The morning scan reads all four.";
  return `The morning scan reads ${read.join(", ")}.`;
}
