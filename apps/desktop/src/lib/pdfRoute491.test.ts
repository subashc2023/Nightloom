import { describe, expect, it, vi } from "vitest";

// Item 491: on the Claude Code engine a PDF of more than 10 pages — or an
// office file that converts to one — goes by path for the model to read,
// unless his "Send whole" is on; short PDFs, images, text and the API
// engine are as before; a draft keeps the chip's pages and choice.

let pages: number | null = 11;
let office: unknown = null;
const stashed: string[] = [];
const disk = new Map<string, string>();
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  pdfPages: () => Promise.resolve(pages),
  officeConverter: () => Promise.resolve(true),
  prepareOfficeAttachment: () => Promise.resolve(office),
  stashDraftFile: (data: string) => {
    stashed.push(data);
    const id = "a".repeat(63) + String(stashed.length % 10);
    disk.set(id, data);
    return Promise.resolve(id);
  },
  readDraftFile: (id: string) => (disk.has(id) ? Promise.resolve(disk.get(id)!) : Promise.reject(new Error("gone"))),
}));

class StubReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(): void {
    this.result = "data:application/pdf;base64,UERG";
    queueMicrotask(() => this.onload?.());
  }
}
vi.stubGlobal("FileReader", StubReader);

const { isLongPdf, pdfFileName, pdfRoute, routeLabel } = await import("./attachKinds");
const { acceptFiles, restoreStashed, splitChips } = await import("./attachFiles.svelte");
const { drafts, findChip, loadDrafts, serializeDrafts, PERSIST_ATTACHMENT_MAX } = await import("./drafts.svelte");
const { midTurnWire } = await import("./midTurn");
const { asideWire } = await import("./state.svelte");
import type { Attachment } from "./types";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const pdf = (n: number | undefined, extra: Partial<Attachment> = {}): Attachment => ({
  id: 1,
  kind: "document",
  name: "deck.pdf",
  media_type: "application/pdf",
  data: "UERG",
  ...(n !== undefined ? { pages: n } : {}),
  ...extra,
});

describe("the routing rule", () => {
  it("sends 10 pages inline and 11 by path, on Claude Code only", () => {
    expect(pdfRoute(pdf(10), "claude-code")).toBe("inline");
    expect(pdfRoute(pdf(11), "claude-code")).toBe("path");
    expect(pdfRoute(pdf(98), "api")).toBe("inline");
    // Pages that could not be counted: as before.
    expect(pdfRoute(pdf(undefined), "claude-code")).toBe("inline");
  });

  it("sends a long PDF whole when he says so", () => {
    expect(pdfRoute(pdf(98, { whole: true }), "claude-code")).toBe("inline");
  });

  it("has nothing to choose for images and text", () => {
    expect(pdfRoute({ kind: "image", media_type: "image/png", pages: 50 }, "claude-code")).toBeNull();
    expect(pdfRoute({ kind: "document", media_type: "text/plain", pages: 50 }, "claude-code")).toBeNull();
    expect(isLongPdf({ kind: "file", media_type: "application/pdf", pages: 50 })).toBe(false);
  });

  it("names an office file's PDF as a PDF", () => {
    expect(pdfFileName("deck.pptx")).toBe("deck.pdf");
    expect(pdfFileName("notes.pdf")).toBe("notes.pdf");
    expect(pdfFileName("README")).toBe("README.pdf");
  });

  it("says the route on the chip, and only where there is one", () => {
    expect(routeLabel(pdf(98), "claude-code")).toMatchObject({ text: "98 pages · read by path", toggle: "Send whole" });
    expect(routeLabel(pdf(98, { whole: true }), "claude-code")).toMatchObject({
      text: "98 pages · sent whole",
      toggle: "Read by path",
    });
    expect(routeLabel(pdf(10), "claude-code")).toBeNull();
    expect(routeLabel(pdf(98), "api")).toBeNull();
  });
});

describe("the wire", () => {
  const img: Attachment = { id: 2, kind: "image", name: "a.png", media_type: "image/png", data: "SU1H" };
  const txt: Attachment = { id: 3, kind: "document", name: "a.txt", media_type: "text/plain", data: "dA==" };

  it("moves a long PDF to the files with its pages, and leaves the rest", () => {
    const w = splitChips([pdf(11), pdf(10, { id: 4, name: "short.pdf" }), img, txt], "claude-code");
    expect(w.files).toEqual([{ name: "deck.pdf", data: "UERG", pages: 11 }]);
    expect(w.documents.map((d) => d.name)).toEqual(["short.pdf", "a.txt"]);
    expect(w.images).toHaveLength(1);
  });

  it("sends it whole with the switch, and on the API engine", () => {
    expect(splitChips([pdf(11, { whole: true })], "claude-code").files).toEqual([]);
    const api = splitChips([pdf(98)], "api");
    expect(api.files).toEqual([]);
    expect(api.documents).toEqual([{ media_type: "application/pdf", name: "deck.pdf", data: "UERG" }]);
  });

  it("saves a converted deck under a .pdf name", () => {
    const w = splitChips([pdf(40, { name: "lecture.pptx", label: "slides → PDF · 40 pages" })], "claude-code");
    expect(w.files).toEqual([{ name: "lecture.pdf", data: "UERG", pages: 40 }]);
  });

  it("holds a long PDF for the turn's end rather than joining a running turn", () => {
    expect(midTurnWire([pdf(11)])).toBeNull();
    expect(midTurnWire([pdf(11, { whole: true })])?.documents).toHaveLength(1);
    expect(midTurnWire([pdf(10)])?.documents).toHaveLength(1);
  });

  it("routes an aside's long PDF by path (an aside is Claude Code)", () => {
    const w = asideWire(null, [pdf(11), pdf(5, { id: 9, name: "s.pdf" })]);
    expect(w.files).toEqual([{ name: "deck.pdf", data: "UERG", pages: 11 }]);
    expect(w.documents?.map((d) => d.name)).toEqual(["s.pdf"]);
  });
});

