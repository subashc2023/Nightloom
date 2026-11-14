import { describe, expect, it } from "vitest";

// His ask (2026-11-12, after item 628): "call it Jarvis theme everywhere no longer this Filament shit".
// Every word he can read in a .svelte file — comments, imports and code identifiers (FilamentMark,
// .fil-*, the stored id "filament") aside — says Jarvis, never Filament.
const files = import.meta.glob(["../**/*.svelte"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function visible(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/^\s*import .*$/gm, "");
}

describe("the theme is called Jarvis everywhere he can see it", () => {
  it("no visible 'Filament' word in any component", () => {
    const hits: string[] = [];
    for (const [path, src] of Object.entries(files)) {
      visible(src).split("\n").forEach((line, i) => {
        if (/Filament(?![A-Za-z])/.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
