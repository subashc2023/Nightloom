// Item 847, phase 1: Home's views run against real scenarios and edge cases with the model stubbed — the views are
// the real components (drawn with Svelte's server renderer, the only renderer this node suite has), the model's
// output is a task's `data` as `update_task` would carry it, and the app is a stub host. Scenario ids (A1, C3, …) are
// `nightshift-code/notes/runner-design/847-scenarios-2026-11-19.md`; results in `847-results-2026-11-19.md`.
// A test marked `it.fails` is a recorded failure: the results file names the proposed item.
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { Component } from "svelte";
import Todo from "./views/Todo.svelte";
import Triage from "./views/Triage.svelte";
import Timeline from "./views/Timeline.svelte";
import Run from "./views/Run.svelte";
import Research from "./views/Research.svelte";
import Browse from "./views/Browse.svelte";
import Brief from "./views/Brief.svelte";
import stageSrc from "./Stage.svelte?raw";
import phoneStageSrc from "../../remote/HomeStage.svelte?raw";
import { setStageHost, stageHost, type HomeTask, type StageHost } from "./host";
import { tasks, refreshTasks, nudge, closeTask, NUDGE_PREFIX } from "./tasks.svelte";
import { stopThenTell } from "./runControls";
import { todoOf, triageOf, timelineOf, runOf, researchOf, browseOf } from "./taskData";
import { briefOf, sectionsOf } from "./brief";
import { readKept } from "./stageState.svelte";
import { phoneStageHost, clickNotSent } from "../../remote/phoneStageHost";
import { Unreachable } from "../../remote/client";

