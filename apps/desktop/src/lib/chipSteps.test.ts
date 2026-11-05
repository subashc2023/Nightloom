import { describe, expect, it } from "vitest";
import { BoxHistory } from "./boxHistory";
import { chipStep, isChipTag, type ChipTag } from "./chipSteps";
import type { Attachment } from "./types";

// Item 458: attach and remove as steps of the box's history, in order with text edits.
const chip = (id: number, name = `f${id}.png`): Attachment =>
  ({ id, kind: "image", name, media_type: "image/png", data: "" }) as unknown as Attachment;

/** The composer's loop in small: text steps through `external`, chip steps through `mark`. */
class Box {
  hist = new BoxHistory("");
  text = "";
  chips: Attachment[] = [];
  type(t: string) {
    this.text += t;
    this.hist.external(this.text);
  }
  attach(c: Attachment) {
    this.chips = [...this.chips, c];
    this.hist.mark({ chipStep: "add", chip: c, index: this.chips.length - 1 } satisfies ChipTag);
  }
  remove(id: number) {
    const i = this.chips.findIndex((c) => c.id === id);
    const c = this.chips[i];
    this.chips = this.chips.filter((x) => x.id !== id);
    this.hist.mark({ chipStep: "remove", chip: c, index: i } satisfies ChipTag);
  }
  step(dir: "undo" | "redo") {
    const s = dir === "undo" ? this.hist.undo() : this.hist.redo();
    if (!s) return;
    if (isChipTag(s.tag)) this.chips = chipStep(s.tag, dir, this.chips).chips;
    this.text = s.text;
  }
  get ids() {
    return this.chips.map((c) => c.id);
  }
}

describe("chip steps (item 458)", () => {
  it("⌘Z takes an attach back, ⌘⇧Z brings it back", () => {
    const b = new Box();
    b.attach(chip(1));
    b.step("undo");
    expect(b.ids).toEqual([]);
    b.step("redo");
    expect(b.ids).toEqual([1]);
  });
  it("⌘Z restores a removed chip in its place", () => {
    const b = new Box();
    b.attach(chip(1));
    b.attach(chip(2));
    b.attach(chip(3));
    b.remove(2);
    expect(b.ids).toEqual([1, 3]);
    b.step("undo");
    expect(b.ids).toEqual([1, 2, 3]);
    b.step("redo");
    expect(b.ids).toEqual([1, 3]);
  });
  it("runs in order with text edits", () => {
    const b = new Box();
    b.type("look at ");
    b.attach(chip(1));
    b.type("this");
    b.remove(1);
    b.step("undo"); // the remove
    expect([b.text, b.ids]).toEqual(["look at this", [1]]);
    b.step("undo"); // "this"
    expect([b.text, b.ids]).toEqual(["look at ", [1]]);
    b.step("undo"); // the attach
    expect([b.text, b.ids]).toEqual(["look at ", []]);
    b.step("undo"); // "look at "
    expect([b.text, b.ids]).toEqual(["", []]);
    for (let i = 0; i < 4; i++) b.step("redo");
    expect([b.text, b.ids]).toEqual(["look at this", []]);
  });
  it("a new edit after an undo drops the redo, chip steps included", () => {
    const b = new Box();
    b.attach(chip(1));
    b.step("undo");
    b.type("x");
    b.step("redo");
    expect(b.ids).toEqual([]);
  });
  it("a chip that comes back is the one that left (a finished conversion stays finished)", () => {
    const b = new Box();
    b.attach(chip(1, "draft.pdf"));
    b.chips = [{ ...b.chips[0], name: "draft.pdf (converted)" } as Attachment];
    b.step("undo");
    b.step("redo");
    expect(b.chips[0].name).toBe("draft.pdf (converted)");
  });
  it("a step whose chip is already where it would go changes nothing", () => {
    const tag: ChipTag = { chipStep: "add", chip: chip(1), index: 0 };
    expect(chipStep(tag, "redo", [chip(1)]).chips.map((c) => c.id)).toEqual([1]);
    expect(chipStep(tag, "undo", []).chips).toEqual([]);
  });
});
