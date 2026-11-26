// @vitest-environment happy-dom
/*
 * Items 996, 997, 998 (the real-app verify sweep, 2026-11-25, rows 11, 17, 21): the REAL Composer and ⌘P's list
 * (Palette) mounted in a DOM, driven by key events.
 * - 998: a bare command typed in full (`/model`, `/keepwarm` …) runs on ONE Return, in the main chat's box and an
 *   aside's; a command that needs words (`/note`) still completes to `/note `; Tab still completes, and a row ↑/↓
 *   moved to is still picked (blocker 2293's default for picking a row).
 * - 997: bare `/project` opens the projects list and switches nothing — the Return that ran it no longer reaches
 *   the list's own window handler (which opened the first project, Home).
 * - 996: `/terminal` makes a new shell in the project folder, in front, even when the dock already shows the
 *   Agent commands tab (or is hidden).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.hoisted(() => {
  (globalThis as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ = "macos";
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});
const calls = vi.hoisted(() => [] as { cmd: string; args: unknown }[]);
let nextPty = 100;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "terminal_open") {
      const a = args as { cwd: string };
      return { id: nextPty++, shell: "zsh", cwd: a.cwd, pid: 4242 };
    }
    throw new Error("no backend");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

// happy-dom rejects an animation's `finished` when Svelte cancels a menu's transition (the box's menu closing
// as a command runs); a browser's rejection there is handled. Not this test's concern.
{
  const A = (globalThis as { Animation?: { prototype: { cancel(): void; finished?: Promise<unknown> } } }).Animation;
  if (A) {
    const cancel = A.prototype.cancel;
    A.prototype.cancel = function (this: { finished?: Promise<unknown> }) {
      this.finished?.catch(() => {});
      return cancel.call(this);
    };
  }
}
await import("./asides.svelte");
const { app } = await import("./state.svelte");
const { drafts, readDraft } = await import("./drafts.svelte");
const { asideDraftKey } = await import("./asides");
const { composerFormat } = await import("./composerFormat.svelte");
const { term } = await import("./terminal.svelte");
const { saved } = await import("./savedPromptsStore.svelte");
const { APP_COMMANDS, commandsOn, runsAlone } = await import("./appCommands");
const Composer = (await import("./Composer.svelte")).default;
const Palette = (await import("./Palette.svelte")).default;

const PROJECTS = [
  { id: "home", name: "Home", root: "/h", exists: true },
  { id: "stats", name: "STATS 67", root: "/w/STATS-67", exists: true },
  { id: "vg", name: "Value Generalization", root: "/w/VG", exists: true },
];

let mounted: Record<string, unknown>[] = [];
// Unhandled rejections from actions whose backend the mock refuses (a new chat, Save memory) are not this test's.
const swallow = (e: PromiseRejectionEvent) => e.preventDefault?.();

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  composerFormat.on = false;
  app.asides = [];
  app.connecting = true;
  app.activeSessionId = "chat-A";
  app.projects = PROJECTS as never;
  app.project = PROJECTS[1] as never;
  app.overlay = null;
  app.toasts = [];
  term.shells = [];
  for (const k of Object.keys(term.docks)) delete term.docks[k];
  term.pane = null;
  saved.list = [];
  calls.length = 0;
  document.body.innerHTML = "";
  window.addEventListener("unhandledrejection", swallow as never);
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
  window.removeEventListener("unhandledrejection", swallow as never);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}
async function show(props: Record<string, unknown> = {}): Promise<void> {
  mounted.push(mount(Composer, { target: document.body, props }));
  mounted.push(mount(Palette, { target: document.body, props: {} }));
  await settle();
}
const box = () => document.querySelector("textarea[data-own-undo]") as HTMLTextAreaElement;
function type(s: string): void {
  const ta = box();
  ta.focus();
  for (const ch of s) {
    ta.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
    const at = ta.selectionStart;
    ta.value = ta.value.slice(0, at) + ch + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = at + 1;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  }
  flushSync();
}
/** A key in the box, bubbling to the window as WebKit's does. */
function key(k: string): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  flushSync();
}
const toasts = () => app.toasts.map((t) => t.text);

describe("998: a bare command typed in full runs on one Return", () => {
  it("/model opens the model menu on the first Return, the box emptied", async () => {
    await show();
    type("/model");
    expect(document.querySelector('[role="listbox"], .slash')).not.toBeNull();
    key("Enter");
    await settle();
    expect(readDraft("chat-A").text).toBe("");
    expect(document.querySelector('.pick-menu[aria-label="Model"]')).not.toBeNull();
  });

  for (const surface of ["chat", "aside"] as const) {
    const names = commandsOn(surface).filter(runsAlone).map((c) => c.name);
    it(`every bare-runnable command (${names.length}) in the ${surface}'s box: one Return runs it, never "/name "`, async () => {
      let n = 7;
      for (const name of names) {
        // A fresh aside per command: each its own box and draft.
        const a = { id: n, uid: `uid-${n++}`, quote: null, draft: false, anchor: null, turns: [] } as never;
        const draftKey = surface === "aside" ? asideDraftKey(a) : "chat-A";
        await settle();
        for (const k of Object.keys(drafts)) delete drafts[k];
        app.toasts = [];
        app.overlay = null;
        if (surface === "aside") app.asides = [a];
        await show(surface === "aside" ? { aside: a, takeFocus: true } : {});
        type(`/${name}`);
        key("Enter");
        await settle();
        const after = readDraft(draftKey).text;
        // Ran: the box emptied; or could not run here and said why, the box as typed. Never the menu's completion.
        expect([after, toasts()], `/${name}`).not.toEqual([`/${name} `, []]);
        expect(after === "" || toasts().length > 0, `/${name}: ${JSON.stringify(after)} ${toasts()}`).toBe(true);
        expect(after, `/${name}`).not.toBe(`/${name} `);
        for (const c of mounted) unmount(c);
        mounted = [];
        document.body.innerHTML = "";
      }
    });
  }

  it("a command that needs its words (/note, /rename, /aside, /schedule) still completes to '/name '", async () => {
    const needs = APP_COMMANDS.filter((c) => !runsAlone(c)).map((c) => c.name);
    expect(needs.sort()).toEqual(["aside", "note", "rename", "schedule"]);
    await show();
    type("/note");
    key("Enter");
    await settle();
    expect(readDraft("chat-A").text).toBe("/note ");
    expect(toasts()).toEqual([]);
  });

  it("Tab still completes a full name (blocker 2293), and a row ↑/↓ moved to is picked, not the typed name", async () => {
    await show();
    type("/model");
    key("Tab");
    await settle();
    expect(readDraft("chat-A").text).toBe("/model ");

    for (const k of Object.keys(drafts)) delete drafts[k];
    for (const c of mounted) unmount(c);
    mounted = [];
    document.body.innerHTML = "";
    saved.list = [
      { name: "newsletter", body: "LETTER BODY" },
      { name: "newyear", body: "YEAR BODY" },
    ] as never;
    await show();
    type("/new");
    // Unmoved: the typed name runs (a new chat), ahead of the saved prompt drawn first.
    key("Enter");
    await settle();
    expect(readDraft("chat-A").text).not.toContain("LETTER");
    expect(readDraft("chat-A").text).not.toBe("/new ");

    for (const k of Object.keys(drafts)) delete drafts[k];
    for (const c of mounted) unmount(c);
    mounted = [];
    document.body.innerHTML = "";
    await show();
    type("/new");
    key("ArrowDown");
    key("Enter");
    await settle();
    expect(readDraft("chat-A").text).toContain("YEAR BODY");
  });
});
