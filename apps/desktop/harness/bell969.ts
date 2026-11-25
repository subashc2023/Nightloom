// Items 968-969 harness — see bell969.html. The real App, the Tauri backend stubbed, fed with synthetic data shaped
// like his on 2026-11-25 (916-911 report): dream commits over 10 days in the vault and 7 projects, dream writes with
// no commit, Claude Code memory changes, 5 pending proposals, one Nightshift project with 19 open blockers (3 held,
// 16 default: applied) and 24 shipped items, an unread morning page, a release. Never his real data.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app, showNightshift } from "../src/lib/state.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { needsNow } from "../src/lib/needsBoard.svelte";
import { waitingCount } from "../src/lib/needsYou";
import { bellList } from "../src/lib/centre";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();

const day = (d: number, h = 3) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(h, 10, 0, 0);
  return t.toISOString();
};
const names = ["nightshift-code", "Nightloom", "AISC", "ics-51", "hopecraft", "spar", "reading"];
const projects = names.map((n, i) => ({ id: `p${i}`, name: n, root: `/Users/you/${n}`, notes_dir: `/Users/you/${n}/.agents/notes`, chats: 3, notes: 3, exists: true }));
const refs = projects.map((p) => ({ id: p.id, name: p.name }));
const commits = [
  ...Array.from({ length: 10 }, (_, i) => ({ project: null, repo: "/Users/you/vault", hash: `v${i}abcdef`, at: day(i), subject: "dream", files: [{ path: `note-${i}.md`, added: 4, removed: 1 }] })),
  ...Array.from({ length: 60 }, (_, i) => ({
    project: refs[i % 7],
    repo: projects[i % 7].root,
    hash: `c${i}abcdef`,
    at: day(Math.floor(i / 6)),
    subject: "dream",
    files: [{ path: `notes/topic-${i}.md`, added: 3, removed: 2 }, ...(i % 10 === 0 ? [{ path: "AGENTS.md", added: 1, removed: 0 }] : [])],
  })),
];
const entry = (id: string, at: string, why: string, applied = false) => ({ id, proposal: { v: 1, at, target: { kind: "user" }, why, text: "…", from_dream: true, ...(applied ? { applied: { at } } : {}) } });
const applied = Array.from({ length: 52 }, (_, i) => ({ project: refs[i % 7], entry: entry(`a${i}`, day(i % 9, 4), "A rule the dream wrote", true), file: "AGENTS.md" }));
const memory = Array.from({ length: 10 }, (_, i) => ({ hash: `m${i}abcdef`, at: day(i, 5), subject: "sync", files: [{ path: "-Users-you/memory/a.md", added: 2, removed: 0 }], places: ["nightshift-code"] }));
const proposals = Array.from({ length: 5 }, (_, i) => ({ project: refs[i], entry: entry(`pr${i}`, day(0, 4), "Three chats asked for the same rule; the instructions would say it up front.") }));
const blockers = Array.from({ length: 19 }, (_, i) => ({
  id: String(2270 + i),
  file: `${2270 + i}-x.md`,
  path: "",
  status: "open",
  raised: "2026-11-24",
  shift: "",
  item: String(960 + i),
  follow_up: null,
  question: i < 3 ? `Held question ${i + 1}: should the roll wait for the review?` : `Defaulted question ${i - 2}: which of two layouts for the panel?`,
  guess: "Build the default and list it in the report.",
  blocks: "",
  answer: "",
  where_guess_lives: "",
  fields: { default: i < 3 ? "held" : "applied" },
  sections: [],
}));
const items = Array.from({ length: 24 }, (_, i) => ({ id: String(930 + i), title: `Shipped item ${i + 1}`, kind: "build", status: "shipped", fields: { shipped: "2026-11-24" } }));
const nsRow = {
  id: "p0",
  name: "nightshift-code",
  workspace: projects[0].root,
  exists: true,
  disabled: null,
  nightshift: { newest_morning: "2026-11-25.md", open_blockers: 19, held_blockers: 3, items: 40, config: { kind: "build" } },
};

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd) => {
  switch (cmd) {
    case "centre_proposals":
      return proposals;
    case "centre_dream_commits":
      return commits;
    case "centre_applied":
      return applied;
    case "centre_claude_memory":
      return memory;
    case "build_stamp":
      return { version: "0.1.0", exe_modified: day(1, 9) };
    case "nightshift_projects":
      return [nsRow];
    case "nightshift_blockers":
      return { blockers, errors: [] };
    case "nightshift_items":
      return { items, errors: [] };
    // Review's own flow (item 968's Review button) and the digest's diffs (969), for the click test.
    case "list_proposals":
      return proposals.map((p) => p.entry);
    case "centre_dream_diff":
    case "centre_applied_diff":
    case "centre_claude_memory_diff":
      return "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,2 +1,3 @@\n line one\n+a rule the dream wrote\n line two\n";
    case "list_projects":
      return projects;
    case "home_feed":
      return { rows: [], seen_at: null };
    case "list_threads":
    case "list_sessions":
    case "list_notes":
    case "providers":
    case "tidy_memory":
    case "tidy_threads":
    case "flat_canary":
      return [];
    default:
      unknown.add(cmd);
      return null;
  }
};

