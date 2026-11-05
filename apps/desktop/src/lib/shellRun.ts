/**
 * Run on a reply's command block (nightshift item 503, 2026-11-04): the pure
 * part. Which blocks get the button, what comes out of a pty's bytes, and the
 * message that goes to the chat — so the suite can pin them without a DOM or
 * a pty. `shellRun.svelte.ts` holds the calls; `codeCopy.ts` puts the button.
 */

/** The fence languages that are his shell's. A fence with none gets no Run. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/** Whether a `<code>`'s class names a shell (marked writes `language-bash`). */
export function isShellClass(className: string): boolean {
  const m = /(?:^|\s)language-([\w+-]+)/.exec(className);
  return m !== null && SHELL_LANGS.has(m[1].toLowerCase());
}

/**
 * Whether marked's code token is a fence of a shell language: never an
 * indented block, which names no language. The renderer marks these and only
 * these (`markRunFence`), because a reply's raw HTML can draw a `pre` of any
 * class with text the eye does not get: Run reads the mark, not the class.
 */
export function isRunFence(token: { lang?: string; codeBlockStyle?: string }): boolean {
  if (token.codeBlockStyle === "indented") return false;
  // `bash start-prompt` is a hand-off's prose (item 463), not a command.
  const words = (token.lang ?? "").trim().split(/\s+/);
  return !words.includes("start-prompt") && SHELL_LANGS.has(words[0].toLowerCase());
}

/** The attribute a real shell fence's `<pre>` carries. */
export const RUN_FENCE_ATTR = "data-run-fence";
/**
 * Its value, new each launch and never shown to a model: raw HTML in a reply
 * keeps `data-` attributes through DOMPurify, so a fixed value could be copied.
 */
export const RUN_MARK = Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join("");

/** marked's block HTML for a run fence, with the mark on its `<pre>`. */
export function markRunFence(html: string): string {
  return html.replace(/^<pre\b/, `<pre ${RUN_FENCE_ATTR}="${RUN_MARK}"`);
}

/**
 * Whether a block holds a control or format character (Unicode Cc, Cf) other
 * than a newline or a tab: a zero-width character or a right-to-left override
 * makes what shows differ from what runs, so such a block keeps Copy and gets no Run.
 */
export function hasHiddenChars(text: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\t]/g, ""));
}

/**
 * Whether the reply's source ends inside a fenced block — that block is still
 * arriving, or was cut off, and its last `pre` must not run: never half a
 * command. While `streaming`, a closing fence that is the very last thing
 * received is not trusted either, since the next chunk may extend the line.
 * Fences are read through a quote or list's indent, CommonMark's way: the
 * closer is the opener's character, at least as long, with nothing after it.
 */
export function endsInOpenFence(text: string, streaming = false): boolean {
  let open: { ch: string; len: number } | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^[\s>]*(?:[-*+]\s+|\d+[.)]\s+)?(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const ch = m[1][0];
    if (!open) {
      // A backtick fence's info string has no backticks; that line is inline code.
      if (ch === "`" && m[2].includes("`")) continue;
      open = { ch, len: m[1].length };
    } else if (ch === open.ch && m[1].length >= open.len && m[2].trim() === "") {
      if (streaming && i === lines.length - 1) return true;
      open = null;
    }
  }
  return open !== null;
}

/** The tab's name: the block's first line that does something, cut. */
export function runTabTitle(command: string): string {
  const line = command.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? command.trim();
  return line.length > 32 ? `${line.slice(0, 31)}…` : line;
}

/**
 * A pty's text as the words on screen: escape sequences out (colours, cursor
 * moves, titles, bracketed paste), a carriage return overwrites its line so a
 * progress bar leaves its last state, a backspace takes the character before.
 */
export function stripAnsi(raw: string): string {
  const plain = raw
    // OSC, DCS, APC, PM, SOS: up to BEL or ST. One never ended is not a
    // string: its ESC goes below and the rest stays, rather than all of it.
    .replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // CSI.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Charset and other two- and three-byte escapes.
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\x1b/g, "")
    // C1 controls: U+009B is a one-byte CSI, and xterm obeys it.
    .replace(/[\u0080-\u009f]/g, "");
  const out: string[] = [];
  for (const line of plain.replace(/\r\n/g, "\n").split("\n")) {
    const last = line.replace(/\r+$/, "").split("\r").pop() ?? "";
    let kept = "";
    for (const c of last) {
      if (c === "\b") kept = kept.slice(0, -1);
      else if (c === "\t" || c >= " ") kept += c;
    }
    out.push(kept);
  }
  return out.join("\n");
}

/**
 * The most output one message carries, in characters: 30,000, the length
 * Claude Code itself cuts a Bash result to by default (`external`, the CLI's
 * `BASH_MAX_OUTPUT_LENGTH`), so a run costs the model what the same command
 * would have cost it as a tool call. About 7,500 tokens.
 */
export const RUN_OUTPUT_CAP = 30_000;
/** Of the cap, the share kept from the start; the tail, where errors end up, gets the rest. */
const HEAD_SHARE = 1 / 3;

/** Head and tail, with a line saying what went. Short output comes back as it is. */
export function cutOutput(text: string, cap: number = RUN_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * HEAD_SHARE);
  const tail = cap - head;
  const gone = text.length - cap;
  return `${text.slice(0, head)}\n[… ${gone.toLocaleString("en-US")} characters cut …]\n${text.slice(-tail)}`;
}

