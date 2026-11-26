/*
 * Item 1010: the reply footer's items never overlap or break inside themselves. happy-dom has no layout, so this
 * is a layout-rule test over the stylesheets the real components ship (main chat, Classic, the aside card all
 * draw the footer through these two files; the phone page runs the same components).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
const rule = (css: string, sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule ${sel}`);
  return m[1];
};

describe("the reply footer's layout rules (item 1010)", () => {
  for (const f of ["AssistantMessage.svelte", "AssistantMessageClassic.svelte"]) {
    const css = read(f).split("<style>")[1];
    it(`${f}: the row wraps between items instead of squeezing them`, () => {
      const r = rule(css, ".footer");
      expect(r).toMatch(/display:\s*flex/);
      expect(r).toMatch(/flex-wrap:\s*wrap/);
    });
    it(`${f}: figures and Redo never shrink or break onto two lines`, () => {
      expect(rule(css, ".meta")).toMatch(/white-space:\s*nowrap/);
      expect(rule(css, ".meta")).toMatch(/flex:\s*none/);
      expect(rule(css, ".footer .redo")).toMatch(/flex:\s*none/);
      expect(rule(css, ".footer .redo")).toMatch(/white-space:\s*nowrap/);
    });
    it(`${f}: only the stop note (free text) may wrap, inside its own box`, () => {
      const r = rule(css, ".meta.stopped");
      expect(r).toMatch(/min-width:\s*0/);
      expect(r).toMatch(/white-space:\s*normal/);
    });
  }
  it("Listen and Brief keep their width while idle (they were squeezed into Redo)", () => {
    const css = read("ListenButton.svelte").split("<style>")[1];
    expect(rule(css, ".listen:not(.open)")).toMatch(/flex:\s*none/);
    expect(rule(css, ".lb,\n  .lx")).toMatch(/white-space:\s*nowrap/);
  });
});
