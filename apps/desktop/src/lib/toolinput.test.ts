import { describe, expect, it } from "vitest";
import { inputFields } from "./toolinput";

describe("inputFields (the approval card)", () => {
  it("puts each item of a list of objects on its own line (backlog 353 review)", () => {
    // Claude in Chrome's browser_batch: a run of actions the card must let
    // him read one by one, not one wrapped line of escaped JSON.
    const actions = [
      { name: "navigate", input: { url: "https://example.com" } },
      { name: "computer", input: { action: "left_click", coordinate: [10, 20] } },
    ];
    const [f] = inputFields({ actions });
    expect(f.key).toBe("actions");
    expect(f.value.split("\n")).toEqual([
      "[",
      '  {"name":"navigate","input":{"url":"https://example.com"}},',
      '  {"name":"computer","input":{"action":"left_click","coordinate":[10,20]}}',
      "]",
    ]);
    expect(JSON.parse(f.value)).toEqual(actions);
  });

  it("keeps strings verbatim and everything else on one line", () => {
    const fields = inputFields({ action: "left_click", coordinate: [10, 20], text: "a\nb", one: [{ a: 1 }] });
    expect(fields).toEqual([
      { key: "action", value: "left_click" },
      { key: "coordinate", value: "[10,20]" },
      { key: "text", value: "a\nb" },
      { key: "one", value: '[{"a":1}]' },
    ]);
  });
});
