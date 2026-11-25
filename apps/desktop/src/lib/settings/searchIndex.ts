// Search in Settings (nightshift item 844, 2026-11-18). His words: "add
// backlog for like search functionality in settings". A box at the top of
// the nav finds any setting by its label, its help text and its section,
// across every pane; picking one opens its pane, scrolls to it and
// highlights it.
//
// This module is the inventory and the matching, pure so the tests hold
// them. Each entry is a card of a pane (its title is `section`), or one
// control inside a card (`label`). Subscription's controls come from its
// own inventory (`subscriptionPane.ts`, item 546) so the two never drift;
// the providers and web-search backends are added from what the app has.
// `searchIndex.test.ts` checks every card title SettingsModal renders is
// here, so a new card cannot go unsearchable.

import { CONTROLS, GROUPS } from "./subscriptionPane";
import { USAGE_PANE, COST_PANE } from "../settingsUsage";

export interface SettingEntry {
  /** The pane id SettingsModal selects. */
  pane: string;
  /** The card's title as rendered (`.card .ch .t`), or Subscription's group title. */
  section: string;
  /** A control inside the card; absent for the card itself. */
  label?: string;
  /** The card's explanation, matched but not shown in full. */
  help?: string;
  /** Extra words he might type looking for it. */
  terms?: string;
  /** Subscription's fold keys: the group to open, the row to find. */
  fold?: { group: string; row: string };
}

/** Pane titles, as the nav and the pane head say them. Providers and backends come from the app. */
export const PANE_TITLES: Record<string, string> = {
  [USAGE_PANE]: "Usage",
  [COST_PANE]: "Cost",
  "claude-code": "Subscription",
  council: "Council",
  knowledge: "Knowledge base",
  models: "Model instructions",
  "saved-prompts": "Saved prompts",
  home: "Home",
  projects: "Projects folder",
  appearance: "Palette",
  animations: "Animations",
  remote: "Phone",
  away: "Away server",
  outside: "Outside control",
  "quick-entry": "Quick Entry",
  notifications: "Notifications",
  sleep: "Sleep",
};

/** The panes themselves, so a pane's own name finds it (the palette picker sits above any card). */
const PANES: SettingEntry[] = [
  { pane: "appearance", section: "Palette", terms: "palette theme colours colors dark jarvis classic look" },
  { pane: "animations", section: "Animations", terms: "motion animation reduce motion" },
  { pane: "remote", section: "Phone", terms: "phone iphone remote mobile" },
  { pane: "away", section: "Away server", terms: "away server lid closed vps" },
  { pane: USAGE_PANE, section: "Usage", terms: "usage plan limit refresh now" },
  { pane: COST_PANE, section: "Cost", terms: "cost spend dollars price money" },
  { pane: "claude-code", section: "Subscription", terms: "subscription claude code engine max plan" },
  { pane: "knowledge", section: "Knowledge base", terms: "knowledge memory vault" },
  { pane: "models", section: "Model instructions", terms: "model instructions system prompt" },
  { pane: "saved-prompts", section: "Saved prompts", terms: "saved prompts slash" },
  { pane: "home", section: "Home", terms: "home morning brief" },
  { pane: "projects", section: "Projects folder", terms: "projects folder" },
];

