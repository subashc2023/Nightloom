/**
 * Item 654: runs `dialDrive.ts` for one dial — one requestAnimationFrame
 * loop while anything moves (a reply streaming, the landing, a decay), and
 * none at rest. `view` is what ContextDial draws (raw state: replaced each
 * frame, so only the attributes that read it update); `gear` is a plain
 * object DialMotion reads in its own frame. Under reduced motion each input
 * is drawn once, at once, and no loop runs.
 */
import { untrack } from "svelte";
import { newDrive, stepDrive, type DialView, type DriveInput, type GearView } from "./dialDrive";

export class ContextDrive {
  view = $state.raw<DialView | null>(null);
  /** Bumped each step, so a still (reduced-motion) DialMotion redraws. */
  n = $state(0);
  readonly gear: GearView = { tok: 0, radar: 0, surge: null, glow: 1, landings: 0 };
  #d = newDrive();
  #input: DriveInput | null = null;
  #raf = 0;
  #last = -1;
  #reduce: MediaQueryList | null =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  /** Called from an effect: the drive's own state is written untracked, so it never re-runs that effect. */
  set(input: Omit<DriveInput, "reduce">): void {
    untrack(() => this.#set(input));
  }

  #set(input: Omit<DriveInput, "reduce">): void {
    this.#input = { ...input, reduce: !!this.#reduce?.matches };
    if (this.#input.reduce || typeof requestAnimationFrame !== "function") {
      this.#stop();
      this.#step(0);
      return;
    }
    if (!this.#raf) {
      // The first frame of a run steps by zero (no jump from an old clock).
      if (!this.view) this.#step(0);
      this.#last = -1;
      this.#raf = requestAnimationFrame(this.#frame);
    }
  }

  #frame = (now: number) => {
    this.#raf = 0;
    if (!this.#input) return;
    const dt = this.#last < 0 ? 1 / 60 : (now - this.#last) / 1000;
    this.#last = now;
    const active = this.#step(dt);
    if (active) this.#raf = requestAnimationFrame(this.#frame);
    else this.#last = -1;
  };

  #step(dt: number): boolean {
    if (!this.#input) return false;
    const r = stepDrive(this.#d, dt, this.#input);
    Object.assign(this.gear, r.gear);
    this.view = r.view;
    this.n++;
    return r.active;
  }

  #stop(): void {
    if (this.#raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#last = -1;
  }

  destroy(): void {
    this.#stop();
    this.#input = null;
  }
}
