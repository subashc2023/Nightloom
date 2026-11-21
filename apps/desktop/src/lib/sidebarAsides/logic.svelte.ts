// Item 856 (2026-11-19): the behaviour of SidebarAsides, once. `SidebarAsides.svelte` (Jarvis) and
// `SidebarAsidesClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from SidebarAsides.svelte's script.
/**
* A chat's open asides, listed under its sidebar row when its asides
* toggle is open (item 265; the design is in `asideSidebar.svelte.ts`).
* Indented like its forks, but each row carries the asides glyph and
* "aside" on its second line, and the rule at its left is dotted where
* a fork's is solid. A click shows the thread in a tab (the one already
* showing it, else a new one beside); a double-click or the ··· menu's
* Rename names it; the menu's Close moves it to the chat's Past list, as
* the card's × does (text in its box asks first).
*/
import { app, asideAsking, asideInTab, type Aside } from "../state.svelte";
import * as tabs from "../tabs";
import { asidesListedOf } from "../asideSidebar.svelte";

export type SidebarAsidesLogicProps = { session: string; depth?: number };



export function sidebarAsidesLogic(props: () => SidebarAsidesLogicProps) {
  const session = $derived(props().session);
  const depth = $derived(props().depth ?? 0);
  const list = $derived(asidesListedOf(session));
  const front = $derived(tabs.activeTab(tabs.focusedPane(app.tabs)).content);
  let naming = $state<number | null>(null);
  let menu = $state<{ a: Aside; x: number; y: number; up: boolean } | null>(null);

  function statusOf(a: Aside): string {
    if (asideAsking(a)) return "asking…";
    if (a.draft) return "not asked yet";
    const n = a.turns.length;
    const s = `${n} ${n === 1 ? "exchange" : "exchanges"}`;
    return asideInTab(session, a.id) ? `${s} · in a tab` : s;
  }
  function isFront(a: Aside): boolean {
    return front.kind === "aside" && front.session === session && front.thread === a.id;
  }
  function openMenu(e: MouseEvent, a: Aside, fromButton: boolean) {
    e.preventDefault();
    e.stopPropagation();
    if (fromButton) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const up = r.bottom + 120 > window.innerHeight;
      menu = { a, x: r.left, y: up ? window.innerHeight - r.top + 4 : r.bottom + 4, up };
    } else {
      menu = { a, x: e.clientX, y: e.clientY, up: false };
    }
  }
  function pick(fn: (a: Aside) => void) {
    const a = menu?.a;
    menu = null;
    if (a) fn(a);
  }

  return {
    get depth() {
      return depth;
    },
    isFront,
    get list() {
      return list;
    },
    get menu() {
      return menu;
    },
    set menu(v) {
      menu = v;
    },
    get naming() {
      return naming;
    },
    set naming(v) {
      naming = v;
    },
    openMenu,
    pick,
    get session() {
      return session;
    },
    statusOf,
  };
}
