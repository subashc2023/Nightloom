// Item 874: Home froze the whole window. Stage's rules effect reran on `row` (derived from `fk.folded`), and
// `foldDone` wrote a fresh `fk.folded` on every pass — an effect loop (effect_update_depth_exceeded) after which
// Svelte drew nothing more. This builds the stage's own shape on Svelte's client runtime (what a .svelte file
// compiles to: a proxied bag, a derived row, an effect that reads it and runs the rules untracked) and must settle.
import { describe, expect, it } from "vitest";
import { foldDone, type FocusBag } from "./focus";
import type { Tab } from "./tabs";

// The suite runs in node, where "svelte" resolves to the server build and effects never run.
type Client = {
  proxy: <T>(v: T) => T;
  derived: <T>(f: () => T) => unknown;
  get: <T>(s: unknown) => T;
  effect_root: (f: () => void) => () => void;
  user_effect: (f: () => void) => void;
  untrack: <T>(f: () => T) => T;
  flushSync: () => void;
};
const CLIENT = "svelte/internal/" + "client";
const $ = (await import(/* @vite-ignore */ CLIENT)) as unknown as Client & { flush: () => void };
const flush = $.flush;

const tab = (id: string, live = true): Tab => ({ id, view: id === "watch" ? "watch" : "todo", name: id, needs: 0, live }) as Tab;

describe("Home's done-folding never loops the stage (874)", () => {
  it("an effect keyed on the folded row settles, and a repeat pass writes nothing", () => {
    const fk = $.proxy<FocusBag>({ follow: true, split: false, primed: true, ready: [], seen: {}, doneSeen: {}, folded: [] });
    const all = [tab("watch"), tab("task:a", false), tab("task:b")];
    const done = (id: string) => id === "task:a";
    const row = $.derived(() => all.filter((t) => !(fk.folded ?? []).includes(t.id)));
    let runs = 0;
    let err: unknown = null;
    const stop = $.effect_root(() => {
      $.user_effect(() => {
        void $.get(row); // the shape Stage.svelte had: keyed on the row's identity
        runs++;
        $.untrack(() => foldDone(fk, all, done, "watch", Date.now()));
      });
    });
    try {
      flush();
    } catch (e) {
      err = e;
    }
    stop();
    expect(String(err ?? "")).not.toMatch(/effect_update_depth_exceeded/);
    expect(err).toBeNull();
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(5);
    const before = fk.folded;
    foldDone(fk, all, done, "watch", Date.now());
    expect(fk.folded).toBe(before);
  });
});
