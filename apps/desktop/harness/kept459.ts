// Item 459 harness — see kept459.html. The real Composer and the real NotesPanel side by side, app state stubbed:
// three chips in the box (an image, a kept PDF, a file not kept). The page clicks each and logs what happened:
// the left tab, the notices the panel was given, and which Notes row flashed. #seq ; "@C" picks the palette.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { addAttachment, nextAttachmentId } from "../src/lib/drafts.svelte";
import { keepKey } from "../src/lib/keep";
import { keeps } from "../src/lib/keep.svelte";
import { pngDataUrl } from "./files362";

const [, palette] = (location.hash.slice(1) || "seq").split("@");
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

const note = (name: string) => ({ name, bytes: 1200, modified: "2026-10-28T20:00:00Z", summary: name.endsWith(".md") ? name.replace(/\.md$/, "") : null });
const flashed = () => [...document.querySelectorAll<HTMLElement>("#notes [data-note].flash")].map((e) => e.dataset.note).join(", ") || "none";

async function main(): Promise<void> {
  composerFormat.on = false;
  app.project = { id: "p1", name: "CS 161", root: "/tmp/cs161", notes_dir: "/tmp/cs161/.agents" } as unknown as typeof app.project;
  app.notes = [
    ...Array.from({ length: 24 }, (_, i) => note(`lecture-${String(i + 1).padStart(2, "0")}.md`)),
    note("files/notes.pdf"),
    note("files/whiteboard.png"),
    note("syllabus.md"),
  ] as typeof app.notes;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;

  const png = (await pngDataUrl()).split(",")[1];
  const pdf = "JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoK";
  addAttachment(KEY, { id: nextAttachmentId(), kind: "image", name: "whiteboard.png", media_type: "image/png", data: png } as never);
  addAttachment(KEY, { id: nextAttachmentId(), kind: "document", name: "notes.pdf", media_type: "application/pdf", data: pdf } as never);
  addAttachment(KEY, { id: nextAttachmentId(), kind: "document", name: "draft.txt", media_type: "text/plain", data: "aGVsbG8=" } as never);
  keeps[keepKey("notes.pdf", pdf)] = { phase: "kept", rel: "files/notes.pdf" };
  keeps[keepKey("whiteboard.png", png)] = { phase: "kept", rel: "files/whiteboard.png" };

  const { default: Composer } = await import("../src/lib/Composer.svelte");
  const { default: NotesPanel } = await import("../src/lib/NotesPanel.svelte");
  mount(NotesPanel, { target: document.getElementById("notes")!, props: {} });
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  await wait(100);

  const chip = (name: string) => [...document.querySelectorAll<HTMLElement>(".composer .attachment")].find((e) => e.textContent?.includes(name) || e.querySelector(`img[alt="${name}"]`));
  const click = async (name: string, what: string) => {
    const c = chip(name)!;
    const target = c.querySelector<HTMLElement>(".file") ?? c.querySelector<HTMLElement>("img")!;
    app.leftTab = "chats";
    target.click();
    flushSync();
    await tick();
    await wait(400);
    say(`click ${what} → left tab ${app.leftTab}; Notes row flashing: ${flashed()}`);
  };
  say(`chips: whiteboard.png (image, kept), notes.pdf (kept), draft.txt (not kept)`);
  await click("draft.txt", "draft.txt (not kept)");
  await click("whiteboard.png", "whiteboard.png (image)");
  await click("notes.pdf", "notes.pdf (kept)");
  const row = document.querySelector<HTMLElement>('#notes [data-note="project:files/notes.pdf"]');
  const panel = document.querySelector<HTMLElement>("#notes .panel");
  if (row && panel) {
    const r = row.getBoundingClientRect();
    const b = panel.getBoundingClientRect();
    const seen = r.top >= b.top && r.bottom <= b.bottom;
    say(`files/notes.pdf row at y=${Math.round(r.top - b.top)} in the panel's ${Math.round(b.height)}px (scrolled ${Math.round(panel.scrollTop)}px): ${seen ? "in view" : "NOT in view"}`);
  }
  document.body.dataset.done = "1";
}
main().catch((e) => say("error: " + (e instanceof Error ? e.stack : String(e))));
