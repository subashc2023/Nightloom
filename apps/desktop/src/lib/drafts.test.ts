import { beforeEach, describe, expect, it } from "vitest";
import {
  NEW_DRAFT_KEY,
  PERSIST_ATTACHMENT_MAX,
  addAttachment,
  clearDraft,
  draftKey,
  drafts,
  flushDrafts,
  hasDraft,
  loadDrafts,
  moveDraft,
  readDraft,
  removeAttachment,
  saveDrafts,
  serializeDrafts,
  setDraftText,
} from "./drafts.svelte";
import type { Attachment } from "./types";

// The draft bug (nightshift backlog 065): a draft belongs to one chat. The
// store here is what the composer binds to; these pin the map's rules —
// per key, the handover from the pending chat, clear on send only, and
// that a storage that throws costs the persistence and not the feature.

function png(id: number, chars = 10): Attachment {
  return { id, kind: "image", media_type: "image/png", name: "pasted image", data: "A".repeat(chars) };
}

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  localStorage.clear();
});

describe("draftKey", () => {
  it("is the chat id, or 'new' while no chat is open", () => {
    expect(draftKey("abc")).toBe("abc");
    expect(draftKey(null)).toBe(NEW_DRAFT_KEY);
  });
});

describe("per-key drafts", () => {
  it("keeps one draft per chat and reads empty for a chat without one", () => {
    setDraftText("a", "hello from a");
    setDraftText("b", "hello from b");
    expect(readDraft("a").text).toBe("hello from a");
    expect(readDraft("b").text).toBe("hello from b");
    expect(readDraft("c").text).toBe("");
    expect(readDraft("c").attachments).toEqual([]);
  });

  it("does not make an entry for an empty write", () => {
    setDraftText("a", "");
    expect(drafts.a).toBeUndefined();
    expect(hasDraft("a")).toBe(false);
  });

  it("hasDraft is non-blank text or a chip", () => {
    setDraftText("a", "   ");
    expect(hasDraft("a")).toBe(false);
    addAttachment("a", png(1));
    expect(hasDraft("a")).toBe(true);
    removeAttachment("a", 1);
    expect(hasDraft("a")).toBe(false);
    setDraftText("a", "x");
    expect(hasDraft("a")).toBe(true);
  });
});

describe("handover from the pending chat", () => {
  it("moves the 'new' entry to the created chat's id", () => {
    setDraftText(NEW_DRAFT_KEY, "typed during the first turn");
    addAttachment(NEW_DRAFT_KEY, png(7));
    moveDraft(NEW_DRAFT_KEY, "s1");
    expect(drafts[NEW_DRAFT_KEY]).toBeUndefined();
    expect(readDraft("s1").text).toBe("typed during the first turn");
    expect(readDraft("s1").attachments.map((a) => a.id)).toEqual([7]);
  });

  it("is a no-op with nothing pending, and keeps what the target already had", () => {
    moveDraft(NEW_DRAFT_KEY, "s1");
    expect(drafts.s1).toBeUndefined();
    setDraftText("s2", "already here");
    setDraftText(NEW_DRAFT_KEY, "and this");
    moveDraft(NEW_DRAFT_KEY, "s2");
    expect(readDraft("s2").text).toBe("already here\nand this");
  });
});

describe("clearing", () => {
  it("clears only the sent chat's entry", () => {
    setDraftText("a", "a's");
    setDraftText("b", "b's");
    clearDraft("a");
    expect(hasDraft("a")).toBe(false);
    expect(readDraft("b").text).toBe("b's");
  });
});

describe("persistence", () => {
  it("round-trips text and small attachments, dropping empty entries", () => {
    const map = { a: { text: "kept", attachments: [png(1)] }, b: { text: "", attachments: [] } };
    saveDrafts(map, localStorage);
    const back = loadDrafts(localStorage);
    expect(Object.keys(back)).toEqual(["a"]);
    expect(back.a.text).toBe("kept");
    expect(back.a.attachments[0]?.data).toBe("AAAAAAAAAA");
  });

  it("keeps a large attachment out of storage but the text in", () => {
    const big = png(2, PERSIST_ATTACHMENT_MAX + 1);
    const json = serializeDrafts({ a: { text: "the words", attachments: [png(1), big] } });
    const parsed = JSON.parse(json) as Record<string, { text: string; attachments: Attachment[] }>;
    expect(parsed.a.text).toBe("the words");
    expect(parsed.a.attachments.map((a) => a.id)).toEqual([1]);
  });

  it("ignores a malformed store and malformed entries", () => {
    localStorage.setItem("nightloom.drafts", "{not json");
    expect(loadDrafts(localStorage)).toEqual({});
    localStorage.setItem(
      "nightloom.drafts",
      JSON.stringify({ a: { text: 5, attachments: [{ id: "x" }] }, b: { text: "ok", attachments: "no" } }),
    );
    expect(loadDrafts(localStorage)).toEqual({ b: { text: "ok", attachments: [] } });
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("quota");
      },
    };
    expect(loadDrafts(broken)).toEqual({});
    expect(() => saveDrafts({ a: { text: "x", attachments: [] } }, broken)).not.toThrow();
  });

  it("falls back to the text alone when the full store will not fit", () => {
    let calls = 0;
    const tight = {
      setItem(_k: string, v: string): void {
        calls++;
        if (v.includes('"data"')) throw new Error("quota");
        localStorage.setItem(_k, v);
      },
    };
    saveDrafts({ a: { text: "words", attachments: [png(1)] } }, tight);
    expect(calls).toBe(2);
    expect(loadDrafts(localStorage)).toEqual({ a: { text: "words", attachments: [] } });
  });

  it("flushDrafts writes the live map", () => {
    setDraftText("a", "flushed");
    flushDrafts();
    expect(loadDrafts(localStorage).a?.text).toBe("flushed");
  });
});
