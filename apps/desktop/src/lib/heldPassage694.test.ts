import { beforeEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import transcriptSrcRaw from "./Transcript.svelte?raw";
import classicSrcRaw from "./TranscriptClassic.svelte?raw";
import { app, askAside } from "./state.svelte";
import { boxAsideArgs, dropHeld, focusIsMainBox, heldFor, heldLabel, heldPassage, holdPassage, takeHeld } from "./heldPassage.svelte";
import * as api from "./api";
import transcriptLogicRaw from "./transcript/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
const transcriptSrc = asOneFile(transcriptSrcRaw, transcriptLogicRaw);
const classicSrc = asOneFile(classicSrcRaw, transcriptLogicRaw);

/**
 * Item 694: highlight a passage, click into the message box, type, click
 * Ask aside — the aside is about the passage, anchored to it, as the
 * selection pill's Ask aside would be. Before the fix the box's Ask aside
 * always asked `askAside(t, null, null, …)`: no quote, no anchor.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({ answer: "because", cost: 0, cache_read: 10, is_error: false, notices: [] })),
  cancelAside: vi.fn(async () => null),
}));

const SOURCES: Record<string, string> = { "Composer.svelte": composerSrc, "Transcript.svelte": transcriptSrc, "TranscriptClassic.svelte": classicSrc };
const src = (f: string) => SOURCES[f]!;

const quote = { text: "the  passage\nhe highlighted", role: "assistant" as const, ordinal: 3 };
const anchor = { turn: 7, block: 0, start: 4, end: 30, side: "below" as const };

describe("the box's held passage (item 694)", () => {
  beforeEach(() => {
    heldPassage.value = null;
  });

  it("is held for one box and only that box", () => {
    holdPassage("chat-a", quote, anchor);
    expect(heldFor("chat-a")?.quote.text).toBe(quote.text);
    expect(heldFor("chat-a")?.anchor).toEqual(anchor);
    expect(heldFor("chat-b")).toBeNull();
    expect(heldFor(null)).toBeNull();
  });

  it("a new passage replaces the held one", () => {
    holdPassage("chat-a", quote, anchor);
    holdPassage("chat-a", { ...quote, text: "another" }, null);
    expect(heldFor("chat-a")?.quote.text).toBe("another");
    expect(heldFor("chat-a")?.anchor).toBeNull();
  });

  it("drops only the named box's passage", () => {
    holdPassage("chat-a", quote, anchor);
    dropHeld("chat-b");
    expect(heldFor("chat-a")).not.toBeNull();
    dropHeld("chat-a");
    expect(heldFor("chat-a")).toBeNull();
    holdPassage("chat-a", quote, anchor);
    dropHeld();
    expect(heldPassage.value).toBeNull();
  });

  it("is taken once", () => {
    holdPassage("chat-a", quote, anchor);
    expect(takeHeld("chat-b")).toBeNull();
    expect(takeHeld("chat-a")?.anchor).toEqual(anchor);
    expect(takeHeld("chat-a")).toBeNull();
  });

  it("the composer's choice: the held passage's quote and anchor, then nothing", () => {
    holdPassage("chat-a", quote, anchor);
    expect(boxAsideArgs("chat-a")).toEqual({ quote, anchor });
    // Taken: the next Ask aside from the box is about nothing, as before.
    expect(boxAsideArgs("chat-a")).toEqual({ quote: null, anchor: null });
  });

  it("the chip shows the passage's first ~60 characters on one line", () => {
    expect(heldLabel(quote)).toBe("the passage he highlighted");
    const long = { ...quote, text: "x".repeat(100) };
    expect(heldLabel(long)).toBe(`${"x".repeat(60)}…`);
  });

  it("only the chat's own message box holds it", () => {
    const el = (inBox: boolean) => ({ closest: (sel: string) => (inBox && sel === '[data-drop-box="main"] .ta-wrap' ? {} : null) }) as unknown as Element;
    expect(focusIsMainBox(el(true))).toBe(true);
    // The wrap-up textarea, the aside's box, a button: not in the main box's `.ta-wrap`.
    expect(focusIsMainBox(el(false))).toBe(false);
    expect(focusIsMainBox(null)).toBe(false);
  });
});

describe("askAside from the box with a held passage (item 694)", () => {
  beforeEach(() => {
    app.activeSessionId = "chat-a";
    app.asides = [];
    app.aside = null;
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
    } as unknown as typeof app.connection;
    vi.mocked(api.askAside).mockClear();
  });

  it("opens a card about the passage, anchored to it, with his words", async () => {
    await askAside("why this?", quote, null, { anchor });
    expect(app.asides).toHaveLength(1);
    const a = app.asides[0]!;
    expect(a.quote).toEqual(quote);
    expect(a.anchor).toEqual(anchor);
    expect(a.draft).toBe(false);
    expect(a.turns[0]!.question).toBe("why this?");
    // The passage rides in the string sent, as the pill's aside sends it.
    expect(JSON.stringify(vi.mocked(api.askAside).mock.calls[0])).toContain("he highlighted");
  });

  it("without a quote the anchor is ignored (a composer aside has no passage)", async () => {
    await askAside("what now?", null, null, { anchor });
    expect(app.asides[0]!.anchor).toBeNull();
  });
});

describe("the wiring (item 694)", () => {
  it("the composer's Ask aside passes the held quote and anchor", () => {
    const c = src("Composer.svelte");
    const body = c.slice(c.indexOf("async function submitAside()"), c.indexOf("async function asideSubmit()"));
    expect(body).toContain("boxAsideArgs(sendKey)");
    expect(body).toMatch(/askAside\(t, quote, null, \{ attachments: chips, anchor \}\)/);
    expect(body).not.toContain("askAside(t, null, null");
  });

  it("Send drops the held passage", () => {
    const c = src("Composer.svelte");
    const body = c.slice(c.indexOf("async function submitNow()"), c.indexOf("async function submitCouncil("));
    expect(body).toContain("dropHeld(key)");
  });

  it("both transcripts hold the passage when it gives way to the box", () => {
    for (const f of ["Transcript.svelte", "TranscriptClassic.svelte"]) {
      const t = src(f);
      const place = t.slice(t.indexOf("function placePill()"), t.indexOf("function anchorOfSelection()"));
      expect(place, f).toContain("holdIfIntoBox()");
      expect(t, f).toContain("holdPassage(chatBoxKey(), last.quote, anchorOf(last))");
    }
  });
});
