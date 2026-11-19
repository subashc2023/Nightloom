// Item 855: a file dropped into Notes shows at once as a pending row,
// which goes when its note is kept (the note takes its place) or turns into
// an error row with the reason.
import { describe, expect, it, vi } from "vitest";
import { keepDropped, type KeepDeps } from "./notesDrop";
import {
  addRows,
  dismissRow,
  endRow,
  failRow,
  placeRows,
  rowWords,
  type DropRows,
  type PendingNote,
} from "./notesPending";
import type { KeepState } from "./keep";
import type { Attachment } from "./types";

const file = (name: string) => new File(["x"], name);

/** Rows as the panel's store keeps them, with every state they passed through. */
function rowsBox() {
  let list: PendingNote[] = [];
  let seq = 0;
  const seen: string[] = [];
  const log = () => seen.push(list.map((r) => `${r.name}:${r.phase}`).join(","));
  const rows: DropRows = {
    start(files) {
      const r = addRows(list, "/p", "files", files, () => ++seq);
      list = r.list;
      log();
      return r.ids;
    },
    fail(id, why) {
      list = failRow(list, id, why);
      log();
    },
    end(id) {
      list = endRow(list, id);
      log();
    },
  };
  return { rows, now: () => list, seen };
}

/** A drop's deps: `.pptx` files convert behind a pending chip, resolved by
 *  `convert` (a failure removes the chip and says why, as `attachOffice`). */
