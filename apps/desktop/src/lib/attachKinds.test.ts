import { describe, expect, it } from "vitest";
import {
  badgeOf,
  convertedLabel,
  convertingLabel,
  decide,
  imageType,
  looksLikeText,
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  notebookText,
  routeOf,
} from "./attachKinds";
import { serializeDrafts } from "./drafts.svelte";
import type { Attachment } from "./types";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("routeOf (item 277)", () => {
  it("keeps images and PDFs on their old routes, by type or by extension when macOS gives none", () => {
    expect(routeOf("a.png", "image/png")).toBe("image");
    expect(routeOf("photo.JPG", "")).toBe("image");
    expect(imageType("photo.JPG", "")).toBe("image/jpeg");
    expect(routeOf("paper.pdf", "application/pdf")).toBe("pdf");
    expect(routeOf("paper.pdf", "")).toBe("pdf");
  });

  it("sends office files to conversion, modern and legacy alike", () => {
    for (const n of ["Lecture 7.pptx", "report.docx", "grades.xlsx", "old.ppt", "old.doc", "x.xls", "talk.key", "a.odp"])
      expect(routeOf(n, ""), n).toBe("office");
    expect(
      routeOf("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ).toBe("office");
  });

  it("reads known text extensions and any text/* type as text", () => {
    for (const n of ["data.csv", "notes.md", "fib.py", "nb.ipynb", "conf.yaml", "page.html", "Makefile", "x.rs"])
      expect(routeOf(n, ""), n).toBe("text");
    expect(routeOf("weird.thing", "text/plain")).toBe("text");
  });

  it("leaves everything else to the bytes", () => {
    expect(routeOf("bundle.zip", "application/zip")).toBe("maybe-text");
    expect(routeOf("server.log.1", "")).toBe("maybe-text");
  });
});

describe("looksLikeText", () => {
  it("is UTF-8 with no NUL", () => {
    expect(looksLikeText(utf8("city,pop\nIrvine,314621\n"))).toBe(true);
    expect(looksLikeText(utf8("naïve — ünïcode ✓"))).toBe(true);
    expect(looksLikeText(new Uint8Array())).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false); // a zip
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false); // not UTF-8
  });
});

describe("decide: text, a file for Claude Code, or a refusal that says why", () => {
  it("sends text that fits as text on both engines", () => {
    expect(decide("a.csv", 100, true, "api")).toEqual({ as: "text" });
    expect(decide("a.csv", 100, true, "claude-code")).toEqual({ as: "text" });
  });

  it("makes a binary a file on the Claude Code engine", () => {
    expect(decide("bundle.zip", 132, false, "claude-code")).toEqual({ as: "file" });
  });

  it("refuses a binary on the API engine, naming the engine that can take it", () => {
    const d = decide("bundle.zip", 132, false, "api");
    expect(d.as).toBe("refuse");
    if (d.as === "refuse") {
      expect(d.why).toContain("bundle.zip");
      expect(d.why).toContain(".zip");
      expect(d.why).toContain("Claude Code engine");
    }
  });

  it("sends text too long to inline as a file on Claude Code, refuses it on the API engine", () => {
    expect(decide("big.log", MAX_TEXT_BYTES + 1, true, "claude-code")).toEqual({ as: "file" });
    const d = decide("big.log", MAX_TEXT_BYTES + 1, true, "api");
    expect(d.as).toBe("refuse");
    if (d.as === "refuse") expect(d.why).toContain("KB of text");
  });

  it("refuses a file over the cap even on Claude Code", () => {
    const d = decide("huge.bin", MAX_FILE_BYTES + 1, false, "claude-code");
    expect(d.as).toBe("refuse");
  });
});

describe("notebookText", () => {
  it("is the cells in order, outputs left out", () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "intro"] },
        { cell_type: "code", source: "print(1)", outputs: [{ data: { "image/png": "AAAA" } }] },
      ],
    });
    const t = notebookText(nb);
    expect(t).toBe("# --- cell 1 (markdown) ---\n# Title\nintro\n\n# --- cell 2 (code) ---\nprint(1)");
    expect(t).not.toContain("AAAA");
  });

  it("is the text as is when it is not a notebook", () => {
    expect(notebookText("{not json")).toBe("{not json");
  });
});

describe("the chip's words", () => {
  it("says what is happening while it converts", () => {
    expect(convertingLabel("Lecture 7.pptx", true)).toBe("slides → PDF…");
    expect(convertingLabel("Lecture 7.pptx", false)).toBe("slides → text…");
    expect(convertingLabel("grades.xlsx", true)).toBe("sheet → PDF…");
    expect(convertingLabel("report.docx", false)).toBe("document → text…");
  });

  it("says what will be sent once it has", () => {
    expect(convertedLabel("Lecture 7.pptx", "pdf", 12)).toBe("slides → PDF · 12 pages");
    expect(convertedLabel("Lecture 7.pptx", "text", 3)).toBe("slides → text · 3 slides");
    expect(convertedLabel("grades.xlsx", "text", 1)).toBe("sheet → text · 1 sheet");
    expect(convertedLabel("report.docx", "pdf", 1)).toBe("document → PDF · 1 page");
    expect(convertedLabel("report.docx", "text", 1)).toBe("document → text");
  });

  it("badges a chip by what goes, not what was dropped", () => {
    expect(badgeOf({ kind: "document", media_type: "application/pdf", name: "Lecture 7.pptx" })).toBe("PDF");
    expect(badgeOf({ kind: "document", media_type: "text/plain", name: "Lecture 7.pptx" })).toBe("TXT");
    expect(badgeOf({ kind: "document", media_type: "text/plain", name: "data.csv" })).toBe("CSV");
    expect(badgeOf({ kind: "document", media_type: "text/plain", name: "Makefile" })).toBe("TXT");
    expect(badgeOf({ kind: "file", media_type: "application/zip", name: "bundle.zip" })).toBe("ZIP");
  });
});

describe("drafts keep finished chips and their words, not conversions in flight", () => {
  it("drops a pending chip and keeps a label and a file chip", () => {
    const chips: Attachment[] = [
      { id: 1, kind: "document", media_type: "application/pdf", name: "a.pptx", data: "", label: "slides → PDF…", pending: true },
      { id: 2, kind: "document", media_type: "text/plain", name: "b.csv", data: "YQ==", label: "text" },
      { id: 3, kind: "file", media_type: "application/zip", name: "c.zip", data: "UEs=", label: "file for Claude Code" },
    ];
    const out = JSON.parse(serializeDrafts({ k: { text: "", attachments: chips, queue: [] } }));
    expect(out.k.attachments.map((a: Attachment) => a.id)).toEqual([2, 3]);
    expect(out.k.attachments[0].label).toBe("text");
    expect(out.k.attachments[1].kind).toBe("file");
  });
});
