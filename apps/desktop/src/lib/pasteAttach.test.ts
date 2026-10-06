import { describe, expect, it } from "vitest";
import {
  LONG_PASTE_WORDS,
  PASTED_NAME,
  canUndo,
  decodeText,
  followOffer,
  isPasteAsAttachmentKey,
  longPasteOffer,
  pasteAction,
  pastedFile,
  pastedLabel,
  pastedName,
  undoConverted,
  withoutSpan,
  wordCount,
  type Converted,
} from "./pasteAttach";
import { decide, looksLikeText, routeOf, badgeOf } from "./attachKinds";
import { loadDrafts, PERSIST_ATTACHMENT_MAX, saveDrafts, serializeDrafts } from "./drafts.svelte";
import type { Attachment } from "./types";

// Paste as an attachment (nightshift item 284). ⌘V is unchanged; ⌥⌘V
// (⌘⇧V is the clipboard history, blocker 942) attaches; a long ⌘V paste
// is offered as an attachment, undoably; the chip keeps with the draft.

const key = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  code: "KeyV",
  ...o,
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("the keys", () => {
  it("⌥⌘V and Ctrl+Alt+V paste as an attachment", () => {
    expect(isPasteAsAttachmentKey(key({ metaKey: true, altKey: true }))).toBe(true);
    expect(isPasteAsAttachmentKey(key({ ctrlKey: true, altKey: true }))).toBe(true);
  });
  it("⌘V, ⌘⇧V (the clipboard history) and ⌥⇧⌘V are not it", () => {
    expect(isPasteAsAttachmentKey(key({ metaKey: true }))).toBe(false);
    expect(isPasteAsAttachmentKey(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteAsAttachmentKey(key({ metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteAsAttachmentKey(key({ metaKey: true, altKey: true, code: "KeyC" }))).toBe(false);
  });
});

describe("what a paste does", () => {
  it("⌘V: text goes into the box, however long", () => {
    expect(pasteAction(false, "hello", 0)).toBe("box");
    expect(pasteAction(false, words(5000), 0)).toBe("box");
  });
  it("⌥⌘V: text becomes an attachment", () => {
    expect(pasteAction(true, "hello", 0)).toBe("attach");
  });
  it("⌥⌘V with an image on the clipboard pastes as ⌘V", () => {
    expect(pasteAction(true, "", 1)).toBe("box");
    expect(pasteAction(true, "a caption", 1)).toBe("box");
  });
  it("⌥⌘V with nothing to attach says so", () => {
    expect(pasteAction(true, "", 0)).toBe("empty");
  });
});

describe("the chip", () => {
  it("is named Pasted text, numbered when the box has one", () => {
    expect(pastedName([])).toBe(PASTED_NAME);
    expect(pastedName(["Pasted text"])).toBe("Pasted text (2)");
    expect(pastedName(["Pasted text", "Pasted text (2)"])).toBe("Pasted text (3)");
  });
  it("counts words", () => {
    expect(wordCount("  one\ttwo\nthree  ")).toBe(3);
    expect(pastedLabel(words(1240))).toBe("1,240 words");
    expect(pastedLabel("one")).toBe("1 word");
  });
  it("takes item 277's text route: a TXT text attachment", async () => {
    const f = pastedFile("héllo — wörld", "Pasted text");
    expect(routeOf(f.name, f.type)).toBe("text");
    const bytes = new Uint8Array(await f.arrayBuffer());
    expect(looksLikeText(bytes)).toBe(true);
    expect(decide(f.name, f.size, true, "api")).toEqual({ as: "text" });
    expect(badgeOf({ kind: "document", media_type: "text/plain", name: f.name })).toBe("TXT");
  });
  it("decodes for the transcript's fold (UTF-8)", () => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("naïve ∑ text")));
    expect(decodeText(b64)).toBe("naïve ∑ text");
    expect(decodeText("%%%")).toBe("");
  });
});

describe("the long ⌘V paste's offer", () => {
  const long = words(LONG_PASTE_WORDS + 1);

  it("only past the threshold", () => {
    expect(longPasteOffer(words(LONG_PASTE_WORDS), 0)).toBeNull();
    expect(longPasteOffer(long, 0)).not.toBeNull();
  });

  it("stands once the paste lands, and goes on the next edit", () => {
    const o0 = longPasteOffer(long, 4)!;
    const landed = "abc " + long + " xyz";
    const o1 = followOffer(o0, landed);
    expect(o1?.after).toBe(landed);
    expect(followOffer(o1, landed)).toBe(o1);
    expect(followOffer(o1, landed + "!")).toBeNull();
    // A send clears the box: gone.
    expect(followOffer(o1, "")).toBeNull();
  });

  it("CRLF on the clipboard matches the box's newlines", () => {
    const crlf = long.replace(/ /g, "\r\n");
    const o = followOffer(longPasteOffer(crlf, 0), long.replace(/ /g, "\n"));
    expect(o).not.toBeNull();
  });

  it("converts, and Undo restores the text exactly", () => {
    const before = "Please read: " + long + "\nThanks";
    const o = followOffer(longPasteOffer(long, 13), before)!;
    const after = withoutSpan(before, o);
    expect(after).toBe("Please read: \nThanks");
    const c: Converted = { before, after: after!, chipId: 7, caret: 13 };
    expect(canUndo(c, after!, [7])).toBe(true);
    const r = undoConverted(c);
    expect(r.text).toBe(before);
    expect(r.caret).toBe(13 + long.length);
  });

  it("Undo is gone after an edit, a send, or the chip's removal", () => {
    const c: Converted = { before: "x" + long, after: "x", chipId: 3, caret: 1 };
    expect(canUndo(c, "xy", [3])).toBe(false);
    expect(canUndo(c, "x", [])).toBe(false);
    expect(canUndo(null, "x", [3])).toBe(false);
  });

  it("a span no longer there is not cut", () => {
    const o = followOffer(longPasteOffer(long, 0), long)!;
    expect(withoutSpan("edited " + long, o)).toBeNull();
  });
});

describe("the pasted chip keeps with the draft", () => {
  const big: Attachment = {
    id: 1,
    kind: "document",
    media_type: "text/plain",
    name: "Pasted text",
    data: "a".repeat(PERSIST_ATTACHMENT_MAX + 10),
    label: "90,000 words",
    pasted: true,
  };
  const dropped: Attachment = { ...big, id: 2, name: "big.txt", pasted: undefined, label: "text" };

  it("past the per-attachment cap, where a dropped file is not kept", () => {
    const out = JSON.parse(serializeDrafts({ chat: { text: "", attachments: [big, dropped], queue: [] } }));
    expect(out.chat.attachments.map((a: Attachment) => a.name)).toEqual(["Pasted text"]);
    expect(out.chat.attachments[0].pasted).toBe(true);
  });

  it("round-trips a reload with its name, label and flag", () => {
    const store = new Map<string, string>();
    saveDrafts({ chat: { text: "hi", attachments: [big], queue: [] } }, { setItem: (k, v) => void store.set(k, v) });
    const back = loadDrafts({ getItem: (k) => store.get(k) ?? null });
    expect(back.chat.attachments[0]).toMatchObject({ name: "Pasted text", label: "90,000 words", pasted: true });
    expect(back.chat.attachments[0].data.length).toBe(big.data.length);
  });

  it("survives the over-quota fallback, which drops other attachments", () => {
    let calls = 0;
    let written = "";
    saveDrafts(
      { chat: { text: "hi", attachments: [{ ...big, data: "abc" }, { ...dropped, data: "def" }], queue: [] } },
      {
        setItem: (_k, v) => {
          if (calls++ === 0) throw new Error("QuotaExceededError");
          written = v;
        },
      },
    );
    const out = JSON.parse(written);
    expect(out.chat.text).toBe("hi");
    expect(out.chat.attachments.map((a: Attachment) => a.name)).toEqual(["Pasted text"]);
  });
});

describe("item 318: dismissing the long-paste offer", () => {
  it("a dismissed offer (null) stays gone for the same paste, whatever the box does", () => {
    const pasted = Array.from({ length: LONG_PASTE_WORDS + 5 }, () => "w").join(" ");
    const box = "intro " + pasted;
    const o = followOffer(longPasteOffer(pasted, 6), box);
    expect(o).not.toBeNull();
    // The × or Esc sets the offer to null; only a new paste makes one.
    expect(followOffer(null, box)).toBeNull();
    expect(followOffer(null, box + " more")).toBeNull();
    expect(followOffer(null, box)).toBeNull();
  });
});
