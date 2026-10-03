/**
 * ⌘L's ask (nightshift backlog 290): the open chat's composer takes the
 * focus, its kept caret back, else the end of the draft. A counter, like
 * the rewind's `composerFocus`: the composer that is mounted when it
 * moves answers it, and one mounted later does not.
 */
export const composerSummon = $state<{ seq: number }>({ seq: 0 });

export function summonComposer(): void {
  composerSummon.seq += 1;
}

/**
 * How many chat composers (not an aside's) are mounted. ⌘L goes to the
 * chat's box; an aside tab's box answers only when no chat box is drawn —
 * the aside tab is then what the pane shows.
 */
let chatBoxes = 0;

/** A chat composer mounting; the returned function is its unmount. */
export function chatBoxMounted(): () => void {
  chatBoxes += 1;
  return () => {
    chatBoxes -= 1;
  };
}

export function chatBoxCount(): number {
  return chatBoxes;
}
