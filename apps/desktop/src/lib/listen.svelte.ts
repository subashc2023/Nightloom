/*
 * Item 801: the audio made this session, by key, so a player closed (or a
 * view left) and opened again plays at once from where it was — Piper is
 * not asked twice. Blob URLs live as long as the window; the cache holds
 * the last few.
 */
export type Made = { url: string; words?: string };

const MAX = 12;
const made = new Map<string, Made>();
const making = new Map<string, Promise<Made>>();

/** The audio for `key`, made once by `make` (a WAV blob, and the Brief's
 *  words when it is one). */
export function audioFor(key: string, make: () => Promise<{ blob: Blob; words?: string }>): Promise<Made> {
  const have = made.get(key);
  if (have) return Promise.resolve(have);
  const running = making.get(key);
  if (running) return running;
  const p = make()
    .then(({ blob, words }) => {
      const m: Made = { url: URL.createObjectURL(blob), words };
      made.set(key, m);
      while (made.size > MAX) {
        const [oldest, o] = made.entries().next().value as [string, Made];
        URL.revokeObjectURL(o.url);
        made.delete(oldest);
      }
      return m;
    })
    .finally(() => making.delete(key));
  making.set(key, p);
  return p;
}

/** Whether `key`'s audio is being made now. */
export function isMaking(key: string): boolean {
  return making.has(key);
}
