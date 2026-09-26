/**
 * The launch (nightshift item 220, 2026-09-26).
 *
 * He opened the app to an empty window saying "not connected", no projects,
 * no chats, for 7–86 s (2026-09-25): `init` read the project list, then
 * reopened the last project, then read the chats, the vault, the notes …
 * one after another, and only then connected — and until the connect ended
 * the top bar said "not connected", which read as broken rather than
 * "still starting".
 *
 * Now: the window shows the moon and "Opening <project>…" until the project
 * list is read and the last project has reopened (or `REOPEN_DEADLINE_MS`
 * has passed, when the app shows and the reopen finishes behind it); the
 * connect runs beside the reads rather than after them; and the connection
 * reads "connecting…" until the launch's connect has actually settled —
 * "not connected" only once it has failed, or when there was nothing to
 * connect.
 */

/** What the launch screen and the connection label read. */
export const launch = $state({
  /** The launch screen is up: the list is not read or the reopen not done. */
  opening: true,
  /** The project being reopened, by name once the list has it. */
  project: null as string | null,
  /** The launch's connect has ended, however it ended. */
  connectSettled: false,
});

/** How long the launch screen waits on the last project's reopen. */
export const REOPEN_DEADLINE_MS = 15_000;

/** The launch screen's line. */
export function launchMessage(project: string | null): string {
  return project ? `Opening ${project}…` : "Opening Nightloom…";
}

/**
 * The connection's word in the top bar and on the rail. "not connected" is
 * said only when it is true: no connection, none running, and the launch's
 * connect over.
 */
export function connectionWord(s: {
  connected: boolean;
  connecting: boolean;
  launchConnectSettled: boolean;
}): "connected" | "connecting…" | "not connected" {
  if (s.connected) return "connected";
  if (s.connecting || !s.launchConnectSettled) return "connecting…";
  return "not connected";
}

/** The steps `init` hands the launch; the tests hand fakes. */
export interface LaunchSteps {
  /** Read the project list (`refreshProjects`). */
  listProjects(): Promise<void>;
  /** The project to reopen, read after the list: id and name, or null. */
  lastProject(): { id: string; name: string } | null;
  /** Reopen it; rejects when it cannot be opened. */
  openProject(id: string): Promise<void>;
  /** Forget the last project (its reopen failed). */
  forgetLastProject(): void;
  /** Tell the backend the next chat's kind, before the engine is built. */
  newSession(): Promise<void>;
  /** The launch connect (`autoConnect`). */
  connect(): Promise<void>;
  /** Reads that need the project but not the connection; run together. */
  reads: Array<[string, () => Promise<void>]>;
  /** After the lists and the connect (`restoreTabs`). */
  after(): Promise<void>;
  /** The window's timing of a step, for the startup log. */
  mark(step: string, ms: number, detail?: string): void;
  now(): number;
}

async function timed<T>(s: LaunchSteps, step: string, p: () => Promise<T>): Promise<T> {
  const t0 = s.now();
  try {
    return await p();
  } finally {
    s.mark(step, s.now() - t0);
  }
}

/**
 * The launch, in order: the list; the last project's reopen (the launch
 * screen waits on it up to `reopenMs`, the connect waits on it always —
 * the project decides the workspace the tools are rooted at); the next
 * chat's kind; then the connect and the reads together; then `after`.
 */
export async function runLaunch(s: LaunchSteps, reopenMs = REOPEN_DEADLINE_MS): Promise<void> {
  launch.opening = true;
  launch.project = null;
  launch.connectSettled = false;
  const t0 = s.now();
  try {
    await timed(s, "listProjects", () => s.listProjects());
    const last = s.lastProject();
    launch.project = last?.name ?? null;
    if (last) {
      const opened = s.now();
      const reopen = s.openProject(last.id).then(
        () => s.mark("openProject", s.now() - opened),
        () => {
          s.mark("openProject", s.now() - opened, "(error)");
          // A project whose folder vanished must not stop the app launching.
          s.forgetLastProject();
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), reopenMs);
      });
      const first = await Promise.race([reopen.then(() => "done" as const), deadline]);
      clearTimeout(timer);
      if (first === "late") {
        s.mark("openProject", reopenMs, "(launch screen deadline; still opening)");
        launch.opening = false;
      }
      await reopen;
    }
    launch.opening = false;
    await timed(s, "newSession", () => s.newSession().catch(() => {}));
    const connecting = timed(s, "connect", () => s.connect())
      .catch(() => {})
      .finally(() => (launch.connectSettled = true));
    const reading = Promise.all(
      s.reads.map(([name, r]) => timed(s, name, () => r().catch(() => {}))),
    );
    await Promise.all([connecting, reading]);
    await timed(s, "after", () => s.after());
  } finally {
    launch.opening = false;
    launch.connectSettled = true;
    s.mark("launch", s.now() - t0);
  }
}
