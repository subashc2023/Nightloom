import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import NoteMedia from "./NoteMedia.svelte";
import { noteMediaShape } from "./noteMedia";
import type { FileTabData } from "./api";

// Nightshift backlog 307: a PDF in a project's files opened in the note
// editor as "cannot read files/slides/1.3-assembly.pdf: stream did not
// contain valid UTF-8". A file that is not text is drawn — a PDF as pages,
// an image as itself — and anything else gets a card with Open and Reveal;
// none of them offers the editor's Plain / Formatted / Save.

const file = (over: Partial<FileTabData>): FileTabData => ({
  path: "/p/.agents/files/slides/1.3-assembly.pdf",
  kind: "pdf",
  media_type: "application/pdf",
  size: 2397352,
  text: null,
  data: "JVBERi0xLjc=",
  via: "folder",
  ...over,
});

describe("noteMediaShape", () => {
  it("draws a PDF and an image, and cards the rest", () => {
    expect(noteMediaShape(file({}))).toEqual({ view: "pdf", label: "PDF" });
    expect(noteMediaShape(file({ kind: "image", path: "/p/a/shot.png", media_type: "image/png" }))).toEqual({
      view: "image",
      label: "PNG image",
    });
    expect(noteMediaShape(file({ kind: "other", path: "/p/a/1.3-assembly.pptx", data: null }))).toEqual({
      view: "card",
      label: "PowerPoint deck",
    });
    expect(noteMediaShape(file({ kind: "other", path: "/p/a/blob", data: null })).label).toBe("Binary file");
    // A PDF past the tab's limit comes back without bytes: a card, not a blank embed.
    expect(noteMediaShape(file({ data: null })).view).toBe("card");
  });
});

describe("NoteMedia", () => {
  it("embeds a PDF from its bytes", () => {
    const { body } = render(NoteMedia, { props: { file: file({}), name: "files/slides/1.3-assembly.pdf" } });
    expect(body).toContain('<embed class="pdf');
    expect(body).toContain("data:application/pdf;base64,JVBERi0xLjc=");
    expect(body).toContain("Reveal in Finder");
    expect(body).not.toContain("Save");
  });

  it("shows an image as itself", () => {
    const { body } = render(NoteMedia, {
      props: { file: file({ kind: "image", path: "/p/shot.png", media_type: "image/png", data: "iVBORw0K" }), name: "shot.png" },
    });
    expect(body).toContain("<img");
    expect(body).toContain("data:image/png;base64,iVBORw0K");
  });

  it("cards a deck with Open and Reveal", () => {
    const { body } = render(NoteMedia, {
      props: {
        file: file({ kind: "other", path: "/p/1.3-assembly.pptx", media_type: "application/octet-stream", data: null, size: 3599981 }),
        name: "files/slides/1.3-assembly.pptx",
      },
    });
    expect(body).toContain("This file isn't text");
    expect(body).toContain("PowerPoint deck");
    expect(body).toContain(">Open</button>");
    expect(body).toContain("Reveal in Finder");
    expect(body).not.toContain("<embed");
    expect(body).not.toContain("<img");
  });
});
