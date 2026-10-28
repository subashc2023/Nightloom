import { describe, expect, it } from "vitest";
import transcriptSrc from "./Transcript.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";
import { removeAsk, removeSnippet, removeTip } from "./removeAsk";

/*
 * Nightshift item 356: Remove on a message looked like Edit (a ringed
 * minus beside a pencil) and ran on one click. It is a trash button now,
 * red on hover, and asks first; the undo toast stays.
 */

const SRC: Record<string, string> = {
  "Transcript.svelte": transcriptSrc,
  "AssistantMessage.svelte": messageSrc,
};
const here = (f: string) => SRC[f];

describe("the Remove confirmation's words", () => {
  it("names what goes, what stays, and the way back", () => {
    const ask = removeAsk("message", "fix the tab bar\nand more", false);
    expect(ask.title).toBe("Remove this message from the chat history?");
    expect(ask.lead).toContain("stays in the log");
    expect(ask.lead).toContain("Undo or Restore");
    expect(ask.lead).not.toContain("Claude Code");
    expect(ask.facts).toEqual([["message", "fix the tab bar"]]);
    expect(ask.confirmLabel).toBe("Remove");
  });

  it("on Claude Code says the history is rewritten by copy", () => {
    const ask = removeAsk("reply", "Done.", true);
    expect(ask.title).toBe("Remove this reply from the chat history?");
    expect(ask.lead).toContain("rewritten copy");
  });

  it("cuts a long first line and names an empty one", () => {
    expect(removeSnippet("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(removeSnippet("   ")).toBe("(no text)");
  });

  it("the tips differ for a message and a reply", () => {
    expect(removeTip("message")).toContain("this message");
    expect(removeTip("reply")).toContain("tool calls stay");
  });
});

describe("the Remove buttons", () => {
  it("are trash icons with the danger class, not the ringed minus", () => {
    for (const f of ["Transcript.svelte", "AssistantMessage.svelte"]) {
      const src = here(f);
      const at = src.indexOf('removeTip("');
      expect(at, f).toBeGreaterThan(-1);
      const button = src.slice(src.lastIndexOf("<button", at), src.indexOf("</button>", at));
      expect(button, f).toContain('name="trash"');
      expect(button, f).toContain("tool-btn danger");
      expect(button, f).not.toContain('name="minus"');
      expect(src, f).toMatch(/\.tool-btn\.danger:hover/);
    }
  });

  it("ask before removing a turn: removeTurn runs only from the confirmation", () => {
    const src = here("Transcript.svelte");
    const calls = [...src.matchAll(/removeTurn\(/g)].map((m) => m.index!);
    // The import, and the one call in the dialog's confirm — through
    // `removeHere`, which lays down the delete motion first (item 397).
    const markup = src.slice(src.indexOf("</script>"));
    expect([...markup.matchAll(/removeTurn\(/g)].length).toBe(0);
    const inMarkup = [...markup.matchAll(/removeHere\(/g)];
    expect(inMarkup.length).toBe(1);
    expect(src).toMatch(/async function removeHere\(index: number\)[^}]*await removeTurn\(index\);/);
    const at = markup.indexOf("removeHere(");
    expect(markup.slice(markup.lastIndexOf("<ConfirmDialog", at), at)).toContain("removing");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("the question belongs to the chat it was asked in: a switch drops it, the confirm checks it", () => {
    // Wave 8 review: the service removes by index in the open chat.
    const src = here("Transcript.svelte");
    expect(src).toContain("if (removing && removing.key !== k) removing = null;");
    expect(src).toContain("if (asked && asked.key === sessionKey) void removeHere(asked.index);");
    expect(src).toContain('kind: "message", text: item.text, key: sessionKey }');
    expect(src).toContain('kind: "reply", text: textOf(item.segs), key: sessionKey }');
  });
});