/** Every card and control of the fixed panes. */
export const CARDS: SettingEntry[] = [
  { pane: "appearance", section: "Layout", help: "Classic puts every screen back the way it was before Jarvis — the chat, the composer, the sidebar, the tabs, the top bar, the terminal strip — with its four palettes (A is charcoal & amber again). Applies at once and is remembered; switch back any time." },
  { pane: "appearance", section: "Zoom", help: "Your default zoom: ⌘0 returns here, and the top bar's zoom chip shows only when the app is zoomed to something else.", terms: "zoom default size scale bigger smaller actual size" },
  { pane: "appearance", section: "Accent", help: "The colour of what you press — buttons, Send, the selected row, the brackets. It does not change the motion colour (below)." },
  { pane: "appearance", section: "Instrument light", terms: "glow light lamp" },
  { pane: "appearance", section: "New-chat page", terms: "new chat start page empty wheel" },
  { pane: "appearance", section: "Motion colour", help: "The colour of what moves: the send thread, the rewind's strike, the notes card's shuttle, the running step in the trace. Each option is the current palette's own colour." },
  { pane: "appearance", section: "Composer row", terms: "composer box input row controls" },
  { pane: "appearance", section: "Cache on the box", terms: "cache warm cold timer composer" },
  { pane: "appearance", section: "Question cards", terms: "question ask card answers rows buttons send claude asks needs you" },
  { pane: "appearance", section: "Transcript type", help: "The face and size of replies and your own messages, and which tool calls a reply lists (Show all, Hide successful, Hide all). Applies at once to the transcript behind this window and is remembered. The rest of the interface stays in Plex Sans." },
  { pane: "appearance", section: "Links", help: "Where a link in a reply, a note or an aside opens when you click it. A Nightloom tab opens beside the chat, with back, forward and Open in browser; ⌘-click opens it in the other place." },
  { pane: "appearance", section: "Stop button", help: "The button that takes Send's place while a reply comes in. Applies at once and is remembered." },
  { pane: "appearance", section: "Typed maths", help: "When a message has maths typed as text (s^2, x_1, sqrt(x), “s squared”), a bar above the box offers it as formulas after a pause. Tab or Use maths wraps it as LaTeX, Esc or × keeps it as typed. Nothing changes unless you accept." },
  { pane: "appearance", section: "Typed maths", label: "Offer typed maths as formulas" },
  { pane: "appearance", section: "Pages in replies", help: "A reply can hold a small interactive page — a chart, a diagram, a table with controls — drawn where the reply wrote it. A page runs in a sandbox with no network and nothing of the app; its libraries () come from inside Nightloom. Each page has Hide, Source and Copy on its card." },
  { pane: "appearance", section: "Pages in replies", label: "Show pages as a one-line card until I click Show" },
  { pane: "outside", section: "Outside control", help: "A terminal, a script or another agent on this Mac can list and read your chats through Nightloom's command and its MCP tools. Starting chats and sending messages is off until you switch it on here.", terms: "outside cli command line mcp script agent terminal start send external control" },
  { pane: "outside", section: "Outside control", label: "Let them start chats and send messages" },
  { pane: "quick-entry", section: "Quick Entry", help: "A shortcut that works from any app: it opens a small box over what you are in, without bringing Nightloom forward. Send goes to the chat you last used, a new chat in a project, or an aside on the last chat; the box remembers which. It takes typing, dictation and ⌘V (the clipboard only, so macOS asks for no permission). Closing it keeps what you typed. It works only while Nightloom is running.", terms: "shortcut hotkey keyboard global system-wide box dictation clipboard" },
  { pane: "notifications", section: "Notifications", help: "A native banner while Nightloom is behind another window, on either engine. Never for the window in front — except the Refresh-now one, which you asked for by pressing the button. Clicking one brings Nightloom forward.", terms: "notify banner alert native macos" },
  { pane: "notifications", section: "Notifications", label: "When a turn finishes — files changed, tokens, time" },
  { pane: "notifications", section: "Notifications", label: "When a turn needs you — a permission, a question, a plan" },
  { pane: "notifications", section: "Notifications", label: "When Usage & Cost → Refresh now finishes — the figures; clicking it opens that page. Never for the automatic refresh" },
  { pane: "sleep", section: "Sleep", help: "While a turn, dream or capture runs — on either engine — the Mac is kept awake (a caffeinate assertion — see it under pmset -g assertions). A closed lid on battery still sleeps it; on wake, a turn that was cut off is continued.", terms: "caffeinate awake lid battery wake resume display" },
  { pane: "sleep", section: "Sleep", label: "Keep the Mac awake while a turn runs" },
  { pane: "sleep", section: "Sleep", label: "Keep the display on too" },
  { pane: "sleep", section: "Sleep", label: "Resume a turn interrupted by sleep" },
  { pane: "sleep", section: "Sleep", label: "Ask first (a Resume toast) instead of resuming automatically" },
  { pane: "animations", section: "Thinking block", help: "How a reply's thinking block comes in when the model starts thinking." },
  { pane: "animations", section: "New-chat background", help: "What moves behind the wheel on the new-chat page. Reduce motion is on in macOS, so Horizon and Radar hold one still pose and Default keeps the still dots." },
  { pane: "remote", section: "This Mac's listener", terms: "phone remote port listener tailscale" },
  { pane: "remote", section: "This Mac's listener", label: "Port" },
  { pane: "remote", section: "This Mac's listener", label: "Keep the Mac awake while remote is on (needs System → Sleep's first switch; a closed lid on battery still sleeps it)" },
  { pane: "remote", section: "This Mac's own code", help: "The phone's key. Scan the code with the camera — Safari opens the page with the token in it, once — or paste the text into the page. Regenerate when a phone should stop having it; every phone then scans again." },
  { pane: "away", section: "Server", terms: "away server url address vps" },
  { pane: "away", section: "Server", label: "Address" },
  { pane: "away", section: "Projects available away", help: "A project that is not marked sends nothing; unmarking one removes its copies from the server at the next sync. Incognito chats are never sent." },
  { pane: "usage", section: "Plan", terms: "plan five hour week limit gauge" },
  { pane: "usage", section: "Surfaces", terms: "surfaces share weekly limit" },
  { pane: "usage", section: "The last 7 days, by where it was spent" },
  { pane: "cost", section: "Spend", help: "What Claude Code has cost. These are the API's own usage fields — tokens in, out, cache written and cache read, one count per API message — priced by usage-rates.json. Turns run on a subscription are shown as what they would have cost on the API, not as a bill; a rate change in that file restates every figure here. Days are UTC, as on Anthropic's dashboard." },
  { pane: "cost", section: "Provider credits", terms: "credits balance provider refresh" },
  { pane: "cost", section: "Ledger", help: "The collector runs every six hours by a LaunchAgent (com.swaraagsistla.claude-usage-ledger). Nightloom reads its three files and writes none of them; the same numbers, to the cent, are claude_usage in a shell." },
  { pane: "council", section: "Default roster", terms: "council seats roster models" },
  { pane: "council", section: "Mode", help: "answer: a research dump; each seat answers its questions with sources. disproof: an idea; each seat searches for what already exists and what contradicts it and returns a hits table with a where-I-looked list — no seat and no chair scores novelty or says \"new\"; that judgement stays yours. When every seat cites at least half of the same sources, the next council turn on that chat assigns each seat an area from the chair's Gaps section." },
  { pane: "council", section: "Recent council turns", terms: "council turns history" },
  { pane: "home", section: "Brief", help: "What Home should always know — what you want each morning, what to leave out. Your draft is kept until you save or discard it." },
  { pane: "home", section: "What Home can reach", help: "Your connectors, one row per account. Home reads them; a label, draft or calendar event it proposes changes only when you tap Allow on that one change, and it cannot send or delete anything through them." },
  { pane: "home", section: "Morning scan", help: "The scan is one of your jobs: change its time from the Jobs list on the phone page." },
  { pane: "home", section: "Home's jobs", help: "Run now runs one at once. Past Home's spend guard it asks first." },
  { pane: "projects", section: "Folder", terms: "projects folder path location" },
  { pane: "knowledge", section: "Folder", terms: "knowledge vault notes folder obsidian" },
  { pane: "knowledge", section: "Dreaming", help: "A dream pass consolidates the memory inbox into the vault — the Dream button in the Notes panel runs one by hand. Switched on here, one also runs at every hand-off — a turn that writes HANDOFF.md, or continuing in a new chat — and after a compaction, the moments a chat is finished as far as memory is concerned. A capture pass runs first, reading the chats since the last one into the inbox, on the same engine (the Claude Code engine bills the subscription). When there is nothing new, nothing runs and nothing is said." },
  { pane: "knowledge", section: "Dreaming", label: "Capture and dream automatically at a hand-off" },
  { pane: "knowledge", section: "Every day", help: "Once a day, capture the chats since the last pass into the memory inbox, dream them into the vault and each project's memory, and archive struck-through lines older than 30 days — on the engine chosen above. After the hour, once the Mac has been idle for ten minutes (or at once if the last pass is more than a day and a half old); if Nightloom is closed or the Mac asleep, on the next launch or wake after it. What the pass proposed and changed lands in the bell." },
  { pane: "knowledge", section: "Every day", label: "Capture and dream every day at" },
  { pane: "knowledge", section: "Every day", label: "A macOS notification when the bell gains something" },
  { pane: "saved-prompts", section: "Prompts", terms: "saved prompts slash snippet template" },
  { pane: "saved-prompts", section: "Deleted", help: "Kept here until you restore them." },
  { pane: "models", section: "Files", terms: "model instructions files claude.md" },
  { pane: "models", section: "Chat instructions", help: "How a Chat — the conversational kind, no folder, reads only — talks. Read into the system prompt of every Chat and no Claude Code chat's, after the model's file and before the project's. On the subscription engine it sits on top of the CLI's own prompt, which stays underneath; on the provider engine Nightloom owns the whole prompt. Something like: Talk, don't build. Answer in prose first; no file edits, no commands." },
  { pane: "models", section: "Practices", help: "How you work, in every chat: write findings to files, strike an old claim with a date instead of deleting it, tag where a claim came from, hand off past ~300k. Read from your practices folder, after the Chat instructions and before the project's rules, on both engines. Left out of a Claude Code chat whose folder's CLAUDE.md already imports the full practices.md. A running chat takes a change at its next cold moment." },
  { pane: "models", section: "Practices", label: "Give every chat the practices layer" },
  { pane: "models", section: "Any model", help: "Read or start the file for a model the chat is not on. The list is what the picker knows for that provider — its curated ids and, with a key, what its API lists — and an id in neither can be typed." },
  // Animations' cards drawn from a list (MOTION_KINDS) and its pickers inside a card.
  { pane: "animations", section: "Thinking block", label: "Thinking motion", terms: "thinking animation" },
  { pane: "animations", section: "Thinking block", label: "Reply text", terms: "reply text streaming words rise animation" },
  { pane: "animations", section: "Rewinding a message", help: "How the thread goes back when you rewind to one of your messages.", terms: "rewind animation" },
  // A card of its own component (ImageToolCalls.svelte, item 823), found by its aria-label.
  { pane: "usage", section: "Image tool calls", terms: "image generate_image tool calls count draw" },
  { pane: "animations", section: "Deleting a message", help: "How one of your messages leaves the context when you delete it.", terms: "delete animation" },
];

