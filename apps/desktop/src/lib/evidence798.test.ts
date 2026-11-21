import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import liveSrc from "./liveHtml.ts?raw";
import mainSrc from "../main.ts?raw";
import markdownSrc from "./markdown.ts?raw";
import fileViewSrc from "./FileView.svelte?raw";
import serverSrc from "../../../../crates/nightloom-service/src/mcp_server.rs?raw";
import {
  evidenceBlock,
  besideTable,
  checkWords,
  evidencePath,
  locatorWords,
  parseTable,
  placeholderPath,
  tableFiles,
  tableHtml,
  utf16Range,
  type EvTable,
} from "./evidenceBlock";

const PATH = "/w/.agents/evidence/sleep/table.json";

const TABLE: EvTable = {
  version: 1,
  title: "Sleep <and> memory",
  slug: "sleep",
  checked_at: "2026-11-18 7:00 AM",
  questions: ["Effect on memory?", "Population?"],
  sources: [
    { id: "S1", title: "Paper A", path: "a.pdf", text: "sources/S1.txt", pages: 9, chars: 100 },
    { id: "S2", title: "Page B", url: "https://e.x/b", error: "no stored text for this page" },
  ],
  cells: [
    { source: "S1", question: 0, answer: "Improves", quote: "Sleep improves memory", locator: "p. 4", check: "found", start: 10, end: 31, page: 4 },
    { source: "S1", question: 1, answer: "Adults", quote: "in adults <b>", check: "not_found", elsewhere: "S2" },
    { source: "S2", question: 0, answer: "?", quote: "never read", check: "no_source" },
  ],
  counts: { cells: 3, found: 1, not_found: 1, unchecked: 1, failed: 2 },
};

describe("evidence tables in replies (item 798)", () => {
  const md = new Marked().use(evidenceBlock);
  const render = (src: string) => md.parse(src, { async: false }) as string;
  const el = (html: string) => {
    const m = /data-evidence-path="([^"]*)"/.exec(html);
    return { getAttribute: (n: string) => (n === "data-evidence-path" && m ? m[1] : null) } as unknown as Element;
  };

  it("draws a closed ```evidence fence naming a table as a placeholder that keeps the path as its code", () => {
    const html = render("Here:\n\n```evidence\n" + PATH + "\n```\n");
    expect(html).toContain('<div class="md-evidence" data-evidence-path=');
    expect(placeholderPath(el(html))).toBe(PATH);
    expect(html).toContain(`<pre><code class="language-evidence">${PATH}\n</code></pre>`.replace("\n</code>", "</code>"));
  });

  it("leaves an open fence, a relative path and a non-JSON path as ordinary code", () => {
    expect(render("```evidence\n" + PATH)).not.toContain("md-evidence");
    expect(render("```evidence\ntable.json\n```\n")).not.toContain("md-evidence");
    expect(render("```evidence\n/w/notes.md\n```\n")).not.toContain("md-evidence");
    expect(evidencePath("\n  " + PATH + "  \n")).toBe(PATH);
  });

  it("is wired into every markdown surface, the window, liveHtml, the file tab and the chat's server", () => {
    expect(markdownSrc.match(/\.use\(evidenceBlock\)/g)?.length).toBe(3);
    expect(mainSrc).toContain("installEvidence();");
    expect(liveSrc).toContain('classList.contains("md-evidence-mount")');
    expect(fileViewSrc).toContain("bind:this={textPre}");
    expect(serverSrc).toContain("crate::evidence::EvidenceTable::new(");
  });

  it("reads table.json back and refuses anything else", () => {
    expect(parseTable(JSON.stringify(TABLE))?.title).toBe(TABLE.title);
    expect(parseTable("{}")).toBeNull();
    expect(parseTable("not json")).toBeNull();
    expect(parseTable(JSON.stringify({ ...TABLE, cells: [{ ...TABLE.cells[0], check: "maybe" }] }))).toBeNull();
  });

  it("draws sources as rows and questions as columns, keeps failed cells marked, and escapes every string", () => {
    const h = tableHtml(TABLE, PATH);
    expect(h.match(/<th[ >]/g)?.length).toBe(3 + 2); // corner + 2 questions, then 2 source row heads
    expect(h.match(/<tr>/g)?.length).toBe(3);
    expect(h).toContain('<span class="ev-title">Sleep &lt;and&gt; memory</span>');
    expect(h).not.toContain("<b>");
    expect(h).toContain("1 of 3 quotes found in their source · <span class=\"ev-bad\">1 not found in source</span> · 1 not checkable");
    expect(h).toContain("✗ not found in source (it is in S2)");
    expect(h).toContain("✗ source text missing");
    // Only a found quote with a stored text opens at the quote.
    expect(h.match(/data-ev-text=/g)?.length).toBe(1);
    expect(h).toContain('data-ev-text="/w/.agents/evidence/sleep/sources/S1.txt" data-ev-start="10" data-ev-end="31"');
    expect(h).toContain('<span class="ev-src-err">no stored text for this page</span>');
    // S2 × Q2 had no cell.
    expect(h.match(/class="ev-empty"/g)?.length).toBe(1);
    expect(h).toContain('data-ev-open="/w/.agents/evidence/sleep.md"');
    expect(h).toContain('data-ev-open="/w/.agents/evidence/sleep/table.csv"');
  });

  it("says where a quote is and what the check found", () => {
    expect(locatorWords(TABLE.cells[0])).toBe("p. 4");
    expect(locatorWords({ ...TABLE.cells[0], page_differs: true, page: 6 })).toBe("p. 4 · PDF p. 6");
    expect(locatorWords({ ...TABLE.cells[0], locator: undefined, page: undefined, section: "Results" })).toBe("§ Results");
    expect(checkWords({ ...TABLE.cells[0], page_differs: true, page: 6 })).toBe("found in source, on PDF page 6");
    expect(besideTable(PATH, "sources/S1.txt")).toBe("/w/.agents/evidence/sleep/sources/S1.txt");
    expect(tableFiles(PATH).note).toBe("/w/.agents/evidence/sleep.md");
  });

  it("turns the check's character offsets into the tab's UTF-16 offsets", () => {
    const text = "a𝛼 quote here";
    // Characters: a, 𝛼, space, q… — "quote" starts at character 3, unit 4.
    expect(utf16Range(text, 3, 8)).toEqual([4, 9]);
    expect(text.slice(...utf16Range(text, 3, 8))).toBe("quote");
    expect(utf16Range("abc", 1, 3)).toEqual([1, 3]);
  });
});
