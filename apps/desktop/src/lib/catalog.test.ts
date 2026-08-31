import { beforeEach, describe, expect, it } from "vitest";
import { defaultDraft, groupModels, loadLastConnection } from "./catalog";

const LAST_KEY = "nightloom.last-connection";

function ids(sections: ReturnType<typeof groupModels>): string[] {
  return sections.flatMap((s) => s.entries.map((e) => e.id));
}

describe("groupModels: folding dated snapshots", () => {
  it("collapses a family's snapshots onto the untagged id", () => {
    // Most of a fetched provider list is the same handful of models wearing
    // release dates. Left unfolded the dropdown is a wall of near-duplicates
    // and the id the user wants is buried among four copies of itself.
    const sections = groupModels([
      "claude-opus-5",
      "claude-opus-5-2026-01-15",
      "claude-opus-5-2025-11-01",
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].entries).toEqual([
      {
        id: "claude-opus-5",
        folded: ["claude-opus-5-2026-01-15", "claude-opus-5-2025-11-01"],
      },
    ]);
  });

  it("never synthesizes an untagged id that the provider did not list", () => {
    // A family whose only ids carry dates has no untagged form. Offering the
    // folded base as the chip would be a 404 the user finds out about a turn
    // later, so the newest real snapshot is offered instead.
    const sections = groupModels(["gemini-x-2025-01-01", "gemini-x-2026-01-01"]);
    expect(sections[0].entries).toEqual([
      { id: "gemini-x-2026-01-01", folded: ["gemini-x-2025-01-01"] },
    ]);
  });

  it("prefers a -latest alias over the newest date", () => {
    // `-latest` is the id that keeps working after the next release; picking a
    // date over it pins the user to a snapshot they never asked to pin.
    const sections = groupModels(["nova-2026-01-01", "nova-latest"]);
    expect(sections[0].entries[0].id).toBe("nova-latest");
  });

  it("does not read a parameter count as a release tag", () => {
    // `-405` is a size and `-002` is a revision, which is why the revision arm
    // demands a leading zero. Folding sizes away would merge models that are
    // genuinely different and hide the one the user picked.
    expect(ids(groupModels(["vendor-model", "vendor-model-405"]))).toEqual([
      "vendor-model",
      "vendor-model-405",
    ]);
    expect(ids(groupModels(["vendor-model", "vendor-model-002"]))).toEqual([
      "vendor-model",
    ]);
  });

  it("does not fold a name away to nothing", () => {
    // `some-vendor/2024-08-06` is all tag after its vendor path. Folding it
    // would leave a group keyed on a bare vendor prefix and an entry with no
    // name at all.
    const sections = groupModels(["some-vendor/2024-08-06"]);
    expect(sections[0].entries).toEqual([
      { id: "some-vendor/2024-08-06", folded: [] },
    ]);
  });

  it("returns nothing for an empty list", () => {
    // A provider whose list has not been fetched yet. The shaping runs on
    // every render, and `entries[0]` in the partitioner is not optional.
    expect(groupModels([])).toEqual([]);
  });
});

