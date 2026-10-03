import { beforeEach, describe, expect, it, vi } from "vitest";
import cardSrc from "./AsideCard.svelte?raw";
import viewSrc from "./AsideView.svelte?raw";
import threadSrc from "./AsideThread.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import composerSrc from "./Composer.svelte?raw";
import {
  ATTACHMENTS_ONLY,
  answerAsideDiscard,
  app,
  askAside,
  asideHasDraft,
  asideWire,
  dismissAside,
  draftAside,
  followUpAside,
  requestDismissAside,
  restoreAsideTurns,
  rewindAside,
  setAsideUnsent,
  stopAside,
  type Aside,
} from "./state.svelte";
import { asideDraftKey, asideFromStored, loadAsides, serializeAsides, storedAsideOf, ASIDES_KEY } from "./asides";
import { addAttachment, drafts, enqueueMessage, historyFor, readDraft, setDraftText } from "./drafts.svelte";
import { ASIDE_HIDDEN, ASIDE_KEPT, composerShows, type ChatOnlyControl } from "./asideControls";
import { foldBlocked } from "./asideFold";
import "./asides.svelte";
import * as api from "./api";
import type { Attachment } from "./types";

/**
 * Nightshift backlog 283 (2026-10-02): an aside's box is the chat's
 * composer and its exchanges the chat's message pieces. The suite runs in
 * node, so the components are pinned through what they call — the send
 * path the aside composer takes (`askAside` / `followUpAside` with the
 * box's chips and the thread's picks), the drafts store its box lives in,
 * the controls list the markup reads — and, for the wiring the markup
 * alone holds, by reading the component source.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({
    answer: "because $x^2$",
    cost_usd: 0,
    cache_read: 10,
    is_error: false,
    notices: [],
    model: "claude-opus-5",
    input_tokens: 1200,
    output_tokens: 34,
  })),
  cancelAside: vi.fn(async () => null),
}));

const quote = (n: number) => ({ text: `passage ${n}`, role: "assistant" as const, ordinal: n });
const anchor = (turn: number) => ({ turn, block: 0, start: 0, end: 9, side: "below" as const });
const img = (id: number, data = "aGVsbG8="): Attachment => ({ id, kind: "image", name: `shot${id}.png`, media_type: "image/png", data });
const doc = (id: number): Attachment => ({ id, kind: "document", name: "notes.txt", media_type: "text/plain", data: "bm90ZXM=" });
const file = (id: number): Attachment => ({ id, kind: "file", name: "deck.key", media_type: "application/octet-stream", data: "AAAA" });

function reset(): void {
  app.activeSessionId = "chat-a";
  app.asides = [];
  app.aside = null;
  app.asideDiscard = null;
  app.connection = {
    provider: "claude-code",
    model: "default",
    thinking: "off",
    tools: false,
    contextLimit: null,
    price: null,
    mcp: [],
    reviewers: [],
    workspace: "/tmp",
    search: null,
    knowledge: null,
    engine: "claude-code",
    agent: null,
  };
  for (const k of Object.keys(drafts)) delete drafts[k];
  vi.mocked(api.askAside).mockClear();
  vi.mocked(api.cancelAside).mockClear();
}

describe("an aside sends through the shared composer's path (283)", () => {
  beforeEach(reset);

  it("a draft's first question goes in place with the box's chips and the thread's own model and effort", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    d.model = "haiku";
    d.effort = "low";
    await askAside("what is in the shot?", d.quote, d, { attachments: [img(1), doc(2), file(3)] });
    expect(app.asides).toHaveLength(1);
    expect(d.draft).toBe(false);
    const [, , opts] = vi.mocked(api.askAside).mock.calls[0]!;
    expect(opts?.images).toEqual([{ media_type: "image/png", data: "aGVsbG8=" }]);
    expect(opts?.documents).toEqual([{ media_type: "text/plain", name: "notes.txt", data: "bm90ZXM=" }]);
    expect(opts?.files).toEqual([{ name: "deck.key", data: "AAAA" }]);
    expect(opts?.model).toBe("haiku");
    expect(opts?.effort).toBe("low");
    const t = d.turns[0]!;
    expect(t.attachments?.map((a) => a.name)).toEqual(["shot1.png", "notes.txt", "deck.key"]);
    // Drawn as a reply: the model and the figure come back with the answer.
    expect(t.model).toBe("claude-opus-5");
    expect(t.usage?.output_tokens).toBe(34);
    expect(t.at).toBeTruthy();
  });

  it("no pick is the chat's: neither model nor effort crosses", () => {
    expect(asideWire({}, [])).toEqual({});
    expect(asideWire({ model: null, effort: null }, [])).toEqual({});
    // An empty effort is the CLI's default, a real pick: it crosses.
    expect(asideWire({ effort: "" }, [])).toEqual({ effort: "" });
  });

  it("chips alone send: the words the CLI needs stand in, his bubble keeps none", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("", d.quote, d, { attachments: [img(1)] });
    const [sent] = vi.mocked(api.askAside).mock.calls[0]!;
    expect(sent).toContain(ATTACHMENTS_ONLY);
    expect(d.turns[0]!.question).toBe("");
  });

  it("a follow-up sends the earlier exchanges' chips again (blocker 960), not one read back without bytes", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("look", d.quote, d, { attachments: [img(1)] });
    d.turns[0]!.attachments!.push({ ...img(9), data: "" });
    await followUpAside("and the corner?", d, { attachments: [img(2, "Y29ybmVy")] });
    const [, , opts] = vi.mocked(api.askAside).mock.calls[1]!;
    expect(opts?.images?.map((i) => i.data)).toEqual(["aGVsbG8=", "Y29ybmVy"]);
    expect(d.turns[1]!.attachments?.map((a) => a.name)).toEqual(["shot2.png"]);
  });

  it("a composer aside asked from its own box stays that thread, not the newest composer thread", async () => {
    await askAside("first composer aside");
    const other = app.asides[0]!;
    const own = draftAside(quote(4), null)!;
    own.quote = null;
    await askAside("mine", null, own);
    expect(own.turns.map((t) => t.question)).toEqual(["mine"]);
    expect(other.turns.map((t) => t.question)).toEqual(["first composer aside"]);
  });

  it("Stop keeps what arrived and the card", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.askAside).mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    const d = draftAside(quote(2), anchor(3))!;
    const p = askAside("slow", d.quote, d);
    d.turns[0]!.partial = "half";
    stopAside(d);
    release({ answer: "whole", cache_read: 0, is_error: false, notices: [] });
    await p;
    expect(api.cancelAside).toHaveBeenCalled();
    expect(app.asides).toContain(d);
    expect(d.turns[0]!.partial).toBe("half");
    expect(d.turns[0]!.cancelled).toBe(true);
  });
});

describe("the aside's box is kept as a chat's draft is (283, practices §7)", () => {
  beforeEach(reset);

  it("typed text lives under the thread's drafts key and in `unsent`", () => {
    const d = draftAside(quote(2), anchor(3))!;
    expect(d.uid).toBeTruthy();
    setAsideUnsent(d, "half a question");
    expect(readDraft(asideDraftKey(d)).text).toBe("half a question");
    expect(d.unsent).toBe("half a question");
  });

  it("the thread's key survives a relaunch: its uid, model and effort are written with it", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("why?", d.quote, d, { attachments: [img(1)] });
    d.model = "sonnet";
    d.effort = "high";
    const raw = serializeAsides(new Map([["chat-a", [d]]]));
    const back = loadAsides({ getItem: (k: string) => (k === ASIDES_KEY ? raw : null) }).get("chat-a")![0]!;
    expect(back.uid).toBe(d.uid);
    expect(asideDraftKey(back)).toBe(asideDraftKey(d));
    expect(back.model).toBe("sonnet");
    expect(back.effort).toBe("high");
    // The chip by name: the bytes are not in the store.
    expect(back.turns[0]!.attachments?.[0]).toMatchObject({ name: "shot1.png", kind: "image", data: "" });
    expect(raw).not.toContain("aGVsbG8=");
  });

  it("a draft card holding only a chip or a held message is kept; an empty one is not", () => {
    const d = draftAside(quote(2), anchor(3))!;
    const empty = draftAside(quote(5), anchor(9))!;
    addAttachment(asideDraftKey(d), img(1));
    const raw = serializeAsides(new Map([["chat-a", [d, empty]]]));
    const back = loadAsides({ getItem: () => raw }).get("chat-a")!;
    expect(back).toHaveLength(1);
    expect(back[0]!.uid).toBe(d.uid);
    expect(back[0]!.draft).toBe(true);
    delete drafts[asideDraftKey(d)];
    enqueueMessage(asideDraftKey(d), "held", []);
    expect(serializeAsides(new Map([["chat-a", [d]]]))).toContain(d.uid!);
  });

  it("closing asks first when the box holds only a chip; Discard drops the entry and rings the words to the chat", () => {
    const d = draftAside(quote(2), anchor(3))!;
    addAttachment(asideDraftKey(d), img(1));
    expect(asideHasDraft(d)).toBe(true);
    requestDismissAside(d);
    expect(app.asideDiscard).toBe(d);
    expect(app.asides).toContain(d);
    answerAsideDiscard(false);
    expect(app.asides).toContain(d);
    const long = "x".repeat(240);
    setAsideUnsent(d, long);
    requestDismissAside(d);
    answerAsideDiscard(true);
    expect(app.asides).not.toContain(d);
    expect(drafts[asideDraftKey(d)]).toBeUndefined();
    expect(historyFor("chat-a").some((s) => s.text === long)).toBe(true);
  });

  it("× while it answers stops it and keeps a card whose box holds his next words", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.askAside).mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    const d = draftAside(quote(2), anchor(3))!;
    const p = askAside("slow", d.quote, d);
    setDraftText(asideDraftKey(d), "next question");
    dismissAside(d);
    release({ answer: "", cache_read: 0, is_error: false, notices: [] });
    await p;
    expect(app.asides).toContain(d);
    expect(readDraft(asideDraftKey(d)).text).toBe("next question");
  });

  it("a past thread reopens with a fresh key: what its box held was discarded with the close", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("why?", d.quote, d);
    const stored = storedAsideOf(d)!;
    expect(stored.uid).toBeUndefined();
    const again = asideFromStored(JSON.parse(JSON.stringify(stored)))!;
    expect(again.uid).toBeTruthy();
    expect(again.uid).not.toBe(d.uid);
  });
});

describe("the message tools in an aside (283)", () => {
  beforeEach(reset);

  it("Rewind drops this exchange and the later ones, puts the question and its chips back in the box; Undo restores", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("one", d.quote, d, { attachments: [img(1)] });
    await followUpAside("two", d);
    await followUpAside("three", d);
    setAsideUnsent(d, "typed");
    const gone = rewindAside(d, 1);
    expect(gone.map((t) => t.question)).toEqual(["two", "three"]);
    expect(d.turns.map((t) => t.question)).toEqual(["one"]);
    expect(readDraft(asideDraftKey(d)).text).toBe("two\ntyped");
    expect(restoreAsideTurns(d, 1, gone)).toBe(true);
    expect(d.turns.map((t) => t.question)).toEqual(["one", "two", "three"]);
    // To the first: the thread is a question box again, its chip in the box.
    const all = rewindAside(d, 0);
    expect(all).toHaveLength(3);
    expect(d.draft).toBe(true);
    expect(readDraft(asideDraftKey(d)).attachments.map((a) => a.name)).toEqual(["shot1.png"]);
  });

  it("no rewind while an answer streams", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.askAside).mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    const d = draftAside(quote(2), anchor(3))!;
    const p = askAside("slow", d.quote, d);
    expect(rewindAside(d, 0)).toEqual([]);
    release({ answer: "ok", cache_read: 0, is_error: false, notices: [] });
    await p;
  });
});

describe("what an aside draws and hides (283)", () => {
  const files: Record<string, string> = {
    "./AsideCard.svelte": cardSrc,
    "./AsideView.svelte": viewSrc,
    "./AsideThread.svelte": threadSrc,
    "./Transcript.svelte": transcriptSrc,
    "./Composer.svelte": composerSrc,
  };
  const src = (f: string) => files[f]!;

  it("every chat-only control is hidden in an aside and shown in the chat", () => {
    for (const c of Object.keys(ASIDE_HIDDEN) as ChatOnlyControl[]) {
      expect(composerShows(c, true)).toBe(false);
      expect(composerShows(c, false)).toBe(true);
    }
    // The kept list and the hidden list never overlap.
    for (const k of ASIDE_KEPT) expect(k in ASIDE_HIDDEN).toBe(false);
  });

  it("the card, the panel and the tab draw the chat's composer and the shared thread", () => {
    for (const f of ["./AsideCard.svelte", "./AsideView.svelte"]) {
      const s = src(f);
      expect(s).toMatch(/<Composer \{aside\}/);
      expect(s).toMatch(/<AsideThread \{aside\}/);
      expect(s).not.toMatch(/<AsideBox/);
      expect(s).toMatch(/Aside of <em>/);
    }
    // The thread draws his words with the transcript's own bubble and the
    // answer with the chat's reply piece; the transcript uses the bubble too.
    expect(src("./AsideThread.svelte")).toMatch(/<UserBubble /);
    expect(src("./AsideThread.svelte")).toMatch(/<AssistantMessage/);
    expect(src("./Transcript.svelte")).toMatch(/<UserBubble/);
    // Fork and Remove-from-context are not in the aside's thread.
    expect(src("./AsideThread.svelte")).not.toMatch(/Fork helpers from here"/);
  });

  it("the composer gates the chat-only pieces through the list", () => {
    const s = src("./Composer.svelte");
    expect(s).toMatch(/composerShows\("schedule", !!aside\)/);
    expect(s).toMatch(/composerShows\("handoff", !!aside\)/);
    expect(s).toMatch(/composerShows\("ghost", !!aside\)/);
    // The aside's Send branch has neither the schedule ▾ nor the council.
    const branch = s.slice(s.indexOf("<!-- The aside's Send (backlog 283)"), s.indexOf("{:else}", s.indexOf("<!-- The aside's Send (backlog 283)")));
    expect(branch).not.toMatch(/ScheduleMenu|CouncilPopover|submitAside/);
  });

  it("Fold into thread is still offered on an asked aside, in the card and the tab", () => {
    expect(foldBlocked({ mode: "normal", claudeCode: true, open: true, answered: 1 })).toBeNull();
    for (const f of ["./AsideCard.svelte", "./AsideView.svelte"]) {
      const s = src(f);
      expect(s).toMatch(/<AsideFoldPanel \{aside\} part="button"/);
      expect(s).toMatch(/<AsideFoldPanel \{aside\} part="panel"/);
    }
  });
});

// The `Aside` type is the state's; this keeps the import used under `tsc`.
export type _A = Aside;
