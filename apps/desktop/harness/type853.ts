// Item 853 (fix 2) — see type853.html. The real App on a chat; a click where he clicks, then "h".
import "../src/app.css";
import "../src/composerControls.css";
import "../src/composerRow.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app, openSession, activateTab } from "../src/lib/state.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { openContent } from "../src/lib/state/tabs.svelte";
import { TYPE_BLOCKERS } from "../src/lib/typeToCompose";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? (location.search || location.hash.slice(1)));
const sc = q.get("sc") ?? "main";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const W = window as unknown as Record<string, unknown>;

const project = { id: "nl", name: "Nightloom", root: "/Users/you/code/nightloom", notes_dir: "/Users/you/code/nightloom/.agents/notes", chats: 1, notes: 0, exists: true };
const sessions = [{ id: "c1", title: "Cheat sheet", mode: "normal", kind: "chat", modified: ago(1) }];
const MAIN = "MAINTEXT the cheat sheet has the log and derivative rules, in two columns.";
const ASIDE = "ASIDETEXT yes, in step 10 the AB term can be dropped and the expression becomes A plus B.";
const events = [
  { event: "user_message", text: "Make me a cheat sheet", at: ago(30) },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text: MAIN }], stop_reason: "end_turn", usage: { input_tokens: 4200, output_tokens: 90 }, at: ago(29) },
];

W.__stub = async (cmd: string) => {
  switch (cmd) {
    case "list_models": return ["claude-opus-5-5"];
    case "list_projects": return [project];
    case "list_sessions": return sessions;
    case "open_session": return events;
    case "providers": return [{ kind: "anthropic", available: true, default_model: "claude-opus-5-5", key_source: "stored" }];
    case "schedule_probe": return { due_ms: [], limit_ms: null };
    case "list_proposals": case "named_files": case "for_you_files": case "search_backends": case "centre_proposals": case "centre_dream_commits": case "turn_usage": case "list_threads": case "nightshift_projects": case "list_notes":
      return [];
    default: return null;
  }
};

/** A click as WebKit on macOS gives it: pointerdown/mousedown, then the focus to the nearest mouse-focusable
 *  ancestor (a button is not one), else the body; then mouseup and click. */
function click(el: Element): void {
  const o = { bubbles: true, cancelable: true, composed: true, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", o));
  const down = el.dispatchEvent(new MouseEvent("mousedown", o));
  if (down) {
    const f = el.closest<HTMLElement>('[tabindex], a[href], input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (f && !f.closest("[inert]")) f.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }
  el.dispatchEvent(new PointerEvent("pointerup", o));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  el.dispatchEvent(new MouseEvent("click", o));
}

/** A typed key: keydown at the focus; if nothing prevented it and the focus is a field, the character goes in. */
function type(ch: string): void {
  const t = (document.activeElement as HTMLElement | null) ?? document.body;
  const ok = t.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true, composed: true }));
  const a = document.activeElement as HTMLElement | null;
  if (ok && a && (a instanceof HTMLTextAreaElement || a.isContentEditable)) document.execCommand("insertText", false, ch);
}

/** The element whose own text holds `needle` (deepest). */
function textEl(needle: string, within: ParentNode = document): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of Array.from(within.querySelectorAll<HTMLElement>("p, span, div, li"))) if (el.textContent?.includes(needle) && !el.closest("[inert]")) best = el;
  return best;
}

function boxText(root: Element | null): string {
  const b = root?.querySelector<HTMLElement>(".ta-wrap textarea, .ta-wrap .cm-content");
  if (!b) return "∅";
  if (b instanceof HTMLTextAreaElement) return b.value;
  const c = b.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".cm-placeholder").forEach((n) => n.remove());
  return "cm:" + (c.textContent ?? "");
}

function where(el: Element | null): string {
  if (!el) return "null";
  if (el === document.body) return "BODY";
  const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  const in_ = el.closest(".aside-card") ? "@card" : el.closest(".composer") ? "@composer" : el.closest(".aside-view") ? "@tab" : "";
  return `${el.tagName}${cls ? "." + cls : ""}${in_}`;
}

