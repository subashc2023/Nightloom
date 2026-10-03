import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { pastAsides, pastOf } from "./asideHistory.svelte";
import {
  answerDelete,
  cancelWrapPick,
  confirmWrapPick,
  requestDelete,
  requestWrapUp,
  setTicked,
  wrapPick,
} from "./wrapAsides.svelte";
import type { SessionEvent } from "./types";

// Nightshift item 285: at Wrap up, the chat's open asides chip in through
// a picker — all ticked, untick to skip, Delete (confirmed) to Past — each
// ticked one running 282's fold step; fixtures and a scripted aside turn.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async (text: string) => {
    if (text.includes("Q-fail")) return { answer: "", is_error: true, notices: ["rate limited"], cache_read: 0 };
    if (text.includes("Q-slow")) return new Promise(() => {}); // never answers
    const q = /Q-[a-z]+/.exec(text)?.[0] ?? "?";
    return { answer: `### His words\n- "${q} matters" — pointer`, is_error: false, notices: [], cache_read: 0 };
  }),
  appendThreadLog: vi.fn(async (_slug: string, entry: string) => entry.length),
  cancelAside: vi.fn(async () => null),
}));

const AT = "2026-10-02T01:00:00Z";
const created = { event: "session_created", id: "c1", at: AT } as SessionEvent;

function aside(id: number, q: string, name?: string): Aside {
  const a: Aside = {
    id,
    quote: null,
    draft: false,
    turns: [{ seq: id, question: q, partial: "an answer", answer: "an answer", error: null, cancelled: false, cacheRead: 0 }],
    anchor: null,
  };
  if (name) a.name = name;
  return a;
}

let sent: string[] = [];
const go = async (extra: string) => {
  sent.push(extra);
};

beforeEach(() => {
  switchAside(null);
  app.activeSessionId = "c1";
  app.events = [created, { event: "thread", thread: "stuart-brainstorm", at: AT } as SessionEvent];
  app.project = { id: "p1", name: "VG" } as unknown as typeof app.project;
  app.connection = { engine: "claude-code" } as typeof app.connection;
  app.sessions = [{ id: "c1", title: "Stuart 9", first_user: null } as unknown as (typeof app.sessions)[number]];
  app.busy = false;
  for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
  cancelWrapPick();
  sent = [];
  vi.mocked(api.askAside).mockClear();
  vi.mocked(api.appendThreadLog).mockClear();
});

describe("the wrap-up's aside picker (285)", () => {
  it("with no asides, the wrap-up goes at once with nothing extra", async () => {
    await requestWrapUp("c1", go);
    expect(sent).toEqual([""]);
    expect(wrapPick.chat).toBeNull();
  });

  it("lists every asked aside, all ticked; a bound chat's summaries are appended to log.md", async () => {
    app.asides = [aside(1, "Q-alpha", "alpha"), aside(2, "Q-beta", "beta")];
    await requestWrapUp("c1", go);
    expect(sent).toEqual([]); // waits for the picker
    expect(wrapPick.rows.map((r) => r.ticked)).toEqual([true, true]);
    await confirmWrapPick(1000);
    expect(api.askAside).toHaveBeenCalledTimes(2);
    expect(api.appendThreadLog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.appendThreadLog).mock.calls.map((c) => c[0])).toEqual(["stuart-brainstorm", "stuart-brainstorm"]);
    expect(vi.mocked(api.appendThreadLog).mock.calls[0]![1]).toContain("aside 'alpha' from chat 'Stuart 9'");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Aside summaries appended to .agents/threads/stuart-brainstorm/log.md just now, for step 3: 'alpha', 'beta'.");
    expect(app.asides.length).toBe(2); // nothing closed
    expect(app.asides[0]!.foldedInto?.length).toBe(1);
  });

  it("an unticked aside is left out and untouched", async () => {
    app.asides = [aside(1, "Q-alpha", "alpha"), aside(2, "Q-beta", "beta")];
    await requestWrapUp("c1", go);
    setTicked(app.asides[1]!, false);
    await confirmWrapPick(1000);
    expect(api.askAside).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.askAside).mock.calls[0]![0]).toContain("Q-alpha");
    expect(sent[0]).toContain("'alpha'");
    expect(sent[0]).not.toContain("'beta'");
    expect(app.asides[1]!.foldedInto).toBeUndefined();
  });

  it("Delete asks first: cancel keeps the aside; confirm moves it to Past", async () => {
    app.asides = [aside(1, "Q-alpha", "alpha"), aside(2, "Q-beta", "beta")];
    await requestWrapUp("c1", go);
    requestDelete(app.asides[1]!);
    expect(wrapPick.deleting).not.toBeNull();
    answerDelete(false);
    expect(app.asides.length).toBe(2);
    expect(wrapPick.rows.length).toBe(2);
    requestDelete(app.asides[1]!);
    answerDelete(true);
    expect(app.asides.length).toBe(1);
    expect(wrapPick.rows.length).toBe(1);
    expect(pastOf("c1").map((p) => p.thread.name)).toEqual(["beta"]);
  });

  it("Cancel sends nothing and leaves every aside as it was", async () => {
    app.asides = [aside(1, "Q-alpha", "alpha")];
    await requestWrapUp("c1", go);
    cancelWrapPick();
    expect(sent).toEqual([]);
    expect(app.asides.length).toBe(1);
    expect(api.askAside).not.toHaveBeenCalled();
  });

  it("an unbound chat's summaries ride in the wrap-up message, for the HANDOFF section", async () => {
    app.events = [created];
    app.asides = [aside(1, "Q-alpha", "alpha")];
    await requestWrapUp("c1", go);
    await confirmWrapPick(1000);
    expect(api.appendThreadLog).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Put them in the HANDOFF section you write");
    expect(sent[0]).toContain("#### Aside 'alpha'");
    expect(sent[0]).toContain('"Q-alpha matters"');
    expect(vi.mocked(api.askAside).mock.calls[0]![0]).toContain("Fold this side conversation into the chat's hand-off");
  });

  it("a failed summary and one past the wait are named; the wrap-up still goes", async () => {
    app.asides = [aside(1, "Q-alpha", "alpha"), aside(2, "Q-fail", "broken"), aside(3, "Q-slow", "slow")];
    await requestWrapUp("c1", go);
    await confirmWrapPick(30);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("'alpha'");
    expect(sent[0]).toContain("'broken' (rate limited)");
    expect(sent[0]).toContain("'slow' (no summary within the wait)");
    expect(api.appendThreadLog).toHaveBeenCalledTimes(1);
    expect(api.cancelAside).toHaveBeenCalled();
    expect(app.asides.length).toBe(3);
  });
});
