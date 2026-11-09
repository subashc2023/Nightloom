import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import UserBubble from "./UserBubble.svelte";
import { cleanPassage, joinAttachNote, savedFilePaths, shownText, splitAttachNote } from "./keep";
import { nameLine, chatLabel } from "./chatLabel";
import { ticks } from "./navigator";
import { transcriptRows } from "../remote/client";
import { app } from "./state.svelte";
import type { ProjectInfo, SessionEvent } from "./types";

// Nightshift item 515 (his report, 2026-11-09): the note the backend adds
// for the CLI — "[Attached a file — saved for you to open with your tools:
// - <path>]" — was drawn as his words, and a message of only a file was an
// empty pill. Drawn as cards now; what the CLI receives is unchanged.

const P = "/Users/me/projects/STATS-67/.nightloom/attachments/7f3c/Lab4_SamplingDist.html";
// Byte for byte as `attach::files_note` writes it.
const one = `[Attached a file — saved for you to open with your tools:\n- ${P}]`;
const two = "[Attached files — saved for you to open with your tools:\n- /w/a.zip\n- /w/b (2).zip]";
const pdf =
  "[Attached a PDF of 42 pages, saved for you to read with your tools rather than sent whole:\n- /w/deck.pdf\n" +
  'Pull its text first (`"/opt/homebrew/bin/pdftotext" -layout "/w/deck.pdf" -`, or `-f A -l B` for pages A to B) to find what the question needs, then Read only those pages with the Read tool\'s `pages` parameter (at most 20 a call) to see them as drawn — figures, equations and diagrams are not in the text.]';

describe("splitAttachNote", () => {
  it("takes the note off his words and names its files", () => {
    const s = splitAttachNote(`Is this ready to submit then\n\n${one}`);
    expect(s.said).toBe("Is this ready to submit then");
    expect(s.files).toEqual([{ path: P, name: "Lab4_SamplingDist.html" }]);
    expect(s.note).toBe(one);
  });
  it("reads a file-only message as no words", () => {
    expect(splitAttachNote(one)).toEqual({ said: "", files: [{ path: P, name: "Lab4_SamplingDist.html" }], note: one });
  });
  it("reads several files, and the long-PDF note after the files note", () => {
    const s = splitAttachNote(`look\n\n${two}\n\n${pdf}`);
    expect(s.said).toBe("look");
    expect(s.files.map((f) => f.name)).toEqual(["a.zip", "b (2).zip", "deck.pdf"]);
    expect(s.files[2].pages).toBe(42);
    expect(savedFilePaths(`look\n\n${two}\n\n${pdf}`)).toEqual(["/w/a.zip", "/w/b (2).zip", "/w/deck.pdf"]);
  });
  it("leaves words that only look like a note as his", () => {
    for (const t of ["[Attached a cat picture]", "plain words", `${one} and then more`, `see this:[Attached a file — saved for you to open with your tools:\n- /x]`])
      expect(splitAttachNote(t)).toEqual({ said: t, files: [], note: "" });
  });
  it("keeps his own trailing newline", () => {
    expect(splitAttachNote(`hi\n\n\n${one}`).said).toBe("hi\n");
  });
});

describe("joinAttachNote: an edit keeps the note exactly", () => {
  it("round-trips the backend's join", () => {
    for (const t of [`Is this ready\n\n${one}`, one, `a\n\nb\n\n${two}\n\n${pdf}`, `hi\n\n\n${one}`, "no files"]) {
      const s = splitAttachNote(t);
      expect(joinAttachNote(s.said, s.note)).toBe(t);
    }
  });
  it("puts the note back after new words, or alone when the words are blank", () => {
    expect(joinAttachNote("new words", one)).toBe(`new words\n\n${one}`);
    expect(joinAttachNote("  ", one)).toBe(one);
  });
});

describe("one-line views: titles, the navigator, the phone", () => {
  it("names a chat by his words, else the files", () => {
    expect(shownText(one)).toBe("Lab4_SamplingDist.html");
    expect(shownText(`Is this ready\n\n${one}`)).toBe("Is this ready");
    expect(nameLine(one)).toBe("Lab4_SamplingDist.html");
    expect(chatLabel({ title: null, first_user: `${two}` }, "New chat")).toBe("a.zip, b (2).zip");
  });
  it("gives the navigator's tick the words, not the note", () => {
    const evs: SessionEvent[] = [
      { event: "user_message", text: one, at: "2026-11-09T20:00:00Z" },
      { event: "user_message", text: `Is this ready\n\n${one}`, at: "2026-11-09T20:01:00Z" },
    ];
    const t = ticks(evs, [true, true]);
    expect(t[0].first_line).toBe("Lab4_SamplingDist.html");
    expect(t[1].first_line).toBe("Is this ready");
    expect(t.map((x) => x.preview).join(" ")).not.toContain("saved for you");
  });
  it("gives the phone's row his words and the file names", () => {
    const rows = transcriptRows([
      { event: "session_created", id: "c1", at: "2026-11-09T20:00:00Z" },
      { event: "user_message", text: `Is this ready\n\n${one}`, at: "2026-11-09T20:00:00Z", documents: [{ media_type: "application/pdf", name: "brief.pdf", data: "JVBERi0x" }] },
    ]);
    const u = rows.find((r) => r.kind === "user");
    expect(u && u.kind === "user" && u.said).toBe("Is this ready");
    expect(u && u.kind === "user" && u.files).toEqual(["brief.pdf", "Lab4_SamplingDist.html"]);
    expect(u && u.kind === "user" && u.text).toContain("saved for you"); // kept for an edit
  });
});

