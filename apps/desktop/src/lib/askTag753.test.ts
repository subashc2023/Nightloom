import { describe, expect, it } from "vitest";
import { answeredWhen, askTag, extractAsk, parseAsk, pendingAsk } from "./askTag";
import { Marked } from "marked";
import markdownSrc from "./markdown.ts?raw";
import type { SessionEvent } from "./types";
import askQuestions from "./AskQuestions.svelte?raw";
import turnAsk from "./TurnAsk.svelte?raw";

const reply = (text: string): SessionEvent =>
  ({ event: "assistant_message", model: "m", blocks: [{ type: "text", text }], stop_reason: "end_turn", usage: {} }) as unknown as SessionEvent;
const mine = (text: string): SessionEvent => ({ event: "user_message", text, at: "2026-11-16T17:00:00Z" });

const ASK = "Done with the merge.\n\n<ask>\nRoll the release now,\nor after lunch?\n- Roll it now\n- **After lunch**\n</ask>\n";

describe("the turn-end question (753)", () => {
  it("reads the question and its answers, the default first", () => {
    expect(parseAsk("Which one?\n- A\n- B\n")).toEqual({ question: "Which one?", options: ["A", "B"] });
    expect(extractAsk(ASK)).toEqual({ question: "Roll the release now, or after lunch?", options: ["Roll it now", "After lunch"] });
    // No answers offered: he types one.
    expect(extractAsk("<ask>\nWhat should it be called?\n</ask>")).toEqual({ question: "What should it be called?", options: [] });
  });

  it("is text inside a fence, unclosed, or without a question; the last block wins", () => {
    expect(extractAsk("```\n<ask>\nQ?\n- A\n</ask>\n```\n")).toBeNull();
    expect(extractAsk("<ask>\nQ?\n- A\n")).toBeNull();
    expect(extractAsk("<ask>\n- A\n</ask>")).toBeNull();
    expect(extractAsk("<ask>\nFirst?\n</ask>\n\ntext\n\n<ask>\nSecond?\n- Yes\n</ask>")?.question).toBe("Second?");
  });

  it("waits until he writes: the last reply's ask is pending, a message after it answers it", () => {
    expect(pendingAsk([mine("go"), reply(ASK)])).toEqual({ ask: extractAsk(ASK), index: 1 });
    expect(pendingAsk([mine("go"), reply(ASK), mine("Roll it now")])).toBeNull();
    expect(pendingAsk([mine("go"), reply(ASK), mine("x"), reply("ok")])).toBeNull();
    expect(pendingAsk([])).toBeNull();
  });

  it("shows in the reply as a box, never as raw tags", () => {
    // (The reply renderer uses this extension; DOMPurify needs a DOM, so the extension is run alone.)
    expect(markdownSrc).toContain("replyMarked.use(askTag)");
    const html = new Marked().use(askTag).parse(ASK, { async: false }) as string;
    expect(html).toContain('class="nl-ask"');
    expect(html).toContain("Roll the release now, or after lunch?");
    expect(html).toContain("<li>After lunch</li>");
    expect(html).not.toContain("&lt;ask&gt;");
  });

  it("dates the blocker in 12-hour time", () => {
    expect(answeredWhen(new Date(2026, 10, 16, 9, 5))).toBe("2026-11-16 9:05 AM");
    expect(answeredWhen(new Date(2026, 10, 16, 0, 30))).toBe("2026-11-16 12:30 AM");
    expect(answeredWhen(new Date(2026, 10, 16, 15, 0))).toBe("2026-11-16 3:00 PM");
  });

  it("is 712's card, extended: the host hands AskQuestions a click that sends", () => {
    expect(askQuestions).toContain("onquick");
    expect(turnAsk).toContain("<AskQuestions");
    expect(turnAsk).toContain("{onquick}");
    // 712's comment on an option goes out with the answer.
    expect(turnAsk).toContain("answerText(");
    expect(turnAsk).toContain("onnote=");
  });
});

