import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESUME_KEY,
  RESUME_TTL_MS,
  atRisk,
  keptSheet,
  readResume,
  saveResume,
  schemeVerdict,
  scrollBy,
  scrollPlace,
  takeResume,
  unkeptText,
  type Resume,
} from "./schemeReload";

describe("schemeVerdict (item 302)", () => {
  const dark = { loaded: "light", now: "dark" } as const;

  it("no reload when the phone's scheme is the one the page loaded in", () => {
    for (const visible of [true, false])
      for (const risk of [true, false]) expect(schemeVerdict({ loaded: "dark", now: "dark", visible, atRisk: risk })).toBe("none");
  });

  it("hidden: when next shown, at risk or not", () => {
    expect(schemeVerdict({ ...dark, visible: false, atRisk: false })).toBe("later");
    expect(schemeVerdict({ ...dark, visible: false, atRisk: true })).toBe("later");
  });

  it("visible: at once only when nothing is at risk", () => {
    expect(schemeVerdict({ ...dark, visible: true, atRisk: false })).toBe("now");
    expect(schemeVerdict({ ...dark, visible: true, atRisk: true })).toBe("later");
  });

  it("a switch and back while away asks for nothing (no loop: after a reload, loaded is the new scheme)", () => {
    expect(schemeVerdict({ loaded: "light", now: "light", visible: true, atRisk: false })).toBe("none");
    expect(schemeVerdict({ loaded: "dark", now: "dark", visible: true, atRisk: false })).toBe("none");
  });
});

describe("atRisk and unkeptText (item 302)", () => {
  const calm = { attachments: 0, writes: 0, unkept: false, held: false, naming: false, unsavedDrafts: 0 };

  it("nothing at risk on a calm page", () => {
    expect(atRisk(calm)).toBe(false);
  });

  it("a photo attached, a send on its way, unkept words or the voice orb each hold the reload", () => {
    expect(atRisk({ ...calm, attachments: 1 })).toBe(true);
    expect(atRisk({ ...calm, writes: 1 })).toBe(true);
    expect(atRisk({ ...calm, unkept: true })).toBe(true);
    expect(atRisk({ ...calm, held: true })).toBe(true);
  });

  it("item 303: a new chat the host has not named yet, or a draft whose save failed, holds the reload", () => {
    expect(atRisk({ ...calm, naming: true })).toBe(true);
    expect(atRisk({ ...calm, unsavedDrafts: 1 })).toBe(true);
    // Shown and switched: later, not now.
    expect(schemeVerdict({ loaded: "dark", now: "light", visible: true, atRisk: atRisk({ ...calm, naming: true }) })).toBe("later");
  });

  it("words in a kept field (composer, note editor) are safe; in an unkept one (rename) they are not", () => {
    expect(unkeptText([{ type: "textarea", value: "half-typed", kept: true }])).toBe(false);
    expect(unkeptText([{ type: "text", value: "New name", kept: false }])).toBe(true);
    expect(unkeptText([{ type: "", value: "a note on the approval", kept: false }])).toBe(true);
    expect(unkeptText([{ type: "textarea", value: "x", kept: false }])).toBe(true);
  });

  it("an empty field, a search box and a checkbox hold nothing", () => {
    expect(unkeptText([{ type: "text", value: "   ", kept: false }])).toBe(false);
    expect(unkeptText([{ type: "search", value: "garden", kept: false }])).toBe(false);
    expect(unkeptText([{ type: "checkbox", value: "on", kept: false }])).toBe(false);
    expect(unkeptText([{ type: "file", value: "C:\\fakepath\\a.jpg", kept: false }])).toBe(false);
  });
});

describe("keptSheet (item 302)", () => {
  it("keeps the sheets that reopen on their own", () => {
    for (const s of ["chat", "project", "rail", "running", "notes", "aside", "council", "newproject", "hosts", "nightshift"]) expect(keptSheet(s)).toBe(s);
  });
  it("brings the message menu, rename and the confirmations back as the chat menu", () => {
    for (const s of ["message", "rename", "delete", "compact"]) expect(keptSheet(s)).toBe("chat");
  });
  it("none and an unknown name keep nothing", () => {
    expect(keptSheet(null)).toBe(null);
    expect(keptSheet("bogus")).toBe(null);
  });
});

describe("the transcript's scroll (item 302)", () => {
  const rows = [
    { row: 0, top: -900, bottom: -400 },
    { row: 1, top: -400, bottom: -40 },
    { row: 2, top: -40, bottom: 300 },
    { row: 3, top: 300, bottom: 700 },
  ];

  it("keeps the first row still in view and its offset", () => {
    expect(scrollPlace(rows, false)).toEqual({ atEnd: false, row: 2, offset: -40 });
  });

  it("at the end, the end", () => {
    expect(scrollPlace(rows, true)).toEqual({ atEnd: true });
    expect(scrollPlace([], false)).toEqual({ atEnd: true });
  });

  it("scrolls by how far the row's top moved from its offset", () => {
    const p = scrollPlace(rows, false);
    // After the reload the page starts at the end: row 2 sits 1800 px up.
    expect(scrollBy(p, -1840)).toBe(-1800);
    // Already in place: no move.
    expect(scrollBy(p, -40)).toBe(0);
    expect(scrollBy(p, null)).toBe(0);
    expect(scrollBy({ atEnd: true }, 500)).toBe(0);
  });
});

describe("the resume note (item 302)", () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const g = globalThis as unknown as { sessionStorage?: unknown };
  let was: unknown;
  beforeEach(() => {
    was = g.sessionStorage;
    g.sessionStorage = fake;
    store.clear();
  });
  afterEach(() => {
    g.sessionStorage = was;
  });

  const kept: Resume = {
    at: 1_000_000,
    chat: "c1",
    scroll: { atEnd: false, row: 7, offset: -32 },
    drawer: false,
    sheet: "notes",
    projects: null,
    context: false,
    notesPid: "garden",
    notes: { tab: "knowledge", view: { v: "edit", scope: "knowledge", name: "plants.md" } },
  };

  it("saves and reads back everything it keeps", () => {
    expect(saveResume(kept)).toBe(true);
    expect(takeResume(kept.at + 2000)).toEqual(kept);
  });

  it("is read once: a later reload does not replay it", () => {
    saveResume(kept);
    expect(takeResume(kept.at + 10)).not.toBe(null);
    expect(takeResume(kept.at + 20)).toBe(null);
    expect(store.has(RESUME_KEY)).toBe(false);
  });

  it("a stale note is dropped", () => {
    saveResume(kept);
    expect(takeResume(kept.at + RESUME_TTL_MS + 1)).toBe(null);
  });

  it("reads a damaged note field by field", () => {
    expect(readResume("nope", 0)).toBe(null);
    const r = readResume({ at: 5, chat: 3, scroll: { row: -1, offset: 2 }, sheet: "delete", notes: { tab: "x", view: { v: "edit" } }, projects: { page: "garden" } }, 5);
    expect(r).toEqual({
      at: 5,
      chat: null,
      scroll: null,
      drawer: false,
      sheet: "chat",
      projects: { page: "garden" },
      context: false,
      notesPid: null,
      notes: { tab: "project", view: { v: "list" } },
    });
  });

  it("storage off: nothing kept, nothing thrown", () => {
    g.sessionStorage = {
      getItem: () => {
        throw new Error("off");
      },
      setItem: () => {
        throw new Error("off");
      },
      removeItem: () => {},
    };
    expect(saveResume(kept)).toBe(false);
    expect(takeResume(kept.at)).toBe(null);
  });
});
