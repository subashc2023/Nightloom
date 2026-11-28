// Item 771: "Left it?" — who is asked about, how often, and what stops it.
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HIGH_AFTER_MS,
  LOW_AFTER_MS,
  PER_DAY,
  candidates,
  dayKey,
  emptyStore,
  isSettled,
  levelOf,
  parseStore,
  pickToday,
  pruned,
  splitSettled,
  todayRows,
  type Chat,
  type Store,
} from "./leftBehind";

const T0 = Date.parse("2026-11-01T09:00:00Z");
const NOW = T0 + 10 * DAY_MS;
const TODAY = dayKey(NOW);
const iso = (ms: number) => new Date(ms).toISOString();
const chat = (id: string, replyAgo: number, extra: Partial<Chat> = {}): Chat => ({
  id,
  project: null,
  title: id,
  first_user: null,
  last_reply: iso(NOW - replyAgo),
  last_message: iso(NOW - replyAgo - 60_000),
  ...extra,
});
const store = (over: Partial<Store> = {}): Store => ({ ...emptyStore(T0), ...over });
const none = new Set<string>();

describe("771: the levels", () => {
  const reply = NOW - 3 * DAY_MS;
  it("high: a reply never opened, after 2 days", () => {
    expect(levelOf(reply, undefined, T0, NOW)).toBe("high");
    expect(levelOf(NOW - HIGH_AFTER_MS + 1, undefined, T0, NOW)).toBeNull();
  });
  it("low: opened after the reply, foot never seen, after 4 days", () => {
    const r = NOW - LOW_AFTER_MS;
    expect(levelOf(r, { opened: r + 1000 }, T0, NOW)).toBe("low");
    expect(levelOf(r + 1, { opened: r + 1000 }, T0, NOW)).toBeNull();
  });
  it("read to the end: none", () => {
    expect(levelOf(reply, { opened: reply + 1, foot: reply + 1 }, T0, NOW)).toBeNull();
  });
  it("a foot seen before the reply came does not count", () => {
    expect(levelOf(reply, { opened: reply - 5, foot: reply - 5 }, T0, NOW)).toBe("high");
  });
  it("a reply from before the nudge existed is never asked about", () => {
    expect(levelOf(T0 - 1, undefined, T0, NOW)).toBeNull();
  });
});

describe("771: who shows", () => {
  it("high first, then the longest left; at most three a day", () => {
    const chats = [chat("lowOld", 6 * DAY_MS), chat("hiNew", 2.5 * DAY_MS), chat("hiOld", 5 * DAY_MS), chat("hi3", 3 * DAY_MS), chat("hi4", 4 * DAY_MS)];
    const st = store({ marks: { lowOld: { opened: NOW - 5 * DAY_MS } } });
    const c = candidates(chats, st, NOW, TODAY, none);
    expect(c.map((x) => x.chat.id)).toEqual(["hiOld", "hi4", "hi3", "hiNew", "lowOld"]);
    const st2 = pickToday(st, c, TODAY);
    expect(st2.day?.ids).toEqual(["hiOld", "hi4", "hi3"]);
    expect(st2.day?.ids.length).toBe(PER_DAY);
  });
  it("never a running chat, the one in front, a settled, a snoozed or an incognito one", () => {
    const chats = [chat("run", 3 * DAY_MS), chat("set", 3 * DAY_MS), chat("snz", 3 * DAY_MS), chat("inc", 3 * DAY_MS, { mode: "incognito" }), chat("ok", 3 * DAY_MS)];
    const st = store({ settled: { set: NOW - DAY_MS }, snoozed: { snz: NOW + DAY_MS } });
    expect(candidates(chats, st, NOW, TODAY, new Set(["run"])).map((x) => x.chat.id)).toEqual(["ok"]);
  });
  it("a snooze that ran out asks again", () => {
    const st = store({ snoozed: { a: NOW - 1 } });
    expect(candidates([chat("a", 3 * DAY_MS)], st, NOW, TODAY, none)).toHaveLength(1);
  });
  it("a message written after settling takes the chat back", () => {
    expect(isSettled(NOW - DAY_MS, iso(NOW - 2 * DAY_MS))).toBe(true);
    expect(isSettled(NOW - DAY_MS, iso(NOW - 1000))).toBe(false);
    expect(isSettled(undefined, null)).toBe(false);
  });
  it("one reply is asked about on two days at most; a new reply starts again", () => {
    const c = chat("a", 3 * DAY_MS);
    const reply = Date.parse(c.last_reply!);
    const st = store({ asked: { a: { reply, days: ["2026-11-08", "2026-11-09"] } } });
    expect(candidates([c], st, NOW, TODAY, none)).toHaveLength(0);
    const newer = chat("a", 2.5 * DAY_MS);
    expect(candidates([newer], st, NOW, TODAY, none)).toHaveLength(1);
  });
  it("the day's picks are frozen: a second look the same day changes nothing", () => {
    const st = pickToday(store(), candidates([chat("a", 3 * DAY_MS)], store(), NOW, TODAY, none), TODAY);
    expect(pickToday(st, [], TODAY)).toBe(st);
    expect(st.asked.a.days).toEqual([TODAY]);
  });
});

