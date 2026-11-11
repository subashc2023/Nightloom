/**
 * Item 603: closing tabs as Chrome does. Every tab shares one width; when he
 * closes a tab from the strip (its close button, or the middle button), the
 * tabs that stay keep the width they had, so the next tab slides left under
 * the pointer and its close button lands where his pointer already is — five
 * clicks in place close five tabs. The strip re-fits once the pointer leaves
 * it, or once the pointer has rested `idleMs` after the last close without
 * moving (his "does the resize a few seconds after").
 *
 * Pure of the DOM so the tests can drive it with fake timers; the strip
 * measures the width and hands it in.
 */

/** How long a still pointer holds the frozen widths after the last close. */
export const TAB_FREEZE_IDLE_MS = 3000;

export class TabFreeze {
  /** The width every tab is held at, in px; null when the strip fits itself. */
  width: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: (width: number | null) => void,
    private readonly idleMs: number = TAB_FREEZE_IDLE_MS,
  ) {}

  /** A tab closed from the strip; `tabWidth` is its width just before. */
  closed(tabWidth: number): void {
    if (this.width === null && tabWidth > 0) {
      this.width = tabWidth;
      this.onChange(this.width);
    }
    this.arm();
  }

  /** The pointer moved over the strip: a frozen strip stays frozen. */
  moved(): void {
    if (this.width !== null) this.arm();
  }

  /** The pointer left the strip (or the strip goes): re-fit now. */
  thaw(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.width === null) return;
    this.width = null;
    this.onChange(null);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.thaw(), this.idleMs);
  }
}
