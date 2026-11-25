// @vitest-environment happy-dom
/* Item 974: the question card's host forwards a key that reached its box — a digit picks the active
   question's option, Enter asks the host to send. */
import { describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AskQuestions from "./AskQuestions.svelte";

describe("AskQuestions.hostKey (item 974)", () => {
  it("2 picks the second option; Enter calls onenter", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const ontoggle = vi.fn();
    const onenter = vi.fn();
    const c = mount(AskQuestions, {
      target,
      props: {
        questions: [{ question: "Which?", header: "pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
        idBase: "t",
        picks: {},
        others: {},
        ontoggle,
        onother: () => {},
        onenter,
      },
    }) as unknown as { hostKey(e: KeyboardEvent): boolean };
    flushSync();
    expect(target.querySelector("[data-keycard]")).not.toBeNull();
    const d = new KeyboardEvent("keydown", { key: "2", cancelable: true });
    Object.defineProperty(d, "target", { value: target });
    expect(c.hostKey(d)).toBe(true);
    expect(ontoggle).toHaveBeenCalledWith(0, "B", false);
    const en = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    Object.defineProperty(en, "target", { value: target });
    c.hostKey(en);
    expect(onenter).toHaveBeenCalledTimes(1);
    const x = new KeyboardEvent("keydown", { key: "7", cancelable: true });
    Object.defineProperty(x, "target", { value: target });
    expect(c.hostKey(x)).toBe(false);
    unmount(c as never);
  });
});
