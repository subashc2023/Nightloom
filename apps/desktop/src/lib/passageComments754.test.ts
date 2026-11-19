/**
 * Item 754: comments on passages, collected as chips in the composer and
 * sent as one message. The message's shape, the drafts store keeping them
 * (switch, reload, quit), Send clearing them, other sends keeping them,
 * and the pill and composer wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import transcriptSrcRaw from "./Transcript.svelte?raw";
import classicSrcRaw from "./TranscriptClassic.svelte?raw";
import composerSrc from "./Composer.svelte?raw";
import approvalSrc from "./ApprovalPrompt.svelte?raw";
import { chipLabel, commentLabel, commentsMessage, commentWhere, readComments, type PassageComment } from "./passageComments";
import {
  addComment,
  carryDraft,
  clearDraft,
  draftComments,
  drafts,
  hasBoxDraft,
  hasDraft,
  loadDrafts,
  moveDraft,
  readDraft,
  removeComment,
  serializeDrafts,
  setCommentNote,
  setDraftText,
} from "./drafts.svelte";
import { splitQuotes } from "./replyQuote.svelte";
import { requestCommentFocus, takeCommentFocus } from "./commentRequest.svelte";

const c = (over: Partial<PassageComment>): PassageComment => ({
  id: 1,
  quote: "the passage",
  source: "reply",
  ordinal: 3,
  note: "",
  ...over,
});

afterEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
});

describe("the message Send sends", () => {
  it("is the typed text unchanged with no comments", () => {
    expect(commentsMessage([], "hello")).toBe("hello");
    expect(commentsMessage(undefined, "  hi ")).toBe("  hi ");
  });

  it("quotes each passage with his comment under it, in order, then the box", () => {
    const m = commentsMessage(
      [c({ id: 1, quote: "first line\nsecond line", note: "why two?" }), c({ id: 2, quote: "B", note: "" })],
      "and overall: fine",
    );
    expect(m).toBe("> first line\n> second line\n\nwhy two?\n\n> B\n\nand overall: fine");
    // The bubble draws each quote as a quote and his words as text.
    expect(splitQuotes(m).map((s) => s.kind)).toEqual(["quote", "text", "quote", "text"]);
  });

  it("goes with an empty box", () => {
    expect(commentsMessage([c({ note: "no" })], "   ")).toBe("> the passage\n\nno");
  });

  it("fences a diff passage so +/- lines are not read as a list", () => {
    expect(commentsMessage([c({ source: "diff", quote: "-a\n+b" })], "")).toBe("> ```diff\n> -a\n> +b\n> ```");
  });
});

describe("the chip's words", () => {
  it("cuts a long passage to one line", () => {
    expect(commentLabel("a\n b   c")).toBe("a b c");
    expect(commentLabel("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`);
  });
  it("skips a diff's path header", () => {
    expect(chipLabel({ source: "diff", quote: "--- a.py\n+++ a.py\n-x\n+y" })).toBe("-x +y");
  });
  it("says where the passage is from", () => {
    expect(commentWhere(c({}))).toBe("its 3rd reply");
    expect(commentWhere(c({ source: "message", ordinal: 1 }))).toBe("your 1st message");
    expect(commentWhere(c({ source: "plan", ordinal: 0 }))).toBe("the plan");
  });
});

describe("the drafts store keeps comments", () => {
  it("adds, writes notes, and counts as a draft", () => {
    const id = addComment("chat-a", "passage", "reply", 2);
    setCommentNote("chat-a", id, "my words");
    expect(draftComments("chat-a")).toEqual([{ id, quote: "passage", source: "reply", ordinal: 2, note: "my words" }]);
    expect(hasDraft("chat-a")).toBe(true);
    expect(hasBoxDraft("chat-a")).toBe(true);
  });

  it("survives a reload: serialized and read back", () => {
    const id = addComment("chat-b", "passage", "plan", 0);
    setCommentNote("chat-b", id, "change step 2");
    const back = loadDrafts({ getItem: () => serializeDrafts(drafts) });
    expect(back["chat-b"]?.comments).toEqual([{ id, quote: "passage", source: "plan", ordinal: 0, note: "change step 2" }]);
  });

  it("reads back malformed comments as nothing, not a broken draft", () => {
    expect(readComments([{ quote: "" }, null, 5, { quote: "ok", source: "bogus" }])).toEqual([
      { id: 0, quote: "ok", source: "reply", ordinal: 0, note: "" },
    ]);
  });

  it("is cleared by a send that carried them, kept by any other", () => {
    addComment("chat-c", "p", "reply", 1);
    setDraftText("chat-c", "asked aside");
    clearDraft("chat-c"); // Ask aside / Send later: not carried
    expect(draftComments("chat-c")).toHaveLength(1);
    expect(readDraft("chat-c").text).toBe("");
    clearDraft("chat-c", true); // Send / Queue / council
    expect(draftComments("chat-c")).toHaveLength(0);
    expect(drafts["chat-c"]).toBeUndefined();
  });

  it("drops one only by removeComment, leaving the rest", () => {
    const a = addComment("chat-d", "a", "reply", 1);
    const b = addComment("chat-d", "b", "reply", 1);
    removeComment("chat-d", a);
    expect(draftComments("chat-d").map((x) => x.id)).toEqual([b]);
    removeComment("chat-d", b);
    expect(drafts["chat-d"]).toBeUndefined();
  });

  it("moves with the draft when a pending chat gets its id, and into a fork", () => {
    addComment("new:p:normal", "p", "reply", 1);
    moveDraft("new:p:normal", "chat-e");
    expect(draftComments("chat-e")).toHaveLength(1);
    carryDraft("chat-e", "chat-f");
    expect(draftComments("chat-f")).toHaveLength(1);
    expect(draftComments("chat-e")).toHaveLength(0);
  });
});

describe("the focus request", () => {
  it("is taken once, by the box it names", () => {
    requestCommentFocus("k1", 7);
    expect(takeCommentFocus("k2")).toBe(0);
    expect(takeCommentFocus("k1")).toBe(7);
    expect(takeCommentFocus("k1")).toBe(0);
  });
});

describe("wiring", () => {
  const SRC: Record<string, string> = {
    "Transcript.svelte": transcriptSrc,
    "TranscriptClassic.svelte": classicSrc,
    "Composer.svelte": composerSrc,
    "ApprovalPrompt.svelte": approvalSrc,
  };
  const read = (f: string) => SRC[f]!;
  it("both transcripts' pills offer Comment", () => {
    for (const f of ["Transcript.svelte", "TranscriptClassic.svelte"]) {
      const s = read(f);
      expect(s).toContain("onclick={commentOnSelection}");
      expect(s).toMatch(/addComment\(k, pill\.quote\.text, pill\.source, ordinal\)/);
    }
  });
  it("the plan card's text is a passage", () => {
    expect(read("ApprovalPrompt.svelte")).toContain('class="planv" data-plan-text');
  });
  it("the composer sends comments with Send, Queue and the council, and confirms a discard", () => {
    const s = read("Composer.svelte");
    expect(s.match(/clearDraft\(key, true\)/g)?.length).toBe(3);
    expect(s).toContain("const typed = commentsMessage(comments, text);");
    expect(s).toContain('title: "Discard this comment?"');
  });
});


import { diffQuote } from "./diffPassage";
import transcriptLogicRaw from "./transcript/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
const transcriptSrc = asOneFile(transcriptSrcRaw, transcriptLogicRaw);
const classicSrc = asOneFile(classicSrcRaw, transcriptLogicRaw);
describe("a diff passage", () => {
  it("is unified-diff lines under the file's path", () => {
    expect(
      diffQuote("src/a.ts", [
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
        { kind: "ctx", text: "same" },
      ]),
    ).toBe("--- src/a.ts\n+++ src/a.ts\n-old\n+new\n same");
  });
  it("offers Comment alone: Ask aside and Reply refuse a diff pill", () => {
    for (const f of ["Transcript.svelte", "TranscriptClassic.svelte"]) {
      const s = f === "Transcript.svelte" ? transcriptSrc : classicSrc;
      expect(s).toContain('if (!pill || !canAsk || pill.source === "diff") return;');
      expect(s).toContain('if (!pill || pill.source === "diff") return;');
      expect(s).toContain('{:else if asidePill}');
    }
  });
});
