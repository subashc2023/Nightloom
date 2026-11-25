// @vitest-environment happy-dom
/*
 * Item 927 (his words, 2026-11-23: "clicking outside the box thing should be the same as clicking cancel"):
 * a click on a dialog's scrim is its Cancel; a click inside the box, or a drag that starts inside and ends on
 * the scrim, is not. And every scrim dialog of the kind uses the action (the class rule).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { scrimClose } from "./scrimClose";

function setup() {
  const scrim = document.createElement("div");
  const box = document.createElement("div");
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  const close = vi.fn();
  const act = scrimClose(scrim, close);
  return { scrim, box, close, act };
}
function press(down: Element, up: Element) {
  down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  up.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("scrimClose (item 927)", () => {
  it("a click on the scrim closes", () => {
    const { scrim, close } = setup();
    press(scrim, scrim);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("a click inside the box does not", () => {
    const { box, close } = setup();
    press(box, box);
    expect(close).not.toHaveBeenCalled();
  });
  it("a drag from inside the box that ends on the scrim does not", () => {
    const { scrim, box, close } = setup();
    press(box, scrim);
    expect(close).not.toHaveBeenCalled();
  });
  it("follows an updated handler and stops after destroy", () => {
    const { scrim, close, act } = setup();
    const next = vi.fn();
    act.update(next);
    press(scrim, scrim);
    expect(next).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    act.destroy();
    press(scrim, scrim);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("every scrim dialog with a Cancel or Close uses it", () => {
    // The dom environment resolves `import.meta.url` against its page; vitest runs from apps/desktop.
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const here = (f: string) => readFileSync(`${cwd}/src/lib/${f}`, "utf8");
    for (const f of [
      "WrapAsidesDialog.svelte",
      "ConfirmDialog.svelte",
      "DisableDialog.svelte",
      "RevertDialog.svelte",
      "FeedbackBox.svelte",
      "AttachmentLayer.svelte",
      "ReviewBlockers.svelte",
      "NotesPanel.svelte",
      "InboxSortSheet.svelte",
    ]) {
      expect(here(f), f).toContain("use:scrimClose=");
    }
    expect(here("WrapAsidesDialog.svelte")).toContain("use:scrimClose={cancelWrapPick}");
  });
});