try {
  localStorage.clear();
  // A release seen before, so this one is announced.
  localStorage.setItem("nightloom.centre.build", "older");
} catch {
  // no storage
}
if (q.get("classic") === "1") setLayout("classic");
mount(App, { target: document.getElementById("app")! });
flushSync();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await wait(500);
  app.project = projects[0] as unknown as typeof app.project;
  await tick();
  await wait(600);
  const log: string[] = [];
  if (q.get("t") === "clicks") {
    try {
      await clickTest(log);
    } catch (e) {
      log.push(`THREW ${String(e)}`);
    }
  } else if (q.get("ns") === "1") {
    showNightshift();
    await tick();
    await wait(1200);
    const txt = (el: Element | null | undefined) => JSON.stringify(el?.textContent?.replace(/\s+/g, " ").trim() ?? "none");
    log.push(`ns page: wait button ${txt(document.querySelector(".ns-btn.wait"))}; blockers tab ${txt([...document.querySelectorAll("[role=tab], .tab")].find((b) => b.textContent?.includes("Blockers")))}; eyebrow ${txt(document.querySelector(".eyebrow"))}`);
  } else if (q.get("needs") === "1") {
    app.showNeeds = true;
    await tick();
    await wait(600);
    if (q.get("decided") === "1") {
      [...document.querySelectorAll<HTMLButtonElement>(".group-head")].find((b) => b.textContent?.includes("Decided for you"))?.click();
      await wait(200);
    }
    const heads = [...document.querySelectorAll(".group-head")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
    log.push(`groups: ${heads.join(" | ")}`);
  } else {
    const bell = document.querySelector<HTMLButtonElement>(".centre-bell");
    log.push(`bell: ${!!bell}, dot: ${!!document.querySelector(".centre-bell .centre-dot")}, number: ${JSON.stringify(bell?.textContent?.replace("🔔", "").trim() ?? "")}`);
    bell?.click();
    await wait(500);
    await tick();
    if (q.get("open") === "today") {
      document.querySelector<HTMLButtonElement>(".centre-day-btn")?.click();
      await wait(200);
    }
    if (q.get("seen") === "1") {
      [...document.querySelectorAll<HTMLButtonElement>(".centre-head button")].find((b) => b.textContent?.includes("Mark all seen"))?.click();
      await wait(200);
      log.push(`after Mark all seen, dot: ${!!document.querySelector(".centre-bell .centre-dot")}`);
    }
    const rows = document.querySelectorAll(".centre-panel .centre-day, .centre-panel .centre-kind.alone").length;
    log.push(`panel rows (days + alone): ${rows}; else-line: ${JSON.stringify(document.querySelector(".centre-else")?.textContent?.trim() ?? "")}`);
  }
  const badge = document.querySelector(".need-badge");
  log.push(`needs badge: ${JSON.stringify(badge?.textContent?.replace(/\s+/g, " ").trim() ?? "none")}; waiting=${waitingCount(needsNow())}`);
  log.push(`notices=${app.centre.notices.length}; bellList rows=${(() => { const b = bellList(app.centre.notices, app.centre.seen, new Date()); return b.days.length + b.alone.length; })()}`);
  log.push(`stub unknown: ${[...unknown].slice(0, 8).join(", ")}`);
  cap.textContent = (q.get("t") === "clicks" ? "" : cap.textContent) + log.join("\n");
}
/** The click test (review of 968-969, 2026-11-25): every control the build added or moved, clicked in order, each
 *  line PASS or FAIL with what was seen. */
