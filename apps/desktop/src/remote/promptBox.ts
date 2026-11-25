/**
 * Saved prompts in the phone's boxes (nightshift item 800): the chat's
 * box, an aside's and a job's prompt. A Svelte action on a textarea —
 * `use:promptBox` — so every box gets the same thing:
 *
 * - typing `/word` (at the start, a line's start or after a space) shows
 *   the saved prompts whose names start with it, in a strip just above the
 *   box; a tap puts the prompt in place of the `/word`, with `{clipboard}`,
 *   `{date}` and `{selection}` filled and the first blank selected;
 * - while blanks are left, the strip shows ‹ and **Next blank ›** (a phone
 *   keyboard has no Tab); a hardware keyboard's Tab and ⇧Tab do the same.
 *
 * The prompts come from the host (`GET /api/saved-prompts`), set here by
 * the page when it connects (`setPhonePrompts`). The text is set the way a
 * keystroke would set it — the value, then an `input` event — so the box's
 * own binding, its draft keeping and its autogrow all see it.
 */
import { dateWord, fillAuto, insertAt, matching, nextBlank, slashToken, wantsClipboard } from "../lib/savedPrompts";
import { lastSelection, watchSelection } from "../lib/selectionMemory";
import { applyInsert, insertEdit, insertMatches, insertToken, type BoxInsert } from "../lib/boxInserts";
import { commandMatches, type AppCommand } from "../lib/appCommands";

export interface PhonePrompt {
  name: string;
  body: string;
}

let prompts: PhonePrompt[] = [];

/** The host's saved prompts (an older host's 501 leaves the list empty). */
export function setPhonePrompts(list: PhonePrompt[]): void {
  prompts = list;
}

const STYLE = `
.nl-pb{position:fixed;z-index:60;display:flex;gap:6px;overflow-x:auto;padding:6px;border-radius:12px;
background:var(--sheet,#1c1c1e);border:1px solid var(--line,rgba(127,127,127,.3));box-shadow:0 6px 24px rgba(0,0,0,.25);
-webkit-overflow-scrolling:touch;scrollbar-width:none}
.nl-pb button{flex:none;font:inherit;font-size:14px;padding:7px 11px;border-radius:9px;border:1px solid var(--line2,rgba(127,127,127,.25));
background:var(--well,transparent);color:var(--ink,inherit);white-space:nowrap}
.nl-pb button .n{font-family:var(--mono,ui-monospace,monospace)}
.nl-pb button .k{color:var(--dim,#888);font-size:12px;margin-left:6px}
.nl-pb button.go{background:var(--accent,#0a84ff);color:var(--accent-ink,#fff);border-color:transparent}
`;

function ensureStyle(): void {
  if (document.getElementById("nl-pb-style")) return;
  const s = document.createElement("style");
  s.id = "nl-pb-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

async function clipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard.readText()) || null;
  } catch {
    return null;
  }
}

/** Set the box's text as typing would, then select `[start, end]`. */
function put(node: HTMLTextAreaElement, text: string, start: number, end: number): void {
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.focus();
  node.setSelectionRange(start, end);
}

/** Item 966: the chat's box also lists the app's commands the phone runs
 *  (`appCommands.ts`, surface `phone`); an aside's or a job's box does not. */
export interface PromptBoxOptions {
  commands?: boolean;
}

