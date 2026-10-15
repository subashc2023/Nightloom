import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import editAttachSrc from "./EditAttachments.svelte?raw";
import asideCardSrc from "./AsideCard.svelte?raw";
import {
  CHIP_FADE_RM_MS,
  CHIP_MS,
  CHIP_STAGGER_MS,
  DropMarks,
  carriesFiles,
  chipDropIn,
  dropKind,
  landTiles,
  veilClip,
  zoneRect,
  zoneTitle,
} from "./dropLook";

/** A stand-in for an element: its attributes and its ancestors'. */
class El {
  classList = new Set<string>();
  constructor(
    private attrs: Record<string, string>,
    private parent: El | null = null,
  ) {}
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  closest(sel: string): El | null {
    const name = sel.slice(1, -1);
    for (let e: El | null = this; e; e = e.parent) if (name in e.attrs) return e;
    return null;
  }
  getBoundingClientRect() {
    return { left: 100, top: 500, width: 600, height: 120 };
  }
}
const win = new El({});
const chat = new El({ "data-drop-chat": "" }, win);
const bubble = new El({}, chat);
const main = new El({ "data-drop-box": "main" }, win);
const textarea = new El({}, main);
const edit = new El({ "data-drop-box": "edit" }, chat);
const sidebar = new El({}, win);
// An aside card drawn inline in the chat, its thread and its own box.
const asideCard = new El({ "data-drop-none": "" }, chat);
const asideThread = new El({}, asideCard);
const asideBox = new El({ "data-drop-box": "aside" }, asideCard);

