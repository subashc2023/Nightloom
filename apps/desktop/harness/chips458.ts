// Item 458 harness — see chips458.html. The real Composer: type, attach an image through the Attach picker,
// type more, remove a chip with its ×, then ⌘Z / ⌘⇧Z through the Edit menu's route, logging the box and the chips
// after every step. #seq (default) ; "@C" picks the palette.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app, runMenuCommand } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";
import { pdfFile, pngFile } from "./files362";

const [scene, palette] = (location.hash.slice(1) || "seq").split("@");
if (palette) document.documentElement.dataset.palette = palette;
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "chat-a";
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0 };

const box = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
function type(t: string): void {
  box().focus();
  document.execCommand("insertText", false, t);
}
const state = () => {
  const d = readDraft(KEY);
  return `box ${JSON.stringify(d.text)} · chips [${d.attachments.map((a) => a.name).join(", ")}]`;
};
async function settle(): Promise<void> {
  flushSync();
  await tick();
  await wait(60);
}
async function attach(files: File[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.composer input[type="file"]')!;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 40 && readDraft(KEY).attachments.length < files.length; i++) await wait(25);
  await settle();
}
async function step(dir: "undo" | "redo"): Promise<void> {
  runMenuCommand(dir === "undo" ? "undo_app" : "redo_app");
  await settle();
  const drawn = document.querySelectorAll(".composer .attachment").length;
  say(`${dir === "undo" ? "⌘Z " : "⌘⇧Z"} → ${state()} · ${drawn} drawn`);
}

async function main(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  await settle();
  box().focus();

  type("look at ");
  await settle();
  await attach([await pngFile("whiteboard.png")]);
  say(`attach whiteboard.png → ${state()}`);
  type("this");
  await settle();
  await attach([pdfFile("notes.pdf")]);
  say(`attach notes.pdf → ${state()}`);
  document.querySelector<HTMLButtonElement>('.composer button[aria-label="remove whiteboard.png"]')!.click();
  await settle();
  say(`× whiteboard.png → ${state()}`);
  for (let i = 0; i < 5; i++) await step("undo");
  for (let i = 0; i < 5; i++) await step("redo");
  if (scene === "end") for (let i = 0; i < 2; i++) await step("undo");
  document.body.dataset.done = "1";
}
main().catch((e) => say("error: " + (e instanceof Error ? e.stack : String(e))));