async function run() {
  document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>");
  if (q.get("classic") === "1") setLayout("classic");
  mount(App, { target: document.getElementById("app")! });
  flushSync();
  await wait(350);
  app.projects = [project] as unknown as typeof app.projects;
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.connection = { provider: "anthropic", model: "claude-opus-5-5", thinking: "default", tools: true, contextLimit: 1_000_000, price: null, mcp: [], reviewers: [], workspace: project.root, search: null, knowledge: null, engine: "claude-code", agent: null } as unknown as typeof app.connection;
  await tick();
  await openSession("c1");
  await wait(500);
  flushSync();
  const floating = sc.startsWith("card") || sc === "main-with-card";
  // *-scroll (blocker 2204): no click — a wheel over the place, then the key.
  const scrollCase = sc.endsWith("-scroll");
  // anchor-*: the card as his are — anchored to a passage (no `moved`), drawn beside it in the transcript.
  const anchored = sc.startsWith("anchor") || sc === "main-with-anchor" || sc === "main-topbar" || sc === "main-scroll";
  const wheel = () => {
    if (!scrollCase || !target) return;
    target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 }));
  };
  const finish = () => {
    // anchor-finish: the aside's reply ends between the click and the key.
    const t = (app as unknown as { asides: { turns: { answer: string }[] }[] }).asides[0]?.turns[0];
    if (sc === "anchor-finish" && t) t.answer = ASIDE;
    flushSync();
  };
  const tab = sc.startsWith("tab");
  const panel = sc.startsWith("panel");
  if (floating || anchored || tab || panel) {
    const aside = {
      id: 1, uid: "u853", quote: anchored ? { text: "the cheat sheet has the log", role: "assistant", ordinal: 1 } : null, draft: false,
      anchor: anchored ? { turn: 1, block: 0, start: 9, end: 36, side: "below" } : null,
      moved: floating ? { left: 80, top: 80, width: 420, from: "column" as const } : null,
      turns: [{ seq: 1, question: "Is step 10 right?", partial: ASIDE, answer: sc === "anchor-finish" ? "" : ASIDE, error: null, cancelled: false, cacheRead: 4200, model: "claude-opus-5-5", usage: { input_tokens: 4200, output_tokens: 80 } }],
    };
    (app as unknown as { asides: unknown[] }).asides = [aside];
    if (panel) {
      (app as unknown as Record<string, unknown>).asidePanel = "c1";
      (app as unknown as Record<string, unknown>).asidePanelThread = 1;
    }
    await tick();
    if (tab) await openContent({ kind: "aside", session: "c1", thread: 1 } as never, "new");
    // tab-switch-*: to the chat's tab and back to the aside's, as a Ctrl+Tab or two clicks on the strip do.
    if (sc.startsWith("tab-switch")) {
      const p = app.tabs.panes[0];
      const asideTab = p.tabs.find((t) => t.id === p.active)!;
      const other = p.tabs.find((t) => t.id !== asideTab.id);
      if (other) {
        await activateTab(other.id);
        await wait(300);
        await activateTab(asideTab.id);
        await wait(400);
      }
    }
    await wait(600);
    flushSync();
  }
  const card = document.querySelector(".aside-card");
  const view = document.querySelector(".content:not(.away) .aside-view") ?? document.querySelector(".aside-view");
  const asideBoxRoot = card?.querySelector(".composer") ?? (tab ? document.querySelector(".content:not(.away) .composer.aside") : null);
  const mainBoxRoot = Array.from(document.querySelectorAll(".composer")).find((c) => !c.closest(".aside-card") && !c.classList.contains("aside") && !c.closest("[inert]")) ?? null;
  // Where he clicks.
  let target: Element | null = null;
  if (sc === "main" || sc === "main-with-card" || sc === "main-with-anchor" || sc === "seed") target = textEl("MAINTEXT");
  else if (sc === "main-scroll") target = textEl("MAINTEXT");
  else if (sc.endsWith("-thread") || sc === "anchor-finish" || sc === "tab-switch" || (scrollCase && sc !== "main-scroll")) target = textEl("ASIDETEXT", card ?? view ?? document);
  else if (sc === "card-head" || sc === "anchor-head") target = card?.querySelector(".aside-card-head .aside-card-of") ?? card?.querySelector(".aside-card-head") ?? null;
  else if (sc === "card-border" || sc === "anchor-border") target = card;
  // main-topbar: the chat's top bar (its own text, no field), e.g. after reading the gauge.
  else if (sc === "main-topbar") target = document.querySelector("section.pane.focused .topbar");
  else if (sc === "tab-head") target = view?.querySelector(".aside-kick") ?? view?.querySelector(".aside-head") ?? null;
  // pre=<where the focus was before the click>: main (the chat's transcript), card (the card's), cardbox (the aside's box, as a send leaves it), tab (a tab in the strip),
  // body (nothing); none given, the box's own (the composer takes it on arrival).
  const pre = q.get("pre");
  const preEl =
    pre === "main" ? Array.from(document.querySelectorAll<HTMLElement>(".transcript")).find((t) => !t.closest(".aside-card") && !t.closest(".aside-view") && !t.closest("[inert]"))
    : pre === "card" ? (card?.querySelector<HTMLElement>(".transcript") ?? view?.querySelector<HTMLElement>(".transcript"))
    : pre === "cardbox" ? (card ?? view)?.querySelector<HTMLElement>(".ta-wrap textarea, .ta-wrap .cm-content")
    : pre === "tab" ? document.querySelector<HTMLElement>(".tab-strip .tab")
    : null;
  if (pre === "body") (document.activeElement as HTMLElement | null)?.blur?.();
  else preEl?.focus();
  const before = where(document.activeElement);
  const report = (afterClick: string) =>
    JSON.stringify({
      sc,
      real: q.get("real") === "1",
      classic: q.get("classic") === "1",
      target: target ? where(target) : "MISSING",
      before,
      afterClick,
      afterKey: where(document.activeElement),
      mainBox: boxText(mainBoxRoot),
      asideBox: asideBoxRoot ? boxText(asideBoxRoot) : "n/a",
      composers: document.querySelectorAll(".composer").length,
      pane: !!document.querySelector("section.pane.focused"),
      blockers: Array.from(document.querySelectorAll(TYPE_BLOCKERS)).map(where),
      focusedPane: where(document.querySelector("section.pane.focused")),
      errs: (W.__errs as string[]).slice(0, 3),
    });
  if (q.get("real") === "1") {
    // real=1: snapkeys sends a real AppKit click at __at and a real "h" (WebKit does the focus and the typing).
    let at: [number, number] = [-1, -1];
    if (target && !scrollCase) {
      target.scrollIntoView({ block: "center" });
      await wait(100);
      const r = target.getBoundingClientRect();
      if (sc.endsWith("-border")) at = [r.left + 3, r.top + r.height / 2];
      else if (sc === "main-topbar") at = [r.left + r.width / 2, r.top + r.height / 2];
      else {
        const tn = Array.from(target.childNodes).find((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
        const rr = tn ? (() => { const g = document.createRange(); g.setStart(tn, 0); g.setEnd(tn, Math.min(4, (tn.textContent ?? "").length)); return g.getBoundingClientRect(); })() : r;
        at = [rr.left + rr.width / 2, rr.top + rr.height / 2];
      }
    }
    let afterClick = "";
    W.__afterClick = () => {
      afterClick = where(document.activeElement) + " hit=" + where(document.elementFromPoint(at[0], at[1]));
      wheel();
      finish();
    };
    W.__report = () => report(afterClick);
    W.__at = at;
    W.__ready = true;
    return;
  }
  if (target && !scrollCase) click(target);
  wheel();
  flushSync();
  const afterClick = where(document.activeElement);
  finish();
  await wait(100);
  type("h");
  await wait(50);
  flushSync();
  W.__result = report(afterClick);
  W.__done = true;
}
run().catch((e) => {
  W.__result = JSON.stringify({ sc, fatal: String(e), stack: String((e as Error)?.stack ?? "").slice(0, 400) });
  W.__done = true;
});
