import { beforeEach, describe, expect, it } from "vitest";
import {
  draftKey,
  drafts,
  enqueueMessage,
  forgetMove,
  moveDraft,
  moveQueue,
  newDraftKey,
  queueAfterTurn,
  ranKey,
  readDraft,
  setDraftText,
} from "./drafts.svelte";

// Nightshift backlog 375 (his report 2026-10-18): a message queued in an
// AI Safety Collective chat while its turn ran was sent into the ICS 51
// chat he had switched to when that turn ended. A queued message is bound
// to the chat it was queued in: a turn's end drains only that chat's
// queue, and only while that chat is the one open.
beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
});

describe("a queued message goes only to its own chat (375)", () => {
  it("switching chat and project before the turn ends leaves the message in its chat", () => {
    // In AISCI (project p-aisci), a turn runs; he queues a message.
    const from = draftKey("chat-aisci", "p-aisci");
    enqueueMessage(from, "the queued message", []);
    // He opens a chat in ICS 51 (another project); then the AISCI turn ends.
    const live = draftKey("chat-ics51", "p-ics51");
    expect(queueAfterTurn(from, live)).toBeNull();
    expect(readDraft(live).queue).toEqual([]);
    expect(readDraft(from).queue.map((r) => r.text)).toEqual(["the queued message"]);
    // And the ICS 51 New chat page is not AISCI's either.
    expect(queueAfterTurn(from, newDraftKey("p-ics51"))).toBeNull();
  });

  it("the same chat still open drains its own queue, as before", () => {
    const k = draftKey("chat-aisci", "p-aisci");
    expect(queueAfterTurn(k, k)).toBe(k);
  });

  it("a New chat's first turn drains the chat it made, on screen at its end", () => {
    const pending = newDraftKey("p-aisci");
    forgetMove(pending);
    enqueueMessage(pending, "typed during the first turn", []);
    // The turn's end on screen: the draft follows the chat it made.
    moveDraft(pending, "chat-new");
    expect(ranKey(pending)).toBe("chat-new");
    expect(queueAfterTurn(pending, "chat-new")).toBe("chat-new");
    expect(queueAfterTurn(pending, "chat-ics51")).toBeNull();
  });

  it("a New chat's first turn that went off screen takes its queue, not the next New chat", () => {
    const pending = newDraftKey("p-aisci");
    forgetMove(pending);
    enqueueMessage(pending, "for the chat being made", []);
    setDraftText(pending, "a new draft he started");
    moveQueue(pending, "chat-made");
    expect(readDraft("chat-made").queue.map((r) => r.text)).toEqual(["for the chat being made"]);
    // The next New chat of the project has no queue to send as its own,
    // and the words in its box stay where they are.
    expect(readDraft(pending).queue).toEqual([]);
    expect(readDraft(pending).text).toBe("a new draft he started");
  });

  it("an old move from the pending key routes nothing once a new turn leaves from it", () => {
    const pending = newDraftKey("p-aisci");
    moveDraft(pending, "chat-old");
    forgetMove(pending);
    expect(queueAfterTurn(pending, "chat-old")).toBeNull();
  });
});
