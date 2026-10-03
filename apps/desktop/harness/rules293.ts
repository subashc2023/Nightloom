// Backlog 291 + 293 harness — see rules293.html. Fixtures only.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import ProviderRail from "../src/lib/ProviderRail.svelte";
import ContextPanel from "../src/lib/ContextPanel.svelte";
import { app, subagentRules } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const cap = document.getElementById("cap")!;
const v = q.get("v") ?? "rail";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORDS = "At most two subagents at once. Only for broad searches or long research; do bounded tasks yourself. Ask me before a third.";
// The layer as Rust renders it (prompt::subagent_rules_segment), default limits, fork mode on.
const layer = (words: string) =>
  `<subagent-rules>\nThe user's subagent rules for this chat, in their words. Follow them:\n${words}\n\nLimits Nightloom enforces whatever you do (a launch past one is refused, and the refusal says which):\n- At most 6 subagent launches per message.\n- At most 4 running at once.\n- Nesting at most 3 deep (a subagent's own subagents count).\n- No daily cap.\n- From 70% of the five-hour usage window, at most 4 launches per message.\n- At 85% of the five-hour window every launch is refused until it resets.\n- One message (you, every subagent and council seat) may spend 35% of the five-hour window; past it every tool call is refused: stop and report.\n- Subagents' model: yours to choose on each launch.\n\nHelper kinds (subagent_type), what each starts with, and why to pick it:\n- checkpoint: it starts with this chat's instructions and opening exchange only, none of the later turns, so a research helper's priors stay independent of the discussion since. Pick it for long research or a many-step side task.\n- fork: it starts with the whole conversation so far, for a short task that builds on points made recently.\n- general-purpose: it starts with nothing of this chat but the brief you write, for a task that needs no context of it.\n</subagent-rules>`;
const seg = (kind: string, name: string, text: string) => ({
  kind, name, preview: text.slice(0, 80), truncated: false, text,
  size: { bytes: text.length, tokens: Math.round(text.length / 4) }, cache_anchor: false,
});
const held = layer("Use subagents freely.");
const newer = layer(WORDS);

(window as unknown as { __stub: (c: string) => Promise<unknown> }).__stub = async (cmd: string) => {
  switch (cmd) {
    case "context_view": {
      const system = [seg("subagents", "subagents", "<subagents>\nHow to use subagents here…\n</subagents>"), seg("subagent_rules", "subagent-rules", q.get("warm") === "1" ? held : newer)];
      const text = system.map((s) => s.text).join("\n\n");
      return { system, system_text: text, messages: [], totals: { tokens: Math.round(text.length / 4), bytes: text.length, unestimated: 0 }, context_limit: 200000 };
    }
    case "connect_agent":
      // The page's look-only reconnect (refreshLayerVersions): left
      // pending, so the fixture connection and marks stay as set.
      return new Promise(() => {});
    default:
      // As the context harness: an unstubbed command fails, the panel copes.
      if (v === "context") throw `stub: ${cmd}`;
      return null;
  }
};

app.connection = { engine: "claude-code", workspace: "/tmp/w", folders: [], model: "opus" } as unknown as typeof app.connection;
app.draft.engine = "claude-code";
app.draft.agentModel = "opus";
app.draft.tools = true;
app.activeSessionId = "chat-a";

async function rail() {
  const root = document.getElementById("root")!;
  subagentRules.store.default = "Ask before launching more than one subagent.";
  mount(ProviderRail, { target: root });
  flushSync();
  await wait(150);
  const lines: string[] = [];
  const box = document.querySelector<HTMLTextAreaElement>(".rules-box");
  lines.push(`rules box: ${box ? `shows "${box.value.slice(0, 40)}…"` : "ABSENT"} · foot: "${document.querySelector(".rules-foot")?.textContent?.trim().replace(/\s+/g, " ")}"`);
  if (q.get("type") === "1" && box) {
    box.value = WORDS;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    lines.push(`typed → store chat-a: "${subagentRules.store.chats["chat-a"]?.slice(0, 30)}…" · foot: "${document.querySelector(".rules-foot")?.textContent?.trim().replace(/\s+/g, " ")}"`);
  }
  const det = document.querySelector<HTMLDetailsElement>("details.exact");
  lines.push(`Exact limits: ${det ? (det.open ? "open" : "folded") : "ABSENT"} · summary "${det?.querySelector(".exact-sum")?.textContent}" · grid inputs visible ${document.querySelectorAll(".limits-grid input[type=number]").length && det?.open ? "yes" : "no"}`);
  if (q.get("open") === "1" && det) {
    det.querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
    await wait(100);
    const nums = Array.from(document.querySelectorAll<HTMLInputElement>(".limits-grid input[type=number]")).map((i) => i.value);
    lines.push(`clicked "Exact limits" → ${det.open ? "open" : "folded"} · numbers kept: ${nums.join(",")}`);
  }
  document.querySelector(".rules")?.scrollIntoView({ block: "start" });
  window.scrollBy(0, -40);
  cap.textContent = lines.join("\n");
}

async function context() {
  app.promptPending =
    q.get("warm") === "1"
      ? { session: "chat-a", layers: [{ kind: "subagent_rules", held, newer, choice: "auto" }], rules_note: "…" }
      : { session: "chat-a", layers: [] };
  // A warm cache: a turn a minute ago.
  app.events = (q.get("warm") === "1"
    ? [{ event: "assistant_message", sent_at: new Date(Date.now() - 60_000).toISOString(), cache_ttl: "1h", content: [] }]
    : []) as unknown as typeof app.events;
  app.showContext = true;
  const overlay = document.createElement("div");
  overlay.id = "overlay";
  document.body.appendChild(overlay);
  mount(ContextPanel, { target: overlay });
  flushSync();
  for (let i = 0; i < 40 && !document.querySelector('[data-fold-key="subagent_rules"]'); i++) await wait(50);
  await wait(100);
  const card = document.querySelector('[data-fold-key="subagent_rules"]');
  Array.from(card?.querySelectorAll("button") ?? []).find((b) => /Read/.test(b.textContent ?? ""))?.click();
  await tick();
  await wait(100);
  card?.scrollIntoView({ block: "start" });
  cap.textContent = `Subagent rules card: ${card ? "present" : "ABSENT"} · mark: "${card?.querySelector(".mark .say")?.textContent ?? "none"}" · mark buttons: [${Array.from(card?.querySelectorAll(".mark button") ?? []).map((b) => b.textContent?.trim()).join(", ")}]`;
}

void (v === "context" ? context() : rail());
