/**
 * The app's own slash commands (item 966, 916's item A; blocker 2285's
 * default batch): one table that the main chat's box, an aside's box and
 * the phone page's chat box all read, so a command added here reaches every
 * surface its row marks, and the menu, the send and the suite cannot
 * disagree. Before this, `/handoff` (item 915) was the one app command,
 * written into the composer by hand.
 *
 * A command is typed alone in the box — `/name` or `/name words` — and on
 * Send it runs its action instead of going as text. The menu lists it on
 * either engine, labelled `app`, ahead of Claude Code's own skills and
 * commands; where Claude Code has a command of the same name (`/model`,
 * `/context`, `/rewind`, `/rename`), the app's wins and the CLI's row is
 * hidden, as `/handoff` already did (916's decision).
 *
 * This file is pure: the parse, the matches, and the argument matchers.
 * What each command does is the caller's — `Composer.svelte` on the Mac,
 * `Remote.svelte` on the phone — each through the function a click there
 * already runs.
 */
import { ASIDE_HIDDEN } from "./asideControls";

export type AppCommandName =
  | "handoff"
  | "aside"
  | "model"
  | "effort"
  | "rename"
  | "rewind"
  | "context"
  | "new"
  | "search"
  // Item 967 (916's item B, blocker 2285: his "add all the 19").
  | "fork"
  | "schedule"
  | "council"
  | "keepwarm"
  | "thinking"
  | "tools"
  | "remember"
  | "project"
  | "note"
  | "terminal"
  | "commands"
  | "makemain"
  | "settings"
  | "feedback";

/** Where a box is: the main chat's, an aside's, or the phone page's chat box. */
export type CommandSurface = "chat" | "aside" | "phone";

export interface AppCommand {
  name: AppCommandName;
  /** What follows the name, for the menu (`<question>`), or "" for none. */
  args: string;
  /** What it does, for the menu's row. */
  what: string;
  /** Not in an aside's box, with why — `ASIDE_HIDDEN`'s words where the
   *  control it runs is the chat's alone; null where an aside has it too. */
  notInAside: string | null;
  /** The phone page runs it (from what its chat page can already do). */
  phone: boolean;
}

/** The table, in the menu's order. */
export const APP_COMMANDS: readonly AppCommand[] = [
  { name: "handoff", args: "", what: "send the hand-off message now", notInAside: ASIDE_HIDDEN.handoff, phone: false },
  { name: "aside", args: "<question>", what: "ask aside — off the warm cache, recorded nowhere", notInAside: ASIDE_HIDDEN.askAside, phone: true },
  { name: "model", args: "<name>", what: "switch the model (alone: open the model menu)", notInAside: null, phone: true },
  { name: "effort", args: "<level>", what: "set the effort (alone: open its menu)", notInAside: null, phone: true },
  { name: "rename", args: "<title>", what: "rename this chat (in an aside: the aside)", notInAside: null, phone: true },
  { name: "rewind", args: "", what: "drop the last exchange; its message back in the box", notInAside: null, phone: true },
  { name: "context", args: "", what: "open the Context panel", notInAside: null, phone: true },
  { name: "new", args: "[code|chat|incognito|ephemeral]", what: "a new chat of that kind (alone: the project's kind)", notInAside: null, phone: true },
  { name: "search", args: "<words>", what: "search chats and notes", notInAside: null, phone: true },
  // Item 967: the second batch, in 916's table order. Chat-only where the
  // table says so — `ASIDE_HIDDEN`'s words where the control is listed
  // there, else the reason in the same voice. The phone has those its page
  // can already run: the message menu's checkpoint, the council sheet, the
  // projects page.
  { name: "fork", args: "", what: "helpers fork from the end of the last exchange", notInAside: ASIDE_HIDDEN.fork, phone: true },
  { name: "schedule", args: "<time> <message>", what: "send the message later — a time (9:30pm, 21:30), reset or week", notInAside: ASIDE_HIDDEN.schedule, phone: false },
  { name: "council", args: "<message>", what: "send the message to the council (alone: open its roster)", notInAside: ASIDE_HIDDEN.council, phone: true },
  { name: "keepwarm", args: "[on|off]", what: "the keep-warm switch (alone: flip it)", notInAside: null, phone: false },
  { name: "thinking", args: "[on|off]", what: "show or fold thinking in every reply", notInAside: null, phone: false },
  { name: "tools", args: "[on|off]", what: "show or fold tool calls in every reply", notInAside: null, phone: false },
  { name: "remember", args: "", what: "save memory from this chat", notInAside: "Save memory reads the chat's log; an aside is recorded nowhere", phone: false },
  { name: "project", args: "<name>", what: "switch project (alone: the projects list)", notInAside: null, phone: true },
  { name: "note", args: "<title>", what: "a new note in this project (or the vault)", notInAside: null, phone: false },
  { name: "terminal", args: "", what: "a new terminal in the project folder", notInAside: null, phone: false },
  { name: "commands", args: "", what: "this chat's agent commands, view only", notInAside: null, phone: false },
  { name: "makemain", args: "", what: "make this version the main chat", notInAside: "Make main moves the chat's row; an aside has no row", phone: false },
  { name: "settings", args: "", what: "open Settings", notInAside: null, phone: false },
  { name: "feedback", args: "", what: "open the feedback box", notInAside: null, phone: false },
];

