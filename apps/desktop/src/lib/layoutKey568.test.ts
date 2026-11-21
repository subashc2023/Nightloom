import { beforeEach, describe, expect, it, vi } from "vitest";

/** Item 568: the layout choice and the window's sizes kept one key. */
// Each test pays a fresh import of `layout.svelte` and its graph (4.8 s
// alone, measured 2026-11-16); the 5 s default timed the first out under
// load twice in one merge wave.
const IMPORT_TIMEOUT = 30_000;

describe("the layout choice has its own key (item 568)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it(
    "moves an old bare 'classic' to its own key once",
    async () => {
      localStorage.setItem("nightloom.layout", "classic");
      const { layout } = await import("./layout.svelte");
      expect(layout.value).toBe("classic");
      expect(localStorage.getItem("nightloom.look")).toBe("classic");
      expect(localStorage.getItem("nightloom.layout")).toBeNull();
    },
    IMPORT_TIMEOUT,
  );

  it(
    "leaves the window's sizes alone and saves the choice apart",
    async () => {
      const sizes = JSON.stringify({ sidebar: 300 });
      localStorage.setItem("nightloom.layout", sizes);
      const { layout, setLayout } = await import("./layout.svelte");
      expect(layout.value).toBe("filament");
      setLayout("classic");
      expect(localStorage.getItem("nightloom.layout")).toBe(sizes);
      expect(localStorage.getItem("nightloom.look")).toBe("classic");
    },
    IMPORT_TIMEOUT,
  );
});
