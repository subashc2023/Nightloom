import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNCIL,
  councilOfTurn,
  lastCouncil,
  parseCouncilPrefs,
  parseCouncilRecord,
  parseCouncilSeat,
  recordCost,
  recordTokens,
  rosterLabel,
} from "./council";
import type { SessionEvent } from "./types";

// The writers' shapes, verbatim from `council.rs`'s tests
// (`a_seat_block_reveals_the_map_and_escapes_its_attributes`,
// `the_record_round_trips_through_its_block_and_reads_back_from_a_session`).
const SEAT =
  '<council-seat label="A" model="opus" forked="true" searches="2" tokens="110" angle="1/2" area="costs &amp; &quot;limits&quot;">\nthe answer\n</council-seat>';

const RECORD_JSON = {
  mode: "answer",
  seats: [
    {
      label: "A",
      model: "fable",
      engine: "subscription",
      forked: true,
      searches: 2,
      tool_uses: 3,
      words: 1,
      usage: { input_tokens: 100, output_tokens: 10 },
      cost_usd: 0.5,
      duration_ms: 1200,
      cited: ["a.org/p", "b.org/q"],
      seen: 0,
    },
    {
      label: "B",
      model: "opus",
      engine: "subscription",
      forked: true,
      searches: 2,
      tool_uses: 3,
      words: 1,
      usage: { input_tokens: 100, output_tokens: 10 },
      cost_usd: 0.5,
      duration_ms: 1200,
      angle: [1, 2],
      cited: ["a.org/p"],
      seen: 0,
    },
  ],
  overlap: { pairwise: [[0, 1, 0.5]], shared_by_all: 0.5, union: 2, shared: 1 },
  fired: true,
  areas_used: [],
  areas_next: ["the missing area"],
  at: "2026-09-17T20:00:00Z",
};
const RECORD = `<council>\n${JSON.stringify(RECORD_JSON, null, 2)}\n</council>`;

describe("parseCouncilSeat", () => {
  it("reads the map from the attributes and the answer from the body", () => {
    const s = parseCouncilSeat(SEAT);
    expect(s).not.toBeNull();
    expect(s!.label).toBe("A");
    expect(s!.model).toBe("opus");
    expect(s!.forked).toBe(true);
    expect(s!.searches).toBe(2);
    expect(s!.tokens).toBe(110);
    expect(s!.angle).toBe("1/2");
    expect(s!.area).toBe('costs & "limits"');
    expect(s!.error).toBeNull();
    expect(s!.body).toBe("the answer");
  });

  it("leaves prose and the other marker alone", () => {
    expect(parseCouncilSeat("hello")).toBeNull();
    expect(parseCouncilSeat(RECORD)).toBeNull();
    expect(parseCouncilSeat('<council-seat model="x">\nno label\n</council-seat>')).toBeNull();
  });
});

describe("parseCouncilRecord", () => {
  it("round-trips the record and sums its figures", () => {
    const r = parseCouncilRecord(RECORD);
    expect(r).not.toBeNull();
    expect(r!.seats.map((s) => s.label)).toEqual(["A", "B"]);
    expect(r!.overlap.shared_by_all).toBe(0.5);
    expect(r!.fired).toBe(true);
    expect(recordTokens(r!)).toBe(220);
    expect(recordCost(r!)).toBe(1);
    expect(parseCouncilRecord("<council>\nnot json\n</council>")).toBeNull();
    expect(parseCouncilRecord(SEAT)).toBeNull();
  });
});

describe("councilOfTurn / lastCouncil", () => {
  const events: SessionEvent[] = [
    { event: "session_created", id: "s", at: "t" },
    { event: "user_message", text: "dump", at: "t" },
    {
      event: "assistant_message",
      model: "m",
      blocks: [
        { type: "text", text: "the chair" },
        { type: "text", text: SEAT },
        { type: "text", text: RECORD },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      at: "t",
    },
    { event: "user_message", text: "plain", at: "t" },
    {
      event: "assistant_message",
      model: "m",
      blocks: [{ type: "text", text: "plain reply" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      at: "t",
    },
  ] as SessionEvent[];

  it("finds the record of the reply that answered a user message", () => {
    expect(councilOfTurn(events, 1)?.seats.length).toBe(2);
    expect(councilOfTurn(events, 3)).toBeNull();
    expect(lastCouncil(events)?.areas_next).toEqual(["the missing area"]);
    expect(lastCouncil(events.slice(0, 2))).toBeNull();
  });
});

describe("parseCouncilPrefs", () => {
  it("takes the design's default for nothing, junk, or too few seats", () => {
    expect(parseCouncilPrefs(null)).toEqual(DEFAULT_COUNCIL);
    expect(parseCouncilPrefs("{nope")).toEqual(DEFAULT_COUNCIL);
    expect(parseCouncilPrefs(JSON.stringify({ seats: [{ model: "opus" }], mode: "disproof" })).seats).toEqual(
      DEFAULT_COUNCIL.seats,
    );
    const p = parseCouncilPrefs(
      JSON.stringify({ seats: [{ model: "sonnet" }, { model: "fable", engine: "api" }], mode: "disproof" }),
    );
    expect(p.mode).toBe("disproof");
    expect(p.seats).toEqual([
      { model: "sonnet", engine: "subscription" },
      { model: "fable", engine: "api" },
    ]);
    expect(rosterLabel(p.seats)).toBe("sonnet + fable");
  });
});
