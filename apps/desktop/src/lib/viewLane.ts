/**
 * The view's openers, one at a time (item 686, his "the text box where I'm
 * supposed to type was gone"). Opening a chat asks the backend for its log
 * — a read from disk, slow when iCloud has evicted the file — and New chat
 * asks for nothing from disk, so the two answer in any order. Tabs closed
 * fast each open the neighbour; the last tab's New chat answered first and
 * a closed neighbour's late answer made that chat the open one under the
 * New chat tab: no tab was the live one, the pane drew the "Not the open
 * chat" card, and the box was gone. The backend's open chat followed the
 * late answer too.
 *
 * Every opener that changes the open chat runs its backend call and its
 * adoption in this lane, so they land in the order they were asked for:
 * the last one asked for is the one on screen and in the backend. A step
 * that fails lets the next one run. A step must not wait on the lane from
 * inside it (it would wait on itself); the openers check what they defer
 * to before they enter.
 */
let tail: Promise<unknown> = Promise.resolve();

export function inViewLane<T>(step: () => Promise<T>): Promise<T> {
  const run = tail.then(step, step);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
