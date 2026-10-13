// Item 284 harness — see paste284.html. ?s= one of: cmdv-short, cmdv-long, converted, undo, attach, image,
// reloaded (run after attach: the page reloads without clearing the drafts store), transcript, transcript-open.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, flushDrafts } from "../src/lib/drafts.svelte";
import type { SessionEvent } from "../src/lib/types";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "cmdv-long";
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => (i % 12 === 11 ? "watermark.\n" : ["the", "runner", "advances", "only", "on", "success", "and", "redoes", "a", "failed", "unit", "—"][i % 12])).join(" ");
const LONG = words(2431);
const SHORT = "a short paste";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The Tauri bridge, faked: `paste_into_focus` answers as the Mac does — yes,
// and then the webview's paste event arrives with the clipboard.
let clipboard: { text: string; png?: boolean } = { text: "" };
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "paste_into_focus") {
      setTimeout(() => paste(clipboard.text, clipboard.png), 30);
      return true;
    }
    return null;
  },
  transformCallback: () => 0,
};

function box(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
}

/** A paste as WebKit delivers it; if the page lets it through, the text
 *  lands at the caret the way the browser's own insert would. */
function paste(text: string, png = false): boolean {
  const ta = box();
  ta.focus();
  const dt = new DataTransfer();
  if (text) dt.setData("text/plain", text);
  if (png) {
    const bin = atob(PNG);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
  }
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  if (!ev.defaultPrevented && text) {
    ta.setRangeText(text.replace(/\r\n?/g, "\n"), ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return ev.defaultPrevented;
}

function chips(): string {
  return JSON.stringify(readDraft("chat-a").attachments.map((a) => ({ name: a.name, label: a.label, kind: a.kind, media: a.media_type, pasted: a.pasted ?? false })));
}
function offerRow(): string {
  return document.querySelector(".paste-offer")?.textContent?.replace(/\s+/g, " ").trim() ?? "(none)";
}
function click(label: string): void {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".paste-offer button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  b.click();
}
function typeKey(init: KeyboardEventInit): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

async function composer(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  const ta = box();
  if (s === "reloaded") {
    say(`after reload: chips=${chips()} box=${JSON.stringify(ta.value)}`);
    return;
  }
  ta.focus();
  if (s !== "attach" && s !== "image") {
    ta.value = "";
    const intro = "Please summarise this: ";
    ta.setRangeText(intro, 0, 0, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const before = ta.value;
    const prevented = paste(s === "cmdv-short" ? SHORT : LONG);
    await wait(50);
    say(`⌘V: paste prevented=${prevented}; box chars=${ta.value.length} (intro ${before.length} + paste); chips=${chips()}`);
    say(`offer row: ${offerRow()}`);
    if (s === "converted" || s === "undo") {
      const full = ta.value;
      click("Make this an attachment");
      await wait(150);
      say(`after click: box=${JSON.stringify(ta.value)} chips=${chips()}`);
      say(`offer row: ${offerRow()}`);
      if (s === "undo") {
        click("Undo");
        await wait(80);
        say(`after Undo: box restored exactly=${ta.value === full} (chars ${ta.value.length}); chips=${chips()}; caret=${ta.selectionStart}`);
        say(`offer row: ${offerRow()}`);
      }
    }
    return;
  }
  ta.value = "";
  ta.setRangeText("Notes from today, attached:", 0, 0, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  clipboard = s === "image" ? { text: "", png: true } : { text: words(1240) };
  typeKey({ key: "√", code: "KeyV", metaKey: true, altKey: true });
  await wait(200);
  say(`⌥⌘V (${s === "image" ? "an image on the clipboard" : "1,240 words of text on the clipboard"}): box=${JSON.stringify(ta.value)} chips=${chips()}`);
  if (s === "attach") {
    flushDrafts();
    const stored = JSON.parse(localStorage.getItem("nightloom.drafts") ?? "{}");
    say(`drafts store: ${JSON.stringify((stored["chat-a"]?.attachments ?? []).map((a: { name: string; pasted?: boolean; data: string }) => ({ name: a.name, pasted: a.pasted, chars: a.data.length })))}`);
  }
}

async function transcript(): Promise<void> {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
  app.activeSessionId = "s";
  app.events = [
    {
      event: "user_message",
      text: "Please summarise the attached notes.",
      documents: [{ media_type: "text/plain", data: b64(words(240)), name: "Pasted text" }],
      at,
    } as SessionEvent,
    {
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [{ type: "text", text: "The notes say the runner advances its watermark only on success." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2000, output_tokens: 40 },
      at,
    } as unknown as SessionEvent,
  ];
  const { default: Transcript } = await import("../src/lib/Transcript.svelte");
  mount(Transcript, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await wait(100);
  const t = document.querySelector<HTMLButtonElement>(".user-file-toggle");
  say(`toggle: ${t?.textContent?.trim() ?? "(none)"}; open texts=${document.querySelectorAll(".user-file-text").length}`);
  if (s === "transcript-open" && t) {
    t.click();
    await wait(80);
    say(`after click: toggle=${t.textContent?.trim()}; open texts=${document.querySelectorAll(".user-file-text").length}; first chars=${JSON.stringify(document.querySelector(".user-file-text")?.textContent?.slice(0, 40))}`);
  }
}

void (s.startsWith("transcript") ? transcript() : composer()).catch((e) => say(`error: ${String(e)}`));