function deps(over: Partial<KeepDeps> = {}) {
  const boxes: Record<string, Attachment[]> = {};
  const states: Record<string, KeepState> = {};
  const jobs: Promise<void>[] = [];
  const convert: Record<string, (ok: boolean) => void> = {};
  let id = 0;
  const d: KeepDeps = {
    project: () => ({}),
    toast: vi.fn(),
    attach: vi.fn(async (key: string, files: File[], toast?: (t: string) => void) => {
      const made: Attachment[] = [];
      for (const f of files) {
        if (f.name.endsWith(".exe")) {
          toast?.(`${f.name} is not a file Notes can keep`);
          continue;
        }
        const office = f.name.endsWith(".pptx");
        const chip: Attachment = {
          id: ++id,
          kind: "document",
          name: f.name,
          media_type: "application/pdf",
          data: office ? "" : `D${f.name}`,
          ...(office ? { pending: true } : {}),
        };
        (boxes[key] ??= []).push(chip);
        made.push(chip);
        if (office) {
          jobs.push(
            new Promise<void>((done) => {
              convert[f.name] = (ok) => {
                const box = boxes[key];
                const i = box.findIndex((c) => c.id === chip.id);
                if (ok) box[i] = { ...chip, pending: false, data: `PDF${f.name}` };
                else {
                  box.splice(i, 1);
                  toast?.(`${f.name}: LibreOffice could not read it`);
                }
                done();
              };
            }),
          );
        }
      }
      return made;
    }),
    jobs: () => jobs,
    chips: (key) => boxes[key] ?? [],
    state: (k) => states[k] ?? { phase: "idle" },
    forget: vi.fn((k: string) => void delete states[k]),
    keep: vi.fn(async () => undefined),
    discard: vi.fn((key: string) => void delete boxes[key]),
    ...over,
  };
  return { d, convert };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("item 855: pending rows for a drop into Notes", () => {
  it("pending → done: a row per file at once, each gone once its note is kept", async () => {
    const box = rowsBox();
    const { d, convert } = deps({ rows: box.rows });
    const run = keepDropped([file("deck.pptx"), file("notes.txt")], d);
    await tick();
    // Both rows show while the deck converts; nothing is kept yet.
    expect(box.seen[0]).toBe("deck.pptx:adding,notes.txt:adding");
    expect(box.now().map((r) => r.phase)).toEqual(["adding", "adding"]);
    expect(d.keep).not.toHaveBeenCalled();
    convert["deck.pptx"](true);
    expect(await run).toBe(2);
    expect(d.keep).toHaveBeenCalledTimes(2);
    expect(box.now()).toEqual([]);
    // The deck's row went after its own keep, before the text file's.
    expect(box.seen).toContain("notes.txt:adding");
    expect(d.toast).not.toHaveBeenCalled();
  });

  it("pending → error: a failed conversion turns its row into an error row with the reason", async () => {
    const box = rowsBox();
    const { d, convert } = deps({ rows: box.rows });
    const run = keepDropped([file("deck.pptx"), file("a.txt")], d);
    await tick();
    convert["deck.pptx"](false);
    expect(await run).toBe(1);
    expect(box.now()).toHaveLength(1);
    expect(box.now()[0]).toMatchObject({ name: "deck.pptx", phase: "failed", why: "deck.pptx: LibreOffice could not read it" });
    // Its words are on the row, not in a toast as well.
    expect(d.toast).not.toHaveBeenCalled();
  });

  it("pending → error: a refused file and a keep that fails say why on their rows", async () => {
    const box = rowsBox();
    const { d } = deps({
      rows: box.rows,
      keep: vi.fn(async (_k: string, name: string) => (name === "b.pdf" ? "Could not keep b.pdf: disk full" : undefined)),
    });
    expect(await keepDropped([file("x.exe"), file("a.pdf"), file("b.pdf")], d)).toBe(2);
    expect(box.now().map((r) => [r.name, r.phase, r.why])).toEqual([
      ["x.exe", "failed", "x.exe is not a file Notes can keep"],
      ["b.pdf", "failed", "Could not keep b.pdf: disk full"],
    ]);
  });

  it("a drop that throws leaves no row saying adding — each turns into an error row", async () => {
    const box = rowsBox();
    const { d } = deps({
      rows: box.rows,
      attach: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(keepDropped([file("a.pdf")], d)).rejects.toThrow("boom");
    expect(box.now()).toEqual([expect.objectContaining({ phase: "failed", why: "Stopped before it was kept: Error: boom" })]);
  });

  it("no project: no rows, the refusal toasts as before", async () => {
    const box = rowsBox();
    const { d } = deps({ rows: box.rows, project: () => null });
    expect(await keepDropped([file("a.pdf")], d)).toBe(0);
    expect(box.seen).toEqual([]);
    expect(d.toast).toHaveBeenCalledTimes(1);
  });

  it("a zip gets one row, an error row when it cannot be opened", async () => {
    const box = rowsBox();
    const { d } = deps({
      rows: box.rows,
      zip: {
        read: async () => "",
        unpack: async () => {
          throw new Error("not a zip");
        },
        keepAt: async () => ({ rel: "", already: false }),
        kept: async () => {},
      },
    });
    expect(await keepDropped([file("pack.zip")], d)).toBe(0);
    expect(box.now()).toEqual([
      expect.objectContaining({ name: "pack.zip", zip: true, phase: "failed", why: "Could not open pack.zip: Error: not a zip" }),
    ]);
  });
});

describe("item 855: the rows' pure moves", () => {
  const r = (over: Partial<PendingNote>): PendingNote => ({
    id: 1,
    project: "/p",
    folder: "files",
    name: "a.pdf",
    zip: false,
    phase: "adding",
    ...over,
  });

  it("end removes an adding row, keeps a failed one; dismiss removes either", () => {
    expect(endRow([r({})], 1)).toEqual([]);
    const failed = failRow([r({})], 1, "nope");
    expect(endRow(failed, 1)).toEqual(failed);
    expect(dismissRow(failed, 1)).toEqual([]);
  });

  it("rows show under their folder when it is in view, else at the top", () => {
    const at = placeRows([r({ id: 1 }), r({ id: 2, folder: "files/new" })], new Set(["files"]));
    expect(at.get("files")?.map((x) => x.id)).toEqual([1]);
    expect(at.get("")?.map((x) => x.id)).toEqual([2]);
  });

  it("words: where it is going, or why it failed", () => {
    expect(rowWords(r({}))).toBe("adding to files/…");
    expect(rowWords(r({ zip: true }))).toBe("unpacking into files/…");
    expect(rowWords(r({ phase: "failed", why: "too large" }))).toBe("too large");
    expect(rowWords(r({ phase: "failed", why: "a.pdf: damaged" }))).toBe("damaged");
  });
});
