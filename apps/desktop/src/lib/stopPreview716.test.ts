// Item 716 part 4: the Stop's rules live in src/composerControls.css (re-rooted on `.composer`);
// Settings' Stop button choices draw the real Stop, not the stop-swatch drawing.
import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import settingsSrc from "./SettingsModal.svelte?raw";
// vitest empties CSS imports, so the sheet is read from disk (the module name is built so the type check skips it).
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const css = fs.readFileSync(new URL("../composerControls.css", import.meta.url), "utf8");
const style = composerSrc.slice(composerSrc.indexOf("<style>"));

describe("the Stop's rules (item 716 part 4)", () => {
  it("are in composerControls.css, rooted on .composer, and gone from Composer.svelte", () => {
    for (const k of [".composer .stop .stop-ico", ".composer .stop:not(.shape-wide)", ".composer .stop.shape-round", ".composer .stop.stopping", ".composer .stop-spin", "@keyframes stop-spin"])
      expect(css, k).toContain(k);
    for (const k of ["  .stop .stop-ico {", "  .stop.shape-round {", "  .stop.stopping {", "@keyframes stop-spin"]) expect(style, k).not.toContain(k);
  });
});

describe("Settings' Stop button choices (item 716 part 4)", () => {
  const card = settingsSrc.slice(settingsSrc.indexOf('aria-label="Stop button shape"'), settingsSrc.indexOf("<!-- Item 456"));
  it("draw the composer's own Stop markup inside a .composer", () => {
    expect(card).toContain('class="composer stop-pv"');
    expect(card).toContain('class="ns-btn danger send stop shape-{sh.id}"');
    expect(card).toContain('<span class="stop-size">Send</span>');
    expect(card).toContain('<span class="stop-word">Stop</span>');
    expect(card).not.toContain('class="stop-swatch');
    expect(settingsSrc).not.toContain(".stop-swatch {");
  });
});
