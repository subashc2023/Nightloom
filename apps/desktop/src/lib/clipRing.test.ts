import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIP_IMAGE_PERSIST_MAX,
  CLIP_MAX,
  CLIP_TEXT_PERSIST_MAX,
  clips,
  copyText,
  loadClips,
  pushClip,
  recordImage,
  recordText,
  serializeClips,
} from "./clipRing.svelte";
import type { ClipEntry } from "./clipRing.svelte";
import { app } from "./state.svelte";

const t = (text: string, source: ClipEntry["source"] = "copied", at = "2026-09-22T19:00:00Z"): ClipEntry => ({
  kind: "text",
  text,
  source,
  at,
});
const img = (data: string): ClipEntry => ({
  kind: "image",
  media_type: "image/png",
  data,
  name: "pasted image",
  source: "pasted",
  at: "2026-09-22T19:00:00Z",
});

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  } as Storage;
}

describe("pushClip — the ring's order and cap", () => {
  it("puts the newest first", () => {
    let r: ClipEntry[] = [];
    r = pushClip(r, t("one"));
    r = pushClip(r, img("AAAA"));
    r = pushClip(r, t("three", "sent"));
    expect(r.map((e) => (e.kind === "text" ? e.text : e.data))).toEqual(["three", "AAAA", "one"]);
  });

  it(`keeps ${CLIP_MAX} and drops the oldest`, () => {
    let r: ClipEntry[] = [];
    for (let i = 0; i < CLIP_MAX + 5; i++) r = pushClip(r, t(`n${i}`));
    expect(r).toHaveLength(CLIP_MAX);
    expect(r[0]).toMatchObject({ text: `n${CLIP_MAX + 4}` });
    expect(r[CLIP_MAX - 1]).toMatchObject({ text: "n5" });
  });

  it("moves a repeat to the top rather than listing it twice", () => {
    let r = [t("b"), t("a")];
    r = pushClip(r, t("a", "pasted"));
    expect(r.map((e) => (e.kind === "text" ? `${e.text}:${e.source}` : ""))).toEqual(["a:pasted", "b:copied"]);
    r = pushClip([img("X"), t("y")], img("X"));
    expect(r).toHaveLength(2);
  });

  it("ignores blank text", () => {
    expect(pushClip([t("a")], t("  \n "))).toEqual([t("a")]);
  });
});

describe("the store", () => {
  it("round-trips, newest first", () => {
    const ring = [t("two", "sent"), img("QUJD"), t("one")];
    const s = memStore();
    s.setItem("nightloom.clip-ring", serializeClips(ring));
    expect(loadClips(s)).toEqual(ring);
  });

  it("leaves a large image out of the store and cuts a long text", () => {
    const big = "A".repeat(CLIP_IMAGE_PERSIST_MAX + 1);
    const long = "x".repeat(CLIP_TEXT_PERSIST_MAX + 10);
    const out = JSON.parse(serializeClips([img(big), t(long), t("kept")])) as ClipEntry[];
    expect(out.map((e) => e.kind)).toEqual(["text", "text"]);
    expect((out[0] as { text: string }).text).toHaveLength(CLIP_TEXT_PERSIST_MAX);
  });

  it("reads a broken store as empty and skips malformed rows", () => {
    const s = memStore();
    s.setItem("nightloom.clip-ring", "{not json");
    expect(loadClips(s)).toEqual([]);
    s.setItem("nightloom.clip-ring", JSON.stringify([{ kind: "text", text: 3 }, t("ok"), null]));
    expect(loadClips(s)).toEqual([t("ok")]);
  });
});

describe("what is recorded", () => {
  beforeEach(() => {
    clips.ring = [];
    app.events = [];
    app.pendingMode = "normal";
  });

  it("records copies, pastes and sends in an ordinary chat", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: vi.fn(async () => {}) } },
      configurable: true,
    });
    await copyText("from a reply");
    recordImage("pasted", { media_type: "image/png", data: "QUJD", name: "pasted image" });
    recordText("sent", "typed and sent");
    expect(clips.ring.map((e) => e.source)).toEqual(["sent", "pasted", "copied"]);
  });

  it("records nothing from an incognito chat", () => {
    app.events = [{ event: "session_created", at: "x", kind: "build", mode: "incognito" } as never];
    recordText("pasted", "secret");
    recordImage("pasted", { media_type: "image/png", data: "QUJD", name: "x" });
    expect(clips.ring).toEqual([]);
  });

  it("records nothing while the pending chat is to be incognito", () => {
    app.pendingMode = "incognito";
    recordText("sent", "secret");
    expect(clips.ring).toEqual([]);
  });
});
