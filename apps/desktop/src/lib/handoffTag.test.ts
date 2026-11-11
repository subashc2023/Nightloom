import { describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import { extractHandoff, handoffTag, HANDOFF_LABEL } from "./handoffTag";
import { extractStartPrompt } from "./handoff.svelte";
import markdownSource from "./markdown.ts?raw";
import type { SessionEvent } from "./types";

// Item 464: the tagged hand-off — one source of truth for a thread's next
// chat. The extraction and the card read the reply through one tokenizer.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  saveThreadHandoff: vi.fn(async () => null),
}));

const FENCE = "```";

describe("extractHandoff", () => {
  it("is null with no tag", () => {
    expect(extractHandoff("Updated thread.md. Next, run T-04.")).toBeNull();
    expect(extractHandoff("")).toBeNull();
  });

  it("reads one block, trimmed, keeping its lines", () => {
    const reply = "Updated thread.md.\n\n<handoff>\nRead the Queue.\n\nThen run T-04.\n</handoff>\n";
    expect(extractHandoff(reply)).toBe("Read the Queue.\n\nThen run T-04.");
  });

  it("takes the last of two blocks", () => {
    const reply = "<handoff>\nfirst\n</handoff>\n\nRevised:\n\n<handoff>\nsecond\n</handoff>";
    expect(extractHandoff(reply)).toBe("second");
  });

  it("reads a block on one line, and one right after a paragraph", () => {
    expect(extractHandoff("<handoff>Read X.</handoff>")).toBe("Read X.");
    expect(extractHandoff("Done.\n<handoff>\nRead Y.\n</handoff>")).toBe("Read Y.");
  });

  it("ignores a tag inside a code fence or inline code", () => {
    expect(extractHandoff(`${FENCE}text\n<handoff>\nnot this\n</handoff>\n${FENCE}\n`)).toBeNull();
    expect(extractHandoff("I put it in `<handoff>x</handoff>` tags.")).toBeNull();
    const both = `${FENCE}\n<handoff>\nfenced\n</handoff>\n${FENCE}\n\n<handoff>\nreal\n</handoff>`;
    expect(extractHandoff(both)).toBe("real");
    // The real one first, an example in a fence after it: still the real one.
    const after = `<handoff>\nreal\n</handoff>\n\n${FENCE}\n<handoff>\nexample\n</handoff>\n${FENCE}`;
    expect(extractHandoff(after)).toBe("real");
  });

  it("ignores an unclosed tag", () => {
    expect(extractHandoff("<handoff>\nRead the Queue, then")).toBeNull();
    // An unclosed one before a closed one: the closed one.
    expect(extractHandoff("<handoff>\nhalf\n\n<handoff>\nwhole\n</handoff>")).toBe("whole");
  });

  it("is null for a blank block", () => {
    expect(extractHandoff("<handoff>\n  \n</handoff>")).toBeNull();
  });
});

describe("extractStartPrompt (the wrap-up's Continue)", () => {
  it("reads the tag first, and an older reply's start-prompt fence still", () => {
    expect(extractStartPrompt("<handoff>\nTagged.\n</handoff>")).toBe("Tagged.");
    expect(extractStartPrompt(`${FENCE}start-prompt\nFenced.\n${FENCE}`)).toBe("Fenced.");
    expect(extractStartPrompt(`${FENCE}start-prompt\nFenced.\n${FENCE}\n<handoff>\nTagged.\n</handoff>`)).toBe(
      "Tagged.",
    );
  });
});

// No DOM in this suite, so no sanitizer: the reply's marked instance is
// stood in for by one with the extension; the wiring is checked by source.
const md = new Marked();
md.use(handoffTag);
const renderReply = (src: string) => md.parse(src, { async: false, gfm: true }) as string;

describe("the card", () => {
  it("is on the reply's renderer", () => {
    expect(markdownSource).toContain("replyMarked.use(handoffTag);");
  });

  it("shows the block as the next chat's prompt, not the raw tags", () => {
    const html = renderReply("Updated thread.md.\n\n<handoff>\nRead <the> Queue & run T-04.\n</handoff>\n\nDone.");
    expect(html).toContain('class="handoff-card"');
    expect(html).toContain(HANDOFF_LABEL);
    expect(html).toContain("Read &lt;the&gt; Queue &amp; run T-04.");
    expect(html).not.toContain("&lt;handoff&gt;");
    expect(html).not.toMatch(/<handoff>/);
    expect(html).toContain("<p>Done.</p>");
  });

  it("leaves a fenced tag as code and an unclosed tag as text — what the extraction ignores", () => {
    expect(renderReply(`${FENCE}\n<handoff>\nx\n</handoff>\n${FENCE}`)).not.toContain("handoff-card");
    // Mid-stream (no close yet): no card.
    expect(renderReply("<handoff>\nRead the Queue, then")).not.toContain("handoff-card");
  });
});

