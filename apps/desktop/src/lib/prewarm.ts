/**
 * The next message's `claude` process, asked for while he types
 * (nightshift item 256, 2026-10-03), and again the moment a reply ends
 * (blocker 1240, 2026-10-08).
 *
 * Each message starts a new Claude Code process, whose start-up (the CLI,
 * his hooks, the MCP servers) cost ~1.3 s of every message before the
 * model was even asked. The composer asks the backend (`prewarm_agent`,
 * `crates/nightloom-service/src/agent/warm.rs`) to start that process as
 * soon as the open chat holds a draft; Send then finds it ready. The
 * backend starts nothing when the same process is already waiting, so
 * asking again is cheap — but it is still asked at most once per
 * {@link PREWARM_EVERY_MS}, with one trailing ask so the last change (a
 * turn ending under a typed draft) is never dropped.
 *
 * A draft-time ask alone left a pasted or dictated message, sent the
 * instant it lands, with a process too young to have finished starting
 * (14 of 16 slow warm turns, `notes/runner-design/256-301-latency-2026-10-06.md`
 * §2 in nightshift-code). So the composer also asks as soon as the open
 * chat's turn ends ({@link turnEnded}): the process then has his whole
 * reading time to start, and waits up to the backend's `MAX_AGE` (5 min).
 */
import { invoke } from "@tauri-apps/api/core";

export const PREWARM_EVERY_MS = 3000;

/** Whether the composer's state is worth a waiting process: the agent
 *  engine, the chat's own box (not an aside's), no turn running, a draft,
 *  and not a slash command (which goes on argv, never warm). */
export function wantsWarm(s: {
  engine: string | null | undefined;
  busy: boolean;
  aside: boolean;
  text: string;
}): boolean {
  if (s.engine !== "claude-code" || s.busy || s.aside) return false;
  const t = s.text.trimStart();
  return t.length > 0 && !t.startsWith("/");
}

/** What {@link turnEnded} compares: the turn flag and the chat on screen. */
export type TurnView = { busy: boolean; chat: string | null };

/** Blocker 1240: the open chat's turn has just ended — running before, not
 *  now, and the same chat on screen (`null` stays `null` for a new chat's
 *  first turn, whose id is learnt after the turn). A turn sent to the
 *  background because he opened another chat also clears `busy`, but the
 *  chat changed, so that is not a turn end here. */
export function turnEnded(prev: TurnView, now: TurnView): boolean {
  return prev.busy && !now.busy && prev.chat === now.chat;
}

/** Whether a just-ended turn should leave a process waiting: the agent
 *  engine, the chat's own box, and no slash command already typed. An
 *  empty box is fine — that is the point. */
export function wantsWarmAtTurnEnd(s: {
  engine: string | null | undefined;
  aside: boolean;
  text: string;
}): boolean {
  return s.engine === "claude-code" && !s.aside && !s.text.trimStart().startsWith("/");
}

/** At most one ask per `every` ms, the last one in a burst kept. */
export class Prewarmer {
  private last = -Infinity;
  private trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ask: () => void,
    private readonly every = PREWARM_EVERY_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  poke(): void {
    const wait = this.last + this.every - this.now();
    if (wait <= 0) {
      this.fire();
      return;
    }
    if (this.trailing === null) {
      this.trailing = setTimeout(() => this.fire(), wait);
    }
  }

  private fire(): void {
    if (this.trailing !== null) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    this.last = this.now();
    this.ask();
  }
}

/** The app's one prewarmer; a failed ask costs only the head start. */
export const prewarmer = new Prewarmer(() => {
  void invoke("prewarm_agent").catch(() => {});
});

export const AFTER_TURN_TRIES = 3;
export const AFTER_TURN_GAP_MS = 400;

/**
 * The turn-end ask (blocker 1240), outside the draft throttle: the turn
 * that just ended took the last waiting process, and its follow-on
 * session id makes a new one due now, not up to 3 s later. The backend
 * skips (`false`) while something still holds the chat or its agent — the
 * view settling just after the turn — so a `false` is asked again, up to
 * {@link AFTER_TURN_TRIES} times; when it meant "the same one already
 * waits", asking again is a no-op. Resolves to whether a process was
 * started.
 */
export async function prewarmAfterTurn(
  ask: () => Promise<boolean> = () => invoke<boolean>("prewarm_agent"),
  tries = AFTER_TURN_TRIES,
  gap = AFTER_TURN_GAP_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(gap);
    try {
      if (await ask()) return true;
    } catch {
      // Not connected, or the spawn failed: nothing to warm.
      return false;
    }
  }
  return false;
}
