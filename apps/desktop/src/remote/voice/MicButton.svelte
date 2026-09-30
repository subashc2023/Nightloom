<script lang="ts">
  // The composer's mic (item 246 wave 3): the one thing Remote.svelte
  // mounts for voice. With this host's voice (`/api/state`'s `voice`) and
  // a page that may use the microphone (HTTPS), a tap opens voice mode —
  // the AudioContext is made inside the tap, the only moment iOS lets a
  // page start sound. Otherwise (plain HTTP, or no voice programs on the
  // host) it is design §2.2's fallback D: a tap arms auto-send, he uses
  // the keyboard's own dictation key, and 2 s after the words stop the
  // message goes. Shown while the box is empty, and while armed.
  import { onDestroy } from "svelte";
  import { canCapture } from "./capture";
  import { AutoSend } from "./dictation";
  import type { VoiceInfo } from "./socket";
  import Voice from "./Voice.svelte";

  let {
    token,
    chat,
    title,
    voice = null,
    draft,
    box = null,
    still = false,
    send,
    onkeep,
  }: {
    token: string | null;
    chat: string | null;
    title: string;
    voice?: VoiceInfo | null;
    draft: string;
    box?: HTMLTextAreaElement | null;
    still?: boolean;
    /** The composer's own send (fallback D). */
    send: () => void;
    /** His words the host could not send, for the composer. */
    onkeep: (text: string) => void;
  } = $props();

  let open = $state(false);
  let ctx = $state<AudioContext | null>(null);
  let armed = $state(false);
  let tip = $state(false);
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  const auto = new AutoSend(() => send());

  // A new chat (no id yet) dictates: the socket speaks into an existing
  // chat, and would otherwise land in whatever the Mac has open.
  const full = $derived(!!voice && chat !== null && canCapture());
  const shown = $derived(!!token && (!draft.trim() || armed));

  $effect(() => {
    auto.changed(draft);
  });

  function tap() {
    if (full) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new C();
      void ctx.resume();
      open = true;
      return;
    }
    armed = !armed;
    if (armed) {
      auto.arm();
      box?.focus();
      tip = true;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(() => (tip = false), 6000);
    } else {
      auto.disarm();
      tip = false;
    }
  }

  function closed(keyboard: boolean) {
    open = false;
    void ctx?.close().catch(() => {});
    ctx = null;
    if (keyboard) setTimeout(() => box?.focus(), 50);
  }

  onDestroy(() => {
    auto.disarm();
    if (tipTimer) clearTimeout(tipTimer);
  });
</script>

{#if shown}
  <span class="mic-wrap">
    {#if tip}
      <span class="tip" role="status">Tap the mic on your keyboard and talk — I send 2 s after you stop.</span>
    {/if}
    <button
      class="mic"
      class:armed
      onclick={tap}
      aria-label={full ? "Voice mode" : armed ? "Stop sending after a pause" : "Dictate — send after a pause"}
      aria-pressed={full ? undefined : armed}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg
      >
    </button>
  </span>
{/if}

{#if open && token}
  <Voice {token} {chat} {title} {ctx} {still} onclose={closed} {onkeep} />
{/if}

<style>
  .mic-wrap {
    position: relative;
    flex: none;
    display: flex;
  }
  .mic {
    width: 40px;
    height: 40px;
    margin: 1px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, #3b82f6 16%, transparent);
    color: #3b82f6;
    -webkit-tap-highlight-color: transparent;
  }
  .mic.armed {
    background: #3b82f6;
    color: #fff;
  }
  .mic svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tip {
    /* Fixed, not under the button: the composer clips what overhangs it. */
    position: fixed;
    right: 16px;
    left: 16px;
    bottom: calc(env(safe-area-inset-bottom) + 84px);
    z-index: 5;
    text-align: center;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--ink, #2a251d);
    color: var(--paper, #f6f2ea);
    font-size: 13px;
    line-height: 1.35;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }
</style>
