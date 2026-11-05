// Item 490 harness — see math490.html. The real Composer, app state stubbed, his screenshot's draft
// (two lines already wrapped, one `$O (1)` left open). #plain | #plain-all | #fmt | #fmt-all: the plain
// box or the formatted (CodeMirror) box; "-all" presses Tab (Use maths for all) and shows the draft after.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";

const [scene, palette] = (location.hash.slice(1) || "plain").split("@");
if (palette) document.documentElement.dataset.palette = palette;
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "chat-a";
const SHOT =
  "1. push: $O (1)$, pop: $O (1)$, peek $O (1)$\n2. enqueue: $O (1)$, dequeue: $O (1)\n3. O(1), O(1)\n4. worst case is O(n), amortized O(1)\n5. push: O(1) pop: O(n), amortized O(1)\n\n6. ";

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};

const fmt = scene.startsWith("fmt");
const box = () => document.querySelector<HTMLElement>(fmt ? ".composer .cm-content" : ".composer textarea")!;
const bar = () => document.querySelector<HTMLElement>(".tm-bar");
function key(k: string): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}
const draft = () => readDraft(KEY).text;
const chips = () =>
  [...document.querySelectorAll(".tm-item")]
    .map((li) => `${li.querySelector(".tm-src")?.textContent}${li.querySelector(".tm-count")?.textContent ?? ""}`)
    .join(" | ");
const button = () => document.querySelector(".tm-use")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

async function main(): Promise<void> {
  composerFormat.on = fmt;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  setDraftText(KEY, SHOT);
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  box().focus();
  // A keystroke-free nudge: the offer runs after a typing pause on the draft's text.
  setDraftText(KEY, SHOT + " ");
  flushSync();
  setDraftText(KEY, SHOT);
  flushSync();
  await wait(900);
  say(`${fmt ? "formatted" : "plain"} box, his screenshot's draft`);
  say(`chips: ${bar() ? chips() : "(no bar)"}; button "${button()}"`);
  if (scene.endsWith("-all")) {
    key("Tab");
    flushSync();
    await tick();
    await wait(50);
    say(`Tab (Use maths for all) → draft:\n${draft()}`);
    const lines = draft().split("\n");
    const odd = lines.filter((l) => ((l.match(/(?<![\\$])\$(?!\$)/g) ?? []).length) % 2 === 1).length;
    say(`lines ${lines.length} (was ${SHOT.split("\n").length}); lines with an unpaired $: ${odd}`);
  }
  document.body.dataset.done = "1";
}
main().catch((e) => say("error: " + (e instanceof Error ? e.stack : String(e))));