// Two real replies (wave G follow-up, 2026-11-16): `claude -p` with the 753 engine note, Opus 5.5 and Haiku,
// asked to list the options for scoring an unbuilt patch and let him pick. Both ended on the block.
const REAL_OPUS = "I read `scorer.py`. It's four lines, and nothing else is in the directory, so I can't see how callers handle `None` today:\n\n```python\ndef score(patch):\n    if not patch.built:\n        return None\n    return patch.tests_passed / patch.tests_total\n```\n\n**Options for an unbuilt patch:**\n\n| # | Return | Upside | Downside |\n|---|---|---|---|\n| 1 | `0.0` | Stays a float in [0, 1]. Averages and rankings work with no changes, and a build failure counts as a full failure. | Looks the same as \"built, but every test failed.\" |\n| 2 | `None` (keep it, but document it) | No code change. Callers can tell \"didn't build\" apart from \"scored 0\". | Callers that filter out `None` before averaging leave build failures out, which inflates the average. Callers that don't filter crash on `sum()` or comparisons. |\n| 3 | A negative value, e.g. `-1.0` | Always ranks below any patch that built. Still one number. | Breaks the [0, 1] range, so averages mix two different kinds of score. |\n| 4 | Raise an error, e.g. `PatchNotBuilt` | Every caller has to decide how to handle it. Nothing slips through quietly. | Every caller needs a `try`. |\n| 5 | A result object, e.g. `Score(value=0.0, built=False)` | Keeps all the information: you can average with build failures as 0 and still count how many failed. | Changes the return type, so every caller has to be updated. |\n\nI'd pick **option 1** if the score mostly feeds averages or rankings. I'd pick **option 5** if you need to report build failures separately.\n\n**A separate bug:** a patch that builds but has `tests_total == 0` raises `ZeroDivisionError`. Whichever option you choose, that case needs a value too. I'll leave it alone unless you want it in the same change.\n\n<ask>\nWhich option should an unbuilt patch get? You can also reply with another option number from the table.\n- Option 1: return 0.0\n- Option 5: return a result object that keeps the built flag\n</ask>";
const REAL_HAIKU = "`scorer.py` is three lines. `score(patch)` returns `None` when `patch.built` is false, and otherwise returns `patch.tests_passed / patch.tests_total`. I didn't change anything. (The copy under `/tmp/ny753/...` resolves to the same file on macOS.)\n\nOptions for an unbuilt patch:\n\n1. **Score 0.0.** Simple, and works for averages and pass rates. It merges \"didn't build\" with \"built, but every test failed,\" so you lose that distinction unless you report build rate separately.\n2. **Keep `None` and exclude it.** This is today's behavior. Every caller must filter `None`, and the score denominator changes with the build rate.\n3. **Raise an exception.** Fails loudly, which suits a pipeline where an unbuilt patch should never reach scoring. It stops the run, though, so it needs a catch somewhere.\n4. **Return a distinct status.** Score 0.0 for pass rate, but return a status (for example `built: False`, or an enum) so build failures are counted separately. More code, but both numbers are kept.\n5. **Score 0.0 and report build rate alongside.** Same as 1 with a separate build metric, without changing the return type.\n\nSeparately, `tests_passed / tests_total` raises `ZeroDivisionError` if a built patch has zero tests. Tell me if you want that handled too.\n\n<ask>\nWhich should an unbuilt patch score: 0.0 (option 1), or keep `None` and exclude it (option 2)?\n- 0.0 — counts as a failure, and I'd report build rate separately if you want it visible.\n- Keep `None` — leave the current behavior and have callers exclude unbuilt patches.\n</ask>";
describe("real model replies (753)", () => {
  it("read as a card with two answers, the default first", () => {
    const o = extractAsk(REAL_OPUS);
    expect(o?.options).toEqual(["Option 1: return 0.0", "Option 5: return a result object that keeps the built flag"]);
    expect(o?.question).toMatch(/^Which option should an unbuilt patch get\?/);
    const h = extractAsk(REAL_HAIKU);
    expect(h?.options.length).toBe(2);
    expect(h?.question).toMatch(/^Which should an unbuilt patch score/);
    expect(pendingAsk([mine("q"), reply(REAL_OPUS)])?.ask).toEqual(o);
  });
});
