import { describe, expect, it } from "vitest";
import {
  linkTitle,
  noteTarget,
  parseLinks,
  resolveLink,
  resolveNote,
} from "./links";
import type { Note } from "./types";

// `resolveNote` is the editor-side copy of `knowledge::resolve_link`. The
// backend's copy is what the graph and the model see; this one is what the
// note editor colours. Drift shows up as a link that is blue in the editor and
// broken in the graph, or the reverse — neither of which anything reports.

function vault(...names: string[]): Note[] {
  return names.map((name) => ({
    name,
    bytes: 0,
    modified: "2026-01-01T00:00:00Z",
    summary: null,
  }));
}

function nameOf(note: Note | null): string | null {
  return note?.name ?? null;
}

describe("noteTarget", () => {
  it("keeps the note name and drops the heading anchor", () => {
    // Mirrors `a_heading_anchor_is_kept_but_not_part_of_the_note_name`. Left
    // in, the anchor becomes part of the filename being looked up and every
    // deep link in the vault reads as broken.
    expect(noteTarget("rust/async#Cancellation")).toBe("rust/async");
  });

  it("leaves a name with no anchor untouched", () => {
    expect(noteTarget("rust/async")).toBe("rust/async");
  });
});

describe("resolveNote", () => {
  it("resolves a full relative path, with or without the extension", () => {
    // Mirrors `resolves_by_path_then_by_unique_basename`. Both spellings are
    // what people actually type; accepting only one makes half the links in a
    // vault written by hand look broken.
    const notes = vault("rust/async.md", "people/ada.md");
    expect(nameOf(resolveNote("rust/async", notes))).toBe("rust/async.md");
    expect(nameOf(resolveNote("rust/async.md", notes))).toBe("rust/async.md");
  });

  it("resolves a bare basename that is unique in the vault", () => {
    // The whole point of the Obsidian rule: a note is linkable by its name
    // from anywhere, so moving it between folders does not break its inbound
    // links.
    const notes = vault("rust/async.md", "people/ada.md");
    expect(nameOf(resolveNote("ada", notes))).toBe("people/ada.md");
  });

  it("reports a shared basename rather than picking one", () => {
    // Mirrors `two_notes_sharing_a_basename_are_reported_rather_than_picked`.
    // Resolving to the first match would make an existing link silently
    // change meaning the day someone adds a second note with that name.
    const notes = vault("a/notes.md", "b/notes.md");
    expect(resolveNote("notes", notes)).toBeNull();
    // The full path is still unambiguous.
    expect(nameOf(resolveNote("a/notes", notes))).toBe("a/notes.md");
  });

  it("prefers an exact path over an ambiguous basename", () => {
    // The two passes are ordered, not merged. Running the basename pass first
    // would turn a link to the vault-root `report.md` into an ambiguity,
    // because a second `report.md` exists in a folder.
    const notes = vault("archive/report.md", "report.md");
    expect(nameOf(resolveNote("report", notes))).toBe("report.md");
  });

  it("matches without regard to case", () => {
    // `eq_ignore_ascii_case` on the backend. A vault is a folder of files the
    // user named, and "Ada" in prose pointing at `ada.md` is the ordinary
    // case, not the exotic one.
    const notes = vault("people/Ada.md");
    expect(nameOf(resolveNote("PEOPLE/ada", notes))).toBe("people/Ada.md");
    expect(nameOf(resolveNote("ada", notes))).toBe("people/Ada.md");
  });

  it("folds ASCII case only, never the whole of Unicode", () => {
    // `eq_ignore_ascii_case` on the backend is ASCII by definition, and this
    // is its mirror: `toLowerCase()` folds É to é, so `[[café]]` would light
    // up blue in the editor while the graph and the model see a broken link
    // to a note nobody wrote. Mirrors have to agree on what "same name" is.
    expect(resolveNote("café", vault("CAFÉ.md"))).toBeNull();
    expect(nameOf(resolveNote("CAFÉ", vault("CAFÉ.md")))).toBe("CAFÉ.md");
    // The ASCII half of the same name still folds, on both sides.
    expect(nameOf(resolveNote("ADA", vault("people/ada.md")))).toBe(
      "people/ada.md",
    );
  });

  it("normalizes backslashes, a leading ./ and surrounding slashes", () => {
    // Note names always use `/`, but a target pasted from a Windows path or
    // written as a relative one does not. Each of these would otherwise fall
    // through to the basename pass, which is a different rule with a
    // different answer.
    const notes = vault("rust/async.md");
    expect(nameOf(resolveNote("rust\\async", notes))).toBe("rust/async.md");
    expect(nameOf(resolveNote("./rust/async", notes))).toBe("rust/async.md");
    expect(nameOf(resolveNote("/rust/async/", notes))).toBe("rust/async.md");
    expect(nameOf(resolveNote("  rust/async  ", notes))).toBe("rust/async.md");
  });

  it("strips a repeated ./ prefix, not only the first one", () => {
    // `normalize_target` uses `trim_start_matches("./")`, which takes every
    // repetition; stripping one leaves `./a/notes`, which misses the path
    // pass and falls through to the basename pass — a different rule with a
    // different answer. Here the backend resolves the link and the editor
    // renders it broken, which is exactly the drift these mirrors invite.
    const notes = vault("a/notes.md", "b/notes.md");
    expect(nameOf(resolveNote("././a/notes", notes))).toBe("a/notes.md");
  });

  it("resolves nothing for a target that is only an anchor", () => {
    // `normalize_target` splits on `#` unguarded, so `[[#todo]]` names no
    // note even in a vault holding `#todo.md`. `noteTarget` does guard —
    // it mirrors `Link::note_target`, whose job is what the UI displays — and
    // resolving through that guard makes the editor resolve a link the
    // backend reports missing.
    expect(resolveNote("#todo", vault("#todo.md"))).toBeNull();
    expect(resolveNote("#heading", vault("rust/async.md"))).toBeNull();
  });

  it("resolves nothing for an empty or whitespace-only target", () => {
    // `[[ ]]` and `[[#anchor]]` both normalize to nothing. An empty `wanted`
    // reaching the basename pass would match a note whose stem is "".
    const notes = vault("rust/async.md");
    expect(resolveNote("", notes)).toBeNull();
    expect(resolveNote("   ", notes)).toBeNull();
  });

  it("resolves nothing when the vault holds no such name", () => {
    // A planned note. It has to come back null rather than throw or match
    // loosely — writing `[[thing]]` before the note exists is how a note gets
    // planned, and the renderer styles that state.
    expect(resolveNote("nothing-here", vault("rust/async.md"))).toBeNull();
    expect(resolveNote("anything", vault())).toBeNull();
  });

  it("takes the extension off only the basename when matching a stem", () => {
    // `stem` splits at the last dot of the *basename*. Splitting the whole
    // path would make `v1.2/notes.md` stem to `v1`, and its links would stop
    // resolving the day a folder got a dot in its name.
    const notes = vault("v1.2/release.notes.md");
    expect(nameOf(resolveNote("release.notes", notes))).toBe(
      "v1.2/release.notes.md",
    );
  });
});

