/** Plain helpers for the feedback box (item 805), kept pure for tests. */

/** The box's draft: his words and the images he attached (item 815).
 *  Feedback always goes to Nightloom's own backlog (item 816), so there is
 *  no project to pick; a draft saved by an older build with an `about`
 *  reads as its text alone. */
export interface FeedbackDraft {
  text: string;
  images?: DraftImage[];
}

/** One attached image as the draft keeps it (item 815): its bytes are on
 *  disk in the composer's draft-file store (`stash_draft_file`, item 491),
 *  so a quit or reload brings it back; `stash` is that copy's id. */
export interface DraftImage {
  stash: string;
  media_type: string;
  /** `paste` (⌘V, the phone's photo button) or `page` (the page shot). */
  kind: "paste" | "page";
}

export const FEEDBACK_DRAFT_KEY = "nightloom.feedback.draft";

/** The image types a note takes (the service judges the bytes again). */
export const FEEDBACK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** At most this many images on one note (the service's `MAX_IMAGES`). */
export const MAX_FEEDBACK_IMAGES = 8;
/** One image's cap in base64 characters (the service's 10 MB, the composer's `MAX_IMAGE_BASE64`). */
export const MAX_FEEDBACK_IMAGE_BASE64 = 10 * 1024 * 1024;

function draftImages(v: unknown): DraftImage[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (i): i is DraftImage =>
        !!i && typeof i.stash === "string" && !!i.stash && typeof i.media_type === "string",
    )
    .map((i) => ({ stash: i.stash, media_type: i.media_type, kind: i.kind === "page" ? "page" : "paste" }));
}

/** A kept draft, from its localStorage entry; anything unreadable is no draft. */
export function parseDraft(raw: string | null): FeedbackDraft {
  try {
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.text === "string") {
        const images = draftImages(v.images);
        return images.length ? { text: v.text, images } : { text: v.text };
      }
    }
  } catch {
    // a bad entry reads as no draft
  }
  return { text: "" };
}

/** The draft-file ids a kept feedback draft names, so the 30-day prune of
 *  `~/.nightloom/draft-files/` keeps them (item 815). */
export function feedbackFileIdsIn(raw: string | null): string[] {
  return (parseDraft(raw).images ?? []).map((i) => i.stash);
}

/** Why an image cannot be attached, or null when it can. */
export function imageRefusal(mediaType: string, base64Length: number, count: number): string | null {
  if (count >= MAX_FEEDBACK_IMAGES) return `A note takes at most ${MAX_FEEDBACK_IMAGES} images.`;
  if (!FEEDBACK_IMAGE_TYPES.has(mediaType)) return "Only PNG, JPEG, WebP or GIF images can be attached.";
  if (base64Length > MAX_FEEDBACK_IMAGE_BASE64) return "That image is over the 10 MB limit.";
  return null;
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
