/**
 * Brief (item 845), pure: the newest morning scan in the Home chat — the page Home wrote, cut into its sections so
 * each opens on its own, and the counts the page's top row shows.
 */
import type { Ev } from "./steps";

export interface BriefSection {
  key: string;
  title: string;
  body: string;
  /** Its list lines ("- …", "1. …"), counted for the top row. */
  lines: number;
}
export interface Brief {
  at: string | null;
  /** The scan's own message (the facts it was given). */
  asked: string;
  sections: BriefSection[];
  /** Home is still writing it. */
  writing: boolean;
}

/** A page of markdown cut at its headings ("# x", "## x", or a line that is only **x**). Text before the first is "Summary". */
export function sectionsOf(page: string): BriefSection[] {
  const out: BriefSection[] = [];
  let cur: { title: string; body: string[] } = { title: "Summary", body: [] };
  const push = () => {
    const body = cur.body.join("\n").trim();
    if (body) out.push({ key: `${out.length}:${cur.title}`, title: cur.title, body, lines: cur.body.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length });
  };
  for (const line of page.split("\n")) {
    const h = /^#{1,4}\s+(.+?)\s*#*$/.exec(line) ?? /^\*\*(.+?)\*\*:?\s*$/.exec(line.trim());
    if (h) {
      push();
      cur = { title: h[1].replace(/\*\*/g, "").trim(), body: [] };
    } else cur.body.push(line);
  }
  push();
  return out;
}

/** The newest scan in `events` and Home's page after it; null when the chat holds no scan. */
export function briefOf(events: readonly Ev[], isScan: (t: string) => boolean, busy: boolean): Brief | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "user_message" || !isScan(e.text ?? "")) continue;
    let page = "";
    let later = false;
    for (let k = i + 1; k < events.length; k++) {
      const a = events[k];
      if (a.event === "user_message") {
        later = true;
        break;
      }
      if (a.event === "assistant_message") for (const b of a.blocks ?? []) if (b.type === "text" && b.text?.trim()) page += (page ? "\n\n" : "") + b.text.trim();
    }
    return { at: e.at ?? null, asked: e.text ?? "", sections: sectionsOf(page), writing: busy && !later };
  }
  return null;
}

/** A section's markdown as plain words to speak: list marks, emphasis, links and code fences gone. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.(\s*\.)+/g, ".")
    .trim();
}

/** The brief as a note: its date heading, then each section under its own heading. */
export function briefNote(b: Brief, when: string): string {
  return [`# Morning brief${when ? ` — ${when}` : ""}`, "", ...b.sections.flatMap((s) => [`## ${s.title}`, "", s.body, ""])].join("\n");
}
