/** Plain helpers for the feedback box (item 805), kept pure for tests. */

export interface FeedbackDraft {
  text: string;
  /** A Nightshift project's id; "" is Nightloom. */
  about: string;
}

/** Where it was sent from, in plain words, as the item records it. */
export function feedbackSurface(at: { home: boolean; asideOpen: boolean; theme: "Jarvis" | "Classic" }): string {
  const where = at.home ? "Home on the Mac" : "the Mac";
  const aside = at.asideOpen ? ", an aside open beside the chat" : "";
  return `${where} (${at.theme} theme${aside})`;
}