async function clickTest(log: string[]): Promise<void> {
  // Each line goes on the caption at once too, so a shot taken mid-run shows how far it got.
  const ok = (name: string, pass: boolean, seen = "") => {
    const line = `${pass ? "PASS" : "FAIL"} ${name}${seen ? ` — ${seen}` : ""}`;
    log.push(line);
    (window as unknown as { __progress?: string[] }).__progress = log;
    cap.textContent = log.join("\n");
  };
  const one = (sel: string) => document.querySelector<HTMLElement>(sel);
  const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const byText = (sel: string, t: string) => all(sel).find((b) => (b.textContent ?? "").includes(t));
  // bin/snap's hidden window throttles timers to about one a second: yield by MessageChannel (never throttled),
  // enough turns for the stubbed backend's promises and Svelte's flush.
  const turn = () => new Promise<void>((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
  const settle = async (ms = 250) => {
    for (let i = 0; i < Math.max(8, ms / 10); i++) {
      await tick();
      await turn();
    }
  };
  cap.style.cssText += ";top:0;bottom:auto;font-size:13px;line-height:1.35";
  // 1. The bell: a dot, no number; opening it keeps the dot (default B).
  const bell = one(".centre-bell");
  ok("bell has a dot and no number", !!one(".centre-bell .centre-dot") && (bell?.textContent ?? "").replace("🔔", "").trim() === "");
  bell?.click();
  await settle(500);
  ok("bell opens the panel", !!one(".centre-panel"));
  ok("opening keeps the dot", !!one(".centre-bell .centre-dot"));
  const days0 = all(".centre-day").length;
  const alone0 = all(".centre-kind.alone").length;
  ok("panel lists <= 10 rows", days0 + alone0 <= 10, `${days0} days + ${alone0} alone`);
  // 2. Day toggle: open Today, its rows show and its dot goes.
  const today = all(".centre-day-btn")[0];
  today?.click();
  await settle();
  const todayRows = all(".centre-day-rows .centre-item").length;
  ok("day toggle opens the day", today?.getAttribute("aria-expanded") === "true" && todayRows > 0, `${todayRows} rows`);
  ok("opening a day clears its dot", !all(".centre-day")[0]?.querySelector(".centre-dot"));
  // 3. Inside the day: Show the diff, then Revert and Open in editor reachable.
  // A dream's row (Claude Code's memory rows have no Revert by design: Nightloom never writes those files).
  const dreamRow = all(".centre-day-rows .centre-item").find((r) => r.textContent?.includes("A dream changed"));
  const showBtn = [...(dreamRow?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) => b.textContent?.includes("Show the diff"));
  showBtn?.click();
  await settle(400);
  ok("Show the diff opens a diff", !!one(".centre-diff"), showBtn ? "" : "no Show the diff button");
  ok("Revert reachable in an opened day", !!byText(".centre-files button", "Revert"));
  let editor = byText(".centre-files button", "Open in editor");
  if (!editor) {
    for (const btn of all(".centre-day-btn")) {
      if (btn.getAttribute("aria-expanded") !== "true") btn.click();
      await settle(150);
      for (const sb of all(".centre-day-rows button").filter((b) => b.textContent?.includes("Show the diff"))) {
        sb.click();
        await settle(150);
        editor = byText(".centre-files button", "Open in editor");
        if (editor) break;
      }
      if (editor) break;
    }
  }
  ok("Open in editor reachable for an instructions change", !!editor);
  // Revert asks first (the app's dialog); Cancel leaves the row.
  byText(".centre-files button", "Revert")?.click();
  await settle();
  const cancel = byText(".centre-panel button, [role=dialog] button", "Cancel");
  ok("Revert asks for confirmation", !!cancel);
  cancel?.click();
  await settle();
  for (const btn of all(".centre-day-btn")) if (btn.getAttribute("aria-expanded") === "true") btn.click();
  await settle();
  ok("day toggle closes the day", all(".centre-day-rows").length === 0);
  // 4. Done on a row (inside a day), then Done on a whole day.
  all(".centre-day-btn")[1]?.click();
  await settle();
  const before = all(".centre-day-rows .centre-item").length;
  byText(".centre-day-rows .centre-actions button", "Done")?.click();
  await settle();
  const after = all(".centre-day-rows .centre-item").length;
  ok("Done on a row takes it off", after === before - 1, `${before} -> ${after}`);
  const daysBefore = all(".centre-day").length;
  const lastHead = all(".centre-day-head").at(-1);
  [...(lastHead?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === "Done")?.click();
  await settle();
  ok("Done on a day takes the day off", all(".centre-day").length === daysBefore - 1, `${daysBefore} -> ${all(".centre-day").length}`);
  // 5. Mark all seen: the dot goes, the button goes, the rows stay.
  const rowsBefore = all(".centre-day").length;
  byText(".centre-head button", "Mark all seen")?.click();
  await settle();
  ok("Mark all seen clears the dot", !one(".centre-bell .centre-dot"));
  ok("Mark all seen keeps the rows", all(".centre-day").length === rowsBefore, `${rowsBefore} -> ${all(".centre-day").length}`);
  ok("Mark all seen hides itself", !byText(".centre-head button", "Mark all seen"));
  // 6. The foot line opens Needs you.
  const foot = one(".centre-else");
  ok("foot line counts what asks him", !!foot, JSON.stringify(foot?.textContent?.replace(/\s+/g, " ").trim() ?? ""));
  foot?.click();
  await settle(900);
  ok("foot line opens Needs you, closes the bell", app.showNeeds && !app.centre.open && !!one(".group-head"));
  // 7. Needs you: the Decided fold opens and closes; its rows keep their reply box.
  log.push(`groups: ${all(".group-head").map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ")}`);
  const dec = () => byText(".group-head", "Decided for you");
  ok("Decided starts folded", dec()?.getAttribute("aria-expanded") === "false");
  dec()?.click();
  await settle();
  const decRows = document.querySelectorAll('.group[data-state="decided"] .row').length;
  const decBoxes = document.querySelectorAll('.group[data-state="decided"] textarea').length;
  ok("Decided opens", dec()?.getAttribute("aria-expanded") === "true" && decRows > 0, `${decRows} rows, ${decBoxes} reply boxes`);
  dec()?.click();
  await settle();
  ok("Decided folds again", dec()?.getAttribute("aria-expanded") === "false" && document.querySelectorAll('.group[data-state="decided"] .row').length === 0);
  // 8. Review on a proposal row: the view closes and the proposal review opens on its project.
  const reviews = all('.group[data-state="waiting"] button').filter((b) => b.textContent?.trim() === "Review");
  ok("proposal rows carry Review", reviews.length > 0, `${reviews.length} Review buttons`);
  reviews[0]?.click();
  await settle(1200);
  ok("Review opens the proposal review", !app.showNeeds && !!app.proposalReview, `proposalReview=${app.proposalReview ? app.proposalReview.entry.id : "null"} project=${app.project?.id ?? "none"}`);
}

void run();