export function promptBox(node: HTMLTextAreaElement, opts: PromptBoxOptions = {}) {
  ensureStyle();
  watchSelection();
  let bar: HTMLDivElement | null = null;
  /** A prompt went in; its blanks are the strip's until none are left. */
  let live = false;

  function close(): void {
    bar?.remove();
    bar = null;
  }

  /** Just above the box, measured from its top — the coordinates a fixed
   *  element and the box's rectangle share even with the keyboard up. */
  function place(el: HTMLDivElement): void {
    const r = node.getBoundingClientRect();
    el.style.left = `${Math.max(6, r.left)}px`;
    el.style.width = `${Math.max(160, r.width)}px`;
    el.style.maxWidth = `calc(100vw - 12px)`;
    el.style.top = `${Math.max(6, r.top - el.offsetHeight - 6)}px`;
  }

  function button(label: string, hint: string | null, go: boolean, act: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    if (go) b.className = "go";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = label;
    b.appendChild(n);
    if (hint) {
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = hint;
      b.appendChild(k);
    }
    // Keep the box focused (and its keyboard up) through the tap.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", act);
    return b;
  }

  function step(back: boolean): boolean {
    const b = nextBlank(node.value, node.selectionStart, node.selectionEnd, back);
    if (!b) {
      live = false;
      return false;
    }
    node.focus();
    node.setSelectionRange(b.start, b.end);
    return true;
  }

  async function pick(p: PhonePrompt): Promise<void> {
    const token = slashToken(node.value, node.selectionEnd);
    if (!token) return;
    const before = node.value;
    const body = fillAuto(p.body, {
      clipboard: wantsClipboard(p.body) ? await clipboard() : null,
      selection: lastSelection(),
      date: dateWord(),
    });
    if (node.value !== before) return;
    const done = insertAt(node.value, token, body);
    put(node, done.text, done.select.start, done.select.end);
    live = nextBlank(done.text, 0, 0) !== null;
    refresh();
  }

  /** Item 890: the box's inserts (/table, /math, /code, …) under the caret. */
  function inserts(): BoxInsert[] {
    if (node !== document.activeElement || node.selectionStart !== node.selectionEnd) return [];
    return insertMatches(insertToken(node.value, node.selectionEnd));
  }

  function pickInsert(ins: BoxInsert): void {
    const tok = insertToken(node.value, node.selectionEnd);
    if (!tok) return;
    const ed = insertEdit(node.value, tok, ins);
    put(node, applyInsert(node.value, ed), ed.anchor, ed.head);
    refresh();
  }

  /** Item 966: the app's commands while the whole box is a `/word`. */
  function commands(): AppCommand[] {
    if (!opts.commands || node !== document.activeElement) return [];
    return commandMatches(node.value, "phone");
  }

  /** A command picked: `/name ` in the box; Send runs it. */
  function pickCommand(c: AppCommand): void {
    const t = `/${c.name} `;
    put(node, t, t.length, t.length);
    refresh();
  }

  function refresh(): void {
    const token = node === document.activeElement ? slashToken(node.value, node.selectionEnd) : null;
    const found = token ? matching(prompts, token.query, 8) : [];
    const ins = inserts();
    const cmds = commands();
    const blanksLeft = live && nextBlank(node.value, 0, 0) !== null;
    if (!blanksLeft) live = false;
    if (found.length === 0 && ins.length === 0 && cmds.length === 0 && !blanksLeft) {
      close();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "nl-pb";
      bar.setAttribute("role", "listbox");
      bar.setAttribute("aria-label", "Saved prompts");
      document.body.appendChild(bar);
    }
    bar.replaceChildren();
    if (found.length > 0 || ins.length > 0 || cmds.length > 0) {
      for (const p of found) bar.appendChild(button(`/${p.name}`, null, false, () => void pick(p)));
      for (const i of ins) bar.appendChild(button(`/${i.name}`, "insert", false, () => pickInsert(i)));
      for (const c of cmds) bar.appendChild(button(`/${c.name}`, c.args ? `app · ${c.args}` : "app", false, () => pickCommand(c)));
    } else {
      bar.appendChild(button("‹", null, false, () => step(true)));
      bar.appendChild(button("Next blank ›", null, true, () => step(false)));
    }
    place(bar);
  }

  function onkey(e: KeyboardEvent): void {
    if (e.key === "Escape" && bar) {
      e.preventDefault();
      live = false;
      close();
      return;
    }
    if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
    const token = slashToken(node.value, node.selectionEnd);
    const found = token ? matching(prompts, token.query, 8) : [];
    if (found.length > 0 && !e.shiftKey) {
      e.preventDefault();
      void pick(found[0]);
      return;
    }
    const ins = inserts();
    if (ins.length > 0 && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      pickInsert(ins[0]);
      return;
    }
    const cmds = commands();
    if (cmds.length > 0 && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      pickCommand(cmds[0]);
      return;
    }
    if (live && step(e.shiftKey)) e.preventDefault();
  }

  const onInput = () => {
    if (!node.value) live = false;
    refresh();
  };
  const onBlur = () => setTimeout(() => node !== document.activeElement && close(), 150);
  node.addEventListener("input", onInput);
  node.addEventListener("keydown", onkey);
  node.addEventListener("focus", refresh);
  node.addEventListener("blur", onBlur);
  return {
    update(next: PromptBoxOptions = {}) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("input", onInput);
      node.removeEventListener("keydown", onkey);
      node.removeEventListener("focus", refresh);
      node.removeEventListener("blur", onBlur);
      close();
    },
  };
}
