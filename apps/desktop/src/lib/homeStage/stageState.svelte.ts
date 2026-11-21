/**
 * Home's stage (nightshift item 845; the design is 809 round 6): the state the stage keeps for him. One view is in
 * focus; the tab row lists what is live. Every view keeps its own state here (what is open, where he was), saved to
 * the page's storage, so leaving Home and coming back loses nothing (his rule: every view keeps its state).
 *
 * Each control on the stage is one of three kinds (846's contract, §2), named where it is drawn:
 *   A — view-only: the screen changes, no model call;
 *   B — a fact Home reads at its next turn (`homeTasks.ts` `tell`);
 *   C — an answer to a card Home is waiting on.
 */
import type { IconName } from "../icons";

export type ViewId = "watch" | "chat" | "brief" | "run" | "timeline" | "todo" | "triage" | "browse" | "research";

export interface ViewDef {
  id: ViewId;
  name: string;
  icon: IconName;
  /** What Home is doing, as the bar says it. */
  doing: string;
}
export const VIEWS: ViewDef[] = [
  { id: "watch", name: "Watch", icon: "home", doing: "Watching — nothing of its own to do" },
  { id: "chat", name: "Chat", icon: "chat", doing: "Talking with you" },
  { id: "brief", name: "Brief", icon: "note", doing: "Your morning brief" },
  { id: "run", name: "Run", icon: "play", doing: "Running work in your projects" },
  { id: "timeline", name: "Timeline", icon: "updown", doing: "Updating your schedule" },
  { id: "todo", name: "To-do", icon: "checklist", doing: "Working your to-do list" },
  { id: "triage", name: "Triage", icon: "read", doing: "Sorting what arrived" },
  { id: "browse", name: "Browse", icon: "globe", doing: "On a website for you" },
  { id: "research", name: "Research", icon: "grep", doing: "Researching" },
];
export const def = (id: ViewId) => VIEWS.find((v) => v.id === id) ?? VIEWS[0];

export const STAGE_KEY = "nightloom.home.stage";

interface Kept {
  focus: string;
  strip: "open" | "closed";
  /** The message the strip was closed on (its `at`), so a new send opens it again. */
  stripFor: string;
  ui: Record<string, Record<string, unknown>>;
}
const fresh = (): Kept => ({ focus: "watch", strip: "open", stripFor: "", ui: {} });

/** What the page's storage holds, or a fresh stage. Never throws. */
export function readKept(raw: string | null): Kept {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return fresh();
    return {
      focus: typeof v.focus === "string" ? v.focus : "watch",
      strip: v.strip === "closed" ? "closed" : "open",
      stripFor: typeof v.stripFor === "string" ? v.stripFor : "",
      ui: v.ui && typeof v.ui === "object" ? v.ui : {},
    };
  } catch {
    return fresh();
  }
}
function load(): Kept {
  try {
    return readKept(localStorage.getItem(STAGE_KEY));
  } catch {
    return fresh();
  }
}

export const stage = $state(load());

/** Save the stage (called from one effect in Stage.svelte). */
export function keep(): void {
  try {
    localStorage.setItem(STAGE_KEY, JSON.stringify(stage));
  } catch {
    // best-effort
  }
}

/** A view's own state, kept under its tab's id so it survives a switch, a project switch and a restart. */
export function bag<T extends object>(id: string, init: T): T {
  if (!stage.ui[id]) stage.ui[id] = {};
  const b = stage.ui[id];
  for (const k of Object.keys(init) as (keyof T & string)[]) if (!(k in b)) b[k] = init[k];
  return b as T;
}

/** Bring a node that just opened into view inside its own scrolling panel — never by scrolling the page. */
export function revealNow(node: HTMLElement) {
  let p = node.parentElement;
  while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
  if (!p || !p.clientHeight) return;
  const b = p.getBoundingClientRect();
  const row = node.previousElementSibling instanceof HTMLElement && node.previousElementSibling.classList.contains("isopen") ? node.previousElementSibling : null;
  const box = () => {
    const r = node.getBoundingClientRect();
    return { top: row ? Math.min(r.top, row.getBoundingClientRect().top) : r.top, bottom: r.bottom };
  };
  let a = box();
  if (a.bottom > b.bottom - 6) p.scrollTop += a.bottom - b.bottom + 10;
  a = box();
  if (a.top < b.top + 2) p.scrollTop -= b.top - a.top + 6;
}
export function reveal(node: HTMLElement) {
  node = node.parentElement?.closest<HTMLElement>("[data-reveal]") ?? node;
  const a = setTimeout(() => revealNow(node), 0);
  const b = setTimeout(() => revealNow(node), 260);
  return { destroy: () => (clearTimeout(a), clearTimeout(b)) };
}
