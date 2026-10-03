/**
 * The next message's `claude` process, asked for while he types
 * (nightshift item 256, 2026-10-03).
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
