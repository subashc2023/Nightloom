/**
 * The images tool calls returned, for the transcript (nightshift backlog
 * 434). The stream and the chat's log carry a result's text only, with an
 * image named `[image]` (the service's `translate::flatten`); the bytes are
 * in the CLI's own session file, which `api.toolResultImages` reads. This
 * module asks for them once per call, batching the calls one render names
 * into one read of the file, and keeps the answer for the window's life.
 *
 * A live call can be drawn before the CLI has written its result line, so
 * a miss is retried a few times, a second apart, before it is believed.
 */
import * as api from "./api";

export type ToolImagesState =
  | { status: "loading" }
  | { status: "done"; images: api.ToolResultImages["images"]; skipped: number }
  | { status: "none" };

/** Whether a result's text says it carried an image. */
export function namesImage(content: string | null | undefined): boolean {
  return !!content && content.includes("[image]");
}

/** Retries for an id the file did not have yet, and the gap between them. */
export const RETRIES = 3;
export const RETRY_MS = 1000;
/** How long a render's requests are gathered before the one read. */
const BATCH_MS = 30;

const cache = $state<Record<string, ToolImagesState>>({});
const tries: Record<string, number> = {};
const queued = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | null = null;

type Fetch = (session: string, ids: string[]) => Promise<Record<string, api.ToolResultImages>>;
let fetcher: Fetch = (s, ids) => api.toolResultImages(s, ids);

/** Tests swap the reader and clear the cache. */
export function _reset(f?: Fetch): void {
  for (const k of Object.keys(cache)) delete cache[k];
  for (const k of Object.keys(tries)) delete tries[k];
  queued.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  fetcher = f ?? ((s, ids) => api.toolResultImages(s, ids));
}

/** The state for `id`, asking for it on first sight. */
export function toolImages(session: string | null, id: string): ToolImagesState {
  const known = cache[id];
  if (known) return known;
  if (!session) return { status: "none" };
  request(session, id);
  return { status: "loading" };
}

function request(session: string, id: string): void {
  // Written outside the reactive read that called us: a $state write in a
  // template expression is refused, so the mark lands a tick later.
  queueMicrotask(() => {
    if (!cache[id]) cache[id] = { status: "loading" };
  });
  let set = queued.get(session);
  if (!set) queued.set(session, (set = new Set()));
  set.add(id);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

async function flush(): Promise<void> {
  timer = null;
  const batches = [...queued.entries()];
  queued.clear();
  for (const [session, set] of batches) {
    const ids = [...set];
    let got: Record<string, api.ToolResultImages> = {};
    try {
      got = await fetcher(session, ids);
    } catch {
      got = {};
    }
    for (const id of ids) {
      const hit = got[id];
      if (hit) {
        cache[id] = { status: "done", images: hit.images, skipped: hit.skipped };
        continue;
      }
      const n = (tries[id] ?? 0) + 1;
      tries[id] = n;
      if (n > RETRIES) {
        cache[id] = { status: "none" };
        continue;
      }
      setTimeout(() => {
        let s = queued.get(session);
        if (!s) queued.set(session, (s = new Set()));
        s.add(id);
        if (!timer) timer = setTimeout(flush, BATCH_MS);
      }, RETRY_MS);
    }
  }
}

/** A data URL for one image. */
export function imageSrc(img: { media_type: string; data: string }): string {
  return `data:${img.media_type};base64,${img.data}`;
}
