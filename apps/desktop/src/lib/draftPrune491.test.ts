import { describe, expect, it, vi } from "vitest";

// Item 491 follow-up: the draft copies a draft names are always kept; the
// prune is told every id the store holds, or not run when it cannot read it.

const pruneCalls: string[][] = [];
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  pruneDraftFiles: (keep: string[]) => {
    pruneCalls.push(keep);
    return Promise.resolve({ removed: 0, kept: keep.length, freed: 0 });
  },
}));

const { draftFileIdsIn, draftFileIds, drafts } = await import("./drafts.svelte");
const { pruneDraftCopies } = await import("./attachFiles.svelte");

const A = "a".repeat(64);
const B = "B".repeat(64);
const C = "c".repeat(64);

describe("the ids the drafts name", () => {
  it("finds a stash anywhere: box chips, queued chips, nested", () => {
    const raw = JSON.stringify({
      k1: { text: "hi", attachments: [{ name: "deck.pdf", stash: A }] },
      k2: { attachments: [], queue: [{ attachments: [{ stash: B }] }] },
    });
    expect(draftFileIdsIn(raw)?.sort()).toEqual([A, B.toLowerCase()].sort());
  });
  it("nothing stored is no ids; a value that will not parse is null (prune nothing)", () => {
    expect(draftFileIdsIn(null)).toEqual([]);
    expect(draftFileIdsIn("{not json")).toBeNull();
  });
  it("a stash that is not a SHA-256 is not an id", () => {
    expect(draftFileIdsIn(JSON.stringify({ k: { attachments: [{ stash: "../x" }] } }))).toEqual([]);
  });
  it("unions the saved drafts, the history ring and the drafts in memory", () => {
    const store = new Map<string, string>([
      ["nightloom.drafts", JSON.stringify({ k: { attachments: [{ stash: A }] } })],
      ["nightloom.draft-history", JSON.stringify([{ k: "k", s: { attachments: [{ stash: B }] } }])],
    ]);
    (drafts as Record<string, unknown>)["mem"] = { text: "", attachments: [{ id: 1, name: "x.pdf", stash: C }] };
    const ids = draftFileIds({ getItem: (k) => store.get(k) ?? null });
    expect(ids?.sort()).toEqual([A, B.toLowerCase(), C].sort());
    delete (drafts as Record<string, unknown>)["mem"];
  });
  it("an unreadable store gives null", () => {
    expect(draftFileIds({ getItem: (k) => (k === "nightloom.drafts" ? "{broken" : null) })).toBeNull();
    expect(
      draftFileIds({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBeNull();
    expect(draftFileIds(null)).toBeNull();
  });
});

describe("pruneDraftCopies", () => {
  it("runs once a launch with the ids the drafts name", async () => {
    (drafts as Record<string, unknown>)["mem"] = { text: "", attachments: [{ id: 2, name: "y.pdf", stash: A }] };
    await pruneDraftCopies();
    await pruneDraftCopies();
    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]).toContain(A);
    delete (drafts as Record<string, unknown>)["mem"];
  });
});
