/**
 * The feedback box (nightshift item 805): his words to the agent that
 * builds Nightloom, filed as a backlog item with the open chat, the
 * project, the build and the time attached. Opened from the sidebar's foot,
 * the menu bar (Nightloom ▸ Send Feedback…) and the command palette.
 *
 * **The draft is never lost** (practices §7): every keystroke is kept in
 * localStorage, so closing the box, switching chats, leaving the project
 * and a reload all bring it back. Only a send that landed, or Discard (which
 * asks first), clears it.
 */
import * as api from "./api";
import { app, addToast } from "./state.svelte";
import { classic } from "./layout.svelte";
import { chatLabel } from "./chatLabel";
import { isHome } from "./home";
import { afterSend, feedbackSurface, parseDraft, type FeedbackDraft } from "./feedbackText";

export const FEEDBACK_DRAFT_KEY = "nightloom.feedback.draft";

function readDraft(): FeedbackDraft {
  try {
    return parseDraft(localStorage.getItem(FEEDBACK_DRAFT_KEY));
  } catch {
    // no localStorage: no draft
    return { text: "" };
  }
}

export const feedback = $state({
  open: false,
  draft: readDraft(),
  sending: false,
  /** The last send's sentence, shown in the box until he types again. */
  last: null as string | null,
  /** Why the last send failed; the draft stays. */
  problem: null as string | null,
  confirmDiscard: false,
});

/** Keep the draft (every keystroke). */
export function keepDraft(): void {
  try {
    if (!feedback.draft.text) localStorage.removeItem(FEEDBACK_DRAFT_KEY);
    else localStorage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify(feedback.draft));
  } catch {
    // best-effort; the state still holds it this session
  }
}

export function openFeedback(): void {
  feedback.open = true;
  feedback.problem = null;
}

/** Close the box; the draft stays. */
export function closeFeedback(): void {
  feedback.open = false;
  feedback.confirmDiscard = false;
}

/** Discard, after the box's confirm: the draft goes. */
export function discardFeedback(): void {
  feedback.draft = { text: "" };
  keepDraft();
  feedback.confirmDiscard = false;
  feedback.last = null;
}

/** What the box will attach, from what is on screen now. */
export function feedbackContext(): api.FeedbackNote {
  const open = app.sessions.find((s) => s.id === app.activeSessionId) ?? null;
  return {
    text: feedback.draft.text,
    surface: feedbackSurface({
      home: isHome(app.project),
      asideOpen: !!app.asidePanel,
      theme: classic() ? "Classic" : "Jarvis",
    }),
    chat: open?.id ?? null,
    chat_title: open ? chatLabel(open, "") || null : null,
    project: app.project?.name ?? null,
  };
}

export async function sendFeedback(): Promise<boolean> {
  if (feedback.sending || !feedback.draft.text.trim()) return false;
  feedback.sending = true;
  feedback.problem = null;
  try {
    const note = feedbackContext();
    const sent = await api.feedbackSend(note);
    const line = sentLine(sent);
    feedback.last = line;
    // Only what was sent goes (review of 805): words typed while it was
    // sending stay in the box.
    feedback.draft = { text: afterSend(feedback.draft.text, note.text) };
    keepDraft();
    addToast(line);
    return true;
  } catch (e) {
    feedback.problem = `Not sent — ${String(e)}. Your words are kept here.`;
    return false;
  } finally {
    feedback.sending = false;
  }
}

/** One plain sentence for what happened. */
export function sentLine(sent: api.FeedbackSent): string {
  const also = sent.also_filed.length
    ? ` Earlier feedback went in too (item ${sent.also_filed.map((f) => f.item).join(", ")}).`
    : "";
  if (sent.filed) return `Feedback sent — item ${sent.filed.item} in ${sent.filed.project}.${also}`;
  return `Feedback saved, not filed yet — ${sent.pending_why ?? "it will be filed shortly"}. It goes in when Nightloom next can.${also}`;
}

/** At launch: file what was saved while a shift was live. Quiet unless something went in. */
export async function flushFeedback(): Promise<void> {
  try {
    const filed = await api.feedbackFlush();
    if (filed.length) addToast(`Waiting feedback filed: item ${filed.map((f) => f.item).join(", ")}`);
  } catch {
    // an older backend, or no config dir
  }
}
