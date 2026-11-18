/** Plain helpers for the feedback box (item 805), kept pure for tests. */

/** The box's draft: his words. Feedback always goes to Nightloom's own
 *  backlog (item 816), so there is no project to pick; a draft saved by an
 *  older build with an `about` reads as its text alone. */
export interface FeedbackDraft {
  text: string;
}

/** A kept draft, from its localStorage entry; anything unreadable is no draft. */
export function parseDraft(raw: string | null): FeedbackDraft {
  try {
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.text === "string") return { text: v.text };
    }
  } catch {
    // a bad entry reads as no draft
  }
  return { text: "" };
}

/** Where it was sent from, in plain words, as the item records it. */
export function feedbackSurface(at: { home: boolean; asideOpen: boolean; theme: "Jarvis" | "Classic" }): string {
  const where = at.home ? "Home on the Mac" : "the Mac";
  const aside = at.asideOpen ? ", an aside open beside the chat" : "";
  return `${where} (${at.theme} theme${aside})`;
}

/** What stays in the box after `sent` landed: the words typed while it was
 *  sending (review of 805), never the ones that went. */
export function afterSend(now: string, sent: string): string {
  if (now === sent) return "";
  if (now.startsWith(sent)) return now.slice(sent.length).replace(/^\s+/, "");
  return now;
}
