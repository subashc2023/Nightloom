import { describe, expect, it } from "vitest";
import { asideFollowUp, asideQuestion, quoteLabel, samePassage } from "./asideQuote";

// The aside about a highlighted passage (nightshift backlog 107): the
// passage rides inside the one string the aside sends, framed as a
// selection, quoted exactly, his question last. These pin the framing,
// the default question, the ordinal's wording, and the rule for when two
// selection ends make a passage at all.

describe("asideQuestion", () => {
  it("frames the passage as a selection, quotes it exactly, and ends with the question", () => {
    const q = asideQuestion({ text: "the cache is warm", role: "assistant", ordinal: 3 }, "  why?  ");
    expect(q).toBe(
      [
        "The user selected this passage in the transcript, from your 3rd reply, quoted exactly:",
        "",
        '"""',
        "the cache is warm",
        '"""',
        "",
        "why?",
      ].join("\n"),
    );
  });

  it("keeps the passage's inner whitespace and drops only a trailing run and leading newlines", () => {
    const q = asideQuestion({ text: "\n\n- one\n  - two  \n\n", role: "user", ordinal: 1 }, "x");
    expect(q).toContain('"""\n- one\n  - two\n"""');
  });

  it("asks to explain when nothing was typed", () => {
    const q = asideQuestion({ text: "p", role: "assistant", ordinal: 1 }, "   ");
    expect(q.endsWith("\n\nExplain this.")).toBe(true);
  });
});

describe("quoteLabel", () => {
  it("names the reply or the message with an English ordinal", () => {
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 1 })).toBe("your 1st reply");
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 2 })).toBe("your 2nd reply");
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 3 })).toBe("your 3rd reply");
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 11 })).toBe("your 11th reply");
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 12 })).toBe("your 12th reply");
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 22 })).toBe("your 22nd reply");
    expect(quoteLabel({ text: "", role: "user", ordinal: 4 })).toBe("the user's 4th message");
  });
  it("turns the pronouns round for the card he reads", () => {
    expect(quoteLabel({ text: "", role: "assistant", ordinal: 2 }, "card")).toBe("its 2nd reply");
    expect(quoteLabel({ text: "", role: "user", ordinal: 1 }, "card")).toBe("your 1st message");
  });
});

describe("samePassage", () => {
  const prose = {};
  it("is a passage only when both ends sit in the same prose block of the same turn", () => {
    expect(samePassage({ turn: 3, prose }, { turn: 3, prose })).toBe(true);
    expect(samePassage({ turn: 3, prose }, { turn: 5, prose })).toBe(false);
    expect(samePassage({ turn: 3, prose }, { turn: 3, prose: {} })).toBe(false);
  });
  it("is no passage when either end is outside prose", () => {
    expect(samePassage(null, { turn: 3, prose })).toBe(false);
    expect(samePassage({ turn: 3, prose }, null)).toBe(false);
    expect(samePassage(null, null)).toBe(false);
  });
});

describe("asideFollowUp (backlog 130)", () => {
  it("quotes one earlier exchange, then the new question", () => {
    const s = asideFollowUp(null, [{ question: "why?", answer: "Because the cache is warm.\n" }], " and then? ");
    expect(s).toBe(
      [
        "This is a side conversation beside the chat, not part of it.",
        "Earlier in the side conversation, the user asked:",
        "",
        '"""',
        "why?",
        '"""',
        "",
        "and you answered:",
        "",
        '"""',
        "Because the cache is warm.",
        '"""',
        "",
        "Now the user asks:",
        "",
        "and then?",
      ].join("\n"),
    );
  });

  it("puts the passage first, and numbers the later exchanges as 'then'", () => {
    const s = asideFollowUp(
      { text: "the cache is warm", role: "user", ordinal: 2 },
      [
        { question: "q1", answer: "a1" },
        { question: "q2", answer: "a2" },
      ],
      "q3",
    );
    expect(s.startsWith(["This is a side conversation beside the chat, not part of it.", "It is about this passage the user selected in the transcript, from the user's 2nd message, quoted exactly:", "", '"""', "the cache is warm", '"""', "", "Earlier in the side conversation, the user asked:"].join("\n"))).toBe(true);
    expect(s).toContain(["", "Then the user asked:", "", '"""', "q2", '"""', "", "and you answered:", "", '"""', "a2", '"""', "", "Now the user asks:", "", "q3"].join("\n"));
    expect(s.match(/and you answered:/g)).toHaveLength(2);
  });

  it("defaults an empty follow-up to Go on.", () => {
    expect(asideFollowUp(null, [], "  ").endsWith("Now the user asks:\n\nGo on.")).toBe(true);
  });
});
