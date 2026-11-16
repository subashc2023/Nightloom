<!--
  Item 716 part 3 (his "again why no demo bro", on Reply text): a sample reply
  streaming in, looping, under one card's look — the real motion (replyMotion.ts,
  the action a reply in the transcript uses), its look pinned on this root with
  `data-reply-look` so Line reveal and Word rise run side by side whatever the
  setting is. The text arrives in uneven small deltas, as a stream's do; then it
  holds, clears, and streams again. Reduce motion: the whole reply, still (as a
  reply then shows).
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { replyMotion, motionOff, type ReplyLook } from "./replyMotion";

  let { look }: { look: ReplyLook } = $props();

  const SAMPLE =
    "The preview now draws the real controls. Send glows when you point at it, the pickers open the same way, and the box keeps its frame while the answer streams in underneath.";
  // Delta sizes in characters, repeated — uneven, as a stream's chunks are.
  const STEPS = [3, 7, 2, 5, 9, 4, 6, 2, 8, 3];
  const TICK_MS = 70;
  const HOLD_MS = 2600;
  const GAP_MS = 500;

  const still = motionOff();
  let shown = $state(still ? SAMPLE : "");
  let streaming = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function next(i: number, k: number): void {
    if (i >= SAMPLE.length) {
      streaming = false;
      timer = setTimeout(() => {
        shown = "";
        timer = setTimeout(() => {
          streaming = true;
          next(0, 0);
        }, GAP_MS);
      }, HOLD_MS);
      return;
    }
    const n = Math.min(SAMPLE.length, i + STEPS[k % STEPS.length]);
    shown = SAMPLE.slice(0, n);
    timer = setTimeout(() => next(n, k + 1), TICK_MS);
  }

  if (!still) {
    timer = setTimeout(() => {
      streaming = true;
      next(0, 0);
    }, GAP_MS);
  }
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
</script>

<span class="rl-demo" data-reply-look={look} aria-hidden="true" use:replyMotion={streaming}>
  <span class="markdown"><span class="rl-p">{shown}</span></span>
</span>

<style>
  /* A reply's text on a scrap of the transcript's ground. */
  .rl-demo {
    position: relative;
    display: block;
    min-height: 5.6em;
    padding: 10px 12px;
    border-radius: var(--r2);
    background: var(--paper);
    border: 1px solid var(--line);
    text-align: left;
    color: var(--ink);
    font-family: var(--transcript-font, var(--sans));
    line-height: 1.62;
    pointer-events: none;
  }
  /* The transcript's face and line height (AssistantMessage's .markdown); a little smaller than
     the transcript's size, so a three-line sample fits the card. */
  .rl-demo .markdown {
    display: block;
    font-size: calc(var(--transcript-size, 16px) - 2px);
  }
  .rl-p {
    display: block;
  }
  /* The motion's own marks, as AssistantMessage draws them (`.assistant :global(.rm-shuttle)`,
     `.rm-w`; keyframes rm-rise / rm-weft-under are global there). rlDemo716.test.ts keeps
     these declarations equal to AssistantMessage's. */
  .rl-demo :global(.rm-shuttle) {
    position: absolute;
    left: 0;
    top: 0;
    width: 18px;
    height: 5px;
    margin: -2.5px 0 0 0;
    border-radius: 50% / 100%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--motion-ink, var(--accent)) 10%, transparent), var(--motion-ink-hi, var(--accent-ink, var(--accent))));
    box-shadow: 0 0 8px color-mix(in srgb, var(--motion-ink, var(--accent)) 70%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 260ms ease-out;
    z-index: 5;
  }
  @media (prefers-reduced-motion: reduce) {
    .rl-demo :global(.rm-shuttle) {
      display: none;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .rl-demo :global(.rm-w) {
      display: inline;
      position: relative;
      animation:
        rm-rise 520ms cubic-bezier(0.2, 0.7, 0.2, 1) both,
        rm-weft-under 900ms ease-out both;
    }
  }
</style>
