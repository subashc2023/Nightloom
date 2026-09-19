import { beforeEach, describe, expect, it, vi } from "vitest";

// The proposal path must never write the file itself: loading a proposal is
// a draft, and only the editor's ordinary Save reaches `save_note`. The api
// module is stubbed so a stray call would be a failure here rather than a
// write on someone's disk.
vi.mock("./api", async (original) => {
  const real = await original<typeof import("./api")>();
  return {
    ...real,
    saveNote: vi.fn(),
    markApplied: vi.fn(),
    dismissProposal: vi.fn(),
    listProposals: vi.fn(async () => []),
  };
});

import * as api from "./api";
import {
  app,
  mirrorDraft,
  noteDraftKey,
  reviewProposal,
  stageProposal,
  unstageProposal,
} from "./state.svelte";
import type { ProposalEntry } from "./types";

// The project's `AGENTS.md` is keyed by the project (backlog 133); with
// none open the key says so.
const KEY = "unfiled:instructions:AGENTS.md";
const SAVED = "# Lanternfish\n\nUse cargo.\n";

function entry(text: string, id = "2026-09-14T03-12-45.000Z"): ProposalEntry {
  return {
    id,
    proposal: {
      v: 1,
      at: "2026-09-14T03:12:45Z",
      target: { kind: "project", id: "abc", name: "Lanternfish" },
      why: "Observation 1 says tokio.",
      text,
      from_dream: true,
    },
  };
}

beforeEach(() => {
  app.noteDrafts = {};
  app.stagedProposal = null;
  app.proposalReview = null;
  app.proposals = { instructions: [], memory: [] };
  vi.mocked(api.saveNote).mockClear();
});

describe("a loaded proposal is a draft", () => {
  it("stages the proposed text as a draft under the file's key and writes nothing", () => {
    const e = entry("# Lanternfish\n\nUse cargo and tokio.\n");
    app.proposals.instructions = [e];
    reviewProposal("instructions");
    expect(app.proposalReview?.entry).toBe(e);
    expect(app.openNote).toEqual({ scope: "instructions", name: "AGENTS.md" });

    stageProposal("instructions", e, SAVED);
    // The draft is where unsaved text lives; the editor reads it from here.
    expect(app.noteDrafts[KEY]).toBe(e.proposal.text);
    expect(app.stagedProposal).toEqual({ key: KEY, scope: "instructions", id: e.id });
    // The review is over; the editor is showing.
    expect(app.proposalReview).toBeNull();
    // And the file was not written by any of it.
    expect(api.saveNote).not.toHaveBeenCalled();
  });

  it("Revert restores the saved text and forgets the proposal", () => {
    const e = entry("proposed\n");
    stageProposal("instructions", e, SAVED);
    expect(app.noteDrafts[KEY]).toBe("proposed\n");

    // What the editor's Revert does: buffer back to saved, then the mirror
    // rule runs on the next tick and the draft entry goes with it.
    mirrorDraft(KEY, SAVED, SAVED);
    unstageProposal(KEY);
    expect(app.noteDrafts[KEY]).toBeUndefined();
    expect(app.stagedProposal).toBeNull();
    expect(api.saveNote).not.toHaveBeenCalled();
  });

  it("an edit to the loaded draft stays a draft of the same proposal", () => {
    const e = entry("proposed\n");
    stageProposal("instructions", e, SAVED);
    mirrorDraft(KEY, "proposed, then edited\n", SAVED);
    expect(app.noteDrafts[KEY]).toBe("proposed, then edited\n");
    expect(app.stagedProposal?.id).toBe(e.id);
  });

  it("opening another note leaves the review; a proposal for another scope is not shown", () => {
    const e = entry("x\n");
    app.proposals.memory = [e];
    reviewProposal("memory");
    expect(app.proposalReview?.scope).toBe("memory");
    reviewProposal("instructions");
    // Nothing pending for instructions: the call is a no-op and the memory
    // review is still the one showing.
    expect(app.proposalReview?.scope).toBe("memory");
  });
});

describe("a staged proposal belongs to its project (backlog 133)", () => {
  it("does not come back as another project's draft after a switch, and is not marked applied there", () => {
    app.project = { id: "A", name: "A", root: "/tmp/a" } as never;
    const e = entry("# A's instructions\n");
    stageProposal("instructions", e, SAVED);
    const aKey = noteDraftKey("instructions", "AGENTS.md");
    expect(aKey).toBe("A:instructions:AGENTS.md");
    expect(app.noteDrafts[aKey]).toBe(e.proposal.text);
    // The bell opens project B's proposal: B's editor reads under B's key.
    app.project = { id: "B", name: "B", root: "/tmp/b" } as never;
    const bKey = noteDraftKey("instructions", "AGENTS.md");
    expect(bKey).toBe("B:instructions:AGENTS.md");
    expect(app.noteDrafts[bKey]).toBeUndefined();
    expect(app.stagedProposal?.key).toBe(aKey);
    expect(app.stagedProposal?.key).not.toBe(bKey);
    // Back in A, the draft is still there.
    app.project = { id: "A", name: "A", root: "/tmp/a" } as never;
    expect(app.noteDrafts[noteDraftKey("instructions", "AGENTS.md")]).toBe(e.proposal.text);
    // The vault's file is one for every project: no project in its key.
    expect(noteDraftKey("memory", "AGENTS.md")).toBe("memory:AGENTS.md");
    expect(noteDraftKey("knowledge", "x.md")).toBe("knowledge:x.md");
    expect(noteDraftKey("project", "notes/a.md")).toBe("A:project:notes/a.md");
    app.project = null;
  });
});
