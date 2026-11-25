import { describe, expect, it } from "vitest";
import { cacheEstimate, coldToast, type ChipRates } from "./cacheCost";
import { nextSendCost } from "./cachePrice";
import { changePrice, switchDetail } from "./changeCost";
import { chipCosts, coldButtons, coldTip } from "./warmWrap";
import { draftCostNote, draftSendTokens, fileTokens, IMAGE_MAX_TOKENS, imageSize, imageTokens, PDF_PAGE_TOKENS } from "./draftCost";
import { phoneCache } from "../remote/cacheChip";
import type { SessionEvent, Usage } from "./types";
import composer from "./Composer.svelte?raw";
import rail from "./rightRail/logic.svelte?raw";
import topBar from "./topBar/logic.svelte?raw";
import remote from "../remote/Remote.svelte?raw";

// Item 904 (blocker 2283, default: split): the box's draft — text and
// attachments — goes into every next-send figure. 902's chat: 244k on Opus
// 5.5 ($8 write, $0.20 read per MTok) and a ~4.5k-token draft.
const AT = "2026-11-23T20:00:00Z";
const OPUS55: ChipRates = { read: 0.2, write: 8, from: "row" };
const usage: Usage = { input_tokens: 243_000, output_tokens: 1_000, cache_read_tokens: 242_000, cache_write_tokens: 1_000 };
const events = [
  { event: "user_message", text: "q", at: AT },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [], stop_reason: "end_turn", usage, sent_at: AT, cache_ttl: "1h", at: AT },
] as SessionEvent[];

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
function png(w: number, h: number): string {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(w), ...be(h), 8, 6, 0, 0, 0]);
}
function jpeg(w: number, h: number): string {
  // SOI, an APP0 of 16 bytes, then SOF0 with the size.
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return b64([0xff, 0xd8, ...app0, ...sof]);
}

