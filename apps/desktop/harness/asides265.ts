// Items 265, 266 harness — see asides265.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import AsideView from "../src/lib/AsideView.svelte";
import { app, asideStash } from "../src/lib/state.svelte";
import type { Aside } from "../src/lib/state.svelte";
import { asidesShown } from "../src/lib/asideSidebar.svelte";
import { pastAsides } from "../src/lib/asideHistory.svelte";
import { storedAsideOf } from "../src/lib/asides";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "sidebar";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const when = new Date(Date.now() - 600_000).toISOString();
const row = (id: string, title: string, parent?: string) => ({
  id,
  title,
  mode: "normal",
  kind: "chat",
  modified: when,
  ...(parent ? { forked_from: { session: parent } } : {}),
});
app.sessions = [
  row("5d068f2a-stuart9", "Stuart 9 (Toy Model Review)"),
  row("1b3e9483-fork", "Alright so we're trying to create a…", "5d068f2a-stuart9"),
  row("7c2d1e00-fork2", "Edit: the cache question", "5d068f2a-stuart9"),
  row("9e8f7a6b-other", "Another chat, asides closed"),
  row("3a4b5c6d-plain", "Plain chat, no asides"),
] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code" } as unknown as typeof app.connection;

let seq = 0;
const thread = (id: number, question: string, name?: string, quote = "The watermark advances only on success."): Aside => ({
  id,
  quote: { text: quote, role: "assistant", ordinal: 2 },
  draft: false,
  turns: [
    { seq: ++seq, question, partial: "Because a skipped unit is lost.", answer: "Because a skipped unit is lost.", error: null, cancelled: false, cacheRead: 0 },
    { seq: ++seq, question: "and then?", partial: "It is redone.", answer: "It is redone.", error: null, cancelled: false, cacheRead: 0 },
  ],
  anchor: null,
  ...(name ? { name } : {}),
});

app.activeSessionId = "5d068f2a-stuart9";
app.asides = [
  thread(1, "Why does the watermark advance only on success?", "Watermark rule"),
  thread(2, "What does the cache hold between passes?"),
];
asideStash.set("9e8f7a6b-other", [thread(3, "Is this the same as a checkpoint?")]);
const past = thread(9, "What did the old runner do here?", "Old runner");
pastAsides.byChat["5d068f2a-stuart9"] = [{ key: "k1", closedAt: Date.now() - 3_600_000, thread: storedAsideOf(past)! }];

if (view === "sidebar") {
  app.tabs = {
    panes: [
      {
        id: "p1",
        tabs: [
          { id: "t1", content: { kind: "chat", session: "5d068f2a-stuart9" } },
          { id: "t2", content: { kind: "aside", session: "5d068f2a-stuart9", thread: 2 } },
        ],
        active: "t2",
      },
    ],
    focused: "p1",
  } as unknown as typeof app.tabs;
  asidesShown.open = new Set(["5d068f2a-stuart9"]);
  try {
    localStorage.setItem("nightloom.forksOpen", JSON.stringify(["5d068f2a-stuart9"]));
  } catch {
    /* harness */
  }
  root.style.setProperty("--w", "300px");
  root.style.setProperty("--h", "620px");
  mount(Sidebar, { target: root });
} else {
  app.tabs = {
    panes: [{ id: "p1", tabs: [{ id: "t1", content: { kind: "aside", session: "5d068f2a-stuart9", thread: 1 } }], active: "t1" }],
    focused: "p1",
  } as unknown as typeof app.tabs;
  mount(AsideView, { target: root, props: { session: "5d068f2a-stuart9", thread: 1 } });
}
flushSync();

setTimeout(() => {
  if (view === "sidebar" && q.get("menu") === "1") {
    const more = document.querySelector<HTMLElement>(".session-item .more-btn");
    more?.click();
    flushSync();
  }
  setTimeout(() => {
    const lines: string[] = [];
    if (view === "sidebar") {
      for (const e of document.querySelectorAll(".session-item .snippet, .aside-item .snippet"))
        lines.push(`${e.closest(".aside-item") ? "  aside" : "row  "} ${e.textContent!.trim()}`);
      lines.push(`toggles: ${[...document.querySelectorAll(".forks-btn")].map((b) => b.getAttribute("aria-label")).join(" | ")}`);
      const menu = document.querySelector(".row-menu");
      if (menu) lines.push(`menu: ${[...menu.querySelectorAll("button, .sec")].map((b) => b.textContent!.replace(/\s+/g, " ").trim()).join(" | ")}`);
    } else {
      lines.push(`title: ${document.querySelector(".aside-view-name")?.textContent?.trim()}`);
      lines.push(`close: ${document.querySelector(".aside-view-close")?.textContent?.trim()}`);
    }
    cap.textContent = lines.join("\n");
  }, 150);
}, 300);
