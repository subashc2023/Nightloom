// Item 618b: the Composer row choice (Settings → Appearance), its default,
// its memory, and where its rules sit.
import { afterEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import settingsSrc from "./SettingsModal.svelte?raw";
import mainSrc from "../main.ts?raw";
// vitest empties CSS imports (codeCopy.test.ts), so the rules are read from disk; the module name is built so the
// type check (no Node types in this app) does not resolve it.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const rowCss = fs.readFileSync(new URL("../composerRow.css", import.meta.url), "utf8");

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the Composer row setting", () => {
  it("offers Glass rail first and reads nothing, or anything unknown, as Glass rail", async () => {
    const { COMPOSER_ROWS, parseComposerRow } = await import("./composerRow.svelte");
    expect(COMPOSER_ROWS.map((r) => r.id)).toEqual(["glass-rail", "glass", "rail", "strip"]);
    expect(COMPOSER_ROWS.map((r) => r.name)).toEqual(["Glass rail", "Glass", "Rail", "Strip"]);
    expect(parseComposerRow(null)).toBe("glass-rail");
    expect(parseComposerRow("hud")).toBe("glass-rail");
    for (const id of ["glass", "rail", "strip"]) expect(parseComposerRow(id)).toBe(id);
  });

  it("defaults to Glass rail with empty storage, and a pick survives a relaunch", async () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    let mod = await import("./composerRow.svelte");
    expect(mod.composerRow.value).toBe("glass-rail");
    mod.setComposerRow("strip");
    expect(store.getItem("nightloom.composerRow")).toBe("strip");
    vi.resetModules(); // a relaunch: the module reads storage afresh
    mod = await import("./composerRow.svelte");
    expect(mod.composerRow.value).toBe("strip");
    mod.setComposerRow("glass-rail"); // the default stores nothing
    expect(store.getItem("nightloom.composerRow")).toBeNull();
  });
});

describe("where it applies", () => {
  it("is stamped on the composer's root and offered in Appearance under Filament only", () => {
    expect(composerSrc).toMatch(/data-composer-row=\{composerRow\.value\}/);
    expect(settingsSrc).toMatch(/<section class="card f4-only" aria-label="Composer row">/);
    expect(settingsSrc).toMatch(/class="composer crow-pv" data-composer-row=\{r\.id\}/);
  });

  it("loads after app.css, as the designs harness did", () => {
    expect(mainSrc.indexOf('import "./composerRow.css"')).toBeGreaterThan(mainSrc.indexOf('import "./app.css"'));
  });

  it("puts every rule behind the Filament guard, so Classic is untouched", () => {
    const noComments = rowCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...noComments.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((m) => m[1].trim())
      .filter((s) => s && !s.startsWith("@") && s !== ":root");
    expect(selectors.length).toBeGreaterThan(50);
    for (const s of selectors) expect(s.startsWith('html:not([data-layout="classic"]) .composer'), s).toBe(true);
  });
});
