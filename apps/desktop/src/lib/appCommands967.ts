/**
 * Item 967 (916's item B; blocker 2285, his "u can lowk add all the 19
 * slash commands they're all fine"): what the second batch of app
 * commands does when typed alone in the Mac's box and sent. Each runs the
 * function its existing control already runs — the transcript's Fork
 * helpers button, Send's ▾, the Council popover, the keep-warm switch, the
 * two transcript toggles, the sidebar's Save memory and Make main, ⌘P, the
 * Notes panel's New note, ⌘K's terminal and Agent commands rows, ⌘, and
 * the feedback box.
 *
 * The functions come in through `BoxActions`, so this file is plain logic
 * the suite can drive: `Composer.svelte` passes the real ones (its own for
 * the schedule, the council and keep-warm, the app's for the rest).
 * `/compact`, `/delete`, `/archive` and `/stop` stay out (916's reasons:
 * compaction is off for him; deleting by typing skips Delete's confirm;
 * ⌘. and Stop exist, and text typed mid-turn queues).
 */
import { noteFileName, onOff, pickRow, scheduleArg, SCHEDULE_HINT, type TypedCommand } from "./appCommands";

export type ScheduleWhen = "five_hour" | "seven_day" | "time";

export interface BoxActions {
  /** The box is an aside's. */
  aside: boolean;
  toast(msg: string): void;
  /** Empty the box (the command ran). */
  clear(): void;
  engine(): string | null;
  busy(): boolean;
  sessionId(): string | null;
  /** The log index of the last live message of his, or -1. */
  lastLiveUser(): number;
  // /fork — the transcript's "Fork helpers from here".
  setCheckpoint(index: number): Promise<void>;
  // /schedule — Send's ▾.
  scheduleBlocked(): string | null;
  /** The reset's time for a reset kind; a clock time's from `hhmm`. Null: unknown. */
  scheduleTime(kind: ScheduleWhen, hhmm: string): number | null;
  schedule(words: string, kind: ScheduleWhen, at: number): Promise<boolean>;
  // /council — the Council popover.
  openCouncil(): void;
  sendCouncil(words: string): Promise<void>;
  // /keepwarm — the switch beside the cache chip.
  keepWarmChat(): string | null;
  keepWarmOn(): boolean;
  setKeepWarm(mode: "on" | "off"): Promise<void>;
  // /thinking, /tools — the two transcript toggles.
  transcriptOn(which: "thinking" | "tool"): boolean;
  thinkingDead(): boolean;
  toggleTranscript(which: "thinking" | "tool"): void;
  // /remember — the sidebar row's Save memory from this chat.
  capturing(): boolean;
  saveMemory(id: string): Promise<void>;
  // /project — ⌘P and its rows.
  projects(): readonly { id: string; name: string }[];
  currentProject(): string | null;
  canLeaveProject(): boolean;
  useProject(id: string): Promise<void>;
  openProjects(): void;
  // /note — the Notes panel's New note.
  noteScope(): "project" | "knowledge" | null;
  newNote(scope: "project" | "knowledge", name: string): Promise<void>;
  // /terminal, /commands — ⌘K's two Panels rows.
  terminalCwd(): string | null;
  openTerminal(): Promise<void>;
  openAgentTab(id: string): Promise<void>;
  // /makemain — the top bar's and the row menu's Make main.
  canMakeMain(id: string): boolean;
  makeMain(id: string): Promise<void>;
  // /settings, /feedback — the menu bar's ids.
  menu(id: "settings" | "feedback"): void;
}

/** True when `typed` was one of the second batch (run, or a toast saying
 *  why not); false for any other command, which the caller runs. */
