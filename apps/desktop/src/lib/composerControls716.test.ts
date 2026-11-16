// Item 716 part 2: the composer's controls' rules live in src/composerControls.css, re-rooted on
// `.composer`, imported before app.css; Settings' Composer row previews draw the real controls.
import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import settingsSrc from "./SettingsModal.svelte?raw";
import mainSrc from "../main.ts?raw";
// vitest empties CSS imports, so the sheet is read from disk (the module name is built so the type check skips it).
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const css = fs.readFileSync(new URL("../composerControls.css", import.meta.url), "utf8");
const style = composerSrc.slice(composerSrc.indexOf("<style>"));

/** Every selector of every rule (comments dropped; @media / @keyframes / @property preludes and keyframe steps skipped). */
function selectors(sheet: string): string[] {
  const out: string[] = [];
  const clean = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const pre = m[1].trim();
    if (!pre || pre.startsWith("@") || /^(from|to|\d+%)(\s*,\s*\d+%)*$/.test(pre)) continue;
    for (const s of pre.split(/,(?![^(]*\))/)) out.push(s.trim());
  }
  return out;
}

describe("composerControls.css (item 716)", () => {
  it("is imported in main.ts before app.css, where the scoped rules sat in the bundle", () => {
    const i = mainSrc.indexOf('import "./composerControls.css";');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(mainSrc.indexOf('import "./app.css";'));
  });
  it("roots every selector on .composer (one class, as Svelte's scope was), behind at most a :where() gate", () => {
    const sels = selectors(css);
    expect(sels.length).toBeGreaterThan(60);
    for (const s of sels) expect(s, s).toMatch(/^(:where\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\) )?\.composer /);
    expect(css).not.toContain(":global(");
  });
  it("holds Send's look, its keyframes and the pickers; Composer.svelte no longer does", () => {
    for (const k of [".ns-btn.fil-send:hover:not(:disabled) .fil-scan", "@keyframes fil-scan", "@keyframes fil-edge", ".pick-btn", ".bottom-mark::after", ".fil-ghost .council-ico"])
      expect(css, k).toContain(k);
    for (const k of [".ns-btn.fil-send {", "@keyframes fil-scan", ") .pick-btn {", ") .bottom-mark {", "\n  .council-ico {\n"]) expect(style, k).not.toContain(k);
  });
});

describe("Settings' Composer row previews (item 716)", () => {
  const pv = settingsSrc.slice(settingsSrc.indexOf('class="composer crow-pv"'), settingsSrc.indexOf("<!-- Item 596"));
  it("draws the real Send, Council, picker and switches, not stand-ins", () => {
    expect(pv).toContain('class="ns-btn accent send fil-btn fil-send"');
    expect(pv).toContain('<FilamentMark kind="send" />');
    expect(pv).toContain('<FilamentMark kind="council" />');
    expect(pv).toContain('class="pick-chev"');
    expect(pv).toContain('class="ns-btn accent sched-caret"');
    expect(pv).not.toContain("pv-send");
    expect(settingsSrc).not.toContain(".crow-pv) .pick-btn");
  });
  it("lets the pointer reach the controls, so their hover runs", () => {
    const rule = settingsSrc.slice(settingsSrc.indexOf("  .crow-pv {"), settingsSrc.indexOf("  .crow-pv .card {"));
    expect(rule).not.toMatch(/^\s*pointer-events:\s*none/m);
  });
});