describe("item 904 — what the draft adds, in tokens", () => {
  it("reads an image's size from its header and prices it as the API scales it", () => {
    expect(imageSize("image/png", png(800, 600))).toEqual({ w: 800, h: 600 });
    expect(imageSize("image/jpeg", jpeg(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(imageTokens({ w: 800, h: 600 })).toBe(640);
    // A Retina screenshot is scaled down: the cap.
    expect(imageTokens({ w: 2880, h: 1800 })).toBeLessThanOrEqual(IMAGE_MAX_TOKENS);
    expect(imageTokens({ w: 2880, h: 1800 })).toBeGreaterThan(1_400);
    // A size the header does not give counts the cap, never nothing.
    expect(fileTokens({ kind: "image", media_type: "image/webp", data: "AAAA" }, "claude-code")).toBe(IMAGE_MAX_TOKENS);
  });
  it("counts a PDF inline by its pages, a long one by path as a line, text by bytes, a converting chip as nothing", () => {
    const pdf = { kind: "document" as const, media_type: "application/pdf", data: "JVBERi0=" };
    expect(fileTokens({ ...pdf, pages: 4 }, "claude-code")).toBe(4 * PDF_PAGE_TOKENS);
    expect(fileTokens({ ...pdf, pages: 40 }, "claude-code")).toBeLessThan(100);
    expect(fileTokens({ ...pdf, pages: 40, whole: true }, "claude-code")).toBe(40 * PDF_PAGE_TOKENS);
    expect(fileTokens({ ...pdf, pages: 40 }, "api")).toBe(40 * PDF_PAGE_TOKENS);
    const text = btoa("x".repeat(4_000));
    expect(fileTokens({ kind: "document", media_type: "text/plain", data: text }, "api")).toBe(1_000);
    expect(fileTokens({ kind: "document", media_type: "application/pdf", data: "", pending: true }, "api")).toBe(0);
    expect(draftSendTokens("y".repeat(18_000), [{ kind: "document", media_type: "text/plain", data: text }], "api")).toBe(5_500);
    expect(draftSendTokens("   ", [], "api")).toBe(0);
  });
  it("the tooltip line says the figure counts the draft; none without one", () => {
    expect(draftCostNote(4_500)).toBe("Includes this draft's ~4.5k tokens");
    expect(draftCostNote(0)).toBe("");
  });
});

describe("item 904 — every next-send figure carries the draft", () => {
  const D = 4_500;
  it("the chip: written warm or cold, and its tooltip says so", () => {
    const bare = nextSendCost(usage, OPUS55);
    const with4k = nextSendCost(usage, OPUS55, D);
    expect(with4k.cold - bare.cold).toBeCloseTo((D * 8) / 1e6, 9);
    expect(with4k.warm - bare.warm).toBeCloseTo((D * 8) / 1e6, 9);
    const est = cacheEstimate(events, OPUS55, false, D)!;
    expect(est.cold).toBeCloseTo(((244_000 + D) * 8) / 1e6, 9);
    expect(est.title).toBe("Cache cold · next send ≈ $1.99 (API price)\nIncludes this draft's ~4.5k tokens");
    expect(cacheEstimate(events, OPUS55, false)!.title).toBe("Cache cold · next send ≈ $1.95 (API price)");
  });
  it("the cold banner: Keep sends the draft, Hand off's wrap-up does not", () => {
    const c = chipCosts(usage, OPUS55, false, D)!;
    expect(coldButtons(c)).toEqual({ handoff: "Hand off (≈ $1.95)", keep: "Keep (re-writes 244k ≈ $1.99)" });
    expect(coldTip(c, OPUS55).split("\n")[0]).toBe("Next send ≈ $1.99 · then ≈ $0.06 a turn");
  });
  it("the 'cache will be lost' bar and the rail's pending price: with and without the change both carry it", () => {
    const base = { usage, changes: [{ what: "tools", text: "tools off", whole: true }] as never, layers: null, built: OPUS55, target: OPUS55, engine: "claude-code" as const };
    const a = changePrice({ ...base, warm: true });
    const b = changePrice({ ...base, warm: true, draft: D });
    expect(b.with! - a.with!).toBeCloseTo((D * 8) / 1e6, 9);
    expect(b.without! - a.without!).toBeCloseTo((D * 8) / 1e6, 9);
    const cold = changePrice({ ...base, warm: false, draft: D });
    expect(cold.with).toBeCloseTo(((244_000 + D) * 8) / 1e6, 9);
  });
  it("the model menu's switch price and the cold toast", () => {
    expect(switchDetail(usage, "claude-opus-5-5", "claude-fable-5-2", { read: 0.2, write: 16, from: "r" }, true, false, D)).toBe("next ≈ $3.98");
    expect(coldToast(events, OPUS55, D)).toBe("Prompt cache cold — edits to the history now cost nothing extra · the next send re-writes 244k ≈ $1.99 API with the draft");
    expect(coldToast(events, OPUS55)).toMatch(/≈ \$1\.95 API$/);
  });
  it("the phone's chip", () => {
    const wire = { model: "claude-opus-5-5", read: 0.2, write_1h: 8, write_5m: 5, source: "rates" as const, pings: 0 };
    const chip = phoneCache({ usage }, 0, 1, wire, D)!;
    expect(chip.price).toBe("next ≈ $1.99");
    expect(chip.tip).toContain("Includes this draft's ~4.5k tokens");
  });
  it("is wired at every surface: the composer (chat and aside), the rail, the toast, the phone", () => {
    expect(composer).toContain("cacheEstimate(app.events, targetRates, cache.warm && !modelSwitch, draftTokens)");
    expect(composer).toContain("chipCosts(wwUsage, targetRates, modelSwitch, draftTokens)");
    expect(composer).toMatch(/sideWarm: !!sideCache,\s+draftTokens,/);
    expect(composer).toContain("chatCache.warm, !!side, draftTokens)");
    expect(rail).toContain("boxDraftTokens(aside ? asideDraftKey(aside) : draftKey(");
    expect(rail).toContain("cache.warm, railDraft)");
    expect(rail).toContain("draftTokens: railDraft");
    expect(topBar).toContain("boxDraftTokens(app.activeSessionId, app.connection?.engine)");
    expect(remote).toContain('phoneCache(lastReplyHere, warmUntil, now, chipRates, photoTokens + draftSendTokens(draft, [], "claude-code"))');
    expect(remote).toContain("price={asideChip?.price ?? null}");
  });
});
