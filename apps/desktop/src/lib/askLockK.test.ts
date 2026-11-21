// Wave K (items 713 + 753; his pick, blocker 2031): the "Claude asks you" card in Lock-on with Thread's answer
// motion — one card for the mid-turn question and the turn-end ask, and the Needs-you view.
import { afterEach, describe, expect, it, vi } from "vitest";
import turnAsk from "./TurnAsk.svelte?raw";
import prompt from "./ApprovalPrompt.svelte?raw";
import askQ from "./AskQuestions.svelte?raw";
import needsView from "./NeedsYou.svelte?raw";
import { ARRIVE, BEAD_MS, CARRY_MS, FADE, FOLD, decodeAt, flightAt, flyAnswer, look } from "./askMotion";

// vitest empties CSS imports (codeCopy.test.ts): app.css is read from disk.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const appCss = fs.readFileSync(new URL("../app.css", import.meta.url), "utf8");
const J = ':global(:where(:root:not([data-layout="classic"])))';
const block = appCss.slice(appCss.indexOf("/* ---- ask lock-on"));
const noPref = (css: string) => {
  const at = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  // the media block: up to the matching close brace
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { inside: css.slice(at, i + 1), outside: css.slice(0, at) + css.slice(i + 1) };
  }
  return { inside: "", outside: css };
};

afterEach(() => vi.unstubAllGlobals());

describe("arrival (Lock-on)", () => {
  it("both hosts and the view draw AskLock inside an lk-shell", () => {
    expect(turnAsk).toContain('class="turn-ask lk-shell"');
    expect(turnAsk).toContain("<AskLock />");
    expect(prompt).toContain('class="ask qcard lk-shell"');
    expect(prompt).toContain("<AskLock />");
    expect(needsView).toContain('class="modal lk-shell"');
    expect(needsView).toContain('<AskLock header=".pane-title" />');
  });
  it("every lock-on animation runs only with motion allowed, and only in Jarvis but Classic's calm rise", () => {
    const { inside, outside } = noPref(block);
    expect(outside).not.toMatch(/\banimation:\s*lk-/);
    for (const k of ["lk-veil", "lk-scan", "lk-tl", "lk-tr", "lk-bl", "lk-br", "lk-breathe"]) expect(inside).toContain(k);
    for (const line of inside.split("\n").filter((l) => /^\s{2}\S.*\{$/.test(l))) {
      if (line.includes(".lk-shell")) expect(line).toContain('[data-layout="classic"]');
      else expect(line).toContain(':root:not([data-layout="classic"])');
    }
  });
  it("brackets wear --bracket (none under calm and Classic) and Classic hides them", () => {
    expect(block).toMatch(/\.lk-br \{[^}]*border: 2px solid var\(--bracket, transparent\);/);
    expect(block).toContain('[data-layout="classic"] .lk-br {\n  display: none;');
  });
  it("the header decodes left to right, keeps its spaces, and settles on its words", () => {
    const t = "Claude asks · needs you";
    expect(decodeAt(t, 0)).toHaveLength(t.length);
    expect(decodeAt(t, 0).split(" ").length).toBe(t.split(" ").length);
    expect(decodeAt(t, 0)).not.toBe(t);
    const mid = decodeAt(t, (ARRIVE.decodeFrom + ARRIVE.decodeTo) / 2);
    expect(mid.slice(0, 5)).toBe(t.slice(0, 5));
    expect(decodeAt(t, ARRIVE.decodeTo)).toBe(t);
    expect(decodeAt(t, 300, 3)).toBe(decodeAt(t, 300, 3));
  });
  it("answers are bracketed under the pointer and the pick locks in, Jarvis only, sliding only with motion", () => {
    for (const sel of [".aq-opt::before,", ".aq-opt:not(.aq-other):hover {", ".aq-opt.quick:hover {"]) expect(askQ).toContain(`${J} ${sel}`);
    const { inside } = noPref(askQ.slice(askQ.indexOf("Wave K, Lock-on")));
    expect(inside).toContain(`${J} .aq-opt.on .aq-mk {`);
    expect(inside).toContain("animation: aq-lock");
  });
  it("the view brackets its group heads, marks what waits, scans rows in only with motion, and folds a leaving row", () => {
    for (const sel of [".group-name::before {", ".count::after {", ".row.asks {", ".pane-title {"]) expect(needsView).toContain(`${J} ${sel}`);
    expect(noPref(needsView.slice(needsView.indexOf("Wave K, Lock-on"))).inside).toContain("animation: ny-row");
    expect(needsView).toContain("out:rowOut");
    expect(needsView).toMatch(/if \(kind === "none"\) return \{ duration: 0 \};/);
  });
});

describe("answer (Thread)", () => {
  it("both hosts fly the answer before it is sent", () => {
    expect(turnAsk.indexOf("flyAnswer(shell, pickedRow(), answer);")).toBeLessThan(turnAsk.indexOf("onsend(answer);\n  }"));
    expect(prompt.indexOf("flyAnswer(box,")).toBeLessThan(prompt.indexOf('decide("allow", payload);'));
  });
  it("the timeline: the thread draws, the bead rides it, the copy folds after the carry starts, then fades", () => {
    expect(flightAt(0)).toMatchObject({ trail: 0, bead: 0, fold: 0, fade: 0 });
    expect(flightAt(BEAD_MS).bead).toBe(1);
    expect(flightAt(CARRY_MS).trail).toBe(1);
    expect(flightAt(FOLD.from).fold).toBe(0);
    expect(flightAt(FOLD.to).fold).toBe(1);
    expect(flightAt(FADE.from - 1).fade).toBe(0);
    expect(flightAt(FADE.to).fade).toBe(1);
    expect(FOLD.from).toBeLessThan(CARRY_MS);
    expect(FADE.to).toBeLessThan(1800);
  });
  it("reduce motion draws nothing; Classic is calm; Jarvis otherwise", () => {
    const root = { getAttribute: (k: string) => (k === "data-layout" ? "classic" : null) } as unknown as Element;
    const jroot = { getAttribute: () => null } as unknown as Element;
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    expect(look(root)).toBe("none");
    expect(look(jroot)).toBe("none");
    expect(flyAnswer({} as HTMLElement, null, "x")).toEqual([]);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(look(root)).toBe("classic");
    expect(look(jroot)).toBe("jarvis");
  });
  it("the copy's own CSS motion is off, so it never replays the arrival", () => {
    expect(block).toMatch(/\.ask-ghost,\n\.ask-ghost \* \{\n  animation: none !important;/);
  });
});