describe("resolveLink", () => {
  it("reports ambiguity as a state of its own, apart from missing", () => {
    // Mirrors `Resolution::Ambiguous`, which the backend reports rather than
    // picks. Collapsed into the same null as a missing note, every ambiguous
    // link got the renderer's "no such note yet" — a tooltip that is wrong in
    // the one way the reader cannot see past, because the note exists twice
    // and the fix is to name one by path, not to write it.
    const notes = vault("a/notes.md", "b/notes.md");
    const found = resolveLink("notes", notes);
    if (found.kind !== "ambiguous") {
      throw new Error(`expected ambiguity, got ${found.kind}`);
    }
    expect(found.notes.map((n) => n.name)).toEqual(["a/notes.md", "b/notes.md"]);
    // The other two states stay distinguishable from it and from each other.
    expect(resolveLink("ghost", notes)).toEqual({ kind: "missing" });
    expect(resolveLink("a/notes", notes)).toEqual({
      kind: "note",
      note: notes[0],
    });
  });
});

describe("linkTitle", () => {
  it("says the note exists twice, and that the fix is a path", () => {
    // The preview's tooltip, the outbound chip and the graph's unresolved
    // strip all describe the same condition, so they describe it with the
    // same sentence. Three wordings for one state is how a reader ends up
    // thinking they are three states.
    const notes = vault("a/notes.md", "b/notes.md");
    const title = linkTitle("notes", resolveLink("notes", notes));
    expect(title).toContain("more than one note has that name");
    expect(title).toContain("a/notes.md, b/notes.md");
    expect(title).toContain("link one by its path");
    // Not the missing wording: a note that exists twice does not need writing,
    // and the chip that offered to write a third is the bug this closes.
    expect(title).not.toContain("no such note");
  });

  it("names the note it found, and says when there is none yet", () => {
    const notes = vault("rust/async.md");
    expect(linkTitle("async", resolveLink("async", notes))).toBe(
      "rust/async.md",
    );
    expect(linkTitle("ghost", resolveLink("ghost", notes))).toBe(
      "ghost — no such note yet",
    );
  });
});

describe("parseLinks", () => {
  it("keeps the target and the alias apart", () => {
    // The outbound list resolves against the target; showing the alias there
    // would list a note name that does not exist.
    expect(parseLinks("see [[rust/async|the async note]]")).toEqual([
      { target: "rust/async", alias: "the async note" },
    ]);
  });

  it("lists each target once, in the order written", () => {
    // A note that mentions the same link three times has one outbound edge,
    // and the panel showing three rows for it is the bug.
    expect(parseLinks("[[a]] [[b]] [[a]]").map((l) => l.target)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not scan a fenced block for links", () => {
    // Mirrors `code_is_not_scanned_for_links`. A code sample containing
    // `[[x]]` is a code sample; listing it as an outbound link invents an edge
    // the backend's graph does not have.
    const src = "real [[kept]]\n\n```\n[[not-a-link]]\n```\n";
    expect(parseLinks(src).map((l) => l.target)).toEqual(["kept"]);
  });

  it("treats an unterminated bracket as ordinary text", () => {
    // Mirrors `an_unterminated_link_is_ordinary_text`. This runs over a note
    // as it is being typed, so every link is unterminated for a moment.
    expect(parseLinks("half written [[thing")).toEqual([]);
  });

  it("ignores an empty target and a bare alias", () => {
    // `[[|alias]]` names no note. Admitting it would put an unresolvable
    // empty entry in the outbound list.
    expect(parseLinks("[[]] [[|alias]] [[ ]]")).toEqual([]);
  });
});