describe("attaching", () => {
  it("counts a dropped PDF's pages and keeps a long one on disk", async () => {
    pages = 11;
    stashed.length = 0;
    const [chip] = await acceptFiles("pdf491-a", [new File(["%PDF"], "deck.pdf", { type: "application/pdf" })], () => {});
    expect(chip.pages).toBe(11);
    await settle();
    expect(stashed).toEqual(["UERG"]);
    expect(findChip("pdf491-a", chip.id)?.stash).toMatch(/^a{63}\d$/);
  });

  it("keeps a short one in memory only, as before", async () => {
    pages = 10;
    stashed.length = 0;
    const [chip] = await acceptFiles("pdf491-b", [new File(["%PDF"], "short.pdf", { type: "application/pdf" })], () => {});
    expect(chip.pages).toBe(10);
    await settle();
    expect(stashed).toEqual([]);
  });

  it("gives an office file that became a long PDF its pages", async () => {
    stashed.length = 0;
    office = { media_type: "application/pdf", name: "deck.pptx", data: "UERG", via: "pdf", count: 40, note: null, source_sha256: "x" };
    const [chip] = await acceptFiles("pdf491-c", [new File(["x"], "deck.pptx")], () => {});
    await settle();
    const done = findChip("pdf491-c", chip.id)!;
    expect(done.pages).toBe(40);
    expect(splitChips([done], "claude-code").files).toEqual([{ name: "deck.pdf", data: "UERG", pages: 40 }]);
    expect(stashed).toEqual(["UERG"]);
  });

  it("gives an office file that became text no pages", async () => {
    office = { media_type: "text/plain", name: "deck.pptx", data: "dA==", via: "text", count: 40, note: null, source_sha256: "x" };
    const [chip] = await acceptFiles("pdf491-d", [new File(["x"], "deck.pptx")], () => {});
    await settle();
    expect(findChip("pdf491-d", chip.id)?.pages).toBeUndefined();
  });
});

describe("a draft across a relaunch", () => {
  const big = "A".repeat(PERSIST_ATTACHMENT_MAX + 4);

  it("keeps a long PDF too big for the store by its copy on disk, with his choice", () => {
    const chip = pdf(98, { data: big, whole: true, stash: "b".repeat(64) });
    const stored = JSON.parse(serializeDrafts({ k: { text: "", attachments: [chip], queue: [] } }));
    expect(stored.k.attachments[0]).toMatchObject({ data: "", pages: 98, whole: true, stash: "b".repeat(64) });
    const back = loadDrafts({ getItem: () => JSON.stringify(stored) });
    expect(back.k.attachments[0]).toMatchObject({ pending: true, pages: 98, whole: true });
    // Read back again before its bytes came: still kept.
    const again = JSON.parse(serializeDrafts(back));
    expect(again.k.attachments[0]).toMatchObject({ stash: "b".repeat(64), pages: 98 });
  });

  it("drops a big chip with no copy on disk, as before", () => {
    const stored = JSON.parse(serializeDrafts({ k: { text: "t", attachments: [pdf(98, { data: big })], queue: [] } }));
    expect(stored.k.attachments).toEqual([]);
  });

  it("gets the bytes back after the relaunch, in the box and the queue", async () => {
    const id = "c".repeat(64);
    disk.set(id, "UERG");
    drafts["pdf491-r"] = {
      text: "",
      attachments: [pdf(98, { id: 501, data: "", stash: id, pending: true })],
      queue: [{ id: 1, text: "q", attachments: [pdf(30, { id: 502, data: "", stash: id, pending: true })] }],
    };
    drafts["pdf491-gone"] = { text: "", attachments: [pdf(98, { id: 503, data: "", stash: "d".repeat(64), pending: true })], queue: [] };
    const toasts: string[] = [];
    await restoreStashed((t) => toasts.push(t));
    expect(drafts["pdf491-r"].attachments[0]).toMatchObject({ data: "UERG", pending: false, pages: 98 });
    expect(drafts["pdf491-r"].queue[0].attachments[0]).toMatchObject({ data: "UERG", pending: false });
    // A copy gone from disk: the chip goes, and says so.
    expect(drafts["pdf491-gone"].attachments).toEqual([]);
    expect(toasts).toEqual(["deck.pdf could not be brought back after the restart — attach it again"]);
  });
});
