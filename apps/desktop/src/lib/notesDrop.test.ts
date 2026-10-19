import { describe, expect, it, vi } from "vitest";
import { Hold, SCRATCH_PREFIX, holdTitle, keepDropped, whyNoKeep, type KeepDeps } from "./notesDrop";
import { EDIT_DRAFT_PREFIX } from "./drafts.svelte";
import { keepKey, type KeepState } from "./keep";
import type { Attachment } from "./types";

const file = (name: string) => new File(["x"], name);

function deps(over: Partial<KeepDeps> = {}) {
  const boxes: Record<string, Attachment[]> = {};
  const states: Record<string, KeepState> = {};
  let id = 0;
  const d: KeepDeps = {
    project: () => ({}),
    toast: vi.fn(),
    attach: vi.fn(async (key: string, files: File[]) => {
      const made = files.map(
        (f): Attachment => ({ id: ++id, kind: "document", name: f.name, media_type: "application/pdf", data: `D${f.name}` }),
      );
      boxes[key] = made;
      return made;
    }),
    jobs: () => [],
    chips: (key) => boxes[key] ?? [],
    state: (k) => states[k] ?? { phase: "idle" },
    forget: vi.fn((k: string) => void delete states[k]),
    keep: vi.fn(async (k: string) => void (states[k] = { phase: "kept", rel: "files/x" })),
    discard: vi.fn((key: string) => void delete boxes[key]),
    ...over,
  };
  return { d, boxes, states };
}

describe("keepDropped (item 391)", () => {
  it("keeps each dropped file through Keep, one call per file, and drops the scratch box", async () => {
    const { d, boxes } = deps();
    const n = await keepDropped([file("a.pdf"), file("b.pdf")], d);
    expect(n).toBe(2);
    expect(d.keep).toHaveBeenCalledTimes(2);
    expect(d.keep).toHaveBeenNthCalledWith(1, keepKey("a.pdf", "Da.pdf"), "a.pdf", "application/pdf", { data: "Da.pdf" });
    expect(d.discard).toHaveBeenCalledTimes(1);
    expect(Object.keys(boxes)).toEqual([]);
  });

  it("uses a scratch key the drafts store never persists", async () => {
    const { d } = deps();
    await keepDropped([file("a.pdf")], d);
    const key = (d.attach as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(key.startsWith(SCRATCH_PREFIX)).toBe(true);
    expect(key.startsWith(EDIT_DRAFT_PREFIX)).toBe(true);
  });

  it("with no project, says why and keeps nothing", async () => {
    const { d } = deps({ project: () => null });
    expect(await keepDropped([file("a.pdf")], d)).toBe(0);
    expect(d.toast).toHaveBeenCalledWith(whyNoKeep(null));
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("in the unfiled holder, says why", async () => {
    const { d } = deps({ project: () => ({ unfiled: true }) });
    expect(await keepDropped([file("a.pdf")], d)).toBe(0);
    expect(d.toast).toHaveBeenCalledWith(whyNoKeep({ unfiled: true }));
  });

  it("a file the upload refuses is not kept (acceptFiles made no chip and toasted)", async () => {
    const { d } = deps({
      attach: vi.fn(async () => []),
    });
    expect(await keepDropped([file("big.bin")], d)).toBe(0);
    expect(d.keep).not.toHaveBeenCalled();
    expect(d.discard).toHaveBeenCalled();
  });

  it("waits for an office file's conversion and keeps the PDF it became", async () => {
    const boxes: Record<string, Attachment[]> = {};
    let finish: () => void = () => {};
    const job = new Promise<void>((r) => (finish = r));
    const { d } = deps({
      attach: vi.fn(async (key: string) => {
        const chip: Attachment = { id: 7, kind: "document", name: "deck.pptx", media_type: "application/pdf", data: "", pending: true };
        boxes[key] = [chip];
        setTimeout(() => {
          Object.assign(chip, { data: "PDF", pending: false });
          finish();
        }, 5);
        return [chip];
      }),
      jobs: () => [job],
      chips: (k) => boxes[k] ?? [],
    });
    expect(await keepDropped([file("deck.pptx")], d)).toBe(1);
    expect(d.keep).toHaveBeenCalledWith(keepKey("deck.pptx", "PDF"), "deck.pptx", "application/pdf", { data: "PDF" });
  });

  it("a failed conversion (chip removed) is not kept", async () => {
    const boxes: Record<string, Attachment[]> = {};
    const { d } = deps({
      attach: vi.fn(async (key: string) => {
        const chip: Attachment = { id: 8, kind: "document", name: "x.key", media_type: "application/pdf", data: "", pending: true };
        boxes[key] = [];
        return [chip];
      }),
      chips: (k) => boxes[k] ?? [],
    });
    expect(await keepDropped([file("x.key")], d)).toBe(0);
    expect(d.keep).not.toHaveBeenCalled();
  });

  it("a file kept earlier in this window is asked again (the backend answers 'already')", async () => {
    const { d, states } = deps();
    states[keepKey("a.pdf", "Da.pdf")] = { phase: "kept", rel: "files/a.pdf" };
    expect(await keepDropped([file("a.pdf")], d)).toBe(1);
    expect(d.forget).toHaveBeenCalledWith(keepKey("a.pdf", "Da.pdf"));
    expect(d.keep).toHaveBeenCalledTimes(1);
  });

  it("a file being kept right now is named, not kept twice", async () => {
    const { d, states } = deps();
    states[keepKey("a.pdf", "Da.pdf")] = { phase: "keeping" };
    expect(await keepDropped([file("a.pdf")], d)).toBe(0);
    expect(d.toast).toHaveBeenCalledWith("a.pdf is being kept already");
  });

  it("drops the scratch box even when attaching throws", async () => {
    const { d } = deps({
      attach: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(keepDropped([file("a.pdf")], d)).rejects.toThrow("boom");
    expect(d.discard).toHaveBeenCalled();
  });
});

describe("hold words", () => {
  it("names the target, or why there is none", () => {
    expect(holdTitle({})).toBe("Drop to keep in this project");
    expect(holdTitle(null)).toBe("No project to keep files in");
    expect(whyNoKeep({})).toBeNull();
  });
});

describe("Hold", () => {
  it("is held between enter and the matching leave, through children", () => {
    const h = new Hold();
    h.enter(0);
    h.enter(10);
    h.leave();
    expect(h.held(20)).toBe(true);
    h.leave();
    expect(h.held(30)).toBe(false);
  });
  it("lapses when dragover stops (a drag that left without saying so)", () => {
    const h = new Hold(1500);
    h.enter(0);
    h.over(100);
    expect(h.held(1500)).toBe(true);
    expect(h.held(1700)).toBe(false);
  });
  it("ends at the drop", () => {
    const h = new Hold();
    h.enter(0);
    h.end();
    expect(h.held(1)).toBe(false);
  });
});