/** Subscription's controls, from its own inventory (item 546). */
function subscriptionEntries(): SettingEntry[] {
  return CONTROLS.map((c) => ({
    pane: "claude-code",
    section: GROUPS.find((g) => g.id === c.group)?.title ?? c.group,
    label: c.label,
    terms: c.terms,
    fold: { group: `subscription/${c.group}`, row: `subscription/${c.id}` },
  }));
}

/** The whole index, with the providers and backends the app has right now. */
export function settingsIndex(
  providers: { kind: string; label: string }[],
  backends: { name: string; label: string }[],
): SettingEntry[] {
  const dyn: SettingEntry[] = [];
  for (const p of providers) {
    dyn.push({ pane: p.kind, section: p.label, terms: "provider api" });
    dyn.push({ pane: p.kind, section: "API key", label: `${p.label} API key`, terms: "key secret token provider" });
    dyn.push({ pane: p.kind, section: "Models", label: `${p.label} models`, terms: "models picker hide show rail provider" });
  }
  for (const b of backends) {
    dyn.push({ pane: "search:" + b.name, section: b.label, terms: "web search backend" });
    dyn.push({ pane: "search:" + b.name, section: "API key", label: `${b.label} API key`, terms: "key secret token web search" });
  }
  return [...PANES, ...CARDS, ...subscriptionEntries(), ...dyn];
}

