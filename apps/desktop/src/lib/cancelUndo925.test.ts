import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { drafts, enqueueMessage, historyFor, readDraft } from "./drafts.svelte";
import { cancelPending } from "./pendingBubble.svelte";
import { app, runToastAction } from "./state.svelte";
import bubbleSource from "./MidTurnBubble.svelte?raw";
import composerSource from "./Composer.svelte?raw";

/**
 * Item 925 (his words 2026-11-23: "if i click the x before it actually sends
 * it gives me a toast being like 'cancel message, keep it' it shoudln't do
 * that, it should jus delete it"): Cancel on a waiting message goes at once.
 * Nothing is lost (practices §7): its words go to the box's history, and the
 * toast's Undo puts it back where it stood, files and all.
 */

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  takeBackInjected: vi.fn(async () => "cancelled" as const),
}));

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  app.toasts.length = 0;
});

describe("925: Cancel at once, Undo brings it back", () => {
  it("cancels without asking, says so with an Undo, and keeps the words in history", async () => {
    enqueueMessage("k", "first", []);
    const mid = enqueueMessage("k", "the middle one", [{ kind: "file", name: "a.txt", media_type: "text/plain" } as never]);
    enqueueMessage("k", "last", []);
    expect(await cancelPending("k", mid.id)).toBe(true);
    expect(readDraft("k").queue.map((q) => q.text)).toEqual(["first", "last"]);
    expect(historyFor("k").map((h) => h.text)).toContain("the middle one");
    const t = app.toasts.at(-1)!;
    expect(t.text).toMatch(/^Cancelled — not sent/);
    expect(t.action?.label).toBe("Undo");
    runToastAction(t.id);
    const q = readDraft("k").queue;
    expect(q.map((r) => r.text)).toEqual(["first", "the middle one", "last"]);
    expect(q[1].id).toBe(mid.id);
    expect(q[1].attachments.map((a) => a.name)).toEqual(["a.txt"]);
  });

  it("an Undo after the queue emptied puts it back alone", async () => {
    const only = enqueueMessage("k2", "only", []);
    await cancelPending("k2", only.id);
    expect(readDraft("k2").queue).toEqual([]);
    runToastAction(app.toasts.at(-1)!.id);
    expect(readDraft("k2").queue.map((r) => r.text)).toEqual(["only"]);
  });

  it("no confirm is drawn in either theme, and the tray's × is the same Cancel", () => {
    expect(bubbleSource).not.toContain(">Keep it<");
    expect(bubbleSource).not.toContain("confirming");
    expect(bubbleSource.match(/onclick=\{\(\) => void run\(\(\) => cancelPending\(chatKey, row!\.id\)\)\}/g)?.length).toBe(2);
    const drop = composerSource.slice(composerSource.indexOf("async function dropRow("), composerSource.indexOf("async function dropRow(") + 200);
    expect(drop).toContain("await cancelPending(key, id)");
  });
});
