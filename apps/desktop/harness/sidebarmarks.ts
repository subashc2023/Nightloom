// Backlog 239 harness — see sidebarmarks.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import { app } from "../src/lib/state.svelte";
import { drafts } from "../src/lib/drafts.svelte";

const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const when = new Date(Date.now() - 600_000).toISOString();
const row = (id: string, title: string, mode: string) => ({ id, title, mode, kind: "chat", modified: when });
app.sessions = [
  row("5d068f2a-plain", "Plain chat, no marks", "normal"),
  row("162d1d00-draft", "Draft only (and open in a tab)", "normal"),
  row("7a1b2c3d-incog", "Incognito only", "incognito"),
  row("9e8f7a6b-both", "Incognito with a draft", "incognito"),
] as unknown as typeof app.sessions;
app.activeSessionId = "5d068f2a-plain";
app.tabs = {
  panes: [
    {
      id: "p1",
      tabs: [
        { id: "t1", content: { kind: "chat", session: "5d068f2a-plain" } },
        { id: "t2", content: { kind: "chat", session: "162d1d00-draft" } },
      ],
      active: "t1",
    },
  ],
  focused: "p1",
} as unknown as typeof app.tabs;
drafts["162d1d00-draft"] = { text: "words waiting", attachments: [], queue: [] };
drafts["9e8f7a6b-both"] = { text: "more words", attachments: [], queue: [] };

// The "before" shot (morning-shots-2026-09-26/239/rows-before.png) came from a temporary copy of the pre-239
// Sidebar mounted here instead; it is not kept.
mount(Sidebar, { target: root });
flushSync();
setTimeout(() => {
  const lines = [...document.querySelectorAll(".session-row .snippet")].map((e) => {
    const marks = [...e.querySelectorAll(".mark")].map((m) => (m.classList.contains("draft") ? "dot" : m.textContent));
    return `${e.textContent!.trim()} | marks: ${marks.join(",") || "none"}`;
  });
  lines.push(`▭ present: ${document.body.innerHTML.includes("▭")}`);
  cap.textContent = lines.join("\n");
}, 300);
