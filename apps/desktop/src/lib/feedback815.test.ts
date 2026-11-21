import { beforeEach, describe, expect, it, vi } from "vitest";

/** Item 815: images in the feedback box — kept with the draft, sent, and
 *  only what was sent cleared. The backend is stubbed. */
const m = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
} as Storage;

const { api } = vi.hoisted(() => {
  let n = 0;
  const disk = new Map<string, string>();
  return {
    api: {
      disk,
      stashDraftFile: vi.fn(async (data: string) => {
        const id = `d${++n}`;
        disk.set(id, data);
        return id;
      }),
      readDraftFile: vi.fn(async (id: string) => {
        const d = disk.get(id);
        if (d === undefined) throw new Error("gone");
        return d;
      }),
      feedbackSend: vi.fn(async (_note: unknown) => ({
        filed: { project: "nightshift-code", item: "900", file: "backlog/900-x.md" },
        pending_why: null,
        saved: null,
        also_filed: [],
      })),
      feedbackPageShot: vi.fn(async () => "UE5HU0hPVA=="),
    },
  };
});
vi.mock("./api", () => api);
vi.mock("./state.svelte", () => ({ app: { sessions: [], activeSessionId: null, project: null, asidePanel: null }, addToast: vi.fn() }));
vi.mock("./layout.svelte", () => ({ classic: () => false }));

import {
  feedback,
  addFeedbackImage,
  removeFeedbackImage,
  sendFeedback,
  discardFeedback,
  restoreFeedbackImages,
  hasFeedback,
  FEEDBACK_DRAFT_KEY,
} from "./feedback.svelte";
import { feedbackFileIdsIn, imageRefusal, parseDraft, MAX_FEEDBACK_IMAGES } from "./feedbackText";

beforeEach(() => {
  discardFeedback();
  api.feedbackSend.mockClear();
});

describe("feedback images (item 815)", () => {
  it("a draft keeps its images by their draft-file ids, and reads older drafts as words", () => {
    const raw = JSON.stringify({ text: "x", images: [{ stash: "ab", media_type: "image/png", kind: "page" }, { bad: 1 }] });
    expect(parseDraft(raw)).toEqual({ text: "x", images: [{ stash: "ab", media_type: "image/png", kind: "page" }] });
    expect(feedbackFileIdsIn(raw)).toEqual(["ab"]);
    expect(parseDraft(JSON.stringify({ text: "y" }))).toEqual({ text: "y" });
  });

  it("refuses what the service would: type, size, count", () => {
    expect(imageRefusal("image/png", 10, 0)).toBeNull();
    expect(imageRefusal("image/tiff", 10, 0)).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(imageRefusal("image/png", 11 * 1024 * 1024, 0)).toMatch(/10 MB/);
    expect(imageRefusal("image/png", 10, MAX_FEEDBACK_IMAGES)).toMatch(/at most/);
  });

  it("a pasted image is on disk and in the kept draft at once, and comes back after a reload", async () => {
    expect(await addFeedbackImage("AAAA", "image/png", "paste")).toBe(true);
    expect(hasFeedback()).toBe(true);
    const kept = parseDraft(m.get(FEEDBACK_DRAFT_KEY) ?? null);
    expect(kept.images?.length).toBe(1);
    // A reload: the bytes are gone from memory, the draft names them.
    feedback.imageData = {};
    await restoreFeedbackImages();
    expect(feedback.imageData[kept.images![0].stash]).toBe("AAAA");
  });

  it("an image alone sends; only what went is cleared — an image added while sending stays", async () => {
    await addFeedbackImage("AAAA", "image/png", "paste");
    let release!: () => void;
    api.feedbackSend.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return { filed: { project: "p", item: "901", file: "f" }, pending_why: null, saved: null, also_filed: [] };
    });
    const going = sendFeedback();
    await vi.waitFor(() => expect(api.feedbackSend).toHaveBeenCalled());
    await addFeedbackImage("BBBB", "image/jpeg", "paste");
    release();
    expect(await going).toBe(true);
    const note = api.feedbackSend.mock.calls[0][0] as { attach: { data: string; kind: string }[] };
    expect(note.attach).toEqual([{ data: "AAAA", kind: "paste" }]);
    expect(feedback.draft.images?.map((i) => feedback.imageData[i.stash])).toEqual(["BBBB"]);
  });

  it("× removes one image; Discard clears words and images", async () => {
    await addFeedbackImage("AAAA", "image/png", "paste");
    await addFeedbackImage("CCCC", "image/png", "page");
    removeFeedbackImage(feedback.draft.images![0].stash);
    expect(feedback.draft.images?.map((i) => i.kind)).toEqual(["page"]);
    discardFeedback();
    expect(hasFeedback()).toBe(false);
    expect(m.has(FEEDBACK_DRAFT_KEY)).toBe(false);
  });

  it("an image whose copy is gone is dropped with a word, the rest stays", async () => {
    m.set(FEEDBACK_DRAFT_KEY, JSON.stringify({ text: "w", images: [{ stash: "gone", media_type: "image/png", kind: "paste" }] }));
    feedback.draft = parseDraft(m.get(FEEDBACK_DRAFT_KEY)!);
    feedback.imageData = {};
    await restoreFeedbackImages();
    expect(feedback.draft.images ?? []).toEqual([]);
    expect(feedback.draft.text).toBe("w");
    expect(feedback.problem).toMatch(/could not be brought back/);
  });
});