describe("groupModels: sectioning", () => {
  const alpha = ["a1", "a2", "a3", "a4", "a5", "a6"].map((s) => `alpha-${s}`);
  const beta = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((s) => `beta-${s}`);

  it("leaves a list at the flat cap as one unheaded section", () => {
    // A heading over three chips is noise. Twelve entries is the point where
    // splitting still costs more than it buys, so a curated provider list
    // stays one block.
    const sections = groupModels([...alpha, ...beta.slice(0, 6)]);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("");
    expect(sections[0].entries).toHaveLength(12);
  });

  it("splits one entry past the cap at the branching token", () => {
    // Thirteen is the first list long enough to be worth reading by family.
    // Off by one here means either a headed list of three or an unheaded wall
    // of three hundred.
    const sections = groupModels([...alpha, ...beta]);
    expect(sections.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(sections.map((s) => s.entries.length)).toEqual([6, 7]);
  });

  it("groups a vendor-pathed list by vendor and then by family", () => {
    // OpenRouter's shape. Recursion re-checks the cap, so depth follows how
    // crowded a branch is rather than being fixed — and the vendor path has to
    // stay one token or `anthropic/claude` rejoins as `anthropic-claude`.
    const sections = groupModels([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4",
      "anthropic/claude-haiku-3",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "openai/gpt-4-turbo",
    ]);
    expect(sections.map((s) => s.name)).toEqual([
      "anthropic/claude",
      "openai/gpt",
    ]);
  });

  it("collects one-model vendors into a single unheaded block", () => {
    // A heading identical to the one chip under it is pure repetition, and a
    // column of those is what makes a fetched list unreadable in the first
    // place.
    const twelve = Array.from({ length: 12 }, (_, i) => `alpha-m${i}`);
    const sections = groupModels([...twelve, "solo"]);
    expect(sections.map((s) => s.name)).toEqual(["alpha", ""]);
    expect(sections[1].entries.map((e) => e.id)).toEqual(["solo"]);
  });

  it("respects input order, which is where the curated ids come first", () => {
    // The settings pane assembles curated ids ahead of fetched ones. Sorting
    // alphabetically here would bury the hand-picked models the user has
    // actually verified.
    expect(ids(groupModels(["zeta", "alpha", "mid"]))).toEqual([
      "zeta",
      "alpha",
      "mid",
    ]);
  });
});

describe("loadLastConnection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Deliberately untyped: the point of these cases is what arrives from a
  // build that had different fields, or none.
  function save(draft: Record<string, unknown>): void {
    localStorage.setItem(LAST_KEY, JSON.stringify(draft));
  }

  it("reads an absent knob as on for the five that default on", () => {
    // A draft written before a switch existed has none of these fields. The
    // failure this prevents is a relaunch silently dropping the preamble, the
    // sidecar, the approval gate, the web tools and the vault at once — all
    // five turning off for everyone who had ever connected before the upgrade.
    save({ provider: "anthropic" });
    const d = loadLastConnection()!;
    expect({
      preamble: d.preamble,
      sidecar: d.sidecar,
      approval: d.approval,
      web: d.web,
      knowledge: d.knowledge,
    }).toEqual({
      preamble: true,
      sidecar: true,
      approval: true,
      web: true,
      knowledge: true,
    });
  });

  it("honours an explicit false on each of the five", () => {
    // The other half of `!== false`: a knob the user turned off has to stay
    // off, which is what stops the migration from being a reset.
    save({
      provider: "anthropic",
      preamble: false,
      sidecar: false,
      approval: false,
      web: false,
      knowledge: false,
    });
    const d = loadLastConnection()!;
    expect([d.preamble, d.sidecar, d.approval, d.web, d.knowledge]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("reads an absent selfCompact as off, the opposite of the other five", () => {
    // Deliberately inverted. This one used to ride on `tools`, so a draft
    // with no field is one written before there was a switch — exactly the
    // state the switch exists to get out of. Reading it as on would hand the
    // model the right to summarise away an afternoon of context unasked.
    save({ provider: "anthropic", tools: true });
    expect(loadLastConnection()!.selfCompact).toBe(false);
  });

  it("turns selfCompact on only for a literal true", () => {
    // `=== true`, not truthiness: a value of `1` or `"true"` from a hand-edited
    // or older payload must not be enough to enable it.
    save({ provider: "anthropic", selfCompact: true });
    expect(loadLastConnection()!.selfCompact).toBe(true);
    save({ provider: "anthropic", selfCompact: "true" });
    expect(loadLastConnection()!.selfCompact).toBe(false);
    save({ provider: "anthropic", selfCompact: 1 });
    expect(loadLastConnection()!.selfCompact).toBe(false);
  });

  it("reads the engine strictly, defaulting to provider", () => {
    // A stray value would land the rail on an engine with no controls
    // showing. A draft from before the agent engine has no field, and the
    // engine it was written on is the only one that existed.
    save({ provider: "anthropic" });
    expect(loadLastConnection()!.engine).toBe("provider");
    save({ provider: "anthropic", engine: "claude-code" });
    expect(loadLastConnection()!.engine).toBe("claude-code");
    save({ provider: "anthropic", engine: "gemini-cli" });
    expect(loadLastConnection()!.engine).toBe("provider");
  });

  it("keeps the fields a saved draft did carry", () => {
    // The migration defaults must not flatten the rest of the draft back to
    // its defaults — the point of saving one is to reconnect where you left
    // off.
    save({ provider: "groq", model: "openai/gpt-oss-120b", budget: 2048 });
    const d = loadLastConnection()!;
    expect([d.provider, d.model, d.budget]).toEqual([
      "groq",
      "openai/gpt-oss-120b",
      2048,
    ]);
    // and a field neither saved nor migrated still comes from the default
    expect(d.thinkingMode).toBe(defaultDraft().thinkingMode);
  });

  it("refuses a draft with no provider", () => {
    // `provider` is what everything else is interpreted against. A draft
    // without one would connect to whatever `defaultDraft` happens to name,
    // carrying a model id from a different vendor.
    save({ model: "claude-opus-5" });
    expect(loadLastConnection()).toBeNull();
    save({ provider: "" });
    expect(loadLastConnection()).toBeNull();
  });

  it("survives a stored value that is not a draft at all", () => {
    // Preferences are best-effort everywhere else in this file, and a
    // half-written or hand-edited entry must cost the preference rather than
    // the launch.
    localStorage.setItem(LAST_KEY, "{not json");
    expect(loadLastConnection()).toBeNull();
    localStorage.setItem(LAST_KEY, "42");
    expect(loadLastConnection()).toBeNull();
  });

  it("returns null when nothing was ever saved", () => {
    expect(loadLastConnection()).toBeNull();
  });
});
