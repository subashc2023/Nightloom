/**
 * Run on a reply's command block (nightshift item 503, 2026-11-04): the calls.
 * A click opens the dock under the chat's pane, a tab named for the command,
 * and runs the block in a new pty under his login shell. When it ends the chat
 * it came from gets a message with the command, the code and the output, drawn
 * as a card (`RanCard.svelte`); `shellRun.ts` holds the pure rules, and its
 * `routeRun` says where the message goes. His click is the approval: nothing
 * asks first and nothing previews (his words: "sent directly to the model").
 *
 * Quitting the app while a block runs: the pty dies with the app, nothing is
 * sent, and no tab comes back. A half-run's output never reaches a chat
 * unless he asked, with Send output so far or Stop.
 */
import * as api from "./api";
import {
  addToast,
  app,
  asideAsking,
  asideOf,
  followUpAside,
  injectIntoTurn,
  runDrainNow,
  sendQueuedInBackground,
  turnChatRef,
} from "./state.svelte";
import { chatName } from "./notify";
import { asideDraftKey } from "./asides";
import { enqueueMessage, readDraft } from "./drafts.svelte";
import {
  chatOfPane,
  markRunEnded,
  openRunShell,
  registerRunEnd,
  runCapture,
  term,
  terminalCwd,
} from "./terminal.svelte";
import { auth, probeAuth } from "./claudeAuth.svelte";
import type { ShellRow } from "./terminal";
import { ranMessage, routeRun, runStatus, runTabTitle } from "./shellRun";

/** How long Stop's ⌃C has before the tab's process is killed. */
export const STOP_GRACE_MS = 1500;

/** Where a block came from, read when he clicks and held by the run. */
export interface RunFrom {
  chat: string | null;
  /** The aside thread it was drawn in, if any. */
  aside?: number | null;
}

interface Source extends RunFrom {
  /** A New chat's first turn has no id yet: the turn learns it. */
  turnChat: () => string | null;
  /** The engine and project it ran under. */
  engine: string | null;
  project: string | null;
  projectName: string | null;
  name: string | null;
}
const sources = new Map<number, Source>();

/** The pane to open under: the one showing that chat, else the focused one. */
function paneFor(chat: string | null): string {
  const shown = chat ? app.tabs.panes.find((p) => chatOfPane(p.id) === chat) : null;
  return shown?.id ?? app.tabs.focused ?? app.tabs.panes[0]?.id ?? "main";
}

/** The chat's folder, or, as the Sign in tab does, the home folder. */
async function folder(): Promise<string | null> {
  const cwd = terminalCwd();
  if (cwd) return cwd;
  return auth.home ?? (await probeAuth())?.home ?? null;
}

/** The click on Run. */
export async function runBlock(command: string, from: RunFrom): Promise<ShellRow | null> {
  const cwd = await folder();
  if (!cwd) {
    addToast("No folder to run this in: the chat has none, and the home folder could not be read.");
    return null;
  }
  const session = app.sessions.find((s) => s.id === from.chat);
  const source: Source = {
    ...from,
    turnChat: turnChatRef(),
    engine: app.connection?.engine ?? null,
    project: app.project?.id ?? null,
    projectName: app.project?.name ?? null,
    name: session ? chatName(session.title, session.first_user) : null,
  };
  const row = await openRunShell(paneFor(from.chat), cwd, {
    command,
    title: runTabTitle(command),
    note: null,
    stopped: false,
    finished: false,
  });
  if (row) sources.set(row.id, source);
  // A `true` can have ended before the source was recorded.
  if (row?.run && row.exit && !row.run.finished) void finish(row);
  return row;
}

/**
 * Whether the chat is still there. Only the project open now is listed here,
 * so a chat of another project counts as there: he switched, he did not delete.
 */
function chatExists(chat: string, src: Source): boolean {
  if (src.project !== (app.project?.id ?? null)) return true;
  return (
    chat === app.activeSessionId ||
    !!app.background[chat] ||
    app.parked?.session === chat ||
    app.sessions.some((s) => s.id === chat)
  );
}

function chatLabel(s: Source): string {
  return s.name ? `"${s.name}"` : "its chat";
}

