// @vitest-environment happy-dom
/* Item 974: a digit focuses button n of a button card; Enter (the browser's own, on a focused button) presses it. */
import { describe, expect, it } from "vitest";
import { keyPicks } from "./cardKeys";

function card(html: string) {
  const node = document.createElement("div");
  node.tabIndex = -1;
  node.innerHTML = html;
  document.body.appendChild(node);
  const act = keyPicks(node, {});
  return { node, act };
}
const key = (t: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  t.dispatchEvent(e);
  return e;
};

describe("keyPicks (item 974)", () => {
  it("2 focuses the second button, skipping a disabled one; nothing is pressed", () => {
    const { node } = card('<button data-pick id="a">Allow</button><button data-pick disabled>x</button><button data-pick id="d">Deny</button><button>Other</button>');
    let pressed = 0;
    node.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => pressed++));
    node.focus();
    const e = key(node, "2");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("d");
    expect(pressed).toBe(0);
    expect(node.hasAttribute("data-keycard")).toBe(true);
  });
  it("a digit typed in a field stays in the field", () => {
    const { node } = card('<input type="text" id="t"><button data-pick id="a">Allow</button>');
    const t = node.querySelector("#t") as HTMLInputElement;
    t.focus();
    const e = key(t, "1");
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(t);
  });
  it("a digit past the buttons does nothing", () => {
    const { node } = card('<button data-pick id="a">Allow</button>');
    node.focus();
    expect(key(node, "5").defaultPrevented).toBe(false);
  });
  it("scope: a key in a row reaches that row's answers only", () => {
    const node = document.createElement("div");
    node.innerHTML = '<div class="row" id="r1"><button class="answer" id="x1">A</button></div><div class="row" id="r2" tabindex="-1"><button class="answer" id="y1">B</button><button class="answer" id="y2">C</button></div>';
    document.body.appendChild(node);
    keyPicks(node, { scope: ".row", pick: ".answer" });
    const r2 = node.querySelector("#r2") as HTMLElement;
    r2.focus();
    key(r2, "2");
    expect(document.activeElement?.id).toBe("y2");
    expect((node.querySelector("#y2") as HTMLElement).dataset.kh).toBe("2");
    expect((node.querySelector("#x1") as HTMLElement).dataset.kh).toBeUndefined();
  });
});