export async function runBatch2({ cmd, arg }: TypedCommand, a: BoxActions): Promise<boolean> {
  switch (cmd.name) {
    case "fork": {
      if (a.engine() !== "claude-code") a.toast("Helpers fork on the Claude Code engine");
      else if (!a.sessionId()) a.toast("Nothing to fork from yet — send a message first");
      else {
        const at = a.lastLiveUser();
        if (at < 0) a.toast("Nothing to fork from yet — send a message first");
        else {
          a.clear();
          await a.setCheckpoint(at);
        }
      }
      return true;
    }
    case "schedule": {
      if (!arg) {
        a.toast(SCHEDULE_HINT);
        return true;
      }
      const s = scheduleArg(arg);
      if ("error" in s) {
        a.toast(s.error);
        return true;
      }
      const blocked = a.scheduleBlocked();
      if (blocked) {
        a.toast(`Send later: ${blocked}`);
        return true;
      }
      const at = a.scheduleTime(s.kind, s.kind === "time" ? s.hhmm : "");
      if (at === null) {
        a.toast(s.kind === "five_hour" ? "The 5-hour reset's time is not known yet — no usage reading with one" : "The weekly reset's time is not known yet — no usage reading with one");
        return true;
      }
      // The scheduler clears the box itself once the message is held.
      await a.schedule(s.words, s.kind, at);
      return true;
    }
    case "council": {
      if (a.engine() !== "claude-code") a.toast("The council runs on the Claude Code engine");
      else if (!arg) {
        a.clear();
        a.openCouncil();
      } else if (a.busy()) a.toast("A reply is running — send to the council when it ends");
      else await a.sendCouncil(arg);
      return true;
    }
    case "keepwarm": {
      const want = onOff(arg);
      if (want === "bad") a.toast("/keepwarm takes on or off");
      else if (!a.keepWarmChat()) a.toast("Keep warm is a chat's — open one with a reply first");
      else {
        a.clear();
        const on = want === null ? !a.keepWarmOn() : want;
        await a.setKeepWarm(on ? "on" : "off");
      }
      return true;
    }
    case "thinking":
    case "tools": {
      const which = cmd.name === "thinking" ? "thinking" : "tool";
      const want = onOff(arg);
      if (want === "bad") a.toast(`/${cmd.name} takes on or off`);
      else if (which === "thinking" && a.thinkingDead()) a.toast("This chat's thinking is hidden — the toggle has nothing to open");
      else {
        a.clear();
        if (want === null || want !== a.transcriptOn(which)) a.toggleTranscript(which);
        a.toast(`${which === "thinking" ? "Thinking" : "Tool calls"}: ${a.transcriptOn(which) ? "shown" : "folded"}`);
      }
      return true;
    }
    case "remember": {
      const id = a.sessionId();
      if (!id) a.toast("Nothing to remember yet — a chat is kept once its first message is sent");
      else if (a.capturing()) a.toast("A capture is already running");
      else {
        a.clear();
        await a.saveMemory(id);
      }
      return true;
    }
    case "project": {
      if (!arg) {
        a.clear();
        a.openProjects();
        return true;
      }
      const rows = a.projects().map((p) => ({ id: p.id, label: p.name }));
      const row = pickRow(arg, rows);
      if (!row) a.toast(`No project “${arg}” — try ${rows.map((r) => r.label).join(", ")}`);
      else if (row.id === a.currentProject()) {
        a.clear();
        a.toast(`Already in ${row.label}`);
      } else if (!a.canLeaveProject()) a.toast("A reply is running — switch project when it ends");
      else {
        a.clear();
        await a.useProject(row.id);
      }
      return true;
    }
    case "note": {
      const scope = a.noteScope();
      if (!arg) a.toast("Type the note's name after /note");
      else if (!scope) a.toast("No project or vault open to hold a note");
      else {
        a.clear();
        await a.newNote(scope, noteFileName(arg));
      }
      return true;
    }
    case "terminal": {
      if (!a.terminalCwd()) a.toast("No folder — this chat has none for a terminal");
      else {
        a.clear();
        await a.openTerminal();
      }
      return true;
    }
    case "commands": {
      const id = a.sessionId();
      if (!id) a.toast("No chat open");
      else {
        a.clear();
        await a.openAgentTab(id);
      }
      return true;
    }
    case "makemain": {
      const id = a.sessionId();
      if (!id || !a.canMakeMain(id)) a.toast("This chat is no version of another — nothing to make main");
      else {
        a.clear();
        await a.makeMain(id);
      }
      return true;
    }
    case "settings":
    case "feedback": {
      a.clear();
      a.menu(cmd.name);
      return true;
    }
  }
  return false;
}
