import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { cite, citeChip, siteOf } from "./cite";

// A bare instance with the extension, as tilde.test.ts does: `renderReply`
// sanitises through DOMPurify, which needs a DOM this environment lacks.
function render(src: string): string {
  const m = new Marked();
  m.use(cite);
  return m.parse(src, { async: false, gfm: true }) as string;
}

describe("citation chips (backlog 213)", () => {
  it("draws `[[1]](url \"title\")` as a chip with the site's name, title and domain on hover", () => {
    const html = render('Rust 2024 shipped in February. [[1]](https://www.rust-lang.org/blog/x "Rust 2024 is out")');
    expect(html).toContain('class="cite-chip"');
    expect(html).toContain('href="https://www.rust-lang.org/blog/x"');
    expect(html).toContain('data-tip="Rust 2024 is out — rust-lang.org"');
    expect(html).toContain(">rust-lang.org</a>");
    expect(html).not.toContain(" title=");
  });
  it("takes `[1](url)` too, and without a title the tip is the domain", () => {
    const html = render("A claim. [2](https://example.com/a)");
    expect(html).toContain('data-cite="2"');
    expect(html).toContain('data-tip="example.com"');
  });
  it("leaves an ordinary link alone", () => {
    const html = render("See [the docs](https://example.com/docs).");
    expect(html).toContain('<a href="https://example.com/docs">the docs</a>');
    expect(html).not.toContain("cite-chip");
  });
  it("a non-web href is not a chip", () => {
    expect(citeChip("file:///etc/passwd", "[1]", null)).toBeNull();
    expect(siteOf("javascript:alert(1)")).toBeNull();
  });
  it("escapes a title with quotes and markup", () => {
    expect(citeChip("https://a.org/", "[1]", 'He said "<b>hi</b>"')).toContain(
      'data-tip="He said &quot;&lt;b&gt;hi&lt;/b&gt;&quot; — a.org"',
    );
  });
});

describe("the foot list folds to All sources", () => {
  it("a Sources heading and list at the end fold", () => {
    const html = render("Answer. [[1]](https://a.org/)\n\n## Sources\n\n- [A](https://a.org/)\n- [B](https://b.org/)\n");
    expect(html).toContain('<details class="all-sources"><summary>All sources</summary>');
    expect(html).not.toContain("<h2");
    expect(html).toMatch(/<\/ul>\s*<\/details>/);
  });
  it("so does a bold `Sources:` line", () => {
    const html = render("Answer.\n\n**Sources:**\n- [A](https://a.org/)\n");
    expect(html).toContain("All sources");
    expect(html).not.toContain("<strong>Sources");
  });
  it("a Sources list followed by more prose is left where it is", () => {
    const html = render("## Sources\n\n- [A](https://a.org/)\n\nAnd then more words.");
    expect(html).not.toContain("all-sources");
  });
  it("a list without the label is left alone", () => {
    expect(render("Steps:\n\n- one\n- two\n")).not.toContain("all-sources");
  });
});
