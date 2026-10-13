import { describe, expect, it } from "vitest";
import { Vad, type VadEvent } from "./vad";

/** Feed `ms` of frames at `db`; collect what the VAD said, with when. */
function feed(vad: Vad, db: number, ms: number, t0 = 0): { at: number; ev: VadEvent }[] {
  const out: { at: number; ev: VadEvent }[] = [];
  for (let t = 20; t <= ms; t += 20) {
    const ev = vad.push(db);
    if (ev) out.push({ at: t0 + t, ev });
  }
  return out;
}

describe("vad", () => {
  it("starts after 150 ms above the floor, not before", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    expect(feed(vad, -30, 140)).toEqual([]);
    const v = new Vad();
    feed(v, -60, 1000);
    const got = feed(v, -30, 160);
    expect(got).toHaveLength(1);
    expect(got[0].at).toBe(160);
    expect(got[0].ev).toEqual({ kind: "start", backMs: 160 });
  });

  it("a blip shorter than the onset never starts, and does not carry over a dip", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    expect(feed(vad, -30, 100)).toEqual([]);
    expect(feed(vad, -60, 20)).toEqual([]);
    expect(feed(vad, -30, 100)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it("ends 2.0 s after the last voiced frame, with the speech counted", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    feed(vad, -30, 1000);
    expect(vad.speaking).toBe(true);
    const quiet = feed(vad, -60, 3000);
    expect(quiet).toHaveLength(1);
    expect(quiet[0].at).toBe(2000);
    expect(quiet[0].ev).toMatchObject({ kind: "end", speechMs: 1000, totalMs: 3000 });
    expect(vad.speaking).toBe(false);
  });

  it("a pause shorter than the setting keeps one utterance", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    feed(vad, -30, 600);
    expect(feed(vad, -60, 1900)).toEqual([]);
    expect(feed(vad, -30, 400)).toEqual([]);
    const end = feed(vad, -60, 2500);
    expect(end.map((e) => e.ev.kind)).toEqual(["end"]);
    expect((end[0].ev as { speechMs: number }).speechMs).toBe(1000);
  });

  it("the silence setting moves the end, clamped to 1–4 s", () => {
    const vad = new Vad();
    vad.setSilence(1000);
    feed(vad, -60, 1000);
    feed(vad, -30, 500);
    expect(feed(vad, -60, 2000)[0].at).toBe(1000);
    vad.setSilence(9000);
    expect(vad.opts.silenceMs).toBe(4000);
    vad.setSilence(10);
    expect(vad.opts.silenceMs).toBe(1000);
  });

  it("the noise floor adapts: a louder room stops counting as speech", () => {
    // In a quiet room (-60 dB) a -45 dB sound is speech…
    const quiet = new Vad();
    feed(quiet, -60, 2000);
    expect(feed(quiet, -45, 300).map((e) => e.ev.kind)).toEqual(["start"]);
    // …but after a while in wind at -50 dB the floor has risen to it, and
    // -45 dB (5 dB over) is the room, not him.
    // (A sudden 10 dB step of wind is heard as one utterance first — the
    // host's noise filter drops what whisper makes of it.)
    const windy = new Vad();
    feed(windy, -60, 2000);
    feed(windy, -50, 10000);
    expect(windy.floor).toBeGreaterThan(-51);
    expect(windy.speaking).toBe(false);
    expect(feed(windy, -45, 1000)).toEqual([]);
    // He still gets through, 9 dB over the new floor.
    expect(feed(windy, -35, 300).map((e) => e.ev.kind)).toEqual(["start"]);
  });

  it("the floor drops at once when the room goes quiet", () => {
    const vad = new Vad();
    feed(vad, -40, 5000);
    feed(vad, -70, 20);
    expect(vad.floor).toBeCloseTo(-70, 5);
  });

  it("while the reply speaks, the bar is higher (the speaker leaks in)", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    vad.replying = true;
    expect(feed(vad, -49, 300)).toEqual([]);
    expect(feed(vad, -40, 300).map((e) => e.ev.kind)).toEqual(["start"]);
  });

  it("digital silence is not NaN", () => {
    const vad = new Vad();
    expect(vad.push(-Infinity)).toBeNull();
    expect(Number.isFinite(vad.floor)).toBe(true);
  });

  it("level is 0 at the floor and 1 well above it", () => {
    const vad = new Vad();
    feed(vad, -60, 1000);
    expect(vad.level(-60)).toBe(0);
    expect(vad.level(-20)).toBe(1);
  });
});
