import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_NEW_DRAFT_KEY,
  PERSIST_ATTACHMENT_MAX,
  addAttachment,
  clearDraft,
  draftKey,
  drafts,
  flushDrafts,
  hasDraft,
  loadDrafts,
  dropQueued,
  enqueueMessage,
  moveDraft,
  newDraftKey,
  readDraft,
  removeAttachment,
  saveDrafts,
  serializeDrafts,
  setDraftText,
  stashEdit,
  takeEdit,
  hasEdit,
  shiftQueue,
  takeBackQueued,
  HISTORY_MIN_CHARS,
  HISTORY_PER_KEY,
  HISTORY_TOTAL_MAX,
  draftHistory,
  flushDraftHistory,
  historyFor,
  loadDraftHistory,
  recordDraft,
  requeueFront,
  restoreDraft,
  retained,
  serializeDraftHistory,
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
  for (const k of Object.keys(draftHistory)) delete draftHistory[k];
  localStorage.clear();
});

// The draft history and the never-dropped queue (nightshift backlog 158):
// an 11k draft was queued during a turn, taken back, then replaced by a
// paste. The ring keeps every long text that leaves a box; a queue moves
// whole; a failed send never drops what it took.
describe("the draft history (backlog 158)", () => {
  const long = (seed: string) => `${seed} ${"x".repeat(HISTORY_MIN_CHARS)}`;

  it("keeps a sent text, a queued text and a replaced text; not a short one, not a keystroke", () => {
    setDraftText("s1", long("sent"));
    clearDraft("s1");
    expect(historyFor("s1").map((s) => s.text)).toEqual([long("sent")]);

    setDraftText("s1", long("queued"));
    enqueueMessage("s1", long("queued"), []);
    clearDraft("s1"); // the same words again: one entry, not two
    expect(historyFor("s1").map((s) => s.text)).toEqual([long("queued"), long("sent")]);

    // Typed, then replaced by a paste that carried nothing (⌘A, ⌘V of a
    // screenshot): the words go to the ring before the box empties.
    setDraftText("s1", long("typed"));
    setDraftText("s1", long("typed") + "!"); // a keystroke: not a snapshot
    setDraftText("s1", "");
    expect(historyFor("s1")[0]!.text).toBe(long("typed") + "!");
    expect(historyFor("s1")).toHaveLength(3);

    setDraftText("s1", "short");
    clearDraft("s1");
    expect(historyFor("s1")).toHaveLength(3);
  });

  it("retained counts the ends that survive a change", () => {
    expect(retained("abcdef", "abcXef")).toBe(5);
    expect(retained("abcdef", "abcde")).toBe(5);
    expect(retained("abcdef", "")).toBe(0);
    expect(retained("abcdef", "zzz")).toBe(0);
    expect(retained("abc", "abc")).toBe(3);
  });

  it("holds ten per key, newest first, and a restore puts one back in front of the box", () => {
    for (let i = 0; i < HISTORY_PER_KEY + 3; i++) recordDraft("k", long(`v${i}`), `2026-09-18T00:00:${String(i).padStart(2, "0")}Z`);
    const ring = historyFor("k");
    expect(ring).toHaveLength(HISTORY_PER_KEY);
    expect(ring[0]!.text).toBe(long(`v${HISTORY_PER_KEY + 2}`));
    setDraftText("k", "typed meanwhile");
    expect(restoreDraft("k", 1)?.text).toBe(long(`v${HISTORY_PER_KEY + 1}`));
    expect(readDraft("k").text).toBe(`${long(`v${HISTORY_PER_KEY + 1}`)}\ntyped meanwhile`);
    expect(historyFor("k")).toHaveLength(HISTORY_PER_KEY); // a restore is not a use
    expect(restoreDraft("k", 99)).toBeNull();
  });

  it("follows moveDraft to the chat the pending draft made", () => {
    const pending = newDraftKey("p1");
    recordDraft(pending, long("early"), "2026-09-18T00:00:01Z");
    recordDraft("chat9", long("late"), "2026-09-18T00:00:02Z");
    setDraftText(pending, "words");
    moveDraft(pending, "chat9");
    expect(historyFor(pending)).toEqual([]);
    expect(historyFor("chat9").map((s) => s.text)).toEqual([long("late"), long("early")]);
  });

  it("persists across a reload and caps the store by dropping the oldest across keys", () => {
    recordDraft("a", long("one"), "2026-09-18T00:00:01Z");
    flushDraftHistory();
    const back = loadDraftHistory();
    expect(back.a?.map((s) => s.text)).toEqual([long("one")]);

    const big = "y".repeat(HISTORY_TOTAL_MAX / 2 + 1);
    const map = {
      a: [{ text: `1${big}`, at: "2026-09-18T00:00:03Z" }],
      b: [{ text: `2${big}`, at: "2026-09-18T00:00:02Z" }],
      c: [{ text: `3${big}`, at: "2026-09-18T00:00:01Z" }],
    };
    const kept = JSON.parse(serializeDraftHistory(map)) as Record<string, { text: string }[]>;
    expect(Object.keys(kept)).toEqual(["a"]);
    expect(loadDraftHistory({ getItem: () => "nonsense{" })).toEqual({});
  });
});

