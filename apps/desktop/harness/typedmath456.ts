// Item 456 harness — see typedmath456.html. The real Composer, app state stubbed, driven by the page.
// #one | #many | #accepted | #denied | #fence | #perf ; "@C" after it picks the palette (default A).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app, runMenuCommand } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";
import { typedMathPrefs } from "../src/lib/typedMathPrefs.svelte";
import { findTypedMath } from "../src/lib/typedMath";

const [scene, palette] = (location.hash.slice(1) || "one").split("@");
if (palette) document.documentElement.dataset.palette = palette;
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "chat-a";

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};

const box = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
const bar = () => document.querySelector<HTMLElement>(".tm-bar");
function type(t: string): void {
  box().focus();
  document.execCommand("insertText", false, t);
}
function key(k: string, extra: KeyboardEventInit = {}): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
}
const draft = () => readDraft(KEY).text;
const offered = () => [...document.querySelectorAll(".tm-src")].map((e) => e.textContent).join(" | ");

async function main(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  box().focus();

  if (scene === "one" || scene === "accepted" || scene === "denied") {
    type("so the variance is s^2 here, right?");
    await wait(300);
    say(`typed; after 300 ms the bar is ${bar() ? "shown" : "not shown"} (pause is 600 ms)`);
    await wait(500);
    say(`after 800 ms: offered ${offered() || "nothing"}`);
    const b = bar();
    if (b) {
      const r = b.getBoundingClientRect();
      say(`bar at y=${Math.round(r.top)} h=${Math.round(r.height)} opacity=${getComputedStyle(b).opacity}`);
    }
    if (scene === "accepted") {
      key("Tab");
      flushSync();
      await tick();
      say(`Tab → draft: ${JSON.stringify(draft())}; bar ${bar() ? "still shown" : "gone"}`);
      runMenuCommand("undo_app");
      flushSync();
      await tick();
      say(`⌘Z → draft: ${JSON.stringify(draft())}`);
      runMenuCommand("redo_app");
      flushSync();
      await tick();
      say(`⌘⇧Z → draft: ${JSON.stringify(draft())}`);
    }
    if (scene === "denied") {
      key("Escape");
      flushSync();
      await tick();
      say(`Esc → draft: ${JSON.stringify(draft())}; bar ${bar() ? "still shown" : "gone"}`);
      type(" ok");
      await wait(800);
      say(`typed more, after 800 ms: bar ${bar() ? "shown: " + offered() : "not shown (s^2 declined for this draft)"}`);
    }
  } else if (scene === "many") {
    type("x squared plus y squared equals r squared, and is x_1 <= sqrt(x) when alpha = 0.05?");
    await wait(800);
    say(`offered: ${offered()}`);
    // The per-formula ✓/× show on hover; forced visible for the shot.
    await tick();
    const ones = document.querySelectorAll<HTMLElement>(".tm-one");
    ones.forEach((e) => e.style.setProperty("opacity", "1", "important"));
    say(`per-formula ✓/× pairs: ${ones.length} (forced visible; they show on hover)`);
  } else if (scene === "fence") {
    type("the code is `x_1 = 2` and\n```py\ny = x^2\n```\n> quoted s^2\nnothing else");
    await wait(800);
    say(`code, fence and quote only: bar ${bar() ? "shown: " + offered() : "not shown"}`);
  } else if (scene === "perf") {
    // Per-keystroke cost on a 2,000-character draft: one insertText plus the Svelte flush,
    // with the offer on and off (the pause timer means detection itself never runs per key).
    const base = "we have x^2 + 3x - 4 = 0 and some prose about the plan for the week. ".repeat(30).slice(0, 2000);
    // WebKit rounds performance.now() to 1 ms here, so each figure is a batch total divided by its count.
    const per = async (on: boolean) => {
      typedMathPrefs.on = on;
      setDraftText(KEY, "");
      flushSync();
      await tick();
      type(base);
      flushSync();
      await wait(50);
      const runs: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 100; i++) {
          type(i % 2 ? "a" : " ");
          flushSync();
        }
        runs.push((performance.now() - t0) / 100);
      }
      runs.sort((x, y) => x - y);
      return { med: runs[2], max: runs[4], len: box().value.length };
    };
    const off = await per(false);
    const on = await per(true);
    const text = box().value;
    const fr: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) findTypedMath(text);
      fr.push((performance.now() - t0) / 10);
    }
    fr.sort((x, y) => x - y);
    const f = (x: number) => x.toFixed(3);
    say(`draft ${on.len} chars; 5 batches of 100 keystrokes (insertText + Svelte flush), per keystroke:`);
    say(`  offer off: median ${f(off.med)} ms, worst batch ${f(off.max)} ms`);
    say(`  offer on:  median ${f(on.med)} ms, worst batch ${f(on.max)} ms   (difference = the offer's own cost)`);
    say(`findTypedMath on the draft (once per 600 ms pause, never per key): median ${f(fr[2])} ms, worst ${f(fr[4])} ms`);
    (window as unknown as { perf: unknown }).perf = { off, on, find: fr };
  }
  document.body.dataset.done = "1";
}
main().catch((e) => say("error: " + (e instanceof Error ? e.stack : String(e))));
