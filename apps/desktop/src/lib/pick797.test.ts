// Item 797 (point at it): what a pick reads off an element, the words the
// model is sent, the crop's box, and that a pick chip survives the drafts
// store and reaches the wire.
import { describe, expect, it } from "vitest";
import {
  componentOfClass,
  componentsOf,
  cropBox,
  isPickInfo,
  pickDocuments,
  pickLine,
  pickName,
  pickTarget,
  pickText,
  selectorOf,
  themeOf,
  type PickInfo,
} from "./pick";
import { midTurnWire } from "./midTurn";
import { loadDrafts, serializeDrafts } from "./drafts.svelte";
import type { Attachment } from "./types";

/** A stand-in for a DOM element: just what `pick.ts` reads. */
function el(tag: string, classes: string[] = [], attrs: Record<string, string> = {}, parent: unknown = null): Element {
  const all = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  return {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    classList: classes,
    attributes: all,
    getAttribute: (n: string) => attrs[n] ?? null,
    parentElement: parent,
  } as unknown as Element;
}

const info: PickInfo = {
  where: "nightloom",
  components: ["Composer", "ChatView"],
  selector: "div.composer > div.row > button.ns-btn.attach[aria-label=\"Attach files\"]",
  tag: "button",
  text: "Attach",
  label: 'aria-label="Attach files"',
  rect: { x: 100, y: 500, w: 32, h: 28 },
  viewport: { w: 1280, h: 800 },
  zoom: "100%",
  theme: "Jarvis, dark, palette A",
};

describe("item 797: the component from Svelte's scoping class", () => {
  it("reads the name svelte.config.js adds, and nothing from a bare hash", () => {
    expect(componentOfClass("svelte-1abc2d-Composer")).toBe("Composer");
    expect(componentOfClass("svelte-1abc2d")).toBeNull();
    expect(componentOfClass("attach")).toBeNull();
  });
  it("names the nearest components first, each once", () => {
    const outer = el("main", ["svelte-zz9-ChatView"]);
    const mid = el("div", ["composer", "svelte-aa1-Composer"], {}, outer);
    const btn = el("button", ["ns-btn", "svelte-aa1-Composer"], {}, mid);
    expect(componentsOf(btn)).toEqual(["Composer", "ChatView"]);
  });
});

describe("item 797: the selector", () => {
  it("keeps his classes and a naming attribute, drops the scoping classes", () => {
    const root = el("div", ["composer", "svelte-aa1-Composer"]);
    const row = el("div", ["row", "svelte-aa1-Composer"], {}, root);
    const btn = el("button", ["ns-btn", "attach", "svelte-aa1-Composer"], { "aria-label": "Attach files" }, row);
    expect(selectorOf(btn)).toBe('div.composer > div.row > button.attach.ns-btn[aria-label="Attach files"]');
  });
  it("stops at an id", () => {
    const app = el("div", [], { id: "root" });
    const span = el("span", ["x"], {}, app);
    expect(selectorOf(span)).toBe("div#root > span.x");
  });
  it("is at most five steps", () => {
    let e: Element | null = null;
    for (let i = 0; i < 9; i++) e = el("div", [`d${i}`], {}, e);
    expect(selectorOf(e as Element).split(" > ")).toHaveLength(5);
  });
});

describe("item 797: the theme", () => {
  it("is Jarvis unless the root says Classic, with scheme and palette", () => {
    expect(themeOf({ dataset: { scheme: "dark", palette: "A" } } as unknown as HTMLElement)).toBe("Jarvis, dark, palette A");
    expect(themeOf({ dataset: { layout: "classic" } } as unknown as HTMLElement)).toBe("Classic");
  });
});

describe("item 797: the words and the chip", () => {
  it("say the file, selector, text, size, zoom and theme, and which image is the crop", () => {
    const t = pickText(info, 2);
    expect(t).toContain("the crop is image 2");
    expect(t).toContain("Composer.svelte inside ChatView.svelte");
    expect(t).toContain('button.ns-btn.attach[aria-label="Attach files"]');
    expect(t).toContain('text: "Attach"');
    expect(t).toContain("32×28 at (100, 500) CSS px in a 1280×800 window, zoom 100%");
    expect(t).toContain("theme: Jarvis, dark, palette A");
  });
  it("in Claude's browser: the page, no component or theme", () => {
    const t = pickText({ ...info, where: "browser", components: [], url: "https://example.com/" }, 1);
    expect(t).toContain("in Claude's browser tab");
    expect(t).toContain("page: https://example.com/");
    expect(t).not.toContain("component:");
    expect(t).not.toContain("theme:");
  });
  it("the chip's line and file name", () => {
    expect(pickLine(info)).toBe("Composer · button · 32×28");
    expect(pickName(info, 3)).toBe("pick-3-Composer.png");
  });
});

