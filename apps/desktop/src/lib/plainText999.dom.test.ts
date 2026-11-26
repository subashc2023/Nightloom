// @vitest-environment happy-dom
/*
 * Item 999 (the 991 family; the verify sweep's finding 6): one-line text built from a message showed the
 * reply's Markdown marks raw — a search snippet "…the **sampling…", a navigator rib's name "Go to the reply:
 * You picked **Blue**". Drawn and read back from the DOM where a component draws it (item 980's rule).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The panel asks the backend for its answer (debounced); the answer here is the backend's shape, raw marks and all.
const searchAnswer: { r: unknown } = { r: null };
vi.mock("./api", async (orig) => ({ ...((await orig()) as object), searchEverywhere: async () => searchAnswer.r }));
import { flushSync, mount, unmount } from "svelte";
import "./asides.svelte";
import { app } from "./state.svelte";
import SearchPanel from "./SearchPanel.svelte";
import Navigator from "./Navigator.svelte";
import { ticks } from "./navigator";
import { plainFragment, plainOneLine } from "./plainMd";
import { chatLabel, nameLine } from "./chatLabel";
import { asideLabel } from "./asides";
import type { SearchResult, SessionEvent } from "./types";
import { stepsOf } from "./homeStage/steps";

let root: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
});

describe("plainFragment: a piece of a message cut anywhere", () => {
  it("drops a bold pair split by the hit, keeps the joining spaces", () => {
    expect(plainFragment("…distribution is called the **")).toBe("…distribution is called the ");
    expect(plainFragment("** of the mean, and `x_bar` is it… ")).toBe(" of the mean, and x_bar is it… ");
  });
  it("drops link targets, headings, strikes and word-edge emphasis, and leaves prose alone", () => {
    expect(plainFragment("see [the notes](https://x.y/z) ## Mail ~~old~~ *now*")).toBe("see the notes Mail old now");
    expect(plainFragment("2 * 3 = 6, snake_case and __init__.py")).toBe("2 * 3 = 6, snake_case and __init__.py");
    expect(plainFragment("")).toBe("");
  });
});

describe("plainOneLine: a whole message on one line", () => {
  it("drops marks and the chat's tags", () => {
    expect(plainOneLine("You picked **Blue**.\n\n<ask>\nNext?\n- A\n</ask>")).toBe("You picked Blue. Next? • A");
  });
});

describe("the search panel's snippets", () => {
  it("draw the words around the hit without the reply's marks", async () => {
    const result: SearchResult = {
      matches: 2,
      messages: 2,
      chats: 1,
      shown: 2,
      elapsed_ms: 3,
      notes: [],
      groups: [
        {
          id: "c1",
          path: "/tmp/c1.jsonl",
          modified: "2026-11-25T23:00:00Z",
          user_turns: 2,
          first_user: "Lab 4",
          title: "Lab 4 **sampling**",
          hits: 2,
          rows: [
            { index: 3, who: "fable", at: "2026-11-25T23:00:00Z", before: "…distribution is called the **", matched: "sampling", after: " distribution**, and `x̄` is it…", matches: 1 },
            { index: 5, who: "you", at: "2026-11-25T23:00:00Z", before: "", matched: "Sampling", after: " _again_", matches: 1 },
          ],
        } as never,
      ],
    };
    app.search.open = true;
    app.search.query = "sampling";
    app.search.scope = "this";
    app.search.result = null;
    searchAnswer.r = result;
    root = mount(SearchPanel, { target: document.body });
    await vi.waitFor(() => expect(document.body.querySelector(".search-hit:not(.skel)")).not.toBeNull(), { timeout: 2000 });
    flushSync();
    const passes = [...document.body.querySelectorAll(".search-hit .pass")].map((p) => p.textContent);
    expect(passes).toEqual(["…distribution is called the sampling distribution, and x̄ is it…", "Sampling again"]);
    expect(document.body.querySelector(".search-hit .pass mark")?.textContent).toBe("sampling");
    for (const p of passes) expect(p).not.toMatch(/\*|`|_/);
    expect(document.body.querySelector(".search-gh .gt")?.textContent).toBe("Lab 4 sampling");
  });
});

describe("the navigator's ribs", () => {
  it("name and preview a message by its words, not its marks", () => {
    const events = [
      { event: "user_message", text: "Pick a **colour**", at: "a" },
      { event: "assistant_message", blocks: [{ type: "text", text: "You picked **Blue**." }], at: "b" },
      { event: "user_message", text: "and `red`?", at: "c" },
      { event: "assistant_message", blocks: [{ type: "text", text: "## Red\n- *also* fine" }], at: "d" },
    ] as SessionEvent[];
    const t = ticks(events, events.map(() => true));
    root = mount(Navigator, { target: document.body, props: { ticks: t, active: null, viewport: null, onjump: () => {}, ontop: () => {}, onend: () => {} } });
    flushSync();
    const names = [...document.body.querySelectorAll("[aria-label^='Go to']")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Go to your message: Pick a colour", "Go to the reply: You picked Blue.", "Go to your message: and red?", "Go to the reply: Red • also fine"]);
    expect(t.map((x) => x.first_line)).toEqual(["Pick a colour", "You picked Blue.", "and red?", "Red"]);
  });
});

describe("names and labels quoted from a message", () => {
  it("a chat's name and an aside's label drop the marks", () => {
    expect(nameLine("**Plan** for `Monday`")).toBe("Plan for Monday");
    expect(chatLabel({ title: null, first_user: "# Lab 4 *notes*" }, "x")).toBe("Lab 4 notes");
    expect(asideLabel({ quote: { text: "the **sampling** distribution" }, turns: [] })).toBe("the sampling distribution");
    expect(asideLabel({ quote: null, turns: [{ question: "why `n - 1`?" }] })).toBe("why n - 1?");
  });
});

describe("Home's Steps and the reply strip quote his message by its words", () => {
  it("a step's title drops the marks", () => {
    const rows = stepsOf([{ event: "user_message", text: "What is the **sampling** `x_bar`?", at: "a" }] as never);
    expect(rows[0].title).toBe("You: What is the sampling x_bar?");
  });
});
