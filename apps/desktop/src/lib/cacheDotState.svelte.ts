import { cacheFrom, cacheState, ownModelCache } from "./cache";
import { cacheDot, type CacheDot } from "./cacheDot";
import { lastReply } from "./cacheCost";
import { touchedUntil } from "./keepWarm";
import { keepWarm, loadAllKeepWarm } from "./keepWarm.svelte";
import { displayName } from "./modelSeen";
import { app, asideOf, asideReads } from "./state.svelte";

/**
 * Item 1022: the cache dot's state — one shared clock and the rule that
 * picks each chat's timer. The clock ticks every 20 s while any dot is on
 * screen and stops when none is (a dot's ring moves by its minutes; a
 * finer tick would only cost wake-ups). The first dot also reads every
 * chat the backend keeps warm (`loadAllKeepWarm`, item 913's list), so a
 * kept chat shows kept before it is opened; the `keep-warm` events keep
 * it current after.
 */
export const dotClock = $state({ now: Date.now() });

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let listed = false;

/** A dot mounted: start the clock; the returned function stops it. */
export function useDotClock(): () => void {
  users++;
  if (!listed) {
    listed = true;
    void loadAllKeepWarm();
  }
  if (!timer) {
    dotClock.now = Date.now();
    timer = setInterval(() => (dotClock.now = Date.now()), 20_000);
  }
  return () => {
    users--;
    if (users <= 0 && timer) {
      clearInterval(timer);
      timer = null;
      users = 0;
    }
  };
}

/**
 * A chat's dot: the open chat from its live log (as its composer's chip
 * times it — rewinds, asides, keep-warm), any other from its listing.
 */
export function chatDot(session: string, now: number): CacheDot | null {
  const kw = keepWarm.byChat[session];
  const kept = touchedUntil(kw);
  if (session === app.activeSessionId) {
    const reply = lastReply(app.events);
    const cache = cacheState(app.events, now, kept, asideReads(session, reply?.model));
    const ctx = reply?.usage ? reply.usage.input_tokens + reply.usage.output_tokens : null;
    return cacheDot(cache, kw, now, ctx);
  }
  const meta = app.sessions.find((s) => s.id === session);
  const cache =
    meta?.cache_sent_at && meta.cache_ttl
      ? cacheFrom(meta.cache_sent_at, meta.cache_ttl, meta.context_used ?? 0, now, kept, asideReads(session, meta.context_model))
      : null;
  return cacheDot(cache, kw, now, meta?.context_used ?? null);
}

/**
 * An aside's dot (item 786's rule): on the chat's model it reads the
 * chat's cache, so it shows the chat's dot; on another model it times its
 * own answers' entry — nothing before its first answer.
 */
export function asideDot(session: string, thread: number | null | undefined, now: number): CacheDot | null {
  const aside = asideOf(session, thread);
  if (!aside) return null;
  const chatModel =
    session === app.activeSessionId
      ? app.draft.agentModel.trim()
        ? displayName(app.draft.agentModel)
        : "default"
      : (() => {
          const m = app.sessions.find((s) => s.id === session)?.context_model;
          return m ? displayName(m) : null;
        })();
  const own = !!aside.model && chatModel !== null && displayName(aside.model) !== chatModel;
  if (!own) return chatDot(session, now);
  if (!aside.turns.some((t) => t.readAt != null)) return null;
  return cacheDot(ownModelCache(aside.turns, now), null, now, null, displayName(aside.model as string));
}
