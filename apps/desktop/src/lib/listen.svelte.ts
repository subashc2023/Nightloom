/*
 * Item 801, parts since item 862: the readings made this session, by key
 * (the thing, Brief or not, and its words), so a player closed (or a view
 * left) and opened again plays at once from where it was — Piper is not
 * asked twice. A reading fills in a part at a time: the first is short so
 * playback starts within seconds, each next is made while the one before
 * plays. Blob URLs live as long as the window; the cache holds the last few.
 */
import { failWords, wavSeconds, type Source } from "./listen";

const MAX = 12;

export class Reading {
  /** The Brief's words, once written (a Brief only). */
  words = $state<string | undefined>(undefined);
  /** Each landed part's audio, in order. */
  urls = $state<string[]>([]);
  /** Each landed part's length, seconds (from its WAV header: exact). */
  lengths = $state<number[]>([]);
  /** How many parts there are; 0 until the first lands. */
  count = $state(0);
  /** Why it stopped short, if it did. */
  failed = $state("");
  dropped = false;

  get done(): boolean {
    return this.count > 0 && this.urls.length >= this.count;
  }

  drop(): void {
    this.dropped = true;
    for (const u of this.urls) URL.revokeObjectURL(u);
  }
}

const readings = new Map<string, Reading>();

/** The reading for `key`, started now if there is none (or the last one
 *  failed): `text` read aloud by `source`, after its Brief when `brief`. */
export function readingFor(key: string, text: string, brief: boolean, source: Source): Reading {
  const have = readings.get(key);
  if (have && !have.failed) {
    // Most recently used last, so the oldest is the one dropped.
    readings.delete(key);
    readings.set(key, have);
    return have;
  }
  const r = new Reading();
  readings.set(key, r);
  while (readings.size > MAX) {
    const [oldest, o] = readings.entries().next().value as [string, Reading];
    o.drop();
    readings.delete(oldest);
  }
  void run(r, text, brief, source);
  return r;
}

async function run(r: Reading, text: string, brief: boolean, source: Source): Promise<void> {
  try {
    let body = text;
    if (brief) {
      body = await source.brief(text);
      if (r.dropped) return;
      r.words = body;
    }
    for (let i = 0; ; i++) {
      const { bytes, parts } = await source.part(body, i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      if (r.dropped) {
        URL.revokeObjectURL(url);
        return;
      }
      r.count = Math.max(1, parts);
      r.lengths = [...r.lengths, wavSeconds(bytes)];
      r.urls = [...r.urls, url];
      if (i + 1 >= r.count) return;
    }
  } catch (e) {
    r.failed = failWords(e) || "Listen failed";
  }
}
