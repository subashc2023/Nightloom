import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, Unreachable } from "./client";
import {
  NS_DRAFTS_KEY,
  NightshiftClient,
  answerDraftKey,
  discardNeedsConfirm,
  itemDraftKey,
  loadNsDraft,
  morningTitle,
  nsDraftKeys,
  nsProblem,
  saveNsDraft,
  statusTag,
} from "./nightshiftClient";

type Seen = { url: string; method: string; auth: string | null; body: unknown };

describe("the Nightshift client", () => {
  const real = globalThis.fetch;
  let seen: Seen[] = [];
  let answerWith: (url: string) => Response = () => new Response("[]");

  beforeEach(() => {
    seen = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({
        url,
        method: init.method ?? "GET",
        auth: headers.Authorization ?? null,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return answerWith(url);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it("names each route under /api/nightshift with the bearer, ids encoded", async () => {
    const c = new NightshiftClient("tok", "https://away.example:8642");
    answerWith = (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/blockers") ? { blockers: [{ id: "021" }], errors: [] } : url.endsWith("/items") ? { id: "036" } : {},
        ),
        { status: url.endsWith("/items") ? 201 : 200 },
      );
    await c.projects();
    await c.queue("p 1");
    await c.item("p 1", "017");
    expect(await c.newItem("p 1", "A title", "his words")).toBe("036");
    expect(await c.blockers("p 1")).toEqual([{ id: "021" }]);
    await c.blocker("p 1", "021");
    await c.answer("p 1", "021", "Yes.");
    await c.mornings("p 1");
    await c.morning("p 1", "2026-09-11.md");
    const base = "https://away.example:8642/api/nightshift";
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${base}`,
      `GET ${base}/p%201/queue`,
      `GET ${base}/p%201/items/017`,
      `POST ${base}/p%201/items`,
      `GET ${base}/p%201/blockers`,
      `GET ${base}/p%201/blockers/021`,
      `POST ${base}/p%201/blockers/021/answer`,
      `GET ${base}/p%201/mornings`,
      `GET ${base}/p%201/mornings/2026-09-11.md`,
    ]);
    expect(seen.every((s) => s.auth === "Bearer tok")).toBe(true);
    expect(seen[3].body).toEqual({ title: "A title", said: "his words" });
    // Wave 4 C1: a nonce rides along when the sheet gives one.
    await c.newItem("p 1", "A title", "his words", "n-1");
    expect(seen[seen.length - 1].body).toEqual({ title: "A title", said: "his words", nonce: "n-1" });
    expect(seen[6].body).toEqual({ answer: "Yes." });
  });

  it("a refusal is the host's sentence; no host at all is Unreachable", async () => {
    const c = new NightshiftClient("tok");
    answerWith = () => new Response("a shift is live (pid 4); wait for it to finish before editing this project", { status: 409 });
    const e = await c.answer("p1", "021", "yes").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(nsProblem(e, "mac")).toMatch(/^a shift is live/);
    globalThis.fetch = (async () => {
      throw new TypeError("Load failed");
    }) as typeof fetch;
    const u = await c.projects().catch((x: unknown) => x);
    expect(u).toBeInstanceOf(Unreachable);
    expect(nsProblem(u, "serve")).toBe("The away server is unreachable.");
  });

  it("says Nightshift is not on a host that answers 501", () => {
    const e = new ApiError(501, "not available on this host");
    expect(nsProblem(e, "serve")).toBe("Nightshift is not on the away server yet.");
    expect(nsProblem(e, "mac")).toBe("Nightshift is not on this host.");
  });
});

describe("the words the sheet shows", () => {
  it("a dated morning reads as its day; another name as it is", () => {
    expect(morningTitle("2026-09-11.md")).toBe("Friday, September 11");
    expect(morningTitle("special.md")).toBe("special");
  });

  it("a todo item carries no tag; the rest do", () => {
    expect(statusTag("todo")).toBe("");
    expect(statusTag("in-progress")).toBe("in progress");
    expect(statusTag("done")).toBe("done");
  });
});

describe("drafts are kept until Send or a confirmed Discard (practices §7)", () => {
  beforeEach(() => localStorage.clear());

  it("an answer's draft is kept per blocker, and survives a reload", () => {
    saveNsDraft(answerDraftKey("p1", "021"), { text: "Grant the" });
    saveNsDraft(answerDraftKey("p1", "022"), { text: "No." });
    expect(loadNsDraft(answerDraftKey("p1", "021"))).toEqual({ text: "Grant the" });
    expect(JSON.parse(localStorage.getItem(NS_DRAFTS_KEY)!)).toHaveProperty(["answer:p1/022"]);
    expect(nsDraftKeys().sort()).toEqual(["answer:p1/021", "answer:p1/022"]);
  });

  it("a new item's draft keeps its title and his words", () => {
    saveNsDraft(itemDraftKey("p1"), { title: "Phone blockers", text: "" });
    expect(loadNsDraft(itemDraftKey("p1"))).toEqual({ title: "Phone blockers", text: "" });
  });

  it("Send landing (null) drops only that draft; an empty draft is no draft", () => {
    saveNsDraft(answerDraftKey("p1", "021"), { text: "Yes" });
    saveNsDraft(answerDraftKey("p1", "022"), { text: "No" });
    saveNsDraft(answerDraftKey("p1", "021"), null);
    expect(nsDraftKeys()).toEqual(["answer:p1/022"]);
    saveNsDraft(answerDraftKey("p1", "022"), { text: "   " });
    expect(nsDraftKeys()).toEqual([]);
    expect(localStorage.getItem(NS_DRAFTS_KEY)).toBeNull();
  });

  it("Discard asks first whenever there is text to lose", () => {
    expect(discardNeedsConfirm(null)).toBe(false);
    expect(discardNeedsConfirm({ text: "  " })).toBe(false);
    expect(discardNeedsConfirm({ text: "Yes" })).toBe(true);
    expect(discardNeedsConfirm({ text: "", title: "A title" })).toBe(true);
  });

  it("a broken store reads as no drafts rather than throwing", () => {
    localStorage.setItem(NS_DRAFTS_KEY, "{not json");
    expect(loadNsDraft(answerDraftKey("p1", "021"))).toBeNull();
    expect(nsDraftKeys()).toEqual([]);
  });
});
