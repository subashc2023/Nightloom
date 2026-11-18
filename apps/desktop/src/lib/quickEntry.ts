// Item 795 (793 report §4 row 2): Quick Entry's pure half — the shortcut's
// recorder form, the targets the box offers, and what the box and the main
// window share through localStorage (both are pages of the same bundle, so
// one store). The main window writes the targets (`quickEntry.svelte.ts`);
// the box writes the draft and the last target (`quick/QuickEntry.svelte`).

/** Where an entry goes: the chat he last used, a new chat in a project, or
 *  an aside on the last chat. */
export type QuickTarget = "last" | "new" | "aside";

export const TARGETS: readonly QuickTarget[] = ["last", "new", "aside"];

/** What the main window last showed: the box reads it each time it opens. */
export interface QuickContext {
  chat: { id: string; title: string } | null;
  project: { id: string; name: string } | null;
  projects: { id: string; name: string }[];
}

/** The box's send to the main window (`quick-entry-send`). */
export interface QuickSend {
  target: QuickTarget;
  text: string;
  /** "new": the project picked; "last" / "aside": the chat's project. */
  project: string | null;
  /** "last" / "aside": the chat the box named, so a send never lands in a
   *  chat he switched to after the box opened. */
  chat: string | null;
}

export const KEYS = {
  shortcut: "nightloom.quickEntry.shortcut",
  context: "nightloom.quickEntry.context",
  draft: "nightloom.quickEntry.draft",
  target: "nightloom.quickEntry.target",
  project: "nightloom.quickEntry.project",
} as const;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MODS = new Set(["Meta", "Control", "Alt", "Shift", "OS"]);

/**
 * A keydown in the recorder → the shortcut's form ("Ctrl+Alt+Space"), or
 * null while only modifiers are held or none of ⌘ ⌃ ⌥ is (Shift alone would
 * eat a capital in every app). By `code`, the physical key, as the Mac's
 * hot key is (`quick_entry.rs` parses the same form).
 */
export function recordShortcut(e: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (MODS.has(e.key)) return null;
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Period|Comma|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Cmd");
  parts.push(e.code);
  return parts.join("+");
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** "Ctrl+Alt+Space" → "⌃⌥Space", the Mac's order (⌃⌥⇧⌘). */
export function shortcutLabel(s: string | null): string {
  if (!s) return "Off";
  const parts = s.split("+");
  const has = (m: string) => parts.includes(m);
  const key = parts.find((p) => !["Ctrl", "Alt", "Shift", "Cmd"].includes(p)) ?? "";
  const name = key.startsWith("Key") ? key.slice(3) : key.startsWith("Digit") ? key.slice(5) : (KEY_NAMES[key] ?? key);
  return `${has("Ctrl") ? "⌃" : ""}${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${has("Cmd") ? "⌘" : ""}${name}`;
}

export function loadShortcut(s: Store): string | null {
  try {
    return s.getItem(KEYS.shortcut) || null;
  } catch {
    return null;
  }
}

export function saveShortcut(s: Store, v: string | null): void {
  try {
    if (v) s.setItem(KEYS.shortcut, v);
    else s.removeItem(KEYS.shortcut);
  } catch {
    // No storage: the pick lasts this launch.
  }
}

export function readContext(s: Store): QuickContext {
  const empty: QuickContext = { chat: null, project: null, projects: [] };
  try {
    const v = JSON.parse(s.getItem(KEYS.context) ?? "null") as Partial<QuickContext> | null;
    if (!v || typeof v !== "object") return empty;
    const pair = (x: unknown, a: "title" | "name") =>
      x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string" && typeof (x as Record<string, unknown>)[a] === "string" ? x : null;
    return {
      chat: pair(v.chat, "title") as QuickContext["chat"],
      project: pair(v.project, "name") as QuickContext["project"],
      projects: Array.isArray(v.projects) ? (v.projects.filter((p) => pair(p, "name")) as QuickContext["projects"]) : [],
    };
  } catch {
    return empty;
  }
}

export function writeContext(s: Store, c: QuickContext): void {
  try {
    s.setItem(KEYS.context, JSON.stringify(c));
  } catch {
    // No storage: the box offers a new chat only.
  }
}

/** The target the box opens on: the last one used, if it can still run
 *  (no chat on record → a new chat). */
export function openingTarget(s: Store, c: QuickContext): QuickTarget {
  let t: string | null = null;
  try {
    t = s.getItem(KEYS.target);
  } catch {
    t = null;
  }
  const want = (TARGETS as readonly string[]).includes(t ?? "") ? (t as QuickTarget) : "last";
  return want !== "new" && !c.chat ? "new" : want;
}

/** The project a new chat goes in: the one picked last, while it exists;
 *  else the project on screen; else the first. */
export function openingProject(s: Store, c: QuickContext): string | null {
  let p: string | null = null;
  try {
    p = s.getItem(KEYS.project);
  } catch {
    p = null;
  }
  if (p && c.projects.some((x) => x.id === p)) return p;
  return c.project?.id ?? c.projects[0]?.id ?? null;
}

export function remember(s: Store, target: QuickTarget, project: string | null): void {
  try {
    s.setItem(KEYS.target, target);
    if (project) s.setItem(KEYS.project, project);
  } catch {
    // No storage: the default target next time.
  }
}

export function loadDraft(s: Store): string {
  try {
    return s.getItem(KEYS.draft) ?? "";
  } catch {
    return "";
  }
}

/** Kept on every keystroke, so a dismiss, a quit or a crash loses nothing;
 *  only a send that left (or an empty box) clears it. */
export function saveDraft(s: Store, text: string): void {
  try {
    if (text) s.setItem(KEYS.draft, text);
    else s.removeItem(KEYS.draft);
  } catch {
    // No storage: the draft lives while the box's page does.
  }
}

/** A refused send's words go back into the box: after anything typed since,
 *  never over it. */
export function restoreDraft(s: Store, text: string): void {
  const now = loadDraft(s);
  saveDraft(s, now.trim() ? `${now}\n\n${text}` : text);
}

/** The send, or why not (nothing typed; no chat for "last" / "aside"; no
 *  project for "new" is allowed — a chat outside any project). */
export function sendOf(target: QuickTarget, text: string, c: QuickContext, project: string | null): QuickSend | string {
  const t = text.trim();
  if (!t) return "type something first";
  if (target === "new") return { target, text: t, project, chat: null };
  if (!c.chat) return "no chat is on record yet — pick New chat";
  return { target, text: t, project: c.project?.id ?? null, chat: c.chat.id };
}

/** The target's name in the box. */
export function targetName(t: QuickTarget, c: QuickContext): string {
  if (t === "new") return "New chat";
  const title = c.chat?.title?.trim() || "the last chat";
  return t === "last" ? `To: ${title}` : `Aside on: ${title}`;
}
