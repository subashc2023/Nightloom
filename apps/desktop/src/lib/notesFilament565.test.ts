// Item 565 (Filament IV stage 8, Notes): Classic must not change. Each Notes
// file carries its Filament IV look as one block at the end of its style,
// and every rule in that block is behind the layout gate, except the base
// rules that hide Filament IV's added elements (which is what keeps Classic
// as it was).
import { describe, expect, it } from "vitest";
import notesPanel from "./NotesPanel.svelte?raw";
import noteView from "./NoteView.svelte?raw";
import noteToolbar from "./NoteToolbar.svelte?raw";
import noteEditor from "./NoteEditor.svelte?raw";
import graphView from "./GraphView.svelte?raw";
import searchPanel from "./SearchPanel.svelte?raw";

const GATE = ':global(:where(:root:not([data-layout="classic"])))';
const SOURCES: Record<string, string> = {
  NotesPanel: notesPanel,
  NoteView: noteView,
  NoteToolbar: noteToolbar,
  NoteEditor: noteEditor,
  GraphView: graphView,
  SearchPanel: searchPanel,
};
const FILES = Object.keys(SOURCES);
/** Base rules allowed outside the gate: they hide what Filament IV adds. */
const HIDERS = new Set([".lbl,", ".fiv {", ".ico {", ".facts {"]);

function block(name: string): string {
  const src = SOURCES[name];
  const style = src.slice(src.lastIndexOf("<style>"));
  const at = style.indexOf("Filament IV (item 565");
  expect(at, `${name} has its Filament IV block`).toBeGreaterThan(0);
  return style.slice(at, style.lastIndexOf("</style>"));
}

describe("item 565: the Notes look is gated, Classic untouched", () => {
  for (const name of FILES) {
    it(`${name}: every selector in the block is gated or a hider`, () => {
      const lines = block(name).split("\n");
      const selectors = lines
        .map((l) => l.trim())
        .filter((l) => /^[.:]/.test(l) && (l.endsWith("{") || l.endsWith(",")) && !l.startsWith("@") && !/^(from|to)\b/.test(l));
      expect(selectors.length).toBeGreaterThan(0);
      for (const s of selectors) {
        if (HIDERS.has(s)) continue;
        expect(s.startsWith(GATE), `${name}: ${s}`).toBe(true);
      }
    });
  }

  it("the hiders keep Filament IV's additions off Classic", () => {
    expect(block("NoteToolbar")).toMatch(/\.lbl,\s*\.fiv \{\s*display: none;/);
    expect(block("NoteView")).toMatch(/\.facts \{\s*display: none;/);
  });
});