/** Whether `cmd` runs from a box on `surface`. */
export function commandOn(cmd: AppCommand, surface: CommandSurface): boolean {
  if (surface === "aside") return cmd.notInAside === null;
  if (surface === "phone") return cmd.phone;
  return true;
}

/** The commands on `surface`. */
export function commandsOn(surface: CommandSurface): AppCommand[] {
  return APP_COMMANDS.filter((c) => commandOn(c, surface));
}

/**
 * The menu's rows for a box holding `text`: only while the whole box is a
 * `/word` (as `/handoff`'s row was), every command on `surface` whose name
 * starts with the word. A word with a space after it has been picked: no
 * rows, the menu closes, and Send runs it.
 */
export function commandMatches(text: string, surface: CommandSurface): AppCommand[] {
  const m = /^\/([A-Za-z0-9_-]*)$/.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commandsOn(surface).filter((c) => c.name.startsWith(q));
}

/** The menu's label for a command's row: `app`, then what it does. */
export function commandKind(cmd: AppCommand): string {
  return `app · ${cmd.what}`;
}

export interface TypedCommand {
  cmd: AppCommand;
  /** What followed the name, trimmed; "" for none. */
  arg: string;
}

/**
 * The command a box holding `text` runs on Send, or null when it is text to
 * send: `/name` alone or `/name words`, the name exactly a command's
 * (any case), spaces around it fine, the words any length (an aside's
 * question may run to several lines). `/handoffs` or `/model-x` are text.
 */
export function parseCommand(text: string, surface: CommandSurface): TypedCommand | null {
  const m = /^\s*\/([A-Za-z]+)(?:\s+([\s\S]*?))?\s*$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const cmd = APP_COMMANDS.find((c) => c.name === name);
  if (!cmd || !commandOn(cmd, surface)) return null;
  const arg = (m[2] ?? "").trim();
  // A command that takes nothing, with words after it, is a message
  // (`/handoff now`, `/context please` — item 915's rule for /handoff).
  if (!cmd.args && arg) return null;
  return { cmd, arg };
}

/** A row a menu draws (the model and effort menus' rows): its id and label. */
export interface PickRow {
  id: string;
  label: string;
}

/**
 * The row `arg` names, out of a menu's `rows`: the id or label exactly
 * (any case), else the one row whose label or id starts with it, else the
 * one row that holds it as a word (`opus` → `Opus 5.5`). Null when none or
 * several do — the caller says which, rather than guess.
 */
