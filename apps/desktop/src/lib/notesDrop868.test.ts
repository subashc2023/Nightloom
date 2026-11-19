import { describe, expect, it, vi } from "vitest";
import { keepDropped, type KeepDeps } from "./notesDrop";
import type { KeepState } from "./keep";
import type { Attachment } from "./types";
import type { DropRows } from "./notesPending";

/*
 * Item 868 (his bug: a 184-slide deck landed in Notes as text): a deck too
 * long or too big for one PDF comes back from the converter as parts, part
 * 1 on the chip and parts 2..n as chips beside it. A drop on Notes keeps
 * every part, on the file's one row.
 */
function deps(rows?: DropRows) {
  const boxes: Record<string, Attachment[]> = {};
  const states: Record<string, KeepState> = {};
  const pdf = (id: number, name: string): Attachment => ({
    id,
    kind: "document",
    name,
    media_type: "application/pdf",
    data: `D${name}`,
    pages: 92,
  });
  const d: KeepDeps = {
    project: () => ({}),
    toast: vi.fn(),
    attach: vi.fn(async (key: string) => {
      boxes[key] = [pdf(1, "deck (part 1 of 2).pptx"), pdf(2, "deck (part 2 of 2).pptx")];
      return [boxes[key][0]];
    }),
    jobs: () => [],
    chips: (key) => boxes[key] ?? [],
    parts: (key, id) => (id === 1 ? (boxes[key] ?? []).filter((a) => a.id === 2) : []),
    state: (k) => states[k] ?? { phase: "idle" },
    forget: vi.fn((k: string) => void delete states[k]),
    keep: vi.fn(async (k: string) => void (states[k] = { phase: "kept", rel: "files/x" })),
    discard: vi.fn((key: string) => void delete boxes[key]),
    ...(rows ? { rows } : {}),
  };
  return d;
}

const names = (d: KeepDeps) => (d.keep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);

describe("a split deck dropped on Notes (item 868)", () => {
  it("keeps every part, on the file's one row", async () => {
    const rows: DropRows = { start: vi.fn((f: readonly { name: string; zip: boolean }[]) => f.map((_, i) => i + 10)), fail: vi.fn(), end: vi.fn() };
    const d = deps(rows);
    expect(await keepDropped([new File(["x"], "deck.pptx")], d)).toBe(2);
    expect(names(d)).toEqual(["deck (part 1 of 2).pptx", "deck (part 2 of 2).pptx"]);
    expect(rows.fail).not.toHaveBeenCalled();
    expect(rows.end).toHaveBeenCalledWith(10);
  });

  it("keeps every part without rows too", async () => {
    const d = deps();
    expect(await keepDropped([new File(["x"], "deck.pptx")], d)).toBe(2);
    expect(names(d)).toEqual(["deck (part 1 of 2).pptx", "deck (part 2 of 2).pptx"]);
  });
});
