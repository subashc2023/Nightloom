// Item 890 harness — see slash890.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { setLayout } from "../src/lib/layout.svelte";

const h = new URLSearchParams(location.hash.slice(1));
const which = h.get("case") ?? "menu";
const typed = h.get("text") ?? "/ta";
const cap = document.getElementById("cap")!;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  setLayout(h.get("layout") === "classic" ? "classic" : "filament");
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  (app as unknown as { events: unknown[] }).events = [{ kind: "x" }];
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  const ta = document.querySelector<HTMLTextAreaElement>(".ta-wrap textarea")!;
  ta.focus();
  ta.value = typed;
  ta.setSelectionRange(typed.length, typed.length);
  ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: typed.slice(-1), inputType: "insertText" }));
  ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: typed.slice(-1) }));
  flushSync();
  await tick();
  await wait(100);
  const rows = [...document.querySelectorAll(".slash .slash-row")].map((r) => r.textContent?.trim()).join(" | ");
  if (which === "esc") {
    ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    flushSync();
    await tick();
    await wait(1500);
  }
  if (which === "table") {
    ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    flushSync();
    await tick();
    await wait(Number(h.get("after") ?? 400));
  }
  const cells = document.querySelectorAll("textarea.cm-cgrid-cell").length;
  const focused = document.activeElement as HTMLElement | null;
  const where = focused?.classList.contains("cm-cgrid-cell") ? `cell r${focused.dataset.r} c${focused.dataset.c}` : focused?.tagName ?? "none";
  const menu = document.querySelector(".slash")?.getBoundingClientRect();
  const box = document.querySelector(".ta-wrap")?.getBoundingClientRect();
  cap.textContent =
    `case=${which} layout=${h.get("layout") ?? "jarvis"} width=${innerWidth} · typed ${JSON.stringify(typed)} · menu rows: ${rows || "(closed)"}` +
    (menu && box ? ` · menu ${Math.round(menu.width)}px wide, bottom ${Math.round(menu.bottom)} ≤ box top ${Math.round(box.top)}: ${menu.bottom <= box.top + 1}` : "") +
    (which === "table" ? ` · grid cells: ${cells} · focus: ${where}` : "") +
    ` · .slash elements: ${document.querySelectorAll(".slash").length}, inert (outroing): ${(document.querySelector(".slash") as HTMLElement | null)?.inert ?? "-"}, animations: ${document.querySelector(".slash")?.getAnimations().map((a) => a.playState).join("/") ?? "-"}` +
    ` · draft has table: ${(localStorage.getItem("nightloom.drafts") ?? "").includes("---")}` +
    ` · box text: ${JSON.stringify(document.querySelector(".cm-content")?.textContent ?? (document.querySelector(".ta-wrap textarea") as HTMLTextAreaElement | null)?.value)}`;
}
void main();
