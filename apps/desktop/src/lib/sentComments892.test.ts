// Item 892: a message sent with passage comments comes back as his text
// plus its comment chips — on a rewind, a held row taken back, a failed send.
import { beforeEach, describe, expect, it } from "vitest";
import { commentsMessage, type PassageComment } from "./passageComments";
import { SENT_KEY, SENT_MAX, findSent, readSent, sendWithComments, sentComments, withSent } from "./sentComments";
import { clearDraft, draftComments, drafts, enqueueMessage, readDraft, restoreComments, takeBackQueued, withdrawComments } from "./drafts.svelte";
import { rewoundMessage } from "./rewindDraft.svelte";
import composerRaw from "./Composer.svelte?raw";
import rewindRaw from "./state/rewind.svelte.ts?raw";
import type { SessionEvent } from "./types";

function mem(): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const two: PassageComment[] = [
  { id: 4, quote: "the first passage\nover two lines", source: "reply", ordinal: 2, note: "why this?" },
  { id: 5, quote: "another bit", source: "message", ordinal: 1, note: "" },
];

beforeEach(() => {
  localStorage.removeItem(SENT_KEY);
  for (const k of Object.keys(drafts)) delete drafts[k];
});

describe("sentComments (item 892)", () => {
  it("a message with 2 comments comes back as his text and the 2 comments", () => {
    const s = mem();
    const text = sendWithComments(two, "and my own words", s);
    expect(text).toBe(commentsMessage(two, "and my own words"));
    const back = sentComments(text.trim(), s);
    expect(back?.typed).toBe("and my own words");
    expect(back?.comments.map((c) => [c.quote, c.note, c.source, c.ordinal])).toEqual([
      ["the first passage\nover two lines", "why this?", "reply", 2],
      ["another bit", "", "message", 1],
    ]);
  });

  it("a send with no comments records nothing, and a typed quote is never read as one", () => {
    const s = mem();
    expect(sendWithComments([], "> a quote he typed\n\nhis words", s)).toBe("> a quote he typed\n\nhis words");
    expect(s.data[SENT_KEY]).toBeUndefined();
    expect(sentComments("> a quote he typed\n\nhis words", s)).toBeNull();
  });

  it("a text edited since does not match; a stale record is checked against the message", () => {
    const s = mem();
    const text = sendWithComments(two, "mine", s);
    expect(sentComments(text + " more", s)).toBeNull();
    expect(findSent([{ text, typed: "other", comments: two }], text)).toBeNull();
  });

  it("keeps at most SENT_MAX records, newest first, one per text; malformed ones cost only themselves", () => {
    let list = readSent(null);
    for (let i = 0; i < SENT_MAX + 5; i++) list = withSent(list, { text: `t${i}`, typed: "", comments: two });
    list = withSent(list, { text: "t70", typed: "", comments: two });
    expect(list.length).toBe(SENT_MAX);
    expect(list[0].text).toBe("t70");
    expect(readSent(JSON.stringify([{ text: 1 }, { text: "a", typed: "b", comments: two }])).length).toBe(1);
    expect(readSent("not json")).toEqual([]);
  });

  it("a rewound log message with 2 comments: text without the comment block + 2 chips", () => {
    const text = sendWithComments(two, "rest of it").trim();
    const events = [{ event: "user_message", text } as unknown as SessionEvent];
    const m = rewoundMessage(events, 0, () => 1);
    const back = sentComments(m!.text);
    expect(back?.typed).toBe("rest of it");
    expect(back?.typed).not.toContain(">");
    restoreComments("chat", back!.comments);
    expect(draftComments("chat").map((c) => c.quote)).toEqual(["the first passage\nover two lines", "another bit"]);
    expect(draftComments("chat").map((c) => c.note)).toEqual(["why this?", ""]);
  });

  it("restored chips go before the box's own, with fresh ids; Undo takes back only them", () => {
    restoreComments("k", [{ id: 1, quote: "his", source: "reply", ordinal: 0, note: "kept" }]);
    const ids = restoreComments("k", two);
    expect(draftComments("k").map((c) => c.quote)).toEqual(["the first passage\nover two lines", "another bit", "his"]);
    expect(new Set(draftComments("k").map((c) => c.id)).size).toBe(3);
    withdrawComments("k", ids);
    expect(draftComments("k").map((c) => c.quote)).toEqual(["his"]);
  });

  it("a held message taken back brings its chips back too", () => {
    const text = sendWithComments(two, "queued words");
    enqueueMessage("q", text, []);
    clearDraft("q", true);
    takeBackQueued("q");
    expect(readDraft("q").text).toBe("queued words");
    expect(draftComments("q").length).toBe(2);
  });

  it("every send path records; rewind and a failed send restore", () => {
    expect(composerRaw.match(/sendWithComments\(/g)?.length).toBe(3);
    expect(composerRaw).toContain("if (sc) restoreComments(back, sc.comments);");
    expect(rewindRaw).toContain("withComments(rewoundMessage(app.events, here, nextAttachmentId))");
    expect(rewindRaw).toContain("withdrawComments(key, swap.commentIds ?? [])");
  });
});