describe("362: which box a file drag is over", () => {
  it("names the chat, the chat's box, another box, or nothing", () => {
    expect(dropKind(bubble).kind).toBe("chat");
    expect(dropKind(textarea).kind).toBe("main");
    expect(dropKind(textarea).box).toBe(main);
    // The edit box sits inside the chat, and takes its own drop.
    expect(dropKind(edit).kind).toBe("box");
    expect(dropKind(sidebar).kind).toBe("none");
    expect(dropKind(null).kind).toBe("none");
  });
  it("an aside card in the chat takes no drop for the chat's box; its own box takes its own (review)", () => {
    expect(dropKind(asideThread).kind).toBe("none");
    expect(dropKind(asideBox).kind).toBe("box");
    expect(dropKind(asideBox).box).toBe(asideBox);
  });
  it("follows only drags that carry files", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
  it("says where the drop goes, with no count (WebKit gives none while dragging)", () => {
    expect(zoneTitle("chat")).toBe("Drop anywhere in the chat");
    expect(zoneTitle("main")).toBe("Drop to attach");
  });
});

describe("362: the zone and the veil", () => {
  const chatR = { left: 232, top: 40, width: 1208, height: 700 };
  const card = { left: 456, top: 760, width: 760, height: 110 };
  it("sits above the composer, as wide as the box, up to 170 px", () => {
    expect(zoneRect(chatR, card, 740)).toEqual({ left: 456, top: 740 - 14 - 170, width: 760, height: 170 });
  });
  it("shrinks in a short chat and goes when there is no room", () => {
    expect(zoneRect({ ...chatR, height: 120 }, card, 160)?.height).toBe(160 - 14 - 40 - 14);
    expect(zoneRect({ ...chatR, height: 60 }, card, 100)).toBeNull();
  });
  it("cuts a hole for a composer inside the chat, none for one below it", () => {
    expect(veilClip(chatR, { left: 300, top: 760, width: 700, height: 100 })).toBeNull();
    expect(veilClip(chatR, { left: 332, top: 340, width: 700, height: 100 })).toBe(
      'path(evenodd, "M0 0H1208V700H0Z M100 300H800V400H100Z")',
    );
  });
});

describe("362: the chip arriving (A)", () => {
  it("opens the row, scales in with an overshoot and fades its ring, staggered", () => {
    const m = chipDropIn(2, 64, false);
    expect(m.delay).toBe(2 * CHIP_STAGGER_MS);
    expect(m.duration).toBe(CHIP_MS);
    const at0 = m.css!(0);
    expect(at0).toContain("width: 0.00px");
    expect(at0).toContain("scale(0.8200)");
    expect(at0).toContain("var(--accent) 70%");
    const peak = Math.max(...[0.5, 0.6, 0.7, 0.8].map((k) => Number(/scale\(([\d.]+)\)/.exec(m.css!(k))![1])));
    expect(peak).toBeGreaterThan(1);
    const at1 = m.css!(1);
    expect(at1).toContain("width: 64.00px");
    expect(at1).toContain("scale(1.0000)");
    expect(at1).toContain("var(--accent) 0%");
  });
  it("only fades in under reduced motion", () => {
    const m = chipDropIn(1, 64, true);
    expect(m.duration).toBe(CHIP_FADE_RM_MS);
    expect(m.delay).toBeUndefined();
    expect(m.css!(0.5)).toBe("opacity: 0.5");
  });
  it("marks are one-shot and lapse", () => {
    const marks = new DropMarks(1000);
    marks.mark(["a.png", "b.pdf"], 0);
    expect(marks.recent(10)).toBe(true);
    expect(marks.take("b.pdf", 10)).toBe(1);
    expect(marks.take("b.pdf", 10)).toBeNull();
    expect(marks.take("a.png", 5000)).toBeNull();
    expect(marks.recent(5000)).toBe(false);
  });
  it("draws up to three of the dropped files and counts the rest", () => {
    const f = (name: string, type: string) => new File(["x"], name, { type });
    const { tiles, more } = landTiles([f("a.png", "image/png"), f("b.pdf", "application/pdf"), f("c", ""), f("d.png", "image/png")]);
    expect(tiles.map((t) => (t.kind === "doc" ? t.ext : "img"))).toEqual(["img", "PDF", "FILE"]);
    expect(more).toBe(1);
  });
});

describe("362: the window watcher", () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  let accepted: File[][] = [];
  let mod: typeof import("./dropLook.svelte");
  let unwatch: () => void;
  let unregister: () => void;
  const files = [new File(["x"], "shot.png", { type: "image/png" }), new File(["y"], "notes.pdf", { type: "application/pdf" })];
  const ev = (target: El, extra: Record<string, unknown> = {}) => {
    const e = {
      target,
      clientX: 400,
      clientY: 300,
      relatedTarget: null,
      dataTransfer: { types: ["Files"], files: [] as File[], dropEffect: "none" },
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      ...extra,
    };
    return e;
  };
  beforeEach(async () => {
    vi.stubGlobal("window", {
      addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
      removeEventListener: () => {},
    });
    // The real classList is a DOMTokenList; the stand-in's Set has add/delete.
    for (const e of [main, edit]) Object.assign(e.classList, { remove: (c: string) => e.classList.delete(c) });
    mod = await import("./dropLook.svelte");
    accepted = [];
    unwatch = mod.watchDrops();
    unregister = mod.registerChatDrop({ accept: (f) => accepted.push(f), card: () => main as unknown as Element });
  });
  afterEach(() => {
    unregister();
    unwatch();
    vi.unstubAllGlobals();
  });

  it("raises the veil over the chat and takes the drop there for the chat's box", () => {
    listeners.dragenter(ev(bubble));
    expect(mod.drop.kind).toBe("chat");
    const over = ev(bubble);
    listeners.dragover(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    const d = ev(bubble);
    d.dataTransfer.files = files;
    listeners.drop(d);
    expect(d.defaultPrevented).toBe(true);
    expect(accepted).toEqual([files]);
    expect(mod.drop.kind).toBe("idle");
    // The landing travels to the box's chip row, and the chips are marked.
    expect(mod.drop.landings.at(-1)).toMatchObject({ x: 400, y: 300, toX: 140, toY: 470, more: 0 });
    expect(mod.takeDropped("notes.pdf")).toBe(1);
    expect(mod.takeDropped("shot.png")).toBe(0);
  });

  it("turns the zone on over the box, and leaves a box's drop to the box", () => {
    listeners.dragenter(ev(textarea));
    listeners.dragover(ev(textarea));
    expect(mod.drop.kind).toBe("main");
    expect(main.classList.has("drop-over")).toBe(true);
    const d = ev(textarea);
    d.dataTransfer.files = files;
    listeners.drop(d);
    expect(d.defaultPrevented).toBe(false);
    expect(accepted).toEqual([]);
    expect(main.classList.has("drop-over")).toBe(false);
    // Into the box it was dropped on: the landing shrinks in place.
    expect(mod.drop.landings.at(-1)).toMatchObject({ toX: 400, toY: 300 });
    expect(mod.takeDropped("shot.png")).toBe(0);
  });

  it("a drop on an aside card's thread is not handed to the chat's composer (review)", () => {
    listeners.dragenter(ev(asideThread));
    const over = ev(asideThread);
    listeners.dragover(over);
    expect(mod.drop.kind).toBe("none");
    expect(over.defaultPrevented).toBe(false);
    const d = ev(asideThread);
    d.dataTransfer.files = files;
    listeners.drop(d);
    expect(accepted).toEqual([]);
    expect(d.defaultPrevented).toBe(false);
  });

  it("drops the veil of a drag that pauses, goes on, then vanishes without a dragleave (review)", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    try {
      listeners.dragenter(ev(bubble));
      listeners.dragover(ev(bubble));
      expect(mod.drop.kind).toBe("chat");
      vi.advanceTimersByTime(2100);
      expect(mod.drop.kind).toBe("idle");
      // The drag goes on: dragover again, then nothing more — no dragleave.
      listeners.dragover(ev(bubble));
      expect(mod.drop.kind).toBe("chat");
      vi.advanceTimersByTime(2100);
      expect(mod.drop.kind).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the edit box held over, takes nothing outside the chat, ignores non-file drags", () => {
    listeners.dragenter(ev(edit));
    listeners.dragover(ev(edit));
    expect(mod.drop.kind).toBe("box");
    expect(edit.classList.has("drop-over")).toBe(true);
    const out = ev(sidebar);
    listeners.dragover(out);
    expect(mod.drop.kind).toBe("none");
    expect(out.defaultPrevented).toBe(false);
    expect(edit.classList.has("drop-over")).toBe(false);
    listeners.dragleave(ev(sidebar));
    expect(mod.drop.kind).toBe("idle");
    const text = ev(bubble, { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } });
    listeners.dragenter(text);
    expect(mod.drop.kind).toBe("idle");
  });
});

describe("362: wired into the boxes", () => {
  it("the live transcript and the empty chat take a drop for the chat; read-only panes do not", () => {
    expect(transcriptSrc).toContain('data-drop-chat={inPane ? undefined : ""}');
    expect(welcomeSrc).toContain('class="welcome" data-drop-chat');
  });
  it("the composer, the aside box and the edit box are boxes; only the chat's composer draws the overlay", () => {
    expect(composerSrc).toContain('data-drop-box={aside ? "aside" : "main"}');
    expect(transcriptSrc).toContain('class="editor" data-drop-box="edit"');
    expect(asideCardSrc).toMatch(/class="aside-card"\s+data-drop-none/);
    expect(composerSrc).toMatch(/\{#if aside === null\}\s*<!--[^]*?-->\s*<DropOverlay /);
  });
  it("dropped chips arrive with the drop's motion in the composer and the edit box", () => {
    expect(composerSrc).toContain("const dropped = takeDropped(a.name);");
    expect(composerSrc).toContain('<div class="attachments" in:rowIn>');
    expect(editAttachSrc).toContain('<div class="face" in:chipIn={a}>');
  });
});
