// Item 944: Home starts simple and grows — Watching draws a section only once it has something, and says one calm
// line while nothing needs him.
import { describe, expect, it } from "vitest";
import { watchShape } from "./arrive";
import watchSrc from "./views/Watch.svelte?raw";
import phoneSrc from "../../remote/HomeFirst.svelte?raw";

const none = { sources: 0, reading: false, needs: 0, steps: 0, busy: false };

describe("Watching's shape (item 944)", () => {
  it("draws nothing but one calm line on a Home with nothing in it", () => {
    const s = watchShape(none);
    expect(s).toMatchObject({ sources: false, needs: false, steps: false, bare: true });
    expect(s.calm).toContain("Nothing needs you");
    expect(s.calm).toContain("Settings → Home");
  });
  it("adds each section when it first has something", () => {
    expect(watchShape({ ...none, sources: 3 })).toMatchObject({ sources: true, needs: false, steps: false, bare: false });
    expect(watchShape({ ...none, sources: 3 }).calm).toBe("Nothing needs you — Home is watching.");
    expect(watchShape({ ...none, sources: 3, needs: 1 })).toMatchObject({ needs: true, calm: null });
    expect(watchShape({ ...none, steps: 2 })).toMatchObject({ steps: true, sources: false });
  });
  it("shows Sources while the first read is out, and Home's steps while Home works", () => {
    expect(watchShape({ ...none, reading: true }).sources).toBe(true);
    expect(watchShape({ ...none, busy: true }).steps).toBe(true);
  });
  it("no section is removed: each is still in the view, behind its own condition, with an arrival", () => {
    for (const title of ['title="Sources"', 'title="Needs you"', `title="Home's steps"`]) expect(watchSrc).toContain(title);
    expect(watchSrc.match(/use:late/g)?.length).toBeGreaterThanOrEqual(4);
    for (const s of ["needs", "scan", "running", "sources"]) expect(phoneSrc).toContain(`data-home-section="${s}"`);
    expect(phoneSrc).toContain('class="h-calm"');
  });
});