/**
 * What a run has printed, kept as it arrives. A dev server can print for days,
 * so only a head and a tail of the raw text stay, each a few times what the
 * message can carry (the escapes go at the end, and they can outweigh the
 * words), and `dropped` counts the middle.
 */
export class RunCapture {
  private decoder = new TextDecoder();
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private keep: number = RUN_OUTPUT_CAP * 4) {}

  add(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    const room = this.keep - this.head.length;
    if (room > 0) {
      this.head += text.slice(0, room);
      this.tail += text.slice(room);
    } else this.tail += text;
    if (this.tail.length > this.keep * 2) {
      this.dropped += this.tail.length - this.keep;
      this.tail = this.tail.slice(-this.keep);
    }
  }

  /** The output so far as plain text, cut to the cap; the capture starts over. */
  take(cap: number = RUN_OUTPUT_CAP): string {
    const head = this.head;
    const tail = this.tail;
    const dropped = this.dropped;
    this.head = "";
    this.tail = "";
    this.dropped = 0;
    if (dropped === 0) return cutOutput(stripAnsi(head + tail).trimEnd(), cap);
    // Far past the cap whichever way the escapes fall: head and tail apart.
    const a = stripAnsi(head);
    const b = stripAnsi(tail);
    const headRoom = Math.floor(cap * HEAD_SHARE);
    return `${a.slice(0, headRoom)}\n[… about ${(dropped + a.length + b.length - cap).toLocaleString("en-US")} characters cut …]\n${b.trimEnd().slice(-(cap - headRoom))}`;
  }

  /** Whether nothing has arrived since the last `take`. */
  get empty(): boolean {
    return this.head === "" && this.tail === "";
  }
}

/** How a run stands in its message's first line. */
export function runStatus(
  how: { stopped?: boolean; soFar?: boolean; exit?: { code: number | null; signal: string | null } | null },
): string {
  if (how.soFar) return "still running, output so far";
  if (how.stopped) return "stopped by you";
  const e = how.exit;
  if (!e) return "ended";
  if (e.code !== null) return `exit ${e.code}`;
  return e.signal ? `ended by ${e.signal}` : "ended";
}

const RAN_LEAD = "Ran in terminal — ";
const OUT_OPEN = "<terminal-output>";
const OUT_CLOSE = "</terminal-output>";

export interface RanMessage {
  command: string;
  /** `exit 0`, `stopped by you`, `still running, output so far`. */
  status: string;
  output: string;
}

/**
 * The message the chat gets. Plain words for the model, and one shape the
 * bubble can read back: the first line is what a queue row shows.
 */
export function ranMessage(m: RanMessage): string {
  return `${RAN_LEAD}${m.status}\n$ ${m.command.trim()}\n${OUT_OPEN}\n${m.output}\n${OUT_CLOSE}`;
}

/** The message back, for the card; null for anything he typed himself. */
export function parseRan(text: string): RanMessage | null {
  if (!text.startsWith(RAN_LEAD) || !text.endsWith(`\n${OUT_CLOSE}`)) return null;
  const eol = text.indexOf("\n");
  const open = text.indexOf(`\n${OUT_OPEN}\n`, eol);
  if (open < 0 || text.slice(eol + 1, eol + 3) !== "$ ") return null;
  return {
    status: text.slice(RAN_LEAD.length, eol),
    command: text.slice(eol + 3, open),
    output: text.slice(open + OUT_OPEN.length + 2, -(OUT_CLOSE.length + 1)),
  };
}

/** Where a finished run's message goes (`shellRun.svelte.ts` does it). */
export type RunRoute =
  /** That chat is gone: the output stays in the tab, and the tab says so. */
  | { kind: "gone" }
  /** The aside it came from is gone: the same, never the chat's main line. */
  | { kind: "aside-gone" }
  /** The aside it came from: asked there, or held in its queue. */
  | { kind: "aside" }
  /** On screen and idle: sent as the next turn. */
  | { kind: "send" }
  /** On screen with a turn running: queued, offered to the turn at its next step. */
  | { kind: "inject" }
  /** Off screen and idle on Claude Code: sent there in the background. */
  | { kind: "background" }
  /** Held in that chat's queue: its turn's end, or he, sends it. */
  | { kind: "queue" };

/**
 * The rule the spec states: the message goes to the chat the block came from,
 * never the one open; a chat that is gone keeps nothing and the tab keeps the
 * output.
 */
export function routeRun(s: {
  chat: string | null;
  exists: boolean;
  aside: boolean;
  /** It came from an aside that can no longer be found. */
  asideGone: boolean;
  /** `chat`'s queue already has rows: its head may be his, and held. */
  queued: boolean;
  open: string | null;
  busy: boolean;
  /** A turn of `chat` runs off screen or parked. */
  runningElsewhere: boolean;
  engine: string | null;
}): RunRoute {
  if (!s.chat || !s.exists) return { kind: "gone" };
  if (s.asideGone) return { kind: "aside-gone" };
  if (s.aside) return { kind: "aside" };
  if (s.queued || s.runningElsewhere) return { kind: "queue" };
  if (s.open === s.chat) return s.busy ? { kind: "inject" } : { kind: "send" };
  return s.engine === "claude-code" ? { kind: "background" } : { kind: "queue" };
}