describe("a held message is never dropped by the app (backlog 158)", () => {
  it("moveDraft carries a whole queue, and appends it after one already under the target", () => {
    const pending = newDraftKey("p1");
    enqueueMessage(pending, "first held", []);
    enqueueMessage(pending, "second held", [png(1)]);
    enqueueMessage("chat1", "already here", []);
    moveDraft(pending, "chat1");
    expect(readDraft(pending).queue).toEqual([]);
    expect(readDraft("chat1").queue.map((q) => q.text)).toEqual(["already here", "first held", "second held"]);
    expect(readDraft("chat1").queue[2]!.attachments).toHaveLength(1);
    // And to a chat with no entry at all.
    moveDraft("chat1", "chat2");
    expect(readDraft("chat2").queue.map((q) => q.text)).toEqual(["already here", "first held", "second held"]);
    expect(drafts.chat1).toBeUndefined();
  });

  it("a failed send's words go back to the head of the queue when the box holds others", () => {
    enqueueMessage("c", "held", []);
    const q = shiftQueue("c")!;
    setDraftText("c", "typed while it ran");
    requeueFront("c", q);
    expect(readDraft("c").queue.map((x) => x.text)).toEqual(["held"]);
    expect(readDraft("c").text).toBe("typed while it ran");
    // An empty message is not a row.
    requeueFront("c", { id: 9, text: "", attachments: [] });
    expect(readDraft("c").queue).toHaveLength(1);
  });

  it("queue, take back: the words are in the box; send: the ring still holds them", () => {
    const text = "held ".repeat(HISTORY_MIN_CHARS);
    enqueueMessage("d", text, []);
    takeBackQueued("d");
    expect(readDraft("d").text).toBe(text);
    expect(readDraft("d").queue).toEqual([]);
    clearDraft("d");
    expect(readDraft("d").text).toBe("");
    expect(historyFor("d")[0]!.text).toBe(text);
  });
});