describe("item 797: the crop's box", () => {
  it("is the element and 8 px around it, at the shot's scale", () => {
    expect(cropBox({ x: 100, y: 50, w: 40, h: 20 }, 2, { w: 2560, h: 1600 })).toEqual({ sx: 184, sy: 84, sw: 112, sh: 72 });
  });
  it("is clamped to the shot", () => {
    expect(cropBox({ x: 0, y: 0, w: 1300, h: 900 }, 1, { w: 1280, h: 800 })).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 800 });
  });
});

const chip = (id: number, over: Partial<Attachment> = {}): Attachment => ({
  id,
  kind: "image",
  media_type: "image/png",
  name: `pick-${id}.png`,
  data: "iVBORw0KGgo=",
  ...over,
});

describe("item 797: on the wire", () => {
  it("each pick crop brings its words as a text block naming its image", () => {
    const chips = [chip(1, { name: "photo.png" }), chip(2, { pick: info })];
    const docs = pickDocuments(chips);
    expect(docs).toHaveLength(1);
    expect(docs[0].media_type).toBe("text/plain");
    const words = new TextDecoder().decode(Uint8Array.from(atob(docs[0].data), (c) => c.charCodeAt(0)));
    expect(words).toContain("the crop is image 2");
    expect(words).toContain("Composer.svelte");
  });
  it("a crop-less pick is a text chip already, so it brings no second block", () => {
    expect(pickDocuments([chip(1, { kind: "document", media_type: "text/plain", pick: info })])).toEqual([]);
  });
  it("joins a running turn with its words (mid-turn)", () => {
    const w = midTurnWire([chip(1, { pick: info })]);
    expect(w?.images).toHaveLength(1);
    expect(w?.documents).toHaveLength(1);
  });
});

describe("item 797: the drafts store keeps a pick", () => {
  it("through a write and a read", () => {
    const raw = serializeDrafts({ k: { text: "", attachments: [chip(4, { pick: info, label: pickLine(info) })], queue: [] } });
    const back = loadDrafts({ getItem: () => raw });
    const a = back.k.attachments[0];
    expect(isPickInfo(a.pick)).toBe(true);
    expect(a.pick?.components).toEqual(["Composer", "ChatView"]);
  });
});

describe("item 797: what a click means", () => {
  /** A stand-in with `closest` over tag names and roles. */
  function node(tag: string, parent: Element | null = null, role = ""): Element {
    const e = {
      tagName: tag.toUpperCase(),
      parentElement: parent,
      getAttribute: (n: string) => (n === "role" ? role || null : null),
      closest(sel: string): Element | null {
        const tags = sel.split(",").map((s) => s.trim());
        for (let x: Element | null = e as unknown as Element; x; x = x.parentElement) {
          const t = x.tagName.toLowerCase();
          if (tags.some((s) => s === t || (s === "a[href]" && t === "a") || (s.startsWith("[role=") && s.includes(`"${x.getAttribute("role")}"`)))) return x;
        }
        return null;
      },
    };
    return e as unknown as Element;
  }
  it("an icon's path is its button", () => {
    const btn = node("button");
    const svg = node("svg", btn);
    expect(pickTarget(node("path", svg))).toBe(btn);
  });
  it("a label span inside a button is the button; plain text stays itself", () => {
    const btn = node("button");
    expect(pickTarget(node("span", btn))).toBe(btn);
    const p = node("p", node("div"));
    expect(pickTarget(p)).toBe(p);
  });
});

describe("item 797: the selector puts his own classes before the shared look", () => {
  it("names .attach before ns-btn ghost small", () => {
    const btn = el("button", ["ns-btn", "ghost", "small", "attach", "svelte-aa1-Composer"]);
    expect(selectorOf(btn)).toBe("button.attach.ns-btn.ghost");
  });
});
