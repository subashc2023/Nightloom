import { describe, expect, it } from "vitest";
import { heldTap, joinDraft, placeFromHash, placeHash, plainError, readPlace, samePlace, triable } from "./place";
import { tokenFromHash } from "./client";

describe("the place in the hash (item 300, A21/A37)", () => {
  it("round-trips a chat, its project and host", () => {
    const p = { chat: "07ae75a2-1111", project: "p-thesis", host: "away" as const };
    expect(placeFromHash(placeHash(p))).toEqual(p);
  });

  it("round-trips a new chat, with and without a project", () => {
    expect(placeFromHash(placeHash({ chat: null, project: "unfiled", host: null }))).toEqual({ chat: null, project: "unfiled", host: null });
    expect(placeHash({ chat: null, project: null, host: null })).toBe("#new");
    expect(placeFromHash("#new")).toEqual({ chat: null, project: null, host: null });
  });

  it("escapes ids that need it", () => {
    const p = { chat: "a&b=c", project: "x y", host: "mac" as const };
    expect(placeFromHash(placeHash(p))).toEqual(p);
  });

  it("reads no place from a token or an empty hash, and never writes a token", () => {
    expect(placeFromHash("")).toBeNull();
    expect(placeFromHash("#token=" + "a".repeat(32))).toBeNull();
    expect(tokenFromHash(placeHash({ chat: "c", project: "p", host: "mac" }))).toBeNull();
  });

  it("ignores an unknown host and a malformed escape", () => {
    expect(placeFromHash("#chat=c&host=pc")).toEqual({ chat: "c", project: null, host: null });
    expect(placeFromHash("#chat=%E0%A4%A")).toBeNull();
  });

  it("compares places field by field", () => {
    expect(samePlace({ chat: "c", project: "p", host: "mac" }, { chat: "c", project: "p", host: "mac" })).toBe(true);
    expect(samePlace({ chat: "c", project: "p", host: "mac" }, { chat: "c", project: "q", host: "mac" })).toBe(false);
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace(null, { chat: null, project: null, host: null })).toBe(false);
  });

  it("reads back only well-formed stored places", () => {
    expect(readPlace({ chat: "c", project: 3, host: "away" })).toEqual({ chat: "c", project: null, host: "away" });
    expect(readPlace("nope")).toBeNull();
  });
});

describe("plain errors (A14)", () => {
  it("says a missing chat in words, without the folder", () => {
    const p = plainError('no session matching "07ae75a2-…" in /private/tmp/x/scratchpad/home/unfiled/sessions', "rename the chat");
    expect(p.text).toBe("Couldn't rename the chat: the chat could not be found — pull down to refresh, then try again");
    expect(p.text).not.toContain("/");
    expect(p.detail).toContain("unfiled/sessions");
  });

  it("keeps the host's own sentence, minus paths, to its first line", () => {
    const p = plainError("cannot write /Users/x/.nightloom/a.json: permission denied\nmore");
    expect(p.text).toBe("Cannot write: permission denied");
    expect(p.detail).toContain("more");
  });

  it("leaves a plain sentence as it is, with no details", () => {
    const s = "a turn is running in this chat — try again when it ends";
    expect(plainError(s)).toEqual({ text: "A turn is running in this chat — try again when it ends", detail: s });
    expect(plainError("A turn is running").detail).toBeNull();
  });

  it("caps a long sentence and reads an HTML page as unreadable", () => {
    expect(plainError("x".repeat(400)).text.length).toBeLessThanOrEqual(140);
    expect(plainError("<html><body>502</body></html>").text).toMatch(/cannot read/);
  });
});

describe("held messages (A30, A36)", () => {
  it("takes one held for this chat back, and asks about another chat's", () => {
    expect(heldTap({ chat: "a" }, "a")).toBe("take");
    expect(heldTap({ chat: "b" }, "a")).toBe("ask");
    expect(heldTap({ chat: null }, null)).toBe("take");
  });

  it("does not try a refused message again on its own", () => {
    const q = [{ id: "1", failed: "Couldn't send" }, { id: "2" }];
    expect(triable(q).map((x) => x.id)).toEqual(["2"]);
  });

  it("joins taken-back text to a draft rather than replacing it", () => {
    expect(joinDraft("", "held")).toBe("held");
    expect(joinDraft("typed  ", "held")).toBe("typed\n\nheld");
  });
});

describe("rename and open name the chat's project (A13, A29)", () => {
  // A generated test value.
  const T = "0123456789abcdef0123456789abcdef";
  it("sends the project in the body, and none for an unnamed one", async () => {
    const { Client } = await import("./client");
    const seen: { url: string; body: string | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: typeof init.body === "string" ? init.body : null });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const c = new Client(T);
      await c.rename("abc", "New name", "p-thesis");
      await c.rename("abc", "New name");
      await c.open("abc", "unfiled");
      await c.open("abc");
    } finally {
      globalThis.fetch = real;
    }
    expect(seen[0]).toEqual({ url: "/api/chats/abc/rename", body: JSON.stringify({ title: "New name", project: "p-thesis" }) });
    expect(seen[1].body).toBe(JSON.stringify({ title: "New name" }));
    expect(seen[2]).toEqual({ url: "/api/chats/abc/open", body: JSON.stringify({ project: "unfiled" }) });
    expect(seen[3].body).toBeNull();
  });
});
