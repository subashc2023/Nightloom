// @ts-ignore -- node's own module: the suite runs in node; the app's tsconfig carries no node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Item 919 (his bug, 2026-11-23): asides kept missing what the main chat has
// — 698, 699, 732, 768, 774, 775, 776, 777, 786 each fixed one feature with a
// test of that one feature, and the next miss reached him. This test is the
// general one. It holds NO list of capabilities: it reads the window's code
// for everything drawn or set for the chat alone —
//
//   1. every branch of the shared transcript and the composer gated to the
//      chat (`T.isChat`, `!aside`, the else of an `aside` branch), and every
//      component inside one;
//   2. every field of the chat's TranscriptSource (`chatSource()`) that the
//      aside's source (`AsideTranscript.svelte`) leaves out or fixes to an
//      empty constant (`[]`, `null`, `false`, `{}`);
//
// — and fails on each one that has no row in DECISIONS below: a counterpart
// the aside has (checked: the named text is in the named file), or "n/a: …"
// saying why an aside goes without. A new chat-only branch, component or
// source field fails CI until someone decides its aside behaviour. The
// backend's half (hooks, flags, MCP servers, AgentSpec fields) is
// `crates/nightloom-service/src/agent/aside_parity.rs`. The composer's
// script-level gates are item 853's `aside853parity.test.ts`.
//
// `PARITY_ROOT` points the scan at another tree's `src` (how the report
// showed it failing on the code before 919).

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const ROOT = env.PARITY_ROOT ?? decodeURIComponent(new URL("..", import.meta.url).pathname);
const read = (rel: string): string => readFileSync(`${ROOT.replace(/\/$/, "")}/${rel}`, "utf8");
/** A counterpart's file, or nothing when the file is not there. */
const readOr = (rel: string) => {
  try {
    return read(rel);
  } catch {
    return "";
  }
};

/** What the aside does with each chat-only thing: `counterpart: <file> :: <text>`
 *  (the text must be in that file) or `n/a: <why>`. Keys: `<file>: <condition>`
 *  for a gated branch, `<file>: <condition> > <Component>` for a component in
 *  one, `source.<field>` for a TranscriptSource field. */