/** A pane's title for a result's breadcrumb. */
export function paneTitle(pane: string, providers: { kind: string; label: string }[], backends: { name: string; label: string }[]): string {
  if (PANE_TITLES[pane]) return PANE_TITLES[pane];
  if (pane.startsWith("search:")) return backends.find((b) => "search:" + b.name === pane)?.label ?? pane.slice(7);
  return providers.find((p) => p.kind === pane)?.label ?? pane;
}

export interface SettingHit {
  entry: SettingEntry;
  /** What the row says: the control, else the card. */
  title: string;
  /** "Group › Pane › Card", repeats dropped (`whereOf`). */
  where: string;
  score: number;
  /** When a word was found only in the help: the help around it, so the row says why it matched. */
  snippet?: string;
}

/** About `width` characters of `text` around `at`, with ellipses where cut. */
export function snippetAround(text: string, at: number, width = 70): string {
  let start = Math.max(0, at - Math.floor(width / 3));
  // Start and end on a word's edge, never mid-word.
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    start = sp >= 0 && sp < at ? sp + 1 : start;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    end = sp > at ? sp : end;
  }
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * The breadcrumb under a hit: nav group › pane › card, with a repeat
 * dropped ("Subscription › Subscription") and the last crumb dropped when
 * it is the hit's own title ("Sleep", under System, says "System").
 */