describe("771: today's rows", () => {
  const chats = [chat("a", 3 * DAY_MS), chat("b", 3 * DAY_MS), chat("c", 3 * DAY_MS)];
  const base = pickToday(store(), candidates(chats, store(), NOW, TODAY, none), TODAY);
  it("a deleted chat drops out", () => {
    expect(todayRows(base, chats.slice(1), NOW, TODAY, none).map((r) => r.chat.id)).toEqual(["b", "c"]);
  });
  it("a chat read meanwhile drops out; an answered one stays with its answer", () => {
    const st: Store = { ...base, marks: { a: { opened: NOW - 1, foot: NOW - 1 } }, day: { ...base.day!, done: { b: "snoozed" } }, snoozed: { b: NOW + 7 * DAY_MS } };
    const rows = todayRows(st, chats, NOW, TODAY, none);
    expect(rows.map((r) => [r.chat.id, r.done])).toEqual([
      ["b", "snoozed"],
      ["c", null],
    ]);
  });
  it("all settled: nothing shows", () => {
    const st: Store = { ...base, settled: { a: NOW, b: NOW, c: NOW } };
    expect(todayRows(st, chats, NOW, TODAY, none)).toEqual([]);
  });
  it("yesterday's picks are not today's", () => {
    expect(todayRows(base, chats, NOW + DAY_MS, dayKey(NOW + DAY_MS), none)).toEqual([]);
  });
  it("the days since the reply", () => {
    expect(todayRows(base, chats, NOW, TODAY, none)[0].days).toBe(3);
  });
});

describe("771: the sidebar's Settled", () => {
  it("a settled row takes its forks with it", () => {
    const r = (id: string, depth: number) => ({ meta: { id }, depth });
    const out = splitSettled([r("a", 0), r("a1", 1), r("b", 0), r("c", 0), r("c1", 1)], (id) => id === "a" || id === "c");
    expect(out.live.map((x) => x.meta.id)).toEqual(["b"]);
    expect(out.settled.map((x) => x.meta.id)).toEqual(["a", "a1", "c", "c1"]);
  });
});

describe("771: the store", () => {
  it("reads leniently and starts afresh on junk", () => {
    expect(parseStore("{nope", NOW).since).toBe(NOW);
    expect(parseStore(null, NOW)).toEqual(emptyStore(NOW));
    const st = store({ settled: { a: 1 } });
    expect(parseStore(JSON.stringify(st), NOW)).toEqual(st);
  });
  it("drops past snoozes and gone chats, keeps a mark made in the last day", () => {
    const st = store({ snoozed: { a: NOW - 1, b: NOW + 1 }, marks: { gone: { opened: NOW - 2 * DAY_MS }, fresh: { opened: NOW - 1000 }, kept: { opened: 1 } }, settled: { gone: 1, kept: 2 } });
    const p = pruned(st, new Set(["kept", "b"]), NOW);
    expect(Object.keys(p.snoozed)).toEqual(["b"]);
    expect(Object.keys(p.marks).sort()).toEqual(["fresh", "kept"]);
    expect(Object.keys(p.settled)).toEqual(["kept"]);
  });
});
