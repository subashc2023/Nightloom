// Item 862: Listen in parts — a WAV's length from its header, and where a
// time falls across parts.
import { describe, expect, it } from "vitest";
import { before, partAt, wavSeconds } from "./listen";

/** A 16-bit mono WAV of `samples` silent samples at `rate` (the host's encoder's layout). */
function wav(samples: number, rate: number): ArrayBuffer {
  const b = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(b);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, samples * 2, true);
  return b;
}

describe("item 862: Listen in parts", () => {
  it("reads a WAV's length from its header", () => {
    expect(wavSeconds(wav(22050 * 3, 22050))).toBeCloseTo(3, 6);
    expect(wavSeconds(wav(0, 22050))).toBe(0);
    expect(wavSeconds(new ArrayBuffer(8))).toBe(0);
    expect(wavSeconds(new TextEncoder().encode("not a wav file at all, no").buffer as ArrayBuffer)).toBe(0);
  });

  it("finds the part and the place in it", () => {
    const L = [30, 100, 400];
    expect(partAt(L, 0)).toEqual({ i: 0, offset: 0 });
    expect(partAt(L, 29.5)).toEqual({ i: 0, offset: 29.5 });
    expect(partAt(L, 30)).toEqual({ i: 1, offset: 0 });
    expect(partAt(L, 200)).toEqual({ i: 2, offset: 70 });
    // Past what has landed: the next part to come.
    expect(partAt(L, 600)).toEqual({ i: 3, offset: 70 });
    expect(partAt([], 5)).toEqual({ i: 0, offset: 5 });
    expect(before(L, 2)).toBe(130);
    expect(before(L, 9)).toBe(530);
  });
});
