// Backlog 383 review harness — see handoff383.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { handoff, readOrder, setReadOrder, message, setMessage } from "../src/lib/handoff.svelte";

const s = new URLSearchParams(location.search).get("s") ?? "due";
const cap = document.getElementById("cap")!;
const say = (l: string) => (cap.textContent += l + "\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd.includes("thread") ? [] : null),
  transformCallback: () => 0,
};

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>(".composer button, .handoff button")].find((b) => b.textContent?.trim() === label);
}

async function run(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
  handoff.chat = "chat-a";
  handoff.used = 171_000;
  handoff.limit = 200_000;
  handoff.fill = 0.855;
  handoff.stage = s === "due" ? "due" : "wrapped";
  handoff.startPrompt = s === "due" ? null : "Read HANDOFF.md's newest STATE section, then backlog/INDEX.md.";
  const typedMsg = "Wrap up: finish item 383, write the STATE section, push.";
  const typedOrder = "Read CONTRACT.md first, then HANDOFF.md.";
  setMessage("chat-a", typedMsg);
  setReadOrder("chat-a", typedOrder);
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  const vw = window.innerWidth;
  if (s === "stayed") {
    button("Stay here")!.click();
    await wait(60);
    const b = button("Hand off");
    const r = b?.getBoundingClientRect();
    say(`window=${vw}px; after Stay here: stage=${handoff.stage}; Hand off button=${b ? `shown at x=${Math.round(r!.left)}..${Math.round(r!.right)} (box right edge ${Math.round(document.querySelector(".composer")!.getBoundingClientRect().right)})` : "MISSING"}`);
    b?.click();
    await wait(60);
    say(`after Hand off: stage=${handoff.stage}; read order kept=${readOrder("chat-a") === typedOrder}; card shown=${!!document.querySelector('.handoff[aria-label="Hand-off done"]')}`);
    // Back to the stayed state for the shot.
    button("Stay here")!.click();
    await wait(60);
    return;
  }
  button("Minimize")!.click();
  await wait(60);
  const line = document.querySelector<HTMLElement>(".handoff-min");
  if (!line) return say("folded line MISSING");
  const lr = line.getBoundingClientRect();
  const kids = [...line.children].map((c) => (c as HTMLElement).getBoundingClientRect());
  const over = line.scrollWidth > line.clientWidth + 1 || kids.some((k) => k.right > lr.right + 1);
  say(`window=${vw}px; folded line ${Math.round(lr.width)}x${Math.round(lr.height)}px, overflows=${over}, buttons=[${[...line.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(", ")}]`);
  button("Expand")!.click();
  await wait(60);
  const ta = [...document.querySelectorAll<HTMLTextAreaElement>(".handoff textarea")].map((t) => t.value);
  say(`after Expand: typed ${s === "due" ? "wrap-up" : "read order"} kept=${s === "due" ? message("chat-a") === typedMsg && ta.includes(typedMsg) : readOrder("chat-a") === typedOrder && ta.includes(typedOrder)}`);
  button("Minimize")!.click();
  await wait(60);
}
void run().catch((e) => say(`error: ${String(e)}`));
