import { describe, expect, it } from "vitest";
import { BUILT_IN_MODELS, addModel, modelsOr, moveModel, normalizeModels, pickerModels, removeModel } from "./modelList";
import { agentModels, modelList } from "./modelList.svelte";

describe("the model list (item 272)", () => {
  it("is the built-in aliases until a list arrives", () => {
    expect(BUILT_IN_MODELS).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(modelsOr(undefined)).toEqual(BUILT_IN_MODELS);
    expect(modelsOr([])).toEqual(BUILT_IN_MODELS);
    expect(normalizeModels([" ", ""])).toEqual(BUILT_IN_MODELS);
  });

  it("a model added to the file is offered in the pickers, without a build", () => {
    // The Mac: what `model_list_get` read lands in the state every picker
    // derives from.
    modelList.models = normalizeModels(["sonnet", " claude-fake-9 ", "sonnet"]);
    expect(agentModels()).toEqual(["", "sonnet", "claude-fake-9"]);
    // The phone: the host's rail carries the list.
    expect(modelsOr(["opus", "claude-fake-9"])).toContain("claude-fake-9");
    modelList.models = [...BUILT_IN_MODELS];
  });

  it("adds, removes and reorders", () => {
    const l = ["a", "b", "c"];
    expect(addModel(l, " d ")).toEqual(["a", "b", "c", "d"]);
    expect(addModel(l, "b")).toBe(l);
    expect(addModel(l, "  ")).toBe(l);
    expect(removeModel(l, "b")).toEqual(["a", "c"]);
    expect(removeModel(["a"], "a")).toEqual(["a"]);
    expect(moveModel(l, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveModel(l, "c", 1)).toBe(l);
    expect(pickerModels(["x"])).toEqual(["", "x"]);
  });
});
