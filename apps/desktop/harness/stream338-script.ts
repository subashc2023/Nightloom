// Item 338 harness — the stream it replays (see stream338.html). One real-shaped
// turn: a thinking block, a short line of text, two Bash calls, an Agent call
// whose subagent works under it, then the reply. Every step is an op at a time
// (ms from the start at 1×) that mutates the live `segs`, exactly as the turn
// events do in the app: text arrives as deltas appended to the last text
// segment, a call arrives with `result: null` and gets its result later.
//
// Deterministic (a seeded generator), so every replay and every column sees the
// same deltas at the same instants.
import type { Segment } from "../src/lib/state.svelte";

export interface Op {
  at: number;
  apply: (segs: Segment[]) => void;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Split into deltas the way the engine sends them: 1–5 tokens, 30–90 ms apart, bursty. */
function deltas(text: string, start: number, r: () => number): { at: number; text: string }[] {
  const toks = text.match(/\S+\s*|\s+/g) ?? [];
  const out: { at: number; text: string }[] = [];
  let t = start;
  let i = 0;
  while (i < toks.length) {
    // Now and then a stall then a burst — what makes a raw stream feel jerky.
    const burst = r() < 0.08;
    const n = burst ? 6 + Math.floor(r() * 8) : 1 + Math.floor(r() * 5);
    out.push({ at: t, text: toks.slice(i, i + n).join("") });
    i += n;
    t += burst ? 140 + r() * 160 : 30 + r() * 60;
  }
  return out;
}

const THINKING =
  "He is asking why the dream pass leaves some struck lines in place. The archive step moves a dated strike older than thirty days; an undated strike never moves, by design, because there is no date to age it by. So the likely answer: the lines he sees are undated, or younger than a month. Check tidy_struck.py for the threshold and the date pattern, run its tests, and have a subagent find every caller so the answer covers the dream's own tidy too.";

const INTRO = "Let me check the archive script, its tests, and who calls it.";

const SHORT_REPLY = `## Why some struck lines stay

The tidy only moves a strike it can **date**. \`tidy_struck.py\` looks for \`~~old claim~~ (struck 2026-09-02)\` and compares that date with today; anything older than **30 days** moves, verbatim, to \`archive/struck/<same path>.md\`, and a pointer is left where it stood.

Two kinds of struck line never move:

1. **Undated strikes.** With no date there is nothing to age, so the script leaves them — on purpose, because guessing a date could archive a claim he struck yesterday.
2. **Strikes younger than a month.** They move on the first tidy after their thirtieth day.

The dream's own tidy calls the same function, so the rule is the same in both places:

\`\`\`python
def is_old(line: str, today: date) -> bool:
    m = STRUCK_DATE.search(line)
    return bool(m) and (today - parse(m[1])).days > 30
\`\`\`

If you want the undated ones gone too, the safe move is to date them first — the script can stamp today's date on every undated strike, and they would leave a month from now.`;

const WORDS =
  "the archive keeps every claim with its source and a date so a later pass can age it and move it without guessing which notes still matter to the work in front of him the tidy reads each line once compares the date with today and leaves a pointer where the claim stood".split(
    " ",
  );

/** A ~`n`-word reply with the shapes a long answer has: headings, lists, code, paragraphs. */
export function longReply(n: number, seed = 7): string {
  const r = rng(seed);
  const word = () => WORDS[Math.floor(r() * WORDS.length)];
  const sentence = () => {
    const k = 8 + Math.floor(r() * 14);
    const ws = Array.from({ length: k }, word);
    if (r() < 0.25) ws[Math.floor(r() * k)] = `**${word()}**`;
    if (r() < 0.2) ws[Math.floor(r() * k)] = `\`${word()}_${Math.floor(r() * 90)}\``;
    const s = ws.join(" ");
    return s[0].toUpperCase() + s.slice(1) + ".";
  };
  const parts: string[] = [];
  let count = 0;
  let section = 1;
  while (count < n) {
    if (count === 0 || r() < 0.08) {
      parts.push(`## Part ${section++}: ${word()} and ${word()}`);
      count += 4;
    }
    const kind = r();
    if (kind < 0.62) {
      const p = Array.from({ length: 3 + Math.floor(r() * 4) }, sentence).join(" ");
      parts.push(p);
      count += p.split(/\s+/).length;
    } else if (kind < 0.86) {
      const items = Array.from({ length: 3 + Math.floor(r() * 3) }, () => `- ${sentence()}`);
      parts.push(items.join("\n"));
      count += items.join(" ").split(/\s+/).length;
    } else {
      const lines = Array.from({ length: 3 + Math.floor(r() * 5) }, () => `    ${word()}_${word()} = tidy(${word()}, days=${Math.floor(r() * 60)})`);
      parts.push("```python\n" + lines.map((l) => l.trim()).join("\n") + "\n```");
      count += lines.length * 4;
    }
  }
  return parts.join("\n\n");
}

const ok = (content: string) => ({ content, is_error: false });

/** The whole turn as ops. `reply` is the final text (short or long). */
export function buildStream(reply: string): { ops: Op[]; end: number } {
  const r = rng(338);
  const ops: Op[] = [];
  const at = (t: number, apply: (s: Segment[]) => void) => ops.push({ at: t, apply });
  const last = (s: Segment[]) => s[s.length - 1] as Extract<Segment, { kind: "text" | "thinking" }>;
  const tool = (s: Segment[], id: string) =>
    (s.find((x) => x.kind === "tool" && x.call.id === id) as Extract<Segment, { kind: "tool" }>).call;

  // Thinking: begins empty, streams, closes with its clock.
  let t = 300;
  const thinkStart = t;
  at(t, (s) => s.push({ kind: "thinking", text: "", done: false, at: Date.now() }));
  t += 450;
  for (const d of deltas(THINKING, t, r)) {
    at(d.at, (s) => (last(s).text += d.text));
    t = d.at;
  }
  t += 350;
  const thinkMs = t - thinkStart;
  at(t, (s) => {
    const th = last(s) as Extract<Segment, { kind: "thinking" }>;
    th.done = true;
    th.ms = thinkMs;
    delete th.at;
  });

  // A line of text.
  t += 250;
  at(t, (s) => s.push({ kind: "text", text: "" }));
  for (const d of deltas(INTRO, t + 30, r)) {
    at(d.at, (s) => (last(s).text += d.text));
    t = d.at;
  }

  // Two Bash calls: one quick, one that runs a while.
  t += 400;
  at(t, (s) =>
    s.push({ kind: "tool", call: { id: "b1", name: "Bash", input: { command: 'grep -n "days" bin/tidy_struck.py', description: "Find the age threshold" }, result: null } }),
  );
  t += 650;
  at(t, (s) => (tool(s, "b1").result = ok('41:    return bool(m) and (today - parse(m[1])).days > 30\n58:DAYS = 30  # backlog 072')));
  t += 300;
  at(t, (s) =>
    s.push({ kind: "tool", call: { id: "b2", name: "Bash", input: { command: "python3 -m pytest tests/test_tidy_struck.py -q", description: "Run the tidy tests" }, result: null } }),
  );
  t += 1700;
  at(t, (s) => (tool(s, "b2").result = ok("......                                                   [100%]\n6 passed in 0.41s")));

  // The subagent: an Agent call whose own turn arrives as children.
  t += 350;
  at(t, (s) =>
    s.push({
      kind: "tool",
      call: { id: "a1", name: "Agent", input: { description: "Find every caller of tidy_struck", subagent_type: "Explore", prompt: "List every caller of tidy_struck and how each passes today's date." }, result: null, children: [] },
    }),
  );
  const kids = (s: Segment[]) => tool(s, "a1").children as Segment[];
  t += 500;
  at(t, (s) => kids(s).push({ kind: "tool", call: { id: "a1g", name: "Grep", input: { pattern: "tidy_struck", path: "." }, result: null } }));
  t += 600;
  at(t, (s) => {
    const c = kids(s).find((x) => x.kind === "tool") as Extract<Segment, { kind: "tool" }>;
    c.call.result = ok("bin/dream.py:212\nbin/tidy_struck.py:1\ntests/test_tidy_struck.py:3");
  });
  t += 300;
  at(t, (s) => kids(s).push({ kind: "tool", call: { id: "a1r", name: "Read", input: { file_path: "bin/dream.py", offset: 200, limit: 30 }, result: null } }));
  t += 500;
  at(t, (s) => {
    const c = kids(s).filter((x) => x.kind === "tool")[1] as Extract<Segment, { kind: "tool" }>;
    c.call.result = ok("def tidy(self):\n    moved = tidy_struck.run(self.root, today=self.today)\n".repeat(6));
  });
  t += 200;
  at(t, (s) => kids(s).push({ kind: "text", text: "" }));
  for (const d of deltas("Two callers: bin/dream.py passes the dream's own date; the tests pass fixed dates. Same rule in both.", t + 30, r)) {
    at(d.at, (s) => {
      const k = kids(s);
      (k[k.length - 1] as Extract<Segment, { kind: "text" }>).text += d.text;
    });
    t = d.at;
  }
  t += 400;
  at(t, (s) => (tool(s, "a1").result = ok("Two callers: bin/dream.py:212 (passes the dream's date) and the tests (fixed dates). Same 30-day rule.")));

  // The reply.
  t += 450;
  at(t, (s) => s.push({ kind: "text", text: "" }));
  for (const d of deltas(reply, t + 40, r)) {
    at(d.at, (s) => (last(s).text += d.text));
    t = d.at;
  }
  return { ops: ops.sort((a, b) => a.at - b.at), end: t + 300 };
}

export const SHORT = SHORT_REPLY;