const DECISIONS: Record<string, string> = {
  // --- the composer (Composer.svelte) ---
  "lib/Composer.svelte: !aside && app.activeSessionId": "counterpart: lib/Composer.svelte :: {:else if aside && app.activeSessionId}",
  "lib/Composer.svelte: !aside && app.activeSessionId > PreviewChip":
    "n/a: the preview is the chat's dev server (430); an aside's `preview` tool reaches the same chat's preview, whose chip the chat shows",
  "lib/Composer.svelte: !aside && app.activeSessionId > BrowserChip": "counterpart: lib/Composer.svelte :: <BrowserChip chat={asideBrowserSession(",
  "lib/Composer.svelte: !aside && app.activeSessionId > TurnCapChip":
    "n/a: the message's usage cap (538) is set by the chat's brief hook, which an aside does not run (081)",
  "lib/Composer.svelte: else of aside": "n/a: see each component below",
  "lib/Composer.svelte: else of aside > Icon": "n/a: an icon inside the chat's own controls below",
  "lib/Composer.svelte: else of aside > FilamentMark": "counterpart: lib/Composer.svelte :: <FilamentMark kind=\"aside\" />",
  "lib/Composer.svelte: else of aside > CouncilPopover":
    "n/a: a council (149) seats several models on the chat's message; an aside is one question on the chat's warm cache (283: no council)",
  "lib/Composer.svelte: else of aside > ScheduleMenu":
    "n/a: a scheduled send (548) is the chat's next message at a time; an aside answers now (283: no schedule ▾)",
  "lib/Composer.svelte: !aside && handoff.noStartPromptChat !== null && handoff.noStartPromptChat === app.activeSessionId && !text":
    "n/a: the note of a chat continued from a hand-off (086); an aside is never continued from one",
  "T.isChat && app.checkpoint && checkpointOwner(T.userIndexes, app.checkpoint) === item.index > Icon": "n/a: as its branch",
  "T.isChat > AsideLayer": "n/a: the layer that draws asides over the chat; an aside does not hold asides of its own",
  // --- the shared transcript (Transcript.svelte / TranscriptClassic.svelte) ---
  "T.isChat && app.checkpoint && checkpointOwner(T.userIndexes, app.checkpoint) === item.index":
    "n/a: a checkpoint fork starts from the chat's own messages; an aside's exchanges are not the chat's log (104)",
  "T.isChat": "n/a: see each component below",
  "T.isChat > AskHandBack": "counterpart: lib/asideAsk.svelte.ts :: resolveAsideApproval",
  "T.isChat > TurnAskHost":
    "n/a: the turn-end question card (753) answers the chat's last reply; an aside's question tools are refused in words (ASIDE_QUESTION_DENIED) and it asks in its answer",
  "T.isChat && app.busy && app.budgetSession && app.turnBudget?.pending_since_ms":
    "n/a: the 85% stop line holds the chat's turn (189); an aside runs only while the chat's turn does not (the agent lock)",
  "T.isChat && app.busy && app.budgetSession && app.turnBudget?.pending_since_ms > BudgetStopCard": "n/a: as its branch",
  "T.isChat && app.error": "counterpart: lib/AsideTranscript.svelte :: aside-stalled",
  "T.isChat && app.rewindRestore && app.rewindRestore.session === app.activeSessionId":
    "counterpart: lib/AsideTranscript.svelte :: rewind",
  "T.isChat && app.rewoundWrites && app.rewoundWrites.session === app.activeSessionId":
    "n/a: the rewound files are the chat's checkpoints; an aside's changes go to the chat as a note (775)",
  "T.isChat && !app.connection && app.connectError && !app.connecting":
    "counterpart: lib/AsideTranscript.svelte :: An aside is answered by Claude Code — connect it to ask",
  "T.isChat > ChatDividers": "n/a: dividers mark the chat's log (its compactions and cuts); an aside has no log of its own",
  "T.isChat > SessionCutNotice": "n/a: the chat's own session cut; an aside forks whatever the chat has",
  "T.isChat > KeepWarmNotice": "counterpart: lib/Composer.svelte :: asideHit",
  // --- the TranscriptSource the aside hands the shared transcript ---
  "source.approvals": "counterpart: lib/AsideTranscript.svelte :: approvals: asideApprovals(",
  "source.chat": "n/a: an aside is not a chat; `runFrom` names the chat it belongs to",
  "source.cliSession": "n/a: an aside forks the chat's session and keeps no session of its own (081)",
  "source.liveModel": "n/a: an aside's answer is drawn under the model it ran on once it lands (283); its composer's picker shows the pick meanwhile",
  "source.livePick": "n/a: the chat's picker; an aside's own is in its composer (283)",
  "source.chatActions": "n/a: branch, fork and edit act on the chat's log; an aside's rewind/edit/retry are its `actions`",
};

/** Every chat-only branch of a Svelte file's markup: its condition and the components inside it. */
export function chatOnlyBranches(src: string): { cond: string; components: string[] }[] {
  const markup = src.slice(src.lastIndexOf("</script>") + 1);
  const out: { cond: string; components: string[] }[] = [];
  const stack: { cond: string; chatOnly: boolean; at: number }[] = [];
  const tok = /\{#if\s+([^}]*)\}|\{:else\s+if\s+([^}]*)\}|\{:else\}|\{\/if\}|<([A-Z][A-Za-z0-9]*)\b/g;
  const chatOnly = (c: string) => /\bT\.isChat\b/.test(c) || /(^|[^\w.!])!aside\b/.test(c);
  // Only a bare `aside` makes its else the chat's alone (`aside && x`'s else holds asides too).
  const positiveAside = (c: string) => /^\s*aside\s*$/.test(c);
  for (let m = tok.exec(markup); m; m = tok.exec(markup)) {
    if (m[1] !== undefined) {
      const cond = m[1].trim();
      stack.push({ cond, chatOnly: chatOnly(cond), at: out.length });
      if (chatOnly(cond)) out.push({ cond, components: [] });
    } else if (m[2] !== undefined) {
      const top = stack[stack.length - 1];
      if (top) {
        const cond = m[2].trim();
        top.chatOnly = chatOnly(cond);
        top.cond = cond;
        if (top.chatOnly) out.push({ cond, components: [] });
      }
    } else if (m[0] === "{:else}") {
      const top = stack[stack.length - 1];
      if (top) {
        top.chatOnly = positiveAside(top.cond);
        if (top.chatOnly) out.push({ cond: `else of ${top.cond}`, components: [] });
      }
    } else if (m[0] === "{/if}") {
      stack.pop();
    } else if (m[3]) {
      // The innermost chat-only branch holds it.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (!stack[i].chatOnly) continue;
        const branch = [...out].reverse().find((b) => b.cond === stack[i].cond || b.cond === `else of ${stack[i].cond}`);
        if (branch && !branch.components.includes(m[3])) branch.components.push(m[3]);
        break;
      }
    }
  }
  return out;
}

