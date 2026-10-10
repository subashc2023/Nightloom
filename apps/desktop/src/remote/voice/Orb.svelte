<script lang="ts" module>
  export type OrbState = "idle" | "listening" | "sent" | "thinking" | "speaking" | "muted" | "error";

  export const ORB_LABEL: Record<OrbState, string> = {
    idle: "Ready",
    listening: "Listening",
    sent: "Sent",
    thinking: "Thinking",
    speaking: "Speaking",
    muted: "Muted",
    error: "Problem",
  };
</script>

<script lang="ts">
  // The orb (item 246 wave 3, design §2.5): his "blue floating thing".
  // Three stacked radial gradients, the back two blurred and screened, each
  // drifting on its own slow loop (9 s / 13 s / 17 s) so they never line
  // up. `--level` (0–1, set per frame from the mic or the reply's voice)
  // swells the front layer and the glow. CSS only: composited on the GPU,
  // cheap on a walk's battery. Reduced motion (and the harness's ?still=1):
  // no drift, rotation or swelling — the state by colour and a label, the
  // level by a thin bar whose opacity changes.
  let {
    state = "idle",
    level = 0,
    still = false,
    onclick,
  }: { state?: OrbState; level?: number; still?: boolean; onclick?: () => void } = $props();

  const lv = $derived(Math.max(0, Math.min(1, level)));
</script>

<button
  class="orb {state}"
  class:still
  style:--level={lv.toFixed(3)}
  {onclick}
  aria-label={state === "speaking" ? "Stop speaking" : state === "muted" ? "Resume listening" : "Pause listening"}
>
  <span class="glow"></span>
  <span class="layer back"></span>
  <span class="layer mid"></span>
  <span class="layer front"><span class="shine"></span></span>
</button>
{#if still}
  <div class="still-label" aria-live="polite">
    <span class="bar" style:opacity={(0.15 + lv * 0.85).toFixed(3)}></span>
    <span>{ORB_LABEL[state]}</span>
  </div>
{/if}

<style>
  .orb {
    --size: 168px;
    --level: 0;
    --a: #1e40af;
    --b: #3b82f6;
    --c: #93c5fd;
    position: relative;
    width: var(--size);
    height: var(--size);
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    isolation: isolate;
    animation: breathe 4s ease-in-out infinite;
  }
  .orb:focus-visible {
    outline: 2px solid var(--c);
    outline-offset: 8px;
  }
  .layer,
  .glow {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    pointer-events: none;
  }
  .glow {
    inset: -28%;
    background: radial-gradient(circle, color-mix(in srgb, var(--b) 55%, transparent) 0%, transparent 65%);
    opacity: calc(0.35 + var(--level) * 0.65);
    filter: blur(18px);
    transition: opacity 120ms linear;
  }
  .layer {
    mix-blend-mode: screen;
  }
  .back {
    inset: -6%;
    background: radial-gradient(circle at 60% 65%, var(--a) 0%, color-mix(in srgb, var(--a) 40%, transparent) 55%, transparent 72%);
    filter: blur(14px);
    animation: drift-a 13s ease-in-out infinite;
  }
  .mid {
    inset: 2%;
    background: radial-gradient(circle at 38% 42%, var(--b) 0%, color-mix(in srgb, var(--a) 70%, transparent) 60%, transparent 74%);
    filter: blur(14px);
    animation: drift-b 17s ease-in-out infinite;
  }
  .front {
    inset: 10%;
    background: radial-gradient(circle at 42% 40%, var(--c) 0%, var(--b) 45%, var(--a) 78%, transparent 80%);
    transform: scale(calc(1 + var(--level) * 0.18));
    transition: transform 90ms linear;
    overflow: hidden;
  }
  .front::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    animation: spin 9s linear infinite;
    background: radial-gradient(circle at 70% 30%, color-mix(in srgb, var(--c) 60%, transparent) 0%, transparent 45%);
  }
  .shine {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.75) 0%, rgba(255, 255, 255, 0.18) 16%, transparent 34%);
  }

  /* States. */
  .listening {
    --a: #1e3a8a;
    --b: #2563eb;
    --c: #93c5fd;
  }
  .speaking {
    --a: #1d4ed8;
    --b: #3b82f6;
    --c: #bfdbfe;
  }
  .speaking .glow {
    opacity: calc(0.55 + var(--level) * 0.45);
  }
  .thinking .layer {
    animation-duration: 6s, 6s;
  }
  .thinking .front {
    animation: shimmer 2.4s ease-in-out infinite;
  }
  .thinking .shine {
    animation: orbit 3s linear infinite;
  }
  .sent .front {
    animation: pulse-in 200ms ease-out 1;
  }
  .muted {
    --a: #334155;
    --b: #64748b;
    --c: #cbd5e1;
    filter: saturate(0.7);
    animation: none;
  }
  .muted .glow {
    opacity: 0.15;
  }
  .error {
    --a: #7c4a12;
    --b: var(--accent, #e0a458);
    --c: #f5d9a8;
    animation: none;
  }
  .idle .front {
    transform: none;
  }

  @keyframes breathe {
    0%,
    100% {
      transform: scale(0.97);
    }
    50% {
      transform: scale(1.03);
    }
  }
  @keyframes drift-a {
    0% {
      transform: translate(-6px, 3px) rotate(0deg);
    }
    50% {
      transform: translate(6px, -4px) rotate(180deg);
    }
    100% {
      transform: translate(-6px, 3px) rotate(360deg);
    }
  }
  @keyframes drift-b {
    0% {
      transform: translate(5px, 5px) rotate(360deg);
    }
    50% {
      transform: translate(-5px, -6px) rotate(180deg);
    }
    100% {
      transform: translate(5px, 5px) rotate(0deg);
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes orbit {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes shimmer {
    0%,
    100% {
      filter: hue-rotate(-8deg);
    }
    50% {
      filter: hue-rotate(8deg);
    }
  }
  @keyframes pulse-in {
    0% {
      transform: scale(1.08);
    }
    100% {
      transform: scale(0.9);
    }
  }

  /* Reduced motion: nothing moves; the label and the bar say it. */
  .still,
  .still .layer,
  .still .front,
  .still .front::before,
  .still .shine {
    animation: none !important;
    transition: none !important;
  }
  .still .front {
    transform: none;
  }
  .still .glow {
    opacity: 0.5;
    transition: none;
  }
  .still-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 18px;
    font-size: 15px;
    font-weight: 500;
    /* Voice mode's ground is always night (Voice.svelte). */
    color: #aebbd6;
    letter-spacing: 0.02em;
  }
  .bar {
    display: block;
    width: 72px;
    height: 3px;
    border-radius: 2px;
    background: #3b82f6;
  }
  @media (prefers-reduced-motion: reduce) {
    .orb,
    .layer,
    .front,
    .front::before,
    .shine {
      animation: none !important;
      transition: none !important;
    }
    .front {
      transform: none;
    }
  }
</style>
