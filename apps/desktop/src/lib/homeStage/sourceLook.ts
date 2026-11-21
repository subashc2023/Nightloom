/**
 * Each source's look on Home (item 873, his "there's like no color, for the connectors"): a mark and a tint from
 * its service — Gmail red, Google Calendar blue, Claude clay, the Mac apps their own tints — so a row reads as what
 * it is at a glance. Pure; the Mac's Watch and the phone's Home on this Mac both draw from it. The tints are the
 * services' own colours lifted for a dark ground; the views mix them down (a low-alpha fill, an edge, the mark), so
 * no flat brand block sits inside Jarvis. A service not known here gets a stable hue from its name.
 */
import type { IconName } from "../icons";

export interface SourceLook {
  /** The tint, a CSS colour. */
  tint: string;
  icon: IconName;
}

/** Matched in order against the service's name, lower-cased; the first that fits wins. */
const KNOWN: [RegExp, SourceLook][] = [
  [/gmail|google mail/, { tint: "#f2675a", icon: "mail" }],
  [/google calendar/, { tint: "#6b9cf6", icon: "calendar" }],
  [/google drive|^drive$/, { tint: "#f5c443", icon: "drive" }],
  [/google docs/, { tint: "#5d93f2", icon: "note" }],
  [/google slides/, { tint: "#f4b63f", icon: "slides" }],
  [/google sheets/, { tint: "#3fbf7a", icon: "sheet" }],
  [/claude|anthropic/, { tint: "#e08a68", icon: "spark" }],
  [/outlook|microsoft|office/, { tint: "#4aa3f0", icon: "mail" }],
  [/slack/, { tint: "#e8638f", icon: "bubble" }],
  [/notion/, { tint: "#d9dde3", icon: "note" }],
  [/github/, { tint: "#c4ccd6", icon: "branch" }],
  [/linear/, { tint: "#8f97ea", icon: "checklist" }],
  [/figma/, { tint: "#a57ff2", icon: "image" }],
];

/** The Mac's own apps (item 808's ids), their app tints. */
const MAC: Record<string, SourceLook> = {
  messages: { tint: "#5cd27c", icon: "bubble" },
  reminders: { tint: "#f7a33c", icon: "checklist" },
  calendar: { tint: "#f2665e", icon: "calendar" },
  contacts: { tint: "#c3a27a", icon: "person" },
};

const KIND_ICON: Record<string, IconName> = { mail: "mail", calendar: "calendar", files: "note", other: "mcp" };

/** A stable hue from the name (FNV-1a), light enough for a dark ground. */
export function hueFor(name: string): string {
  let h = 0x811c9dc5;
  for (const c of name.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `hsl(${h % 360} 62% 68%)`;
}

/** A connector's look from its service's name and kind (mail, calendar, files, other). */
export function connectorLook(service: string, kind: string): SourceLook {
  const s = service.toLowerCase();
  for (const [re, look] of KNOWN) if (re.test(s)) return look;
  return { tint: hueFor(service), icon: KIND_ICON[kind] ?? "mcp" };
}

/** A Mac source's look by its id (messages, reminders, calendar, contacts). */
export function macLook(id: string): SourceLook {
  return MAC[id] ?? { tint: hueFor(id), icon: "read" };
}
