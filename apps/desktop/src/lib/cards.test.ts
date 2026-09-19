import { describe, expect, it } from "vitest";
import {
  MAX_CARDS,
  artifactLinks,
  displayPath,
  extOf,
  fmtSize,
  pathCandidates,
} from "./cards";

// The cards under a reply (nightshift backlog 078): what the detection
// takes from a reply's text and, as importantly, what it leaves alone.

const ROOT = "/Users/s/Documents/proj";

describe("artifactLinks", () => {
  it("finds the artifact URL and keeps a markdown link's text as its title", () => {
    const text =
      "Published: [Q5 divergence — correction draft](https://claude.ai/artifact/Wc1j1ReUyanMuRq69ULnh7).";
    expect(artifactLinks(text)).toEqual([
      { url: "https://claude.ai/artifact/Wc1j1ReUyanMuRq69ULnh7", title: "Q5 divergence — correction draft" },
    ]);
  });

  it("names a bare URL 'Artifact' and trims the sentence's punctuation", () => {
    expect(artifactLinks("It is at https://claude.ai/artifact/abc123XYZ_-, open it.")).toEqual([
      { url: "https://claude.ai/artifact/abc123XYZ_-", title: "Artifact" },
    ]);
  });

  it("lists each URL once, in order, and skips fenced code", () => {
    const text = [
      "https://claude.ai/artifact/first000 and again https://claude.ai/artifact/first000",
      "```",
      "curl https://claude.ai/artifact/inFence00",
      "```",
      "then https://claude.ai/artifact/second00",
    ].join("\n");
    expect(artifactLinks(text).map((l) => l.url)).toEqual([
      "https://claude.ai/artifact/first000",
      "https://claude.ai/artifact/second00",
    ]);
  });

  it("ignores other claude.ai pages and short ids", () => {
    expect(artifactLinks("see https://claude.ai/chat/abc and https://claude.ai/artifact/ab")).toEqual([]);
  });
});

describe("pathCandidates", () => {
  it("takes an absolute path as written", () => {
    const c = pathCandidates(`Wrote the report to /Users/s/Documents/proj/notes/report.md.`, [ROOT]);
    expect(c).toEqual([{ written: `${ROOT}/notes/report.md`, path: `${ROOT}/notes/report.md` }]);
  });

  it("takes a backtick-quoted relative path with a slash, resolved against the first root", () => {
    const c = pathCandidates("The note is in `notes/ace/q5-correction.md` now.", [ROOT, "/elsewhere"]);
    expect(c).toEqual([
      { written: "notes/ace/q5-correction.md", path: `${ROOT}/notes/ace/q5-correction.md` },
    ]);
  });

  it("leaves a bare filename, an unquoted relative path and a folder as text", () => {
    const text = "Edited `state.svelte.ts`; see notes/ace/x.md and the folder `notes/ace/` and /.";
    expect(pathCandidates(text, [ROOT])).toEqual([]);
  });

  it("does not resolve relative paths when there is no root", () => {
    expect(pathCandidates("in `notes/ace/x.md`", [])).toEqual([]);
    expect(pathCandidates("in /abs/x.md", [])).toEqual([{ written: "/abs/x.md", path: "/abs/x.md" }]);
  });

  it("keeps `~/…` for the backend to expand, and does not read a URL as a path", () => {
    const text = "Saved ~/scratch/out.html; the page is https://claude.ai/artifact/abcdefgh";
    expect(pathCandidates(text, [ROOT])).toEqual([{ written: "~/scratch/out.html", path: "~/scratch/out.html" }]);
  });

  it("skips paths inside fenced code and trims closing punctuation", () => {
    const text = ["Run:", "```sh", "cat /etc/hosts", "```", "(see `docs/desktop.md`)."].join("\n");
    expect(pathCandidates(text, [ROOT])).toEqual([
      { written: "docs/desktop.md", path: `${ROOT}/docs/desktop.md` },
    ]);
  });

  it("stops at MAX_CARDS", () => {
    const text = Array.from({ length: MAX_CARDS + 3 }, (_, i) => `/abs/file${i}.md`).join(" ");
    expect(pathCandidates(text, [])).toHaveLength(MAX_CARDS);
  });
});

describe("the card's label", () => {
  it("shows a path relative to the workspace, else as written", () => {
    expect(displayPath(`${ROOT}/notes/x.md`, [ROOT])).toBe("notes/x.md");
    expect(displayPath("/tmp/x.md", [ROOT])).toBe("/tmp/x.md");
    expect(displayPath(`${ROOT}/notes/x.md`, [`${ROOT}/`])).toBe("notes/x.md");
  });

  it("badges the extension, lower-cased, 'file' when there is none", () => {
    expect(extOf("/a/b/Report.MD")).toBe("md");
    expect(extOf("/a/b/Makefile")).toBe("file");
    expect(extOf("/a/b/.env")).toBe("file");
  });

  it("formats sizes like the attachment chip", () => {
    expect(fmtSize(812)).toBe("812 B");
    expect(fmtSize(4198)).toBe("4.1 KB");
    expect(fmtSize(1_300_000)).toBe("1.2 MB");
  });
});
