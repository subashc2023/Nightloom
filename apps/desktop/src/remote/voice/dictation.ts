/**
 * The zero-setup fallback (design §2.2 option D): when this host has no
 * voice (`/api/state`'s `voice` is null) or the page cannot use the
 * microphone (plain HTTP), the mic button arms auto-send on the composer:
 * he taps the keyboard's own dictation key, talks, and 2 s after the text
 * stops changing it is sent. Typing counts as changing, so a typed message
 * sends the same way while armed. Nothing is lost: an empty box never
 * sends, and disarming leaves the text where it is.
 */
export class AutoSend {
  private timer: ReturnType<typeof setTimeout> | null = null;
  armed = false;

  constructor(
    private send: () => void,
    readonly idleMs = 2000,
    // Arrows, not the bare functions: a browser's setTimeout called as a
    // method of another object throws "Illegal invocation".
    private clock: { set: typeof setTimeout; clear: typeof clearTimeout } = {
      set: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout,
      clear: (id) => clearTimeout(id),
    },
  ) {}

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
    this.stop();
  }

  /** The composer's text changed to `text`. */
  changed(text: string): void {
    this.stop();
    if (!this.armed || !text.trim()) return;
    this.timer = this.clock.set(() => {
      this.timer = null;
      if (this.armed) this.send();
    }, this.idleMs);
  }

  private stop(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }
}