/** The message to the chat the block came from; the tab says what became of it. */
async function send(row: ShellRow, how: Parameters<typeof runStatus>[0]): Promise<void> {
  const run = row.run;
  const src = sources.get(row.id);
  if (!run || !src) return;
  const capture = runCapture(row.id);
  const output = capture ? capture.take() : "";
  const text = ranMessage({ command: run.command, status: runStatus(how), output });
  const chat = src.chat ?? src.turnChat();
  const exists = chat ? chatExists(chat, src) : false;
  const aside = chat && src.aside != null ? asideOf(chat, src.aside) : null;
  const route = routeRun({
    chat,
    exists,
    aside: aside !== null,
    asideGone: src.aside != null && aside === null,
    queued: !!chat && readDraft(chat).queue.length > 0,
    open: app.activeSessionId,
    busy: app.busy && !app.parked,
    runningElsewhere: !!chat && (!!app.background[chat] || app.parked?.session === chat),
    engine: src.engine,
  });
  switch (route.kind) {
    case "gone":
      // The tab keeps what the grid drew; the capture is spent, so the words
      // are kept for nothing but what is on screen, and it says so.
      run.note = "Not sent: the chat this came from is gone. The output stays in this tab.";
      addToast(`"${run.title}" ended, but the chat it came from is gone: its output stays in the terminal tab.`);
      return;
    case "aside-gone":
      run.note = "Not sent: the aside this came from is gone. The output stays in this tab.";
      addToast(`"${run.title}" ended, but the aside it came from is gone: its output stays in the terminal tab.`);
      return;
    case "aside": {
      const key = asideDraftKey(aside!);
      if (app.activeSessionId === chat && !asideAsking(aside) && !aside!.draft) {
        run.note = "Sent to the aside.";
        await followUpAside(text, aside);
      } else {
        enqueueMessage(key, text, []);
        run.note = "Waiting in the aside's queue.";
      }
      return;
    }
    case "send": {
      const q = enqueueMessage(chat!, text, []);
      const waiting = "Waiting in this chat's queue: a turn can't start right now.";
      const queuedStill = () => readDraft(chat!).queue.some((r) => r.id === q.id);
      // A drain takes its row at once, then awaits the whole send.
      const drained = runDrainNow();
      run.note = queuedStill() ? waiting : "Sent to this chat.";
      await drained;
      // A failed send gives the row back.
      if (queuedStill()) run.note = waiting;
      return;
    }
    case "inject": {
      const q = enqueueMessage(chat!, text, []);
      run.note = "Queued for the running turn.";
      void injectIntoTurn(chat!, q);
      return;
    }
    case "background": {
      enqueueMessage(chat!, text, []);
      const went = await sendQueuedInBackground(
        { chat, pendingKey: null },
        { pendingMode: "normal", pendingKind: app.pendingKind, project: src.project, projectName: src.projectName, name: src.name },
        true,
      );
      const still = readDraft(chat!).queue.some((q) => q.text === text);
      run.note = went && !still ? `Sent to ${chatLabel(src)}.` : `Waiting in the queue of ${chatLabel(src)}.`;
      if (still) addToast(`"${run.title}" ended: its output is waiting in the queue of ${chatLabel(src)}.`);
      return;
    }
    case "queue":
      enqueueMessage(chat!, text, []);
      run.note = `Waiting in the queue of ${chatLabel(src)}, behind what is already there or the turn it is running.`;
      return;
  }
}

/** The block ended, however: once. */
async function finish(row: ShellRow): Promise<void> {
  const run = row.run;
  // Its source is written just after `terminal_run` answers; a block that
  // ended first is finished by `runBlock`.
  if (!run || run.finished || !sources.has(row.id)) return;
  run.finished = true;
  await send(row, { stopped: run.stopped, exit: row.exit });
  sources.delete(row.id);
}
registerRunEnd((row) => void finish(row));

/** The tab's Send output so far: the message goes, the block runs on, and its
 *  end sends only what came after. */
export async function sendSoFar(id: number): Promise<void> {
  const row = term.shells.find((s) => s.id === id);
  if (!row?.run || row.run.finished) return;
  // Nothing since the last one, a double click among them: not a turn's worth.
  if (runCapture(id)?.empty) {
    row.run.note = "Nothing new to send yet.";
    return;
  }
  await send(row, { soFar: true });
}

/** The tab's Stop: ⌃C, and past the grace the process is killed. What ran is
 *  sent, with "stopped by you"; the tab stays. */
export async function stopRun(id: number): Promise<void> {
  const row = term.shells.find((s) => s.id === id);
  if (!row?.run || row.run.finished || row.exit) return;
  row.run.stopped = true;
  void api.terminalWrite(id, "\u0003").catch(() => {});
  setTimeout(() => {
    const now = term.shells.find((s) => s.id === id);
    if (!now || now.exit) return;
    void api.terminalClose(id).catch(() => {});
    markRunEnded(now, { code: null, signal: "SIGKILL" });
  }, STOP_GRACE_MS);
}