export function pickRow<R extends PickRow>(arg: string, rows: readonly R[]): R | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const exact = rows.filter((r) => r.id.toLowerCase() === a || r.label.toLowerCase() === a);
  if (exact.length >= 1) return exact[0];
  const starts = rows.filter((r) => r.label.toLowerCase().startsWith(a) || r.id.toLowerCase().startsWith(a));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;
  const words = rows.filter((r) => r.label.toLowerCase().split(/[\s·]+/).includes(a));
  return words.length === 1 ? words[0] : null;
}

/** The CLI's effort levels, `default` (no flag) as "". */
export const EFFORT_LEVELS = ["", "low", "medium", "high", "xhigh", "max"] as const;

/** `/effort`'s word as a level: "" for `default`; null when it is none. */
export function effortLevel(arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (a === "default" || a === "none") return "";
  if (a === "med") return "medium";
  return (EFFORT_LEVELS as readonly string[]).includes(a) && a !== "" ? a : null;
}

export type NewKind = "default" | "build" | "chat" | "incognito" | "ephemeral";

/** `/new`'s word as a kind of chat; null when it names none. */
export function newKind(arg: string): NewKind | null {
  const a = arg.trim().toLowerCase();
  if (!a) return "default";
  if (a === "code" || a === "build" || a === "claude-code" || a === "cc") return "build";
  if (a === "chat" || a === "talk") return "chat";
  if (a === "incognito" || a === "private") return "incognito";
  if (a === "ephemeral" || a === "temp") return "ephemeral";
  return null;
}

/** The sentence for a word `/new` does not know. */
export const NEW_KINDS_HINT = "/new takes code, chat, incognito or ephemeral";

/** `[on|off]`'s word: true, false, null for none (a flip), or "bad". */
export function onOff(arg: string): boolean | null | "bad" {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  if (a === "on" || a === "show" || a === "yes") return true;
  if (a === "off" || a === "fold" || a === "hide" || a === "no") return false;
  return "bad";
}

/** What `/schedule` read: when, and the message to send then. */
export type ScheduleArg =
  | { kind: "five_hour" | "seven_day"; words: string }
  | { kind: "time"; hhmm: string; words: string }
  | { error: string };

/** The sentence for a `/schedule` it cannot read. */
export const SCHEDULE_HINT = "Type a time and the message: /schedule 9:30pm …, /schedule reset …, /schedule week …";

/**
 * `/schedule`'s words: the first is when — `reset` (or `5h`) for the
 * five-hour reset, `week` for the weekly one, or a clock time (`21:30`,
 * `9:30pm`, `9pm`) — and the rest, any length, is the message. A bare
 * hour with no am/pm (`9`) is not read: it could be either.
 */
export function scheduleArg(arg: string): ScheduleArg {
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(arg.trim());
  if (!m) return { error: SCHEDULE_HINT };
  const when = m[1].toLowerCase();
  const words = (m[2] ?? "").trim();
  let out: ScheduleArg | null = null;
  if (when === "reset" || when === "5h" || when === "5-hour") out = { kind: "five_hour", words };
  else if (when === "week" || when === "weekly") out = { kind: "seven_day", words };
  else {
    const t = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(when);
    if (t && (t[2] !== undefined || t[3] !== undefined)) {
      let h = Number(t[1]);
      const min = Number(t[2] ?? "0");
      if (t[3]) {
        if (h < 1 || h > 12) return { error: `No time “${m[1]}” — ${SCHEDULE_HINT}` };
        h = (h % 12) + (t[3] === "pm" ? 12 : 0);
      }
      if (h > 23 || min > 59) return { error: `No time “${m[1]}” — ${SCHEDULE_HINT}` };
      out = { kind: "time", hhmm: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`, words };
    }
  }
  if (!out) return { error: `No time “${m[1]}” — ${SCHEDULE_HINT}` };
  if (!out.words) return { error: "Type the message after the time" };
  return out;
}

/** A note's file name from `/note`'s title: `.md` added when it has no
 *  extension, as the Notes panel's New note does. */
export function noteFileName(title: string): string {
  const name = title.trim();
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
}
