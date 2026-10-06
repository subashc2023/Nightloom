<script lang="ts" module>
  /** For the harness's shots: draw a state without a socket or a mic. */
  export interface VoicePreview {
    state: import("./Orb.svelte").OrbState;
    level?: number;
    partial?: string;
    heard?: string;
    sentence?: string;
    held?: string | null;
    problem?: string | null;
    note?: string | null;
    /** The "Speak it" button beside the note (wave 3 B2). */
    speakIt?: boolean;
  }

  export const SILENCE_KEY = "nightloom.remote.voice.silence";
  export const SILENCE_STEPS = [1000, 1500, 2000, 3000, 4000];

  export function loadSilence(): number {
    try {
      const v = Number(localStorage.getItem(SILENCE_KEY));
      if (SILENCE_STEPS.includes(v)) return v;
    } catch {
      // Storage off: the default.
    }
    return 2000;
  }
</script>

<script lang="ts">
  // Voice mode (item 246 wave 3, design §2.3 and §2.5): a full screen over
  // the chat — the title, the orb at ~40 % height, his words as he says
  // them, the sentence being spoken, and Mute / Keyboard / End. Every turn
  // lands in the chat underneath, so leaving voice mode shows the whole
  // transcript. The phone's half of the pipeline lives here: the mic's
  // frames through the VAD to the socket, the host's frames to the orb and
  // the player.
  import { onDestroy, onMount, untrack } from "svelte";
  import Orb, { type OrbState } from "./Orb.svelte";
  import { startCapture, type Capture } from "./capture";
  import { Uplink, leBytes, rmsDb } from "./pcm";
  import { Player, earcon } from "./player";
  import { VoiceSocket, type HostFrame } from "./socket";
  import { Vad } from "./vad";
  import type { ApprovalRequest } from "../../lib/types";
  import { cardKind } from "../client";

  let {
    token,
    chat,
    title,
    ctx = null,
    still = false,
    preview = null,
    onclose,
    onkeep,
    reply = undefined,
    approvals = [],
    onanswer = undefined,
  }: {
    token: string;
    chat: string | null;
    title: string;
    ctx?: AudioContext | null;
    still?: boolean;
    preview?: VoicePreview | null;
    /** Voice mode is over; `keyboard` when he asked for the composer. */
    onclose: (keyboard: boolean) => void;
    /** His words the host could not send: into the composer, not lost. */
    onkeep?: (text: string) => void;
    /** The chat's last reply as speakable text, read fresh from the host
     *  (`speakText`); null while there is none or the turn still runs. */
    reply?: () => Promise<string | null>;
    /** The approval prompts waiting in this chat (backlog 317): the first
     *  is shown over the orb, so a spoken turn that stopped for one can be
     *  answered without leaving voice mode. */
    approvals?: ApprovalRequest[];
    /** Answer a plain call's prompt, as the chat's own card does. */
    onanswer?: (req: ApprovalRequest, decision: "allow" | "deny") => void;
  } = $props();

  // Shown.
  let orb = $state<OrbState>("idle");
  let level = $state(0);
  let partial = $state("");
  let heard = $state("");
  let sentence = $state("");
  let held = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let note = $state<string | null>(null);
  let muted = $state(false);
  let silence = $state(loadSilence());
  let leaving = $state(false);
  /** The reply that finished while the page was away, offered as
   *  "Speak it" (design §2.6). */
  let speakable = $state<string | null>(null);
  /** The host's `approval` frame (backlog 317), until the prompt itself
   *  arrives in `approvals` or is answered. */
  let waiting = $state<{ id: string; text: string } | null>(null);
  const card = $derived(approvals[0] ?? null);
  $effect(() => {
    // The card is here (or was answered): the frame's note has done its job.
    if (waiting && approvals.some((a) => a.id === waiting?.id)) waiting = null;
  });

  // The machinery (not drawn).
  let socket: VoiceSocket | null = null;
  let capture: Capture | null = null;
  let player: Player | null = null;
  let lock: { release(): Promise<void> } | null = null;
  const vad = new Vad();
  const uplink = new Uplink();
  let micLevel = 0;
  let replyOver = true;
  let raf = 0;
  let sentTimer: ReturnType<typeof setTimeout> | null = null;
  let wasChat: string | null = null;
  let settleLeave: (() => void) | null = null;

  $effect(() => {
    vad.setSilence(silence);
  });

  // A preview is drawn once, as given (the harness never changes it).
  const shown0 = untrack(() => preview);
  if (shown0) {
    orb = shown0.state;
    level = shown0.level ?? 0;
    partial = shown0.partial ?? "";
    heard = shown0.heard ?? "";
    sentence = shown0.sentence ?? "";
    held = shown0.held ?? null;
    problem = shown0.problem ?? null;
    note = shown0.note ?? null;
    speakable = shown0.speakIt ? "preview" : null;
    muted = shown0.state === "muted";
  }

  // ---- the host's frames ---------------------------------------------------
  function frame(f: HostFrame) {
    switch (f.t) {
      case "ready":
        problem = null;
        void listen();
        break;
      case "partial":
        if (vad.speaking || orb === "listening") partial = f.text;
        break;
      case "final":
        heard = f.text;
        partial = "";
        break;
      case "dropped":
        partial = "";
        if (orb !== "speaking") orb = muted ? "muted" : "listening";
        settleLeave?.();
        break;
      case "held":
        held = f.text;
        break;
      case "sent":
        replyOver = false;
        sentence = "";
        orb = "sent";
        if (ctx) earcon(ctx);
        if (sentTimer) clearTimeout(sentTimer);
        sentTimer = setTimeout(() => {
          if (orb === "sent") orb = "thinking";
        }, 220);
        if (f.status === "queued") note = "The Mac is mid-turn — it goes when that ends";
        settleLeave?.();
        break;
      case "approval":
        if (!approvals.some((a) => a.id === f.id)) waiting = { id: f.id, text: f.text };
        break;
      case "reply_end":
        replyOver = true;
        if (!player?.busy) backToListening();
        break;
      case "error":
        if (f.message) {
          onkeep?.(f.message);
          problem = `${f.text} — your words are in the composer`;
        } else problem = f.text;
        orb = "error";
        settleLeave?.();
        break;
    }
  }

  function backToListening() {
    if (orb === "speaking" || orb === "thinking" || orb === "sent") orb = muted ? "muted" : "listening";
  }

  // ---- the microphone ---------------------------------------------------------
  function onFrame(pcm: Int16Array) {
    if (muted || leaving || !socket?.open) {
      micLevel = 0;
      return;
    }
    const db = rmsDb(pcm);
    const ev = vad.push(db);
    micLevel = vad.level(db);
    if (ev?.kind === "start") {
      partial = "";
      note = null;
      speakable = null;
      if (player?.busy) {
        // Barge-in: he spoke over the reply — stop it at once.
        player.hush();
        socket.hush();
        sentence = "";
      }
      if (orb !== "error") orb = "listening";
    }
    for (const f of uplink.push(pcm, vad.speaking, vad.quietMs(), ev?.kind === "start")) socket.audio(leBytes(f));
    if (ev?.kind === "end") {
      uplink.reset();
      // A cough or a door is not a message (the host drops < 0.4 s too,
      // but it would count the trailing pause).
      if (ev.speechMs < 400) {
        socket.cancel();
        partial = "";
      } else socket.end();
    }
    vad.replying = !!player?.busy;
  }

  async function listen() {
    if (capture || !ctx) {
      if (!muted && orb !== "error") orb = replyOver ? "listening" : orb;
      return;
    }
    try {
      if (ctx.state === "suspended") await ctx.resume();
      capture = await startCapture(ctx, onFrame);
      if (orb === "idle") orb = muted ? "muted" : "listening";
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      orb = "error";
    }
  }

  // ---- the socket ---------------------------------------------------------------
  function connect() {
    socket?.close();
    problem = null;
    orb = "idle";
    socket = new VoiceSocket(token, chat, {
      onFrame: frame,
      onAudio: (head, wav) => {
        if (head.seq === 0 && head.since_end_ms != null)
          console.info(`voice: first audio ${head.since_end_ms} ms after the pause (first text ${head.first_text_ms ?? "?"} ms)`);
        player?.add({ seq: head.seq, sentence: head.sentence }, wav);
      },
      onClose: (clean) => {
        if (clean || leaving) return;
        // The host's own sentence (a wrong token, voice failing to start)
        // came first and says more than this one would.
        if (orb === "error" && problem) {
          problem = `${problem}. Tap the orb to try again`;
          return;
        }
        problem = "Lost the Mac — tap the orb to reconnect";
        orb = "error";
        settleLeave?.();
      },
    });
    wasChat = chat;
  }

  // Another chat opened underneath: speak into it from now on.
  $effect(() => {
    const c = chat;
    if (socket && c !== wasChat) {
      wasChat = c;
      socket.chat(c);
    }
  });

  // ---- the controls ---------------------------------------------------------------
  function endUtterance() {
    if (!vad.speaking) return false;
    const long = vad.quietMs() < 10_000;
    vad.reset();
    uplink.reset();
    if (long) socket?.end();
    else socket?.cancel();
    return long;
  }

  function toggleMute() {
    muted = !muted;
    if (muted) {
      // Mid-sentence: what he said so far still goes.
      endUtterance();
      partial = "";
      if (orb === "listening" || orb === "idle") orb = "muted";
    } else if (orb === "muted") orb = "listening";
  }

  function tapOrb() {
    if (preview) return;
    if (orb === "error") return connect();
    if (orb === "speaking" && player?.busy) {
      player.hush();
      socket?.hush();
      sentence = "";
      orb = muted ? "muted" : "listening";
      return;
    }
    toggleMute();
  }

  function cycleSilence() {
    const i = SILENCE_STEPS.indexOf(silence);
    silence = SILENCE_STEPS[(i + 1) % SILENCE_STEPS.length];
    try {
      localStorage.setItem(SILENCE_KEY, String(silence));
    } catch {
      // Storage off: this visit only.
    }
  }

  function unqueue() {
    socket?.unqueue();
    held = null;
  }

  /** Leave; if he is mid-sentence, send it first (up to 3 s) so nothing
   *  he said is lost. */
  async function leave(keyboard: boolean) {
    if (leaving) return;
    leaving = true;
    if (!preview && endUtterance()) {
      note = "Sending what you said…";
      await new Promise<void>((resolve) => {
        settleLeave = resolve;
        setTimeout(resolve, 3000);
      });
    }
    teardown();
    onclose(keyboard);
  }

  // ---- the page going away and coming back -----------------------------------------
  function hidden() {
    // A home-screen app loses the mic and audio in the background anyway:
    // close cleanly; the turn keeps running on the Mac.
    if (document.visibilityState === "hidden") {
      capture?.stop();
      capture = null;
      player?.hush();
      leaving = true;
      socket?.close();
      socket = null;
      vad.reset();
      uplink.reset();
    } else if (!socket) {
      leaving = false;
      // A reply was coming when the page went: it landed in the chat
      // while away (or is still running). The new socket has none.
      const missed = !replyOver;
      replyOver = true;
      note = "Back — the reply is in the chat";
      connect();
      void wake();
      if (missed) void offerReply();
    }
  }

  /** Read the chat again; when its reply is whole, offer to speak it. */
  async function offerReply() {
    if (!reply) return;
    try {
      const text = await reply();
      if (text && !leaving && note) speakable = text;
    } catch {
      // The chat could not be read: the note alone says where the reply is.
    }
  }

  /** "Speak it": the host reads the reply aloud through the same voice. */
  function speakIt() {
    if (preview || !speakable || !socket?.open) return;
    socket.speak(speakable);
    speakable = null;
    note = null;
    replyOver = false;
    if (orb !== "error") orb = "thinking";
  }

  async function wake() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl) lock = await wl.request("screen");
    } catch {
      // iOS before 18.4, or refused: the screen may sleep.
    }
  }

  function teardown() {
    cancelAnimationFrame(raf);
    if (sentTimer) clearTimeout(sentTimer);
    capture?.stop();
    capture = null;
    player?.hush();
    socket?.close();
    socket = null;
    void lock?.release().catch(() => {});
    lock = null;
    document.removeEventListener("visibilitychange", hidden);
  }

  onMount(() => {
    if (preview) return;
    if (ctx) {
      // iOS: capture and playback in one session, the reply on the speaker.
      const s = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (s) s.type = "play-and-record";
      player = new Player(ctx, {
        onSentence: (line) => {
          sentence = line.sentence;
          if (orb !== "error") orb = "speaking";
        },
        onIdle: () => {
          if (replyOver) {
            sentence = "";
            backToListening();
          }
        },
        onError: (m) => (problem = m),
      });
    }
    document.addEventListener("visibilitychange", hidden);
    void wake();
    connect();
    const tick = () => {
      const target = orb === "speaking" ? (player?.level() ?? 0) : orb === "listening" ? micLevel : 0;
      level += (target - level) * 0.35;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (!preview) teardown();
  });

  /** What the waiting call wants, in a line: its name and its first
   *  argument (a command, a path, a query). */
  function wants(req: ApprovalRequest): { name: string; arg: string } {
    const name = req.name.replace(/^mcp__.+?__/, "").replaceAll("_", " ");
    const input = req.input && typeof req.input === "object" ? (req.input as Record<string, unknown>) : {};
    const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
    const arg = first ? (first.length > 120 ? `${first.slice(0, 120)}…` : first) : "";
    return { name, arg };
  }

  function decide(req: ApprovalRequest, decision: "allow" | "deny") {
    waiting = null;
    onanswer?.(req, decision);
  }

  const secs = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}` : (ms / 1000).toFixed(1));
</script>

<div class="voice" role="dialog" aria-label="Voice mode">
  <header>
    <span class="title">{title}</span>
    <button class="chip" onclick={cycleSilence} aria-label="Send after this long a pause">Send after {secs(silence)} s</button>
  </header>

  <div class="stage">
    <Orb state={orb} {level} {still} onclick={tapOrb} />
  </div>

  <div class="words">
    {#if partial}
      <p class="partial">{partial}</p>
    {:else if heard && (orb === "sent" || orb === "thinking")}
      <p class="heard">{heard}</p>
    {:else if !sentence && orb === "listening" && !still}
      <p class="hint">Listening — I send after a {secs(silence)} s pause</p>
    {/if}
    {#if sentence}
      <p class="sentence">{sentence}</p>
    {/if}
    {#if held}
      <button class="held" onclick={unqueue} aria-label="Take back the held message">
        <span class="held-text">{held}</span>
        <span class="held-meta">goes when the reply ends · tap to cancel</span>
      </button>
    {/if}
    {#if card}
      {@const w = wants(card)}
      <!-- Backlog 317: the turn waits on him; answer it here. -->
      <div class="approval" role="group" aria-label="Waiting for your approval">
        {#if cardKind(card) === "call"}
          <p class="ask">Allow <b>{w.name}</b>?</p>
          {#if w.arg}<p class="arg">{w.arg}</p>{/if}
          <div class="row">
            <button class="yes" onclick={() => decide(card, "allow")}>Allow</button>
            <button class="no" onclick={() => decide(card, "deny")}>Deny</button>
          </div>
        {:else}
          <p class="ask">{cardKind(card) === "question" ? "A question is waiting for you" : "A plan is waiting for your OK"}</p>
          <div class="row">
            <button class="yes" onclick={() => void leave(false)}>Answer in the chat</button>
          </div>
        {/if}
      </div>
    {:else if waiting}
      <p class="note">
        {waiting.text}
        <button class="speak-it" onclick={() => void leave(false)}>Show it</button>
      </p>
    {/if}
    {#if problem}
      <p class="problem">{problem}</p>
    {:else if note}
      <p class="note">
        {note}
        {#if speakable}<button class="speak-it" onclick={speakIt}>Speak it</button>{/if}
      </p>
    {/if}
  </div>

  <footer>
    <button class="ctl" class:on={muted} onclick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted}>
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{#if muted}<path
            d="M4 4l16 16"
          />{/if}</svg
      >
    </button>
    <button class="ctl" onclick={() => void leave(true)} aria-label="Back to the keyboard">
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg
      >
    </button>
    <button class="ctl end" onclick={() => void leave(false)} aria-label="End voice mode">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
  </footer>
</div>

<style>
  .voice {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    padding: calc(env(safe-area-inset-top) + 12px) 20px calc(env(safe-area-inset-bottom) + 20px);
    /* Always night: the orb's screened blues need a dark ground, whatever
       the phone's theme (design §2.5 — blue is his ask, off palette A). */
    background: radial-gradient(120% 70% at 50% 38%, #0f1a33 0%, #080c18 60%, #05070d 100%);
    color: #e6ecf7;
    font-family: "IBM Plex Sans", system-ui, sans-serif;
    overflow: hidden;
    overscroll-behavior: contain;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
  }
  .title {
    font-size: 15px;
    font-weight: 500;
    color: #aebbd6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    flex: none;
    height: 32px;
    padding: 0 12px;
    border-radius: 16px;
    border: 1px solid rgba(147, 197, 253, 0.25);
    background: rgba(59, 130, 246, 0.1);
    color: #bcd3f5;
    font: inherit;
    font-size: 13px;
  }
  .stage {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* The orb's centre at about 40 % of the height. */
    margin-top: calc(40dvh - 84px - 56px - env(safe-area-inset-top));
  }
  .words {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 28px 4px 12px;
    text-align: center;
  }
  .words p {
    margin: 0;
    max-width: 34ch;
  }
  .partial,
  .heard {
    font-size: 24px;
    line-height: 1.3;
    font-weight: 500;
    color: #f2f6ff;
  }
  .heard {
    color: #9fb0cf;
  }
  .sentence {
    font-size: 19px;
    line-height: 1.4;
    color: #dbe7ff;
    background: rgba(59, 130, 246, 0.16);
    border-radius: 12px;
    padding: 8px 12px;
  }
  .hint,
  .note {
    font-size: 15px;
    color: #8193b5;
  }
  .speak-it {
    margin-left: 8px;
    min-height: 36px;
    padding: 0 16px;
    border-radius: 18px;
    border: 1px solid #3b82f6;
    background: color-mix(in srgb, #3b82f6 18%, transparent);
    color: #cfe0ff;
    font: inherit;
    font-size: 15px;
    vertical-align: middle;
  }
  .approval {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 34ch;
    padding: 12px 16px;
    border-radius: 14px;
    border: 1px solid rgba(147, 197, 253, 0.35);
    background: rgba(30, 64, 175, 0.24);
  }
  .approval .ask {
    font-size: 17px;
    color: #f2f6ff;
  }
  .approval .arg {
    font-size: 13px;
    color: #9fb0cf;
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    overflow-wrap: anywhere;
  }
  .approval .row {
    display: flex;
    gap: 12px;
  }
  .approval button {
    min-height: 44px;
    min-width: 96px;
    padding: 0 18px;
    border-radius: 22px;
    font: inherit;
    font-size: 16px;
  }
  .approval .yes {
    border: 1px solid #3b82f6;
    background: #3b82f6;
    color: #fff;
  }
  .approval .no {
    border: 1px solid rgba(248, 113, 113, 0.6);
    background: transparent;
    color: #fecaca;
  }
  .problem {
    font-size: 15px;
    color: #f0c27a;
  }
  .held {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 34ch;
    padding: 8px 14px;
    border-radius: 14px;
    border: 1px dashed rgba(147, 197, 253, 0.4);
    background: rgba(30, 64, 175, 0.2);
    color: #dbe7ff;
    font: inherit;
    text-align: left;
  }
  .held-text {
    font-size: 16px;
  }
  .held-meta {
    font-size: 12px;
    color: #8da2c8;
  }
  footer {
    flex: none;
    display: flex;
    justify-content: center;
    gap: 36px;
    padding-top: 8px;
  }
  .ctl {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: rgba(148, 163, 184, 0.16);
    color: #e6ecf7;
    -webkit-tap-highlight-color: transparent;
  }
  .ctl.on {
    background: #e6ecf7;
    color: #0b1020;
  }
  .ctl.end {
    background: #dc2626;
    color: #fff;
  }
  .ctl svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
