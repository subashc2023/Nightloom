import { describe, expect, it } from "vitest";
import palette from "./Palette.svelte?raw";
import projectMenu from "./ProjectMenu.svelte?raw";
import scheduleMenu from "./ScheduleMenu.svelte?raw";
import tabChooser from "./TabChooser.svelte?raw";
import threadPicker from "./ThreadPicker.svelte?raw";
import confirmDialog from "./ConfirmDialog.svelte?raw";
import revertDialog from "./RevertDialog.svelte?raw";
import centre from "./NotificationCentre.svelte?raw";
import council from "./CouncilPopover.svelte?raw";
import asideItems from "./AsideMenuItems.svelte?raw";
import composer from "./Composer.svelte?raw";
import sidebar from "./Sidebar.svelte?raw";

/*
 * Item 570 (Filament IV stage 6: menus, palette, dialogs). Classic must not
 * change (item 542): every rule the stage added sits behind the Filament IV
 * gate, so a component under `data-layout="classic"` draws as before.
 */
const GATE = ':global(:where(:root:not([data-layout="classic"])))';
const files: [string, string][] = [
  ["Palette", palette],
  ["ProjectMenu", projectMenu],
  ["ScheduleMenu", scheduleMenu],
  ["TabChooser", tabChooser],
  ["ThreadPicker", threadPicker],
  ["ConfirmDialog", confirmDialog],
  ["RevertDialog", revertDialog],
  ["NotificationCentre", centre],
  ["CouncilPopover", council],
  ["AsideMenuItems", asideItems],
  ["Composer", composer],
  ["Sidebar", sidebar],
];

/** The CSS after the stage's marker comment, up to `</style>`. */
function stageBlock(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf("item 570");
  while (at !== -1) {
    const open = src.indexOf("*/", at);
    const close = src.indexOf("</style>", open);
    const next = src.indexOf("item 570", open);
    // A block ends at the next marker, `</style>`, or the first blank line
    // (the stage's blocks have none; the rules after one are the file's own).
    const blank = src.indexOf("\n\n", open);
    const end = Math.min(...[next, close, blank].filter((i) => i !== -1 && i > open));
    if (open !== -1 && close !== -1 && src.lastIndexOf("<style", at) !== -1 && src.lastIndexOf("<style", at) > src.lastIndexOf("</script>", at)) {
      out.push(src.slice(open + 2, end));
    }
    at = next;
  }
  return out;
}

describe("570 every Filament IV menu rule is gated, so Classic is unchanged", () => {
  for (const [name, src] of files) {
    it(`${name}: each selector in the stage's CSS starts with the gate`, () => {
      const blocks = stageBlock(src);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        // Drop comments, @keyframes bodies and the at-rule lines themselves.
        const css = b
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
          .replace(/@media[^{]*\{/g, "");
        const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
          .flatMap((m) => m[1].split(","))
          .map((s) => s.trim())
          .filter(Boolean);
        expect(selectors.length).toBeGreaterThan(0);
        for (const s of selectors) {
          // Classic-only hides (`.g-rule`, `.sub-head`, …) are display:none, ungated by design.
          if (/^\.(g-rule|g-n|sub-head|del-note)$/.test(s)) continue;
          expect(s.startsWith(GATE), `${name}: ${s}`).toBe(true);
        }
      }
    });
  }
});

describe("570 markup", () => {
  it("the new-chat page's box asks the mockup's question under Filament IV only", () => {
    expect(composer).toMatch(/floating && !classic\(\)\s*\? "What are we making\?"\s*: "Message…"/);
  });
  it("a two-line detail drops its leading dot under Filament IV only", () => {
    expect(composer).toMatch(/classic\(\) \? r\.detail : r\.detail\.replace\(/);
  });
  it("Delete rows are the red danger rows, still confirming (rowDelete, deletingThread)", () => {
    expect(sidebar).toMatch(/class="danger"[^>]*onclick=\{rowDelete\}>Delete…/);
    expect(sidebar).toMatch(/class="danger" onclick=\{\(\) => threadPick\(\(g\) => \(deletingThread = g\)\)\}>Delete thread…/);
  });
  it("the palette's headings carry their group's size", () => {
    expect(palette).toMatch(/<span class="g-n">\{groupSize\(i\)\}<\/span>/);
  });
});
