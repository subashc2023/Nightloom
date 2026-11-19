/**
 * Item 868: one clock for the "converting slides · 1:12" words on chips and
 * Notes rows. It ticks once a second only while some view says something
 * is converting (`tickWhile`), and stops when none does.
 */
export const clock = $state({ now: Date.now() });

let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;

/** Call during a component's setup: the clock ticks while `active()`. */
export function tickWhile(active: () => boolean): void {
  $effect(() => {
    if (!active()) return;
    users++;
    clock.now = Date.now();
    timer ??= setInterval(() => (clock.now = Date.now()), 1000);
    return () => {
      if (--users === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  });
}
