/**
 * The draft's exact token count (nightshift backlog 155, second half).
 *
 * "On the API engine past ~500 tokens it becomes exact within a second of
 * pausing." The estimate (`tokens.ts`) updates as you type; this asks the
 * provider's count endpoint once the draft has been still for
 * `EXACT_DELAY_MS` — never per keystroke — and only on the provider engine:
 * the Claude Code engine has no count endpoint and keeps the estimate.
 *
 * Kept out of the component so the hook-up and the threshold can be tested
 * with fake timers and a fake counter, without a real API call.
 */
import { EXACT_TOKENS_FROM, estimateTokens } from "./tokens";

/** How long the draft must be still before it is counted. With the request
 *  itself (~100–300 ms, not measured here) this lands inside a second. */
export const EXACT_DELAY_MS = 600;

export interface CountTarget {
  /** `"provider"` or `"claude-code"` (catalog's `Engine`). */
  engine: string | undefined;
  provider: string | undefined;
  model: string | undefined;
}

/** Whether `text` on `target` is worth an exact count at all. */
export function wantsExactCount(text: string, target: CountTarget): boolean {
  return (
    target.engine === "provider" &&
    !!target.provider &&
    estimateTokens(text) >= EXACT_TOKENS_FROM
  );
}

/** What the counter settled on for one text: a figure, or `null` when the
 *  provider has no counter (or the request failed) and the estimate stands. */
export interface ExactResult {
  text: string;
  tokens: number | null;
  model: string;
}

export type Counter = (
  provider: string,
  model: string | undefined,
  text: string,
) => Promise<number | null>;

/**
 * A debounced counter. Call `update` on every change of the draft or the
 * connection; `onResult` hears only the answer for the latest text, and hears
 * `null` at once when the draft drops out of range (so a stale exact figure
 * is never left standing). `dispose` cancels anything pending.
 */
export function exactCounter(count: Counter, onResult: (r: ExactResult | null) => void, delayMs = EXACT_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    generation++;
  };
  return {
    update(text: string, target: CountTarget) {
      cancel();
      if (!wantsExactCount(text, target)) {
        onResult(null);
        return;
      }
      const mine = generation;
      const model = target.model ?? "";
      timer = setTimeout(() => {
        timer = null;
        count(target.provider!, target.model || undefined, text).then(
          (tokens) => {
            if (mine === generation) onResult({ text, tokens, model });
          },
          () => {
            if (mine === generation) onResult({ text, tokens: null, model });
          },
        );
      }, delayMs);
    },
    dispose: cancel,
  };
}