// The pending chat's key is per project and per kind (nightshift backlog
// 094, 2026-09-16): one literal "new" was one slot for the whole app, so a
// draft typed into one project's New chat was in every other project's.
describe("draftKey", () => {
  it("is the chat id, or the pending key while no chat is open", () => {
    expect(draftKey("abc")).toBe("abc");
    expect(draftKey("abc", "p1", "incognito")).toBe("abc");
    expect(draftKey(null)).toBe("new:unfiled:normal");
    expect(draftKey(null, "p1")).toBe("new:p1:normal");
    expect(draftKey(null, "p1", "incognito")).toBe("new:p1:incognito");
    expect(draftKey(null, undefined, "ephemeral")).toBe("new:unfiled:ephemeral");
  });

  it("differs per project and per kind, and never equals the old literal", () => {
    expect(newDraftKey("p1")).not.toBe(newDraftKey("p2"));
    expect(newDraftKey("p1")).not.toBe(newDraftKey(null));
    expect(newDraftKey("p1", "normal")).not.toBe(newDraftKey("p1", "incognito"));
    expect(newDraftKey(null)).not.toBe(LEGACY_NEW_DRAFT_KEY);
  });

  it("a project switch leaves the other project's pending draft where it was", () => {
    setDraftText(newDraftKey("p1"), "for project one");
    expect(readDraft(newDraftKey("p2")).text).toBe("");
    expect(hasDraft(newDraftKey("p2"))).toBe(false);
    setDraftText(newDraftKey("p2"), "for project two");
    expect(readDraft(newDraftKey("p1")).text).toBe("for project one");
    // And an incognito new chat in the same project reads empty.
    expect(readDraft(newDraftKey("p1", "incognito")).text).toBe("");
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
  const pending = newDraftKey("p1", "normal");

  it("moves the project-scoped pending entry to the created chat's id", () => {
    setDraftText(pending, "typed during the first turn");
    addAttachment(pending, png(7));
    // Another project's pending draft is not the one that moves.
    setDraftText(newDraftKey("p2"), "stays");
    moveDraft(pending, "s1");
    expect(drafts[pending]).toBeUndefined();
    expect(readDraft("s1").text).toBe("typed during the first turn");
    expect(readDraft("s1").attachments.map((a) => a.id)).toEqual([7]);
    expect(readDraft(newDraftKey("p2")).text).toBe("stays");
  });

  it("is a no-op with nothing pending, and keeps what the target already had", () => {
    moveDraft(pending, "s1");
    expect(drafts.s1).toBeUndefined();
    setDraftText("s2", "already here");
    setDraftText(pending, "and this");
    moveDraft(pending, "s2");
    expect(readDraft("s2").text).toBe("already here\nand this");
  });
});

// The queue (nightshift backlog 089): a message sent during a turn is held
// in the draft's entry, oldest first, and goes as the next turn when the
// running one ends. Same key as the draft, same store, same handover.
describe("the queue", () => {
  it("holds messages oldest first and hands the oldest out on shift", () => {
    enqueueMessage("a", "first", []);
    enqueueMessage("a", "second", [png(1)]);
    expect(readDraft("a").queue.map((q) => q.text)).toEqual(["first", "second"]);
    expect(hasDraft("a")).toBe(true);
    const q = shiftQueue("a");
    expect(q?.text).toBe("first");
    expect(readDraft("a").queue.map((q) => q.text)).toEqual(["second"]);
    expect(shiftQueue("a")?.attachments.map((x) => x.id)).toEqual([1]);
    expect(shiftQueue("a")).toBeNull();
    expect(drafts.a).toBeUndefined();
  });

  it("a send clears the box and not the queue", () => {
    setDraftText("a", "typed");
    addAttachment("a", png(2));
    enqueueMessage("a", "held", []);
    clearDraft("a");
    expect(readDraft("a").text).toBe("");
    expect(readDraft("a").attachments).toEqual([]);
    expect(readDraft("a").queue.map((q) => q.text)).toEqual(["held"]);
  });

  it("take-back puts the row in front of what is typed, the newest when no id is given", () => {
    setDraftText("a", "typing now");
    enqueueMessage("a", "older", [png(3)]);
    const newer = enqueueMessage("a", "newer", []);
    expect(takeBackQueued("a")?.id).toBe(newer.id);
    expect(readDraft("a").text).toBe("newer\ntyping now");
    expect(readDraft("a").queue.map((q) => q.text)).toEqual(["older"]);
    const older = readDraft("a").queue[0]!;
    takeBackQueued("a", older.id);
    expect(readDraft("a").text).toBe("older\nnewer\ntyping now");
    expect(readDraft("a").attachments.map((x) => x.id)).toEqual([3]);
    expect(readDraft("a").queue).toEqual([]);
    expect(takeBackQueued("a")).toBeNull();
  });

  it("drop removes one row and the entry once nothing is left", () => {
    const q1 = enqueueMessage("a", "one", []);
    const q2 = enqueueMessage("a", "two", []);
    dropQueued("a", q1.id);
    expect(readDraft("a").queue.map((q) => q.text)).toEqual(["two"]);
    dropQueued("a", q2.id);
    expect(drafts.a).toBeUndefined();
    expect(hasDraft("a")).toBe(false);
  });

  it("moves with the pending chat's draft and persists with it", () => {
    const pending = newDraftKey("p1");
    enqueueMessage(pending, "held during the first turn", [png(5)]);
    moveDraft(pending, "s1");
    expect(readDraft("s1").queue.map((q) => q.text)).toEqual(["held during the first turn"]);
    flushDrafts();
    const back = loadDrafts(localStorage);
    expect(back.s1?.queue.map((q) => q.text)).toEqual(["held during the first turn"]);
    expect(back.s1?.queue[0]?.attachments.map((x) => x.id)).toEqual([5]);
  });

  it("keeps a queued message's text when its attachment is too big for the store", () => {
    const big = png(6, PERSIST_ATTACHMENT_MAX + 1);
    const json = serializeDrafts({ a: { text: "", attachments: [], queue: [{ id: 1, text: "words", attachments: [big] }] } });
    const parsed = JSON.parse(json) as Record<string, { queue: { text: string; attachments: Attachment[] }[] }>;
    expect(parsed.a.queue[0]?.text).toBe("words");
    expect(parsed.a.queue[0]?.attachments).toEqual([]);
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
    const map = { a: { text: "kept", attachments: [png(1)], queue: [] }, b: { text: "", attachments: [], queue: [] } };
    saveDrafts(map, localStorage);
    const back = loadDrafts(localStorage);
    expect(Object.keys(back)).toEqual(["a"]);
    expect(back.a.text).toBe("kept");
    expect(back.a.attachments[0]?.data).toBe("AAAAAAAAAA");
  });

  it("keeps a large attachment out of storage but the text in", () => {
    const big = png(2, PERSIST_ATTACHMENT_MAX + 1);
    const json = serializeDrafts({ a: { text: "the words", attachments: [png(1), big], queue: [] } });
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
    expect(loadDrafts(localStorage)).toEqual({ b: { text: "ok", attachments: [], queue: [] } });
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
    expect(() => saveDrafts({ a: { text: "x", attachments: [], queue: [] } }, broken)).not.toThrow();
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
    saveDrafts({ a: { text: "words", attachments: [png(1)], queue: [] } }, tight);
    expect(calls).toBe(2);
    expect(loadDrafts(localStorage)).toEqual({ a: { text: "words", attachments: [], queue: [] } });
  });

  it("reads a pre-094 'new' entry once as the unfiled ordinary pending key", () => {
    localStorage.setItem(
      "nightloom.drafts",
      JSON.stringify({ [LEGACY_NEW_DRAFT_KEY]: { text: "from before", attachments: [png(3)] }, s1: { text: "s1's", attachments: [] } }),
    );
    const back = loadDrafts(localStorage);
    expect(back[LEGACY_NEW_DRAFT_KEY]).toBeUndefined();
    expect(back[newDraftKey(null)]?.text).toBe("from before");
    expect(back[newDraftKey(null)]?.attachments.map((a) => a.id)).toEqual([3]);
    expect(back.s1?.text).toBe("s1's");
    // Written back, the old key is gone and nothing else is.
    saveDrafts(back, localStorage);
    const again = loadDrafts(localStorage);
    expect(Object.keys(again).sort()).toEqual([newDraftKey(null), "s1"].sort());
  });

  it("appends the old entry to a new-shape unfiled entry rather than dropping either", () => {
    localStorage.setItem(
      "nightloom.drafts",
      JSON.stringify({
        [newDraftKey(null)]: { text: "newer", attachments: [] },
        [LEGACY_NEW_DRAFT_KEY]: { text: "older", attachments: [png(4)] },
      }),
    );
    const back = loadDrafts(localStorage);
    expect(back[newDraftKey(null)]?.text).toBe("newer\nolder");
    expect(back[newDraftKey(null)]?.attachments.map((a) => a.id)).toEqual([4]);
  });

  it("flushDrafts writes the live map", () => {
    setDraftText("a", "flushed");
    flushDrafts();
    expect(loadDrafts(localStorage).a?.text).toBe("flushed");
  });
});

describe("the in-place edit's stash (backlog 137)", () => {
  it("keeps one open edit per chat across a switch, an unmount and a turn", () => {
    // What the transcript does on the way out: stash under the chat.
    stashEdit("chat-a", { editing: { index: 3, original: "was", draft: "is now" }, line: "cache line" });
    stashEdit("chat-b", { editing: { index: 1, original: "x", draft: "y" }, line: "" });
    // Back on chat A: its own draft, not B's.
    expect(takeEdit("chat-a")?.editing.draft).toBe("is now");
    expect(takeEdit("chat-a")?.editing.index).toBe(3);
    expect(takeEdit("chat-b")?.editing.draft).toBe("y");
    // Taking does not forget: a second mount on the same chat finds it too.
    expect(hasEdit("chat-a")).toBe(true);
    // A cancel or a save forgets it; the other chat's stays.
    stashEdit("chat-a", null);
    expect(takeEdit("chat-a")).toBeNull();
    expect(hasEdit("chat-b")).toBe(true);
    stashEdit("chat-b", null);
  });

  it("answers null for a chat with no edit open", () => {
    expect(takeEdit("never")).toBeNull();
    expect(hasEdit("never")).toBe(false);
  });
});