describe("the save at a turn's end (threadHandoff)", () => {
  const reply = (text: string): SessionEvent[] =>
    [
      { event: "user_message", text: "wrap up", at: "2026-10-28T23:00:00Z" },
      { event: "assistant_message", blocks: [{ type: "text", text }], at: "2026-10-28T23:01:00Z" },
    ] as unknown as SessionEvent[];

  it("saves only a finished reply's block, only for a thread chat", async () => {
    const { noteThread } = await import("./handoff.svelte");
    const { handoffToSave, noteThreadHandoff } = await import("./threadHandoff.svelte");
    const api = await import("./api");
    noteThread("c1", "stuart");
    expect(handoffToSave("c1", reply("<handoff>\nRun T-04.\n</handoff>"))).toEqual({
      slug: "stuart",
      text: "Run T-04.",
    });
    // A streaming reply has no events at the call (only a turn's end passes them).
    expect(handoffToSave("c1", null)).toBeNull();
    // Unbound chat: nothing.
    expect(handoffToSave("c2", reply("<handoff>\nRun T-04.\n</handoff>"))).toBeNull();
    // No block: nothing.
    expect(handoffToSave("c1", reply("Updated thread.md."))).toBeNull();
    noteThreadHandoff("c1", reply("<handoff>\nRun T-04.\n</handoff>"));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.saveThreadHandoff).toHaveBeenCalledWith("stuart", "Run T-04.", "c1");
  });
});

// Item 583: asked for in his own words, a model wrote the prompt as a code
// block under a heading — no card, no Continue, nothing kept on the thread.
describe("the heading-and-fence fallback (item 583)", () => {
  const shot =
    "Context is at 500k, so here is the hand-off.\n\n## Handoff prompt for the next chat\n\n" +
    `${FENCE}\nRead thread.md's Queue rows 3–5, then the newest log.md entry.\nThen run T-07.\n${FENCE}\n`;

  it("takes his screenshot's shape: a heading, then a fence", () => {
    expect(extractHandoff(shot)).toBe(
      "Read thread.md's Queue rows 3–5, then the newest log.md entry.\nThen run T-07.",
    );
    const html = renderReply(shot);
    expect(html).toContain('class="handoff-card"');
    expect(html).toContain("Handoff prompt for the next chat");
    expect(html).toContain("Then run T-07.");
  });

  it("takes a bold line, hand-off spelled any way, and next chat's prompt", () => {
    expect(extractHandoff(`**Hand-off prompt:**\n\n${FENCE}text\nGo.\n${FENCE}`)).toBe("Go.");
    expect(extractHandoff(`### Next chat’s prompt\n${FENCE}\nGo on.\n${FENCE}`)).toBe("Go on.");
    expect(extractHandoff(`# HANDOFF\n\n${FENCE}md\nX.\n${FENCE}`)).toBe("X.");
  });

  it("leaves an ordinary code block alone", () => {
    const code = `## Install\n\n${FENCE}bash\nnpm install\n${FENCE}\n\nThe handoff is next week.`;
    expect(extractHandoff(code)).toBeNull();
    expect(renderReply(code)).not.toContain("handoff-card");
    // A fence not directly under the title is not taken either.
    const apart = `## Handoff\n\nSome words first.\n\n${FENCE}\nnot it\n${FENCE}`;
    expect(extractHandoff(apart)).toBeNull();
    // Nor an indented block, nor an empty fence.
    expect(extractHandoff("## Handoff\n\n    indented code\n")).toBeNull();
    expect(extractHandoff(`## Handoff\n\n${FENCE}\n${FENCE}`)).toBeNull();
  });

  it("lets a tagged block win", () => {
    const both = `${shot}\n<handoff>\nThe tagged one.\n</handoff>\n`;
    expect(extractHandoff(both)).toBe("The tagged one.");
    const html = renderReply(both);
    expect(html.match(/handoff-card/g)?.length).toBe(1);
    // The untagged fence stays an ordinary code block.
    expect(html).toContain("Then run T-07.");
  });
});