/** The fields of the object literal after `anchor`, each with its value's text. */
export function objectFields(src: string, anchor: string): Record<string, string> {
  const start = src.indexOf("{", src.indexOf(anchor));
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{" || src[i] === "(" || src[i] === "[") depth++;
    else if (src[i] === "}" || src[i] === ")" || src[i] === "]") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  // Line comments out first: a comma in one would split a field.
  const body = src.slice(start + 1, end).replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const fields: Record<string, string> = {};
  let d = 0;
  let cur = "";
  const flush = () => {
    const m = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(cur);
    if (m) fields[m[1]] = m[2].trim();
    else {
      const short = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_]\w*)\s*$/.exec(cur);
      if (short) fields[short[1]] = short[1];
    }
    cur = "";
  };
  for (const ch of body) {
    if ("{([".includes(ch)) d++;
    if ("})]".includes(ch)) d--;
    if (ch === "," && d === 0) flush();
    else cur += ch;
  }
  flush();
  return fields;
}

const EMPTY = /^(\[\]|null|false|\{\}|undefined)$/;

/** Every chat-only thing the window's code has, as decision keys. */
export function chatOnlyKeys(): string[] {
  const keys: string[] = [];
  for (const b of chatOnlyBranches(read("lib/Composer.svelte"))) {
    keys.push(`lib/Composer.svelte: ${b.cond}`);
    for (const c of b.components) keys.push(`lib/Composer.svelte: ${b.cond} > ${c}`);
  }
  for (const f of ["lib/Transcript.svelte", "lib/TranscriptClassic.svelte"])
    for (const b of chatOnlyBranches(read(f))) {
      keys.push(b.cond);
      for (const c of b.components) keys.push(`${b.cond} > ${c}`);
    }
  const sources = read("lib/transcriptSource.svelte.ts");
  const chat = objectFields(sources.slice(sources.indexOf("export function chatSource()")), "return {");
  const aside = objectFields(read("lib/AsideTranscript.svelte"), "const source = $derived<TranscriptSource>(");
  for (const [k, v] of Object.entries(chat)) {
    if (EMPTY.test(v)) continue;
    if (!(k in aside) || EMPTY.test(aside[k])) keys.push(`source.${k}`);
  }
  return [...new Set(keys)];
}

describe("919: every chat-only thing in the window has its aside behaviour decided", () => {
  it("the scan reads the code (it finds the gates it must)", () => {
    const keys = chatOnlyKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("T.isChat > TurnAskHost");
    expect(keys).toContain("source.cliSession");
  });

  it("every chat-only branch, component and source field has a row", () => {
    const missing = chatOnlyKeys().filter((k) => !(k in DECISIONS));
    expect(missing, `decide each in DECISIONS (asideParity919.test.ts): a counterpart in asides, or n/a with why`).toEqual([]);
  });

  it("every counterpart it names is there", () => {
    const keys = new Set(chatOnlyKeys());
    const broken: string[] = [];
    for (const [k, v] of Object.entries(DECISIONS)) {
      if (!keys.has(k)) continue;
      const m = /^counterpart: (\S+) :: ([\s\S]+)$/.exec(v);
      if (!m && !v.startsWith("n/a: ")) broken.push(`${k}: not a decision: ${v}`);
      else if (m && !readOr(m[1]).includes(m[2])) broken.push(`${k}: no counterpart — ${m[1]} lacks ${m[2]}`);
    }
    expect(broken).toEqual([]);
  });

  it("the parser follows else branches and nesting", () => {
    const b = chatOnlyBranches(
      `<script></script>{#if aside}<A />{:else}<B />{/if}{#if !aside && x}<C />{#if y}<D />{/if}{:else if aside}<E />{/if}`,
    );
    expect(b).toEqual([
      { cond: "else of aside", components: ["B"] },
      { cond: "!aside && x", components: ["C", "D"] },
    ]);
  });
});
