// Item 871, second pass: a kept draft whose note was deleted is reachable —
// listed as a recovered draft (from the launch toast's Show and from a row
// at the top of Notes), opened in the editor where Save puts it back under
// its old name (870's check refuses to write over a file that appeared),
// and dropped only by a confirmed Discard.
import { describe, expect, it } from "vitest";
import { recoveredDrafts } from "./recoveredDrafts";
import appSrc from "../App.svelte?raw";
import panelSrc from "./NotesPanel.svelte?raw";
import listSrc from "./RecoveredDrafts.svelte?raw";
import stateSrc from "./state.svelte?raw";

const notes = (...names: string[]) => names.map((name) => ({ name }));

describe("871: recovered drafts", () => {
  const drafts = {
    "p1:project:plan.md": "draft of a note still there",
    "p1:project:old/gone.md": "draft of a deleted note",
    "knowledge:people/ana.md": "vault draft, note deleted",
    "knowledge:kept.md": "vault draft, note there",
    "p2:project:other.md": "another project's draft — its list is not read here",
    "p1:instructions:AGENTS.md": "a one-file scope always has its file",
  };
  it("lists exactly the drafts whose note is not in a whole, read listing", () => {
    const r = recoveredDrafts(drafts, {
      projectId: "p1",
      notes: notes("plan.md"),
      vault: notes("kept.md"),
      listed: { project: "p1", knowledge: true },
      complete: { project: true, knowledge: true },
    });
    expect(r.map((d) => [d.scope, d.name])).toEqual([
      ["project", "old/gone.md"],
      ["knowledge", "people/ana.md"],
    ]);
    expect(r[0].text).toBe("draft of a deleted note");
    expect(r[0].key).toBe("p1:project:old/gone.md");
  });
  it("before the lists are read, or when a list was cut, nothing is called missing", () => {
    const base = { projectId: "p1", notes: [], vault: [] };
    expect(recoveredDrafts(drafts, { ...base, listed: { project: null, knowledge: false }, complete: { project: true, knowledge: true } })).toEqual([]);
    expect(
      recoveredDrafts(drafts, { ...base, listed: { project: "p1", knowledge: true }, complete: { project: false, knowledge: false } }),
    ).toEqual([]);
  });
  it("is reachable: the toast's Show, the Notes row, the list mounted in the app; Discard confirms", () => {
    expect(stateSrc).toMatch(/label: "Show"/);
    expect(panelSrc).toContain("recovered draft");
    expect(appSrc).toContain("<RecoveredDrafts");
    expect(listSrc).toContain("<ConfirmDialog");
    expect(listSrc).toContain("showNote(");
  });
});
