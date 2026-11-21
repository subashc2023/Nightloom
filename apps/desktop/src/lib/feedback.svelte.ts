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
 *
 * **Images (item 815):** ⌘V of an image in the box, and "Attach a shot of
 * this page" (WebKit's own render of the page, no screen capture), add
 * thumbnails. Each image's bytes go to the composer's draft-file store on
 * disk at once (`stash_draft_file`, item 491) and the draft keeps the ids,
 * so an image survives every way out the words do.
 */
import * as api from "./api";
import { app, addToast } from "./state.svelte";
import { classic } from "./layout.svelte";
import { chatLabel } from "./chatLabel";
import { isHome } from "./home";
import {
  afterSend,
  feedbackSurface,
  imageRefusal,
  MAX_FEEDBACK_IMAGE_BASE64,
  MAX_FEEDBACK_IMAGES,
  parseDraft,
  FEEDBACK_DRAFT_KEY,
  type DraftImage,
  type FeedbackDraft,
} from "./feedbackText";

export { FEEDBACK_DRAFT_KEY };

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
  /** Item 815: each attached image's base64, by its draft id. */
  imageData: {} as Record<string, string>,
  /** The page shot is being taken: the box hides for that moment. */
  capturing: false,
});

/** An image the draft-file store could not take is kept in memory only. */
const inMemory = (stash: string) => stash.startsWith("mem-");
let memN = 0;

/** The images attached now. */
export function feedbackImages(): DraftImage[] {
  return feedback.draft.images ?? [];
}

/** Whether there is anything to send: words, or an image (item 815). */
export function hasFeedback(): boolean {
  return !!feedback.draft.text.trim() || feedbackImages().length > 0;
}

/** Keep the draft (every keystroke, every image). */
export function keepDraft(): void {
  try {
    const images = feedbackImages().filter((i) => !inMemory(i.stash));
    if (!feedback.draft.text && !images.length) localStorage.removeItem(FEEDBACK_DRAFT_KEY);
    else
      localStorage.setItem(
        FEEDBACK_DRAFT_KEY,
        JSON.stringify(images.length ? { text: feedback.draft.text, images } : { text: feedback.draft.text }),
      );
  } catch {
    // best-effort; the state still holds it this session
  }
}

export function openFeedback(): void {
  feedback.open = true;
  feedback.problem = null;
  void restoreFeedbackImages();
}

/** After a reload or relaunch: the kept images' bytes back from disk. One
 *  that is gone is dropped, and the box says so; words and the rest stay. */
let restoring: Promise<void> | null = null;
export function restoreFeedbackImages(): Promise<void> {
  const missing = feedbackImages().filter((i) => feedback.imageData[i.stash] === undefined);
  if (!missing.length) return restoring ?? Promise.resolve();
  restoring = Promise.all(
    missing.map(async (i) => {
      try {
        if (inMemory(i.stash)) throw new Error("not kept");
        feedback.imageData[i.stash] = await api.readDraftFile(i.stash);
      } catch {
        feedback.draft.images = feedbackImages().filter((x) => x.stash !== i.stash);
        feedback.problem = "An attached image could not be brought back — attach it again.";
        keepDraft();
      }
    }),
  ).then(() => {
    restoring = null;
  });
  return restoring;
}

/** Attach an image (base64, no `data:` prefix). False, with the reason in
 *  the box, when it cannot be. */
export async function addFeedbackImage(data: string, mediaType: string, kind: DraftImage["kind"]): Promise<boolean> {
  const why = imageRefusal(mediaType, data.length, feedbackImages().length);
  if (why) {
    feedback.problem = why;
    return false;
  }
  let stash: string;
  try {
    stash = await api.stashDraftFile(data);
  } catch {
    stash = `mem-${++memN}`;
  }
  if (feedbackImages().length >= MAX_FEEDBACK_IMAGES) {
    feedback.problem = `A note takes at most ${MAX_FEEDBACK_IMAGES} images.`;
    return false;
  }
  feedback.imageData[stash] = data;
  feedback.draft.images = [...feedbackImages(), { stash, media_type: mediaType, kind }];
  feedback.last = null;
  feedback.problem = null;
  keepDraft();
  return true;
}

/** Take one image off the note (its × ). */
export function removeFeedbackImage(stash: string): void {
  feedback.draft.images = feedbackImages().filter((i) => i.stash !== stash);
  delete feedback.imageData[stash];
  keepDraft();
}

/** The image files of a paste, as base64 with their types (⌘V in the box). */
export async function pastedImages(files: File[]): Promise<{ data: string; type: string }[]> {
  const out: { data: string; type: string }[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    out.push({ data: await fileBase64(f), type: f.type });
  }
  return out;
}

function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

/** One painted frame — or 60 ms, whichever is first: a window WebKit
 *  treats as hidden paints no frames, and the box must not stay hidden. */
const frame = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 60);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });

/** A PNG over the cap, re-drawn as a JPEG (a large window's shot can be). */
async function underCap(data: string): Promise<{ data: string; type: string }> {
  if (data.length <= MAX_FEEDBACK_IMAGE_BASE64) return { data, type: "image/png" };
  const img = new Image();
  img.src = `data:image/png;base64,${data}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")?.drawImage(img, 0, 0);
  const url = c.toDataURL("image/jpeg", 0.85);
  return { data: url.slice(url.indexOf(",") + 1), type: "image/jpeg" };
}

/** "Attach a shot of this page": the box hides for two frames, WebKit
 *  draws the page as it stands (`feedback_page_shot`), the box comes back
 *  with the shot as a thumbnail. Never a screen capture, so never a
 *  permission dialog. */
export async function attachPageShot(): Promise<void> {
  if (feedback.capturing) return;
  feedback.capturing = true;
  feedback.problem = null;
  try {
    await frame();
    await frame();
    const png = await api.feedbackPageShot();
    feedback.capturing = false;
    const shot = await underCap(png);
    await addFeedbackImage(shot.data, shot.type, "page");
  } catch (e) {
    feedback.problem = `The page shot was not taken — ${String(e)}.`;
  } finally {
    feedback.capturing = false;
  }
}

/** Close the box; the draft stays. */
export function closeFeedback(): void {
  feedback.open = false;
  feedback.confirmDiscard = false;
}

/** Discard, after the box's confirm: the draft goes. */
export function discardFeedback(): void {
  feedback.draft = { text: "" };
  feedback.imageData = {};
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
  if (feedback.sending || !hasFeedback()) return false;
  feedback.sending = true;
  feedback.problem = null;
  try {
    await restoreFeedbackImages();
    const images = feedbackImages().filter((i) => feedback.imageData[i.stash] !== undefined);
    if (!feedback.draft.text.trim() && !images.length) return false;
    const note = feedbackContext();
    if (images.length) note.attach = images.map((i) => ({ data: feedback.imageData[i.stash], kind: i.kind }));
    const sent = await api.feedbackSend(note);
    const line = sentLine(sent);
    feedback.last = line;
    // Only what was sent goes (review of 805): words typed and images
    // attached while it was sending stay in the box.
    const went = new Set(images.map((i) => i.stash));
    const left = feedbackImages().filter((i) => !went.has(i.stash));
    for (const id of went) delete feedback.imageData[id];
    const text = afterSend(feedback.draft.text, note.text);
    feedback.draft = left.length ? { text, images: left } : { text };
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
