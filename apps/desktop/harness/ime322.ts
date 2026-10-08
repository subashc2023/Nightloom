// Item 322 (2026-10-08): Enter during an input method's composition commits the composition only; a
// second Enter sends. The real Composer, app state stubbed, driven by synthetic compositions in the two
// orders engines use — WebKit's (compositionend, then the Enter keydown with keyCode 229) and Chromium's
// (the Enter keydown with isComposing true, then compositionend) — on the textarea (?f=0) and on the
// formatted editor (?f=1, LiveBox / CodeMirror). Each case reports the box's text and whether a send went
// out after the first Enter and after the second. The page writes #cap and ends with DONE.
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";
import { EditorView } from "@codemirror/view";

const q = new URLSearchParams(location.search);
const formatted = q.get("f") === "1";
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const J = JSON.stringify;
const KEY = "chat-a";
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    calls.push(cmd);
    return null;
  },
  transformCallback: () => 0,
};

const box = (): HTMLElement =>
  document.querySelector<HTMLElement>(formatted ? ".composer .cm-content" : ".composer textarea")!;
const text = () => readDraft(KEY).text;
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
  }
  // Not setTimeout: WebKit throttles timers in an offscreen view.
  await new Promise<void>((r) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => r();
    mc.port2.postMessage(0);
  });
}
function enter(keyCode: number, isComposing: boolean): boolean {
  const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing });
  // WebKit's KeyboardEventInit may not carry keyCode; set it as the engine would.
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  Object.defineProperty(ev, "which", { get: () => keyCode });
  box().dispatchEvent(ev);
  return ev.defaultPrevented;
}
async function compose(word: string): Promise<void> {
  if (formatted) {
    setDraftText(KEY, word);
    await settle();
  }
  const el = box();
  el.focus();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: word }));
  if (el instanceof HTMLTextAreaElement) {
    el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertCompositionText", data: word, bubbles: true, cancelable: true, isComposing: true }));
    el.setRangeText(word, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: word, bubbles: true, isComposing: true }));
  }
  // CodeMirror (?f=1) reads marked text from DOM mutations a synthetic event cannot make cleanly: the word
  // went in as the draft above, and the composition events frame the keys that follow. A real composition's
  // DOM changes raise CodeMirror's own count of them above zero (its DOMObserver); set it as they would.
  if (formatted) {
    const view = EditorView.findFromDOM(el);
    if (view) (view as unknown as { inputState: { composing: number } }).inputState.composing = 1;
  }
}
/** A person's pause before the second Enter (CodeMirror drops a key within 100 ms of a composition's end). */
async function pause(ms: number): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) await settle();
}
function end(word: string): void {
  box().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: word }));
}
const sends = () => calls.filter((c) => c === "send_agent").length;

async function one(order: "webkit" | "chromium", word: string): Promise<boolean> {
  setDraftText(KEY, "");
  // The stub never ends a turn: each case starts idle, so a send is a send and not a queued message.
  app.busy = false;
  await settle();
  calls.length = 0;
  await compose(word);
  await settle();
  let prevented: boolean;
  if (order === "webkit") {
    end(word);
    prevented = enter(229, false);
  } else {
    prevented = enter(229, true);
    end(word);
  }
  await settle();
  const afterFirst = text();
  const sentFirst = afterFirst === "" || sends() > 0;
  const before = sends();
  await pause(150);
  const prevented2 = enter(13, false);
  for (let i = 0; i < 20 && sends() === before; i++) await settle();
  const afterSecond = text();
  const sentSecond = sends() > before;
  const ok = !sentFirst && afterFirst.includes(word) && !afterFirst.includes("\n") && sentSecond;
  say(
    `${order.padEnd(8)} ${J(word)}: 1st Enter (composing) → box ${J(afterFirst)}, prevented=${prevented}, sent=${sentFirst}; ` +
      `2nd Enter → box ${J(afterSecond)}, prevented=${prevented2}, sent=${sentSecond}; ${ok ? "OK" : "FAIL"}`,
  );
  return ok;
}

async function main(): Promise<void> {
  composerFormat.on = formatted;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  await settle();
  say(`box: ${formatted ? "formatted editor (LiveBox)" : "textarea"}`);
  let fails = 0;
  for (const order of ["webkit", "chromium"] as const)
    for (const w of ["にほん", "中文", "é"]) if (!(await one(order, w))) fails++;
  say(`fails=${fails}`);
  say("DONE");
}
void main().catch((e) => say(`error: ${String(e)}\nDONE`));