export function whereOf(group: string, pane: string, section: string, title: string): string {
  const crumbs: string[] = [];
  for (const c of [group, pane, section]) if (c && crumbs.at(-1) !== c) crumbs.push(c);
  if (crumbs.length > 1 && crumbs.at(-1) === title) crumbs.pop();
  return crumbs.join(" › ");
}

/** The words of a query, lower-cased; empty when the box is blank. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Every entry whose label, section, pane title, terms or help hold every
 * word, best first: a word in the label (or the card's title, for a card)
 * counts most, then the section and pane, then the terms, then the help.
 * Ties keep the nav's order.
 */
export function searchSettings(
  entries: SettingEntry[],
  q: string,
  titleOf: (pane: string) => string,
  groupOf: (pane: string) => string = () => "",
  limit = 40,
): SettingHit[] {
  const words = queryWords(q);
  if (words.length === 0) return [];
  const hits: SettingHit[] = [];
  entries.forEach((e, i) => {
    const pt = titleOf(e.pane);
    const title = (e.label ?? e.section).toLowerCase();
    const place = `${e.section} ${pt}`.toLowerCase();
    const terms = (e.terms ?? "").toLowerCase();
    const help = (e.help ?? "").toLowerCase();
    let score = 0;
    let helpAt = -1;
    for (const w of words) {
      if (title.startsWith(w) || title.includes(" " + w)) score += 8;
      else if (title.includes(w)) score += 6;
      else if (place.includes(w)) score += 4;
      else if (terms.includes(w)) score += 2;
      else if (help.includes(w)) {
        score += 1;
        if (helpAt < 0) helpAt = help.indexOf(w);
      }
      else return;
    }
    // The whole query as typed, in the title, beats words found apart.
    if (words.length > 1 && title.includes(words.join(" "))) score += 4;
    const where = whereOf(groupOf(e.pane), pt, e.section, e.label ?? e.section);
    const hit: SettingHit = { entry: e, title: e.label ?? e.section, where, score: score - i / 10000 };
    if (helpAt >= 0 && e.help) hit.snippet = snippetAround(e.help, helpAt);
    hits.push(hit);
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
