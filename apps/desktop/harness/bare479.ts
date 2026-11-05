// Item 479 harness — see bare479.html. The real Composer, app state stubbed, driven by the page:
// bare LaTeX typed without its dollars gets the typed-maths bar's "Wrap as maths".
// #his | #line | #accepted | #nothing ; "@C" after it picks the palette (default A).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app, runMenuCommand } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";

const [scene, palette] = (location.hash.slice(1) || "his").split("@");
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
function key(k: string): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}
const draft = () => readDraft(KEY).text;
const offered = () => [...document.querySelectorAll(".tm-src")].map((e) => e.textContent).join(" | ");
const label = () => document.querySelector(".tm-label")?.textContent ?? "";
const button = () => document.querySelector(".tm-use")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

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

  const text =
    scene === "line"
      ? "the sets are:\n\\overline{A}+B"
      : scene === "nothing"
        ? "it is in C:\\Users\\me, print \\n, run `echo \\alpha`, already $\\beta$"
        : "4. \\sigma{1, 2, 4}";
  type(text);
  await wait(800);
  say(`typed ${JSON.stringify(text)}`);
  say(`after 800 ms: bar ${bar() ? `"${label()}", offered ${offered()}, button "${button()}"` : "not shown"}`);
  if (scene === "accepted" || scene === "line") {
    key("Tab");
    flushSync();
    await tick();
    say(`Tab → draft: ${JSON.stringify(draft())}; bar ${bar() ? "still shown" : "gone"}`);
    runMenuCommand("undo_app");
    flushSync();
    await tick();
    say(`⌘Z → draft: ${JSON.stringify(draft())}`);
  }
  document.body.dataset.done = "1";
}
main().catch((e) => say("error: " + (e instanceof Error ? e.stack : String(e))));