const base = { ...stageHost.now };
type Calls = { events: [string, string, string][]; nudges: string[]; toasts: string[]; stops: string[] };
function stub(over: Partial<StageHost> = {}): Calls {
  const c: Calls = { events: [], nudges: [], toasts: [], stops: [] };
  setStageHost({
    ...base,
    taskEvent: async (t, v, l) => void c.events.push([t, v, l]),
    nudge: (text) => void c.nudges.push(text),
    toast: (t) => void c.toasts.push(t),
    stopChat: async (chat) => void c.stops.push(chat),
    ...over,
  });
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const task = (view: string, data: unknown, over: Partial<HomeTask> = {}): HomeTask => ({
  id: `${view}-1`,
  view,
  name: `A ${view} task`,
  doing: "",
  step: 1,
  of: 3,
  state: "live",
  needs: 0,
  why: "",
  data,
  started_at: "2026-11-19T08:00:00Z",
  updated_at: "2026-11-19T08:01:00Z",
  ...over,
});
const VIEWS = { todo: Todo, triage: Triage, timeline: Timeline, run: Run, research: Research, browse: Browse } as const;
const draw = (view: keyof typeof VIEWS, data: unknown, over: Partial<HomeTask> = {}) => render(VIEWS[view] as unknown as Component<{ task: HomeTask }>, { props: { task: task(view, data, over) } }).body;
const text = (html: string) => html.replace(/<!--[^]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const uniq = (xs: readonly string[]) => new Set(xs).size === xs.length;

beforeEach(() => {
  stub();
  tasks.rows = [];
  tasks.loaded = false;
  tasks.problem = null;
});

describe("A. missing info — every task view draws with nothing in it", () => {
  for (const view of Object.keys(VIEWS) as (keyof typeof VIEWS)[]) {
    for (const [label, data] of [["null data", null], ["a string", "oops"], ["an empty object", {}], ["wrong types", { items: 5, cards: "x", events: {}, steps: null, sources: 7, fields: true }]] as const) {
      it(`A5–A11 ${view} with ${label} renders without throwing`, () => {
        expect(() => draw(view, data)).not.toThrow();
      });
    }
  }
  it("A7 To-do with no data shows Home's doing line as its loading line", () => {
    expect(text(draw("todo", null, { doing: "Reading your list" }))).toContain("Reading your list");
  });
  it("A3 no scan in the chat: no brief (so no Brief tab)", () => {
    expect(briefOf([], () => false, false)).toBeNull();
    expect(briefOf([{ event: "user_message", text: "hi" } as never], () => false, false)).toBeNull();
  });
  it("A4 a scan page of whitespace has no sections", () => {
    expect(sectionsOf("   \n\n  ")).toEqual([]);
  });
  it("A3 Brief draws with no brief from the host", () => {
    stub({ brief: () => null });
    expect(() => render(Brief as unknown as Component<Record<string, never>>, { props: {} })).not.toThrow();
  });
  it("A6 events with unreadable times are dropped; the readable one is kept", () => {
    const t = timelineOf({ events: [{ title: "Soon", start: "soon" }, { title: "Bad", start: "25:00" }, { title: "Blank", start: "" }, { title: "Stand-up", start: "9:00 AM", end: "9:15 AM" }] });
    expect(t.events.map((e) => e.title)).toEqual(["Stand-up"]);
    expect(t.z1 - t.z0).toBeGreaterThanOrEqual(6);
  });
  it("A11 Browse on a host with no live browser draws the page Home reports", () => {
    const h = draw("browse", { url: "permits.example/renew", page: "Renew a permit", fields: [{ label: "Permit", value: "RP-1" }] });
    expect(text(h)).toContain("RP-1");
  });
});

describe("B. his take-over mid-run", () => {
  it("B1 Take back with Home reachable is one short turn, never also kept", () => {
    const c = stub();
    nudge({ name: "List", view: "todo" }, "you took “Call the plumber” back — leave it to you");
    expect(c.nudges).toEqual([NUDGE_PREFIX + "you took “Call the plumber” back — leave it to you"]);
    expect(c.events).toEqual([]);
  });
  it("B2 Home not reachable: the click is kept for Home's next look, once", async () => {
    const c = stub({ nudge: (_t, fallback) => (fallback(), fallback()) });
    nudge({ name: "List", view: "todo" }, "you handed it to Home");
    await flush();
    expect(c.events).toEqual([["List", "todo", "you handed it to Home"]]);
  });
  it("B3 the host throws on the nudge: kept once, never zero", async () => {
    const c = stub({
      nudge: () => {
        throw new Error("no engine");
      },
    });
    nudge({ name: "List", view: "todo" }, "you took it back");
    await flush();
    expect(c.events).toHaveLength(1);
  });
  it("B8 Stop now that fails: a toast says so and Home is told nothing", async () => {
    const c = stub({ routedRunning: async () => ["chat-1"], stopChat: async () => Promise.reject(new Error("the Mac is not answering")) });
    expect(await stopThenTell({ name: "Merge", view: "run" }, "chat-1", "Checks")).toBe(false);
    expect(c.toasts).toEqual(["The chat was not stopped — the Mac is not answering"]);
    expect(c.nudges).toEqual([]);
  });
  it("B8b Stop now on a chat Home did not route is refused (never stops his own chat)", async () => {
    const c = stub({ routedRunning: async () => ["chat-2"] });
    expect(await stopThenTell({ name: "Merge", view: "run" }, "chat-1", null)).toBe(false);
    expect(c.stops).toEqual([]);
  });
  it("B9 Stop now that works stops that chat and tells Home once", async () => {
    const c = stub({ routedRunning: async () => ["chat-1"] });
    expect(await stopThenTell({ name: "Merge", view: "run" }, "chat-1", "Checks")).toBe(true);
    expect(c.stops).toEqual(["chat-1"]);
    expect(c.nudges).toHaveLength(1);
  });
  it("B10 his × on a tab whose close fails still takes the tab off this screen", async () => {
    stub({ taskClose: async () => Promise.reject(new Error("offline")), homeTasks: async () => [] });
    tasks.rows = [task("todo", null)];
    await closeTask("todo-1").catch(() => {});
    expect(tasks.rows).toEqual([]);
  });
});

describe("C. failures", () => {
  it("C2 junk rows from the service are dropped, good rows kept", async () => {
    stub({ homeTasks: async () => [null, { id: 3 }, { id: "x" }, task("todo", null)] as never });
    await refreshTasks();
    expect(tasks.rows.map((t) => t.id)).toEqual(["todo-1"]);
    stub({ homeTasks: async () => "not a list" as never });
    await refreshTasks();
    expect(tasks.rows).toEqual([]);
  });
  it("C1 a failed read is recorded", async () => {
    stub({ homeTasks: async () => Promise.reject(new Error("service down")) });
    await refreshTasks();
    expect(tasks.problem).toContain("service down");
    expect(tasks.loaded).toBe(true);
  });
  it("C1b a failed read is shown to him on the Mac stage and the phone stage (894)", () => {
    expect(stageSrc).toContain("{#if tasks.problem}");
    expect(phoneStageSrc).toContain("{#if tasks.problem}");
  });
  // Fixed on this branch (847: fix …, taskData.ts `once`); before it these failed and the harness shot
  // `847-shots/todo-dup847-1440x900.png` showed the whole window stop ("Nightloom hit an error and stopped updating").
  // Svelte 5 throws `each_key_duplicate` on a repeated key in a keyed each, in production too
  // (node_modules/svelte/src/internal/client/dom/blocks/each.js), and an uncaught throw in an effect stops the window
  // drawing (the 874 freeze). Each view keys its rows on the parsed id; these feed what a model could plausibly write.
  it("C3 To-do: two items Home gave one id keep distinct keys", () => {
    const items = todoOf({ items: [{ id: "1", text: "Call the plumber" }, { id: "1", text: "Pay rent" }] });
    expect(items).toHaveLength(2);
    expect(uniq(items.map((i) => i.id))).toBe(true);
  });
  it("C4 Triage: two cards with one id keep distinct keys", () => {
    const cards = triageOf({ cards: [{ id: "m1", title: "Lease" }, { id: "m1", title: "Dentist" }] });
    expect(uniq(cards.map((c) => c.id))).toBe(true);
  });
  it("C4b Triage: a card's repeated option (keyed on its text) stays distinct", () => {
    const [card] = triageOf({ cards: [{ title: "Lease", question: "Renew?", options: ["Yes", "Yes", "No"] }] });
    expect(uniq(card.options)).toBe(true);
  });
  it("C5 Timeline: two free slots at one hour ('2 PM', '14:00') stay distinct", () => {
    const t = timelineOf({ changes: [{ kind: "pick", title: "Gym", slots: ["2 PM", "14:00", "4 PM"] }] });
    expect(uniq(t.changes[0].slots.map(String))).toBe(true);
  });
  it("C6 Research: an answer citing one claim twice keeps distinct cite keys", () => {
    const r = researchOf({ claims: [{ id: "c1", text: "x" }], answer: [{ text: "y", cites: ["c1", "c1"] }] });
    expect(uniq(r.answer[0].cites)).toBe(true);
  });
  it("C6b Research: two sources with one id keep distinct keys", () => {
    const r = researchOf({ sources: [{ id: "s", title: "A" }, { id: "s", title: "B" }] });
    expect(uniq(r.sources.map((s) => s.id))).toBe(true);
  });
  it("C7 Run: two steps with one id keep distinct keys", () => {
    const r = runOf({ steps: [{ id: "build", name: "Build" }, { id: "build", name: "Build again" }], agents: [{ id: "a", name: "x" }, { id: "a", name: "y" }] });
    expect(uniq(r.steps.map((s) => s.id))).toBe(true);
    expect(uniq(r.agents.map((s) => s.id))).toBe(true);
  });
  it("C7b ids made from position never collide when Home gives none", () => {
    const items = todoOf({ items: [{ text: "Same words" }, { text: "Same words" }] });
    expect(uniq(items.map((i) => i.id))).toBe(true);
  });
});

describe("E. offline / network drop", () => {
  it("E2 a failed read after a good one keeps the last good rows (not blanked)", async () => {
    stub({ homeTasks: async () => [task("todo", null)] });
    await refreshTasks();
    stub({ homeTasks: async () => Promise.reject(new Unreachable("down")) });
    await refreshTasks();
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.problem).not.toBeNull();
  });
  it("E4 network back: rows return and the problem clears", async () => {
    stub({ homeTasks: async () => Promise.reject(new Error("down")) });
    await refreshTasks();
    stub({ homeTasks: async () => [task("run", null)] });
    await refreshTasks();
    expect(tasks.problem).toBeNull();
    expect(tasks.rows[0].view).toBe("run");
  });
  it("E1 phone: a click the Mac does not answer says so in plain words and is kept", async () => {
    const notes: string[] = [];
    const client = { homeTaskEvent: async () => Promise.reject(new Unreachable("down")) };
    const h = phoneStageHost({ client: () => client as never, home: () => ({ project: "p", chat: "c" }), scan: () => null, open: () => {}, note: (t) => notes.push(t) });
    await expect(h.taskEvent("List", "todo", "you ticked it")).rejects.toBeTruthy();
    expect(notes).toEqual([clickNotSent(new Unreachable("down"))]);
    expect(notes[0]).toContain("kept here");
  });
  it("E1b phone: a short turn the Mac does not answer falls back to Home's next look", async () => {
    const notes: string[] = [];
    let kept = 0;
    const client = { send: async () => Promise.reject(new Unreachable("down")) };
    const h = phoneStageHost({ client: () => client as never, home: () => ({ project: "p", chat: "c" }), scan: () => null, open: () => {}, note: (t) => notes.push(t) });
    h.nudge("x", () => kept++);
    await flush();
    expect(kept).toBe(1);
    expect(notes).toHaveLength(1);
  });
  it("E1c phone: no Home chat yet → the click is kept, nothing sent", () => {
    let kept = 0;
    const h = phoneStageHost({ client: () => ({}) as never, home: () => ({ project: null, chat: null }), scan: () => null, open: () => {}, note: () => {} });
    h.nudge("x", () => kept++);
    expect(kept).toBe(1);
  });
});

describe("F. the app closed and reopened", () => {
  it("F2 the kept stage comes back as he left it", () => {
    const k = readKept(JSON.stringify({ focus: "task:list", strip: "closed", stripFor: "t1", ui: { "task:list": { open: "t:1" } } }));
    expect(k).toMatchObject({ focus: "task:list", strip: "closed", ui: { "task:list": { open: "t:1" } } });
  });
  it("F3 a corrupt kept stage falls back to Watch", () => {
    for (const raw of ["{not json", "null", "42", '"x"', JSON.stringify({ focus: 5, ui: "x" })]) expect(readKept(raw).focus).toBe("watch");
  });
});

describe("G. long text, LaTeX, many items", () => {
  const many = (n: number, make: (i: number) => object) => Array.from({ length: n }, (_, i) => make(i));
  it("G1 To-do with 100 items says how many are not shown (895)", () => {
    const h = text(draw("todo", { items: many(100, (i) => ({ id: `t${i}`, text: `Item ${i}` })) }));
    // 60 drawn, 40 dropped by todoOf; the count must be honest ("100 open" or "40 more").
    expect(/100 open|40 more|40 not shown/.test(h)).toBe(true);
  });
  it("G2 Triage with 120 cards says how many are not shown (895)", () => {
    const h = text(draw("triage", { cards: many(120, (i) => ({ id: `m${i}`, title: `Mail ${i}`, pile: "inbox" })) }));
    expect(/120|40 more|40 not shown/.test(h)).toBe(true);
  });
  it("G2b Run steps, Research sources and claims past their caps say so (895)", () => {
    expect(text(draw("run", { steps: many(15, (i) => ({ name: `s${i}` })) }))).toContain("3 more steps not shown");
    const h = text(draw("research", { question: "q", sources: many(31, (i) => ({ title: `s${i}` })), claims: many(45, (i) => ({ text: `c${i}` })) }));
    expect(h).toContain("1 more source not shown");
    expect(h).toContain("5 more claims not shown");
    expect(text(draw("todo", { items: many(100, (i) => ({ text: `t${i}` })) }))).toContain("100 open");
  });
  it("G1b the cap is what it is: 60 to-dos, 80 cards, 12 steps, 30 sources, 40 claims", () => {
    expect(todoOf({ items: many(100, (i) => ({ text: `t${i}` })) })).toHaveLength(60);
    expect(triageOf({ cards: many(120, (i) => ({ title: `c${i}` })) })).toHaveLength(80);
    expect(runOf({ steps: many(20, (i) => ({ name: `s${i}` })) }).steps).toHaveLength(12);
    expect(researchOf({ sources: many(50, (i) => ({ title: `s${i}` })), claims: many(50, (i) => ({ text: `c${i}` })) })).toMatchObject({ sources: { length: 30 }, claims: { length: 40 } });
  });
  it("G3 a 5,000-character title is cut to its view's max", () => {
    const long = "word ".repeat(1000);
    expect(todoOf({ items: [{ text: long }] })[0].text.length).toBeLessThanOrEqual(160);
    expect(triageOf({ cards: [{ title: long }] })[0].title.length).toBeLessThanOrEqual(160);
    expect(timelineOf({ events: [{ title: long, start: "9:00" }] }).events[0].title.length).toBeLessThanOrEqual(80);
    expect(browseOf({ url: long }).url.length).toBeLessThanOrEqual(300);
  });
  it("G4 markup in Home's words is drawn as text, never as an element", () => {
    const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    for (const [view, data] of [
      ["todo", { items: [{ text: evil }] }],
      ["triage", { cards: [{ title: evil, from: evil }] }],
      ["timeline", { events: [{ title: evil, start: "9:00", end: "10:00" }] }],
      ["run", { title: evil, steps: [{ name: evil }], log: [evil] }],
      ["research", { question: evil, sources: [{ title: evil }], claims: [{ text: evil }] }],
      ["browse", { page: evil, url: evil, fields: [{ label: "x", value: evil }] }],
    ] as const) {
      const h = draw(view, data);
      expect(h, view).not.toMatch(/<img src=x|<script>alert/);
      expect(h, view).toContain("&lt;");
    }
  });
  // Since 6da69275 the views typeset math (MathText.svelte, sanitized with DOMPurify, which needs a DOM this node
  // suite does not have): the server render throws "sanitize is not a function" here only. Checked by a bin/snap shot.
  it.skip("G5 LaTeX and emoji survive as their own text (server render cannot run MathText)", () => {
    const latex = String.raw`Rent $\frac{1200}{2}$ each 🏠`;
    expect(text(draw("todo", { items: [{ text: latex }] }))).toContain(latex);
    // Since 6da69275 Research draws math (MathText): the words around it and the emoji stay; the math is typeset.
    const r = text(draw("research", { question: latex }));
    expect(r).toContain("Rent");
    expect(r).toContain("each 🏠");
  });
  it("G6 thirty events in a day are all kept and the track spans them", () => {
    const t = timelineOf({ events: many(30, (i) => ({ title: `E${i}`, start: `${7 + Math.floor(i / 2)}:${i % 2 ? "30" : "00"}`, minutes: 25 })) });
    expect(t.events).toHaveLength(30);
    expect(t.z0).toBeLessThanOrEqual(7);
    expect(t.z1).toBeGreaterThanOrEqual(22);
    expect(() => draw("timeline", { events: many(30, (i) => ({ title: `E${i}`, start: `${7 + Math.floor(i / 2)}:00` })) })).not.toThrow();
  });
  it("G7 a brief of forty sections keeps every one, keys distinct", () => {
    const page = Array.from({ length: 40 }, (_, i) => `## Same heading\n- line ${i}`).join("\n\n");
    const s = sectionsOf(page);
    expect(s).toHaveLength(40);
    expect(uniq(s.map((x) => x.key))).toBe(true);
  });
  it("G7b an event that crosses midnight is not drawn past the day's end", () => {
    const t = timelineOf({ events: [{ title: "Late", start: "11:00 PM", end: "1:00 AM" }] });
    expect(t.events[0].h + t.events[0].d).toBeLessThanOrEqual(24);
  });
});

describe("H. phone", () => {
  it("H1 every task view draws with the phone's host", () => {
    setStageHost(phoneStageHost({ client: () => ({}) as never, home: () => ({ project: "p", chat: "c" }), scan: () => null, open: () => {}, note: () => {} }));
    for (const view of Object.keys(VIEWS) as (keyof typeof VIEWS)[]) expect(() => draw(view, { items: [{ text: "x" }], cards: [{ title: "y" }] })).not.toThrow();
  });
});
