/** The phone's feedback draft and its reply sentence (item 805), pure for tests. */
import type { FeedbackSent } from "./client";

export const FEEDBACK_PHONE_KEY = "nightloom.remote.feedback.draft";

export function loadPhoneFeedback(store: Pick<Storage, "getItem"> = localStorage): string {
  try {
    return store.getItem(FEEDBACK_PHONE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Keep it (an empty one is removed). */
export function savePhoneFeedback(text: string, store: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (text) store.setItem(FEEDBACK_PHONE_KEY, text);
    else store.removeItem(FEEDBACK_PHONE_KEY);
  } catch {
    // best-effort
  }
}

export function sentSentence(sent: FeedbackSent): string {
  const also = sent.also_filed.length
    ? ` Earlier feedback went in too (item ${sent.also_filed.map((f) => f.item).join(", ")}).`
    : "";
  if (sent.filed) return `Feedback sent — item ${sent.filed.item} in ${sent.filed.project}.${also}`;
  return `Feedback saved, not filed yet — ${sent.pending_why ?? "it will be filed shortly"}.${also}`;
}
