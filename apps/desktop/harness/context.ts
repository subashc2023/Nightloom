// Backlog 242 harness — see context.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import ContextPanel from "../src/lib/ContextPanel.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const cap = document.getElementById("cap")!;
const mode = q.get("mode") ?? "layers";
const query = q.get("q") ?? "";
const steps = Number(q.get("steps") ?? "0");

const filler = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `- ${tag} rule ${i + 1}: keep each change small, commit it by path, and say what it does in plain words.`).join("\n");
const seg = (kind: string, name: string, text: string) => ({
  kind, name, preview: text.slice(0, 80), truncated: false, text,
  size: { bytes: text.length, tokens: Math.round(text.length / 4) }, cache_anchor: false,
});
const memory = `# Standing instructions\n${filler(30, "memory")}\n- The watermark advances only on success.\n${filler(20, "memory")}`;
const project = `# Nightshift\n${filler(40, "project")}\n## The watermark\nstate/watermark.json records progress; the Watermark advances only on success.\n${filler(10, "project")}`;
const notes = `# Notes\n${filler(25, "notes")}`;
const system = [seg("user_memory", "user memory", memory), seg("project_instructions", "AGENTS.md", project), seg("project_notes", "notes", notes)];
const systemText = `<user-instructions>\n## Standing instructions\n${memory}\n</user-instructions>\n\n<project>\n${project}\n</project>\n\n${notes}\n\n${filler(60, "tail")}`;
const cliPrompt = { path: "~/.claude/projects/x/session.jsonl", sections: [`You are Claude Code.\n${filler(50, "cli")}\nNever skip the watermark check.\n${filler(10, "cli")}`] };

(window as unknown as { __stub: (c: string) => Promise<unknown> }).__stub = async (cmd: string) => {
  switch (cmd) {
    case "context_view":
      return { system, system_text: systemText, messages: [], totals: { tokens: Math.round(systemText.length / 4), bytes: systemText.length, unestimated: 0 }, context_limit: 200000 };
    case "cli_prompt_snapshot":
      return cliPrompt;
    case "cli_memory_file":
      return { path: "~/.claude/projects/x/memory/MEMORY.md", text: `# Memory\n${filler(8, "automem")}`, others: [] };
    default:
      throw `stub: ${cmd}`;
  }
};

app.connection = { engine: "claude-code", workspace: "/tmp/w", folders: [] } as unknown as typeof app.connection;
app.agentInit = {
  session_id: "s-1", model: "claude-opus-5-5", version: "2.1.300", permission_mode: "default",
  tools: ["Bash", "Read", "Edit", "Write", "Grep", "WebFetch"], mcp_servers: [{ name: "watermark-mcp", status: "connected" }],
  slash_commands: ["compact", "review", "watermark"], skills: ["watermark-audit", "pdf"], agents: ["reusable"],
} as unknown as typeof app.agentInit;
app.showContext = true;

mount(ContextPanel, { target: document.getElementById("overlay")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

function rect(e: Element | null) {
  if (!e) return "absent";
  const r = e.getBoundingClientRect();
  return `${Math.round(r.top)}–${Math.round(r.bottom)}`;
}

async function run() {
  for (let i = 0; i < 40 && !document.querySelector(".seg button"); i++) await wait(50);
  await wait(100);
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".seg button"));
  const want = { layers: "Layers", sent: "As sent", session: "This session" }[mode] ?? "Layers";
  tabs.find((b) => b.textContent?.trim() === want)?.click();
  const hand = q.get("open");
  if (hand) {
    const sec = document.querySelector(`[data-fold-key="${hand}"]`);
    Array.from(sec?.querySelectorAll("button") ?? []).find((b) => /Read/.test(b.textContent ?? ""))?.click();
  }
  await tick();
  await wait(100);
  key(window, { key: "f", code: "KeyF", metaKey: true });
  await tick();
  await wait(50);
  const field = document.querySelector<HTMLInputElement>(".find-field");
  const lines: string[] = [];
  lines.push(`⌘F: bar ${field ? "open" : "ABSENT"}, focus in field: ${document.activeElement === field}`);
  if (field && query) {
    field.value = query;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    await wait(150);
    for (let i = 0; i < steps; i++) {
      key(field, { key: "Enter", code: "Enter" });
      await wait(60);
    }
    if (q.get("back") === "1") {
      key(field, { key: "Enter", code: "Enter", shiftKey: true });
      await wait(60);
    }
  }
  await wait(150);
  const count = document.querySelector(".find-count")?.textContent;
  const open = Array.from(document.querySelectorAll("[data-fold-key]"))
    .filter((s) => s.querySelector(".reader"))
    .map((s) => s.getAttribute("data-fold-key"));
  lines.push(`mode ${mode} · query "${query}" · steps ${steps}${q.get("back") === "1" ? " then ⇧⏎" : ""} · count "${count}" · unfolded: [${open.join(", ")}]`);
  const hl = (CSS as unknown as { highlights?: Map<string, { size: number } & Iterable<Range>> }).highlights;
  const cur = hl?.get("find-current");
  const all = hl?.get("find-match");
  lines.push(`highlights: current ${cur?.size ?? 0}, others ${all?.size ?? 0}`);
  if (cur && cur.size) {
    const r = [...cur][0].getBoundingClientRect();
    const reader = ([...cur][0].startContainer.parentElement as Element).closest(".reader");
    const pane = document.querySelector(".pane");
    const pr = pane!.getBoundingClientRect();
    const inPane = r.top >= pr.top && r.bottom <= pr.bottom;
    let inReader = true;
    if (reader) {
      const rr = reader.getBoundingClientRect();
      inReader = r.top >= rr.top && r.bottom <= rr.bottom;
    }
    lines.push(`current hit ${Math.round(r.top)}–${Math.round(r.bottom)} · pane ${rect(pane)} · reader ${rect(reader)} · ${inPane && inReader ? "IN VIEW" : "NOT IN VIEW"}`);
  }
  const esc = Number(q.get("esc") ?? "0");
  for (let i = 0; i < esc; i++) {
    key(document.activeElement ?? window, { key: "Escape", code: "Escape" });
    await tick();
    await wait(80);
    const unf = Array.from(document.querySelectorAll("[data-fold-key]")).filter((s) => s.querySelector(".reader")).map((s) => s.getAttribute("data-fold-key"));
    lines.push(`⎋ ${i + 1}: bar ${document.querySelector(".find-bar") ? "open" : "closed"} · page ${app.showContext ? "open" : "closed"} · unfolded: [${unf.join(", ")}]`);
  }
  cap.textContent = lines.join("\n");
}
void run();