describe("cleanPassage: a search hit never shows the note", () => {
  const flat = (t: string) => t.replace(/\s+/g, " ");
  it("leaves a passage with no note alone", () => {
    const r = { before: "…we said ", matched: "ready", after: " to go" };
    expect(cleanPassage(r)).toBe(r);
  });
  it("draws a whole note as the file names, the match after it intact", () => {
    const r = { before: "", matched: "ready", after: "" };
    const s = flat(`${one} ready`);
    const at = s.indexOf("ready");
    const out = cleanPassage({ before: s.slice(0, at), matched: "ready", after: s.slice(at + 5) });
    expect(out.before + out.matched + out.after).toBe("[attached Lab4_SamplingDist.html] ready");
    expect(out.matched).toBe(r.matched);
  });
  it("marks the part of the name a match inside the note hit", () => {
    const s = flat(`Is this ready to submit then ${one}`);
    const at = s.indexOf("Lab4");
    const out = cleanPassage({ before: s.slice(0, at), matched: "Lab4", after: s.slice(at + 4) });
    expect(out.before).toBe("Is this ready to submit then [attached ");
    expect(out.matched).toBe("Lab4");
    expect(out.after).toBe("_SamplingDist.html]");
  });
  it("handles a note cut by the window at either end", () => {
    const tail = cleanPassage({ before: "…ments/7f3c/", matched: "Lab4", after: "_SamplingDist.html]" });
    expect(tail.before + tail.matched + tail.after).toBe("[attached Lab4_SamplingDist.html]");
    expect(tail.matched).toBe("Lab4");
    const head = cleanPassage({ before: "", matched: "ready", after: " to submit [Attached a file — saved for you to open with your tools: - /Users/me/proj…" });
    expect(head.matched).toBe("ready");
    expect(head.after).not.toContain("saved for you");
  });
  it("cleans the long-PDF note too", () => {
    const s = flat(`deck please ${pdf}`);
    const out = cleanPassage({ before: "", matched: "deck", after: s.slice(4) });
    expect(out.matched).toBe("deck");
    expect(out.after).toBe(" please [attached deck.pdf]");
  });
});

describe("UserBubble draws files as cards, never the note, never an empty pill", () => {
  const project = { id: "s67", name: "STATS-67", unfiled: false } as ProjectInfo;
  afterEach(() => {
    app.project = null;
  });
  it("a file-only message: one card, no words", () => {
    app.project = project;
    const { body } = render(UserBubble, { props: { text: one } });
    expect(body).toMatch(/class="attach-card[ "]/);
    expect(body).toContain("Lab4_SamplingDist.html");
    expect(body).toContain("HTML file · saved for Claude to open with its tools");
    expect(body).toContain("Keep in project");
    expect(body).not.toContain("saved for you to open");
    expect(body).not.toContain("user-text");
  });
  it("draws the card with no project too, without Keep", () => {
    const { body } = render(UserBubble, { props: { text: one } });
    expect(body).toContain("Lab4_SamplingDist.html");
    expect(body).not.toContain("Keep in project");
  });
  it("file and words: the card, then his words alone", () => {
    const { body } = render(UserBubble, { props: { text: `Is this ready to submit then\n\n${one}` } });
    expect(body).toContain("Is this ready to submit then");
    expect(body).not.toContain("[Attached");
  });
  it("a PDF only and a text file only: their cards", () => {
    const { body } = render(UserBubble, {
      props: {
        text: "",
        documents: [
          { media_type: "application/pdf", name: "brief.pdf", data: "JVBERi0x" },
          { media_type: "text/plain", name: "notes.txt", data: btoa("one two three") },
        ],
      },
    });
    expect(body).toContain("brief.pdf");
    expect(body).toContain("PDF · sent with this message");
    expect(body).toContain("notes.txt");
    expect(body).toContain("Text · sent with this message as text");
  });
  it("while the backend saves it: the name, not an empty pill", () => {
    const { body } = render(UserBubble, { props: { text: "", sending: ["Lab4_SamplingDist.html"] } });
    expect(body).toContain("Lab4_SamplingDist.html");
    expect(body).toContain("saving for Claude");
    // Once the log's note names it, one card, not two.
    const after = render(UserBubble, { props: { text: one, sending: ["Lab4_SamplingDist.html"] } }).body;
    expect(after.split('class="attach-name').length - 1).toBe(1);
  });
  it("a long PDF sent by path says its pages", () => {
    const { body } = render(UserBubble, { props: { text: pdf } });
    expect(body).toContain("deck.pdf");
    expect(body).toContain("PDF · 42 pages");
    expect(body).not.toContain("pdftotext");
  });
});
